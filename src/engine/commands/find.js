// find and xargs
import { qa, qf, getopt, quotearg } from './util.js';
import { FsError, joinPath, normPath, basename as pbase, modeString, byteCmp } from '../vfs.js';
import { globRegex, compileRegex } from '../pattern.js';
import { strftime, parseDate } from '../timefmt.js';
import { OutBuf } from '../streams.js';

const C = {};
const USERS = { root: 0, daemon: 1, bin: 2, sys: 3, nobody: 65534, player: 1000 };
const userName = (uid) => ({ 0: 'root', 1: 'daemon', 2: 'bin', 3: 'sys', 65534: 'nobody', 1000: 'player' })[uid] ?? String(uid);
const groupName = (gid) => ({ 0: 'root', 1: 'daemon', 2: 'bin', 3: 'sys', 65534: 'nogroup', 1000: 'player' })[gid] ?? String(gid);

class FindErr extends Error {}
const NO_STAT = {};     // a lazy stat that failed (the file went away after its directory was read)

function cmpNum(spec, value) {
  // spec: '+N' | '-N' | 'N'
  const m = /^([+-]?)(\d+)$/.exec(spec);
  if (!m) return null;
  const n = parseInt(m[2], 10);
  if (m[1] === '+') return value > n;
  if (m[1] === '-') return value < n;
  return value === n;
}

function parsePerm(spec) {
  let mode = spec, kind = 'exact';
  if (spec.startsWith('-')) { kind = 'all'; mode = spec.slice(1); }
  else if (spec.startsWith('/')) { kind = 'any'; mode = spec.slice(1); }
  else if (spec.startsWith('+') && /^\+[0-7]+$/.test(spec)) { kind = 'any'; mode = spec.slice(1); }
  let bits;
  if (/^[0-7]+$/.test(mode)) bits = parseInt(mode, 8);
  else {
    bits = 0;
    for (const clause of mode.split(',')) {
      const m = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(clause);
      if (!m) return null;
      let who = m[1] || 'a';
      if (who.includes('a')) who = 'ugo';
      for (const w of who) {
        const sh = { u: 6, g: 3, o: 0 }[w];
        for (const p of m[3]) {
          if (p === 'r') bits |= 4 << sh;
          if (p === 'w') bits |= 2 << sh;
          if (p === 'x' || p === 'X') bits |= 1 << sh;
          if (p === 's') bits |= w === 'u' ? 0o4000 : w === 'g' ? 0o2000 : 0;
          if (p === 't') bits |= 0o1000;
        }
      }
    }
  }
  return { kind, bits };
}

function sizeUnits(spec) {
  const m = /^([+-]?)(\d+)([cwbkMG]?)$/.exec(spec);
  if (!m) return null;
  const unit = { c: 1, w: 2, b: 512, k: 1024, M: 1048576, G: 1073741824, '': 512 }[m[3]];
  return { sign: m[1], n: parseInt(m[2], 10), unit };
}

function findRegex(re, type, icase) {
  // GNU find default regextype is emacs
  let kind = 'bre', src = re;
  if (type === 'posix-extended' || type === 'posix-egrep' || type === 'egrep' || type === 'posix-awk' || type === 'awk' || type === 'gnu-awk') kind = 'ere';
  else if (type === 'posix-basic' || type === 'grep' || type === 'sed' || type === 'ed') kind = 'bre';
  else {
    // emacs: + and ? are operators, \( \) \| grouping, {} literal
    src = re.replace(/\\\{|\\\}/g, (m) => m).replace(/(\\.)|([+?])/g, (m, esc, op) => esc ? esc : '\\' + op);
    kind = 'bre';
  }
  return compileRegex(src, kind, { icase, line: true });
}

function printfEscapes(s) {
  return s.replace(/\\([abfnrtv\\0]|[0-7]{1,3}|c)/g, (m, d) => {
    if (d === 'c') return '\u0000STOP';
    if (/^[0-7]+$/.test(d) && d !== '0') return String.fromCharCode(parseInt(d, 8) & 255);
    return { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '0': '\0' }[d];
  });
}

