// Misc utilities: echo printf test env printenv sleep timeout nice nohup whoami id groups hostname uname nproc arch
// date cal factor expr numfmt base64 base32 cksum *sum xxd od hexdump cmp tsort ps pgrep pkill kill which whereis
// rename bash sh clear tput stty locale uptime free who w users logname lsb_release getconf true false
import { parseArgs, qa, qf, eachInput, splitLines, readErrMsg, getopt, xstrtol, StdioBuffer, LONGINT_OK, LONGINT_INVALID_SUFFIX_CHAR, quotearg } from './util.js';
import { FsError, joinPath, basename as pbase, byteCmp } from '../vfs.js';
import { doPrintf } from '../printf.js';
import { strftime, parseDateNs } from '../timefmt.js';
import { HASHES, cksum as crc } from '../hash.js';
import { testExpr, doKill, SIGNALS, signalNumber } from '../builtins.js';
import { decodeEscapes } from '../shell.js';
import { pcreToJs, posixToJs } from '../pattern.js';
import { binToB64, b64ToBin } from '../bytes.js';

const C = {};

C.true = () => 0;
C.false = () => 1;

C.echo = (ctx) => {
  const args = ctx.argv.slice(1);
  let i = 0, nl = true, esc = false;
  while (i < args.length && /^-[neE]+$/.test(args[i])) { for (const c of args[i].slice(1)) { if (c === 'n') nl = false; else if (c === 'e') esc = true; else esc = false; } i++; }
  const s = args.slice(i).join(' ');
  if (esc) { const r = decodeEscapes(s, { echo: true }); ctx.out(r.text + (r.stop ? '' : nl ? '\n' : '')); }
  else ctx.out(s + (nl ? '\n' : ''));
  return 0;
};

C.printf = (ctx) => {
  const args = ctx.argv.slice(1);
  if (!args.length) { ctx.err('missing operand'); ctx.stderr.write("Try 'printf --help' for more information.\n"); return 1; }
  const r = doPrintf(args[0], args.slice(1), { err: (m) => ctx.err(m), coreutils: true, write: (s) => ctx.out(s), flush: 'all' });
  ctx.out(r.out);
  return r.status;
};

C.test = C['['] = (ctx) => {
  let args = ctx.argv.slice(1);
  if (ctx.name === '[') {
    if (args[args.length - 1] !== ']') { ctx.err("missing ']'"); return 2; }
    args = args.slice(0, -1);
  }
  try { return testExpr(ctx.sh, args) ? 0 : 1; }
  catch (e) { ctx.err(e.message.replace(/^(.*): integer expression expected$/, 'invalid integer $1').replace(/^invalid integer (.*)$/, (m, x) => `invalid integer ${qa(x)}`)); return 2; }
};

// ---------------------------------------------------------------- env / process-ish
C.env = (ctx) => {
  const argv = ctx.argv.slice(1);
  let env = { ...ctx.env };
  let i = 0, nul = false, chdir = null;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-i' || a === '--ignore-environment' || a === '-') { env = {}; continue; }
    if (a === '-0' || a === '--null') { nul = true; continue; }
    if (a === '-u' || a === '--unset') { delete env[argv[++i]]; continue; }
    if (a.startsWith('-u') && a.length > 2) { delete env[a.slice(2)]; continue; }
    if (a.startsWith('--unset=')) { delete env[a.slice(8)]; continue; }
    if (a === '-C' || a === '--chdir') { chdir = argv[++i]; continue; }
    if (a === '-S' || a === '--split-string') { const parts = (argv[++i] || '').split(/\s+/).filter(Boolean); argv.splice(i + 1, 0, ...parts); continue; }
    if (a === '--') { i++; break; }
    if (a.startsWith('-') && a.length > 1 && !a.includes('=')) { ctx.stderr.write(`env: invalid option -- '${a[1]}'\nTry 'env --help' for more information.\n`); return 125; }
    break;
  }
  for (; i < argv.length; i++) { const m = /^([^=]+)=([\s\S]*)$/.exec(argv[i]); if (!m) break; env[m[1]] = m[2]; }
  const cmd = argv.slice(i);
  if (!cmd.length) { ctx.out(Object.entries(env).map(([k, v]) => `${k}=${v}`).join(nul ? '\0' : '\n') + (Object.keys(env).length ? (nul ? '\0' : '\n') : '')); return 0; }
  const st = ctx.spawn(cmd, { env, cwd: chdir ? joinPath(ctx.cwd, chdir) : undefined });
  if (st === 127) { ctx.stderr.write(''); }
  return st;
};

C.printenv = (ctx) => {
  const names = ctx.argv.slice(1).filter(x => x !== '-0' && x !== '--null');
  const nul = ctx.argv.includes('-0');
  if (!names.length) { ctx.out(Object.entries(ctx.env).map(([k, v]) => `${k}=${v}`).join(nul ? '\0' : '\n') + (nul ? '\0' : '\n')); return 0; }
  let st = 0;
  for (const n of names) { if (ctx.env[n] !== undefined) ctx.out(ctx.env[n] + (nul ? '\0' : '\n')); else st = 1; }
  return st;
};

C.sleep = (ctx) => {
  const args = ctx.argv.slice(1);
  if (!args.length) { ctx.err('missing operand'); ctx.stderr.write("Try 'sleep --help' for more information.\n"); return 1; }
  for (const a of args) if (!/^(\d+\.?\d*|\.\d+)[smhd]?$/.test(a) && a !== 'infinity' && a !== 'inf') { ctx.err(`invalid time interval ${qa(a)}`); ctx.stderr.write("Try 'sleep --help' for more information.\n"); return 1; }
  return 0;
};

C.timeout = (ctx) => {
  const argv = ctx.argv.slice(1);
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-s' || a === '--signal' || a === '-k' || a === '--kill-after') { i++; continue; }
    if (/^-(s|k).+/.test(a) || a.startsWith('--signal=') || a.startsWith('--kill-after=') || a === '--preserve-status' || a === '--foreground' || a === '-v' || a === '--verbose') continue;
    break;
  }
  const dur = argv[i];
  const cmd = argv.slice(i + 1);
  if (dur === undefined || !cmd.length) { ctx.err('missing operand'); ctx.stderr.write("Try 'timeout --help' for more information.\n"); return 125; }
  return ctx.spawn(cmd);
};

C.nice = C.nohup = C.stdbuf = C.ionice = C.chrt = C.setsid = C.unbuffer = (ctx) => {
  let args = ctx.argv.slice(1);
  if (ctx.name === 'nice') { if (args[0] === '-n') args = args.slice(2); else if (/^-\d+$/.test(args[0] || '')) args = args.slice(1); else if (/^--adjustment=/.test(args[0] || '')) args = args.slice(1); if (!args.length) { ctx.out('0\n'); return 0; } }
  if (ctx.name === 'stdbuf') while (args.length && /^-[ioe]/.test(args[0])) args = args.slice(args[0].length > 2 ? 1 : 2);
  if (ctx.name === 'nohup' && args.length) ctx.stderr.write('nohup: ignoring input\n');
  if (!args.length) { ctx.err('missing operand'); return 125; }
  return ctx.spawn(args);
};

C.whoami = (ctx) => { ctx.out('root\n'); return 0; };
C.logname = (ctx) => { ctx.err('no login name'); return 1; };
C.groups = (ctx) => { ctx.out('root\n'); return 0; };
C.id = (ctx) => {
  const a = ctx.argv.slice(1);
  const flags = a.filter(x => x.startsWith('-')).join('');
  if (/u/.test(flags)) { ctx.out((/n/.test(flags) ? 'root' : '0') + '\n'); return 0; }
  if (/g/.test(flags) && !/G/.test(flags)) { ctx.out((/n/.test(flags) ? 'root' : '0') + '\n'); return 0; }
  if (/G/.test(flags)) { ctx.out((/n/.test(flags) ? 'root' : '0') + '\n'); return 0; }
  ctx.out('uid=0(root) gid=0(root) groups=0(root)\n');
  return 0;
};
C.hostname = (ctx) => {
  const a = ctx.argv.slice(1);
  if (a.includes('-i') || a.includes('-I') || a.includes('--ip-address')) { ctx.out(a.includes('-I') ? '10.0.2.100 \n' : '10.0.2.100\n'); return 0; }
  if (a.length && !a[0].startsWith('-')) { ctx.err('you must be root to change the host name'); return 1; }
  ctx.out('cmdpro\n');
  return 0;
};
C.uname = (ctx) => {
  const a = ctx.argv.slice(1).join('');
  const parts = { s: 'Linux', n: 'cmdpro', r: '5.15.0-cmdpro', v: '#1 SMP PREEMPT_DYNAMIC Mon Oct 5 12:00:00 UTC 2026', m: 'x86_64', p: 'x86_64', i: 'x86_64', o: 'GNU/Linux' };
  if (!a || a === '--kernel-name') { ctx.out('Linux\n'); return 0; }
  if (a.includes('a') || a === '--all') { ctx.out(`${parts.s} ${parts.n} ${parts.r} ${parts.v} ${parts.m} ${parts.p} ${parts.i} ${parts.o}\n`); return 0; }
  const order = 'snrvmpio';
  ctx.out(order.split('').filter(c => a.includes(c)).map(c => parts[c]).join(' ') + '\n');
  return 0;
};
C.arch = (ctx) => { ctx.out('x86_64\n'); return 0; };
C.nproc = (ctx) => { ctx.out('4\n'); return 0; };
C.getconf = (ctx) => {
  const v = { ARG_MAX: '2097152', PAGESIZE: '4096', PAGE_SIZE: '4096', _NPROCESSORS_ONLN: '4', _NPROCESSORS_CONF: '4', LONG_BIT: '64', PATH: '/bin:/usr/bin', CLK_TCK: '100' }[ctx.argv[1]];
  if (v === undefined) { ctx.err(`Unrecognized variable ${qa(ctx.argv[1] || '')}`); return 1; }
  ctx.out(v + '\n');
  return 0;
};
C.locale = (ctx) => { ctx.out('LANG=\nLANGUAGE=\nLC_CTYPE="POSIX"\nLC_NUMERIC="POSIX"\nLC_TIME="POSIX"\nLC_COLLATE="POSIX"\nLC_MONETARY="POSIX"\nLC_MESSAGES="POSIX"\nLC_PAPER="POSIX"\nLC_NAME="POSIX"\nLC_ADDRESS="POSIX"\nLC_TELEPHONE="POSIX"\nLC_MEASUREMENT="POSIX"\nLC_IDENTIFICATION="POSIX"\nLC_ALL=\n'); return 0; };
C.uptime = (ctx) => { const d = new Date(ctx.fs.now()); ctx.out(` ${strftime('%H:%M:%S', d)} up 42 days,  3:14,  0 users,  load average: 0.42, 0.13, 0.37\n`); return 0; };
C.free = (ctx) => {
  const h = ctx.argv.includes('-h');
  ctx.out(h ? '               total        used        free      shared  buff/cache   available\nMem:           7.7Gi       1.2Gi       4.9Gi        12Mi       1.6Gi       6.3Gi\nSwap:          2.0Gi          0B       2.0Gi\n'
    : '               total        used        free      shared  buff/cache   available\nMem:         8062712     1258004     5137964       12328     1666744     6555644\nSwap:        2097148           0     2097148\n');
  return 0;
};
C.who = C.users = () => 0;
C.w = (ctx) => { const d = new Date(ctx.fs.now()); ctx.out(` ${strftime('%H:%M:%S', d)} up 42 days,  3:14,  0 users,  load average: 0.42, 0.13, 0.37\nUSER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT\n`); return 0; };
C.lsb_release = (ctx) => {
  const a = ctx.argv.slice(1).join(' ');
  const all = { i: 'Distributor ID:\tCMDPRO', d: 'Description:\tCMDPRO OS 1.0 (Command Line Warrior)', r: 'Release:\t1.0', c: 'Codename:\twarrior' };
  if (!a) { ctx.out('No LSB modules are available.\n'); return 0; }
  ctx.stderr.write('No LSB modules are available.\n');
  for (const k of 'idrc') if (a.includes('a') || a.includes(k)) ctx.out((a.includes('s') ? all[k].split('\t')[1] : all[k]) + '\n');
  return 0;
};

// ---------------------------------------------------------------- date / cal
// GNU date 8.32: getopt "d:f:I::r:Rs:u"; the clock is always UTC here, so -u changes nothing
const DATE_ISO = { date: '%Y-%m-%d', hours: '%Y-%m-%dT%H+00:00', minutes: '%Y-%m-%dT%H:%M+00:00', seconds: '%Y-%m-%dT%H:%M:%S+00:00', ns: '%Y-%m-%dT%H:%M:%S,%N+00:00' };
const DATE_RFC3339 = { date: '%Y-%m-%d', seconds: '%Y-%m-%d %H:%M:%S+00:00', ns: '%Y-%m-%d %H:%M:%S.%N+00:00' };
// argmatch: an exact name or an unambiguous prefix
function dateArgmatch(ctx, opt, arg, table) {
  const names = Object.keys(table);
  const hits = names.filter(n => n.startsWith(arg));
  const m = names.includes(arg) ? arg : hits.length === 1 ? hits[0] : null;
  if (m) return table[m];
  ctx.err(`${hits.length ? 'ambiguous' : 'invalid'} argument ${qa(arg)} for '${opt}'`);
  ctx.stderr.write(`Valid arguments are:\n${names.map(n => `  - '${n}'\n`).join('')}Try 'date --help' for more information.\n`);
  return null;
}
C.date = (ctx) => {
  const usage = "Try 'date --help' for more information.\n";
  const a = parseArgs(ctx, {
    short: 'd:f:I::r:Rs:u',
    long: { date: ['d', 'required'], debug: 'debug', file: ['f', 'required'], 'iso-8601': ['I', 'optional'], reference: ['r', 'required'], 'rfc-email': 'R', 'rfc-822': 'R', 'rfc-2822': 'R', 'rfc-3339': ['rfc3339', 'required'], set: ['s', 'required'], uct: 'u', utc: 'u', universal: 'u', help: 'help', version: 'version' },
  });
  if (!a) return 1;
  let datestr = null, batch = null, ref = null, setStr = null, fmt = null;
  for (const [k, v] of a.all) {
    let nf = null;
    if (k === 'help') { ctx.out('Usage: date [OPTION]... [+FORMAT]\n  or:  date [-u|--utc|--universal] [MMDDhhmm[[CC]YY][.ss]]\nDisplay the current time in the given FORMAT, or set the system date.\n'); return 0; }
    if (k === 'version') { ctx.out('date (GNU coreutils) 8.32\n'); return 0; }
    if (k === 'd') datestr = v;
    else if (k === 'f') batch = v;
    else if (k === 'r') ref = v;
    else if (k === 's') setStr = v;
    else if (k === 'R') nf = '%a, %d %b %Y %H:%M:%S +0000';
    else if (k === 'I') { nf = v === null ? DATE_ISO.date : dateArgmatch(ctx, '--iso-8601', v, DATE_ISO); if (nf === null) return 1; }
    else if (k === 'rfc3339') { nf = dateArgmatch(ctx, '--rfc-3339', v, DATE_RFC3339); if (nf === null) return 1; }
    if (nf) {
      if (fmt !== null) { ctx.err('multiple output formats specified'); return 1; }
      fmt = nf;
    }
  }
  const specified = (datestr !== null) + (batch !== null) + (ref !== null);
  if (specified > 1) { ctx.err('the options to specify dates for printing are mutually exclusive'); ctx.stderr.write(usage); return 1; }
  if (setStr !== null && specified) { ctx.err('the options to print and set the time may not be used together'); ctx.stderr.write(usage); return 1; }
  const ops = a.operands;
  if (ops.length > 1) { ctx.err(`extra operand ${qa(ops[1])}`); ctx.stderr.write(usage); return 1; }
  let posix = null;
  if (ops.length) {
    if (ops[0][0] === '+') {
      if (fmt !== null) { ctx.err('multiple output formats specified'); return 1; }
      fmt = ops[0].slice(1);
    } else if (setStr !== null || specified) {
      ctx.err(`the argument ${qa(ops[0])} lacks a leading '+';\nwhen using an option to specify date(s), any non-option\nargument must be a format string beginning with '+'`);
      ctx.stderr.write(usage);
      return 1;
    } else posix = ops[0];
  }
  if (fmt === null) fmt = '%a %b %e %H:%M:%S %Z %Y';
  const now = ctx.fs.now();
  const show = (t, ns) => ctx.out(strftime(fmt, new Date(t), undefined, ns) + '\n');
  if (batch !== null) {
    let data;
    try { data = batch === '-' ? ctx.stdin.readAll() : ctx.readFile(batch); }
    catch (e) { ctx.err(`${qf(batch)}: ${e.message}`); return 1; }
    let ok = true;
    for (const line of splitLines(data)) {
      const t = parseDateNs(line, now);
      if (t === null) { ctx.err(`invalid date ${qa(line)}`); ok = false; } else show(t.ms, t.ns);
    }
    return ok ? 0 : 1;
  }
  let t = now, ns;
  if (ref !== null) {
    try { t = ctx.fs.stat(ref, ctx.cwd).mtime; } catch (e) { ctx.err(`${qf(ref)}: ${e.message}`); return 1; }
  } else if (datestr !== null || setStr !== null) {
    const s = setStr ?? datestr;
    const r = parseDateNs(s, now);
    if (r === null) { ctx.err(`invalid date ${qa(s)}`); return 1; }
    t = r.ms; ns = r.ns;
  } else if (posix !== null) {
    t = posixDate(posix, now);
    if (t === null) { ctx.err(`invalid date ${qa(posix)}`); return 1; }
  }
  // setting the clock needs root: GNU date says so, then prints the date it would have set anyway
  const setting = setStr !== null || posix !== null;
  if (setting) ctx.err('cannot set date: Operation not permitted');
  show(t, ns);
  return setting ? 1 : 0;
};
// MMDDhhmm[[CC]YY][.ss] (the "set the date" operand form)
function posixDate(s, now) {
  const m = /^(\d{8}|\d{10}|\d{12})(?:\.(\d{2}))?$/.exec(s);
  if (!m) return null;
  const d = m[1];
  const year = d.length === 12 ? +d.slice(8) : d.length === 10 ? (+d.slice(8) < 69 ? 2000 : 1900) + +d.slice(8) : new Date(now).getUTCFullYear();
  const [mo, dd, hh, mi, ss] = [+d.slice(0, 2), +d.slice(2, 4), +d.slice(4, 6), +d.slice(6, 8), +(m[2] || 0)];
  const t = Date.UTC(year, mo - 1, dd, hh, mi, ss);
  const c = new Date(t);
  if (c.getUTCMonth() !== mo - 1 || c.getUTCDate() !== dd || hh > 23 || mi > 59 || ss > 60) return null;
  return t;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function calMonth(y, m) {
  const title = `${MONTHS[m]} ${y}`;
  const pad = Math.floor((20 - title.length) / 2);
  const lines = [(' '.repeat(pad) + title).padEnd(22), 'Su Mo Tu We Th Fr Sa  '];
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  let line = '   '.repeat(first);
  let col = first;
  for (let d = 1; d <= days; d++) {
    line += String(d).padStart(2) + ' ';
    col++;
    if (col === 7) { lines.push(line.padEnd(22)); line = ''; col = 0; }
  }
  if (line) lines.push(line.padEnd(22));
  return lines;
}
C.cal = C.ncal = (ctx) => {
  const args = ctx.argv.slice(1).filter(x => !x.startsWith('-'));
  const now = new Date(ctx.fs.now());
  let y = now.getUTCFullYear(), m = now.getUTCMonth();
  if (args.length === 1) {
    y = parseInt(args[0], 10);
    if (!(y >= 1 && y <= 9999)) { ctx.err(`year \`${args[0]}' not in range 1..9999`); return 1; }
    let out = ' '.repeat(Math.floor((66 - String(y).length) / 2)) + y + '\n';
    for (let q = 0; q < 12; q += 3) {
      const ms = [0, 1, 2].map(k => calMonth(y, q + k).map(l => l));
      ms.forEach(mm => { mm[0] = ' '.repeat(Math.floor((20 - MONTHS[mm === ms[0] ? q : mm === ms[1] ? q + 1 : q + 2].length) / 2)) + MONTHS[mm === ms[0] ? q : mm === ms[1] ? q + 1 : q + 2]; mm[0] = mm[0].padEnd(22); });
      const rows = Math.max(...ms.map(x => x.length));
      for (let r = 0; r < rows; r++) out += ms.map(x => (x[r] || '').padEnd(22)).join('') + '\n';
    }
    ctx.out(out);
    return 0;
  }
  if (args.length >= 2) { m = parseInt(args[0], 10) - 1; y = parseInt(args[1], 10); if (!(m >= 0 && m < 12)) { ctx.err(`${args[0]} is neither a month number (1..12) nor a name`); return 1; } }
  ctx.out(calMonth(y, m).join('\n') + '\n');
  return 0;
};

// ---------------------------------------------------------------- factor (Pollard rho)
function modmul(a, b, m) { return (a * b) % m; }
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
function isPrime(n) {
  if (n < 2n) return false;
  for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) { if (n === p) return true; if (n % p === 0n) return false; }
  let d = n - 1n, s = 0;
  while ((d & 1n) === 0n) { d >>= 1n; s++; }
  for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    let x = modpow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let comp = true;
    for (let r = 1; r < s; r++) { x = x * x % n; if (x === n - 1n) { comp = false; break; } }
    if (comp) return false;
  }
  return true;
}
function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
function rho(n) {
  if (n % 2n === 0n) return 2n;
  for (let c = 1n; ; c++) {
    let x = 2n, y = 2n, d = 1n;
    const f = (v) => (v * v + c) % n;
    let iter = 0;
    while (d === 1n) { x = f(x); y = f(f(y)); d = gcd(x > y ? x - y : y - x, n); if (++iter > 200000) break; }
    if (d !== n && d !== 1n) return d;
  }
}
function factorize(n) {
  const out = [];
  for (const p of [2n, 3n, 5n, 7n, 11n, 13n]) while (n % p === 0n) { out.push(p); n /= p; }
  let f = 17n;
  while (f * f <= n && f < 10000n) { while (n % f === 0n) { out.push(f); n /= f; } f += 2n; }
  const stack = n > 1n ? [n] : [];
  while (stack.length) {
    const m = stack.pop();
    if (m === 1n) continue;
    if (isPrime(m)) { out.push(m); continue; }
    const d = rho(m);
    stack.push(d, m / d);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
C.factor = (ctx) => {
  let nums = ctx.argv.slice(1).filter(x => x !== '--');
  if (!nums.length) nums = ctx.stdin.readAll().split(/\s+/).filter(Boolean);
  let st = 0, out = '';
  for (const s of nums) {
    const t = s.replace(/^\+/, '');
    if (!/^\d+$/.test(t)) { ctx.out(out); out = ''; ctx.err(`${qa(s)} is not a valid positive integer`); st = 1; continue; }
    const n = BigInt(t);
    if (n > (1n << 128n)) { ctx.err(`${qa(s)} is too large`); st = 1; continue; }
    const f = n < 2n ? [] : factorize(n);
    out += `${n}:${f.map(x => ' ' + x).join('')}\n`;
    ctx.tick();
  }
  ctx.out(out);
  return st;
};

// ---------------------------------------------------------------- expr
C.expr = (ctx) => {
  const toks = ctx.argv.slice(1);
  let i = 0;
  class ExprErr extends Error { constructor(m, code = 2) { super(m); this.code = code; } }
  const isInt = (v) => /^[+-]?\d+$/.test(v);
  const toBig = (v) => { if (!isInt(v)) throw new ExprErr('non-integer argument'); return BigInt(v); };
  const truthy = (v) => !(v === '' || (isInt(v) && BigInt(v) === 0n));
  const peek = () => toks[i];
  const orE = () => { let l = andE(); while (peek() === '|') { i++; const r = andE(); l = truthy(l) ? l : (truthy(r) ? r : '0'); } return l; };
  const andE = () => { let l = cmpE(); while (peek() === '&') { i++; const r = cmpE(); l = truthy(l) && truthy(r) ? l : '0'; } return l; };
  const cmpE = () => {
    let l = addE();
    while (['<', '<=', '=', '==', '!=', '>=', '>'].includes(peek())) {
      const op = toks[i++]; const r = addE();
      let c;
      if (isInt(l) && isInt(r)) { const a = BigInt(l), b = BigInt(r); c = a < b ? -1 : a > b ? 1 : 0; } else c = l < r ? -1 : l > r ? 1 : 0;
      l = ({ '<': c < 0, '<=': c <= 0, '=': c === 0, '==': c === 0, '!=': c !== 0, '>=': c >= 0, '>': c > 0 }[op]) ? '1' : '0';
    }
    return l;
  };
  const addE = () => { let l = mulE(); while (peek() === '+' || peek() === '-') { const op = toks[i++]; const r = mulE(); l = String(op === '+' ? toBig(l) + toBig(r) : toBig(l) - toBig(r)); } return l; };
  const mulE = () => {
    let l = matchE();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = toks[i++]; const r = matchE();
      const a = toBig(l), b = toBig(r);
      if ((op === '/' || op === '%') && b === 0n) throw new ExprErr('division by zero');
      l = String(op === '*' ? a * b : op === '/' ? a / b : a % b);
    }
    return l;
  };
  const regexMatch = (s, re) => {
    let js;
    try { js = new RegExp('^(?:' + posixToJs(re, {}) + ')', 's'); } catch { throw new ExprErr('Invalid regular expression'); }
    const m = js.exec(s);
    if (/\\\(/.test(re)) return m ? (m[1] ?? '') : '';
    return m ? String(m[0].length) : '0';
  };
  const matchE = () => { let l = prim(); while (peek() === ':') { i++; const r = prim(); l = regexMatch(l, r); } return l; };
  const prim = () => {
    const t = toks[i];
    if (t === undefined) throw new ExprErr(i === 0 ? 'missing operand' : `syntax error: missing argument after ${qa(toks[i - 1])}`);
    if (t === '(') { i++; const v = orE(); if (toks[i] !== ')') throw new ExprErr(toks[i] === undefined ? "syntax error: expecting ')' after " + qa(toks[i - 1]) : `syntax error: expecting ')' instead of ${qa(toks[i])}`); i++; return v; }
    if (t === '+') { i++; const v = toks[i++]; if (v === undefined) throw new ExprErr("syntax error: missing argument after '+'"); return v; }
    if (t === 'length' && toks.length > i + 1) { i++; return String(prim().length); }
    if (t === 'substr' && toks.length > i + 3) { i++; const s = prim(), p = Number(prim()), n = Number(prim()); return p < 1 || n < 1 ? '' : s.substr(p - 1, n); }
    if (t === 'index' && toks.length > i + 2) { i++; const s = prim(), cs = prim(); let best = 0; for (let k = 0; k < s.length; k++) if (cs.includes(s[k])) { best = k + 1; break; } return String(best); }
    if (t === 'match' && toks.length > i + 2) { i++; const s = prim(), r = prim(); return regexMatch(s, r); }
    i++;
    return t;
  };
  try {
    const v = orE();
    if (i < toks.length) throw new ExprErr(`syntax error: unexpected argument ${qa(toks[i])}`);
    ctx.out(v + '\n');
    return truthy(v) ? 0 : 1;
  } catch (e) {
    if (e instanceof ExprErr) { ctx.err(e.message); if (e.message === 'missing operand') ctx.stderr.write("Try 'expr --help' for more information.\n"); return e.code; }
    throw e;
  }
};

// ---------------------------------------------------------------- numfmt
// GNU numfmt (coreutils 8.32, numfmt.c). It computes in `long double`, and its rounding quirks
// ("numfmt 1.0001" prints 1.0002) come from that arithmetic, so it is emulated exactly: x86-64's
// 80-bit extended long double (64-bit significand, LDBL_DIG 18), as on the x86-64 runner.
// (aarch64 has IEEE binary128 long doubles instead: 113 and 33, where "numfmt 1.10" prints 1.11.)
const NF_P = 64, NF_LDBL_DIG = 18, NF_MAX_DIGITS = 27;
const NF_SSE = { OK: 0, LOSS: 1, OVERFLOW: 2, INVALID: 3, FORBIDDEN: 4, BAD_SUFFIX: 5, NO_I: 6 };
const nfBits = (m) => (m === 0n ? 0 : m.toString(2).length);
// round neg·m·2^e (m >= 0, exact) to NF_P significant bits, ties to even
function ldMake(neg, m, e) {
  if (m === 0n) return { neg, m: 0n, e: 0 };
  const sh = nfBits(m) - NF_P;
  if (sh > 0) {
    const B = BigInt(sh);
    let q = m >> B;
    const rem = m & ((1n << B) - 1n), half = 1n << (B - 1n);
    if (rem > half || (rem === half && (q & 1n))) { q += 1n; if (q >> BigInt(NF_P)) { q >>= 1n; e++; } }
    m = q; e += sh;
  }
  return { neg, m, e };
}
const ldInt = (n) => (n < 0n ? ldMake(true, -n, 0) : ldMake(false, n, 0));
const LD_ZERO = ldInt(0n), LD_TEN = ldInt(10n), LD_HALF = { neg: false, m: 1n, e: -1 };
const LD_INTMAX = ldInt((1n << 63n) - 1n);
const ldNeg = (a) => ({ neg: !a.neg, m: a.m, e: a.e });
const ldAbs = (a) => ({ neg: false, m: a.m, e: a.e });
const ldMul = (a, b) => ldMake(a.neg !== b.neg, a.m * b.m, a.e + b.e);
function ldAdd(a, b) {
  if (a.m === 0n && b.m === 0n) return { neg: a.neg && b.neg, m: 0n, e: 0 };
  if (a.m === 0n) return b;
  if (b.m === 0n) return a;
  const e = Math.min(a.e, b.e);
  const ma = a.m << BigInt(a.e - e), mb = b.m << BigInt(b.e - e);
  const s = (a.neg ? -ma : ma) + (b.neg ? -mb : mb);
  return s === 0n ? { neg: false, m: 0n, e: 0 } : ldMake(s < 0n, s < 0n ? -s : s, e);
}
const ldSub = (a, b) => ldAdd(a, ldNeg(b));
function ldDiv(a, b) {
  const neg = a.neg !== b.neg;
  if (a.m === 0n) return { neg, m: 0n, e: 0 };
  const k = Math.max(0, NF_P + 3 + nfBits(b.m) - nfBits(a.m));
  const num = a.m << BigInt(k);
  const q = num / b.m, r = num % b.m;
  return ldMake(neg, (q << 1n) | (r ? 1n : 0n), a.e - b.e - k - 1);
}
function ldCmp(a, b) {
  const sa = a.m === 0n ? 0 : a.neg ? -1 : 1, sb = b.m === 0n ? 0 : b.neg ? -1 : 1;
  if (sa !== sb || sa === 0) return sa < sb ? -1 : sa > sb ? 1 : 0;
  const e = Math.min(a.e, b.e);
  const ma = a.m << BigInt(a.e - e), mb = b.m << BigInt(b.e - e);
  const c = ma < mb ? -1 : ma > mb ? 1 : 0;
  return sa < 0 ? -c : c;
}
// conversion to intmax_t: truncation toward zero
function ldTrunc(a) {
  const v = a.e >= 0 ? a.m << BigInt(a.e) : a.m >> BigInt(-a.e);
  return a.neg ? -v : v;
}
// powerld(): BASE^X by repeated multiplication (1 for X == 0)
function ldPow(base, x) {
  if (x === 0) return ldInt(1n);
  let r = base;
  while (--x) r = ldMul(r, base);
  return r;
}
// expld(): divide by BASE until |val| < BASE; returns [val, power]
function ldExp(val, base) {
  const B = ldInt(BigInt(base));
  let power = 0;
  while (ldCmp(ldAbs(val), B) >= 0) { power++; val = ldDiv(val, B); }
  return [val, power];
}
// |v| as an exact fraction n / 2^k
const ldFrac = (v) => (v.e >= 0 ? [v.m << BigInt(v.e), 0n] : [v.m, BigInt(-v.e)]);
function nfRoundDiv(n, k) {           // round(n / 2^k), ties to even
  if (k === 0n) return n;
  let q = n >> k;
  const rem = n - (q << k), half = 1n << (k - 1n);
  if (rem > half || (rem === half && (q & 1n))) q += 1n;
  return q;
}
// printf("%[0W].*Lf", prec, v)
function nfFmtF(v, prec, zeroWidth = 0) {
  const [n, k] = ldFrac(v);
  let s = nfRoundDiv(n * 10n ** BigInt(prec), k).toString();
  if (prec > 0) { s = s.padStart(prec + 1, '0'); s = s.slice(0, -prec) + '.' + s.slice(-prec); }
  const sign = v.neg ? '-' : '';
  if (zeroWidth > sign.length + s.length) s = s.padStart(zeroWidth - sign.length, '0');
  return sign + s;
}
// printf("%Lg", v)
function nfFmtG(v) {
  const P = 6;
  if (v.m === 0n) return v.neg ? '-0' : '0';
  const [n, k] = ldFrac(v);
  const D = 1n << k;
  let X = n.toString().length - 1 - D.toString().length + 1;
  const ge = (x) => (x >= 0 ? n >= D * 10n ** BigInt(x) : n * 10n ** BigInt(-x) >= D);   // |v| >= 10^x
  while (!ge(X)) X--;
  while (ge(X + 1)) X++;
  const sc = P - 1 - X;
  const num = sc >= 0 ? n * 10n ** BigInt(sc) : n, den = sc >= 0 ? D : D * 10n ** BigInt(-sc);
  let R = num / den;
  const rem = num - R * den;
  if (rem * 2n > den || (rem * 2n === den && (R & 1n))) R += 1n;
  if (R >= 10n ** BigInt(P)) { R /= 10n; X++; }
  const ds = R.toString();
  let out;
  if (X < -4 || X >= P) {
    const frac = ds.slice(1).replace(/0+$/, '');
    out = ds[0] + (frac ? '.' + frac : '') + 'e' + (X < 0 ? '-' : '+') + String(Math.abs(X)).padStart(2, '0');
  } else {
    let int, frac;
    if (X >= 0) { int = ds.slice(0, X + 1); frac = ds.slice(X + 1); } else { int = '0'; frac = '0'.repeat(-X - 1) + ds; }
    frac = frac.replace(/0+$/, '');
    out = int + (frac ? '.' + frac : '');
  }
  return (v.neg ? '-' : '') + out;
}
// simple_round(): val rounded to an integer the way numfmt does it
function nfSimpleRound(val, t) {
  const mul = ldTrunc(ldDiv(val, LD_INTMAX));
  const base = ldMul(LD_INTMAX, ldInt(mul));
  val = ldSub(val, base);
  const ceil = (x) => { let i = ldTrunc(x); if (ldCmp(ldInt(i), x) < 0) i++; return i; };
  const floor = (x) => -ceil(ldNeg(x));
  const isNeg = ldCmp(val, LD_ZERO) < 0;
  let r;
  if (t === 'up') r = ceil(val);
  else if (t === 'down') r = floor(val);
  else if (t === 'from-zero') r = isNeg ? floor(val) : ceil(val);
  else if (t === 'towards-zero') r = ldTrunc(val);
  else r = ldTrunc(isNeg ? ldSub(val, LD_HALF) : ldAdd(val, LD_HALF));
  return ldAdd(base, ldInt(r));
}
// gnulib argmatch (numfmt's argument lists have no duplicate values)
function nfArgmatch(arg, names) {
  let found = -1, ambiguous = false;
  for (let i = 0; i < names.length; i++) {
    if (names[i] === arg) return i;
    if (names[i].startsWith(arg)) { if (found < 0) found = i; else ambiguous = true; }
  }
  return ambiguous ? -2 : found;
}
const NF_HELP = `Usage: numfmt [OPTION]... [NUMBER]...
Reformat NUMBER(s), or the numbers from standard input if none are specified.

Mandatory arguments to long options are mandatory for short options too.
      --debug          print warnings about invalid input
  -d, --delimiter=X    use X instead of whitespace for field delimiter
      --field=FIELDS   replace the numbers in these input fields (default=1)
                         see FIELDS below
      --format=FORMAT  use printf style floating-point FORMAT;
                         see FORMAT below for details
      --from=UNIT      auto-scale input numbers to UNITs; default is 'none';
                         see UNIT below
      --from-unit=N    specify the input unit size (instead of the default 1)
      --grouping       use locale-defined grouping of digits, e.g. 1,000,000
                         (which means it has no effect in the C/POSIX locale)
      --header[=N]     print (without converting) the first N header lines;
                         N defaults to 1 if not specified
      --invalid=MODE   failure mode for invalid numbers: MODE can be:
                         abort (default), fail, warn, ignore
      --padding=N      pad the output to N characters; positive N will
                         right-align; negative N will left-align;
                         padding is ignored if the output is wider than N;
                         the default is to automatically pad if a whitespace
                         is found
      --round=METHOD   use METHOD for rounding when scaling; METHOD can be:
                         up, down, from-zero (default), towards-zero, nearest
      --suffix=SUFFIX  add SUFFIX to output numbers, and accept optional
                         SUFFIX in input numbers
      --to=UNIT        auto-scale output numbers to UNITs; see UNIT below
      --to-unit=N      the output unit size (instead of the default 1)
  -z, --zero-terminated    line delimiter is NUL, not newline
      --help     display this help and exit
      --version  output version information and exit

UNIT options:
  none       no auto-scaling is done; suffixes will trigger an error
  auto       accept optional single/two letter suffix:
               1K = 1000,
               1Ki = 1024,
               1M = 1000000,
               1Mi = 1048576,
  si         accept optional single letter suffix:
               1K = 1000,
               1M = 1000000,
               ...
  iec        accept optional single letter suffix:
               1K = 1024,
               1M = 1048576,
               ...
  iec-i      accept optional two-letter suffix:
               1Ki = 1024,
               1Mi = 1048576,
               ...

FIELDS supports cut(1) style field ranges:
  N    N'th field, counted from 1
  N-   from N'th field, to end of line
  N-M  from N'th to M'th field (inclusive)
  -M   from first to M'th field (inclusive)
  -    all fields
Multiple fields/ranges can be separated with commas

FORMAT must be suitable for printing one floating-point argument '%f'.
Optional quote (%'f) will enable --grouping (if supported by current locale).
Optional width value (%10f) will pad output. Optional zero (%010f) width
will zero pad the number. Optional negative values (%-10f) will left align.
Optional precision (%.1f) will override the input determined precision.

Exit status is 0 if all input numbers were successfully converted.
By default, numfmt will stop at the first conversion error with exit status 2.
With --invalid='fail' a warning is printed for each conversion error
and the exit status is 2.  With --invalid='warn' each conversion error is
diagnosed, but the exit status is 0.  With --invalid='ignore' conversion
errors are not diagnosed and the exit status is 0.

Examples:
  $ numfmt --to=si 1000
            -> "1.0K"
  $ numfmt --to=iec 2048
           -> "2.0K"
  $ numfmt --to=iec-i 4096
           -> "4.0Ki"
  $ echo 1K | numfmt --from=si
           -> "1000"
  $ echo 1K | numfmt --from=iec
           -> "1024"
  $ df -B1 | numfmt --header --field 2-4 --to=si
  $ ls -l  | numfmt --header --field 5 --to=iec
  $ ls -lh | numfmt --header --field 5 --from=iec --padding=10
  $ ls -lh | numfmt --header --field 5 --from=iec --format %10f

GNU coreutils online help: <https://www.gnu.org/software/coreutils/>
Report any translation bugs to <https://translationproject.org/team/>
Full documentation <https://www.gnu.org/software/coreutils/numfmt>
or available locally via: info '(coreutils) numfmt invocation'
`;
const NF_VERSION = `numfmt (GNU coreutils) 8.32
Copyright (C) 2020 Free Software Foundation, Inc.
License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.

Written by Assaf Gordon.
`;
class NfExit { constructor(code) { this.code = code; } }
// set_fields(FIELDSTR, SETFLD_ALLOW_DASH): sorted, merged [lo, hi] ranges (hi = UINTMAX_MAX for "N-")
function nfSetFields(str, fail) {
  const ranges = [];
  let initial = 1n, value = 0n, lhs = false, rhs = false, dash = false, numStart = -1, inDigits = false;
  let i = 0;
  if (str === '-') { value = 1n; lhs = true; dash = true; i = 1; }
  const MAX = (1n << 64n) - 1n;
  for (;;) {
    const c = str[i];
    if (c === '-') {
      inDigits = false;
      if (dash) fail('invalid field range');
      dash = true; i++;
      if (lhs && !value) fail('fields are numbered from 1');
      initial = lhs ? value : 1n;
      value = 0n;
    } else if (c === ',' || c === ' ' || c === '\t' || c === undefined) {
      inDigits = false;
      if (dash) {
        dash = false;
        if (!lhs && !rhs) initial = 1n;
        if (!rhs) ranges.push([initial, MAX]);
        else { if (value < initial) fail('invalid decreasing range'); ranges.push([initial, value]); }
        value = 0n;
      } else {
        if (value === 0n) fail('fields are numbered from 1');
        ranges.push([value, value]);
        value = 0n;
      }
      if (c === undefined) break;
      i++; lhs = false; rhs = false;
    } else if (c >= '0' && c <= '9') {
      if (!inDigits || numStart < 0) numStart = i;
      inDigits = true;
      if (dash) rhs = true; else lhs = true;
      value = value * 10n + BigInt(c.charCodeAt(0) - 48);
      if (value >= MAX) fail(`field number ${quotearg(/^\d*/.exec(str.slice(numStart))[0], 'locale')} is too large`);
      i++;
    } else fail(`invalid field value ${quotearg(str.slice(i), 'locale')}`);
  }
  if (!ranges.length) fail('missing list of fields');
  ranges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (let a = 0; a < ranges.length; a++) {
    for (let b = a + 1; b < ranges.length;) {
      if (ranges[b][0] <= ranges[a][1]) { if (ranges[b][1] > ranges[a][1]) ranges[a][1] = ranges[b][1]; ranges.splice(b, 1); } else break;
    }
  }
  return ranges;
}

C.numfmt = (ctx) => {
  const q = (s) => quotearg(s, 'locale');
  const spec = { name: 'numfmt', short: 'd:z', long: {
    from: ['from', 'required'], 'from-unit': ['fromunit', 'required'], to: ['to', 'required'], 'to-unit': ['tounit', 'required'],
    round: ['round', 'required'], padding: ['padding', 'required'], suffix: ['suffix', 'required'], grouping: 'grouping',
    delimiter: ['d', 'required'], field: ['field', 'required'], debug: 'debug', '-debug': 'devdebug', header: ['header', 'optional'],
    format: ['format', 'required'], invalid: ['invalid', 'required'], 'zero-terminated': 'z', help: 'help', version: 'version',
  } };
  const r = getopt(ctx.argv.slice(1), spec);
  const tryHelp = () => ctx.stderr.write("Try 'numfmt --help' for more information.\n");
  const die = (msg, code = 1) => { ctx.err(msg); throw new NfExit(code); };
  const SCALE_FROM = ['none', 'auto', 'si', 'iec', 'iec-i'], SCALE_TO = ['none', 'si', 'iec', 'iec-i'];
  const ROUNDS = ['up', 'down', 'from-zero', 'towards-zero', 'nearest'], INVALS = ['abort', 'fail', 'warn', 'ignore'];
  let scaleFrom = 'none', scaleTo = 'none', round = 'from-zero', inval = 'abort', suffix = null;
  let fromUnit = 1n, toUnit = 1n, grouping = false, paddingWidth = 0, align = 'right', fields = null;
  let delim = null, lineDelim = '\n', debug = false, header = 0n, formatStr = null;
  let zeroPad = 0, userPrec = -1, fmtPrefix = '', fmtSuffix = '';
  const xargmatch = (opt, arg, names) => {
    const k = nfArgmatch(arg, names);
    if (k >= 0) return names[k];
    let m = `numfmt: ${k === -2 ? 'ambiguous' : 'invalid'} argument ${q(arg)} for ${q(opt)}\nValid arguments are:`;
    for (const n of names) m += `\n  - ${q(n)}`;
    ctx.stderr.write(m + '\n'); tryHelp(); throw new NfExit(1);
  };
  // unit_to_umax(): K=1000, Ki=1024, KiB invalid
  const unitSize = (s) => {
    let t = s, sufs = 'KMGTPEZY';
    if (s.length && !/[0-9]/.test(s[s.length - 1])) {
      if (s[s.length - 1] === 'i' && s.length >= 2 && !/[0-9]/.test(s[s.length - 2])) t = s.slice(0, -1);
      else { t = s + 'B'; sufs = 'KMGTPEZY0'; }
    }
    const x = xstrtol(t, sufs, { max: (1n << 64n) - 1n, unsigned: true });
    if (x.err !== LONGINT_OK || x.rest !== '' || x.val === 0n) die(`invalid unit size: ${q(s)}`);
    return x.val;
  };
  const parseFormat = (fmt) => {
    let i = 0, prefixLen = 0, zero = false;
    for (; !(fmt[i] === '%' && fmt[i + 1] !== '%'); i += (fmt[i] === '%') + 1) {
      if (i >= fmt.length) die(`format ${q(fmt)} has no % directive`);
      prefixLen++;
    }
    i++;
    for (;;) {
      let skip = 0;
      while (fmt[i] === ' ') { i++; skip++; }
      if (fmt[i] === "'") { grouping = true; i++; } else if (fmt[i] === '0') { zero = true; i++; } else if (!skip) break;
    }
    // strtol(fmt + i)
    const m = /^[ \t\n\v\f\r]*([+-]?)(\d+)/.exec(fmt.slice(i));
    let end = i;
    if (m) {
      const pad = BigInt(m[1] + m[2]);
      if (pad > 9223372036854775807n || pad < -9223372036854775807n) die(`invalid format ${q(fmt)} (width overflow)`);
      end = i + m[0].length;
      if (pad !== 0n) {
        if (debug && paddingWidth && !(zero && pad > 0n)) ctx.err('--format padding overriding --padding');
        if (pad < 0n) { align = 'left'; paddingWidth = Number(-pad); } else if (zero) zeroPad = Number(pad); else paddingWidth = Number(pad);
      }
    }
    i = end;
    if (i >= fmt.length) die(`format ${q(fmt)} ends in %`);
    if (fmt[i] === '.') {
      i++;
      const pm = /^[ \t\n\v\f\r]*([+-]?)(\d+)/.exec(fmt.slice(i));
      const pv = pm ? BigInt(pm[1] + pm[2]) : 0n;
      if (pv > 9223372036854775807n || pv < 0n || fmt[i] === ' ' || fmt[i] === '\t' || fmt[i] === '+') die(`invalid precision in format ${q(fmt)}`);
      userPrec = Number(pv);
      if (pm) i += pm[0].length;
    }
    if (fmt[i] !== 'f') die(`invalid format ${q(fmt)}, directive must be %[0]['][-][N][.][N]f`);
    i++;
    const sufPos = i;
    for (; i < fmt.length; i += (fmt[i] === '%') + 1) if (fmt[i] === '%' && fmt[i + 1] !== '%') die(`format ${q(fmt)} has too many % directives`);
    fmtPrefix = fmt.slice(0, prefixLen);
    fmtSuffix = fmt.slice(sufPos);
  };
  try {
    for (const [k, v] of r.opts) {
      if (k === 'from') scaleFrom = xargmatch('--from', v, SCALE_FROM);
      else if (k === 'fromunit') fromUnit = unitSize(v);
      else if (k === 'to') scaleTo = xargmatch('--to', v, SCALE_TO);
      else if (k === 'tounit') toUnit = unitSize(v);
      else if (k === 'round') round = xargmatch('--round', v, ROUNDS);
      else if (k === 'grouping') grouping = true;
      else if (k === 'padding') {
        const x = xstrtol(v, '', {});
        if (x.err !== LONGINT_OK || x.val === 0n || x.val > 9223372036854775807n || x.val < -9223372036854775807n) die(`invalid padding value ${q(v)}`);
        if (x.val < 0n) { align = 'left'; paddingWidth = Number(-x.val); } else paddingWidth = Number(x.val);
      } else if (k === 'field') {
        if (fields) die('multiple field specifications');
        fields = nfSetFields(v, (m) => { ctx.err(m); tryHelp(); throw new NfExit(1); });
      } else if (k === 'd') {
        if (v.length > 1) die('the delimiter must be a single character');
        delim = v === '' ? '\0' : v;
      } else if (k === 'z') lineDelim = '\0';
      else if (k === 'suffix') suffix = v;
      else if (k === 'debug' || k === 'devdebug') debug = true;
      else if (k === 'header') {
        if (v === null) header = 1n;
        else {
          const x = xstrtol(v, '', { max: (1n << 64n) - 1n, unsigned: true });
          if (x.err !== LONGINT_OK || x.val === 0n) die(`invalid header value ${q(v)}`);
          header = x.val;
        }
      } else if (k === 'format') formatStr = v;
      else if (k === 'invalid') inval = xargmatch('--invalid', v, INVALS);
      else if (k === 'help') { ctx.out(NF_HELP); return 0; }
      else if (k === 'version') { ctx.out(NF_VERSION); return 0; }
    }
    if (r.error) { ctx.stderr.write(r.error + '\n'); tryHelp(); return 1; }
    if (formatStr !== null && grouping) die('--grouping cannot be combined with --format');
    if (debug && scaleFrom === 'none' && scaleTo === 'none' && !grouping && !paddingWidth && formatStr === null) ctx.err('no conversion option specified');
    if (formatStr !== null) parseFormat(formatStr);
    if (grouping) {
      if (scaleTo !== 'none') die('grouping cannot be combined with --to');
      if (debug) ctx.err('grouping has no effect in this locale');
    }
  } catch (e) { if (e instanceof NfExit) return e.code; throw e; }

  const autoPadding = paddingWidth === 0 && delim === null;
  const convExit = inval === 'abort' ? 2 : 0;
  const convErr = (msg) => { if (inval !== 'ignore') { ctx.err(msg); if (convExit) throw new NfExit(convExit); } };
  const isBlank = (c) => c === ' ' || c === '\t';
  const fieldSep = (c) => c === ' ' || c === '\t' || c === '\n';
  const scaleBase = (s) => (s === 'iec' || s === 'iec-i' ? 1024 : 1000);
  let padded = '';

  // simple_strtod_int() on MEM (a C string that may be read past its NUL) at index I
  const strtodInt = (mem, i) => {
    let e = NF_SSE.OK, val = LD_ZERO, digits = 0, found = false, neg = false;
    if (mem[i] === '-') { i++; neg = true; }
    while (i < mem.length && mem[i] >= '0' && mem[i] <= '9') {
      const d = mem.charCodeAt(i) - 48;
      found = true;
      if (val.m !== 0n || d) digits++;
      if (digits > NF_LDBL_DIG) e = NF_SSE.LOSS;
      if (digits > NF_MAX_DIGITS) return { e: NF_SSE.OVERFLOW };
      val = ldAdd(ldMul(val, LD_TEN), ldInt(BigInt(d)));
      i++;
    }
    if (!found && mem[i] !== '.') return { e: NF_SSE.INVALID };
    if (neg) val = ldNeg(val);
    return { e, i, val, neg };
  };
  // simple_strtod_human(): number, optional fraction, optional suffix
  const strtodHuman = (mem) => {
    let power = 0, base = scaleBase(scaleFrom);
    const a = strtodInt(mem, 0);
    if (a.e !== NF_SSE.OK && a.e !== NF_SSE.LOSS) return a;
    let { e, i, val } = a, precision = 0;
    if (mem[i] === '.') {
      i++;
      const b = strtodInt(mem, i);
      if (b.e !== NF_SSE.OK && b.e !== NF_SSE.LOSS) return b;
      if (b.e === NF_SSE.LOSS) e = b.e;
      if (b.neg) return { e: NF_SSE.INVALID };
      const exponent = b.i - i;
      const frac = ldDiv(b.val, ldPow(LD_TEN, exponent));
      val = a.neg ? ldSub(val, frac) : ldAdd(val, frac);
      precision = exponent;
      i = b.i;
    }
    if (mem[i] !== '\0' && i < mem.length) {
      while (isBlank(mem[i])) i++;
      const c = i < mem.length ? mem[i] : '\0';
      if (!'KMGTPEZY\0'.includes(c)) return { e: NF_SSE.BAD_SUFFIX };
      if (scaleFrom === 'none') return { e: NF_SSE.FORBIDDEN };
      power = 'KMGTPEZY'.indexOf(c) + 1;
      i++;
      if (scaleFrom === 'auto' && mem[i] === 'i') { base = 1024; i++; }
      precision = 0;
    }
    if (scaleFrom === 'iec-i') { if (mem[i] === 'i') i++; else return { e: NF_SSE.NO_I }; }
    val = ldMul(val, ldPow(ldInt(BigInt(base)), power));
    return { e, i, val, precision };
  };
  // process_suffixed_number(): returns { ok, text (suffix trimmed), val, precision }
  const parseField = (text, field, after) => {
    // the suffix is cut off by writing a NUL over its first byte; the rest of it stays in memory
    if (suffix !== null && text.length > suffix.length && text.endsWith(suffix)) { text = text.slice(0, text.length - suffix.length); after = suffix.slice(1) + '\0' + after; }
    let p = 0;
    while (p < text.length && isBlank(text[p])) p++;
    if (autoPadding) paddingWidth = p > 0 || field > 1 ? text.length : 0;
    const str = text.slice(p);
    const h = strtodHuman(str + '\0' + after);
    let e = h.e;
    if (e !== NF_SSE.OK && e !== NF_SSE.LOSS) {
      const msg = { [NF_SSE.OVERFLOW]: `value too large to be converted: ${q(str)}`, [NF_SSE.INVALID]: `invalid number: ${q(str)}`,
        [NF_SSE.FORBIDDEN]: `rejecting suffix in input: ${q(str)} (consider using --from)`, [NF_SSE.BAD_SUFFIX]: `invalid suffix in input: ${q(str)}`,
        [NF_SSE.NO_I]: `missing 'i' suffix in input: ${q(str)} (e.g Ki/Mi/Gi)` }[e];
      convErr(msg);
      return { ok: false, text };
    }
    const mem = str + '\0' + after;
    const rest = mem.slice(h.i).split('\0')[0];
    if (rest !== '') { convErr(`invalid suffix in input ${q(str)}: ${q(rest)}`); return { ok: false, text }; }
    if (e === NF_SSE.LOSS && debug) ctx.err(`large input value ${q(str)}: possible precision loss`);
    let val = h.val;
    if (fromUnit !== 1n || toUnit !== 1n) val = ldDiv(ldMul(val, ldInt(fromUnit)), ldInt(toUnit));
    return { ok: true, text, val, precision: h.precision };
  };
  // double_to_human()
  const toHuman = (val, precision) => {
    if (scaleTo === 'none') {
      const p10 = ldPow(LD_TEN, precision);
      val = ldDiv(nfSimpleRound(ldMul(val, p10), round), p10);
      const s = nfFmtF(val, precision, Math.min(zeroPad, 256));   // anything that wide fails below
      if (s.length >= 128) { ctx.err(`failed to prepare value '${nfFmtF(val, 6)}' for printing`); throw new NfExit(1); }
      return s;
    }
    const base = scaleBase(scaleTo);
    let power;
    [val, power] = ldExp(val, base);
    let adjust = 0;
    if (userPrec !== -1) adjust = Math.min(power * 3, userPrec);
    else if (ldCmp(ldAbs(val), LD_TEN) < 0) adjust = 1;
    const p10 = ldPow(LD_TEN, adjust);
    val = ldDiv(nfSimpleRound(ldMul(val, p10), round), p10);
    const B = ldInt(BigInt(base));
    if (ldCmp(ldAbs(val), B) >= 0) { val = ldDiv(val, B); power++; }
    const showPoint = val.m !== 0n && ldCmp(ldAbs(val), LD_TEN) < 0 && power > 0;
    const prec = userPrec === -1 ? (showPoint ? 1 : 0) : userPrec;
    const s = nfFmtF(val, prec, Math.min(zeroPad, 256)) + (power <= 8 ? ' KMGTPEZY'[power].trim() : '(error)');
    if (s.length >= 127) { ctx.err(`failed to prepare value '${nfFmtF(val, 6)}' for printing`); throw new NfExit(1); }
    return s + (scaleTo === 'iec-i' && power > 0 ? 'i' : '');
  };
  // prepare_padded_number()
  const prepare = (val, precision) => {
    const precUsed = userPrec === -1 ? precision : userPrec;
    const x = ldExp(val, 10)[1];
    if (scaleTo === 'none' && x + precUsed > NF_LDBL_DIG) {
      convErr(precUsed ? `value/precision too large to be printed: '${nfFmtG(val)}/${precUsed}' (consider using --to)` : `value too large to be printed: '${nfFmtG(val)}' (consider using --to)`);
      return false;
    }
    if (x > NF_MAX_DIGITS - 1) { convErr(`value too large to be printed: '${nfFmtG(val)}' (cannot handle values > 999Y)`); return false; }
    let buf = toHuman(val, precUsed);
    if (suffix !== null) buf = (buf + suffix).slice(0, 127);
    // (a pad wider than any output limit is capped rather than built in full)
    const pw = Math.min(paddingWidth, 1 << 25);
    if (paddingWidth && buf.length < paddingWidth) buf = align === 'left' ? buf.padEnd(pw) : buf.padStart(pw);
    padded = buf;
    return true;
  };
  const includeField = (f) => (fields ? fields.some(([lo, hi]) => lo <= f && f <= hi) : f === 1n);
  // process_field(); AFTER is what follows the field's terminating NUL in memory
  const processField = (text, field, after) => {
    if (!includeField(BigInt(field))) { ctx.out(text); return true; }
    const f = parseField(text, field, after);
    let ok = f.ok;
    if (ok) ok = prepare(f.val, f.precision);
    ctx.out(ok ? fmtPrefix + padded + fmtSuffix : f.text);
    return ok;
  };
  // process_line(): LINE is a C string (cut at its first NUL)
  const processLine = (line, newline, tail) => {
    line = line.split('\0')[0];
    let pos = 0, field = 0, valid = true;
    for (;;) {
      ++field;
      let end = pos;
      if (delim !== null) { if (line[pos] !== delim) while (end < line.length && line[end] !== delim) end++; } else {
        while (end < line.length && fieldSep(line[end])) end++;
        while (end < line.length && !fieldSep(line[end])) end++;
      }
      const text = line.slice(pos, end);
      if (end < line.length) {
        if (!processField(text, field, line.slice(end + 1))) valid = false;
        ctx.out(delim !== null ? delim : ' ');
        pos = end + 1;
      } else {
        if (!processField(text, field, tail)) valid = false;
        break;
      }
    }
    if (newline) ctx.out(lineDelim);
    return valid;
  };

  let valid = true;
  try {
    const ops = r.operands;
    if (ops.length) {
      if (debug && header) ctx.err('--header ignored with command-line input');
      ops.forEach((arg, k) => { if (!processLine(arg, true, k + 1 < ops.length ? ops[k + 1] : '')) valid = false; });
    } else {
      const data = ctx.stdin.readAll();
      let pos = 0;
      const next = () => {
        if (pos >= data.length) return null;
        const j = data.indexOf(lineDelim, pos);
        const s = j < 0 ? data.slice(pos) : data.slice(pos, j + 1);
        pos = j < 0 ? data.length : j + 1;
        return s;
      };
      let line;
      // header lines are written with fputs(), which stops at a NUL
      while (header > 0n && (line = next()) !== null) { header--; ctx.out(line.split('\0')[0]); }
      while ((line = next()) !== null) {
        const nl = line.endsWith(lineDelim);
        if (!processLine(nl ? line.slice(0, -1) : line, nl, '')) valid = false;
      }
    }
  } catch (e) { if (e instanceof NfExit) return e.code; throw e; }
  if (debug && !valid) ctx.err('failed to convert some of the input numbers');
  return !valid && inval !== 'warn' && inval !== 'ignore' ? 2 : 0;
};

// ---------------------------------------------------------------- base64 / base32
function wrapText(s, w) { if (!w) return s; let out = ''; for (let i = 0; i < s.length; i += w) out += s.slice(i, i + w) + '\n'; return out; }
// gnulib base64.c decode_4: a group of up to 4 characters; partial output survives a failure
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64Decode4(g) {
  const v = (c) => B64.indexOf(c);
  const ok = (c) => c !== undefined && v(c) >= 0;
  const chr = (n) => String.fromCharCode(n & 255);
  if (g.length < 2 || !ok(g[0]) || !ok(g[1])) return { out: '', ok: false };
  let out = chr((v(g[0]) << 2) | (v(g[1]) >> 4));
  if (g.length === 2) return { out, ok: false };
  if (g[2] === '=') {
    if (g.length !== 4 || g[3] !== '=') return { out, ok: false };
  } else {
    if (!ok(g[2])) return { out, ok: false };
    out += chr(((v(g[1]) << 4) & 0xf0) | (v(g[2]) >> 2));
    if (g.length === 3) return { out, ok: false };
    if (g[3] !== '=') {
      if (!ok(g[3])) return { out, ok: false };
      out += chr(((v(g[2]) << 6) & 0xc0) | v(g[3]));
    }
  }
  return { out, ok: true };
}

C.base64 = (ctx) => {
  const a = parseArgs(ctx, { short: 'diw:', long: { decode: 'd', 'ignore-garbage': 'i', wrap: ['w', 'required'] } });
  if (!a) return 1;
  if (a.operands.length > 1) { ctx.err(`extra operand ${quotearg(a.operands[1], 'locale')}`); ctx.stderr.write("Try 'base64 --help' for more information.\n"); return 1; }
  let data;
  try { data = ctx.readFile(a.operands[0] || '-'); } catch (e) { ctx.err(readErrMsg(ctx, a.operands[0], e)); return 1; }
  if (a.has('d')) {
    // newlines are skipped anywhere; with -i so is anything outside the alphabet
    let s = data.replace(/\n/g, '');
    if (a.has('i')) s = s.replace(/[^A-Za-z0-9+/=]/g, '');
    let out = '';
    for (let i = 0; i < s.length; i += 4) {
      const r = b64Decode4(s.slice(i, i + 4));
      out += r.out;
      if (!r.ok) { ctx.out(out); ctx.err('invalid input'); return 1; }
    }
    ctx.out(out);
    return 0;
  }
  const w = a.has('w') ? parseInt(a.get('w'), 10) : 76;
  const enc = binToB64(data);
  ctx.out(w ? wrapText(enc, w) : enc + (enc ? '\n' : ''));
  if (w && enc === '') ctx.out('');
  return 0;
};

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
C.base32 = (ctx) => {
  const a = parseArgs(ctx, { short: 'diw:', long: { decode: 'd', 'ignore-garbage': 'i', wrap: ['w', 'required'] } });
  if (!a) return 1;
  let data;
  try { data = ctx.readFile(a.operands[0] || '-'); } catch (e) { ctx.err(readErrMsg(ctx, a.operands[0], e)); return 1; }
  if (a.has('d')) {
    const s = data.replace(/[\n=]/g, '');
    let bits = '', out = '';
    for (const ch of s) { const v = B32.indexOf(ch.toUpperCase()); if (v < 0) { ctx.err('invalid input'); return 1; } bits += v.toString(2).padStart(5, '0'); }
    for (let i = 0; i + 8 <= bits.length; i += 8) out += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2));
    ctx.out(out);
    return 0;
  }
  let bits = '';
  for (const ch of data) bits += ch.charCodeAt(0).toString(2).padStart(8, '0');
  let enc = '';
  for (let i = 0; i < bits.length; i += 5) enc += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  while (enc.length % 8) enc += '=';
  const w = a.has('w') ? parseInt(a.get('w'), 10) : 76;
  ctx.out(w ? wrapText(enc, w) : enc + '\n');
  return 0;
};

