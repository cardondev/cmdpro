// Engine core: judging, recon sessions, completion, file browsing.
// Runs inside the module worker (or inline as a fallback) and in Node for tests.
import { Shell } from './shell.js';
import { System } from './system.js';
import { OutBuf, InStream, ExecLimit, PipeLimit, ExitSignal } from './streams.js';
import { utf8Encode, utf8Decode } from './bytes.js';
import { Parser, ParseError } from './parser.js';
import { BUILTINS, KEYWORD_LIST } from './builtins.js';
import { byteCmp, joinPath } from './vfs.js';

const OUTPUT_LIMIT = 1024 * 1024;

export function makeEnv(fx, extra = {}) {
  return { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', HOSTNAME: 'cmdpro', SHLVL: '1', ...fx.env, ...extra };
}

// output matching
export function matchOutput(check, expected, output) {
  let got = output.replace(/^[\s\u0085\u00a0]+|[\s\u0085\u00a0]+$/g, '').split('\n');
  let exp = [...expected];
  if (check.reSub) {
    const re = new RegExp(check.reSub[0].replace(/\(\?P</g, '(?<'), 'g');
    got = got.map(l => l.replace(re, check.reSub[1]));
  }
  if (!check.order) { exp = [...exp].sort(); got = [...got].sort(); }
  if (check.ignoreNonMatching) { const set = new Set(exp); got = got.filter(l => set.has(l)); }
  const ok = got.length === exp.length && got.every((l, i) => l === exp[i]);
  let firstMismatch = null;
  if (!ok) {
    for (let i = 0; i < Math.max(got.length, exp.length); i++) {
      if (got[i] !== exp[i]) { firstMismatch = { line: i + 1, expected: exp[i] ?? null, got: got[i] ?? null }; break; }
    }
  }
  return { ok, feedback: { expectedLines: exp.length, gotLines: got.length === 1 && got[0] === '' ? 0 : got.length, firstMismatch } };
}

export class EngineCore {
  constructor(opts = {}) {
    this.opts = opts;
    this.ready = false;
    this.recon = null;
  }

  async init() {
    if (this.ready) return true;
    let FIXTURES = this.opts.fixtures, FS = this.opts.fsStore;
    if (!FIXTURES) {
      const mod = await import('../data/fixtures.gen.js');
      FIXTURES = mod.FIXTURES; FS = mod.FS;
    }
    this.fixtures = FIXTURES;
    this.system = new System({ fixtures: FIXTURES, fsStore: FS, game: this.opts.game !== false });
    this.ready = true;
    return true;
  }

  async dispatch(op, a) {
    if (!this.ready) await this.init();
    switch (op) {
      case 'init': return true;
      case 'judge': return this.judge(a.challengeId, a.cmd, a.seed);
      case 'run': return this.runOnce(a.challengeId, a.cmd, a);
      case 'reconStart': return this.reconStart(a.challengeId);
      case 'reconExec': return this.reconExec(a.cmd);
      case 'reconStop': this.recon = null; return true;
      case 'complete': return this.complete(a);
      case 'tree': return this.tree(a.challengeId);
      case 'readFile': return this.readFile(a.challengeId, a.path);
      case 'isIncomplete': return this.isIncomplete(a.line);
      default: throw new Error('unknown op ' + op);
    }
  }

  fixture(id) {
    const fx = this.fixtures[id];
    if (!fx) throw new Error(`unknown challenge ${id}`);
    return fx;
  }

  // trusted: harness scripts (setup, randomizers, checks) can use every command even when the
  // challenge image has no /bin (the oops side quest): the check runs outside the challenge's shell
  newShell(fx, { fs, procs, shellPid }, { interactive = false, seed = 1, deadlineMs = 2500, maxSteps = 5000000, trusted = false } = {}) {
    const limits = { steps: 0, maxSteps, deadline: Date.now() + deadlineMs, depth: 0 };
    const sh = new Shell({
      fs, commands: this.system.registry, cwd: fx.dir, env: makeEnv(fx), procs, limits,
      pid: shellPid, interactive, nobin: fx.nobin, seed, game: this.system.game ? {} : null, trusted,
    });
    return sh;
  }

  // Run a script in a shell, capturing combined stdout+stderr (byte string). Returns { out, status, limit }
  exec(sh, src, { stdin = '' } = {}) {
    const buf = new OutBuf(OUTPUT_LIMIT);
    const io = { fds: { 0: new InStream(stdin), 1: buf, 2: buf } };
    let status = 0, note = null;
    try {
      status = sh.run(utf8Encode(src), io);
    } catch (e) {
      if (e instanceof ExecLimit) { note = e.message; status = 137; }
      else if (e instanceof PipeLimit) { note = 'cmdpro: output truncated (1 MiB limit)'; status = 141; }
      else if (e instanceof ExitSignal) status = e.code;
      else if (e instanceof RangeError && /call stack/i.test(e.message)) { note = 'cmdpro: maximum recursion depth exceeded'; status = 139; }
      else throw e;
    }
    let out = buf.data;
    if (note) out += (out && !out.endsWith('\n') ? '\n' : '') + note + '\n';
    return { out, status, limited: !!note };
  }

  freshEnv(fx, { seed = 1, withSetup = true, randomize = false, interactive = false, deadlineMs } = {}) {
    const img = this.system.buildFs(fx, { nobin: fx.nobin, procs: fx.procs, allChallenges: this.opts.allChallenges });
    const sh = this.newShell(fx, img, { interactive, seed, deadlineMs: 20000, maxSteps: 5000000, trusted: true });
    sh.setVar('CMDPRO_SEED', String(seed));
    if (withSetup && fx.setup) this.exec(sh, fx.setup);
    if (randomize && fx.randomize) this.exec(sh, fx.randomize);
    // fresh limits for the player's command
    const fresh = this.newShell(fx, img, { interactive, seed, deadlineMs: deadlineMs ?? 2500 });
    fresh.unsetVar('CMDPRO_SEED');
    return { sh: fresh, img };
  }

  runFsCheck(fx, img, seed) {
    if (!fx.check.fs) return null;
    const sh = this.newShell(fx, img, { seed, deadlineMs: 5000, maxSteps: 2000000, trusted: true });
    // the check runs from the challenge directory
    const src = `cd ${shq(fx.dir)} 2>/dev/null || { echo "Test failed, the challenge directory is missing!"; exit 1; }\n` + fx.check.fs;
    const r = this.exec(sh, src);
    if (r.status !== 0) return utf8Decode(r.out).trim() || 'Test failed';
    return null;
  }

  judge(id, cmd, seed = 1) {
    const fx = this.fixture(id);
    seed = (seed >>> 0) % 1000003 || 7;
    // pass 1
    const { sh, img } = this.freshEnv(fx, { seed: 1 });
    const r = this.exec(sh, cmd);
    const output = utf8Decode(r.out);
    const result = { correct: true, output, reason: null, exitCode: r.status, feedback: null };
    if (r.limited) { result.correct = false; result.reason = 'Command was stopped (time/output limit)'; return result; }
    if (fx.check.output && fx.expected) {
      const m = matchOutput(fx.check, fx.expected.map(l => utf8Decode(utf8Encode(l))), output);
      result.feedback = m.feedback;
      if (!m.ok) { result.correct = false; result.reason = 'Output does not match expected lines'; return result; }
    }
    const fsFail = this.runFsCheck(fx, img, 1);
    if (fsFail) { result.correct = false; result.reason = fsFail; return result; }
    // pass 2: randomized data defeats hardcoded answers
    if (fx.randomize) {
      let expected2 = null;
      if (fx.check.output) {
        if (fx.expectedRandomized && !/CMDPRO_SEED/.test(fx.randomize)) expected2 = fx.expectedRandomized.map(l => utf8Decode(utf8Encode(l)));
        else {
          const ref = this.freshEnv(fx, { seed, randomize: true, deadlineMs: 10000 });
          const rr = this.exec(ref.sh, fx.reference);
          expected2 = utf8Decode(rr.out).replace(/^[\s\u0085\u00a0]+|[\s\u0085\u00a0]+$/g, '').split('\n');
          if (fx.check.reSub) { const re = new RegExp(fx.check.reSub[0], 'g'); expected2 = expected2.map(l => l.replace(re, fx.check.reSub[1])); }
        }
      }
      const env2 = this.freshEnv(fx, { seed, randomize: true });
      const r2 = this.exec(env2.sh, cmd);
      if (r2.limited) { result.correct = false; result.reason = 'Command was stopped on the randomized data (time/output limit)'; return result; }
      if (expected2) {
        const m2 = matchOutput(fx.check, expected2, utf8Decode(r2.out));
        if (!m2.ok) { result.correct = false; result.reason = 'Output does not match expected lines after randomizing data (no hardcoding!)'; return result; }
      }
      const fs2 = this.runFsCheck(fx, env2.img, seed);
      if (fs2) { result.correct = false; result.reason = fs2 + ' (after randomizing data)'; return result; }
    }
    return result;
  }

  // Run a command once (no judging) — used by tests and tools.
  runOnce(id, cmd, { randomize = false, seed = 1 } = {}) {
    const fx = this.fixture(id);
    const { sh, img } = this.freshEnv(fx, { seed, randomize });
    const r = this.exec(sh, cmd);
    return { output: utf8Decode(r.out), raw: r.out, exitCode: r.status, fsCheck: this.runFsCheck(fx, img, seed) };
  }

  // ---------------------------------------------------------------- recon
  reconStart(id) {
    const fx = this.fixture(id);
    const { sh, img } = this.freshEnv(fx, { seed: 1, interactive: true });
    this.recon = { id, sh, img, io: null };
    return { cwd: sh.cwd };
  }
  reconExec(cmd) {
    if (!this.recon) return { output: 'cmdpro: no recon session\n', exitCode: 1, cwd: '/', reconLost: true };
    const sh = this.recon.sh;
    sh.limits.steps = 0;
    sh.limits.deadline = Date.now() + 2500;
    sh.history.push(cmd);
    const r = this.exec(sh, cmd);
    return { output: utf8Decode(r.out), exitCode: r.status, cwd: sh.cwd };
  }

  // ---------------------------------------------------------------- completion
  complete({ challengeId, line, cursor, recon }) {
    let sh;
    if (recon && this.recon && this.recon.id === challengeId) sh = this.recon.sh;
    else sh = this.freshEnv(this.fixture(challengeId), { seed: 1 }).sh;
    const before = line.slice(0, cursor);
    // find start of the current word (respecting simple quotes/escapes)
    let start = 0, inS = false, inD = false;
    for (let i = 0; i < before.length; i++) {
      const c = before[i];
      if (c === '\\' && !inS) { i++; continue; }
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (!inS && !inD && /[\s|;&<>()=]/.test(c)) start = i + 1;
    }
    const word = before.slice(start);
    const prefixText = before.slice(0, start).replace(/\s+$/, '');
    const isCmdPos = prefixText === '' || /(\||;|&&|\|\||\(|\$\(|`|\bthen|\bdo|\belse|&)$/.test(prefixText) || /\b(sudo|xargs|exec|command|time|nohup|env|watch)$/.test(prefixText);
    const unq = word.replace(/\\(.)/g, '$1').replace(/^['"]/, '');
    let matches = [];
    if (unq.startsWith('$')) {
      const vn = unq.slice(1);
      const names = new Set();
      for (const sc of sh.scopes) for (const k of sc.keys()) names.add(k);
      matches = [...names].filter(n => n.startsWith(vn)).sort(byteCmp).map(n => '$' + n);
    } else if (isCmdPos && !unq.includes('/')) {
      const names = new Set([...Object.keys(BUILTINS), ...KEYWORD_LIST, ...sh.functions.keys()]);
      for (const d of (sh.getVar('PATH') || '').split(':')) { try { for (const n of sh.fs.readdir(d || '.', sh.cwd)) names.add(n); } catch {} }
      matches = [...names].filter(n => n.startsWith(unq) && n !== '').sort(byteCmp).map(n => n + ' ');
    } else {
      // filename completion
      let dirPart = '', base = unq;
      const slash = unq.lastIndexOf('/');
      if (slash >= 0) { dirPart = unq.slice(0, slash + 1); base = unq.slice(slash + 1); }
      let lookDir = dirPart === '' ? '.' : dirPart;
      if (lookDir.startsWith('~')) lookDir = (sh.getVar('HOME') || '/root') + lookDir.slice(1);
      let names = [];
      try { names = sh.fs.readdir(lookDir, sh.cwd); } catch { names = []; }
      matches = names.filter(n => n.startsWith(base) && (base.startsWith('.') || !n.startsWith('.') || base !== '')).sort(byteCmp).map(n => {
        let isDir = false;
        try { isDir = sh.fs.stat(joinPath(lookDir === '.' ? sh.cwd : (lookDir.startsWith('/') ? lookDir : joinPath(sh.cwd, lookDir)), n), '/').type === 'd'; } catch {}
        const full = dirPart + n;
        const esc = full.replace(/([\s'"\\$`!&;|<>(){}[\]*?#~])/g, '\\$1');
        return esc + (isDir ? '/' : ' ');
      });
      if (!base.startsWith('.')) matches = matches.filter(m => !m.slice(dirPart.length).startsWith('.') && !m.slice(dirPart.replace(/([\s'"\\$`!&;|<>(){}[\]*?#~])/g, '\\$1').length).startsWith('.'));
    }
    return { start, end: cursor, matches: matches.slice(0, 500) };
  }

  // ---------------------------------------------------------------- browsing
  tree(id) {
    const fx = this.fixture(id);
    const { sh } = this.freshEnv(fx, { seed: 1 });
    const out = [];
    const base = sh.fs.stat(fx.dir, '/');
    for (const [p, n] of sh.fs.walk(base)) {
      out.push({ path: p, type: n.type === 'd' ? 'dir' : n.type === 'l' ? 'symlink' : 'file', size: n.size, mode: n.mode, target: n.type === 'l' ? n.target : undefined });
      if (out.length > 3000) break;
    }
    return out;
  }
  readFile(id, path) {
    const fx = this.fixture(id);
    const { sh } = this.freshEnv(fx, { seed: 1 });
    try {
      const data = sh.fs.readFile(path.startsWith('/') ? path : fx.dir + '/' + path, '/');
      const clipped = data.length > 200000 ? data.slice(0, 200000) : data;
      if (clipped.includes('\0')) return '[binary file — ' + data.length + ' bytes]\n' + [...clipped.slice(0, 256)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ').replace(/((?:\S+ ){16})/g, '$1\n');
      return utf8Decode(clipped);
    } catch (e) { return `cannot read ${path}: ${e.message}`; }
  }

  isIncomplete(line) {
    if (/(^|[^\\])(\\\\)*\\$/.test(line) && !/'[^']*$/.test(line)) return true;
    try {
      const p = new Parser(utf8Encode(line));
      p.parseAll();
      return !!p.unterminatedHeredoc;
    } catch (e) {
      if (e instanceof ParseError) return e.incomplete;
      return false;
    }
  }
}

function shq(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }
