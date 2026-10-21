// Shell builtins.
import { ExitSignal, ReturnSignal, BreakSignal, ContinueSignal, ShellAbort, InStream, OutBuf } from './streams.js';
import { doPrintf, shellQuote, printfQ } from './printf.js';
import { FsError, normPath, joinPath, byteCmp } from './vfs.js';
import { Var, decodeEscapes, DASH_BUILTINS, assocKeys } from './shell.js';
import { deparse } from './deparse.js';
import { DASH_KEYWORDS, Parser } from './parser.js';
import { fnmatch } from './pattern.js';
import { HELP_TOPICS, HELP_DOCS, HELP_LIST } from './bashhelp.js';
import { evalArith, ArithError } from './arith.js';

export { shellQuote };

export const SPECIAL_BUILTINS = new Set([':', '.', 'source', 'break', 'continue', 'eval', 'exec', 'exit', 'export', 'readonly', 'return', 'set', 'shift', 'trap', 'unset']);
export const KEYWORD_LIST = ['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done', 'in', 'function', 'time', '{', '}', '!', '[[', ']]', 'coproc'];

const out = (sh, io, s) => sh.writeFd(io, 1, s);
const err = (sh, io, s) => sh.shellError(io, s);

// The one-line synopses bash prints after a usage error ("NAME: usage: ...", with no
// "bash: line N:" prefix).
const SYNOPSIS = {
  alias: 'alias [-p] [name[=value] ... ]', unalias: 'unalias [-a] name [name ...]',
  cd: 'cd [-L|[-P [-e]] [-@]] [dir]', pwd: 'pwd [-LP]',
  pushd: 'pushd [-n] [+N | -N | dir]', popd: 'popd [-n] [+N | -N]', dirs: 'dirs [-clpv] [+N] [-N]',
  declare: 'declare [-aAfFgiIlnrtux] [-p] [name[=value] ...]', typeset: 'typeset [-aAfFgiIlnrtux] [-p] name[=value] ...',
  local: 'local [option] name[=value] ...', export: 'export [-fn] [name[=value] ...] or export -p',
  readonly: 'readonly [-aAf] [name[=value] ...] or readonly -p', unset: 'unset [-f] [-v] [-n] [name ...]',
  set: 'set [-abefhkmnptuvxBCHP] [-o option-name] [--] [arg ...]', shopt: 'shopt [-pqsu] [-o] [optname ...]',
  read: 'read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]',
  mapfile: 'mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]',
  readarray: 'readarray [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]',
  printf: 'printf [-v var] format [arguments]', eval: 'eval [arg ...]', source: 'source filename [arguments]', '.': '. filename [arguments]',
  type: 'type [-afptP] name [name ...]', command: 'command [-pVv] command [arg ...]', builtin: 'builtin [shell-builtin [arg ...]]',
  hash: 'hash [-lr] [-p pathname] [-dt] [name ...]', trap: 'trap [-lp] [[arg] signal_spec ...]',
  kill: 'kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]', wait: 'wait [-fn] [-p var] [id ...]',
  history: 'history [-c] [-d offset] [n] or history -anrw [filename] or history -ps arg [arg...]',
  exec: 'exec [-cl] [-a name] [command [argument ...]] [redirection ...]', times: 'times', umask: 'umask [-p] [-S] [mode]',
  getopts: 'getopts optstring name [arg ...]', enable: 'enable [-a] [-dnps] [-f filename] [name ...]', help: 'help [-dms] [pattern ...]',
  disown: 'disown [-h] [-ar] [jobspec ... | pid ...]', suspend: 'suspend [-f]', fc: 'fc [-e ename] [-lnr] [first] [last] or fc -s [pat=rep] [command]',
  compgen: 'compgen [-abcdefgjksuv] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [word]',
  complete: 'complete [-abcdefgjksuv] [-pr] [-DEI] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [name ...]',
};
function usage(sh, io, name) { if (SYNOPSIS[name]) sh.writeFd(io, 2, `${name}: usage: ${SYNOPSIS[name]}\n`); }
// bash's internal_getopt: options come first, `--` ends them, a lone `-` is an operand. `spec`
// lists the letters, ':' after one that takes an argument. A bad option prints the error and the
// usage line; the caller then returns 2.
function bopts(sh, io, argv, spec, { plus = false } = {}) {
  const name = argv[0], opts = [];
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') break;
    if (a === '--') { i++; break; }
    if (a.length < 2 || !(a[0] === '-' || (plus && a[0] === '+'))) break;
    for (let j = 1; j < a.length; j++) {
      const c = a[j], k = c === ':' ? -1 : spec.indexOf(c);
      if (k < 0) { err(sh, io, `${name}: ${a[0]}${c}: invalid option`); usage(sh, io, name); return null; }
      if (spec[k + 1] === ':') {
        let v = a.slice(j + 1);
        if (!v) {
          if (i + 1 >= argv.length) { err(sh, io, `${name}: ${a[0]}${c}: option requires an argument`); usage(sh, io, name); return null; }
          v = argv[++i];
        }
        opts.push([a[0] + c, v]);
        break;
      }
      opts.push([a[0] + c, true]);
    }
  }
  return { opts, args: argv.slice(i), has: (o) => opts.some(([k]) => k === o) };
}
// validate a builtin's options the way bash does before running it
const checked = (spec, fn, o) => (sh, argv, io) => {
  if (sh.dash) return DASH_SPECS[argv[0]] === undefined || dashOpts(sh, io, argv, DASH_SPECS[argv[0]]) ? fn(sh, argv, io) : 2;
  return bopts(sh, io, argv, spec, o) ? fn(sh, argv, io) : 2;
};
// dash's option letters for its builtins, and its error for others
const DASH_SPECS = { cd: 'LP', pwd: 'LP', export: 'p', readonly: 'p', unset: 'fv', trap: '', type: '', command: 'pvV', umask: 'S', hash: 'r', alias: '', unalias: 'a', read: 'p:r', getopts: '', jobs: 'lp', times: '' };
function dashOpts(sh, io, argv, spec) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string' || a === '--') break;
    if (a.length < 2 || a[0] !== '-') break;
    for (let j = 1; j < a.length; j++) {
      const k = spec.indexOf(a[j]);
      if (k < 0 || a[j] === ':') { err(sh, io, `${argv[0]}: Illegal option -${a[j]}`); return false; }
      if (spec[k + 1] === ':') { if (j === a.length - 1) i++; break; }
    }
  }
  return true;
}