// ---------------------------------------------------------------- checksums
function sumCmd(algo) {
  return (ctx) => {
    const a = parseArgs(ctx, { short: 'bctwz', long: { binary: 'b', check: 'c', tag: 'tag', text: 't', warn: 'w', zero: 'z', quiet: 'quiet', status: 'status', strict: 'strict', 'ignore-missing': 'im' } });
    if (!a) return 1;
    const fn = HASHES[ctx.name] || HASHES[algo];
    const tagName = { md5sum: 'MD5', sha1sum: 'SHA1', sha224sum: 'SHA224', sha256sum: 'SHA256', sha384sum: 'SHA384', sha512sum: 'SHA512' }[ctx.name];
    const files = a.operands.length ? a.operands : ['-'];
    let st = 0;
    if (a.has('c')) {
      let failed = 0, missing = 0, bad = 0;
      for (const f of files) {
        let data;
        try { data = ctx.readFile(f); } catch (e) { ctx.err(`${f}: ${e.message}`); st = 1; continue; }
        for (const line of splitLines(data)) {
          const m = /^([0-9a-fA-F]+) [ *](.*)$/.exec(line) || /^\w+ \((.*)\) = ([0-9a-fA-F]+)$/.exec(line);
          if (!m) { bad++; continue; }
          const [hash, name] = m[0].startsWith(tagName || '#') ? [m[2], m[1]] : [m[1], m[2]];
          let content;
          try { content = ctx.readFile(name); } catch (e) { if (!a.has('im')) { ctx.out(`${name}: FAILED open or read\n`); ctx.err(`${name}: ${e.message}`); missing++; } continue; }
          const ok = fn(content) === hash.toLowerCase();
          if (!ok) failed++;
          if (!a.has('status') && (!ok || !a.has('quiet'))) ctx.out(`${name}: ${ok ? 'OK' : 'FAILED'}\n`);
        }
      }
      if (bad && !a.has('status')) ctx.err(`WARNING: ${bad} line${bad > 1 ? 's are' : ' is'} improperly formatted`);
      if (missing && !a.has('status')) ctx.err(`WARNING: ${missing} listed file${missing > 1 ? 's' : ''} could not be read`);
      if (failed && !a.has('status')) ctx.err(`WARNING: ${failed} computed checksum${failed > 1 ? 's' : ''} did NOT match`);
      return failed || missing || st ? 1 : 0;
    }
    let out = '';
    for (const f of files) {
      let data;
      try { data = ctx.readFile(f); }
      catch (e) { if (e instanceof FsError) { ctx.out(out); out = ''; ctx.err(`${f}: ${e.message}`); st = 1; continue; } throw e; }
      const h = fn(data);
      const nameOut = /[\\\n]/.test(f) ? '\\' + h : h;
      if (a.has('tag')) out += `${tagName} (${f}) = ${h}\n`;
      else out += `${nameOut}${a.has('b') ? ' *' : '  '}${f.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}${a.has('z') ? '\0' : '\n'}`;
    }
    ctx.out(out);
    return st;
  };
}
for (const n of Object.keys(HASHES)) C[n] = sumCmd(n);
C.cksum = (ctx) => {
  const files = ctx.argv.slice(1).filter(x => !x.startsWith('-'));
  const list = files.length ? files : ['-'];
  let st = 0, out = '';
  for (const f of list) {
    let data;
    // error() flushes stdout first, so earlier results come before the message
    try { data = ctx.readFile(f); } catch (e) { ctx.out(out); out = ''; ctx.err(`${f}: ${e.message}`); st = 1; continue; }
    out += `${crc(data)} ${data.length}${f === '-' && !files.length ? '' : ' ' + f}\n`;
  }
  ctx.out(out);
  return st;
};