C.find = (ctx) => {
  const fs = ctx.fs;
  const argv = ctx.argv.slice(1);
  let i = 0;
  let follow = 'P';
  while (i < argv.length && /^-[HLP]$/.test(argv[i])) { follow = argv[i][1]; i++; }
  if (argv[i] === '-D' || /^-O\d/.test(argv[i] || '')) i += argv[i] === '-D' ? 2 : 1;
  const starts = [];
  while (i < argv.length && !(argv[i].startsWith('-') && argv[i].length > 1) && argv[i] !== '(' && argv[i] !== '!' && argv[i] !== ',') { starts.push(argv[i]); i++; }
  const toks = argv.slice(i);
  if (!starts.length) starts.push('.');
  let maxdepth = Infinity, mindepth = 0, depthFirst = false, regextype = 'emacs', daystart = false;
  let hasAction = false;
  let sawNonOption = false;
  let warned = [];
  const now = fs.now();
  const execBatches = [];
  let quit = false;
  let status = 0;
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const need = (name) => { if (pos >= toks.length) throw new FindErr(`missing argument to \`${name}'`); return next(); };
  let lastPred = null;

  function parseExpr() { return parseComma(); }
  function parseComma() {
    let l = parseOr();
    while (peek() === ',') { pos++; const r = parseOr(); const L = l; l = (e) => { L(e); return r(e); }; }
    return l;
  }
  function parseOr() {
    let l = parseAnd();
    while (peek() === '-o' || peek() === '-or') { pos++; const r = parseAnd(); const L = l; l = (e) => L(e) || r(e); }
    return l;
  }
  function parseAnd() {
    let l = parseNot();
    for (;;) {
      const t = peek();
      if (t === undefined || t === ')' || t === '-o' || t === '-or' || t === ',') break;
      if (t === '-a' || t === '-and') { pos++; }
      const r = parseNot();
      const L = l;
      l = (e) => L(e) && r(e);
    }
    return l;
  }
  function parseNot() {
    const t = peek();
    if (t === '!' || t === '-not' || t === '-!') { pos++; const e = parseNot(); return (x) => !e(x); }
    // apply_predicate(): a test whose stat fails (get_info) is false
    const p = parsePrimary();
    return (x) => { try { return p(x); } catch (err) { if (err === NO_STAT) return false; throw err; } };
  }
  const OPS = ['-o', '-or', '-a', '-and', ','];
  const dirSuffix = (t) => (t === '-execdir' ? 'dir' : '');
  function parsePrimary() {
    const t = next();
    const prev = toks[pos - 2];
    if (t === undefined) throw new FindErr(`expected an expression after '${toks[pos - 2]}'`);
    if (OPS.includes(t)) throw new FindErr(`invalid expression; you have used a binary operator '${t}' with nothing before it.`);
    if (t === ')' && prev !== undefined && [...OPS, '!', '-not'].includes(prev)) throw new FindErr(`expected an expression between '${prev}' and ')'`);
    if (t === '(') {
      if (peek() === undefined) throw new FindErr("invalid expression; expected to find a ')' but didn't see one. Perhaps you need an extra predicate after '('");
      if (peek() === ')') throw new FindErr("invalid expression; empty parentheses are not allowed.");
      const e = parseExpr();
      if (next() !== ')') throw new FindErr("invalid expression; I was expecting to find a ')' somewhere but did not see one.");
      lastPred = ')';
      return e;
    }
    if (t === ')') throw new FindErr("invalid expression; you have too many ')'");
    if (!t.startsWith('-')) throw Object.assign(new FindErr(`paths must precede expression: \`${t}'`), { badPath: t });
    lastPred = t;
    const isOption = ['-maxdepth', '-mindepth', '-depth', '-d', '-xdev', '-mount', '-noleaf', '-ignore_readdir_race', '-noignore_readdir_race', '-regextype', '-daystart', '-follow', '-warn', '-nowarn'].includes(t);
    if (isOption && sawNonOption && ['-maxdepth', '-mindepth', '-depth', '-d', '-xdev', '-mount', '-noleaf'].includes(t)) warned.push(t);
    if (!isOption) sawNonOption = true;
    switch (t) {
      case '-maxdepth': { const v = need(t); if (!/^\d+$/.test(v)) throw new FindErr(`Expected a positive decimal integer argument to -maxdepth, but got ${qa(v)}`); maxdepth = parseInt(v, 10); return () => true; }
      case '-mindepth': { const v = need(t); if (!/^\d+$/.test(v)) throw new FindErr(`Expected a positive decimal integer argument to -mindepth, but got ${qa(v)}`); mindepth = parseInt(v, 10); return () => true; }
      case '-depth': case '-d': depthFirst = true; return () => true;
      case '-xdev': case '-mount': case '-noleaf': case '-ignore_readdir_race': case '-noignore_readdir_race': case '-warn': case '-nowarn': return () => true;
      case '-follow': follow = 'L'; return () => true;
      case '-daystart': daystart = true; return () => true;
      case '-regextype': {
        regextype = need(t);
        const types = ['findutils-default', 'ed', 'emacs', 'gnu-awk', 'grep', 'posix-awk', 'awk', 'posix-basic', 'posix-egrep', 'egrep', 'posix-extended', 'posix-minimal-basic', 'sed'];
        if (!types.includes(regextype)) throw new FindErr(`Unknown regular expression type ${qa(regextype)}; valid types are ${types.map((x) => `'${x}'`).join(', ')}.`);
        return () => true;
      }
      case '-true': return () => true;
      case '-false': return () => false;
      case '-name': case '-iname': {
        const p = need(t);
        const re = globRegex(p, { nocase: t === '-iname', extglob: false });
        return (e) => re.test(e.base);
      }
      case '-path': case '-wholename': case '-ipath': case '-iwholename': {
        const p = need(t);
        const re = globRegex(p, { nocase: t[1] === 'i', extglob: false });
        return (e) => re.test(e.path);
      }
      case '-lname': case '-ilname': {
        const p = need(t);
        const re = globRegex(p, { nocase: t === '-ilname', extglob: false });
        return (e) => e.lnode.type === 'l' && re.test(e.lnode.target);
      }
      case '-regex': case '-iregex': {
        const p = need(t);
        let re;
        try { re = findRegex(p, regextype, t === '-iregex'); } catch { throw new FindErr(`Invalid regular expression ${qa(p)}`); }
        return (e) => re.test(e.path);
      }
      case '-type': case '-xtype': {
        const v = need(t);
        const types = [];
        if (v === '') throw new FindErr(`Arguments to ${t} should contain at least one letter`);
        for (let k = 0; k < v.length; k++) {
          const x = v[k];
          if (!'fdlbcpsD'.includes(x)) throw new FindErr(`Unknown argument to ${t}: ${x}`);
          if (types.includes(x)) throw new FindErr(`Duplicate file type '${x}' in the argument list to ${t}.`);
          types.push(x);
          if (k + 1 < v.length) {
            if (v[k + 1] !== ',') throw new FindErr(`Must separate multiple arguments to ${t} using: ','`);
            k++;
            if (k + 1 >= v.length) throw new FindErr(`Last file type in list argument to ${t} is missing, i.e., list is ending on: ','`);
          }
        }
        const tm = (n) => n ? ({ f: 'f', d: 'd', l: 'l', c: 'c', p: 'p' }[n.type]) : null;
        if (t === '-type') return (e) => types.includes(tm({ type: e.ftype() }));
        return (e) => {
          if (e.lnode.type === 'l') { if (follow === 'L') return types.includes('l') ? false : types.includes(tm(e.node)); let tgt; try { tgt = fs.stat(e.path, ctx.cwd); } catch { tgt = null; } return tgt ? types.includes(tm(tgt)) : types.includes('l'); }
          return types.includes(tm(e.node));
        };
      }
      case '-size': {
        const v = need(t);
        const s = sizeUnits(v);
        if (!s) throw new FindErr(`invalid -size type \`${v.slice(-1)}'`);
        return (e) => {
          if (e.node.type === 'd') { const units = Math.ceil(4096 / s.unit); return s.sign === '+' ? units > s.n : s.sign === '-' ? units < s.n : units === s.n; }
          const units = Math.ceil(e.node.size / s.unit);
          return s.sign === '+' ? units > s.n : s.sign === '-' ? units < s.n : units === s.n;
        };
      }
      case '-empty': return (e) => (e.node.type === 'f' && e.node.size === 0) || (e.node.type === 'd' && e.node.entries.size === 0);
      case '-mtime': case '-atime': case '-ctime': case '-mmin': case '-amin': case '-cmin': {
        const v = need(t);
        if (!/^[+-]?\d+$/.test(v)) throw new FindErr(`invalid argument \`${v}' to \`${t}'`);
        const field = { m: 'mtime', a: 'atime', c: 'ctime' }[t[1]];
        const isMin = t.endsWith('min');
        return (e) => {
          const ref = daystart ? Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) + 86400000 : now;
          const age = (ref - e.node[field]) / (isMin ? 60000 : 86400000);
          if (!isMin) return cmpNum(v, Math.floor(age));
          const n = parseInt(v.replace(/^[+-]/, ''), 10);
          if (v.startsWith('+')) return age > n;
          if (v.startsWith('-')) return age < n;
          return Math.ceil(age) === n;
        };
      }
      case '-newer': case '-anewer': case '-cnewer': {
        const f = need(t);
        let ref;
        try { ref = fs.stat(f, ctx.cwd); } catch { throw new FindErr(`${qa(f)}: No such file or directory`); }
        const field = { '-newer': 'mtime', '-anewer': 'atime', '-cnewer': 'ctime' }[t];
        return (e) => e.node[field] > ref.mtime;
      }
      case '-newermt': case '-newerat': case '-newerct': {
        const d = need(t);
        const ref = parseDate(d, now);
        if (ref === null) throw new FindErr(`I cannot figure out how to interpret ${qa(d)} as a date or time`);
        const field = { m: 'mtime', a: 'atime', c: 'ctime' }[t[6]];
        return (e) => e.node[field] > ref;
      }
      case '-perm': {
        const v = need(t);
        const p = parsePerm(v);
        if (!p) throw new FindErr(`invalid mode ${qa(v)}`);
        return (e) => {
          const m = e.node.mode & 0o7777;
          if (p.kind === 'exact') return m === p.bits;
          if (p.kind === 'all') return (m & p.bits) === p.bits;
          return p.bits === 0 ? true : (m & p.bits) !== 0;
        };
      }
      case '-user': { const v = need(t); const uid = /^\d+$/.test(v) ? +v : USERS[v]; if (uid === undefined) throw new FindErr(`${qa(v)} is not the name of a known user`); return (e) => e.node.uid === uid; }
      case '-group': { const v = need(t); const gid = /^\d+$/.test(v) ? +v : (v === 'root' ? 0 : v === 'player' ? 1000 : v === 'nogroup' ? 65534 : undefined); if (gid === undefined) throw new FindErr(`${qa(v)} is not the name of an existing group`); return (e) => e.node.gid === gid; }
      case '-uid': { const v = need(t); return (e) => cmpNum(v, e.node.uid); }
      case '-gid': { const v = need(t); return (e) => cmpNum(v, e.node.gid); }
      case '-nouser': case '-nogroup': return () => false;
      case '-links': { const v = need(t); return (e) => cmpNum(v, e.node.nlink); }
      case '-inum': { const v = need(t); return (e) => cmpNum(v, e.node.ino); }
      case '-samefile': { const f = need(t); let ref; try { ref = fs.stat(f, ctx.cwd); } catch { throw new FindErr(`${qf(f)}: No such file or directory`); } return (e) => e.node === ref; }
      case '-readable': case '-writable': return () => true;
      case '-executable': return (e) => e.node.type === 'd' || (e.node.mode & 0o111) !== 0;
      case '-fstype': need(t); return () => true;
      case '-used': need(t); return () => true;
      // actions
      case '-print': hasAction = true; return (e) => { ctx.out(e.path + '\n'); return true; };
      case '-print0': hasAction = true; return (e) => { ctx.out(e.path + '\0'); return true; };
      case '-fprint': case '-fprint0': { hasAction = true; const f = need(t); const sink = ctx.openWrite(f, false); return (e) => { sink.write(e.path + (t === '-fprint0' ? '\0' : '\n')); return true; }; }
      case '-printf': case '-fprintf': {
        hasAction = true;
        const sink = t === '-fprintf' ? ctx.openWrite(need(t), false) : null;
        const f = compilePrintf(need(t), ctx);
        return (e) => { const s = findPrintf(f, e, ctx); (sink || ctx.stdout).write(s); return true; };
      }
      case '-ls': case '-fls': {
        // findutils listfile.c print_name_with_quoting()
        const lsQuote = (p) => p.replace(/[\x00-\x20\\\x7f-\xff]/g, (c) => ({ '\\': '\\\\', '\n': '\\n', '\b': '\\b', '\r': '\\r', '\t': '\\t', '\f': '\\f', ' ': '\\ ', '\x07': '\\a' })[c] ?? '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'));
        hasAction = true;
        const sink = t === '-fls' ? ctx.openWrite(need(t), false) : null;
        return (e) => {
          const n = e.lnode;
          const blk = n.type === 'd' ? 4 : n.type === 'f' ? Math.ceil(n.size / 4096) * 4 : 0;
          const date = strftime((now - n.mtime) < 15778476000 ? '%b %e %H:%M' : '%b %e  %Y', new Date(n.mtime));
          (sink || ctx.stdout).write(`${String(n.ino).padStart(9)} ${String(blk).padStart(6)} ${modeString(n)} ${String(n.nlink).padStart(3)} ${userName(n.uid).padEnd(8)} ${groupName(n.gid).padEnd(8)} ${String(n.size).padStart(8)} ${date} ${lsQuote(e.path)}${n.type === 'l' ? ' -> ' + lsQuote(n.target) : ''}\n`);
          return true;
        };
      }
      case '-delete': {
        hasAction = true; depthFirst = true;
        return (e) => {
          if (e.path === '.' || e.path === './' || e.base === '.') return true;
          // pred_delete(): rmdir when the stat says directory, else unlink (and rmdir after EISDIR)
          const del = (dir) => {
            try { if (dir) fs.rmdir(e.path, ctx.cwd); else fs.unlink(e.path, ctx.cwd); return null; }
            catch (err) { if (err instanceof FsError) return err; throw err; }
          };
          const asDir = e.statOk && e.node.type === 'd';
          let err = del(asDir);
          if (err && err.code === 'EISDIR' && !asDir) err = del(true);
          if (!err) return true;
          ctx.err(`cannot delete ${quotearg(e.path, 'locale')}: ${err.message}`); status = 1;
          return false;
        };
      }
      case '-prune': return (e) => { e.prune = true; return true; };
      case '-quit': hasAction = true; return () => { quit = true; return true; };
      case '-exec': case '-execdir': case '-ok': case '-okdir': {
        hasAction = true;
        const args = [];
        let term = null;
        while (pos < toks.length) {
          const x = next();
          if (x === ';') { term = ';'; break; }
          if (x === '+' && args.length && args[args.length - 1] === '{}') { term = '+'; break; }
          if (x === '+' && args.length && args[args.length - 1].includes('{}')) throw new FindErr(`In '${t} ... {} +' the '{}' must appear by itself, but you specified ${qa(args[args.length - 1])}`);
          args.push(x);
        }
        if (!term || !args.length) throw new FindErr(`missing argument to \`${t}'`);
        if (term === '+' && args.filter((x) => x.includes('{}')).length > 1) throw new FindErr(`Only one instance of {} is supported with -exec${dirSuffix(t)} ... +`);
        const dirMode = t === '-execdir' || t === '-okdir';
        const ok = t === '-ok' || t === '-okdir';
        if (term === '+') {
          const batch = { args: args.slice(0, -1), groups: new Map(), dirMode };
          execBatches.push(batch);
          return (e) => {
            const key = dirMode ? e.dir : '';
            if (!batch.groups.has(key)) batch.groups.set(key, []);
            batch.groups.get(key).push(dirMode ? './' + e.base : e.path);
            return true;
          };
        }
        return (e) => {
          const repl = dirMode ? './' + e.base : e.path;
          const cmd = args.map(x => x.includes('{}') ? x.split('{}').join(repl) : x);
          if (ok) {
            ctx.stderr.write(`< ${qf(args[0])} ... ${qf(repl)} > ? `);
            const ans = ctx.stdin.readUntil('\n');
            if (!ans || !/^[yY]/.test(ans.text)) return false;
          }
          if (!runnable(cmd[0], dirMode ? e.dir : undefined)) return false;
          const st = ctx.spawn(cmd, { cwd: dirMode ? e.dir : undefined });
          return st === 0;
        };
      }
      default:
        throw new FindErr(`unknown predicate \`${t}'`);
    }
  }

  // the child find forks can't exec: it reports and the test is false
  const runnable = (name, cwd) => {
    const save = ctx.sh.cwd;
    if (cwd) ctx.sh.cwd = cwd;
    try {
      const f = ctx.sh.findExecutable(name);
      if (!f) { ctx.err(`${qa(name)}: No such file or directory`); return false; }
      if (f.node.type === 'd' || !(f.node.mode & 0o111)) { ctx.err(`${qa(name)}: Permission denied`); return false; }
      return true;
    } finally { ctx.sh.cwd = save; }
  };
  let expr;
  try {
    expr = toks.length ? parseExpr() : () => true;
    if (pos < toks.length) {
      const t = toks[pos];
      if (t === ')') throw new FindErr("invalid expression; you have too many ')'");
      throw Object.assign(new FindErr(`paths must precede expression: \`${t}'`), { badPath: t });
    }
  } catch (e) {
    if (e instanceof FindErr) {
      ctx.err(e.message);
      // findutils adds a hint when the stray operand is an existing file (an unquoted glob that expanded)
      if (e.badPath !== undefined && lastPred) {
        let exists = false;
        try { ctx.fs.lstat(e.badPath, ctx.cwd); exists = true; } catch {}
        if (exists) ctx.err(`possible unquoted pattern after predicate \`${lastPred}'?`);
      }
      return 1;
    }
    throw e;
  }
  if (false) for (const w of warned) ctx.err(`warning: you have specified the global option ${w} after the argument ${toks.find(x => x.startsWith('-') && !['-maxdepth', '-mindepth', '-depth', '-d', '-xdev', '-mount', '-noleaf'].includes(x)) || ''}, but global options are not positional, i.e., ${w} affects tests specified before it as well as those specified after it.  Please specify global options before other arguments.`);
  const full = hasAction ? expr : (e) => { if (expr(e)) ctx.out(e.path + '\n'); return true; };

  // ftsfind.c over gnulib fts (FTS_NOSTAT): a directory's names and d_types are read when find
  // descends into it, after its own pre-order visit, so an action that removed it makes that
  // descent fail. Start points, directories and the links -L follows are stat'ed when they are
  // reached; anything else only when a test needs it, so an entry removed after its directory
  // was read is still visited by name. Errors about a file are reported once per visit.
  const errName = (p) => quotearg(p, 'locale');
  const followed = (isStart) => follow === 'L' || (follow === 'H' && isStart);
  // FTS_CWDFD: below a start point, names are looked up in the parent directory fts has open
  // (which may have been removed or moved since), not along the path
  const lookup = (parent, name, path) => {
    if (!parent) return fs.lstat(path, ctx.cwd);
    const n = parent.entries.get(name);
    if (!n) throw new FsError('ENOENT', path);
    return n;
  };
  const makeEntry = (path, start, depth, isStart, dtype, parent, name) => {
    const base = isStart ? pbase(path) || path : path.slice(path.lastIndexOf('/') + 1);
    // %f is gnulib's base_name, which keeps a start point's trailing slashes
    const fbase = isStart ? (/^\/+$/.test(path) ? '/' : path.replace(/^.*\/(?=[^/]+\/*$)/, '')) : base;
    const dir = isStart ? (path.includes('/') ? path.slice(0, path.replace(/\/+$/, '').lastIndexOf('/')) || '/' : '.') : path.slice(0, path.lastIndexOf('/'));
    const relDir = dir === '' ? '/' : dir;
    const e = { path, base, fbase, depth, start, dir: relDir.startsWith('/') ? relDir : normPath(joinPath(ctx.cwd, relDir)), prune: false, dtype, statOk: false, errIssued: false, sn: null, sl: null };
    e.report = (msg) => { if (!e.errIssued) { ctx.err(`${errName(path)}: ${msg}`); e.errIssued = true; } status = 1; };
    e.stat = () => {
      if (e.statOk) return true;
      let l;
      try { l = lookup(parent, name, path); }
      catch (err) { if (!(err instanceof FsError)) throw err; e.report(err.message); return false; }
      let n = l;
      if (l.type === 'l' && followed(isStart)) { try { n = fs.stat(path, ctx.cwd); } catch { n = l; } }
      e.sl = l; e.sn = n; e.statOk = true;
      return true;
    };
    Object.defineProperty(e, 'node', { get() { if (!e.stat()) throw NO_STAT; return e.sn; } });
    Object.defineProperty(e, 'lnode', { get() { if (!e.stat()) throw NO_STAT; return e.sl; } });
    // -type needs no stat when readdir's d_type said what it is
    e.ftype = () => (e.statOk || e.dtype === null ? e.node.type : e.dtype);
    return e;
  };
  const visit = (path, start, depth, isStart, seenDirs, dtype = null, parent = null, name = null) => {
    if (quit) return;
    ctx.tick();
    const e = makeEntry(path, start, depth, isStart, dtype, parent, name);
    if (isStart || dtype === 'd' || (dtype === 'l' && follow === 'L')) {
      if (!e.stat()) {
        if (isStart) return;
        e.dtype = null;        // FTS_NS: still visited by name, with no type
      }
    }
    const node = e.statOk ? e.sn : null;
    if (follow === 'L' && node && node.type === 'd' && seenDirs.has(node)) {
      // a symlink back into its own ancestry: fts reports a cycle, and find doesn't test it
      ctx.err(`File system loop detected; ${errName(path)} is part of the same file system loop as ${errName(start)}.`);
      status = 1;
      return;
    }
    const doDir = node && node.type === 'd' && depth < maxdepth;
    if (!depthFirst && depth >= mindepth) full(e);
    if (doDir && !e.prune && !quit) {
      // fts_build(): open the directory and read its names now
      let dn = null, code = null;
      try {
        dn = lookup(parent, name, path);
        if (dn.type === 'l' && followed(isStart)) dn = fs.stat(path, ctx.cwd);
      } catch (err) { if (!(err instanceof FsError)) throw err; code = err.code; }
      if (!code) code = dn.type === 'l' ? 'ELOOP' : dn.type !== 'd' ? 'ENOTDIR' : dn !== node ? 'ENOENT' : null;
      if (code) {
        // FTS_DNR is a visit of its own: reported, and only -depth still tests the directory
        ctx.err(`${errName(path)}: ${new FsError(code, path).message}`);
        status = 1;
        if (depthFirst && depth >= mindepth && !quit) { e.errIssued = true; full(e); }
        return;
      }
      seenDirs.add(node);
      const names = [...dn.entries].map(([name, c]) => [name, c.type]);
      for (const [cname, t] of names) {
        if (quit) break;
        const child = path.endsWith('/') ? path + cname : path + '/' + cname;
        visit(child, start, depth + 1, false, seenDirs, t, dn, cname);
      }
      seenDirs.delete(node);
    }
    if (depthFirst && depth >= mindepth && !quit) full(e);
  };
  for (const s of starts) {
    if (quit) break;
    visit(s, s, 0, true, new Set());
  }
  for (const b of execBatches) {
    for (const [dir, paths] of b.groups) {
      for (let k = 0; k < paths.length; k += 5000) {
        if (!runnable(b.args[0], b.dirMode ? dir : undefined)) { status = 1; continue; }
        const st = ctx.spawn([...b.args, ...paths.slice(k, k + 5000)], { cwd: b.dirMode ? dir : undefined });
        if (st !== 0) status = 1;
      }
    }
  }
  return status;
};

// -printf is compiled when find parses it, as findutils does: escapes and bad directives are
// reported then (a trailing % is fatal), and each directive keeps its printf flags.
function compilePrintf(fmt, ctx) {
  const segs = [];
  let lit = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === '\\') {
      const d = fmt[i + 1];
      if (d === undefined) { ctx.err("warning: escape `\\' followed by nothing at all"); lit += '\\'; continue; }
      if (d === 'c') { if (lit) segs.push({ lit }); segs.push({ stop: true }); return segs; }
      if (d >= '0' && d <= '7') { let o = ''; let j = i + 1; while (o.length < 3 && fmt[j] >= '0' && fmt[j] <= '7') o += fmt[j++]; lit += String.fromCharCode(parseInt(o, 8) & 255); i = j - 1; continue; }
      const esc = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' }[d];
      if (esc === undefined) { ctx.err(`warning: unrecognized escape \`\\${d}'`); lit += '\\' + d; i++; continue; }
      lit += esc; i++;
      continue;
    }
    if (c !== '%') { lit += c; continue; }
    if (fmt[i + 1] === undefined) throw new FindErr(`error: ${fmt.slice(i)} at end of format string`);
    if (fmt[i + 1] === '%') { lit += '%'; i++; continue; }
    let j = i + 1, flags = '', width = '', prec = null;
    while ('-+ #0'.includes(fmt[j]) && j < fmt.length) flags += fmt[j++];
    while (fmt[j] >= '0' && fmt[j] <= '9') width += fmt[j++];
    if (fmt[j] === '.') { j++; prec = ''; while (fmt[j] >= '0' && fmt[j] <= '9') prec += fmt[j++]; }
    const d = fmt[j];
    if (d === undefined) throw new FindErr(`error: ${fmt.slice(i)} at end of format string`);
    if ('ACTB'.includes(d)) {
      const k = fmt[j + 1];
      if (k === undefined) { ctx.err(`warning: format directive \`%${d}' should be followed by another character`); lit += fmt.slice(i, j + 1); i = j; continue; }
      if (lit) { segs.push({ lit }); lit = ''; }
      segs.push({ d, k, flags, width, prec });
      i = j + 1;
      continue;
    }
    if (!'pfhPHdDsbkmMugUGinlyYatcFSZ'.includes(d)) {
      if ('{[('.includes(d)) throw new FindErr(`error: the format directive \`%${d}' is reserved for future use`);
      ctx.err(`warning: unrecognized format directive \`%${d}'`);
      lit += fmt.slice(i, j + 1);
      i = j;
      continue;
    }
    if (lit) { segs.push({ lit }); lit = ''; }
    segs.push({ d, flags, width, prec });
    i = j;
  }
  if (lit) segs.push({ lit });
  return segs;
}

function findPrintf(segs, e, ctx) {
  let out = '';
  const ln = e.lnode;
  const tfmt = (t, k) => {
    const date = new Date(t);
    if (k === '@') return (t / 1000).toFixed(10);
    if (k === '+') return strftime('%Y-%m-%d+%H:%M:%S.0000000000', date);
    if (k === 'S') return strftime('%S.0000000000', date);
    if (k === 'T') return strftime('%H:%M:%S.0000000000', date);
    return strftime('%' + k, date);
  };
  for (const sg of segs) {
    if (sg.stop) return out;
    if (sg.lit !== undefined) { out += sg.lit; continue; }
    const { d, flags, width, prec } = sg;
    let v, numeric = false;
    switch (d) {
      case 'p': v = e.path; break;
      case 'f': v = e.fbase; break;
      case 'h': { const p = e.path.replace(/([^/])\/+$/, '$1'); const k = p.lastIndexOf('/'); v = k < 0 ? '.' : p.slice(0, k); break; }
      case 'P': v = e.path === e.start ? '' : e.path.slice(e.start.length + (e.start.endsWith('/') ? 0 : 1)); break;
      case 'H': v = e.start; break;
      case 'd': v = e.depth; numeric = 'd'; break;
      case 'D': v = '47'; break;
      case 's': v = String(ln.size); break;
      case 'k': v = String(ln.type === 'd' ? 4 : ln.type === 'f' ? Math.ceil(ln.size / 4096) * 4 : 0); break;
      case 'b': v = String(ln.type === 'd' ? 8 : ln.type === 'f' ? Math.ceil(ln.size / 4096) * 8 : 0); break;
      case 'm': v = ln.mode & 0o7777; numeric = 'o'; break;
      case 'M': v = modeString(ln); break;
      case 'u': v = userName(ln.uid); break;
      case 'U': v = String(ln.uid); break;
      case 'g': v = groupName(ln.gid); break;
      case 'G': v = String(ln.gid); break;
      case 'i': v = String(ln.ino); break;
      case 'n': v = String(ln.nlink); break;
      case 'l': v = ln.type === 'l' ? ln.target : ''; break;
      case 'y': v = { f: 'f', d: 'd', l: 'l', c: 'c', p: 'p' }[ln.type] || 'U'; break;
      case 'Y': { if (ln.type !== 'l') { v = { f: 'f', d: 'd', c: 'c', p: 'p' }[ln.type] || 'U'; break; } try { const t = ctx.fs.stat(e.path, ctx.cwd); v = { f: 'f', d: 'd', c: 'c', p: 'p', l: 'L' }[t.type]; } catch (err) { v = err.code === 'ELOOP' ? 'L' : 'N'; } break; }
      case 'a': v = strftime('%a %b %e %H:%M:%S.0000000000 %Y', new Date(ln.atime)); break;
      case 't': v = strftime('%a %b %e %H:%M:%S.0000000000 %Y', new Date(ln.mtime)); break;
      case 'c': v = strftime('%a %b %e %H:%M:%S.0000000000 %Y', new Date(ln.ctime)); break;
      case 'A': v = tfmt(ln.atime, sg.k); break;
      case 'T': v = tfmt(ln.mtime, sg.k); break;
      case 'C': case 'B': v = tfmt(ln.ctime, sg.k); break;
      case 'F': v = 'overlay'; break;
      case 'S': v = '1'; break;
      case 'Z': v = '?'; break;
    }
    if (numeric) {
      // %d and %m are printed with C's %d / %o, so 0 + # and precision apply
      let digits = numeric === 'o' ? v.toString(8) : String(Math.abs(v));
      if (prec !== null) digits = digits.padStart(+prec || 0, '0');
      if (numeric === 'o' && flags.includes('#') && digits[0] !== '0') digits = '0' + digits;
      let sign = numeric === 'd' && v < 0 ? '-' : numeric === 'd' && flags.includes('+') ? '+' : numeric === 'd' && flags.includes(' ') ? ' ' : '';
      let str = sign + digits;
      if (width && str.length < +width) {
        if (flags.includes('-')) str = str.padEnd(+width);
        else if (flags.includes('0') && prec === null) str = sign + digits.padStart(+width - sign.length, '0');
        else str = str.padStart(+width);
      }
      out += str;
      continue;
    }
    // everything else is a string (C %s): precision truncates, - pads right, 0 + # do nothing
    if (prec !== null) v = v.slice(0, +prec || 0);
    if (width) v = flags.includes('-') ? v.padEnd(+width) : v.padStart(+width);
    out += v;
  }
  return out;
}

// ---------------------------------------------------------------- xargs
// The arguments xargs reads, as findutils' read_line / read_string produce them: one entry per
// input line ({ args, blankEnd }), so -L can count lines. Default mode: blanks separate, quotes
// and backslashes protect, a line's leading blanks are skipped; -I keeps each line whole.
function xargsRead(data, opts, warnNul) {
  const lines = [];
  if (opts.null || opts.delim !== null) {
    const d = opts.null ? '\0' : opts.delim;
    const parts = data.split(d);
    if (parts[parts.length - 1] === '') parts.pop();
    for (const p of parts) lines.push({ args: [p], blankEnd: false });
    return { lines };
  }
  let i = 0;
  const n = data.length;
  for (;;) {
    if (i >= n) return { lines };
    const args = [];
    let cur = '', seen = false, state = 'space', quote = '', prev = '';
    const push = () => { const k = cur.indexOf('\0'); args.push(k >= 0 ? cur.slice(0, k) : cur); cur = ''; seen = false; };
    for (;;) {
      if (i >= n) {
        if (state === 'quote') return { lines, args, error: `unmatched ${quote === '"' ? 'double' : 'single'} quote; by default quotes are special to xargs unless you use the -0 option` };
        if (seen || cur) push();
        if (args.length) lines.push({ args, blankEnd: false });
        return { lines };
      }
      const c = data[i++];
      if (state === 'space') { if (c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r') { prev = c; continue; } state = 'norm'; }
      if (state === 'norm') {
        if (c === '\n') {
          if (seen || cur) push();
          lines.push({ args, blankEnd: prev === ' ' || prev === '\t' });
          break;
        }
        seen = true;
        if (!opts.replace && (c === ' ' || c === '\t')) { push(); state = 'space'; prev = c; continue; }
        if (c === '\\') { state = 'backslash'; prev = c; continue; }
        if (c === "'" || c === '"') { state = 'quote'; quote = c; prev = c; continue; }
      } else if (state === 'quote') {
        if (c === '\n') return { lines, args, error: `unmatched ${quote === '"' ? 'double' : 'single'} quote; by default quotes are special to xargs unless you use the -0 option` };
        if (c === quote) { state = 'norm'; seen = true; prev = c; continue; }
      } else if (state === 'backslash') state = 'norm';
      if (c === '\0') warnNul();
      cur += c;
      prev = c;
    }
  }
}

C.xargs = (ctx) => {
  const r = getopt(ctx.argv.slice(1), {
    name: 'xargs', short: '0a:E:e::i::I:l::L:n:oprs:txP:d:',
    long: {
      null: '0', 'arg-file': ['a', 'required'], delimiter: ['d', 'required'], eof: ['e', 'optional'], replace: ['i', 'optional'],
      'max-lines': ['l', 'optional'], 'max-args': ['n', 'required'], 'open-tty': 'o', interactive: 'p', 'no-run-if-empty': 'r',
      'max-chars': ['s', 'required'], 'show-limits': 'S', verbose: 't', exit: 'x', 'max-procs': ['P', 'required'],
      'process-slot-var': ['X', 'required'], version: 'v', help: 'h',
    },
  }, { permute: false });
  const usageFail = () => { ctx.stderr.write("Try 'xargs --help' for more information.\n"); return 1; };
  for (const [k] of r.opts) if (k === 'v') { ctx.out('xargs (GNU findutils) 4.8.0\n'); return 0; }
  if (r.error) { ctx.stderr.write(r.error + '\n'); return usageFail(); }
  const opts = { null: false, delim: null, maxArgs: 0, maxLines: 0, replace: null, noRun: false, trace: false, eof: null, interactive: false, argMax: 131072, exitIfTooBig: false, argFile: '-' };
  const warnMX = (option, offending) => ctx.stderr.write(`xargs: warning: options ${offending} and ${option} are mutually exclusive, ignoring previous ${offending} value\n`);
  // findutils parse_num: a bad number ends xargs; out-of-range ones too unless `fatal` is false
  const num = (str, o, min, max, fatal = true) => {
    if (!/^\s*[+-]?\d+$/.test(str)) { ctx.stderr.write(`xargs: invalid number "${str}" for -${o} option\n`); throw new XStop(usageFail()); }
    let v = parseInt(str, 10);
    if (v < min) { ctx.stderr.write(`xargs: value ${str} for -${o} option should be >= ${min}\n`); if (fatal) throw new XStop(usageFail()); v = min; }
    else if (max >= 0 && v > max) { ctx.stderr.write(`xargs: value ${str} for -${o} option should be <= ${max}\n`); if (fatal) throw new XStop(usageFail()); v = max; }
    return v;
  };
  try {
    for (const [k, v] of r.opts) {
      switch (k) {
        case '0': opts.null = true; opts.delim = null; break;
        case 'd': opts.delim = unescapeDelim(v); opts.null = false; break;
        case 'E': case 'e': opts.eof = v ? v : null; break;
        case 'I': case 'i':
          opts.replace = v ?? '{}';
          if (opts.maxArgs) { warnMX('--replace/-I/-i', '--max-args'); opts.maxArgs = 0; }
          if (opts.maxLines) { warnMX('--replace/-I/-i', '--max-lines'); opts.maxLines = 0; }
          break;
        case 'L':
          opts.maxLines = num(v, 'L', 1, -1);
          if (opts.maxArgs) { warnMX('-L', '--max-args'); opts.maxArgs = 0; }
          if (opts.replace !== null) { warnMX('-L', '--replace'); opts.replace = null; }
          break;
        case 'l':
          opts.maxLines = v ? num(v, 'l', 1, -1) : 1;
          if (opts.maxArgs) { warnMX('--max-lines/-l', '--max-args'); opts.maxArgs = 0; }
          if (opts.replace !== null) { warnMX('--max-lines/-l', '--replace'); opts.replace = null; }
          break;
        case 'n':
          opts.maxArgs = num(v, 'n', 1, -1);
          if (opts.maxLines) { warnMX('--max-args/-n', '--max-lines'); opts.maxLines = 0; }
          if (opts.replace !== null) {
            if (opts.maxArgs === 1) opts.maxArgs = 0;   // -I with -n1 is fine
            else { warnMX('--max-args/-n', '--replace'); opts.replace = null; }
          }
          break;
        case 's': {
          let n = num(v, 's', 1, 2091735, false);
          opts.argMax = n;
          break;
        }
        case 't': opts.trace = true; break;
        case 'x': opts.exitIfTooBig = true; break;
        case 'p': opts.interactive = true; opts.trace = true; break;
        case 'r': opts.noRun = true; break;
        case 'P': num(v, 'P', 0, 2147483647); break;
        case 'a': opts.argFile = v; break;
        case 'S': break;
        case 'X':
          if (v.includes('=')) { ctx.err(`option --process-slot-var may not be set to a value which includes \`='`); return 1; }
          break;
        case 'h': ctx.out('Usage: xargs [OPTION]... COMMAND [INITIAL-ARGS]...\nRun COMMAND with arguments INITIAL-ARGS and more arguments read from input.\n'); return 0;
      }
    }
  } catch (e) { if (e instanceof XStop) return e.code; throw e; }
  if (opts.eof !== null && (opts.null || opts.delim !== null)) ctx.stderr.write('xargs: warning: the -E option has no effect if -0 or -d is used.\n\n');
  let cmd = r.operands;
  if (!cmd.length) cmd = ['echo'];
  let data;
  if (opts.argFile !== '-') { try { data = ctx.readFile(opts.argFile); } catch (e) { ctx.err(`Cannot open input file ${qa(opts.argFile)}: ${e.message}`); return 1; } }
  else data = ctx.stdin.readAll();
  let nulWarned = false;
  const warnNul = () => { if (!nulWarned) { nulWarned = true; ctx.err('WARNING: a NUL character occurred in the input.  It cannot be passed through in the argument list.  Did you mean to use the --null option?'); } };
  const input = xargsRead(data, opts, warnNul);
  let status = 0, execs = 0;
  // a command xargs can't run ends xargs (127/126); signals 125; exit 255 stops with 124.
  // `ran` runs before the child's exit status is looked at (xargs goes on while it runs).
  const launch = (full, ran = null) => {
    execs++;
    if (opts.interactive) {
      // -p asks on /dev/tty, which there isn't
      ctx.stderr.write(full.map(qf).join(' '));
      ctx.err('failed to open /dev/tty for reading: No such device or address');
      throw new XStop(1);
    }
    if (opts.trace) ctx.stderr.write(full.map(qf).join(' ') + '\n');
    const found = ctx.sh.findExecutable(full[0]);
    if (!found) { ctx.err(`${full[0]}: No such file or directory`); throw new XStop(127); }
    if (found.node.type === 'd' || !(found.node.mode & 0o111)) { ctx.err(`${full[0]}: Permission denied`); throw new XStop(126); }
    const st = ctx.spawn(full);
    if (ran) ran();
    if (st === 255) { ctx.err(`${full[0]}: exited with status 255; aborting`); throw new XStop(124); }
    if (st > 128 && st < 160) { ctx.err(`${full[0]}: terminated by signal ${st - 128}`); throw new XStop(125); }
    if (st !== 0) status = 123;
  };
  const size = (args) => args.reduce((n, a) => n + a.length + 1, 0);
  // an unmatched quote: exec_if_possible() starts the command for the arguments read so far
  // (not with -I or -x), die() reports the quote while it runs (which of the two writes first
  // is a race), and the exit waits for it: 123 when any command failed, else 1
  const quoteError = (pending) => {
    const report = () => ctx.err(input.error);
    // (-I and -L imply -x here: main() sets exit_if_size_exceeded for them)
    if (pending && pending.length && opts.replace === null && !opts.maxLines && !opts.exitIfTooBig) launch([...cmd, ...pending], report);
    else report();
    return status === 123 ? 123 : 1;
  };
  try {
    if (opts.replace !== null) {
      if (opts.replace === '') { ctx.err('command too long'); return 1; }
      let stopped = false;
      for (const ln of input.lines) {
        const item = ln.args.join(' ');
        if (opts.eof !== null && item === opts.eof) { stopped = true; break; }
        const full = cmd.map((x) => x.split(opts.replace).join(item));
        if (size(full) > opts.argMax) { ctx.err('command too long'); return 1; }
        launch(full);
      }
      if (input.error && !stopped) return quoteError(null);
      return status;
    }
    const base = size(cmd);
    if (base > opts.argMax) { ctx.err('cannot fit single argument within argument list size limit'); return 1; }
    let cur = [], chars = base, lines = 0;
    const flush = () => { launch([...cmd, ...cur]); cur = []; chars = base; };
    const pushArg = (a) => {
      if (chars + a.length + 1 > opts.argMax) {
        if (!cur.length) { ctx.err('argument line too long'); throw new XStop(1); }
        if (opts.exitIfTooBig && (opts.maxLines || opts.maxArgs)) { ctx.err('argument list too long'); throw new XStop(1); }
        flush();
      }
      if (opts.maxArgs && cur.length === opts.maxArgs) flush();
      cur.push(a); chars += a.length + 1;
    };
    let stopped = false;
    for (const ln of input.lines) {
      for (const a of ln.args) {
        if (opts.eof !== null && !opts.null && opts.delim === null && a === opts.eof) { stopped = true; break; }
        pushArg(a);
      }
      if (stopped) break;
      if (!ln.blankEnd) lines++;
      if (opts.maxLines && lines >= opts.maxLines) { if (cur.length) flush(); lines = 0; }
    }
    if (input.error && !stopped && input.args) {
      // the words before the quote on that last line (the EOF string still ends the input)
      for (const a of input.args) {
        if (opts.eof !== null && a === opts.eof) { stopped = true; break; }
        pushArg(a);
      }
    }
    if (input.error && !stopped) return quoteError(cur);
    if (cur.length || (!opts.noRun && execs === 0)) flush();
  } catch (e) {
    if (e instanceof XStop) return e.code;
    throw e;
  }
  return status;
};

class XStop { constructor(code) { this.code = code; } }

function unquoteXargs(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') { const j = s.indexOf(c, i + 1); if (j < 0) { out += s.slice(i + 1); break; } out += s.slice(i + 1, j); i = j; continue; }
    if (c === '\\' && i + 1 < s.length) { out += s[++i]; continue; }
    out += c;
  }
  return out;
}

function unescapeDelim(d) {
  if (d === undefined) return '\n';
  if (d.length === 1) return d;
  const map = { '\\n': '\n', '\\t': '\t', '\\0': '\0', '\\\\': '\\', '\\r': '\r', '\\a': '\x07', '\\b': '\b', '\\f': '\f', '\\v': '\v' };
  if (map[d]) return map[d];
  if (/^\\x[0-9a-fA-F]{2}$/.test(d)) return String.fromCharCode(parseInt(d.slice(2), 16));
  if (/^\\[0-7]{1,3}$/.test(d)) return String.fromCharCode(parseInt(d.slice(1), 8));
  return d[0];
}

export default C;