export const SIGNALS = ['HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'IO', 'PWR', 'SYS'];
export function signalNumber(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const n = s.toUpperCase().replace(/^SIG/, '');
  if (n === 'EXIT') return 0;
  const i = SIGNALS.indexOf(n);
  return i >= 0 ? i + 1 : -1;
}

// ---------------------------------------------------------------- test / [
class TestErr extends Error {}
const UNARY = new Set(['-a', '-b', '-c', '-d', '-e', '-f', '-g', '-h', '-k', '-p', '-r', '-s', '-t', '-u', '-w', '-x', '-G', '-L', '-N', '-O', '-S', '-z', '-n', '-v', '-o', '-R']);
const BINARY = new Set(['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);

function toInt(s) {
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) throw new TestErr(`${s}: integer expression expected`);
  return BigInt(t);
}

export function testExpr(sh, args) {
  const unary = (op, a) => sh.unaryTest(op, a);
  const binary = (a, op, b) => {
    switch (op) {
      case '=': case '==': return a === b;
      case '!=': return a !== b;
      case '<': return a < b;
      case '>': return a > b;
      case '-eq': return toInt(a) === toInt(b);
      case '-ne': return toInt(a) !== toInt(b);
      case '-lt': return toInt(a) < toInt(b);
      case '-le': return toInt(a) <= toInt(b);
      case '-gt': return toInt(a) > toInt(b);
      case '-ge': return toInt(a) >= toInt(b);
      default: return sh.binaryFileTest(op, a, b);
    }
  };
  const n = args.length;
  if (n === 0) return false;
  if (n === 1) return args[0] !== '';
  if (n === 2) {
    if (args[0] === '!') return args[1] === '';
    if (sh.dash && (args[0] === '-a' || args[0] === '-o')) throw new TestErr(`${args[0]}: unexpected operator`);
    if (UNARY.has(args[0])) return unary(args[0], args[1]);
    throw new TestErr(`${args[0]}: unary operator expected`);
  }
  if (n === 3) {
    if (sh.dash && args[1] === '==') throw new TestErr(`${args[0]}: unexpected operator`);
    if (BINARY.has(args[1])) return binary(args[0], args[1], args[2]);
    if (args[1] === '-a') return args[0] !== '' && args[2] !== '';
    if (args[1] === '-o') return args[0] !== '' || args[2] !== '';
    if (args[0] === '!') return !testExpr(sh, args.slice(1));
    if (args[0] === '(' && args[2] === ')') return args[1] !== '';
    throw new TestErr(`${args[1]}: binary operator expected`);
  }
  if (n === 4) {
    if (args[0] === '!') return !testExpr(sh, args.slice(1));
    if (args[0] === '(' && args[3] === ')') return testExpr(sh, args.slice(1, 3));
  }
  // general expression
  let i = 0;
  const peek = () => args[i];
  const orE = () => { let v = andE(); while (peek() === '-o') { i++; const r = andE(); v = v || r; } return v; };
  const andE = () => { let v = notE(); while (peek() === '-a') { i++; const r = notE(); v = v && r; } return v; };
  const notE = () => { if (peek() === '!') { i++; return !notE(); } return prim(); };
  const prim = () => {
    const a = args[i];
    if (a === undefined) throw new TestErr('argument expected');
    if (a === '(') { i++; const v = orE(); if (args[i] !== ')') throw new TestErr("`)' expected"); i++; return v; }
    if (BINARY.has(args[i + 1]) && args[i + 2] !== undefined) { const r = binary(a, args[i + 1], args[i + 2]); i += 3; return r; }
    if (UNARY.has(a) && args[i + 1] !== undefined) { const r = unary(a, args[i + 1]); i += 2; return r; }
    i++;
    return a !== '';
  };
  const v = orE();
  if (i < args.length) throw new TestErr('too many arguments');
  return v;
}

function bTest(sh, argv, io) {
  let args = argv.slice(1);
  const name = argv[0];
  if (name === '[') {
    if (args[args.length - 1] !== ']') { err(sh, io, "[: missing `]'"); return 2; }
    args = args.slice(0, -1);
  }
  try { return testExpr(sh, args) ? 0 : 1; }
  catch (e) {
    if (e instanceof TestErr) { err(sh, io, `${name}: ${sh.dash ? e.message.replace(/binary operator expected$/, 'unexpected operator') : e.message}`); return 2; }
    throw e;
  }
}

// ---------------------------------------------------------------- echo / printf
function bEcho(sh, argv, io) {
  if (sh.dash) {
    // dash's echo: only -n, and backslash escapes are always interpreted
    let i = 1, nl = true;
    if (argv[1] === '-n') { nl = false; i = 2; }
    const r = decodeEscapes(argv.slice(i).join(' '), { echo: true, dash: true });
    out(sh, io, r.text + (r.stop || !nl ? '' : '\n'));
    return 0;
  }
  let i = 1, nl = true, esc = sh.shopt.xpg_echo;
  while (i < argv.length && /^-[neE]+$/.test(argv[i])) {
    for (const c of argv[i].slice(1)) { if (c === 'n') nl = false; else if (c === 'e') esc = true; else esc = false; }
    i++;
  }
  let s = argv.slice(i).join(' ');
  if (esc) {
    const r = decodeEscapes(s, { echo: true });
    out(sh, io, r.text + (r.stop ? '' : (nl ? '\n' : '')));
    return 0;
  }
  out(sh, io, s + (nl ? '\n' : ''));
  return 0;
}

function bPrintf(sh, argv, io) {
  const o = bopts(sh, io, argv, 'v:');
  if (!o) return 2;
  const args = o.args;
  let varName = null;
  for (const [k, v] of o.opts) if (k === '-v') varName = v;
  if (!args.length) { usage(sh, io, 'printf'); return 2; }
  // bash's stdout is line buffered: complete lines go out ahead of each diagnostic
  const write = varName || sh.dash ? undefined : (s) => out(sh, io, s);
  const r = doPrintf(args[0], args.slice(1), { err: (m) => err(sh, io, `printf: ${sh.dash ? m.replace(/: invalid number$/, ': expected numeric value') : m}`), startTime: sh.startTime, dash: sh.dash, write, flush: 'lines' });
  if (varName) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/.exec(varName);
    if (!m) { err(sh, io, `printf: \`${varName}': not a valid identifier`); return 2; }
    if (m[2] !== undefined) sh.setArrayElem(m[1], /^-?\d+$/.test(m[2]) ? Number(m[2]) : m[2], r.out);
    else sh.setVar(m[1], r.out);
  } else out(sh, io, r.out);
  return r.status;
}

// ---------------------------------------------------------------- directories
function setCwd(sh, logical) {
  sh.setVar('OLDPWD', sh.getVar('PWD') ?? sh.cwd);
  const ov = sh.lookupVar('OLDPWD'); if (ov) ov.exported = true;
  sh.cwd = logical;
  sh.setVar('PWD', logical);
}

function bCd(sh, argv, io) {
  let args = argv.slice(1);
  let physical = false;
  while (args.length && /^-[LPe@]+$/.test(args[0])) { if (args[0].includes('P')) physical = true; args.shift(); }
  if (args[0] === '--') args.shift();
  if (args.length > 1) { err(sh, io, 'cd: too many arguments'); return 1; }
  let dir = args[0];
  let print = false;
  if (dir === undefined) { dir = sh.getVar('HOME'); if (dir === undefined) { err(sh, io, 'cd: HOME not set'); return 1; } }
  else if (dir === '-') { dir = sh.getVar('OLDPWD'); if (dir === undefined) { err(sh, io, 'cd: OLDPWD not set'); return 1; } print = true; }
  if (dir === '') return 0;
  const base = sh.getVar('PWD') || sh.cwd;
  let logical = dir.startsWith('/') ? normPath(dir) : normPath(joinPath(base, dir));
  try {
    const r = sh.fs.resolve(dir.startsWith('/') ? dir : joinPath(sh.cwd, dir), '/');
    if (r.node.type !== 'd') { if (sh.dash) { err(sh, io, `cd: can't cd to ${dir}`); return 2; } err(sh, io, `cd: ${dir}: Not a directory`); return 1; }
    if (physical) logical = r.path;
    else {
      // verify the logical path resolves to the same dir, else fall back to physical
      const lr = sh.fs.tryResolve(logical, '/');
      if (!lr || lr.node !== r.node) logical = r.path;
    }
  } catch (e) {
    if (e instanceof FsError) { if (sh.dash) { err(sh, io, `cd: can't cd to ${dir}`); return 2; } err(sh, io, `cd: ${dir}: ${e.message}`); return 1; }
    throw e;
  }
  setCwd(sh, logical);
  if (print) out(sh, io, logical + '\n');
  return 0;
}

function bPwd(sh, argv, io) {
  let physical = false;
  for (const a of argv.slice(1)) {
    if (a === '--') break;
    if (!a.startsWith('-') || a === '-') break;
    for (const c of a.slice(1)) {
      if (c === 'P') physical = true;
      else if (c === 'L') physical = false;
      else if (sh.dash) { err(sh, io, `pwd: Illegal option -${c}`); return 2; }
      else { err(sh, io, `pwd: -${c}: invalid option`); sh.writeFd(io, 2, 'pwd: usage: pwd [-LP]\n'); return 2; }
    }
  }
  let p = sh.getVar('PWD') || sh.cwd;
  if (physical) { try { p = sh.fs.realpath(sh.cwd, '/'); } catch {} }
  else {
    const r = sh.fs.tryResolve(p, '/');
    const c = sh.fs.tryResolve(sh.cwd, '/');
    if (!r || !c || r.node !== c.node) p = sh.cwd;
  }
  out(sh, io, p + '\n');
  return 0;
}

function homeTilde(sh, p) {
  const h = sh.getVar('HOME');
  if (h && h !== '/' && (p === h || p.startsWith(h + '/'))) return '~' + p.slice(h.length);
  return p;
}

function bPushd(sh, argv, io) {
  const args = argv.slice(1).filter(a => a !== '-n');
  if (!args.length) {
    if (!sh.dirStack.length) { err(sh, io, 'pushd: no other directory'); return 1; }
    const top = sh.dirStack.shift();
    const cur = sh.cwd;
    if (bCd(sh, ['cd', top], io) !== 0) { sh.dirStack.unshift(top); return 1; }
    sh.dirStack.unshift(cur);
  } else {
    const cur = sh.cwd;
    if (bCd(sh, ['cd', args[0]], io) !== 0) return 1;
    sh.dirStack.unshift(cur);
  }
  out(sh, io, [sh.cwd, ...sh.dirStack].map(p => homeTilde(sh, p)).join(' ') + '\n');
  return 0;
}

function bPopd(sh, argv, io) {
  if (!sh.dirStack.length) { err(sh, io, 'popd: directory stack empty'); return 1; }
  const d = sh.dirStack.shift();
  if (bCd(sh, ['cd', d], io) !== 0) return 1;
  out(sh, io, [sh.cwd, ...sh.dirStack].map(p => homeTilde(sh, p)).join(' ') + '\n');
  return 0;
}

function bDirs(sh, argv, io) {
  const args = argv.slice(1);
  const list = [sh.cwd, ...sh.dirStack];
  if (args.includes('-c')) { sh.dirStack = []; return 0; }
  if (args.includes('-v')) { list.forEach((p, i) => out(sh, io, ` ${i}  ${homeTilde(sh, p)}\n`)); return 0; }
  if (args.includes('-p')) { list.forEach(p => out(sh, io, homeTilde(sh, p) + '\n')); return 0; }
  out(sh, io, list.map(p => args.includes('-l') ? p : homeTilde(sh, p)).join(' ') + '\n');
  return 0;
}

// ---------------------------------------------------------------- variables
function declPrint(sh, name, v) {
  let flags = '';
  if (v.arr) flags += 'a';
  if (v.assoc) flags += 'A';
  if (v.integer) flags += 'i';
  if (v.lower) flags += 'l';
  if (v.readonly) flags += 'r';
  if (v.upper) flags += 'u';
  if (v.exported) flags += 'x';
  const f = flags ? '-' + flags : '--';
  if ((v.arr || v.assoc) && v.invisible && !(v.arr || v.assoc).size) return `declare ${f} ${name}`;
  if (v.arr) {
    const keys = [...v.arr.keys()].sort((a, b) => a - b);
    return `declare ${f} ${name}=(${keys.map(k => `[${k}]=${elemQuote(v.arr.get(k))}`).join(' ')})`;
  }
  if (v.assoc) return `declare ${f} ${name}=(${assocKeys(v.assoc).map(k => `[${keyQuote(k)}]=${elemQuote(v.assoc.get(k))} `).join('')})`;
  if (v.value === null) return `declare ${f} ${name}`;
  return `declare ${f} ${name}=${dq(v.value)}`;
}
function dq(s) { return '"' + s.replace(/(["\\$`])/g, '\\$1') + '"'; }
// array_to_assign / assoc_to_assign: elements that aren't printable ASCII get $'…' (ansic_quote),
// the rest double quotes; assoc keys stay bare unless they hold shell metacharacters
const needsAnsic = (s) => /[^\x20-\x7e]/.test(s);
const ANSIC_ESC = { '\x1b': 'E', '\x07': 'a', '\v': 'v', '\b': 'b', '\f': 'f', '\n': 'n', '\r': 'r', '\t': 't', '\\': '\\', "'": "'" };
function ansicQuote(s) {
  let out = "$'";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ANSIC_ESC[ch]) out += '\\' + ANSIC_ESC[ch];
    else if (c < 0x20 || c >= 0x7f) out += '\\' + c.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out + "'";
}
const elemQuote = (s) => (needsAnsic(s) ? ansicQuote(s) : dq(s));
function shellMetas(s) {
  if (/[ \t\n'"\\|&;()<>!{}*[?\]^$`]/.test(s) || s[0] === '#') return true;
  for (let i = 0; i < s.length; i++) if (s[i] === '~' && (i === 0 || s[i - 1] === '=' || s[i - 1] === ':')) return true;
  return false;
}
const keyQuote = (k) => (needsAnsic(k) ? ansicQuote(k) : shellMetas(k) || k === '@' || k === '*' ? dq(k) : k);

function allVars(sh) {
  const m = new Map();
  for (const sc of sh.scopes) for (const [k, v] of sc) m.set(k, v);
  return m;
}

function bDeclare(sh, argv, io) {
  const name = argv[0];
  const set = new Set(), unset = new Set();
  let i = 1;
  const items = [];
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a === 'string' && /^[-+][aAfFgilnprtux]+$/.test(a)) {
      for (const c of a.slice(1)) (a[0] === '-' ? set : unset).add(c);
      continue;
    }
    if (a === '--') { i++; break; }
    break;
  }
  for (; i < argv.length; i++) items.push(argv[i]);
  if (name === 'local' && sh.funcStack.length === 0) {
    if (sh.dash) { err(sh, io, 'local: not in a function'); return 2; }
    err(sh, io, 'local: can only be used in a function'); return 1;
  }
  const local = (name === 'local' || (sh.funcStack.length > 0 && !set.has('g'))) && name !== 'export' && name !== 'readonly';
  if (set.has('f') || set.has('F')) {
    const names = items.length ? items : [...sh.functions.keys()].sort(byteCmp);
    let st = 0;
    for (const n of names) {
      if (!sh.functions.has(n)) { st = 1; continue; }
      if (set.has('F')) out(sh, io, `declare -f ${n}\n`);
      else out(sh, io, deparse({ t: 'func', name: n, body: sh.functions.get(n) }) + '\n');
    }
    return st;
  }
  if (set.has('p') || (items.length === 0 && name !== 'local')) {
    if (items.length === 0) {
      const vars = allVars(sh);
      for (const k of [...vars.keys()].sort(byteCmp)) {
        const v = vars.get(k);
        if (name === 'export' && !v.exported) continue;
        if (name === 'readonly' && !v.readonly) continue;
        if (set.has('x') && !v.exported) continue;
        if (set.has('a') && !v.arr) continue;
        if (set.has('A') && !v.assoc) continue;
        if (name === 'export' || name === 'readonly') out(sh, io, declPrint(sh, k, v).replace(/^declare -[a-zA-Z]*|^declare --/, m => 'declare ' + m.slice(8)) + '\n');
        else out(sh, io, (set.has('p') || set.size || unset.size ? declPrint(sh, k, v) : (v.arr || v.assoc ? declPrint(sh, k, v).replace(/^declare \S+ /, '') : `${k}=${shellQuote(v.value ?? '')}`)) + '\n');
      }
      return 0;
    }
    let st = 0;
    for (const it of items) {
      const n = typeof it === 'string' ? it.split('=')[0] : it.declArray.name;
      const v = sh.lookupVar(n);
      if (!v) { err(sh, io, `${name}: ${n}: not found`); st = 1; continue; }
      out(sh, io, declPrint(sh, n, v) + '\n');
    }
    return st;
  }
  let st = 0;
  for (const it of items) {
    let vname, value = null, append = false, arrayAssign = null, index = null;
    if (typeof it === 'object' && it.declArray) { vname = it.declArray.name; arrayAssign = it.declArray; }
    else {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=([\s\S]*)$/.exec(it);
      if (m) { vname = m[1]; index = m[2] ? m[2].slice(1, -1) : null; append = m[3] === '+'; value = m[4]; }
      else vname = it;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(vname)) { err(sh, io, `${name}: \`${it}': not a valid identifier`); st = 1; continue; }
    if (name === 'export' && set.has('n')) { const v = sh.lookupVar(vname); if (v) v.exported = false; continue; }
    if (set.has('n') && name !== 'export') {
      const scope2 = local ? sh.scopes[sh.scopes.length - 1] : sh.scopes[0];
      let rv = scope2.get(vname);
      if (!rv) { rv = new Var(); scope2.set(vname, rv); }
      if (value !== null) { rv.nameref = value; rv.value = null; }
      continue;
    }
    if (name === 'export' && set.has('f')) continue;
    // find/create variable in the right scope
    let scope = local ? sh.scopes[sh.scopes.length - 1] : (set.has('g') ? sh.scopes[0] : sh.findScopeFor(vname));
    let v = scope.get(vname);
    if (!v) {
      if (local) { v = new Var(); scope.set(vname, v); }
      else { v = sh.lookupVar(vname); if (!v) { v = new Var(); sh.scopes[0].set(vname, v); } }
    }
    if (v.readonly && (value !== null || arrayAssign)) { err(sh, io, `${vname}: readonly variable`); st = 1; continue; }
    if (set.has('n') && value !== null) { v.nameref = value; v.value = null; continue; }
    if (set.has('n') && value === null && !v.nameref) { v.nameref = ''; }
    // `declare -a x` with no value makes an array that is declared but still unset
    if (set.has('a') && !v.arr && !v.assoc) { v.arr = new Map(); if (v.value !== null) v.arr.set(0, v.value); else v.invisible = true; v.value = null; }
    if (set.has('A') && !v.assoc) { v.assoc = new Map(); if (v.value !== null) v.assoc.set('0', v.value); else v.invisible = true; v.value = null; v.arr = null; }
    if (set.has('i')) v.integer = true; if (unset.has('i')) v.integer = false;
    if (set.has('l')) { v.lower = true; v.upper = false; } if (unset.has('l')) v.lower = false;
    if (set.has('u')) { v.upper = true; v.lower = false; } if (unset.has('u')) v.upper = false;
    if (set.has('x') || name === 'export') v.exported = true; if (unset.has('x')) v.exported = false;
    if (arrayAssign) {
      sh.doAssign(arrayAssign, { local, decl: true });
    } else if (value !== null) {
      if (index !== null) sh.setArrayElem(vname, v.assoc ? index : Number(sh.arith(index || '0')), value, { local, append });
      else sh.setVar(vname, value, { local, append });
      // bash traces the assignment again only for export and readonly
      if (sh.opts.xtrace && (name === 'export' || name === 'readonly')) sh.xtrace(io, `${vname}${index !== null ? `[${index}]` : ''}${append ? '+' : ''}=${value === '' ? '' : sh.xq(value)}`);
    } else if (local && v.value === null && !v.arr && !v.assoc && !set.has('a') && !set.has('A')) {
      // `local x` declares without value
    }
    if (set.has('r') || name === 'readonly') v.readonly = true;
  }
  return st;
}

function bUnset(sh, argv, io) {
  let mode = 'v';
  let st = 0;
  for (const a of argv.slice(1)) {
    if (a === '-f') { mode = 'f'; continue; }
    if (a === '-v') { mode = 'v'; continue; }
    if (a === '-n') continue;
    if (mode === 'f') { sh.functions.delete(a); continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(a);
    if (m) {
      const v = sh.lookupVar(m[1]);
      if (v) {
        if (m[2] === '@' || m[2] === '*') { sh.unsetVar(m[1]); continue; }
        if (v.assoc) v.assoc.delete(sh.expandWordString({ parts: [{ t: 'dq', parts: [{ t: 'text', v: m[2] }] }] }));
        else if (v.arr) { let k = Number(sh.arith(m[2])); if (k < 0) { const keys = [...v.arr.keys()].sort((x, y) => x - y); k = (keys.length ? keys[keys.length - 1] : -1) + 1 + k; } v.arr.delete(k); }
        else if (Number(sh.arith(m[2])) === 0) v.value = null;
      }
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) { err(sh, io, `unset: \`${a}': not a valid identifier`); st = 1; continue; }
    const v = sh.lookupVar(a);
    if (v) { if (v.readonly) { err(sh, io, `unset: ${a}: cannot unset: readonly variable`); st = 1; continue; } sh.unsetVar(a); }
    else sh.functions.delete(a);
  }
  return st;
}

const SET_FLAGS = { e: 'errexit', u: 'nounset', x: 'xtrace', f: 'noglob', C: 'noclobber', v: 'verbose', a: 'allexport', n: 'noexec', h: 'hashall', B: 'braceexpand', b: 'notify', m: 'monitor', T: 'functrace', E: 'errtrace', H: 'histexpand', k: 'keyword', P: 'physical', t: 'onecmd' };
const DASH_SET_O = ['errexit', 'noglob', 'ignoreeof', 'interactive', 'monitor', 'noexec', 'stdin', 'xtrace', 'verbose', 'vi', 'emacs', 'noclobber', 'allexport', 'notify', 'nounset', 'nolog', 'debug'];
const SET_O = ['allexport', 'braceexpand', 'emacs', 'errexit', 'errtrace', 'functrace', 'hashall', 'histexpand', 'history', 'ignoreeof', 'interactive-comments', 'keyword', 'monitor', 'noclobber', 'noexec', 'noglob', 'nolog', 'notify', 'nounset', 'onecmd', 'physical', 'pipefail', 'posix', 'privileged', 'verbose', 'vi', 'xtrace'];

function bSet(sh, argv, io) {
  const args = argv.slice(1);
  if (!args.length) {
    const vars = allVars(sh);
    for (const k of [...vars.keys()].sort(byteCmp)) {
      const v = vars.get(k);
      if (v.arr || v.assoc) out(sh, io, declPrint(sh, k, v).replace(/^declare \S+ /, '') + '\n');
      else if (v.value !== null) out(sh, io, `${k}=${shellQuote(v.value)}\n`);
    }
    return 0;
  }
  // each `o` in a bundle takes the next word as its option name (`set -euo pipefail`)
  const setO = (on, oname) => {
    if (sh.dash && !DASH_SET_O.includes(oname)) { err(sh, io, `set: Illegal option ${on ? '-' : '+'}o ${oname}`); return false; }
    if (!SET_O.includes(oname)) { err(sh, io, `set: ${oname}: invalid option name`); return false; }
    sh.opts[oname] = on;
    if (oname === 'allexport') sh.allexport = on;
    return true;
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--') { sh.positional = args.slice(i + 1); sh.dashOpt = { optind: 1, optoff: -1 }; return 0; }
    if (a === '-') { sh.opts.xtrace = false; sh.opts.verbose = false; sh.positional = args.slice(i + 1); sh.dashOpt = { optind: 1, optoff: -1 }; return 0; }
    if (!/^[-+]./.test(a)) { sh.positional = args.slice(i); sh.dashOpt = { optind: 1, optoff: -1 }; return 0; }
    const on = a[0] === '-';
    i++;
    for (const c of a.slice(1)) {
      if (c === 'o') {
        if (i < args.length) { if (!setO(on, args[i++])) return 2; continue; }
        if (sh.dash) {
          const list = ['errexit', 'noglob', 'ignoreeof', 'interactive', 'monitor', 'noexec', 'stdin', 'xtrace', 'verbose', 'vi', 'emacs', 'noclobber', 'allexport', 'notify', 'nounset', 'privileged', 'nolog', 'debug'];
          out(sh, io, on ? 'Current option settings\n' + list.map((o) => `${o.padEnd(16)}${sh.opts[o] ? 'on' : 'off'}\n`).join('') : list.map((o) => `set ${sh.opts[o] ? '-' : '+'}o ${o}\n`).join(''));
          continue;
        }
        for (const o of SET_O) {
          const val = !!(sh.opts[o] || (o === 'braceexpand' || o === 'hashall' || o === 'interactive-comments'));
          if (on) out(sh, io, `${o.padEnd(15)}\t${val ? 'on' : 'off'}\n`);
          else out(sh, io, `set ${val ? '-' : '+'}o ${o}\n`);
        }
        continue;
      }
      if (!SET_FLAGS[c]) {
        if (sh.dash) { err(sh, io, `set: Illegal option ${a[0]}${c}`); return 2; }
        err(sh, io, `set: ${a[0]}${c}: invalid option`); usage(sh, io, 'set'); return 2;
      }
      sh.opts[SET_FLAGS[c]] = on;
      if (c === 'a') sh.allexport = on;
    }
  }
  return 0;
}

function bShift(sh, argv, io) {
  if (sh.dash) {
    if (argv[1] !== undefined && !/^\d+$/.test(argv[1])) throw new ShellAbort(2, `shift: Illegal number: ${argv[1]}`);
    const k = argv[1] === undefined ? 1 : parseInt(argv[1], 10);
    if (k > sh.positional.length) throw new ShellAbort(2, "shift: can't shift that many");
    sh.positional = sh.positional.slice(k);
    sh.dashOpt = { optind: 1, optoff: -1 };
    return 0;
  }
  const n = argv[1] === undefined ? 1 : /^[+-]?\d+$/.test(argv[1].trim()) ? parseInt(argv[1], 10) : NaN;
  if (isNaN(n)) { err(sh, io, `shift: ${argv[1]}: numeric argument required`); return 1; }
  if (n < 0) { err(sh, io, `shift: ${argv[1]}: shift count out of range`); return 1; }
  if (n > sh.positional.length) { if (sh.dash) { err(sh, io, "shift: can't shift that many"); return 2; } return 1; }
  sh.positional = sh.positional.slice(n);
  return 0;
}

// ---------------------------------------------------------------- read / mapfile
function readInput(io, fd) {
  const s = io.fds[fd];
  return s instanceof InStream ? s : null;
}

function bRead(sh, argv, io) {
  let raw = false, arrName = null, delim = '\n', nchars = null, exact = false, fd = 0, silent = false, prompt = null;
  if (sh.dash && !dashOpts(sh, io, argv, 'p:r')) return 2;
  const o = bopts(sh, io, argv, 'ersa:d:i:n:N:p:t:u:');
  if (!o) return 2;
  for (const [k, v] of o.opts) {
    switch (k[1]) {
      case 'r': raw = true; break;
      case 's': silent = true; break;
      case 'a': arrName = v; break;
      case 'd': delim = v === '' ? '\0' : v[0]; break;
      case 'n': case 'N':
        if (!/^\d+$/.test(v)) { err(sh, io, `read: ${v}: invalid number`); return 1; }
        nchars = parseInt(v, 10); exact = k[1] === 'N'; break;
      case 'p': prompt = v; break;
      case 't': if (!/^(\d+(\.\d*)?|\.\d+)$/.test(v)) { err(sh, io, `read: ${v}: invalid timeout specification`); return 1; } break;
      case 'u':
        if (!/^\d+$/.test(v)) { err(sh, io, `read: ${v}: invalid file descriptor specification`); return 1; }
        fd = parseInt(v, 10); break;
    }
  }
  const names = [];
  let i = argv.length - o.args.length;
  for (; i < argv.length; i++) names.push(argv[i]);
  for (const n of arrName === null ? names : [arrName]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) { err(sh, io, `read: \`${n}': not a valid identifier`); return 1; }
  }
  void silent;
  const inp = readInput(io, fd);
  if (!inp) { if (fd !== 0) { err(sh, io, `read: ${fd}: invalid file descriptor: Bad file descriptor`); return 1; } return 1; }
  if (prompt !== null && sh.interactive) sh.writeFd(io, 2, prompt);
  // read the record
  let text = '';
  let gotDelim = false;
  if (inp.eof()) { assignRead(sh, names, arrName, '', raw, exact); return 1; }
  if (nchars !== null) {
    while (text.length < nchars && !inp.eof()) {
      const ch = inp.read(1);
      if (!exact && ch === delim) { gotDelim = true; break; }
      if (!raw && ch === '\\' && !inp.eof()) { const n2 = inp.read(1); if (n2 === '\n') continue; text += '\x00ESC' + n2; continue; }
      text += ch;
    }
    if (text.length >= nchars) gotDelim = true;
  } else {
    for (;;) {
      const r = inp.readUntil(delim);
      if (r === null) break;
      let t = r.text;
      if (!raw) {
        // handle backslash-newline continuation
        let bs = 0;
        for (let k = t.length - 1; k >= 0 && t[k] === '\\'; k--) bs++;
        if (r.found && delim === '\n' && bs % 2 === 1) { text += t.slice(0, -1); continue; }
      }
      text += t;
      gotDelim = r.found;
      break;
    }
  }
  if (!raw) text = text.replace(/\x00ESC(.)/g, '\\$1');
  text = text.replace(/\x00/g, '');
  assignRead(sh, names, arrName, text, raw, exact);
  return gotDelim ? 0 : 1;
}

function unbackslash(s) { return s.replace(/\\([\s\S])/g, '$1'); }

function assignRead(sh, names, arrName, text, raw, exact) {
  const ifs = sh.getVar('IFS') ?? ' \t\n';
  if (arrName) {
    const fields = splitIfs(text, ifs, raw, Infinity);
    const v = new Var(); v.arr = new Map(fields.map((f, i) => [i, f]));
    const scope = sh.findScopeFor(arrName);
    scope.set(arrName, v);
    return;
  }
  if (!names.length) { sh.setVar('REPLY', raw ? text : unbackslash(text)); return; }
  if (exact) { sh.setVar(names[0], text); for (const n of names.slice(1)) sh.setVar(n, ''); return; }
  const fields = splitIfs(text, ifs, raw, names.length);
  names.forEach((n, i) => sh.setVar(n, fields[i] ?? ''));
}

// IFS splitting for read: at most `max` fields; the last field gets the remainder.
function splitIfs(text, ifs, raw, max) {
  const isWs = (c) => (c === ' ' || c === '\t' || c === '\n') && ifs.includes(c);
  const isSep = (c) => ifs.includes(c);
  const fields = [];
  let i = 0;
  const n = text.length;
  // skip leading IFS whitespace
  while (i < n && isWs(text[i])) i++;
  while (i < n) {
    if (fields.length === max - 1) {
      // remainder: strip trailing IFS whitespace
      let rest = text.slice(i);
      let e = rest.length;
      while (e > 0 && isWs(rest[e - 1]) && !(e > 1 && rest[e - 2] === '\\' && !raw)) e--;
      rest = rest.slice(0, e);
      fields.push(raw ? rest : unbackslash(rest));
      return fields;
    }
    let f = '';
    while (i < n && !isSep(text[i])) {
      if (!raw && text[i] === '\\' && i + 1 < n) { f += text[i + 1]; i += 2; continue; }
      f += text[i++];
    }
    fields.push(f);
    // consume separator: ws* [nonws] ws*
    while (i < n && isWs(text[i])) i++;
    if (i < n && isSep(text[i]) && !isWs(text[i])) { i++; while (i < n && isWs(text[i])) i++; }
  }
  return fields;
}

function bMapfile(sh, argv, io) {
  let delim = '\n', count = 0, origin = 0, skip = 0, trim = false, fd = 0;
  let name = 'MAPFILE';
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-t') trim = true;
    else if (a === '-d') { delim = argv[++i] === '' ? '\0' : argv[i][0]; }
    else if (a === '-n') count = parseInt(argv[++i], 10);
    else if (a === '-O') origin = parseInt(argv[++i], 10);
    else if (a === '-s') skip = parseInt(argv[++i], 10);
    else if (a === '-u') fd = parseInt(argv[++i], 10);
    else if (a === '-C' || a === '-c') i++;
    else if (/^-[tdnOsu]/.test(a)) {
      const c = a[1], rest = a.slice(2);
      if (c === 't') trim = true;
      else if (c === 'd') delim = rest === '' ? '\0' : rest[0];
      else if (c === 'n') count = parseInt(rest, 10);
      else if (c === 'O') origin = parseInt(rest, 10);
      else if (c === 's') skip = parseInt(rest, 10);
      else if (c === 'u') fd = parseInt(rest, 10);
    } else { name = a; }
  }
  const inp = readInput(io, fd);
  const v = sh.lookupVar(name) && origin > 0 ? sh.lookupVar(name) : new Var();
  if (!v.arr) v.arr = new Map();
  if (!(origin > 0)) v.arr = new Map();
  let k = origin, read = 0;
  if (inp) {
    for (;;) {
      const r = inp.readUntil(delim);
      if (r === null) break;
      if (skip > 0) { skip--; continue; }
      // a bash string ends at its first NUL, so `-d ''` never keeps the delimiter
      const line = r.text + (trim || !r.found ? '' : delim), z = line.indexOf('\0');
      v.arr.set(k++, z < 0 ? line : line.slice(0, z));
      read++;
      if (count && read >= count) break;
    }
  }
  v.value = null;
  sh.findScopeFor(name).set(name, v);
  return 0;
}

// ---------------------------------------------------------------- flow
function bReturn(sh, argv, io) {
  if (sh.dash) {
    if (argv[1] !== undefined && !/^\d+$/.test(argv[1])) throw new ShellAbort(2, `return: Illegal number: ${argv[1]}`);
    const v = argv[1] === undefined ? sh.status : parseInt(argv[1], 10) & 255;
    if (!sh.funcStack.length && !sh.sourcing) throw new ExitSignal(v);   // dash: return at top level ends the script
    throw new ReturnSignal(v);
  }
  let n = argv[1] === undefined ? sh.status : /^\s*[+-]?\d+\s*$/.test(argv[1]) ? parseInt(argv[1], 10) : NaN;
  if (isNaN(n)) { err(sh, io, `return: ${argv[1]}: numeric argument required`); n = 2; }
  if (!sh.funcStack.length && !sh.sourcing) { err(sh, io, "return: can only `return' from a function or sourced script"); return 2; }
  throw new ReturnSignal(n & 255);
}

function bExit(sh, argv, io) {
  if (sh.interactive && sh.game && sh.game.onExit) { sh.game.onExit(); }
  if (sh.dash) {
    if (argv[1] !== undefined && !/^\d+$/.test(argv[1])) throw new ShellAbort(2, `exit: Illegal number: ${argv[1]}`);
    throw new ExitSignal(argv[1] === undefined ? sh.status : parseInt(argv[1], 10) & 255);
  }
  if (argv[1] !== undefined && !/^\s*[+-]?\d+\s*$/.test(argv[1])) { err(sh, io, `exit: ${argv[1]}: numeric argument required`); throw new ExitSignal(2); }
  if (argv.length > 2) { err(sh, io, 'exit: too many arguments'); throw new ExitSignal(1); }
  const n = argv[1] === undefined ? sh.status : parseInt(argv[1], 10);
  throw new ExitSignal(((n % 256) + 256) % 256);
}

function loopCtl(Sig, word) {
  return (sh, argv, io) => {
    if (sh.dash) {
      if (argv[1] !== undefined && (!/^\d+$/.test(argv[1]) || parseInt(argv[1], 10) < 1)) throw new ShellAbort(2, `${word}: Illegal number: ${argv[1]}`);
      if (!sh.loopDepth) return 0;
      throw new Sig(Math.min(argv[1] === undefined ? 1 : parseInt(argv[1], 10), sh.loopDepth));
    }
    if (!sh.loopDepth) { err(sh, io, `${word}: only meaningful in a \`for', \`while', or \`until' loop`); return 0; }
    // a non-numeric count is fatal to bash (it exits with 128)
    if (argv[1] !== undefined && !/^\s*[+-]?\d+\s*$/.test(argv[1])) throw new ShellAbort(128, `${word}: ${argv[1]}: numeric argument required`);
    const n = argv[1] === undefined ? 1 : parseInt(argv[1], 10);
    if (n < 1) { err(sh, io, `${word}: ${argv[1]}: loop count out of range`); return 1; }
    throw new Sig(Math.min(n, sh.loopDepth));
  };
}

function bEval(sh, argv, io) {
  const o = bopts(sh, io, argv, '');
  if (!o) return 2;
  const src = o.args.join(' ');
  if (!src.trim()) return 0;
  return sh.runString(src, io, { kind: 'eval' });
}

function bSource(sh, argv, io) {
  const o = bopts(sh, io, argv, '');
  if (!o) return 2;
  argv = [argv[0], ...o.args];
  const file = argv[1];
  if (file === undefined) { err(sh, io, `${argv[0]}: filename argument required`); sh.writeFd(io, 2, `${argv[0]}: usage: ${argv[0]} filename [arguments]\n`); return 2; }
  let data = null;
  const tryRead = (p) => {
    try { const n = sh.fs.stat(p, sh.cwd); if (n.type === 'f') return n.data; if (n.type === 'c') return sh.readPath(p, null); } catch {}
    return null;
  };
  if (!file.includes('/')) {
    for (const d of (sh.getVar('PATH') || '').split(':')) { data = tryRead(joinPath(d || '.', file)); if (data !== null) break; }
  }
  if (data === null) data = tryRead(file);
  if (data === null) { err(sh, io, `${file}: No such file or directory`); return 1; }
  const savedPos = sh.positional;
  if (argv.length > 2) sh.positional = argv.slice(2);
  const savedSourcing = sh.sourcing;
  sh.sourcing = true;
  try { return sh.runString(data, io, { kind: 'source', name: file }); }
  catch (e) { if (e instanceof ReturnSignal) return e.code; throw e; }
  finally { sh.sourcing = savedSourcing; if (argv.length > 2) sh.positional = savedPos; }
}

function bLet(sh, argv, io) {
  if (argv.length < 2) { err(sh, io, 'let: expression expected'); return 1; }
  let v = 0n;
  for (const a of argv.slice(1)) {
    try { v = sh.arithRaw(a); }
    catch (e) { if (e instanceof ArithError) { err(sh, io, e.text('let')); return 1; } throw e; }
  }
  return v !== 0n ? 0 : 1;
}

// ---------------------------------------------------------------- hash
// The order the shells walk their tables in. bash: 256 buckets by FNV-1 of the name, newest
// entry first within one; dash: 31 buckets by a byte sum, oldest first.
function hashOrder(sh) {
  const ents = [...sh.hashed].map(([name, h], n) => {
    let b;
    if (sh.dash) {
      let v = name.charCodeAt(0) << 4;
      for (let k = 0; k < name.length; k++) v += name.charCodeAt(k);
      b = (v & 0x7fff) % 31;
    } else {
      let v = 2166136261;
      for (let k = 0; k < name.length; k++) { const c = name.charCodeAt(k); v = (Math.imul(v, 16777619) ^ (c > 127 ? c - 256 : c)) >>> 0; }
      b = v & 255;
    }
    return { name, h, b, n };
  });
  return ents.sort((x, y) => x.b - y.b || (sh.dash ? x.n - y.n : y.n - x.n));
}
function bHash(sh, argv, io) {
  if (sh.dash) {
    let args = argv.slice(1);
    if (args.length && /^-r+$/.test(args[0])) { sh.hashed.clear(); return 0; }   // -r empties it, ignoring the rest
    if (args[0] === '--') args = args.slice(1);
    if (!args.length) { for (const e of hashOrder(sh)) out(sh, io, e.h.path + '\n'); return 0; }
    let st = 0;
    for (const n of args) {
      sh.hashed.delete(n);
      if (n.includes('/') || sh.functions.has(n) || DASH_BUILTINS.has(n)) continue;
      const f = sh.findExecutable(n);
      if (f) sh.hashed.set(n, { path: f.path, hits: 0 });
      else { err(sh, io, `hash: ${n}: not found`); st = 1; }
    }
    return st;
  }
  if (sh.opts.hashall === false) { err(sh, io, 'hash: hashing disabled'); return 1; }
  const o = bopts(sh, io, argv, 'dlp:rt');
  const names = o.args, del = o.has('-d'), portable = o.has('-l'), targets = o.has('-t');
  const pathname = o.opts.filter(([k]) => k === '-p').map(([, v]) => v).pop() ?? null;
  if (!names.length && (del || targets)) { err(sh, io, `hash: ${del ? '-d' : '-t'}: option requires an argument`); return 1; }
  if (!names.length && !o.has('-r')) {
    const ents = hashOrder(sh);
    if (!ents.length) { if (!portable && !sh.opts.posix) out(sh, io, 'hash: hash table empty\n'); return 0; }
    if (!portable) out(sh, io, 'hits\tcommand\n');
    for (const e of ents) out(sh, io, portable ? `builtin hash -p ${e.h.path} ${e.name}\n` : `${String(e.h.hits).padStart(4)}\t${e.h.path}\n`);
    return 0;
  }
  if (o.has('-r')) sh.hashed.clear();
  let st = 0;
  if (targets) {
    for (const n of names) {
      const h = sh.hashed.get(n);
      if (!h) { err(sh, io, `hash: ${n}: not found`); st = 1; continue; }
      h.hits++;
      out(sh, io, portable ? `builtin hash -p ${h.path} ${n}\n` : (names.length > 1 ? `${n}\t` : '') + h.path + '\n');
    }
    return st;
  }
  for (const n of names) {
    if (n.includes('/')) continue;
    if (pathname !== null) {
      const r = sh.fs.tryResolve(pathname, sh.cwd, {});
      if (r && r.node.type === 'd') { err(sh, io, `hash: ${pathname}: Is a directory`); st = 1; }
      else { const h = sh.hashed.get(n); if (h) { h.path = pathname; h.hits = 0; } else sh.hashed.set(n, { path: pathname, hits: 0 }); }
    } else if (del) {
      if (!sh.hashed.delete(n)) { err(sh, io, `hash: ${n}: not found`); st = 1; }
    } else if (!sh.functions.has(n) && !BUILTINS[n]) {
      sh.hashed.delete(n);
      const f = sh.findExecutable(n);
      if (f) sh.hashed.set(n, { path: f.path, hits: 0 });
      else { err(sh, io, `hash: ${n}: not found`); st = 1; }
    }
  }
  return st;
}

// ---------------------------------------------------------------- type / command
// bash's describe_command(); without -a a hashed command is reported from the table (which
// counts as a hit) instead of searching PATH
function whatIs(sh, name, { all = true } = {}) {
  const res = [];
  if (sh.aliases.has(name)) res.push({ kind: 'alias', text: `${name} is aliased to \`${sh.aliases.get(name)}'` });
  if (KEYWORD_LIST.includes(name)) res.push({ kind: 'keyword', text: `${name} is a shell keyword` });
  if (sh.functions.has(name)) res.push({ kind: 'function', text: `${name} is a function\n${deparse({ t: 'func', name, body: sh.functions.get(name) })}` });
  if (BUILTINS[name]) res.push({ kind: 'builtin', text: `${name} is a shell builtin` });
  const h = !all && !name.includes('/') && sh.opts.hashall !== false ? sh.hashed.get(name) : null;
  if (h) {
    if (!res.length) h.hits++;
    res.push({ kind: 'file', text: `${name} is hashed (${h.path})`, path: h.path });
    return res;
  }
  const PATH = sh.getVar('PATH') ?? '';
  if (name.includes('/')) {
    const r = sh.fs.tryResolve(name, sh.cwd, {});
    if (r && r.node.type === 'f' && (r.node.mode & 0o111)) res.push({ kind: 'file', text: `${name} is ${name}`, path: name });
  } else {
    for (const d of PATH.split(':')) {
      const p = joinPath(d || '.', name);
      const r = sh.fs.tryResolve(p, sh.cwd, {});
      if (r && r.node.type === 'f' && (r.node.mode & 0o111)) res.push({ kind: 'file', text: `${name} is ${p}`, path: p });
    }
  }
  return res;
}

// dash's describe_command(), for `type` (verbose) and `command -v`/`-V`. A PATH search adds
// the command to the table, unless it searched `command -p`'s default PATH.
const DASH_SPECIAL_BUILTINS = new Set(['break', 'continue', '.', 'eval', 'exec', 'exit', 'export', 'readonly', 'local', 'return', 'set', 'shift', 'times', 'trap', ':', 'unset']);
const DASH_DEFPATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
// dash's single_quote(): runs of ' go in double quotes
function dashQuote(s) {
  let o = '', i = 0;
  for (;;) {
    let j = s.indexOf("'", i);
    if (j < 0) j = s.length;
    o += `'${s.slice(i, j)}'`;
    if (j >= s.length) return o;
    let k = j;
    while (s[k] === "'") k++;
    o += `"${s.slice(j, k)}"`;
    i = k;
    if (i >= s.length) return o;
  }
}
function dashDescribe(sh, io, name, verbose, stdPath = false) {
  const say = (long, short) => { out(sh, io, (verbose ? `${name} ${long}` : short) + '\n'); return 0; };
  if (DASH_KEYWORDS.has(name)) return say('is a shell keyword', name);
  if (sh.aliases.has(name)) { const v = sh.aliases.get(name); return say(`is an alias for ${v}`, `alias ${name}=${dashQuote(v)}`); }
  const notFound = () => { if (verbose) out(sh, io, `${name}: not found\n`); return 127; };
  if (name.includes('/')) return sh.fs.tryResolve(name, sh.cwd, {}) ? say(`is ${name}`, name) : notFound();
  const h = stdPath ? null : sh.hashed.get(name);
  if (h) return say(`is a tracked alias for ${h.path}`, h.path);
  if (sh.functions.has(name)) return say('is a shell function', name);
  if (DASH_BUILTINS.has(name)) return say(`is a ${DASH_SPECIAL_BUILTINS.has(name) ? 'special ' : ''}shell builtin`, name);
  const f = sh.findExecutable(name, stdPath ? DASH_DEFPATH : undefined);
  if (!f) return notFound();
  if (!stdPath) sh.hashed.set(name, { path: f.path, hits: 0 });
  return say(`is ${f.path}`, f.path);
}

function bType(sh, argv, io) {
  if (sh.dash) {
    let st = 0;
    for (const n of argv.slice(1)) st |= dashDescribe(sh, io, n, true);
    return st;
  }
  const o = bopts(sh, io, argv, 'afptP');
  if (!o) return 2;
  const opts = new Set(o.opts.map(([k]) => k[1]));
  const names = o.args;
  let st = 0;
  for (const n of names) {
    let res = whatIs(sh, n, { all: opts.has('a') });
    if (opts.has('f')) res = res.filter(r => r.kind !== 'function');
    if (opts.has('P')) res = res.filter(r => r.kind === 'file');
    if (!res.length) { if (!opts.has('t') && !opts.has('p') && !opts.has('P')) err(sh, io, `type: ${n}: not found`); st = 1; continue; }
    const list = opts.has('a') ? res : [res[0]];
    for (const r of list) {
      if (opts.has('t')) out(sh, io, r.kind + '\n');
      else if (opts.has('p') || opts.has('P')) { if (r.kind === 'file') out(sh, io, r.path + '\n'); }
      else out(sh, io, r.text + '\n');
    }
  }
  return st;
}

function bCommand(sh, argv, io) {
  let i = 1, v = false, V = false;
  while (i < argv.length && /^-[pvV]+$/.test(argv[i])) { if (argv[i].includes('v')) v = true; if (argv[i].includes('V')) V = true; i++; }
  if (argv[i] === '--') i++;
  const rest = argv.slice(i);
  if (!rest.length) return 0;
  if (v || V) {
    if (sh.dash) return dashDescribe(sh, io, rest[0], V, argv.slice(1, i).some(a => a.includes('p')));
    let st = 0;
    for (const n of rest) {
      const res = whatIs(sh, n, { all: false });
      if (!res.length) { if (V) err(sh, io, `command: ${n}: not found`); st = 1; continue; }
      const r = res[0];
      if (V) out(sh, io, r.text + '\n');
      else out(sh, io, (r.kind === 'file' ? r.path : r.kind === 'alias' ? `alias ${n}='${sh.aliases.get(n)}'` : n) + '\n');
    }
    return st;
  }
  return sh.invoke(rest, io, null, { noFunc: true });
}

function bBuiltin(sh, argv, io) {
  const name = argv[1];
  if (!name) return 0;
  if (!BUILTINS[name]) { err(sh, io, `builtin: ${name}: not a shell builtin`); return 1; }
  return BUILTINS[name](sh, argv.slice(1), io);
}

// ---------------------------------------------------------------- shopt / alias
const SHOPT_ALL = ['autocd', 'assoc_expand_once', 'cdable_vars', 'cdspell', 'checkhash', 'checkjobs', 'checkwinsize', 'cmdhist', 'compat31', 'compat32', 'compat40', 'compat41', 'compat42', 'compat43', 'compat44', 'complete_fullquote', 'direxpand', 'dirspell', 'dotglob', 'execfail', 'expand_aliases', 'extdebug', 'extglob', 'extquote', 'failglob', 'force_fignore', 'globasciiranges', 'globstar', 'gnu_errfmt', 'histappend', 'histreedit', 'histverify', 'hostcomplete', 'huponexit', 'inherit_errexit', 'interactive_comments', 'lastpipe', 'lithist', 'localvar_inherit', 'localvar_unset', 'login_shell', 'mailwarn', 'no_empty_cmd_completion', 'nocaseglob', 'nocasematch', 'nullglob', 'progcomp', 'progcomp_alias', 'promptvars', 'restricted_shell', 'shift_verbose', 'sourcepath', 'xpg_echo'];
function bShopt(sh, argv, io) {
  let mode = null, quiet = false, oMode = false, printMode = false;
  const names = [];
  for (const a of argv.slice(1)) {
    if (/^-[squpo]+$/.test(a)) { for (const c of a.slice(1)) { if (c === 's') mode = true; if (c === 'u') mode = false; if (c === 'q') quiet = true; if (c === 'o') oMode = true; if (c === 'p') printMode = true; } continue; }
    names.push(a);
  }
  const val = (n) => { if (oMode) return !!sh.opts[n]; if (sh.shopt[n] !== undefined) return !!sh.shopt[n]; return ['cmdhist', 'complete_fullquote', 'extquote', 'force_fignore', 'hostcomplete', 'interactive_comments', 'progcomp', 'promptvars', 'sourcepath', 'checkwinsize'].includes(n); };
  if (mode !== null && names.length) {
    for (const n of names) {
      if (!oMode && !SHOPT_ALL.includes(n)) { err(sh, io, `shopt: ${n}: invalid shell option name`); return 1; }
      if (oMode) sh.opts[n] = mode; else sh.shopt[n] = mode;
    }
    return 0;
  }
  const list = names.length ? names : SHOPT_ALL;
  let st = 0;
  for (const n of list) {
    if (!SHOPT_ALL.includes(n) && !oMode) { err(sh, io, `shopt: ${n}: invalid shell option name`); st = 1; continue; }
    const v = val(n);
    if (mode !== null && v !== mode && !names.length) continue;
    if (!v) st = names.length ? 1 : st;
    if (quiet) continue;
    if (printMode) out(sh, io, `shopt ${v ? '-s' : '-u'} ${n}\n`);
    else out(sh, io, `${n.padEnd(15)}\t${v ? 'on' : 'off'}\n`);
  }
  return st;
}

function bAlias(sh, argv, io) {
  const args = argv.slice(1).filter(a => a !== '-p');
  if (!args.length) { for (const k of [...sh.aliases.keys()].sort(byteCmp)) out(sh, io, `${sh.dash ? '' : 'alias '}${k}='${sh.aliases.get(k)}'\n`); return 0; }
  let st = 0;
  for (const a of args) {
    const i = a.indexOf('=');
    if (i > 0) sh.aliases.set(a.slice(0, i), a.slice(i + 1));
    else if (sh.aliases.has(a)) out(sh, io, `alias ${a}='${sh.aliases.get(a)}'\n`);
    else { err(sh, io, `alias: ${a}: not found`); st = 1; }
  }
  return st;
}

function bUnalias(sh, argv, io) {
  let st = 0;
  for (const a of argv.slice(1)) {
    if (a === '-a') { sh.aliases.clear(); continue; }
    if (!sh.aliases.delete(a)) { err(sh, io, `unalias: ${a}: not found`); st = 1; }
  }
  return st;
}

// ---------------------------------------------------------------- getopts
// dash's getopts(): where it has got to lives in the shell (an argument index and an offset
// into that word); OPTIND is only told the index, after the whole word has been taken
function dashGetopts(sh, argv, io) {
  const st = sh.dashOpt, optstr = argv[1], optvar = argv[2];
  const base = argv.length === 3 ? sh.positional : argv.slice(3);
  if (st.optind > base.length + 1) { st.optind = 1; st.optoff = -1; }
  const ind = st.optind, off = st.optoff;
  let next = ind - 1, w = -1, o = 0, c = '?', done = false;   // w/o: the word and offset being read
  if (!(ind <= 1 || off < 0 || base[next - 1].length < off)) { w = next - 1; o = off; }
  out: {
    if (w < 0 || o >= base[w].length) {
      const word = base[next];
      if (word === undefined || word[0] !== '-' || word.length === 1) { w = -1; done = true; break out; }
      next++;
      w = next - 1; o = 1;
      if (word === '--') { w = -1; done = true; break out; }
    }
    const word = base[w];
    c = word[o++];
    let q = 0;
    for (;;) {
      if (q >= optstr.length) {
        if (optstr[0] === ':') sh.setVar('OPTARG', c);
        else { sh.writeFd(io, 2, `Illegal option -${c}\n`); sh.unsetVar('OPTARG'); }
        c = '?';
        break out;
      }
      if (optstr[q] === c) break;
      if (optstr[++q] === ':') q++;
    }
    if (optstr[q + 1] === ':') {
      let arg;
      if (o >= word.length) {
        if (base[next] === undefined) {
          if (optstr[0] === ':') { sh.setVar('OPTARG', c); c = ':'; }
          else { sh.writeFd(io, 2, `No arg for -${c} option\n`); sh.unsetVar('OPTARG'); c = '?'; }
          w = -1;
          break out;
        }
        arg = base[next++];
      } else arg = word.slice(o);
      sh.setVar('OPTARG', arg);
      w = -1;
    } else sh.setVar('OPTARG', '');
  }
  sh.setVar('OPTIND', String(next + 1));
  sh.setVar(optvar, c);
  sh.dashOpt = { optind: next + 1, optoff: w < 0 ? -1 : o };
  return done ? 1 : 0;
}

function bGetopts(sh, argv, io) {
  if (sh.dash && argv.length >= 3) return dashGetopts(sh, argv, io);
  const o = bopts(sh, io, argv, '');
  if (!o) return 2;
  const [spec, name] = o.args;
  if (spec === undefined || name === undefined) { if (sh.dash) err(sh, io, 'getopts: Usage: getopts optstring var [arg]'); else usage(sh, io, 'getopts'); return 2; }
  const args = o.args.length > 2 ? o.args.slice(2) : sh.positional;
  const silent = spec.startsWith(':');
  let optind = parseInt(sh.getVar('OPTIND') || '1', 10);
  if (optind < 1) optind = 1;
  if (sh.getoptsLast !== optind) sh.getoptsPos = 1;
  const arg = args[optind - 1];
  if (arg === undefined || !arg.startsWith('-') || arg === '-') { sh.setVar(name, '?'); sh.setVar('OPTIND', String(optind)); return 1; }
  if (arg === '--') { sh.setVar(name, '?'); sh.setVar('OPTIND', String(optind + 1)); return 1; }
  let pos = sh.getoptsPos || 1;
  const c = arg[pos];
  const idx = spec.indexOf(c);
  const advance = () => { pos++; if (pos >= arg.length) { optind++; pos = 1; } sh.getoptsPos = pos; sh.setVar('OPTIND', String(optind)); sh.getoptsLast = optind; };
  if (idx < 0 || c === ':') {
    if (silent) { sh.setVar('OPTARG', c); } else { sh.writeFd(io, 2, sh.dash ? `Illegal option -${c}\n` : `${sh.arg0}: illegal option -- ${c}\n`); sh.unsetVar('OPTARG'); }
    sh.setVar(name, '?');
    advance();
    return 0;
  }
  if (spec[idx + 1] === ':') {
    let optarg;
    if (pos + 1 < arg.length) { optarg = arg.slice(pos + 1); optind++; pos = 1; }
    else {
      optarg = args[optind];
      if (optarg === undefined) {
        if (silent) { sh.setVar(name, ':'); sh.setVar('OPTARG', c); }
        else { sh.writeFd(io, 2, sh.dash ? `No arg for -${c} option\n` : `${sh.arg0}: option requires an argument -- ${c}\n`); sh.setVar(name, '?'); sh.unsetVar('OPTARG'); }
        optind++; pos = 1;
        sh.getoptsPos = pos; sh.setVar('OPTIND', String(optind)); sh.getoptsLast = optind;
        return 0;
      }
      optind += 2; pos = 1;
    }
    sh.setVar('OPTARG', optarg);
    sh.setVar(name, c);
    sh.getoptsPos = pos; sh.setVar('OPTIND', String(optind)); sh.getoptsLast = optind;
    return 0;
  }
  sh.setVar(name, c);
  sh.unsetVar('OPTARG');
  advance();
  return 0;
}

// ---------------------------------------------------------------- trap / kill / jobs
const trapName = (k, dash) => (SIGNALS.includes(k) && !dash ? 'SIG' + k : k);
function bTrap(sh, argv, io) {
  if (sh.dash && !dashOpts(sh, io, argv, '')) return 2;
  const o = bopts(sh, io, argv, 'lp');
  if (!o) return 2;
  let args = o.args;
  if (o.has('-l')) { out(sh, io, killList()); return 0; }
  if (!args.length || o.has('-p')) {
    const want = args.length ? new Set(args.map((a) => { let n = a.toUpperCase().replace(/^SIG/, ''); if (/^\d+$/.test(n)) n = n === '0' ? 'EXIT' : SIGNALS[parseInt(n, 10) - 1] || n; return n; })) : null;
    for (const [k, v] of sh.traps) if (!want || want.has(k)) out(sh, io, `trap -- ${shellQuote(v, true)} ${trapName(k, sh.dash)}\n`);
    return 0;
  }
  let action = args[0];
  let sigs = args.slice(1);
  if (signalNumber(action) >= 0 && /^(\d+|[A-Za-z]+)$/.test(action) && sigs.length === 0) { sigs = [action]; action = '-'; }
  for (const s of sigs) {
    let name = s.toUpperCase().replace(/^SIG/, '');
    if (name === '0') name = 'EXIT';
    if (/^\d+$/.test(name)) name = SIGNALS[parseInt(name, 10) - 1] || name;
    if (!['EXIT', 'ERR', 'DEBUG', 'RETURN'].includes(name) && SIGNALS.indexOf(name) < 0) { err(sh, io, `trap: ${s}: invalid signal specification`); return 1; }
    if (action === '-') sh.traps.delete(name);
    else sh.traps.set(name, action);
  }
  return 0;
}

// the signal names Linux has, including the real-time ones bash lists as SIGRTMIN+n / SIGRTMAX-n
function signalName(n) {
  if (n >= 1 && n <= 31) return 'SIG' + SIGNALS[n - 1];
  if (n >= 34 && n <= 64) return n === 34 ? 'SIGRTMIN' : n === 64 ? 'SIGRTMAX' : n <= 49 ? `SIGRTMIN+${n - 34}` : `SIGRTMAX-${64 - n}`;
  return null;
}
function killList() {
  let s = '', col = 0;
  for (let n = 1; n <= 64; n++) {
    const name = signalName(n);
    if (!name) continue;
    s += `${String(n).padStart(2)}) ${name}`;
    if (++col < 5) s += '\t'; else { s += '\n'; col = 0; }
  }
  return col ? s + '\n' : s;
}

// dash's kill -l: one name per line, numbers for signals it has no name for
function dashKillName(n) { if (n === 0) return '0'; const nm = signalName(n); return nm && n !== 16 ? nm.slice(3) : String(n); }
export function doKill(sh, args, io, errFn) {
  let sig = 15;
  let i = 0;
  if (sh.dash && (args[0] === '-l' || args[0] === '-L')) {
    if (args[1] === undefined) { let t = ''; for (let n = 0; n <= 64; n++) t += dashKillName(n) + '\n'; out(sh, io, t); return 0; }
    for (const a of args.slice(1)) {
      if (/^\d+$/.test(a)) {
        let n = parseInt(a, 10);
        if (n > 128) n -= 128;
        if (n < 1 || n > 64) { errFn(`invalid signal number or exit status: ${a}`); return 2; }
        out(sh, io, dashKillName(n) + '\n');
      } else { errFn(`Illegal number: ${a}`); return 2; }
    }
    return 0;
  }
  if (sh.dash && (args[0] === '-s') && args[1] === undefined) { errFn('No arg for -s option'); return 2; }
  if (args[0] === '-l' || args[0] === '-L') {
    if (args[1] === undefined) { out(sh, io, killList()); return 0; }
    for (const a of args.slice(1)) {
      if (/^\d+$/.test(a)) {
        const n = parseInt(a, 10) > 128 ? parseInt(a, 10) - 128 : parseInt(a, 10);
        const nm = signalName(n);
        if (!nm) { errFn(`${a}: invalid signal specification`); return 1; }
        out(sh, io, nm.slice(3) + '\n');
      }
      else { const n = signalNumber(a); if (n < 0) { errFn(`${a}: invalid signal specification`); return 1; } out(sh, io, n + '\n'); }
    }
    return 0;
  }
  let spec = null;
  if (args[0] === '-s' || args[0] === '-n') {
    if (args[1] === undefined) { errFn(`${args[0]}: option requires an argument`); return 2; }
    spec = args[1]; sig = signalNumber(spec); i = 2;
  } else if (args[0] && /^-./.test(args[0]) && args[0] !== '--') { spec = args[0].slice(1); sig = signalNumber(spec); i = 1; }
  if (args[i] === '--') i++;
  if (sig < 0 || sig > 64) { errFn(`${spec}: invalid signal specification`); return 1; }
  const pids = args.slice(i);
  if (!pids.length) { if (sh.dash) errFn('Usage: kill [-s sigspec | -signum | -sigspec] [pid | job]... or\nkill -l [exitstatus]'); else usage(sh, io, 'kill'); return 2; }
  let st = 0;
  for (const p of pids) {
    if (p.startsWith('%')) { errFn(`${p}: no such job`); st = 1; continue; }
    if (!/^-?\d+$/.test(p)) { errFn(`${p}: arguments must be process or job IDs`); st = 1; continue; }
    const pid = parseInt(p, 10);
    if (pid === sh.pid) { if (sig === 0) continue; if (sig === 9 || sig === 15 || sig === 2 || sig === 1) throw new ExitSignal(128 + sig); continue; }
    if (!sh.procs.has(pid) && pid !== 1) { errFn(`(${pid}) - No such process`); st = 1; continue; }
    if (sig === 0) continue;
    if (pid === 1) continue;
    const pr = sh.procs.get(pid);
    if (sig === 19 || sig === 20) { pr.state = 'T'; continue; }
    if (sig === 18) { pr.state = 'S'; continue; }
    sh.procs.delete(pid);
    try { sh.fs.root.entries.get('proc').entries.delete(String(pid)); } catch {}
  }
  return st;
}

function bKill(sh, argv, io) {
  return doKill(sh, argv.slice(1), io, (m) => err(sh, io, `kill: ${m}`));
}

// ---------------------------------------------------------------- exec / misc
function bExec(sh, argv, io) {
  const args = argv.slice(1).filter((a, i) => !(i === 0 && /^-[cl]+$/.test(a)));
  if (!args.length) return 0;
  const st = sh.invoke(args, io, null, { noFunc: true });
  throw new ExitSignal(st);
}

function bUmask(sh, argv, io) {
  const a = argv.slice(1).filter(x => x !== '-S');
  if (!a.length) {
    if (argv.includes('-S')) { const m = (~sh.fs.umask) & 0o777; const f = (b) => (m & (4 << b) ? 'r' : '') + (m & (2 << b) ? 'w' : '') + (m & (1 << b) ? 'x' : ''); out(sh, io, `u=${f(6)},g=${f(3)},o=${f(0)}\n`); }
    else out(sh, io, sh.fs.umask.toString(8).padStart(4, '0') + '\n');
    return 0;
  }
  if (/^[0-7]+$/.test(a[0])) { sh.fs.umask = parseInt(a[0], 8) & 0o777; return 0; }
  err(sh, io, `umask: ${a[0]}: invalid symbolic mode operator`);
  return 1;
}


// bash's glob_pattern_p: would this word glob? (a '[' needs a later ']')
function globPatternP(s) {
  let open = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*' || c === '?') return true;
    if (c === '[') open++;
    else if (c === ']') { if (open) return true; }
    else if ((c === '+' || c === '@' || c === '!') && s[i + 1] === '(') return true;
    else if (c === '\\') return i + 1 < s.length;
  }
  return false;
}

// bash 5.1's help builtin over its real texts (src/engine/bashhelp.js): exact names and glob
// matches first, prefix matches only when those find nothing
function bHelp(sh, argv, io) {
  let i = 1;
  const fl = new Set();
  for (; i < argv.length && /^-[dms]+$/.test(argv[i]); i++) for (const c of argv[i].slice(1)) fl.add(c);
  if (argv[i] === '--') i++;
  const pats = argv.slice(i);
  if (!pats.length) { out(sh, io, HELP_LIST); return 0; }
  const ind = (t) => t.split('\n').map(l => '    ' + l + '\n').join('');
  const firstLine = (n) => HELP_DOCS[n][1].split('\n')[0];
  let text = '', found = 0;
  if (globPatternP(pats[0])) text += `Shell commands matching keyword${pats.length > 1 ? 's' : ''} \`${pats.join(', ')}'\n\n`;
  for (const pat of pats) {
    let hits = HELP_TOPICS.filter(n => n === pat || fnmatch(pat, n, { extglob: true }));
    if (!hits.length) hits = HELP_TOPICS.filter(n => n.startsWith(pat));
    for (const n of hits) {
      const [syn, body] = HELP_DOCS[n];
      found++;
      if (fl.has('d')) text += `${n} - ${firstLine(n)}\n`;
      else if (fl.has('m')) text += `NAME\n    ${n} - ${firstLine(n)}\n\nSYNOPSIS\n    ${syn}\n\nDESCRIPTION\n${ind(body)}\nSEE ALSO\n    bash(1)\n\nIMPLEMENTATION\n    GNU bash, version 5.1.16(1)-release (x86_64-pc-linux-gnu)\n    Copyright (C) 2020 Free Software Foundation, Inc.\n    License GPLv3+: GNU GPL version 3 or later <http://gnu.org/licenses/gpl.html>\n\n`;
      else text += `${n}: ${syn}\n` + (fl.has('s') ? '' : ind(body));
    }
  }
  out(sh, io, text);
  if (!found) {
    const p = pats[pats.length - 1];
    err(sh, io, `help: no help topics match \`${p}'.  Try \`help help' or \`man -k ${p}' or \`info ${p}'.`);
    return 1;
  }
  return 0;
}

function bHistory(sh, argv, io) {
  if (argv[1] === '-c') { sh.history.length = 0; return 0; }
  sh.history.forEach((h, i) => out(sh, io, `${String(i + 1).padStart(5)}  ${h}\n`));
  return 0;
}

// bash 5.1's builtin table (alphabetical, as `compgen -b` and `enable` list it)
const BASH_BUILTINS = ['.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'complete', 'compopt', 'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait'];
const SET_O_NAMES = ['allexport', 'braceexpand', 'emacs', 'errexit', 'errtrace', 'functrace', 'hashall', 'histexpand', 'history', 'ignoreeof', 'interactive-comments', 'keyword', 'monitor', 'noclobber', 'noexec', 'noglob', 'nolog', 'notify', 'nounset', 'onecmd', 'physical', 'pipefail', 'posix', 'privileged', 'verbose', 'vi', 'xtrace'];
const COMPGEN_ACTIONS = { alias: 'a', arrayvar: 'arrayvar', binding: 'binding', builtin: 'b', command: 'c', directory: 'd', disabled: 'disabled', enabled: 'enabled', export: 'e', file: 'f', function: 'function', group: 'g', helptopic: 'helptopic', hostname: 'hostname', job: 'j', keyword: 'k', running: 'running', service: 's', setopt: 'setopt', shopt: 'shopt', signal: 'signal', stopped: 'stopped', user: 'u', variable: 'v' };
// the order gen_action_completions tries them in
const COMPGEN_ORDER = ['a', 'arrayvar', 'binding', 'b', 'c', 'd', 'disabled', 'enabled', 'e', 'f', 'function', 'g', 'helptopic', 'hostname', 'j', 'k', 'running', 's', 'setopt', 'shopt', 'signal', 'stopped', 'u', 'v'];

function bCompgen(sh, argv, io) {
  const args = argv.slice(1);
  const acts = new Set();
  let glob = null, words = null, filter = null, pre = '', suf = '', text = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { text = args[i + 1] ?? ''; break; }
    if (a[0] !== '-' || a === '-') { text = a; break; }
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      if ('AGWFCXPSo'.includes(c)) {
        const v = j + 1 < a.length ? a.slice(j + 1) : args[++i] ?? '';
        if (c === 'A') {
          if (!COMPGEN_ACTIONS[v]) { err(sh, io, `compgen: ${v}: invalid action name`); return 2; }
          acts.add(COMPGEN_ACTIONS[v]);
        } else if (c === 'G') glob = v;
        else if (c === 'W') words = v;
        else if (c === 'X') filter = v;
        else if (c === 'P') pre = v;
        else if (c === 'S') suf = v;
        break;
      }
      acts.add(c);
    }
  }
  const starts = (x) => x.startsWith(text);
  const sorted = (xs) => [...xs].sort(byteCmp);
  const res = [];
  const fsList = (dirsOnly) => {
    // readline's filename completion walks the directory in readdir (creation) order
    const slash = text.lastIndexOf('/');
    const dir = slash >= 0 ? text.slice(0, slash + 1) : '', base = text.slice(slash + 1);
    let node;
    try { node = sh.fs.stat(dir || '.', sh.cwd); } catch { return; }
    if (!node.entries) return;
    for (const n of node.entries.keys()) {
      if (n === '.' || n === '..' || !n.startsWith(base)) continue;
      if (dirsOnly) { try { if (sh.fs.stat(dir + n, sh.cwd).type !== 'd') continue; } catch { continue; } }
      res.push(dir + n);
    }
  };
  const vars = () => { const m = new Map(); for (const sc of sh.scopes) for (const [k, v] of sc) m.set(k, v); return m; };
  const lines = (path) => { try { return sh.fs.readFile(path, '/').split('\n').filter(l => l && l[0] !== '#'); } catch { return []; } };
  for (const k of COMPGEN_ORDER) {
    if (!acts.has(k)) continue;
    if (k === 'a') res.push(...sorted(sh.aliases.keys()).filter(starts));
    else if (k === 'arrayvar') res.push(...sorted([...vars()].filter(([, v]) => v.arr || v.assoc).map(([n]) => n)).filter(starts));
    else if (k === 'b' || k === 'helptopic' || k === 'enabled') res.push(...BASH_BUILTINS.filter(starts));
    else if (k === 'c') {
      res.push(...sorted(sh.aliases.keys()).filter(starts), ...KEYWORD_LIST.filter(starts), ...sorted(sh.functions.keys()).filter(starts), ...BASH_BUILTINS.filter(starts));
      for (const d of (sh.getVar('PATH') || '').split(':')) {
        let node;
        try { node = sh.fs.stat(d || '.', sh.cwd); } catch { continue; }
        if (node.entries) for (const n of node.entries.keys()) if (starts(n)) res.push(n);
      }
    } else if (k === 'd') fsList(true);
    else if (k === 'e') res.push(...sorted([...vars()].filter(([, v]) => v.exported).map(([n]) => n)).filter(starts));
    else if (k === 'f') fsList(false);
    else if (k === 'function') res.push(...sorted(sh.functions.keys()).filter(starts));
    else if (k === 'g') res.push(...lines('/etc/group').map(l => l.split(':')[0]).filter(starts));
    else if (k === 'hostname') res.push(...lines('/etc/hosts').flatMap(l => l.trim().split(/\s+/).slice(1)).filter(starts));
    else if (k === 'k') res.push(...KEYWORD_LIST.filter(starts));
    else if (k === 'setopt') res.push(...SET_O_NAMES.filter(starts));
    else if (k === 'shopt') res.push(...Object.keys(sh.shopt).sort(byteCmp).filter(starts));
    else if (k === 'signal') res.push(...SIGNALS.map(n => 'SIG' + n).filter(starts));
    else if (k === 'u') res.push(...lines('/etc/passwd').map(l => l.split(':')[0]).filter(starts));
    else if (k === 'v') res.push(...sorted(vars().keys()).filter(starts));
  }
  if (glob !== null) {
    // glob_filename without the sort a command line gets: each directory comes back newest entry first
    const order = (p) => {
      const key = [];
      let dir = p.startsWith('/') ? '/' : '.';
      for (const c of p.split('/')) {
        if (!c) continue;
        let ix = 0;
        try { const n = sh.fs.stat(dir, sh.cwd); if (n.entries) ix = [...n.entries.keys()].indexOf(c); } catch {}
        key.push(-ix);
        dir = dir === '/' ? '/' + c : dir + '/' + c;
      }
      return key;
    };
    const ms = sh.glob(glob).map(m => ({ m, k: order(m) }));
    ms.sort((x, y) => { for (let i = 0; i < Math.max(x.k.length, y.k.length); i++) { const d = (x.k[i] ?? 1) - (y.k[i] ?? 1); if (d) return d; } return 0; });
    res.push(...ms.map(x => x.m));
  }
  if (words !== null) {
    // split like the shell would, then expand everything except pathnames
    const p = new Parser(words);
    const ws = [];
    for (;;) { p.skipBlanks(); while (p.s[p.i] === '\n') { p.i++; p.skipBlanks(); } if (p.i >= p.s.length) break; const w = p.readWord('normal'); if (!w) { p.i++; continue; } ws.push(w); }
    const saved = sh.opts.noglob;
    sh.opts.noglob = true;
    try { res.push(...sh.expandWords(ws).filter(starts)); } finally { sh.opts.noglob = saved; }
  }
  let outList = res;
  if (filter !== null) {
    const neg = filter[0] === '!';
    const pat = (neg ? filter.slice(1) : filter).replace(/(^|[^\\])&/g, (m, b) => b + text).replace(/\\&/g, '&');
    outList = outList.filter(x => fnmatch(pat, x, { extglob: sh.shopt.extglob }) === neg);
  }
  if (!outList.length) return 1;
  out(sh, io, outList.map(x => pre + x + suf + '\n').join(''));
  return 0;
}

const noop = () => 0;

export const BUILTINS = {
  ':': noop,
  true: noop,
  false: () => 1,
  echo: bEcho,
  printf: bPrintf,
  cd: checked('eLP@', bCd),
  pwd: bPwd,
  pushd: bPushd,
  popd: bPopd,
  dirs: bDirs,
  export: checked('fnp', bDeclare),
  readonly: checked('aAfnp', bDeclare),
  declare: checked('aAfFgiIlnprtux', bDeclare, { plus: true }),
  typeset: checked('aAfFgiIlnprtux', bDeclare, { plus: true }),
  local: (sh, argv, io) => (!sh.funcStack.length || bopts(sh, io, argv, 'aAfFgiIlnprtux', { plus: true }) ? bDeclare(sh, argv, io) : 2),
  unset: checked('fnv', bUnset),
  set: bSet,
  shift: bShift,
  read: bRead,
  mapfile: checked('d:u:n:O:tC:c:s:', bMapfile),
  readarray: checked('d:u:n:O:tC:c:s:', bMapfile),
  return: bReturn,
  exit: bExit,
  logout: (sh, argv, io) => { err(sh, io, "logout: not login shell: use `exit'"); return 1; },
  break: loopCtl(BreakSignal, 'break'),
  continue: loopCtl(ContinueSignal, 'continue'),
  eval: bEval,
  source: bSource,
  '.': bSource,
  test: bTest,
  '[': bTest,
  let: bLet,
  type: bType,
  command: checked('pVv', bCommand),
  builtin: checked('', bBuiltin),
  hash: checked('dlp:rt', bHash),
  shopt: checked('opqsu', bShopt),
  alias: checked('p', bAlias),
  unalias: checked('a', bUnalias),
  getopts: bGetopts,
  trap: bTrap,
  kill: bKill,
  wait: checked('fnp:', (sh, argv, io) => {
    const ids = argv.slice(1).filter((a) => !/^-[fnp]/.test(a));
    if (argv.slice(1).some((a) => /^-[a-z]*n/.test(a))) return 127;
    let st = 0;
    for (const id of ids) {
      if (id.startsWith('%')) { err(sh, io, `wait: ${id}: no such job`); st = 127; continue; }
      if (!/^\d+$/.test(id)) { err(sh, io, `wait: \`${id}': not a pid or valid job spec`); st = 2; continue; }
      if (id !== sh.lastBg) { if (!sh.dash) err(sh, io, `wait: pid ${id} is not a child of this shell`); st = 127; }
    }
    return st;
  }),
  jobs: noop,
  disown: checked('ahr', noop),
  fg: (sh, argv, io) => { err(sh, io, 'fg: no job control'); return 1; },
  bg: (sh, argv, io) => { err(sh, io, 'bg: no job control'); return 1; },
  suspend: checked('f', (sh, argv, io) => { err(sh, io, 'suspend: cannot suspend a login shell'); return 1; }),
  exec: checked('a:cl', bExec),
  times: checked('', (sh, argv, io) => { out(sh, io, sh.dash ? '0m0.000000s 0m0.000000s\n0m0.000000s 0m0.000000s\n' : '0m0.004s 0m0.001s\n0m0.000s 0m0.000s\n'); return 0; }),
  umask: checked('pS', bUmask),
  ulimit: (sh, argv, io) => { if (!argv.slice(1).some(a => /^-?[0-9]+$/.test(a) || a === 'unlimited')) out(sh, io, (argv.includes('-n') ? '1048576' : 'unlimited') + '\n'); return 0; },
  help: checked('dms', bHelp),
  history: checked('acd:nprsw', bHistory),
  enable: checked('adnpsf:', noop),
  caller: () => 1,
  compgen: checked('abcdefgjksuvo:A:G:W:F:C:X:P:S:', bCompgen),
  complete: checked('abcdefgjksuvprDEIo:A:G:W:F:C:X:P:S:', noop),
  compopt: noop,
  bind: noop,
  fc: checked('e:lnrs', (sh, argv, io) => { err(sh, io, 'fc: history specification out of range'); return 1; }),
};