// ---------------------------------------------------------------- xxd / od / hexdump
const printable = (c) => c >= 0x20 && c < 0x7f;
C.xxd = (ctx) => {
  const argv = ctx.argv.slice(1);
  let plain = false, reverse = false, len = Infinity, seek = 0, cols = null, group = null, upper = false, include = false, bits = false, files = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => (x.length > 2 && /^-[lscg]/.test(x) && !x.startsWith('--') ? x.replace(/^-[a-z]+/, '') : argv[++i]);
    if (x === '-p' || x === '-ps' || x === '-postscript' || x === '-plain') plain = true;
    else if (x === '-r' || x === '-revert') reverse = true;
    else if (x === '-rp' || x === '-pr') { reverse = true; plain = true; }
    else if (x === '-u') upper = true;
    else if (x === '-i' || x === '-include') include = true;
    else if (x === '-b' || x === '-bits') bits = true;
    else if (/^-l/.test(x) || x === '-len') len = parseNum(val());
    else if (/^-s/.test(x) || x === '-seek') seek = parseNum(val());
    else if (/^-c/.test(x) || x === '-cols') cols = parseNum(val());
    else if (/^-g/.test(x) || x === '-groupsize') group = parseNum(val());
    else if (x === '-a' || x === '-autoskip' || x === '-e' || x === '-E') { /* ignore */ }
    else files.push(x);
  }
  let data;
  try { data = ctx.readFile(files[0] || '-'); } catch (e) { ctx.stderr.write(e.code === 'EISDIR' ? `xxd: ${e.message}\n` : `xxd: ${files[0]}: ${e.message}\n`); return 2; }
  if (reverse) {
    let out = '';
    if (plain) { const hex = data.replace(/[^0-9a-fA-F]/g, ''); for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16)); }
    else {
      for (const line of splitLines(data)) {
        const m = /^([0-9a-fA-F]+):\s*((?:[0-9a-fA-F]{2,4}\s?)*)/.exec(line);
        if (!m) continue;
        const off = parseInt(m[1], 16);
        while (out.length < off) out += '\0';
        const hex = m[2].replace(/\s/g, '');
        for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      }
    }
    if (files[1]) ctx.openWrite(files[1]).write(out); else ctx.out(out);
    return 0;
  }
  data = data.slice(seek, len === Infinity ? undefined : seek + len);
  // xxd INFILE OUTFILE writes the dump into OUTFILE
  if (files[1] !== undefined && files[1] !== '-') {
    let sink;
    try { sink = ctx.openWrite(files[1]); } catch (e) { ctx.stderr.write(`xxd: ${files[1]}: ${e.message}\n`); return 3; }
    const real = ctx.out;
    ctx = { ...ctx, out: (x) => sink.write(x) };
    void real;
  }
  const hx = (c) => { const s = c.toString(16).padStart(2, '0'); return upper ? s.toUpperCase() : s; };
  if (plain) {
    const c = cols || 30;
    let out = '', line = '';
    for (let i = 0; i < data.length; i++) { line += hx(data.charCodeAt(i)); if ((i + 1) % c === 0) { out += line + '\n'; line = ''; } }
    if (line) out += line + '\n';
    ctx.out(out);
    return 0;
  }
  if (include) {
    const c = cols || 12;
    const name = (files[0] || '').replace(/[^A-Za-z0-9]/g, '_');
    let out = name ? `unsigned char ${name}[] = {\n` : '';
    const bytes = [...data].map(ch => '0x' + hx(ch.charCodeAt(0)));
    for (let i = 0; i < bytes.length; i += c) out += '  ' + bytes.slice(i, i + c).join(', ') + (i + c < bytes.length ? ',' : '') + '\n';
    if (name) out += `};\nunsigned int ${name}_len = ${data.length};\n`;
    ctx.out(out);
    return 0;
  }
  const c = cols || (bits ? 6 : 16);
  const g = group ?? (bits ? 1 : 2);
  let out = '';
  for (let off = 0; off < data.length; off += c) {
    const chunk = data.slice(off, off + c);
    let hex = '';
    for (let k = 0; k < chunk.length; k++) {
      const code = chunk.charCodeAt(k);
      hex += bits ? code.toString(2).padStart(8, '0') : hx(code);
      if (g > 0 && (k + 1) % g === 0) hex += ' ';
    }
    const full = bits ? c * 9 : c * 2 + (g > 0 ? Math.ceil(c / g) : 0);
    hex = hex.padEnd(full);
    const ascii = [...chunk].map(ch => printable(ch.charCodeAt(0)) ? ch : '.').join('');
    out += `${(off + seek).toString(16).padStart(8, '0')}: ${hex} ${ascii}\n`;
  }
  ctx.out(out);
  return 0;
};
function parseNum(s) { if (s === undefined) return 0; if (/^0x/i.test(s)) return parseInt(s, 16); if (/^0[0-7]+$/.test(s)) return parseInt(s, 8); return parseInt(s, 10) || 0; }

const ODCHARS = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
C.od = (ctx) => {
  const argv = ctx.argv.slice(1);
  let addr = 'o', types = [], skip = 0, count = Infinity, width = 16, verbose = false;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = (n) => (x.length > n ? x.slice(n) : argv[++i]);
    if (x.startsWith('-A')) addr = val(2);
    else if (x.startsWith('--address-radix=')) addr = x.slice(16)[0];
    else if (x.startsWith('-t')) types.push(val(2));
    else if (x.startsWith('--format=')) types.push(x.slice(9));
    else if (x.startsWith('-j')) skip = parseNum(val(2));
    else if (x.startsWith('-N')) count = parseNum(val(2));
    else if (x.startsWith('-w')) width = x.length > 2 ? parseInt(x.slice(2), 10) : 32;
    else if (x === '-v' || x === '--output-duplicates') verbose = true;
    else if (/^-[abcdfilosx]+$/.test(x)) for (const c of x.slice(1)) types.push({ a: 'a', b: 'o1', c: 'c', d: 'u2', f: 'fF', i: 'dI', l: 'dL', o: 'o2', s: 'd2', x: 'x2' }[c]);
    else files.push(x);
  }
  if (!types.length) types = ['o2'];
  // files are opened as the dump reaches them: a failure shows up after the lines read before it
  let data = '', st = 0;
  const errs = [];
  for (const f of (files.length ? files : ['-'])) {
    try { data += ctx.readFile(f); }
    catch (e) { if (!(e instanceof FsError)) throw e; errs.push({ at: data.length, msg: readErrMsg(ctx, f, e) }); st = 1; }
  }
  const skipped = Math.min(skip, data.length);
  data = data.slice(skip, count === Infinity ? undefined : skip + count);
  for (const e of errs) e.at -= skipped;
  let out = '';
  const flushErrs = (upto) => {
    while (errs.length && errs[0].at < upto) { ctx.out(out); out = ''; ctx.err(errs.shift().msg); }
  };
  const fmtAddr = (n) => addr === 'n' ? '' : addr === 'x' ? n.toString(16).padStart(6, '0') : addr === 'd' ? String(n).padStart(7, '0') : n.toString(8).padStart(7, '0');
  const specs = types.map(t => {
    const kind = t[0];
    let size = parseInt(t.slice(1), 10);
    if (isNaN(size)) size = { d: 4, o: 4, u: 4, x: 4, c: 1, a: 1, f: 8 }[kind] ?? 4;
    if (t.slice(1) === 'C') size = 1; if (t.slice(1) === 'S') size = 2; if (t.slice(1) === 'I') size = 4; if (t.slice(1) === 'L') size = 8;
    return { kind, size };
  });
  const fieldW = (s) => {
    if (s.kind === 'c' || s.kind === 'a') return 4;
    const max = 2 ** (8 * s.size) - 1;
    if (s.kind === 'x') return s.size * 2 + 1;
    if (s.kind === 'o') return max.toString(8).length + 1;
    if (s.kind === 'u') return String(max).length + 1;
    if (s.kind === 'd') return String(2 ** (8 * s.size - 1)).length + 2;
    return 15;
  };
  const NAMES = ['nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel', 'bs', 'ht', 'nl', 'vt', 'ff', 'cr', 'so', 'si', 'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb', 'can', 'em', 'sub', 'esc', 'fs', 'gs', 'rs', 'us', 'sp'];
  let prevLine = null, starred = false;
  for (let off = 0; off < data.length; off += width) {
    flushErrs(off + width);
    const chunk = data.slice(off, off + width);
    if (!verbose && chunk === prevLine && chunk.length === width) { if (!starred) { out += '*\n'; starred = true; } continue; }
    starred = false; prevLine = chunk;
    specs.forEach((s, si) => {
      let line = si === 0 ? fmtAddr(off + skipped) : (addr === 'n' ? '' : ' '.repeat(fmtAddr(0).length));
      const w = fieldW(s);
      for (let k = 0; k < chunk.length; k += s.size) {
        let v = 0;
        for (let b = s.size - 1; b >= 0; b--) v = v * 256 + ((chunk.charCodeAt(k + b) || 0) & 255);
        let cell;
        if (s.kind === 'c') { const c = chunk.charCodeAt(k); cell = ODCHARS[c] ?? (printable(c) ? chunk[k] : c.toString(8).padStart(3, '0')); }
        else if (s.kind === 'a') { const c = chunk.charCodeAt(k) & 127; cell = c < 33 ? NAMES[c] : c === 127 ? 'del' : String.fromCharCode(c); }
        else if (s.kind === 'x') cell = v.toString(16).padStart(s.size * 2, '0');
        else if (s.kind === 'o') cell = v.toString(8).padStart((2 ** (8 * s.size) - 1).toString(8).length, '0');
        else if (s.kind === 'u') cell = String(v);
        else if (s.kind === 'd') { const lim = 2 ** (8 * s.size - 1); cell = String(v >= lim ? v - 2 * lim : v); }
        else cell = String(v);
        line += cell.padStart(w);
      }
      out += line + '\n';
    });
  }
  flushErrs(Infinity);
  if (addr !== 'n') out += fmtAddr(data.length + skipped) + '\n';
  ctx.out(out);
  return st;
};

C.hexdump = C.hd = (ctx) => {
  const argv = ctx.argv.slice(1);
  let canonical = ctx.name === 'hd', n = Infinity, skip = 0, verbose = false;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '-C') canonical = true;
    else if (x === '-v') verbose = true;
    else if (x.startsWith('-n')) n = parseNum(x.length > 2 ? x.slice(2) : argv[++i]);
    else if (x.startsWith('-s')) skip = parseNum(x.length > 2 ? x.slice(2) : argv[++i]);
    else if (x === '-c' || x === '-x' || x === '-d' || x === '-o' || x === '-b') { /* simplified */ }
    else files.push(x);
  }
  let data = '';
  for (const f of (files.length ? files : ['-'])) { try { data += ctx.readFile(f); } catch (e) { ctx.err(`${f}: ${e.message}`); return 1; } }
  data = data.slice(skip, n === Infinity ? undefined : skip + n);
  let out = '';
  let prev = null, star = false;
  for (let off = 0; off < data.length; off += 16) {
    const chunk = data.slice(off, off + 16);
    if (!verbose && chunk === prev && chunk.length === 16) { if (!star) { out += '*\n'; star = true; } continue; }
    star = false; prev = chunk;
    if (canonical) {
      let hex = '';
      for (let k = 0; k < 16; k++) { hex += k < chunk.length ? chunk.charCodeAt(k).toString(16).padStart(2, '0') + ' ' : '   '; if (k === 7) hex += ' '; }
      out += `${(off + skip).toString(16).padStart(8, '0')}  ${hex} |${[...chunk].map(c => printable(c.charCodeAt(0)) ? c : '.').join('')}|\n`;
    } else {
      let line = (off + skip).toString(16).padStart(7, '0');
      for (let k = 0; k < 16; k += 2) {
        if (k < chunk.length) { const v = (chunk.charCodeAt(k) & 255) | (((chunk.charCodeAt(k + 1) || 0) & 255) << 8); line += ' ' + v.toString(16).padStart(4, '0'); }
        else line += '     ';
      }
      out += line + '\n';
    }
  }
  out += (data.length + skip).toString(16).padStart(canonical ? 8 : 7, '0') + '\n';
  ctx.out(out);
  return 0;
};

// ---------------------------------------------------------------- cmp
// diffutils 3.8 cmp.c
const CMP_VERSION = `cmp (GNU diffutils) 3.8
Copyright (C) 2021 Free Software Foundation, Inc.
License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.

Written by Torbjorn Granlund and David MacKenzie.
`;
class CmpExit { constructor(st) { this.st = st; } }
C.cmp = (ctx) => {
  const out = new StdioBuffer(ctx.stdout);
  // error() flushes stdout before writing to stderr
  const die = (msg, st = 2) => { out.flush(); ctx.stderr.write(`cmp: ${msg}\n`); throw new CmpExit(st); };
  const tryHelp = (reason) => { out.flush(); if (reason) ctx.stderr.write(`cmp: ${reason}\n`); die("Try 'cmp --help' for more information."); };
  const SUF = 'kKMGTPEZY0';
  const ignore = [0n, 0n];
  let bytes = -1n;
  let type = null;   // 'all' (-l) | 'status' (-s)
  let printBytes = false;
  const specifyType = (t) => { if (type && type !== t) tryHelp('options -l and -s are incompatible'); type = t; };
  const specifyIgnore = (f, arg, delim) => {
    const r = xstrtol(arg, SUF, { base: 0 });
    if (!((r.err === LONGINT_OK || (r.err === LONGINT_INVALID_SUFFIX_CHAR && r.rest[0] === delim)) && r.val >= 0n)) {
      tryHelp(`invalid --ignore-initial value '${arg}'`);
    }
    if (ignore[f] < r.val) ignore[f] = r.val;
    return r.rest;
  };
  const run = () => {
    const argv = ctx.argv.slice(1);
    const r = getopt(argv, { name: 'cmp', short: 'bci:ln:sv', long: { 'print-bytes': 'b', 'print-chars': 'c', 'ignore-initial': ['i', 'required'], verbose: 'l', bytes: ['n', 'required'], silent: 's', quiet: 's', version: 'v', help: 'h' } });
    for (const [k, v] of r.opts) {
      switch (k) {
        case 'b': case 'c': printBytes = true; break;
        case 'i': {
          const rest = specifyIgnore(0, v, ':');
          if (rest[0] === ':') specifyIgnore(1, rest.slice(1), '');
          else if (ignore[1] < ignore[0]) ignore[1] = ignore[0];
          break;
        }
        case 'l': specifyType('all'); break;
        case 'n': {
          const x = xstrtol(v, SUF, { base: 0 });
          if (x.err !== LONGINT_OK || x.val < 0n) tryHelp(`invalid --bytes value '${v}'`);
          if (!(0n <= bytes && bytes < x.val)) bytes = x.val;
          break;
        }
        case 's': specifyType('status'); break;
        case 'v': out.write(CMP_VERSION); return 0;
        default: break;
      }
    }
    if (r.error) { ctx.stderr.write(r.error + '\n'); tryHelp(null); }
    const ops = r.operands;
    if (!ops.length) tryHelp(`missing operand after '${argv.length ? argv[argv.length - 1] : 'cmp'}'`);
    const file = [ops[0], ops.length > 1 ? ops[1] : '-'];
    let k = 2;
    for (let f = 0; f < 2 && k < ops.length; f++) specifyIgnore(f, ops[k++], '');
    if (k < ops.length) tryHelp(`extra operand '${ops[k]}'`);
    const data = [null, null], node = [null, null];
    for (let f = 0; f < 2; f++) {
      if (f && ignore[0] === ignore[1] && file[0] === file[1]) return 0;
      try {
        if (file[f] === '-') {
          node[f] = ctx.stdin.name ? (() => { try { return ctx.fs.stat(ctx.stdin.name, ctx.cwd); } catch { return null; } })() : null;
          data[f] = ctx.readFile('-');
        } else {
          node[f] = ctx.fs.stat(file[f], ctx.cwd);
          data[f] = node[f].type === 'd' ? null : ctx.readFile(file[f]);
        }
      } catch (e) {
        if (!(e instanceof FsError)) throw e;
        if (type === 'status') return 2;
        die(`${file[f]}: ${e.message}`);
      }
    }
    // the same file at the same position is identical
    if (node[0] && node[0] === node[1] && ignore[0] === ignore[1] && file[0] !== '-' && file[1] !== '-') return 0;
    for (let f = 0; f < 2; f++) if (data[f] === null) die(`${file[f]}: Is a directory`);
    const isReg = (f) => node[f] && node[f].type === 'f';
    const pos = [Number(ignore[0]), Number(ignore[1])];
    if (type === 'status' && isReg(0) && isReg(1)) {
      const s0 = Math.max(0, data[0].length - pos[0]), s1 = Math.max(0, data[1].length - pos[1]);
      if (s0 !== s1 && (bytes < 0n || BigInt(Math.min(s0, s1)) < bytes)) return 1;
    }
    let d0 = data[0].slice(pos[0]), d1 = data[1].slice(pos[1]);
    if (bytes >= 0n) { const b = Number(bytes); d0 = d0.slice(0, b); d1 = d1.slice(0, b); }
    let width = 1;
    if (type === 'all') {
      let max = bytes >= 0n ? Number(bytes) : Number.MAX_SAFE_INTEGER;
      for (let f = 0; f < 2; f++) if (isReg(f)) max = Math.min(max, f ? d1.length : d0.length);
      width = String(Math.max(0, max)).length;
    }
    const sprintc = (b) => {
      let s = '';
      if (!(b >= 32 && b < 127)) {
        if (b >= 128) { s += 'M-'; b -= 128; }
        if (b < 32) { s += '^'; b += 64; } else if (b === 127) { s += '^'; b = 63; }
      }
      return s + String.fromCharCode(b);
    };
    const o3 = (b) => b.toString(8).padStart(3);
    const smaller = Math.min(d0.length, d1.length);
    let line = 1, atLineStart = true, differing = 0;
    let i = 0;
    while (i < smaller && d0[i] === d1[i]) i++;
    if (type !== 'all' && i > 0) {
      for (let j = 0; j < i; j++) if (d0[j] === '\n') line++;
      atLineStart = d0[i - 1] === '\n';
    }
    if (i < smaller) {
      if (type === 'status') return 1;
      if (type === null) {
        const c0 = d0.charCodeAt(i), c1 = d1.charCodeAt(i);
        if (!printBytes) out.write(`${file[0]} ${file[1]} differ: char ${i + 1}, line ${line}\n`);
        else out.write(`${file[0]} ${file[1]} differ: byte ${i + 1}, line ${line} is ${o3(c0)} ${sprintc(c0)} ${o3(c1)} ${sprintc(c1)}\n`);
        return 1;
      }
      for (; i < smaller; i++) {
        ctx.tick && (i & 4095) === 0 && ctx.tick();
        const c0 = d0.charCodeAt(i), c1 = d1.charCodeAt(i);
        if (c0 === c1) continue;
        const n = String(i + 1).padStart(width);
        if (!printBytes) out.write(`${n} ${o3(c0)} ${o3(c1)}\n`);
        else out.write(`${n} ${o3(c0)} ${sprintc(c0).padEnd(4)} ${o3(c1)} ${sprintc(c1)}\n`);
      }
      differing = -1;
    }
    if (d0.length !== d1.length) {
      if (differing <= 0 && type !== 'status') {
        const shorter = file[d1.length < d0.length ? 1 : 0];
        const n = Math.min(d0.length, d1.length);
        if (n === 0) ctx.stderr.write(`cmp: EOF on ${shorter} which is empty\n`);
        else if (type === null) {
          ctx.stderr.write(atLineStart
            ? `cmp: EOF on ${shorter} after byte ${n}, line ${line - 1}\n`
            : `cmp: EOF on ${shorter} after byte ${n}, in line ${line}\n`);
        } else ctx.stderr.write(`cmp: EOF on ${shorter} after byte ${n}\n`);
      }
      return 1;
    }
    return differing === 0 ? 0 : 1;
  };
  let st;
  try { st = run(); }
  catch (e) { if (!(e instanceof CmpExit)) throw e; st = e.st; }
  out.flush();
  return st;
};

// ---------------------------------------------------------------- tsort (GNU algorithm)
C.tsort = (ctx) => {
  const file = ctx.argv.slice(1).filter(x => x !== '--')[0] || '-';
  let data;
  try { data = ctx.readFile(file); } catch (e) { const m = readErrMsg(ctx, file, e); if (m !== null) ctx.err(m); return 1; }
  const toks = data.split(/\s+/).filter(Boolean);
  if (toks.length % 2) { ctx.err(`${file === '-' ? '-' : file}: input contains an odd number of tokens`); return 1; }
  const items = new Map();
  const get = (s) => { let it = items.get(s); if (!it) { it = { str: s, count: 0, top: [], qlink: null, done: false }; items.set(s, it); } return it; };
  for (let i = 0; i < toks.length; i += 2) {
    const j = get(toks[i]), k = get(toks[i + 1]);
    if (j !== k) { k.count++; j.top.unshift(k); }
  }
  const sorted = [...items.values()].sort((x, y) => byteCmp(x.str, y.str));
  let out = '';
  let remaining = items.size;
  let st = 0;
  while (remaining > 0) {
    const queue = sorted.filter(it => !it.done && it.count === 0);
    if (queue.length) {
      for (let qi = 0; qi < queue.length; qi++) {
        const it = queue[qi];
        if (it.done) continue;
        out += it.str + '\n';
        it.done = true;
        remaining--;
        for (const s of it.top) { s.count--; if (s.count === 0 && !s.done) queue.push(s); }
      }
      continue;
    }
    // cycle: report and break it
    const start = sorted.find(it => !it.done && it.count > 0);
    ctx.err(`${file === '-' ? '-' : file}: input contains a loop:`);
    // find a cycle by walking
    const path = [];
    let cur = start;
    const seen = new Set();
    while (cur && !seen.has(cur)) { seen.add(cur); path.push(cur); cur = cur.top.find(s => !s.done); }
    const loop = cur ? path.slice(path.indexOf(cur)) : path;
    for (const it of loop) ctx.err(it.str);
    if (loop.length) { loop[loop.length - 1].top = loop[loop.length - 1].top.filter(s => s !== loop[0]); loop[0].count--; }
    else start.count = 0;
    st = 1;
  }
  ctx.out(out);
  return st;
};

// ---------------------------------------------------------------- processes
function procList(ctx) {
  const sh = ctx.sh;
  const list = [{ pid: 1, cmd: 'init', args: '/sbin/init', tty: '?' }];
  for (const [pid, p] of sh.procs) list.push({ pid, cmd: p.cmd, args: p.args || p.cmd, tty: '?', state: p.state });
  list.push({ pid: sh.pid, cmd: 'bash', args: 'bash', tty: 'pts/0' });
  list.push({ pid: sh.pid + 7, cmd: ctx.name, args: ctx.argv.join(' '), tty: 'pts/0', self: true });
  return list.sort((a, b) => a.pid - b.pid);
}
C.ps = (ctx) => {
  const args = ctx.argv.slice(1).join(' ');
  const list = procList(ctx);
  let out = '';
  const oMatch = /(?:^|\s)-?o\s*([\w,]+)|--format[= ]([\w,]+)/.exec(args);
  const pMatch = /(?:^|\s)-p\s*(\d+)/.exec(args);
  let rows = pMatch ? list.filter(p => p.pid === +pMatch[1]) : list;
  if (oMatch) {
    const cols = (oMatch[1] || oMatch[2]).split(',');
    const hdr = { pid: '    PID', ppid: '   PPID', comm: 'COMMAND', cmd: 'CMD', args: 'COMMAND', user: 'USER', stat: 'STAT', '%cpu': '%CPU', '%mem': '%MEM', tty: 'TT', etime: '    ELAPSED' };
    const val = (p, c) => ({ pid: String(p.pid).padStart(7), ppid: String(p.pid === 1 ? 0 : 1).padStart(7), comm: p.cmd, cmd: p.args, args: p.args, user: 'root', stat: p.state || 'S', '%cpu': ' 0.0', '%mem': ' 0.1', tty: p.tty, etime: '      42:00' }[c] ?? '');
    const noHdr = /=/.test(oMatch[0]) || args.includes('--no-headers') || args.includes('h ');
    if (!noHdr) out += cols.map(c => hdr[c] || c.toUpperCase()).join(' ') + '\n';
    for (const p of rows) out += cols.map(c => val(p, c)).join(' ') + '\n';
  } else if (/aux|-aux|au|-ef|-e|-A|ax/.test(args)) {
    if (/-ef|-f/.test(args)) {
      out += 'UID          PID    PPID  C STIME TTY          TIME CMD\n';
      for (const p of rows) out += `root     ${String(p.pid).padStart(7)} ${String(p.pid === 1 ? 0 : 1).padStart(7)}  0 10:00 ${p.tty.padEnd(8)} 00:00:00 ${p.args}\n`;
    } else if (/u/.test(args)) {
      out += 'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n';
      for (const p of rows) out += `root     ${String(p.pid).padStart(7)}  0.0  0.1   4628  3712 ${p.tty.padEnd(8)} ${(p.state || 'Ss').padEnd(4)} 10:00   0:00 ${p.args}\n`;
    } else {
      out += '    PID TTY          TIME CMD\n';
      for (const p of rows) out += `${String(p.pid).padStart(7)} ${p.tty.padEnd(8)}     00:00:00 ${p.cmd}\n`;
    }
  } else {
    out += '    PID TTY          TIME CMD\n';
    for (const p of rows.filter(p => p.tty !== '?')) out += `${String(p.pid).padStart(7)} ${p.tty.padEnd(8)} 00:00:00 ${p.cmd}\n`;
  }
  ctx.out(out);
  return 0;
};
C.pgrep = (ctx) => {
  const args = ctx.argv.slice(1);
  const pat = args.filter(x => !x.startsWith('-')).pop();
  const full = args.includes('-f'), list = args.includes('-l') || args.includes('-a');
  if (!pat) { ctx.stderr.write('pgrep: no matching criteria specified\nTry `pgrep --help\' for more information.\n'); return 2; }
  const re = new RegExp(pat);
  const ms = procList(ctx).filter(p => !p.self && re.test(full ? p.args : p.cmd));
  ctx.out(ms.map(p => list ? `${p.pid} ${args.includes('-a') ? p.args : p.cmd}` : String(p.pid)).join('\n') + (ms.length ? '\n' : ''));
  return ms.length ? 0 : 1;
};
C.pkill = C.killall = (ctx) => {
  const args = ctx.argv.slice(1);
  const pat = args.filter(x => !x.startsWith('-')).pop();
  if (!pat) { ctx.err('no process name specified'); return 2; }
  const re = ctx.name === 'killall' ? new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') : new RegExp(pat);
  const ms = procList(ctx).filter(p => !p.self && p.pid !== ctx.sh.pid && p.pid !== 1 && re.test(args.includes('-f') ? p.args : p.cmd));
  for (const p of ms) { ctx.sh.procs.delete(p.pid); try { ctx.fs.root.entries.get('proc').entries.delete(String(p.pid)); } catch {} }
  if (!ms.length && ctx.name === 'killall') { ctx.stderr.write(`${pat}: no process found\n`); }
  return ms.length ? 0 : 1;
};
C.kill = (ctx) => doKill(ctx.sh, ctx.argv.slice(1), ctx.io, (m) => ctx.err(m.replace(/^\((\d+)\) - No such process$/, '($1) - No such process')));

// ---------------------------------------------------------------- which / whereis
C.which = (ctx) => {
  const all = ctx.argv.includes('-a');
  const names = ctx.argv.slice(1).filter(x => !x.startsWith('-'));
  let st = 0;
  const PATH = (ctx.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin').split(':');
  for (const n of names) {
    let found = false;
    const cands = n.includes('/') ? [n] : PATH.map(d => joinPath(d, n));
    for (const p of cands) {
      const r = ctx.fs.tryResolve(p, ctx.cwd);
      if (r && r.node.type === 'f' && (r.node.mode & 0o111)) { ctx.out(p + '\n'); found = true; if (!all) break; }
    }
    if (!found) st = 1;
  }
  return st;
};
C.whereis = (ctx) => {
  const names = ctx.argv.slice(1).filter(x => !x.startsWith('-'));
  for (const n of names) {
    const r = ctx.fs.tryResolve('/usr/bin/' + n, '/');
    ctx.out(`${n}:${r ? ` /usr/bin/${n}` : ''}${r && ctx.sh.manPages && ctx.sh.manPages[n] ? ` /usr/share/man/man1/${n}.1.gz` : ''}\n`);
  }
  return 0;
};

// ---------------------------------------------------------------- rename (perl rename)
C.rename = C['file-rename'] = C.prename = (ctx) => {
  const argv = ctx.argv.slice(1);
  let verbose = false, dry = false, force = false, nul = false, i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-v' || a === '--verbose') verbose = true;
    else if (a === '-n' || a === '--nono' || a === '--no-act') { dry = true; }
    else if (a === '-f' || a === '--force') force = true;
    else if (a === '-0' || a === '--null') nul = true;
    else if (a === '-d' || a === '--filename' || a === '--nopath') { /* basename only */ }
    else if (a === '-e') { i++; break; }
    else if (a === '--') { i++; break; }
    else if (/^-[vnf0]+$/.test(a)) { if (a.includes('v')) verbose = true; if (a.includes('n')) dry = true; if (a.includes('f')) force = true; }
    else break;
  }
  const expr = argv[i++];
  if (expr === undefined) { ctx.stderr.write('Usage: rename [-h|-m|-V] [-v] [-0] [-n] [-f] [-d] [-u [enc]] [-e|-E perlexpr]*|perlexpr [files]\n'); return 1; }
  let files = argv.slice(i);
  if (!files.length) files = ctx.stdin.readAll().split(nul ? '\0' : '\n').filter(Boolean);
  const tr = compilePerlRename(expr);
  if (tr.error) { ctx.stderr.write(tr.error + '\n'); return 255; }
  let st = 0;
  for (const f of files) {
    const nn = tr.fn(f);
    if (nn === f) continue;
    if (!force && ctx.fs.exists(nn, ctx.cwd, false)) { ctx.stderr.write(`${f} not renamed: ${nn} already exists\n`); st = 1; continue; }
    if (dry) { ctx.out(`rename(${f}, ${nn})\n`); continue; }
    try { ctx.fs.rename(f, nn, ctx.cwd); if (verbose) ctx.out(`${f} renamed as ${nn}\n`); }
    catch (e) { ctx.stderr.write(`Can't rename ${f} ${nn}: ${e.message}\n`); st = 1; }
  }
  return st;
};

function compilePerlRename(expr) {
  // supports s/re/repl/flags, y/a/b/, tr/a/b/, $_ = lc/uc, chains with ;
  const parts = expr.split(/;\s*/).filter(Boolean);
  const fns = [];
  for (const p of parts) {
    let m;
    if ((m = /^s(.)([\s\S]*)$/.exec(p.trim()))) {
      const d = m[1];
      const close = { '{': '}', '(': ')', '[': ']', '<': '>' }[d];
      let body = m[2];
      const splitAt = (s, delim) => { let out = [], cur = ''; for (let k = 0; k < s.length; k++) { if (s[k] === '\\' && k + 1 < s.length) { cur += s[k] + s[k + 1]; k++; continue; } if (s[k] === delim) { out.push(cur); cur = ''; continue; } cur += s[k]; } out.push(cur); return out; };
      let re, rep, flags;
      if (close) {
        const e1 = body.indexOf(close); re = body.slice(0, e1); let rest = body.slice(e1 + 1).trim();
        const o2 = rest[0], c2 = { '{': '}', '(': ')', '[': ']', '<': '>' }[o2] || o2; const e2 = rest.indexOf(c2, 1); rep = rest.slice(1, e2); flags = rest.slice(e2 + 1);
      } else { const sp = splitAt(body, d); if (sp.length < 3) return { error: `Substitution replacement not terminated at (user-supplied code).` }; [re, rep, flags] = [sp[0], sp[1], sp.slice(2).join(d)]; }
      const { src, flags: f2 } = pcreToJs(re);
      let rx;
      try { rx = new RegExp(src, (flags.includes('g') ? 'g' : '') + (flags.includes('i') || f2.includes('i') ? 'i' : '') + (flags.includes('s') ? 's' : '')); }
      catch (e) { return { error: `Unmatched ( in regex` }; }
      fns.push((s) => s.replace(rx, (...args) => perlRepl(rep, args)));
      continue;
    }
    if ((m = /^(?:y|tr)(.)([\s\S]*)$/.exec(p.trim()))) {
      const d = m[1];
      const [a, b] = m[2].split(d);
      const expand = (x) => x.replace(/(.)-(.)/g, (mm, lo, hi) => { let r = ''; for (let c = lo.charCodeAt(0); c <= hi.charCodeAt(0); c++) r += String.fromCharCode(c); return r; });
      const A = expand(a), B = expand(b || '');
      fns.push((s) => [...s].map(ch => { const k = A.indexOf(ch); return k < 0 ? ch : (B[Math.min(k, B.length - 1)] ?? ch); }).join(''));
      continue;
    }
    if ((m = /^\$_\s*=\s*(lc|uc|lcfirst|ucfirst)\s*(\$_)?$/.exec(p.trim()))) {
      const f = m[1];
      fns.push((s) => f === 'lc' ? s.toLowerCase() : f === 'uc' ? s.toUpperCase() : f === 'lcfirst' ? s[0].toLowerCase() + s.slice(1) : s[0].toUpperCase() + s.slice(1));
      continue;
    }
    return { error: `syntax error at (user-supplied code), near "${p}"` };
  }
  return { fn: (s) => fns.reduce((acc, f) => f(acc), s) };
}

function perlRepl(rep, args) {
  const m = args.slice(0, -2);
  let out = '', mode = null, one = null;
  const emit = (t) => { for (const ch of t) { let c = ch; if (one) { c = one === 'u' ? c.toUpperCase() : c.toLowerCase(); one = null; } else if (mode === 'U') c = c.toUpperCase(); else if (mode === 'L') c = c.toLowerCase(); out += c; } };
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === '\\' && i + 1 < rep.length) {
      const d = rep[++i];
      if (d === 'U' || d === 'L') { mode = d; continue; }
      if (d === 'E') { mode = null; continue; }
      if (d === 'u' || d === 'l') { one = d; continue; }
      if (/[1-9]/.test(d)) { emit(m[+d] ?? ''); continue; }
      emit(d === 'n' ? '\n' : d === 't' ? '\t' : d);
      continue;
    }
    if (c === '$' && /[0-9&{]/.test(rep[i + 1] || '')) {
      if (rep[i + 1] === '&') { emit(m[0]); i++; continue; }
      if (rep[i + 1] === '{') { const e = rep.indexOf('}', i); emit(m[+rep.slice(i + 2, e)] ?? ''); i = e; continue; }
      let n = '';
      while (/[0-9]/.test(rep[i + 1] || '')) n += rep[++i];
      emit(m[+n] ?? '');
      continue;
    }
    emit(c);
  }
  return out;
}

// ---------------------------------------------------------------- bash / sh as commands
C.bash = C.sh = C.dash = C.rbash = (ctx) => {
  const argv = ctx.argv.slice(1);
  const setopts = {}, shopt = {};
  let cmd = null, i = 0, readStdin = false, login = false, cMode = false;
  const dashName = ctx.name === 'sh' || ctx.name === 'dash';
  for (; i < argv.length; i++) {
    const a = argv[i];
    // -c makes the first operand the command string; options may still follow it
    if (a === '-c') { cMode = true; continue; }
    if (a === '--version') { ctx.out('GNU bash, version 5.1.16(1)-release (x86_64-pc-linux-gnu)\nCopyright (C) 2020 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <http://gnu.org/licenses/gpl.html>\n\nThis is free software; you are free to change and redistribute it.\nThere is NO WARRANTY for this software.\n'); return 0; }
    if (a === '-O' || a === '+O') { shopt[argv[++i]] = a[0] === '-'; continue; }
    if (a === '-o' || a === '+o') { setopts[argv[++i]] = a[0] === '-'; continue; }
    if (a === '-s') { readStdin = true; continue; }
    if (a === '-l' || a === '--login' || a === '-i' || a === '--norc' || a === '--noprofile' || a === '--posix' || a === '-r') { login = true; continue; }
    if (a === '--') { i++; break; }
    if ((ctx.name === 'sh' || ctx.name === 'dash') && /^--./.test(a)) { ctx.stderr.write(`${ctx.name}: 0: Illegal option --\n`); return 2; }
    if (/^[-+][euxvfnCaBhHkmpPtTc]+$/.test(a)) {
      for (const c of a.slice(1)) {
        if (c === 'c') { cMode = true; continue; }
        const map = { e: 'errexit', u: 'nounset', x: 'xtrace', v: 'verbose', f: 'noglob', n: 'noexec', C: 'noclobber', a: 'allexport' };
        if (map[c]) setopts[map[c]] = a[0] === '-';
      }
      continue;
    }
    break;
  }
  if (cMode) {
    if (i >= argv.length) {
      ctx.stderr.write(dashName ? `${ctx.name}: 0: -c requires an argument\n` : `${ctx.name}: -c: option requires an argument\n`);
      return 2;
    }
    cmd = argv[i++];
  }
  void login;
  const sh = ctx.sh;
  const env = ctx.env;
  // Ubuntu's /bin/sh is dash: no brace expansion or [[ ]], echo always interprets escapes,
  // and errors read "sh: 1: foo: not found"
  const dash = ctx.name === 'sh' || ctx.name === 'dash';
  if (cmd !== null) {
    const rest = argv.slice(i);
    return runChild(ctx, cmd, { arg0: rest[0] ?? (dash ? ctx.name : 'bash'), args: rest.slice(1), setopts, shopt });
  }
  if (!readStdin && i < argv.length) {
    const file = argv[i];
    let src;
    try { src = ctx.readFile(file); }
    catch (e) {
      if (dash) { if (e && e.code === 'EISDIR') return 0; ctx.stderr.write(`${ctx.name}: 0: cannot open ${file}: No such file\n`); return 2; }
      if (e && e.code === 'EISDIR') { ctx.stderr.write(`${file}: ${file}: Is a directory\n`); return 126; }
      ctx.stderr.write(`${ctx.name}: ${file}: ${e.message}\n`); return 127;
    }
    return runChild(ctx, src, { arg0: file, args: argv.slice(i + 1), setopts, shopt, scriptMode: true });
  }
  // a script read from standard input reports errors as "bash: line N:"
  const src = ctx.stdin.readAll();
  return runChild(ctx, src, { arg0: ctx.name, args: argv.slice(i), setopts, shopt, stdinConsumed: true, scriptMode: true });
  function runChild(ctx2, src, o) {
    const io = { fds: { ...ctx2.io.fds } };
    if (o.stdinConsumed) io.fds[0] = new (ctx2.stdin.constructor)('');
    return sh.runChildShell(src, io, env, { arg0: o.arg0, args: o.args, setopts: o.setopts, shopt: o.shopt, scriptMode: !!o.scriptMode, dash });
  }
};

// ---------------------------------------------------------------- terminal-ish
C.clear = (ctx) => { ctx.out('\x1b[H\x1b[2J\x1b[3J'); return 0; };
C.reset = (ctx) => { ctx.out('\x1bc'); return 0; };
C.tput = (ctx) => {
  const [cap, ...rest] = ctx.argv.slice(1);
  const caps = { clear: '\x1b[H\x1b[2J', cols: '80\n', lines: '24\n', colors: '8\n', sgr0: '\x1b(B\x1b[m', bold: '\x1b[1m', smul: '\x1b[4m', rmul: '\x1b[24m', rev: '\x1b[7m', blink: '\x1b[5m', dim: '\x1b[2m', civis: '\x1b[?25l', cnorm: '\x1b[?12l\x1b[?25h', el: '\x1b[K', home: '\x1b[H' };
  if (cap === 'setaf' || cap === 'setab') { ctx.out(`\x1b[${cap === 'setaf' ? 3 : 4}${rest[0] || 0}m`); return 0; }
  if (cap === 'cup') { ctx.out(`\x1b[${(+rest[0] || 0) + 1};${(+rest[1] || 0) + 1}H`); return 0; }
  if (caps[cap] === undefined) { ctx.err(`unknown terminfo capability '${cap}'`); return 4; }
  ctx.out(caps[cap]);
  return 0;
};
C.stty = (ctx) => { ctx.err("'standard input': Inappropriate ioctl for device"); return 1; };
C.tty = (ctx) => { ctx.out('not a tty\n'); return 1; };
C.mesg = () => 0;
C.sync = () => 0;
C.look = (ctx) => {
  const args = ctx.argv.slice(1).filter(x => !x.startsWith('-'));
  const prefix = args[0] || '';
  const file = args[1] || '/usr/share/dict/words';
  let data;
  try { data = ctx.readFile(file); } catch (e) { ctx.err(`${file}: ${e.message}`); return 2; }
  const fold = ctx.argv.includes('-f') || !args[1];
  const ms = splitLines(data).filter(l => fold ? l.toLowerCase().startsWith(prefix.toLowerCase()) : l.startsWith(prefix));
  ctx.out(ms.map(x => x + '\n').join(''));
  return ms.length ? 0 : 1;
};

// pagers behave like cat when stdout is not a terminal
// util-linux more writing to a non-terminal: every file gets a ':::' header, errors don't change the status
C.more = C.less = C.pg = C.most = (ctx) => {
  const files = ctx.argv.slice(1).filter(a => !/^[-+]./.test(a));
  if (!files.length) { ctx.out(ctx.stdin.readAll()); return 0; }
  for (const f of files) {
    let d;
    try { d = ctx.readFile(f); }
    catch (e) {
      if (e.code === 'EISDIR') ctx.out(`\n*** ${f}: directory ***\n\n`);
      else ctx.stderr.write(`${ctx.name}: cannot open ${f}: ${e.message}\n`);
      continue;
    }
    if (ctx.name === 'more' && f !== '-') ctx.out(`::::::::::::::\n${f}\n::::::::::::::\n`);
    ctx.out(d);
  }
  return 0;
};
C.unlink = (ctx) => {
  const a = parseArgs(ctx, { short: '', long: { help: 'help', version: 'version' } });
  if (!a) return 1;
  if (a.has('help')) { ctx.out('Usage: unlink FILE\n  or:  unlink OPTION\nCall the unlink function to remove the specified FILE.\n\n      --help     display this help and exit\n      --version  output version information and exit\n'); return 0; }
  if (a.has('version')) { ctx.out('unlink (GNU coreutils) 8.32\n'); return 0; }
  const ops = a.operands;
  if (ops.length !== 1) { ctx.err(ops.length ? `extra operand ${qa(ops[1])}` : 'missing operand'); ctx.stderr.write("Try 'unlink --help' for more information.\n"); return 1; }
  try { ctx.fs.unlink(ops[0], ctx.cwd); } catch (e) { ctx.err(`cannot unlink ${qa(ops[0])}: ${e.message}`); return 1; }
  return 0;
};
C.shasum = (ctx) => {
  const argv = ctx.argv.slice(1);
  let algo = '1';
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-a' || argv[i] === '--algorithm') { algo = argv[++i]; continue; }
    if (/^-a\d+$/.test(argv[i])) { algo = argv[i].slice(2); continue; }
    rest.push(argv[i]);
  }
  const name = { 1: 'sha1sum', 224: 'sha224sum', 256: 'sha256sum', 384: 'sha384sum', 512: 'sha512sum' }[algo];
  if (!name) { ctx.stderr.write(`shasum: Unrecognized algorithm\n`); return 1; }
  return C[name]({ ...ctx, name, argv: [name, ...rest] });
};
C.colrm = (ctx) => {
  const [a, b] = ctx.argv.slice(1).map(Number);
  const data = ctx.stdin.readAll();
  ctx.out(data.split('\n').map(l => { if (!a) return l; const s = a - 1; return b ? l.slice(0, s) + l.slice(b) : l.slice(0, s); }).join('\n'));
  return 0;
};
C.dmesg = (ctx) => { ctx.err('read kernel buffer failed: Operation not permitted'); return 1; };

export default C;
