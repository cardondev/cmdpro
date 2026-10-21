// The CMDPRO bash interpreter.
import { Parser, ParseError, isName, wordLiteral, parseSubscript, DASH_KEYWORDS } from './parser.js';
import { helpText } from './commands/man.js';
import { VFS, FsError, joinPath, normPath, basename as pbase, byteCmp, ELF_HEADER } from './vfs.js';
import { InStream, FileInStream, OutBuf, NullSink, FileSink, PipeLimit, ExecLimit, ExitSignal, ReturnSignal, BreakSignal, ContinueSignal, ShellAbort } from './streams.js';
import { evalArith, ArithError, evalDashArith, DashArithError } from './arith.js';
import { globRegex, hasGlob, unescapeGlob, posixToJs, fnmatch } from './pattern.js';
import { BUILTINS, SPECIAL_BUILTINS, shellQuote } from './builtins.js';
import { wordSrc } from './deparse.js';

const DEFAULT_IFS = ' \t\n';
const GLOB_SPECIAL = new Set(['*', '?', '[', ']', '\\', '(', ')', '|', '+', '@', '!']);
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done', 'in', 'function', 'time', '{', '}', '!', '[[', ']]', 'coproc']);

export class Var {
  constructor(value = null) { this.value = value; this.arr = null; this.assoc = null; this.exported = false; this.readonly = false; this.integer = false; this.lower = false; this.upper = false; }
  clone() {
    const v = new Var(this.value);
    if (this.arr) v.arr = new Map(this.arr);
    if (this.assoc) v.assoc = new Map(this.assoc);
    v.exported = this.exported; v.readonly = this.readonly; v.integer = this.integer; v.lower = this.lower; v.upper = this.upper; v.nameref = this.nameref; v.invisible = this.invisible;
    return v;
  }
}

function sortedKeys(map) { return [...map.keys()].sort((a, b) => a - b); }

// bash keeps associative arrays in a 1024-bucket hash table (hashlib.c): FNV-1 over the key's
// bytes (as signed chars), new keys pushed on the front of their bucket, buckets walked in order.
// A Map's insertion order is exactly that history (updates stay put, unset + re-add moves to the end).
function bashHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 16777619) ^ (c >= 0x80 ? c - 256 : c);
  }
  return h >>> 0;
}
export function assocKeys(map) {
  const ks = [...map.keys()].map((k, i) => ({ k, i, b: bashHash(k) & 1023 }));
  ks.sort((x, y) => x.b - y.b || y.i - x.i);
  return ks.map(x => x.k);
}

// commands whose own --help output we reproduce (everything else gets a man-page summary)
let ZERO_DEV = null;
// `set -o` option names in bash's order (SHELLOPTS lists the ones that are on)
const SHELLOPTS_LIST = ['allexport', 'braceexpand', 'emacs', 'errexit', 'errtrace', 'functrace', 'hashall', 'histexpand', 'history', 'ignoreeof', 'interactive-comments', 'keyword', 'monitor', 'noclobber', 'noexec', 'noglob', 'nolog', 'notify', 'nounset', 'onecmd', 'physical', 'pipefail', 'posix', 'privileged', 'verbose', 'vi', 'xtrace'];
const zeroDev = () => (ZERO_DEV ??= '\0'.repeat(1 << 24));
const NATIVE_HELP = new Set(['sed', 'man', 'bash', 'sh', 'jq', 'awk', 'gawk', 'nawk', 'mawk', 'bc', 'split', 'column', 'tree']);

// bash printable_filename(): names with unprintable bytes are shown $'...'-quoted (C locale)
function printableName(s) {
  if (!/[\x00-\x1f\x7f-\xff]/.test(s)) return s;
  const E = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r', 27: 'E' };
  let out = "$'";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (E[c]) out += '\\' + E[c];
    else if (c < 0x20 || c >= 0x7f) out += '\\' + c.toString(8).padStart(3, '0');
    else if (s[i] === "'" || s[i] === '\\') out += '\\' + s[i];
    else out += s[i];
  }
  return out + "'";
}

// bash print_select_list(): numbered items in columns, padded with tabs like the real thing
function selectMenu(items, COLS) {
  if (!items.length) return '\n';
  const numLen = (n) => String(n).length;
  const indicesLen = numLen(items.length);
  const maxElem = Math.max(...items.map(x => x.length)) + indicesLen + 2 + 2;
  let cols = Math.floor(COLS / maxElem) || 1;
  let rows = Math.floor(items.length / cols) + (items.length % cols ? 1 : 0);
  cols = Math.floor(items.length / rows) + (items.length % rows ? 1 : 0);
  if (rows === 1) { rows = cols; cols = 1; }
  const firstLen = numLen(rows);
  const indent = (from, to) => { let o = ''; while (from < to) { if (Math.floor(to / 8) > Math.floor(from / 8)) { o += '\t'; from += 8 - (from % 8); } else { o += ' '; from++; } } return o; };
  let out = '';
  for (let row = 0; row < rows; row++) {
    let ind = row, pos = 0;
    for (;;) {
      const il = pos === 0 ? firstLen : indicesLen;
      const cell = String(ind + 1).padStart(il) + ') ' + items[ind];
      out += cell;
      ind += rows;
      if (ind >= items.length) break;
      out += indent(pos + cell.length, pos + maxElem);
      pos += maxElem;
    }
    out += '\n';
  }
  return out;
}

// Number of lines in a source string (a final unterminated line counts).
function srcLineCount(src) {
  let n = 0;
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  return src.length && !src.endsWith('\n') ? n + 1 : n;
}

// bash's xtrace quoting (sh_contains_shell_metas / sh_single_quote / ansic_quote)
const sq = (s) => (s === "'" ? "\\'" : "'" + s.replace(/'/g, "'\\''") + "'");
function hasShellMetas(s) {
  if (/[ \t\n'"\\|&;()<>!{}*[?\]^$`]/.test(s) || s[0] === '#') return true;
  for (let i = 0; i < s.length; i++) if (s[i] === '~' && (i === 0 || s[i - 1] === '=' || s[i - 1] === ':')) return true;
  return false;
}
export function xtraceQuote(s) {
  if (s === '') return "''";
  if (hasShellMetas(s)) return sq(s);
  if (!/[\x00-\x1f\x7f-\xff]/.test(s)) return s;
  const ESC = { '\x1b': 'E', '\x07': 'a', '\b': 'b', '\f': 'f', '\n': 'n', '\r': 'r', '\t': 't', '\v': 'v' };
  let out = "$'";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ESC[ch]) out += '\\' + ESC[ch];
    else if (ch === '\\' || ch === "'") out += '\\' + ch;
    else if (c < 0x20 || c >= 0x7f) out += '\\' + c.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out + "'";
}

// the builtins dash (Ubuntu's /bin/sh) has; the rest of bash's are "not found" there
export const DASH_BUILTINS = new Set([':', '.', '[', 'alias', 'bg', 'break', 'cd', 'chdir', 'command', 'continue', 'echo', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'jobs', 'kill', 'local', 'printf', 'pwd', 'read', 'readonly', 'return', 'set', 'shift', 'test', 'times', 'trap', 'true', 'type', 'ulimit', 'umask', 'unalias', 'unset', 'wait']);

export class Shell {
  constructor(opts = {}) {
    this.fs = opts.fs || new VFS();
    this.commands = opts.commands || new Map();
    this.cwd = opts.cwd || '/';
    this.scopes = [new Map()];
    this.functions = new Map();
    this.positional = opts.args || [];
    this.arg0 = opts.arg0 || 'bash';
    this.scriptMode = !!opts.scriptMode;   // running a script file (vs. a -c string)
    this.status = 0;
    this.pid = opts.pid || 1337;
    this.ppid = opts.ppid || 1;
    this.lastBg = '';
    this.interactive = !!opts.interactive;
    this.procs = opts.procs || new Map();     // pid -> { cmd, args }
    this.limits = opts.limits || { steps: 0, maxSteps: 400000, deadline: Infinity, depth: 0 };
    this.opts = { errexit: false, nounset: false, xtrace: false, pipefail: false, noglob: false, noclobber: false, verbose: false, ...(opts.setopts || {}) };
    this.shopt = { globstar: true, extglob: false, nullglob: false, dotglob: false, nocaseglob: false, failglob: false, nocasematch: false, expand_aliases: false, lastpipe: false, xpg_echo: false, globasciiranges: true, ...(opts.shopt || {}) };
    this.traps = new Map();
    this.aliases = new Map();
    this.dirStack = [];
    this.procsubs = new Map();
    this.fdBase = null;           // persistent fds set via `exec`
    this.line = 1;
    this.funcStack = [];
    this.xlevel = 1;              // xtrace nesting: eval, source and $( ) add one
    this.srcName = null;          // file named in error messages (a sourced file, or where the running function was defined)
    this.funcSrc = new Map();     // function name -> srcName to use while it runs
    this.errexitSuppress = 0;
    this.subshellLevel = opts.subshellLevel || 0;
    this.rng = opts.seed !== undefined ? (opts.seed >>> 0) || 1 : 12345;
    this.startTime = Date.now();
    this.nobin = !!opts.nobin;
    this.trusted = !!opts.trusted;
    this.dash = !!opts.dash;           // running as /bin/sh (dash flavour)
    this.hashed = new Map();           // command hash table: name -> { path, hits } (assigning PATH empties it)
    this.dashOpt = { optind: 1, optoff: -1 };   // dash's getopts position (OPTIND only reports it)
    this.game = opts.game || null;   // optional hooks for easter eggs etc.
    this.history = opts.history || [];
    const env = opts.env || {};
    for (const [k, v] of Object.entries(env)) { const x = new Var(String(v)); x.exported = true; this.scopes[0].set(k, x); }
    if (!this.getVar('IFS')) this.setVar('IFS', DEFAULT_IFS);
    if (this.getVar('PS4') === undefined) this.setVar('PS4', '+ ');
    if (this.getVar('OPTIND') === undefined) this.setVar('OPTIND', '1');
    // PPID: a readonly integer in bash, an ordinary variable in dash
    { const v = new Var(String(this.ppid)); v.readonly = v.integer = !this.dash; this.scopes[0].set('PPID', v); }
    if (!this.dash) {
      // what bash defines about itself (not exported)
      for (const [k, v] of [['BASH', '/usr/bin/bash'], ['BASH_VERSION', '5.1.16(1)-release'], ['MACHTYPE', 'x86_64-pc-linux-gnu'], ['HOSTTYPE', 'x86_64'], ['OSTYPE', 'linux-gnu']]) {
        if (!this.lookupVar(k)) this.scopes[0].set(k, new Var(v));
      }
      if (!this.lookupVar('BASH_VERSINFO')) {
        const vi = new Var(); vi.arr = new Map(['5', '1', '16', '1', 'release', 'x86_64-pc-linux-gnu'].map((x, i) => [i, x])); vi.readonly = true;
        this.scopes[0].set('BASH_VERSINFO', vi);
      }
    }
    this.setVar('PWD', this.cwd); this.scopes[0].get('PWD').exported = true;
    if (!this.lookupVar('OLDPWD')) { /* unset */ }
  }

  // ------------------------------------------------------------ variables
  lookupVar(name, depth = 0) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i].get(name);
      if (v) {
        if (v.nameref && depth < 10) { const t = v.nameref; const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(t); return m ? (this.lookupVar(m[1], depth + 1) || this.createGlobal(m[1])) : v; }
        return v;
      }
    }
    return null;
  }
  createGlobal(name) { const v = new Var(); this.scopes[0].set(name, v); return v; }
  resolveName(name) {
    // follow namerefs to the target variable name
    for (let d = 0; d < 10; d++) {
      let v = null;
      for (let i = this.scopes.length - 1; i >= 0; i--) { v = this.scopes[i].get(name); if (v) break; }
      if (v && v.nameref) { name = v.nameref; continue; }
      return name;
    }
    return name;
  }

  special(name) {
    if (this.dash) {
      // dash has none of bash's dynamic variables
      if (name === '-') return [['errexit', 'e'], ['noglob', 'f'], ['noexec', 'n'], ['xtrace', 'x'], ['verbose', 'v'], ['noclobber', 'C'], ['allexport', 'a'], ['nounset', 'u']].filter(([o]) => this.opts[o]).map(([, c]) => c).join('');
      if (['RANDOM', 'SECONDS', 'LINENO', 'BASHPID', 'EPOCHSECONDS', 'EPOCHREALTIME', 'UID', 'EUID', 'BASH_SUBSHELL', 'SHELLOPTS'].includes(name)) return null;
    }
    switch (name) {
      case '?': return String(this.status);
      case '$': return String(this.pid);
      case '!': return this.lastBg;
      case '#': return String(this.positional.length);
      case '0': return this.arg0;
      case '-': return (this.opts.errexit ? 'e' : '') + (this.opts.noglob ? 'f' : '') + 'h' + (this.opts.nounset ? 'u' : '') + (this.opts.xtrace ? 'x' : '') + 'B' + (this.interactive ? 'i' : 'c');
      case '_': return this.lastArg || '';
      case 'RANDOM': return String(this.random() & 32767);
      case 'SECONDS': return String(Math.floor((Date.now() - this.startTime) / 1000));
      case 'LINENO': return String(this.line);
      case 'BASHPID': return String(this.pid + this.subshellLevel);
      case 'EPOCHSECONDS': return String(Math.floor(Date.now() / 1000));
      case 'EPOCHREALTIME': return (Date.now() / 1000).toFixed(6);
      case 'UID': case 'EUID': return '0';
      case 'BASH_SUBSHELL': return String(this.subshellLevel);
      case 'SHLVL': return this.lookupVar('SHLVL') ? null : '1';
      case 'SHELLOPTS': {
        const dflt = (o) => o === 'braceexpand' || o === 'hashall' || o === 'interactive-comments' ||
          (this.interactive && (o === 'emacs' || o === 'histexpand' || o === 'history' || o === 'monitor'));
        return SHELLOPTS_LIST.filter((o) => this.opts[o] ?? dflt(o)).join(':');
      }
    }
    return null;
  }

  random() {
    // xorshift32
    let x = this.rng;
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    this.rng = x;
    return x;
  }

  getVar(name) {
    if (/^[0-9]+$/.test(name)) { const n = parseInt(name, 10); return n === 0 ? this.arg0 : this.positional[n - 1]; }
    const sp = this.special(name);
    if (sp !== null) return sp;
    const v = this.lookupVar(name);
    if (!v) return undefined;
    if (v.arr) return v.arr.get(0);
    if (v.assoc) return v.assoc.get('0');
    return v.value === null ? undefined : v.value;
  }

  isSet(name) {
    if (/^[0-9]+$/.test(name)) { const n = parseInt(name, 10); return n === 0 || n <= this.positional.length; }
    if (this.special(name) !== null) return true;
    const v = this.lookupVar(name);
    if (!v) return false;
    if (v.arr) return v.arr.has(0);
    if (v.assoc) return v.assoc.has('0');
    return v.value !== null;
  }

  transformValue(v, s) {
    if (v.integer) {
      try { s = String(this.arith(s)); } catch { s = '0'; }
    }
    if (v.lower) s = s.toLowerCase();
    if (v.upper) s = s.toUpperCase();
    return s;
  }

  findScopeFor(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i].has(name)) return this.scopes[i];
    return this.scopes[0];
  }

  setVar(name, value, { local = false, append = false } = {}) {
    if (name === 'RANDOM' && !this.dash) { this.rng = (parseInt(value, 10) >>> 0) || 1; return; }
    if (!local) name = this.resolveName(name);
    if (name === 'PATH') this.hashed.clear();
    if (name === 'OPTIND' && this.dash) {
      // dash's getoptsreset() takes number(): digits, blanks around them allowed
      if (!/^\s*\+?\d+\s*$/.test(value) || parseInt(value.trim(), 10) > 2147483647) throw new ShellAbort(2, `Illegal number: ${value}`);
      this.dashOpt = { optind: parseInt(value.trim(), 10) || 1, optoff: -1 };
    }
    const scope = local ? this.scopes[this.scopes.length - 1] : this.findScopeFor(name);
    let v = scope.get(name);
    if (v && v.readonly) throw new ShellAbort(1, `${name}: readonly variable`, true);
    if (!v) { v = new Var(); scope.set(name, v); if (this.allexport) v.exported = true; }
    if (append) {
      if (v.integer) value = String(this.arith((this.getVar(name) || '0') + '+(' + value + ')'));
      else value = (v.arr ? (v.arr.get(0) || '') : v.assoc ? (v.assoc.get('0') || '') : (v.value || '')) + value;
    }
    value = this.transformValue(v, value);
    if (v.arr) v.arr.set(0, value);
    else if (v.assoc) v.assoc.set('0', value);
    else v.value = value;
    if (name === 'PWD') { /* informational */ }
  }

  getArray(name) {
    const v = this.lookupVar(name);
    if (!v) return null;
    return v;
  }

  setArrayElem(name, key, value, { local = false, append = false } = {}) {
    if (!local) name = this.resolveName(name);
    const scope = local ? this.scopes[this.scopes.length - 1] : this.findScopeFor(name);
    let v = scope.get(name);
    if (v && v.readonly) throw new ShellAbort(1, `${name}: readonly variable`, true);
    if (!v) { v = new Var(); scope.set(name, v); }
    if (v.assoc) {
      const k = String(key);
      v.assoc.set(k, this.transformValue(v, append ? (v.assoc.get(k) || '') + value : value));
      return;
    }
    if (!v.arr) { v.arr = new Map(); if (v.value !== null) v.arr.set(0, v.value); v.value = null; }
    let idx = Number(key);
    if (idx < 0) {
      const keys = sortedKeys(v.arr);
      const max = keys.length ? keys[keys.length - 1] : -1;
      idx = max + 1 + idx;
      if (idx < 0) throw new ShellAbort(1, `${name}[${key}]: bad array subscript`, true);
    }
    v.arr.set(idx, this.transformValue(v, append ? (v.arr.get(idx) || '') + value : value));
  }

  unsetVar(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i].get(name);
      if (v) {
        if (v.readonly) throw new ShellAbort(1, `unset: ${name}: cannot unset: readonly variable`);
        if (name === 'OPTIND' && this.dash) throw new ShellAbort(2, 'unset: Illegal number: ');   // getoptsreset("")
        this.scopes[i].delete(name);
        if (name === 'PATH') this.hashed.clear();
        return;
      }
    }
  }

  // values of an array-ish parameter for ${name[@]} / $@
  arrayValues(name) {
    if (name === '@' || name === '*') return [...this.positional];
    const v = this.lookupVar(name);
    if (!v) return [];
    if (v.arr) return sortedKeys(v.arr).map(k => v.arr.get(k));
    if (v.assoc) return assocKeys(v.assoc).map(k => v.assoc.get(k));
    return v.value === null ? [] : [v.value];
  }
  arrayKeys(name) {
    const v = this.lookupVar(name);
    if (!v) return [];
    if (v.arr) return sortedKeys(v.arr).map(String);
    if (v.assoc) return assocKeys(v.assoc);
    return v.value === null ? [] : ['0'];
  }
  arrayElem(name, idxText, idxWord) {
    const v = this.lookupVar(name);
    if (!v) {
      if (name === '@' || name === '*') return undefined;
      return undefined;
    }
    if (v.assoc) {
      const raw = idxWord ? (idxWord.text ?? null) : idxText;
      const key = raw !== null && raw !== undefined ? this.expandWordString(parseSubscript(raw)) : this.expandWordString(idxWord);
      return v.assoc.get(key);
    }
    let i = Number(this.arithWord(idxWord));
    if (v.arr) {
      if (i < 0) { const keys = sortedKeys(v.arr); const max = keys.length ? keys[keys.length - 1] : -1; i = max + 1 + i; }
      return v.arr.get(i);
    }
    return i === 0 || i === -1 ? (v.value === null ? undefined : v.value) : undefined;
  }

  exportedEnv() {
    const all = new Map();
    for (const scope of this.scopes) for (const [k, v] of scope) all.set(k, v);
    const env = {};
    for (const [k, v] of all) if (v.exported && !v.arr && !v.assoc && v.value !== null) env[k] = v.value;
    return env;
  }

  // ------------------------------------------------------------ arithmetic
  arithEnv() {
    const sh = this;
    // the element a subscript names: assoc arrays use the text, indexed ones evaluate it
    const resolve = (v, sub) => {
      if (v && v.assoc) return sub;
      let i = sh.arithRaw(sub);
      if (i < 0n && v && v.arr) { const keys = sortedKeys(v.arr); i = BigInt(keys.length ? keys[keys.length - 1] : -1) + 1n + i; }
      return i;
    };
    return {
      get(name, sub, lval) {
        if (sub !== null && sub !== undefined) {
          const v = sh.lookupVar(name);
          const key = resolve(v, sub);
          if (lval) lval.key = key;
          let val;
          if (v) val = v.assoc ? v.assoc.get(String(key)) : v.arr ? v.arr.get(Number(key)) : (key === 0n ? v.value : undefined);
          if ((val === undefined || val === null) && sh.opts.nounset) throw new ShellAbort(127, `${name}[${sub}]: unbound variable`);
          return val ?? undefined;
        }
        const val = sh.getVar(name);
        if (val === undefined && sh.opts.nounset) throw new ShellAbort(127, `${name}: unbound variable`);
        return val;
      },
      set(name, sub, value, key) {
        if (sub !== null && sub !== undefined) {
          const v = sh.lookupVar(name);
          sh.setArrayElem(name, key !== undefined ? key : resolve(v, sub), value);
        } else sh.setVar(name, value);
      },
    };
  }

  // evaluate; arithmetic errors propagate as ArithError
  arithRaw(text) {
    if (this.dash) return this.dashArith(text);
    return evalArith(text, this.arithEnv());
  }
  // dash's arithmetic; its errors end the shell with status 2
  dashArith(text) {
    try {
      return evalDashArith(text, { get: (n) => this.getVar(n), set: (n, v) => this.setVar(n, v) });
    } catch (e) {
      if (e instanceof DashArithError) throw new ShellAbort(2, e.message);
      throw e;
    }
  }

  // evaluate for an expansion: an error abandons the command line (bash's DISCARD). `name` is the
  // command bash names in the message ("((", "let"), if any.
  arith(text, name = null) {
    if (this.dash) return this.dashArith(text);
    try {
      return evalArith(text, this.arithEnv());
    } catch (e) {
      if (e instanceof ArithError) throw new ShellAbort(1, e.text(name), true);
      throw e;
    }
  }

  arithWord(word) {
    if (!word) return 0n;
    const text = this.expandWordString(word, { arith: true });
    return this.arith(text);
  }
  // (( )) and for (( )): an arithmetic error is reported as "((: ..." and makes the command fail
  arithCmd(word, io, trace = false) {
    if (!word) return 0n;
    const text = this.expandWordString(word, { arith: true });
    if (trace) this.xtrace(io, `(( ${text} ))`);
    try { return this.arithRaw(text); }
    catch (e) {
      if (e instanceof ArithError) { this.shellError(io, e.text('((')); return null; }
      throw e;
    }
  }

  // ------------------------------------------------------------ limits
  tick() {
    const L = this.limits;
    if (++L.steps > L.maxSteps) throw new ExecLimit('cmdpro: execution step limit reached (infinite loop?)');
    if ((L.steps & 255) === 0 && Date.now() > L.deadline) throw new ExecLimit('cmdpro: CPU time limit exceeded (infinite loop?)');
  }

  // ------------------------------------------------------------ error output
  errPrefix() { return this.interactive ? 'bash: ' : this.dash ? `${this.arg0}: ${this.line}: ` : `${this.srcName ?? this.arg0}: line ${this.line}: `; }
  shellError(io, msg) { this.writeFd(io, 2, this.errPrefix() + msg + '\n'); }
  abortMsg(io, e) { this.writeFd(io, 2, (e.prefix ?? this.errPrefix()) + e.msg + '\n'); }
  writeFd(io, fd, s) {
    const f = io.fds[fd];
    if (!f || !f.write) return;
    f.write(s);
  }

  // ------------------------------------------------------------ running
  // Run a script source (bash -c semantics). Returns exit status.
  run(src, io) {
    const parser = new Parser(src, { extglob: this.shopt.extglob, posix: this.dash });
    let status = 0;
    try {
      for (;;) {
        let list;
        const startLine = parser.line;
        parser.extglob = this.shopt.extglob;
        try {
          list = parser.parseNext();
        } catch (e) {
          if (e instanceof ParseError) {
            this.line = parser.line;
            this.syntaxError(io, src, e, startLine);
            this.status = status = e.status ?? 2;
            break;
          }
          throw e;
        }
        if (parser.warnings) {
          for (const w of parser.warnings) this.writeFd(io, 2, (this.interactive ? 'bash: ' : `${this.arg0}: line ${srcLineCount(src)}: `) + 'warning: ' + w + '\n');
          parser.warnings = null;
        }
        if (!list) break;
        if (this.opts.verbose) this.writeFd(io, 2, src.split('\n').slice(startLine - 1, Math.max(parser.line - 1, startLine)).join('\n') + '\n');
        if (this.opts.noexec) continue;
        status = this.execTop(list, io);
      }
    } catch (e) {
      if (e instanceof ExitSignal) status = e.code;
      else throw e;
    }
    status = this.runExitTrap(io, status);
    this.status = status;
    return status;
  }

  // select: menu and PS3 prompt on stderr, one line of stdin per round, until break or EOF
  execSelect(node, io) {
    if (!isName(node.var)) { this.shellError(io, `\`${node.var}': not a valid identifier`); return 1; }
    const items = node.words ? this.expandWords(node.words) : [...this.positional];
    this.xtrace(io, `select ${node.var} in ${items.map(w => w === '' ? "''" : w).join(' ')}`);
    if (!items.length) return 0;
    const stdin = io.fds[0];
    let showMenu = true, st = 0;
    this.loopDepth = (this.loopDepth || 0) + 1;
    try {
      for (;;) {
        this.tick();
        if (showMenu) this.writeFd(io, 2, selectMenu(items, parseInt(this.getVar('COLUMNS') || '', 10) || 80));
        this.writeFd(io, 2, this.getVar('PS3') ?? '#? ');
        let line = stdin && stdin.readUntil ? stdin.readUntil('\n') : null;
        if (!line) { this.writeFd(io, 1, '\n'); st = 1; break; }
        // read as `read` does: backslash-newline continues the line, other backslashes quote
        let text = line.text;
        while (line && line.found && /(^|[^\\])(\\\\)*\\$/.test(text)) {
          text = text.slice(0, -1);
          line = stdin.readUntil('\n');
          if (line) text += line.text;
        }
        const reply = text.replace(/\\(.)/g, '$1');
        this.setVar('REPLY', reply);
        if (reply === '') { showMenu = true; continue; }
        showMenu = false;
        const n = /^\s*[+-]?\d+\s*$/.test(reply) ? parseInt(reply, 10) : 0;
        this.setVar(node.var, n >= 1 && n <= items.length ? items[n - 1] : '');
        try { st = this.execList(node.body, io); }
        catch (e) {
          if (e instanceof BreakSignal) { if (e.n > 1) { e.n--; throw e; } break; }
          if (e instanceof ContinueSignal) { if (e.n > 1) { e.n--; throw e; } continue; }
          throw e;
        }
      }
    } finally { this.loopDepth--; }
    return st;
  }

  // bash's syntax error report: `-c` strings say "NAME: -c: line N:", scripts "NAME: line N:".
  // Errors found at EOF are reported one line past the end of the input.
  syntaxError(io, src, e, startLine, prefix = null, base = 1) {
    if (this.dash && !this.interactive) {
      // dash: "sh: 1: Syntax error: ")" unexpected"
      let m = e.message, ln = e.line ?? startLine;
      const tok = /near unexpected token `(.*)'$/.exec(m);
      const eofLine = (src.match(/\n/g) || []).length + 1;
      if (e.dash) { /* already dash's wording */ }
      else if (tok) {
        // dash's tokname[]: keywords and operators quoted, any other word just "word"
        const t = tok[1];
        if (t === 'newline') { m = 'Syntax error: newline unexpected'; ln++; }
        else if (/^[<>]/.test(t)) m = 'Syntax error: redirection unexpected';
        else if (DASH_KEYWORDS.has(t) || /^[;&|()`]/.test(t)) m = `Syntax error: "${t}" unexpected`;
        else m = 'Syntax error: word unexpected';
      }
      else if (/unexpected end of file/.test(m)) { m = 'Syntax error: end of file unexpected' + (e.expecting ? ` (expecting "${e.expecting}")` : ''); ln = eofLine; }
      else if (/looking for matching `["']'/.test(m)) { m = 'Syntax error: Unterminated quoted string'; ln = eofLine; }
      else if (/looking for matching ``'/.test(m)) { m = 'Syntax error: EOF in backquote substitution'; ln = eofLine; }
      else if (/looking for matching `\)'/.test(m)) { m = 'Syntax error: end of file unexpected (expecting ")")'; ln = eofLine; }
      else if (/looking for matching `\}'/.test(m)) { m = "Syntax error: Missing '}'"; ln = eofLine; }
      else if (/looking for matching/.test(m)) { m = 'Syntax error: end of file unexpected'; ln = eofLine; }
      this.writeFd(io, 2, `${this.arg0}: ${ln}: ${m}\n`);
      return;
    }
    const pre = prefix || ((n) => (this.interactive ? 'bash: ' : this.scriptMode ? `${this.arg0}: line ${n}: ` : `${this.arg0}: -c: line ${n}: `));
    const eofLine = srcLineCount(src) + base;
    if (e.message === 'syntax error: unexpected end of file') { this.writeFd(io, 2, pre(eofLine) + e.message + '\n'); return; }
    if (e.message.startsWith('unexpected EOF while looking for')) {
      this.writeFd(io, 2, pre(e.line ?? startLine) + e.message + '\n');
      if (e.status === 1) return;   // an unfinished array literal
      this.writeFd(io, 2, pre(eofLine) + 'syntax error: unexpected end of file\n');
      return;
    }
    const ln = e.line ?? startLine;
    if (e.near !== undefined) {
      if (e.message) this.writeFd(io, 2, pre(ln) + e.message + '\n');
      this.writeFd(io, 2, pre(ln) + `syntax error near \`${e.near}'\n`);
      if (!this.interactive || prefix) this.writeFd(io, 2, pre(ln) + `\`${src.split('\n')[ln - base] ?? ''}'\n`);
      return;
    }
    this.writeFd(io, 2, pre(ln) + e.message + '\n');
    if ((!this.interactive || prefix) && e.token !== undefined) this.writeFd(io, 2, pre(ln) + `\`${src.split('\n')[ln - base] ?? ''}'\n`);
  }

  runExitTrap(io, status) {
    const t = this.traps.get('EXIT');
    if (t) {
      this.traps.delete('EXIT');
      this.status = status;
      try { this.runString(t, io, { kind: 'trap', name: 'exit trap' }); } catch (e) { if (e instanceof ExitSignal) return e.code; if (!(e instanceof ShellAbort)) throw e; }
    }
    return status;
  }

  // Execute a parsed top-level list, handling aborts.
  execTop(list, io) {
    try {
      return this.execList(list, io);
    } catch (e) {
      if (e instanceof ShellAbort) {
        if (e.msg) this.abortMsg(io, e);
        this.status = e.code;
        if (!this.interactive && !e.discard) throw new ExitSignal(e.code);
        return e.code;
      }
      if (e instanceof BreakSignal || e instanceof ContinueSignal) return this.status;
      if (e instanceof ReturnSignal) {
        this.shellError(io, 'return: can only `return\' from a function or sourced script');
        this.status = 1;
        return 1;
      }
      throw e;
    }
  }

  // Run a string within this shell (eval/source/trap).
  // ctx: how syntax errors are reported — { kind: 'eval' } ("bash: eval: line N:", numbered from
  // the eval's own line), { kind: 'source', name } ("FILE: line N:") or { kind: 'trap', name }.
  runString(src, io, ctx = null) {
    const base = ctx && ctx.kind === 'eval' ? this.line : 1;
    const parser = new Parser(src, { extglob: this.shopt.extglob, posix: this.dash, line: base });
    const savedSrc = this.srcName, savedX = this.xlevel;
    if (ctx && ctx.kind === 'source') this.srcName = ctx.name;
    if (ctx && (ctx.kind === 'eval' || ctx.kind === 'source')) this.xlevel++;
    let status = 0;
    try {
      for (;;) {
        let list;
        const startLine = parser.line;
        parser.extglob = this.shopt.extglob;
        try { list = parser.parseNext(); } catch (e) {
          if (e instanceof ParseError) {
            if (ctx && !this.dash) {
              const tag = ctx.kind === 'source' ? `${ctx.name}: line ` : `${this.interactive ? 'bash' : this.arg0}: ${ctx.kind === 'eval' ? 'eval' : ctx.name}: line `;
              this.syntaxError(io, src, e, startLine, (n) => tag + n + ': ', base);
            } else this.shellError(io, e.message);
            this.status = 2;
            return 2;
          }
          throw e;
        }
        if (!list) break;
        status = this.execList(list, io);
      }
    } finally { this.srcName = savedSrc; this.xlevel = savedX; }
    return status;
  }

  execList(list, io) {
    let status = this.status;
    for (const item of list.items) {
      if (item.bg) {
        // Background jobs run synchronously in a subshell.
        const sub = this.subshell();
        try { sub.execNode(item.cmd, io); } catch (e) { if (!(e instanceof ExitSignal)) { if (e instanceof ShellAbort) { if (e.msg) sub.abortMsg(io, e); } else throw e; } }
        this.lastBg = String(this.pid + 100 + (++this.bgCount || (this.bgCount = 1)));
        status = 0;
        this.status = 0;
      } else {
        status = this.execNode(item.cmd, io);
        this.status = status;
      }
    }
    return status;
  }

  execNode(node, io) {
    switch (node.t) {
      case 'list': return this.execList(node, io);
      case 'andor': return this.execAndOr(node, io);
      case 'pipe': {
        // set -e: a failing pipeline ends the shell (unless negated or being tested)
        const st = this.execPipeline(node, io);
        if (st !== 0 && this.errexitSuppress === 0 && !node.negate) this.failed(st, io);
        return st;
      }
      default: {
        const st = this.execCommand(node, io);
        this.status = st;
        const ps = new Var(); ps.arr = new Map([[0, String(st)]]);
        this.scopes[0].set('PIPESTATUS', ps);
        // compound commands other than ( ) only fail through the command that failed inside
        if (st !== 0 && this.errexitSuppress === 0 && node.t !== 'group' && node.t !== 'if' && node.t !== 'while' && node.t !== 'until' && node.t !== 'for' && node.t !== 'cfor' && node.t !== 'case' && node.t !== 'select') this.failed(st, io);
        return st;
      }
    }
  }

  // a command failed where set -e and the ERR trap apply
  failed(st, io) {
    const t = this.traps.get('ERR');
    if (t && !this.inErrTrap && (this.funcStack.length === 0 || this.opts.errtrace)) {
      this.inErrTrap = true;
      try { this.runString(t, io, { kind: 'trap', name: 'ERR trap' }); } finally { this.inErrTrap = false; this.status = st; }
    }
    if (this.opts.errexit) throw new ExitSignal(st);
  }

  execAndOr(node, io) {
    let st;
    this.errexitSuppress++;
    try {
      st = this.execNode(node.parts[0], io);
    } finally { this.errexitSuppress--; }
    for (let i = 0; i < node.ops.length; i++) {
      const op = node.ops[i];
      const last = i === node.ops.length - 1;
      if ((op === '&&' && st === 0) || (op === '||' && st !== 0)) {
        if (!last) this.errexitSuppress++;
        try { st = this.execNode(node.parts[i + 1], io); } finally { if (!last) this.errexitSuppress--; }
      }
      this.status = st;
    }
    return st;
  }

  execPipeline(node, io) {
    const t0 = Date.now();
    const n = node.cmds.length;
    const statuses = [];
    let st;
    if (node.negate) this.errexitSuppress++;
    try {
      if (n === 1) {
        st = this.execNode(node.cmds[0], io);
        statuses.push(st);
      } else {
        // Real pipeline stages start together, so a later stage's `> file` has (almost always)
        // truncated the file before an earlier stage reads it: `cat f | sort > f` leaves f empty.
        for (let k = 1; k < n; k++) {
          const c = node.cmds[k];
          if (c.t !== 'simple' || !c.redirs) continue;
          for (const r of c.redirs) {
            if (!['>', '>|', '&>'].includes(r.op) || (typeof r.fd === 'number' && r.fd !== 1 && r.fd !== 2)) continue;
            if (JSON.stringify(r.target || '').includes('"t":"cmd"')) continue;   // don't run command substitutions twice
            try {
              const target = this.expandRedirTarget(r.target);
              const ex = this.fs.tryResolve(target, this.cwd, {});
              if (ex && ex.node.type === 'f') { ex.node.data = ''; ex.node.mtime = this.fs.now(); }
            } catch { /* the stage itself will report the error */ }
          }
        }
        let input = io.fds[0];
        for (let k = 0; k < n; k++) {
          const last = k === n - 1;
          if (this.dash) this.dashPrehash(node.cmds[k]);
          const out = last ? io.fds[1] : new OutBuf(8 * 1024 * 1024);
          const fds = { ...io.fds, 0: input, 1: out };
          if (!last && node.stderr[k]) fds[2] = out;
          const sub = (last && this.shopt.lastpipe) ? this : this.subshell();
          let s;
          try {
            s = sub.execNode(node.cmds[k], { fds });
          } catch (e) {
            if (e instanceof ExitSignal) s = e.code;
            else if (e instanceof PipeLimit && !last) s = 141;
            else if (e instanceof ShellAbort) { if (e.msg) sub.abortMsg({ fds }, e); s = e.code; }
            else if (e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal) s = sub.status;
            else throw e;
          }
          statuses.push(s);
          // a writer that filled the pipe (64 KiB) after its reader had stopped reading gets SIGPIPE
          if (k > 0 && input instanceof InStream && input.pos < input.data.length && input.data.length > 65536 && statuses[k - 1] === 0) statuses[k - 1] = 141;
          if (!last) input = new InStream(out.data);
        }
        st = statuses[statuses.length - 1];
        if (this.opts.pipefail) { for (let k = statuses.length - 1; k >= 0; k--) if (statuses[k] !== 0) { st = statuses[k]; break; } }
      }
    } finally { if (node.negate) this.errexitSuppress--; }
    this.pipestatus = statuses;
    const arr = new Var(); arr.arr = new Map(statuses.map((s, i) => [i, String(s)]));
    this.scopes[0].set('PIPESTATUS', arr);
    if (node.negate) st = st === 0 ? 1 : 0;
    if (node.timed) {
      const el = (Date.now() - t0) / 1000;
      const fmt = (s) => { const m = Math.floor(s / 60); return `${m}m${(s - m * 60).toFixed(3)}s`; };
      const tf = this.getVar('TIMEFORMAT');
      if (node.timeP) this.writeFd(io, 2, `real ${el.toFixed(2)}\nuser 0.00\nsys 0.00\n`);
      else if (tf !== undefined) {
        const s = tf.replace(/%(\d)?(l)?([RUSP%])/g, (m, p, l, k) => { if (k === '%') return '%'; const v = k === 'R' ? el : k === 'P' ? 0 : 0; const prec = p === undefined ? 3 : +p; return l ? fmt(v).replace(/\.\d+s$/, prec ? '.' + v.toFixed(prec).split('.')[1] + 's' : 's') : v.toFixed(prec); });
        this.writeFd(io, 2, s + '\n');
      }
      else this.writeFd(io, 2, `\nreal\t${fmt(el)}\nuser\t0m0.000s\nsys\t0m0.000s\n`);
    }
    this.status = st;
    return st;
  }

  subshell() {
    const s = Object.create(Shell.prototype);
    Object.assign(s, this);
    s.scopes = this.scopes.map(sc => { const m = new Map(); for (const [k, v] of sc) m.set(k, v.clone()); return m; });
    s.functions = new Map(this.functions);
    s.funcSrc = new Map(this.funcSrc);
    s.positional = [...this.positional];
    s.opts = { ...this.opts };
    s.shopt = { ...this.shopt };
    s.traps = new Map([...this.traps].filter(([k, v]) => v === ''));
    s.dirStack = [...this.dirStack];
    s.funcStack = [...this.funcStack];
    s.subshellLevel = this.subshellLevel + 1;
    s.procsubs = this.procsubs;
    s.procFiles = null;
    s.pendingProcOut = null;
    s.aliases = new Map(this.aliases);
    s.hashed = new Map([...this.hashed].map(([k, v]) => [k, { ...v }]));
    s.dashOpt = { ...this.dashOpt };
    return s;
  }

  // ------------------------------------------------------------ commands
  execCommand(node, io) {
    this.tick();
    if (this.opts.noexec && !this.interactive) return 0;   // set -n: read commands, run nothing
    this.curIo = io;
    if (node.redirs && node.t !== 'simple') {
      let rio;
      try { rio = this.applyRedirs(node.redirs, io); } catch (e) {
        if (e instanceof RedirError) { this.shellError(io, e.message); return e.status; }
        throw e;
      }
      try { return this.execCompound(node, rio.io); } finally { rio.finish(); }
    }
    if (node.t === 'simple') return this.execSimple(node, io);
    return this.execCompound(node, io);
  }

  execCompound(node, io) {
    switch (node.t) {
      case 'group': return this.execList(node.body, io);
      case 'subshell': {
        const sub = this.subshell();
        try { return sub.execList(node.body, io); }
        catch (e) {
          if (e instanceof ExitSignal) return e.code;
          if (e instanceof ShellAbort) { if (e.msg) sub.abortMsg(io, e); return e.code; }
          if (e instanceof BreakSignal || e instanceof ContinueSignal) return sub.status;
          throw e;
        } finally { sub.runExitTrap(io, sub.status); }
      }
      case 'if': {
        for (const cl of node.clauses) {
          this.errexitSuppress++;
          let c;
          try { c = this.execList(cl.cond, io); } finally { this.errexitSuppress--; }
          if (c === 0) return this.execList(cl.body, io);
        }
        if (node.else) return this.execList(node.else, io);
        return 0;
      }
      case 'while': {
        let st = 0;
        this.loopDepth = (this.loopDepth || 0) + 1;
        try {
        for (;;) {
          this.tick();
          this.errexitSuppress++;
          let c;
          try { c = this.execList(node.cond, io); } finally { this.errexitSuppress--; }
          if (node.until ? c === 0 : c !== 0) break;
          try { st = this.execList(node.body, io); }
          catch (e) {
            if (e instanceof BreakSignal) { if (e.n > 1) { e.n--; throw e; } st = 0; break; }
            if (e instanceof ContinueSignal) { if (e.n > 1) { e.n--; throw e; } continue; }
            throw e;
          }
        }
        } finally { this.loopDepth--; }
        return st;
      }
      case 'select': return this.execSelect(node, io);
      case 'for': {
        if (!isName(node.var)) { this.shellError(io, `\`${node.var}': not a valid identifier`); return 1; }
        let items;
        if (node.words) items = this.expandWords(node.words);
        else items = [...this.positional];
        this.xtrace(io, `for ${node.var} in ${items.map(w => w === '' ? "''" : w).join(' ')}`);
        let st = 0;
        this.loopDepth = (this.loopDepth || 0) + 1;
        try {
        for (const it of items) {
          this.tick();
          this.setVar(node.var, it);
          try { st = this.execList(node.body, io); }
          catch (e) {
            if (e instanceof BreakSignal) { if (e.n > 1) { e.n--; throw e; } break; }
            if (e instanceof ContinueSignal) { if (e.n > 1) { e.n--; throw e; } continue; }
            throw e;
          }
        }
        } finally { this.loopDepth--; }
        return st;
      }
      case 'cfor': {
        let st = 0;
        if (node.init && this.arithCmd(node.init, io, true) === null) return 1;
        this.loopDepth = (this.loopDepth || 0) + 1;
        try {
        for (;;) {
          this.tick();
          if (node.cond && wordLiteral(node.cond).trim() !== '') {
            const c = this.arithCmd(node.cond, io, true);
            if (c === null) return 1;
            if (c === 0n) break;
          }
          try { st = this.execList(node.body, io); }
          catch (e) {
            if (e instanceof BreakSignal) { if (e.n > 1) { e.n--; throw e; } break; }
            if (!(e instanceof ContinueSignal)) throw e;
            if (e.n > 1) { e.n--; throw e; }
          }
          if (node.step && this.arithCmd(node.step, io, true) === null) return 1;
        }
        } finally { this.loopDepth--; }
        return st;
      }
      case 'case': {
        const w = this.expandWordString(node.word);
        this.xtrace(io, `case ${w} in`);
        let st = 0;
        let fall = false;
        for (let i = 0; i < node.items.length; i++) {
          const item = node.items[i];
          let matched = fall;
          if (!matched) {
            for (const p of item.patterns) {
              const pat = this.expandPattern(p);
              if (fnmatch(pat, w, { nocase: this.shopt.nocasematch, extglob: true })) { matched = true; break; }
            }
          }
          if (matched) {
            st = this.execList(item.body, io);
            if (item.term === ';&') { fall = true; continue; }
            fall = false;
            if (item.term === ';;&') continue;
            return st;
          }
        }
        return st;
      }
      case 'arith': {
        if (node.line) this.line = node.line;
        if (this.opts.xtrace) this.xtrace(io, `(( ${this.expandWordString(node.expr, { arith: true })} ))`);
        const v = this.arithCmd(node.expr, io);
        return v !== null && v !== 0n ? 0 : 1;
      }
      case 'cond': if (node.line) this.line = node.line; return this.evalCond(node.expr, io) ? 0 : 1;
      case 'func': {
        if (node.badName) { this.shellError(io, `\`${node.badName}': not a valid identifier`); return 1; }
        this.functions.set(node.name, node.body);
        if (this.dash) this.hashed.delete(node.name);   // dash keeps functions in the same table
        // bash names functions defined in a -c string "environment" in its error messages
        this.funcSrc.set(node.name, this.srcName ?? (this.scriptMode ? this.arg0 : 'environment'));
        return 0;
      }
    }
    throw new Error('unknown node ' + node.t);
  }

  // ------------------------------------------------------------ [[ ]]
  // inv: the term is directly negated (xtrace shows "[[ ! ... ]]")
  evalCond(e, io, inv = false) {
    const tr = (t) => { if (this.opts.xtrace) this.xtrace(io, `[[ ${inv ? '! ' : ''}${t} ]]`); };
    const or0 = (v) => (v === '' ? "''" : v);
    switch (e.t) {
      case 'and': return this.evalCond(e.l, io) && this.evalCond(e.r, io);
      case 'or': return this.evalCond(e.l, io) || this.evalCond(e.r, io);
      case 'not': return ['word', 'unary', 'binary'].includes(e.e.t) ? !this.evalCond(e.e, io, !inv) : !this.evalCond(e.e, io);
      case 'word': { const v = this.expandWordString(e.w); tr(`-n ${or0(v)}`); return v !== ''; }
      case 'unary': {
        const v = this.expandWordString(e.w);
        tr(`${e.op} ${or0(v)}`);
        return this.unaryTest(e.op, v);
      }
      case 'binary': {
        const l = this.expandWordString(e.l);
        const op = e.op;
        if (this.opts.xtrace) tr(`${or0(l)} ${op} ${or0(op === '=~' ? this.expandRegexWord(e.r) : this.expandWordString(e.r))}`);
        if (op === '==' || op === '=' || op === '!=') {
          const pat = this.expandPattern(e.r);
          const m = fnmatch(pat, l, { nocase: this.shopt.nocasematch, extglob: true });
          return op === '!=' ? !m : m;
        }
        if (op === '=~') {
          const src = this.expandRegexWord(e.r);
          let re;
          try { re = new RegExp(posixToJs(src, { extended: true }), this.shopt.nocasematch ? 'i' : ''); }
          catch { this.status = 2; return false; }
          const m = re.exec(l);
          const arr = new Var(); arr.arr = new Map();
          if (m) m.forEach((g, i) => arr.arr.set(i, g === undefined ? '' : g));
          this.scopes[0].set('BASH_REMATCH', arr);
          return !!m;
        }
        const r = this.expandWordString(e.r);
        if (op === '<') return l < r;
        if (op === '>') return l > r;
        if (['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(op)) {
          const a = this.arith(l || '0'), b = this.arith(r || '0');
          return { '-eq': a === b, '-ne': a !== b, '-lt': a < b, '-le': a <= b, '-gt': a > b, '-ge': a >= b }[op];
        }
        return this.binaryFileTest(op, l, r);
      }
    }
    return false;
  }

  unaryTest(op, v) {
    const fs = this.fs;
    const st = (follow = true) => { try { return follow ? fs.stat(v, this.cwd) : fs.lstat(v, this.cwd); } catch { return null; } };
    switch (op) {
      case '-z': return v === '';
      case '-n': return v !== '';
      case '-e': case '-a': return !!st();
      case '-f': { const n = st(); return !!n && n.type === 'f'; }
      case '-d': { const n = st(); return !!n && n.type === 'd'; }
      case '-L': case '-h': { const n = st(false); return !!n && n.type === 'l'; }
      case '-s': { const n = st(); return !!n && n.size > 0 && n.type !== 'd' || (!!n && n.type === 'd'); }
      case '-r': case '-w': return !!st();
      case '-x': { const n = st(); return !!n && (n.type === 'd' || (n.mode & 0o111) !== 0); }
      case '-p': { const n = st(); return !!n && n.type === 'p'; }
      case '-c': { const n = st(); return !!n && n.type === 'c'; }
      case '-b': case '-S': return false;
      case '-g': { const n = st(); return !!n && (n.mode & 0o2000) !== 0; }
      case '-u': { const n = st(); return !!n && (n.mode & 0o4000) !== 0; }
      case '-k': { const n = st(); return !!n && (n.mode & 0o1000) !== 0; }
      case '-O': case '-G': return !!st();
      case '-N': { const n = st(); return !!n && n.mtime > n.atime; }
      case '-t': return false;
      case '-v': {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/.exec(v);
        if (!m) return false;
        if (m[2] !== undefined) { const val = this.arrayElem(m[1], m[2], null); return val !== undefined; }
        return this.isSet(m[1]);
      }
      case '-R': return false;
      case '-o': return !!this.opts[v];
    }
    return false;
  }

  binaryFileTest(op, l, r) {
    const st = (p) => { try { return this.fs.stat(p, this.cwd); } catch { return null; } };
    const a = st(l), b = st(r);
    if (op === '-nt') return !!a && (!b || a.mtime > b.mtime);
    if (op === '-ot') return !!b && (!a || a.mtime < b.mtime);
    if (op === '-ef') return !!a && !!b && a === b;
    return false;
  }

  // ------------------------------------------------------------ simple commands
  execSimple(node, io) {
    const dt = this.traps.get('DEBUG');
    if (dt && !this.inDebugTrap && (this.funcStack.length === 0 || this.opts.functrace)) {
      const st0 = this.status;
      this.inDebugTrap = true;
      try { this.runString(dt, io, { kind: 'trap', name: 'DEBUG trap' }); } finally { this.inDebugTrap = false; this.status = st0; }
    }
    this.line = node.line || this.line;
    let argv;
    this.cmdSubStatus = null;
    try {
      argv = this.expandWords(node.words, { decl: node.words.length && isDeclWord(node.words[0]) });
    } catch (e) {
      if (e instanceof ShellAbort) throw e;
      throw e;
    }
    // Assignments only
    if (argv.length === 0) {
      for (const a of node.assigns) {
        this.doAssign(a, {});
        if (this.opts.xtrace) this.xtraceAssign(io, a, a.array ? '' : (a.index !== null && a.index !== undefined ? this.assignPreviewRaw(a) : this.getVar(a.name) ?? ''));
      }
      let rio;
      try { rio = this.applyRedirs(node.redirs, io); } catch (e) {
        if (e instanceof RedirError) { this.shellError(io, e.message); return e.status; }
        throw e;
      }
      rio.finish();
      return this.cmdSubStatus !== null ? this.cmdSubStatus : 0;
    }
    const name = argv[0];
    this.lastArg = argv[argv.length - 1];
    if (this.opts.xtrace) {
      for (const a of node.assigns) this.xtraceAssign(io, a, a.array ? '' : this.assignPreviewRaw(a));
      // declaration builtins: `declare -a f=(1 2)` traces "f=('1' '2')", then "declare -a f"
      for (const a of argv) {
        if (typeof a === 'object' && a && a.declArray) {
          const el = (e) => (e.keyText !== undefined ? `[${sq(this.expandWordString(e.key))}]=` : '') + sq(this.expandWordString(e.value));
          this.xtrace(io, `${a.declArray.name}=(${a.declArray.array.map(el).join(' ')})`);
        }
      }
      this.xtrace(io, argv.map(a => (typeof a === 'object' && a && a.declArray ? a.declArray.name : this.xq(a))).join(' '));
    }

    let rio;
    try { rio = this.applyRedirs(node.redirs, io); } catch (e) {
      if (e instanceof RedirError) { this.shellError(io, e.message); return e.status; }
      throw e;
    }
    try {
      // temporary assignments: bash refuses array elements and readonly names here, says so, and
      // runs the command anyway
      if (node.assigns.length) {
        const ok = [];
        for (const a of node.assigns) {
          if (a.index !== null && a.index !== undefined) { this.shellError(io, `\`${a.name}[${a.indexText ?? ''}]': not a valid identifier`); continue; }
          const rv = a.array ? null : this.lookupVar(a.name);
          if (rv && rv.readonly) { this.shellError(io, `${a.name}: readonly variable`); continue; }
          ok.push(a);
        }
        if (ok.length !== node.assigns.length) node = { ...node, assigns: ok };
      }
      const isSpecial = SPECIAL_BUILTINS.has(name);
      const isFunc = this.functions.has(name);
      const isBuiltin = !!BUILTINS[name];
      if (node.assigns.length && (isFunc || isBuiltin)) {
        if (isSpecial) {
          for (const a of node.assigns) this.doAssign(a, {});
          return this.invoke(argv, rio.io, null);
        }
        this.scopes.push(new Map());
        try {
          for (const a of node.assigns) { this.doAssign(a, { local: true }); const v = this.scopes[this.scopes.length - 1].get(a.name); if (v) v.exported = true; }
          return this.invoke(argv, rio.io, null);
        } finally { this.scopes.pop(); }
      }
      if (name === 'exec' && argv.length === 1) {
        // permanent redirections for the rest of this shell
        for (const k of Object.keys(io.fds)) if (!(k in rio.io.fds)) delete io.fds[k];
        Object.assign(io.fds, rio.io.fds);
        return 0;
      }
      let envAdd = null;
      if (node.assigns.length) {
        envAdd = {};
        for (const a of node.assigns) envAdd[a.name] = this.expandAssignValue(a);
      }
      return this.invoke(argv, rio.io, envAdd);
    } finally {
      rio.finish();
      if (this.pendingProcOut) { const pend = this.pendingProcOut; this.pendingProcOut = null; for (const f of pend) f(); }
      if (this.procFiles) { for (const p of this.procFiles) { try { this.fs.unlink(p, '/'); } catch {} } this.procFiles = null; }
    }
  }

  // PS4 with its first character repeated once per level of indirection
  ps4() {
    let p = this.getVar('PS4');
    if (!p) return '';
    if (p.includes('$')) p = p.replace(/\$\{?LINENO\}?/g, String(this.line)).replace(/\$\{?BASH_SOURCE\}?/g, this.srcName ?? '').replace(/\$\{?FUNCNAME\}?/g, this.funcStack[this.funcStack.length - 1] ?? '');
    return p[0].repeat(this.xlevel) + p.slice(1);
  }
  xtrace(io, text) { if (this.opts.xtrace) this.writeFd(io, 2, this.ps4() + text + '\n'); }
  // traced words are quoted the way bash's xtrace does it
  xq(w) { return xtraceQuote(w); }
  xtraceAssign(io, a, value) {
    if (!this.opts.xtrace) return;
    const lhs = a.name + (a.index !== null && a.index !== undefined ? `[${a.indexText ?? ''}]` : '') + (a.append ? '+' : '');
    if (a.array) this.xtrace(io, `${lhs}=(${a.arrayText ?? ''})`);
    else this.xtrace(io, `${lhs}=${value === '' ? '' : xtraceQuote(value)}`);
  }

  assignPreview(a) { try { return shellQuote(this.expandAssignValue(a)); } catch { return ''; } }
  assignPreviewRaw(a) { try { return this.expandAssignValue(a); } catch { return ''; } }

  expandAssignValue(a) {
    if (a.array) return '(' + a.array.map(e => this.expandWordString(e.value)).join(' ') + ')';
    return a.value ? this.expandWordString(a.value, { assign: true }) : '';
  }

  doAssign(a, { local = false, decl = false } = {}) {
    if (a.array) {
      const v0 = this.lookupVar(a.name);
      const isAssoc = !!(v0 && v0.assoc);
      const io = this.curIo || { fds: {} };
      // the declaration builtins get the list back quoted, which shows in these messages
      const sq1 = (x) => "'" + x.replace(/'/g, "'\\''") + "'";
      const shown = (el) => (decl ? sq1(this.expandWordString(el.value)) : wordSrc(el.value));
      const asWord = (el) => (el.keyText === undefined ? this.expandWordString(el.value) : `[${this.expandWordString(el.key)}]${el.appendElem ? '+=' : '='}${this.expandWordString(el.value, { assign: true })}`);
      // bash expands the whole list before it touches the array, so `a=("${a[@]}" x)` and
      // `m=([k]="${m[j]}")` still see the old elements
      let items = [];
      if (isAssoc && a.array.length && a.array[0].keyText === undefined) {
        // bash 5.1: `m=(k1 v1 k2 v2)` is a list of key/value pairs (no splitting or globbing)
        for (let i = 0; i < a.array.length; i += 2) {
          const key = asWord(a.array[i]);
          if (key === '') { this.shellError(io, `${decl ? sq1('') : wordSrc(a.array[i].value)}: bad array subscript`); continue; }
          items.push({ key, value: i + 1 < a.array.length ? asWord(a.array[i + 1]) : '' });
        }
      } else {
        for (const el of a.array) {
          if (el.keyText === undefined) {
            if (isAssoc) { this.shellError(io, `${a.name}: ${shown(el)}: must use subscript when assigning associative array`); continue; }
            items.push({ vals: this.expandWords([el.value]) });
          } else if (isAssoc) {
            const key = this.expandWordString(el.key);
            if (key === '') { this.shellError(io, `[${el.keyText}]=${decl ? sq1(this.expandWordString(el.value, { assign: true })) : wordSrc(el.value)}: bad array subscript`); continue; }
            items.push({ key, value: this.expandWordString(el.value, { assign: true }), append: el.appendElem });
          } else items.push({ index: this.expandWordString(el.key), value: this.expandWordString(el.value, { assign: true }), append: el.appendElem });
        }
      }
      if (!a.append) {
        const scope = local ? this.scopes[this.scopes.length - 1] : this.findScopeFor(a.name);
        let v = scope.get(a.name);
        if (v && v.readonly) throw new ShellAbort(1, `${a.name}: readonly variable`);
        if (!v) { v = new Var(); scope.set(a.name, v); }
        if (isAssoc) v.assoc = new Map(); else { v.arr = new Map(); v.value = null; }
      }
      let next = 0;
      if (!this.lookupVar(a.name)) (local ? this.scopes[this.scopes.length - 1] : this.scopes[0]).set(a.name, new Var());
      const v = this.lookupVar(a.name);
      if (!v.arr && !v.assoc && v.value === null) { v.arr = new Map(); }
      if (v.arr && a.append) { const keys = sortedKeys(v.arr); next = keys.length ? keys[keys.length - 1] + 1 : 0; }
      if (v.value !== null && !v.arr && !v.assoc) { v.arr = new Map([[0, v.value]]); v.value = null; next = a.append ? 1 : 0; }
      v.invisible = false;
      for (const it of items) {
        if (it.key !== undefined) { v.assoc.set(it.key, (it.append ? v.assoc.get(it.key) ?? '' : '') + it.value); continue; }
        if (it.index !== undefined) {
          next = Number(this.arith(it.index));
          if (next < 0) { const keys = sortedKeys(v.arr); next += keys.length ? keys[keys.length - 1] + 1 : 0; }
          v.arr.set(next, (it.append ? v.arr.get(next) ?? '' : '') + it.value);
          next++;
        } else {
          for (const x of it.vals) {
            if (v.assoc) v.assoc.set(String(next++), x);
            else v.arr.set(next++, x);
          }
        }
      }
      return;
    }
    const value = a.value ? this.expandWordString(a.value, { assign: true }) : '';
    if (a.index) {
      const v = this.lookupVar(a.name);
      if (v && v.assoc) this.setArrayElem(a.name, this.expandWordString(parseSubscript(a.indexText)), value, { local, append: a.append });
      else this.setArrayElem(a.name, Number(this.arithWord(a.index)), value, { local, append: a.append });
      return;
    }
    this.setVar(a.name, value, { local, append: a.append });
  }

  // Run a command by argv with function/builtin/external lookup.
  invoke(argv, io, envAdd, { noFunc = false, noBuiltin = false } = {}) {
    const name = argv[0];
    if (!noFunc && this.functions.has(name)) return this.callFunction(name, argv.slice(1), io);
    if (!noBuiltin && BUILTINS[name] && (!this.dash || DASH_BUILTINS.has(name))) {
      try {
        return BUILTINS[name](this, argv, io) ?? 0;
      } catch (e) {
        if (e instanceof PipeLimit) return 141;
        throw e;
      }
    }
    return this.runExternal(argv, io, envAdd);
  }

  callFunction(name, args, io) {
    if (this.funcStack.length > 1000) throw new ShellAbort(1, `${name}: maximum function nesting level exceeded (1000)`);
    const body = this.functions.get(name);
    const savedPos = this.positional, savedOpt = this.dashOpt;
    this.positional = args;
    if (this.dash) this.dashOpt = { optind: 1, optoff: -1 };
    this.scopes.push(new Map());
    this.funcStack.push(name);
    const savedSrc = this.srcName;
    this.srcName = this.funcSrc.get(name) ?? savedSrc;
    try {
      return this.execCommand(body, io);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.code;
      if (e instanceof ShellAbort && e.prefix === undefined) e.prefix = this.errPrefix();   // reported where it happened
      throw e;
    } finally {
      this.srcName = savedSrc;
      this.funcStack.pop();
      this.scopes.pop();
      this.positional = savedPos;
      this.dashOpt = savedOpt;
    }
  }

  // Locate an executable: returns { path, node } or null.
  findExecutable(name, PATH = this.getVar('PATH') ?? '') {
    if (name.includes('/')) {
      const r = this.fs.tryResolve(name, this.cwd, {});
      return r ? { path: name, node: r.node } : null;
    }
    // an unset or empty PATH searches only the current directory
    for (const dir of PATH.split(':')) {
      const p = joinPath(dir || '.', name);
      const r = this.fs.tryResolve(p, this.cwd, {});
      if (r && r.node.type === 'f' && (r.node.mode & 0o111)) return { path: p, node: r.node };
    }
    if (this.trusted && this.commands.has(name)) return { path: '/usr/bin/' + name, node: { type: 'f', mode: 0o755, exe: name } };
    return null;
  }

  // dash looks a pipeline stage's command up before forking it, so the parent's table learns it too
  dashPrehash(c) {
    const w = c.t === 'simple' && c.words.length ? c.words[0] : null;
    if (!w || w.parts.length !== 1 || w.parts[0].t !== 'lit' || !isName(w.parts[0].v)) return;
    const name = w.parts[0].v;
    if (this.functions.has(name) || DASH_BUILTINS.has(name) || this.hashed.has(name)) return;
    const f = this.findExecutable(name);
    if (f) this.hashed.set(name, { path: f.path, hits: 0 });
  }

  // a PATH search that goes through the hash table: both shells remember where they found a
  // command (bash: "hashed", dash: "tracked alias") and go straight there next time, even if the
  // file has gone since. A PATH given just for this command bypasses the table.
  findCommand(name, envAdd) {
    if (name.includes('/') || (envAdd && 'PATH' in envAdd) || this.opts.hashall === false) return this.findExecutable(name);
    const h = this.hashed.get(name);
    if (h) {
      h.hits++;
      const r = this.fs.tryResolve(h.path, this.cwd, {});
      if (r) return { path: h.path, node: r.node };
      if (this.trusted && this.commands.has(name) && h.path === '/usr/bin/' + name) return { path: h.path, node: { type: 'f', mode: 0o755, exe: name } };
      return { path: h.path, node: null, stale: true };
    }
    const f = this.findExecutable(name);
    if (f) this.hashed.set(name, { path: f.path, hits: 1 });
    return f;
  }

  runExternal(argv, io, envAdd) {
    const name = argv[0];
    const found = name === '' ? null : this.findCommand(name, envAdd);
    if (found && found.stale) {
      this.shellError(io, this.dash ? `${name}: not found` : `${found.path}: No such file or directory`);
      return 127;
    }
    if (!found) {
      if (name === '' && this.dash) { this.shellError(io, ': Permission denied'); return 127; }
      if ((name.includes('/') || !this.getVar('PATH')) && !this.dash) { this.shellError(io, `${printableName(name)}: No such file or directory`); return 127; }
      this.shellError(io, this.dash ? `${name}: not found` : `${printableName(name)}: command not found`);
      return 127;
    }
    const node = found.node;
    if (node.type === 'd') { this.shellError(io, `${name}: Is a directory`); return 126; }
    if (!(node.mode & 0o111)) { this.shellError(io, `${name}: Permission denied`); return 126; }
    const env = { ...this.exportedEnv(), ...(envAdd || {}) };
    if (node.exe) return this.runRegistry(node.exe, argv, io, env);
    return this.runScriptFile(found.path, node, argv, io, env);
  }

  runRegistry(cmdName, argv, io, env) {
    const impl = this.commands.get(cmdName);
    if (!impl) { this.shellError(io, `${argv[0]}: command not found`); return 127; }
    if (!NATIVE_HELP.has(cmdName)) {
      const h = argv.indexOf('--help'), dd = argv.indexOf('--');
      if (h > 0 && (dd < 0 || h < dd)) { const t = helpText(cmdName); if (t !== null) { this.writeFd(io, 1, t); return 0; } }
    }
    const ctx = this.makeCtx(argv, io, env);
    try {
      const r = impl(ctx);
      return r === undefined ? 0 : r;
    } catch (e) {
      if (e instanceof PipeLimit) return 141;
      if (e instanceof FsError) { ctx.err(`${e.path}: ${e.message}`); return 1; }
      throw e;
    }
  }

  runScriptFile(path, node, argv, io, env) {
    const data = node.data || '';
    // a copy of one of the system's binaries still runs as that command
    if (data.startsWith(ELF_HEADER) && this.commands.has(data.slice(ELF_HEADER.length))) return this.runRegistry(data.slice(ELF_HEADER.length), argv, io, env);
    // bash won't run a file whose first line (of up to 80 bytes) has a NUL in it
    if (!this.dash && /^[^\n]*\0/.test(data.slice(0, 80))) { this.shellError(io, `${argv[0]}: cannot execute binary file: Exec format error`); return 126; }
    const m = /^#!\s*(\S+)(?:[ \t]+([^\n]*))?/.exec(data);
    if (m) {
      let interp = m[1];
      let iargs = m[2] ? [m[2].trim()] : [];
      if (pbase(interp) === 'env' && iargs.length) { const parts = iargs[0].split(/\s+/); interp = parts[0]; iargs = parts.slice(1); }
      const ib = pbase(interp);
      if (ib !== 'bash' && ib !== 'sh' && ib !== 'dash') {
        return this.invoke([ib, ...iargs, path, ...argv.slice(1)], io, env, { noFunc: true, noBuiltin: true });
      }
    }
    return this.runChildShell(data, io, env, { arg0: argv[0], args: argv.slice(1), scriptMode: true });
  }

  // Run a script in a fresh child shell (like executing `bash script`).
  runChildShell(src, io, env, { arg0 = 'bash', args = [], interactive = false, setopts = {}, shopt = {}, scriptMode = false, dash = false } = {}) {
    if (++this.limits.depth > 60) { this.limits.depth--; this.shellError(io, 'maximum shell nesting reached'); return 1; }
    const child = new Shell({
      fs: this.fs, commands: this.commands, cwd: this.cwd, env, procs: this.procs, limits: this.limits,
      arg0, args, pid: this.pid + 1 + this.limits.depth, ppid: this.pid, nobin: this.nobin, game: this.game, seed: this.random(),
      setopts, shopt: { globstar: false, ...shopt }, interactive, scriptMode, trusted: this.trusted, dash,
    });
    try { return child.run(src, io); }
    finally { this.limits.depth--; }
  }

  // Context object handed to registry commands.
  makeCtx(argv, io, env) {
    const sh = this;
    const stdin = io.fds[0] instanceof InStream ? io.fds[0] : new InStream('');
    const stdout = io.fds[1] && io.fds[1].write ? io.fds[1] : new NullSink();
    const stderr = io.fds[2] && io.fds[2].write ? io.fds[2] : new NullSink();
    const name = pbase(argv[0]);
    return {
      argv, name, env, io, sh,
      stdin, stdout, stderr,
      cwd: sh.cwd,
      fs: sh.fs,
      out(s) { stdout.write(s); },
      err(msg) { stderr.write(`${name}: ${msg}\n`); },
      readFile(path) { return sh.readPath(path, stdin); },
      openWrite(path, append = false) { return sh.openWritePath(path, io, append); },
      resolve(path) { return sh.fs.resolve(path, sh.cwd); },
      spawn(args, opts = {}) {
        // execute an external command (no shell functions), e.g. find -exec / xargs
        const fds = { ...io.fds };
        if (opts.stdin !== undefined) fds[0] = new InStream(opts.stdin);
        if (opts.stdout) fds[1] = opts.stdout;
        if (opts.stderr) fds[2] = opts.stderr;
        const cwdSave = sh.cwd;
        if (opts.cwd) sh.cwd = opts.cwd;
        try {
          sh.tick();
          if (BUILTINS[args[0]] && ['echo', 'printf', 'test', '[', 'true', 'false', 'pwd', 'kill'].includes(args[0])) {
            const found = sh.findExecutable(args[0]);
            if (found && found.node.exe) return sh.runRegistry(found.node.exe, args, { fds }, opts.env || env);
          }
          return sh.runExternalEnv(args, { fds }, opts.env || env);
        } finally { sh.cwd = cwdSave; }
      },
      runShell(src, opts = {}) {
        // run a shell command line (awk system(), etc.)
        const fds = { ...io.fds };
        if (opts.stdin !== undefined) fds[0] = new InStream(opts.stdin);
        if (opts.stdout) fds[1] = opts.stdout;
        return sh.runChildShell(src, { fds }, opts.env || env, { arg0: 'sh', dash: true });   // /bin/sh -c
      },
      tick() { sh.tick(); },
    };
  }

  runExternalEnv(argv, io, env) {
    const found = this.findExecutable(argv[0]);
    if (!found) {
      this.writeFd(io, 2, `${argv[0]}: No such file or directory\n`);
      return 127;
    }
    if (found.node.exe) return this.runRegistry(found.node.exe, argv, io, env);
    return this.runScriptFile(found.path, found.node, argv, io, env);
  }

  randomBytes(n) {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = this.random() & 255;
    let s = '';
    for (let i = 0; i < n; i += 8192) s += String.fromCharCode.apply(null, a.slice(i, i + 8192));
    return s;
  }

  // Read a path for a command (handles /dev/stdin, process substitutions, '-').
  readPath(path, stdin) {
    if (path === '-' || path === '/dev/stdin' || path === '/proc/self/fd/0' || path === '/dev/fd/0') return stdin ? stdin.readAll() : '';
    // endless devices: a bounded prefix (enough for `head -c 16M`-sized reads)
    if (path === '/dev/zero') return zeroDev();
    if (path === '/dev/urandom' || path === '/dev/random') return this.randomBytes(1 << 20);
    const r = this.fs.resolve(path, this.cwd);
    if (r.node.type === 'd') throw new FsError('EISDIR', path);
    if (r.node.type === 'c') {
      if (r.node.dev === 'null') return '';
      if (r.node.dev === 'zero') return zeroDev();
      if (r.node.dev === 'urandom') return this.randomBytes(1 << 20);
      return '';
    }
    r.node.atime = this.fs.now();
    return r.node.data || '';
  }

  openWritePath(path, io, append) {
    if (path === '/dev/stdout' || path === '/dev/fd/1' || path === '/proc/self/fd/1') return io.fds[1] || new NullSink();
    if (path === '/dev/stderr' || path === '/dev/fd/2' || path === '/proc/self/fd/2') return io.fds[2] || new NullSink();
    if (path === '/dev/null' || path === '/dev/zero' || path === '/dev/urandom') return new NullSink();
    if (path === '/dev/tty') return io.fds[1] || new NullSink();
    const m = /^\/dev\/fd\/(\d+)$/.exec(path);
    if (m && io.fds[+m[1]] && io.fds[+m[1]].write) return io.fds[+m[1]];
    const n = this.fs.openWrite(path, this.cwd, append);
    if (n.type === 'c') return new NullSink();
    return new FileSink(n, this.fs);
  }

  // ------------------------------------------------------------ redirections
  applyRedirs(redirs, io) {
    const fds = { ...io.fds };
    const post = [];
    for (const r of redirs || []) {
      let fd = r.fd;
      if (fd && typeof fd === 'object') {
        // {var}>file : allocate fd >= 10
        let n = 10; while (fds[n]) n++;
        this.setVar(fd.varName, String(n));
        fd = n;
      }
      const op = r.op;
      if (op === '<<' || op === '<<-') {
        const h = r.heredoc;
        let body = h.body || '';
        if (!h.quoted) body = this.expandHeredoc(body);
        fds[fd ?? 0] = new InStream(body, null, true);
        continue;
      }
      if (op === '<<<') {
        const s = this.expandWordString(r.target);
        fds[fd ?? 0] = new InStream(s + '\n', null, true);
        continue;
      }
      const target = this.expandRedirTarget(r.target);
      if (op === '<' || op === '<>') {
        try {
          if (op === '<>' && !this.fs.exists(target, this.cwd)) this.fs.writeFile(target, '', this.cwd);
          const data = this.readPath(target, io.fds[0]);
          const rn = this.fs.tryResolve(target, this.cwd);
          fds[fd ?? 0] = rn && rn.node.type === 'f' && !/^\/dev\/|^\/proc\//.test(target) ? new FileInStream(rn.node, target) : new InStream(data, target, true);
        } catch (e) {
          if (e instanceof FsError) throw this.redirFail(target, e, false);
          throw e;
        }
        continue;
      }
      if (op === '>' || op === '>>' || op === '>|' || op === '&>' || op === '&>>') {
        let sink;
        if ((op === '>' || op === '&>') && this.opts.noclobber) {
          // set -C: `>` won't truncate an existing regular file (`>|` will)
          const ex = this.fs.tryResolve(target, this.cwd, {});
          if (ex && ex.node.type === 'f') throw new RedirError(`${target}: cannot overwrite existing file`);
        }
        try { sink = this.openWritePath(target, { fds }, op === '>>' || op === '&>>'); }
        catch (e) { if (e instanceof FsError) throw this.redirFail(target, e, true); throw e; }
        if (op === '&>' || op === '&>>') { fds[1] = sink; fds[2] = sink; }
        else fds[fd ?? 1] = sink;
        continue;
      }
      if (op === '>&' || op === '<&') {
        const dflt = op === '>&' ? 1 : 0;
        if (target === '-') { delete fds[fd ?? dflt]; continue; }
        const m = /^(\d+)(-?)$/.exec(target);
        if (m) {
          const src = parseInt(m[1], 10);
          if (fds[src] === undefined) throw new RedirError(`${src}: Bad file descriptor`, this.dash ? 2 : 1);
          fds[fd ?? dflt] = fds[src];
          if (m[2]) delete fds[src];
          continue;
        }
        if (op === '>&' && fd === null) {
          // >& word  ==  &> word
          let sink;
          try { sink = this.openWritePath(target, { fds }, false); } catch (e) { if (e instanceof FsError) throw new RedirError(`${target}: ${e.message}`); throw e; }
          fds[1] = sink; fds[2] = sink;
          continue;
        }
        throw new RedirError(`${target}: ambiguous redirect`);
      }
    }
    return { io: { fds }, finish: () => { for (const f of post) f(); } };
  }

  expandRedirTarget(word) {
    const fields = this.expandWords([word]);
    if (fields.length !== 1) throw new RedirError(`${wordLiteral(word)}: ambiguous redirect`);
    return fields[0];
  }

  // ------------------------------------------------------------ expansion
  // Expand a list of words into argv fields (brace, tilde, params, cmdsub, arith, split, glob).
  expandWords(words, { decl = false } = {}) {
    const out = [];
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi];
      if (decl && wi > 0 && w.assign) {
        // declaration builtin assignment argument: no split/glob on value
        const a = w.assign;
        if (a.array) { out.push({ declArray: a }); continue; }
        const val = a.value ? this.expandWordString(a.value, { assign: true }) : '';
        out.push(a.name + (a.indexText !== null && a.indexText !== undefined ? '[' + a.indexText + ']' : '') + (a.append ? '+=' : '=') + val);
        continue;
      }
      for (const bw of (this.dash ? [w] : this.braceExpand(w))) {
        const fields = this.expandParts(bw.parts, true);
        for (const f of fields) this.globField(f, out);
      }
    }
    return out;
  }

  // Expand a single word to one string (no splitting/globbing) — assignments, case, [[ ]], redirects.
  expandWordString(word, { assign = false, arith = false } = {}) {
    if (!word) return '';
    const fields = this.expandParts(word.parts, false, { assign, arith });
    return fields.map(f => f.v).join(' ');
  }

  // Expand a word into a glob pattern (quoted parts escaped) for case/[[ ==/param ops.
  expandPattern(word) {
    if (!word) return '';
    const fields = this.expandParts(word.parts, false);
    return fields.map(f => f.p).join(' ');
  }

  // RHS of =~ : quoted parts become literal regex text.
  expandRegexWord(word) {
    let out = '';
    for (const p of word.parts) {
      if (p.t === 'lit') out += p.v;
      else if (p.t === 'sq' || p.t === 'ansi') out += p.v.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
      else if (p.t === 'esc') out += /[\\^$.*+?()[\]{}|]/.test(p.v) ? '\\' + p.v : p.v;
      else if (p.t === 'dq') out += this.expandParts([p], false).map(f => f.v).join('').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
      else out += this.expandParts([p], false).map(f => f.v).join('');
    }
    return out;
  }

  expandHeredoc(body) {
    // parameter/command/arith expansion; backslash escapes only \$ \` \\ \newline
    const parts = [];
    let buf = '';
    const p = new Parser(body);
    while (p.i < body.length) {
      const c = body[p.i];
      if (c === '\\') {
        const d = body[p.i + 1];
        if (d === '$' || d === '`' || d === '\\') { buf += d; p.i += 2; continue; }
        if (d === '\n') { p.i += 2; continue; }
        buf += c; p.i++; continue;
      }
      if (c === '$') {
        let r;
        try { r = p.readDollar(true); } catch { buf += c; p.i++; continue; }
        if (r.t === 'lit') { buf += r.v; continue; }
        if (buf) { parts.push({ t: 'text', v: buf }); buf = ''; }
        parts.push(r); continue;
      }
      if (c === '`') {
        if (buf) { parts.push({ t: 'text', v: buf }); buf = ''; }
        try { parts.push(p.readBackquote()); } catch { buf += c; p.i++; }
        continue;
      }
      buf += c; p.i++;
    }
    if (buf) parts.push({ t: 'text', v: buf });
    return this.expandParts([{ t: 'dq', parts }], false).map(f => f.v).join('');
  }

  // Core expansion: parts -> fields [{v, p, g, q}]
  expandParts(parts, split, opts = {}) {
    const ifs = this.getVar('IFS') ?? DEFAULT_IFS;
    const fields = [];
    let cur = { v: '', p: '', g: false, q: false, keep: false };
    const endField = (force) => {
      if (cur.v !== '' || cur.q || force || cur.keep) fields.push(cur);
      cur = { v: '', p: '', g: false, q: false, keep: false };
    };
    const addQuoted = (s) => {
      cur.v += s;
      for (const ch of s) cur.p += GLOB_SPECIAL.has(ch) ? '\\' + ch : ch;
      cur.q = true;
    };
    const addLit = (s) => {
      cur.v += s; cur.p += s;
      if (/[*?[]/.test(s) || /[+@!]\(/.test(s)) cur.g = true;
      if (s !== '') cur.keep = true;
    };
    // splittable expansion result
    let afterWs = false;
    const addExp = (s, quotedCtx) => {
      if (quotedCtx || !split) { if (quotedCtx) addQuoted(s); else { cur.v += s; cur.p += s.replace(/\\/g, '\\\\'); if (/[*?[]/.test(s)) cur.g = true; if (s !== '') cur.keep = true; } return; }
      for (const ch of s) {
        if (ifs.includes(ch)) {
          if (ch === ' ' || ch === '\t' || ch === '\n') {
            if (cur.v !== '' || cur.q || cur.keep) { endField(false); afterWs = true; }
            continue;
          }
          if (afterWs) { afterWs = false; continue; }
          endField(true);
          continue;
        }
        afterWs = false;
        cur.v += ch;
        cur.p += ch === '\\' ? '\\\\' : ch;
        if (ch === '*' || ch === '?' || ch === '[') cur.g = true;
        cur.keep = true;
      }
    };
    const multi = (vals, quotedCtx) => {
      // "$@"-style: each value its own field
      vals.forEach((val, i) => {
        if (i > 0) { if (quotedCtx) endField(true); else { if (cur.v !== '' || cur.q || cur.keep) endField(false); } }
        if (quotedCtx) addQuoted(val); else addExp(val, false);
      });
    };

    for (const part of parts) {
      switch (part.t) {
        case 'lit': {
          let v = part.v;
          if (opts.assign) v = this.tildeInAssign(v, cur.v === '');
          addLit(v);
          afterWs = false;
          break;
        }
        case 'esc': addQuoted(part.v); afterWs = false; break;
        case 'sq': case 'ansi': addQuoted(part.v); afterWs = false; break;
        case 'text': addQuoted(part.v); break;
        case 'tilde': addQuoted(this.tildeValue(part.user)); break;
        case 'dq': {
          let hadAt = false, atEmpty = true, other = false;
          for (const ip of part.parts) {
            if (ip.t === 'text') { addQuoted(ip.v); other = true; continue; }
            if (ip.t === 'param' && this.isMultiParam(ip)) {
              const vals = this.paramMulti(ip);
              hadAt = true;
              if (vals.length) atEmpty = false;
              if (ip.name === '*' || ip.index === '*' || (ip.op === 'keys' && ip.index === '*') || (ip.op === 'names' && ip.star)) {
                const sep = ifs === '' ? '' : (ifs[0] ?? ' ');
                addQuoted(vals.join(sep)); other = true;
              } else multi(vals, true);
              continue;
            }
            other = true;
            addQuoted(this.expandPart(ip, true));
          }
          if (!(hadAt && atEmpty && !other)) cur.q = true;
          break;
        }
        case 'param': {
          if (this.isMultiParam(part)) {
            const vals = this.paramMulti(part);
            if (!split) {
              const sep = (part.name === '*' || part.index === '*') ? (ifs[0] ?? '') : ' ';
              addExp(vals.join(sep), false);
            } else multi(vals, false);
            break;
          }
          addExp(this.expandPart(part, false), false);
          break;
        }
        case 'cmd': case 'arith': case 'badsubst':
          addExp(this.expandPart(part, false), false);
          break;
        case 'proc':
          addQuoted(this.procSubst(part));
          break;
        default:
          addExp(this.expandPart(part, false), false);
      }
    }
    if (cur.v !== '' || cur.q || cur.keep) fields.push(cur);
    if (!split) {
      // join everything into a single field (no splitting context)
      if (fields.length === 0) return [{ v: '', p: '', g: false, q: true }];
      if (fields.length === 1) return fields;
      return [{ v: fields.map(f => f.v).join(' '), p: fields.map(f => f.p).join(' '), g: fields.some(f => f.g), q: true }];
    }
    return fields;
  }

  tildeInAssign(v, atStart) {
    // ~ after = (start of value) or after ':' in assignments
    return v.replace(/(^|:)~([A-Za-z0-9_.+-]*)(?=\/|:|$)/g, (m, pre, user) => (pre === '' && !atStart) ? m : pre + this.tildeValue(user));
  }

  tildeValue(user) {
    if (user === '') return this.getVar('HOME') ?? '/root';
    if (user === '+') return this.getVar('PWD') ?? this.cwd;
    if (user === '-') return this.getVar('OLDPWD') ?? '~-';
    if (user === 'root') return '/root';
    if (this.fs.exists('/home/' + user)) return '/home/' + user;
    return '~' + user;
  }

  isMultiParam(p) {
    if (p.op === 'keys' || p.op === 'names') return true;
    if (p.indirect) return false;
    if (p.op === 'len') return false;
    if (p.name === '@' || p.name === '*') return !p.op || p.op === ':' || ['#', '##', '%', '%%', '/', '//', '/#', '/%', '^', '^^', ',', ',,', '@'].includes(p.op) || (p.op && /^[-=?+:]/.test(p.op) && false);
    if (p.index === '@' || p.index === '*') return !p.op || p.op === ':' || ['#', '##', '%', '%%', '/', '//', '/#', '/%', '^', '^^', ',', ',,', '@'].includes(p.op);
    return false;
  }

  paramMulti(p) {
    if (p.op === 'keys') return this.arrayKeys(p.name);
    if (p.op === 'names') {
      const names = new Set();
      for (const sc of this.scopes) for (const k of sc.keys()) if (k.startsWith(p.name)) names.add(k);
      return [...names].sort(byteCmp);
    }
    let vals = (p.name === '@' || p.name === '*') ? [...this.positional] : this.arrayValues(p.name);
    if (p.op === ':') {
      // array slice
      let off = Number(this.arithWord(p.off));
      if (p.name === '@' || p.name === '*') {
        const all = [this.arg0, ...this.positional];
        if (off < 0) off = all.length + off;
        let res = all.slice(Math.max(off, 0));
        if (p.len) { const len = Number(this.arithWord(p.len)); res = len < 0 ? res.slice(0, len) : res.slice(0, len); }
        if (off === 0) return res; // includes $0
        return res;
      }
      if (off < 0) off = vals.length + off;
      if (off < 0) return [];
      let res = vals.slice(off);
      if (p.len) { const len = Number(this.arithWord(p.len)); res = len < 0 ? res.slice(0, len) : res.slice(0, len); }
      return res;
    }
    if (p.op) return vals.map(v => this.applyParamOp(p, v, true));
    return vals;
  }

  expandPart(part, inDq) {
    switch (part.t) {
      case 'param': return this.expandParam(part, inDq);
      case 'cmd': return this.cmdSubst(part);
      case 'arith': return String(this.arithWord(part.expr));
      case 'text': return part.v;
      case 'badsubst': throw new ShellAbort(this.dash ? 2 : 1, this.dash ? 'Bad substitution' : `${part.text}: bad substitution`, !this.dash);
      case 'proc': return this.procSubst(part);
      case 'lit': case 'sq': case 'ansi': case 'esc': return part.v;
      case 'tilde': return this.tildeValue(part.user);
    }
    return '';
  }

  paramValue(p) {
    let name = p.name;
    if (p.indirect) {
      let target;
      if (p.index !== null && p.index !== undefined) target = (p.index === '@' || p.index === '*') ? this.arrayValues(name).join(' ') : this.arrayElem(name, null, p.index);
      else target = this.getVar(name);
      if (target === undefined) {
        if (this.dash) return undefined;
        throw new ShellAbort(1, `${name}: invalid indirect expansion`, true);
      }
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/.exec(target);
      if (!m) { if (/^[0-9]+$|^[@*#?$!-]$/.test(target)) return this.getVar(target); throw new ShellAbort(1, `${target}: invalid variable name`, true); }
      if (m[2] !== undefined) {
        if (m[2] === '@' || m[2] === '*') return this.arrayValues(m[1]).join(' ');
        return this.arrayElem(m[1], m[2], { parts: [{ t: 'dq', parts: [{ t: 'text', v: m[2] }] }] });
      }
      return this.getVar(m[1]);
    }
    if (p.index !== null && p.index !== undefined) {
      if (p.index === '@' || p.index === '*') { const vals = this.arrayValues(name); return vals.length ? vals.join(' ') : undefined; }
      return this.arrayElem(name, null, p.index);
    }
    if (name === '@' || name === '*') return this.positional.length ? this.positional.join(' ') : undefined;
    return this.getVar(name);
  }

  // set -u: bash names positional parameters with their `$` and array elements with the subscript
  unbound(p) {
    if (this.dash) return new ShellAbort(2, `${p.name}: parameter not set`);
    const sub = p.index !== null && p.index !== undefined ? (typeof p.index === 'string' ? p.index : p.index.text ?? wordLiteral(p.index)) : null;
    const name = /^[0-9]+$|^[-#?$!@*]$/.test(p.name) ? '$' + p.name : sub !== null ? `${p.name}[${sub}]` : p.name;
    return new ShellAbort(127, `${name}: unbound variable`);
  }

  expandParam(p, inDq) {
    if (this.dash && (p.indirect || p.index != null || ['/', '//', '/#', '/%', ':', '^', '^^', ',', ',,', '@', 'keys', 'names'].includes(p.op))) throw new ShellAbort(2, 'Bad substitution');
    if (p.op === 'len') {
      if (p.index === '@' || p.index === '*') return String(this.arrayValues(p.name).length);
      if (p.name === '@' || p.name === '*') return String(this.positional.length);
      const v = this.paramValue({ ...p, op: null });
      if (v === undefined && this.opts.nounset) throw this.unbound(p);
      return String((v || '').length);
    }
    let val = this.paramValue(p);
    const op = p.op;
    const unset = val === undefined;
    const nullv = unset || val === '';
    switch (op) {
      case null: case undefined:
        if (unset && this.opts.nounset && !(p.name === '@' || p.name === '*')) throw this.unbound(p);
        return val ?? '';
      case '-': return unset ? this.expandWordString(p.arg) : val;
      case ':-': return nullv ? this.expandWordString(p.arg) : val;
      case '=': case ':=': {
        if (op === '=' ? unset : nullv) {
          const nv = this.expandWordString(p.arg);
          if (!isName(p.name)) throw new ShellAbort(1, `$${p.name}: cannot assign in this way`, true);
          if (p.index !== null && p.index !== undefined) this.setArrayElem(p.name, Number(this.arithWord(p.index)), nv);
          else this.setVar(p.name, nv);
          return nv;
        }
        return val;
      }
      case '?': case ':?': {
        if (op === '?' ? unset : nullv) {
          const msg = p.arg && p.arg.parts.length ? this.expandWordString(p.arg) : (op === '?' ? 'parameter not set' : 'parameter null or not set');
          // bash exits with 127 for `bash -c`, 1 when running a script file
          throw new ShellAbort(this.dash ? 2 : this.scriptMode ? 1 : 127, `${p.name}: ${msg}`);
        }
        return val;
      }
      case '+': return unset ? '' : this.expandWordString(p.arg);
      case ':+': return nullv ? '' : this.expandWordString(p.arg);
    }
    if (unset && this.opts.nounset) throw this.unbound(p);
    return this.applyParamOp(p, val ?? '', false);
  }

  applyParamOp(p, val, multi) {
    const op = p.op;
    switch (op) {
      case ':': {
        let off = Number(this.arithWord(p.off));
        const len = val.length;
        if (off < 0) off = Math.max(0, len + off);
        if (off > len) return '';
        if (p.len) {
          let l = Number(this.arithWord(p.len));
          if (l < 0) { const end = len + l; if (end < off) throw new ShellAbort(1, `${l}: substring expression < 0`, true); return val.slice(off, end); }
          return val.slice(off, off + l);
        }
        return val.slice(off);
      }
      case '#': case '##': {
        const pat = this.expandPattern(p.arg);
        const re = globRegex(pat, { extglob: true });
        if (op === '#') { for (let k = 0; k <= val.length; k++) if (re.test(val.slice(0, k))) return val.slice(k); }
        else { for (let k = val.length; k >= 0; k--) if (re.test(val.slice(0, k))) return val.slice(k); }
        return val;
      }
      case '%': case '%%': {
        const pat = this.expandPattern(p.arg);
        const re = globRegex(pat, { extglob: true });
        if (op === '%') { for (let k = val.length; k >= 0; k--) if (re.test(val.slice(k))) return val.slice(0, k); }
        else { for (let k = 0; k <= val.length; k++) if (re.test(val.slice(k))) return val.slice(0, k); }
        return val;
      }
      case '/': case '//': case '/#': case '/%': {
        const pat = this.expandPattern(p.arg);
        const rep = p.arg2 ? this.expandWordString(p.arg2) : '';
        // an empty pattern anchored at either end prefixes/appends the replacement
        if (pat === '') return op === '/#' ? rep + val : op === '/%' ? val + rep : val;
        const re = globRegex(pat, { extglob: true });
        if (op === '/#') { for (let k = val.length; k >= 0; k--) if (re.test(val.slice(0, k))) return rep + val.slice(k); return val; }
        if (op === '/%') { for (let k = 0; k <= val.length; k++) if (re.test(val.slice(k))) return val.slice(0, k) + rep; return val; }
        let out = '', i = 0, done = false;
        while (i <= val.length) {
          let matched = -1;
          if (!done) for (let k = val.length; k >= i; k--) { if (re.test(val.slice(i, k))) { matched = k; break; } }
          if (matched >= 0 && !(matched === i && i === val.length && out !== '' && false)) {
            if (matched === i) { out += rep + (i < val.length ? val[i] : ''); i++; if (op === '/') { out += val.slice(i); return out; } continue; }
            out += rep;
            i = matched;
            if (op === '/') { out += val.slice(i); return out; }
            continue;
          }
          if (i < val.length) out += val[i];
          i++;
        }
        return out;
      }
      case '^': case '^^': case ',': case ',,': {
        const pat = p.arg && p.arg.parts.length ? this.expandPattern(p.arg) : '?';
        const re = globRegex(pat, { extglob: true });
        const up = op[0] === '^';
        const all = op.length === 2;
        let out = '';
        for (let k = 0; k < val.length; k++) {
          const ch = val[k];
          if ((all || k === 0) && re.test(ch)) out += up ? ch.toUpperCase() : ch.toLowerCase();
          else out += ch;
        }
        return out;
      }
      case '@': {
        switch (p.arg) {
          case 'Q': return shellQuote(val, true);
          case 'U': return val.toUpperCase();
          case 'u': return val.charAt(0).toUpperCase() + val.slice(1);
          case 'L': return val.toLowerCase();
          case 'E': return decodeEscapes(val);
          case 'P': return val;
          case 'A': return `${p.name}=${shellQuote(val, true)}`;
          case 'a': { const v = this.lookupVar(p.name); return v ? (v.arr ? 'a' : v.assoc ? 'A' : '') + (v.integer ? 'i' : '') + (v.exported ? 'x' : '') + (v.readonly ? 'r' : '') : ''; }
          case 'K': return shellQuote(val, true);
        }
        return val;
      }
    }
    return val;
  }

  cmdSubst(part) {
    if (part.synerr) {
      // a $( ) that doesn't parse (bash only finds that out now): report it, abandon the command
      const e = part.synerr, io = this.curIo || { fds: {} };
      const pre = `${this.interactive ? 'bash' : this.srcName ?? this.arg0}: command substitution: line ${e.line}: `;
      for (const m of e.msgs) this.writeFd(io, 2, pre + m + '\n');
      if (e.text !== null) this.writeFd(io, 2, pre + `\`${e.text}'\n`);
      throw new ShellAbort(1, null, true);
    }
    if (part.bqerr) {
      const { src, base } = part.bqerr, io = this.curIo || { fds: {} };
      try { new Parser(src, { extglob: this.shopt.extglob, line: base }).parseAll(); }
      catch (e) {
        if (!(e instanceof ParseError)) throw e;
        const name = this.interactive ? 'bash' : this.srcName ?? this.arg0;
        this.syntaxError(io, src, e, base, (n) => `${name}: command substitution: line ${n}: `, base);
      }
      this.cmdSubStatus = 2;
      this.status = 2;
      return '';
    }
    // $(< file) shortcut
    const items = part.body.items;
    if (items.length === 1 && items[0].cmd.t === 'simple' && items[0].cmd.words.length === 0 && items[0].cmd.assigns.length === 0 && items[0].cmd.redirs.length === 1 && items[0].cmd.redirs[0].op === '<') {
      const target = this.expandRedirTarget(items[0].cmd.redirs[0].target);
      try {
        let d = this.readPath(target, null);
        if (d.includes('\0')) { this.shellError(this.curIo || { fds: {} }, 'warning: command substitution: ignored null byte in input'); d = d.replace(/\0/g, ''); }
        this.cmdSubStatus = 0;
        return d.replace(/\n+$/, '');
      } catch (e) {
        if (e instanceof FsError) { this.writeFd(this.curIo || { fds: {} }, 2, `bash: ${target}: ${e.message}\n`); this.cmdSubStatus = 1; return ''; }
        throw e;
      }
    }
    const sub = this.subshell();
    sub.xlevel = this.xlevel + 1;
    // command substitutions don't inherit set -e (shopt inherit_errexit aside)
    if (!this.shopt.inherit_errexit) sub.opts.errexit = false;
    const out = new OutBuf(16 * 1024 * 1024);
    const io = { fds: { ...(this.curIo ? this.curIo.fds : {}), 1: out } };
    if (!io.fds[0]) io.fds[0] = new InStream('');
    let st = 0;
    try { st = sub.execList(part.body, io); }
    catch (e) {
      if (e instanceof ExitSignal) st = e.code;
      else if (e instanceof ShellAbort) { if (e.msg) sub.abortMsg(io, e); st = e.code; }
      else if (e instanceof PipeLimit) st = 141;
      else if (e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal) st = sub.status;
      else throw e;
    }
    this.cmdSubStatus = st;
    this.status = st;
    let d = out.data;
    if (d.includes('\0')) { this.shellError(io, 'warning: command substitution: ignored null byte in input'); d = d.replace(/\0/g, ''); }
    return d.replace(/\n+$/, '');
  }

  procSubst(part) {
    // Process substitution: the data lives in a real file under /proc/self/fd so every tool can stat/read it.
    this.procN = (this.procN || 64) - 1;
    if (this.procN < 10) this.procN = 63;
    const path = `/dev/fd/${this.procN}`;
    if (part.dir === '<') {
      const sub = this.subshell();
      const out = new OutBuf(16 * 1024 * 1024);
      const io = { fds: { ...(this.curIo ? this.curIo.fds : {}), 1: out } };
      try { sub.execList(part.body, io); } catch (e) { if (!(e instanceof ExitSignal || e instanceof ShellAbort || e instanceof PipeLimit || e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal)) throw e; }
      try { const n = this.fs.writeFile(path, out.data, '/'); n.mode = 0o600; (this.procFiles ||= []).push(path); } catch {}
    } else {
      try { this.fs.writeFile(path, '', '/'); } catch {}
      const self = this;
      const ioOuter = this.curIo;
      this.pendingProcOut = this.pendingProcOut || [];
      this.pendingProcOut.push(() => {
        let data = '';
        try { data = self.fs.readFile(path, '/'); } catch {}
        const sub = self.subshell();
        const io = { fds: { ...(ioOuter ? ioOuter.fds : {}), 0: new InStream(data) } };
        try { sub.execList(part.body, io); } catch (e) { if (!(e instanceof ExitSignal || e instanceof ShellAbort || e instanceof PipeLimit)) throw e; }
      });
    }
    return path;
  }

  // Brace expansion on a word's parts: returns array of words.
  braceExpand(word) {
    const hasBrace = word.parts.some(p => p.t === 'lit' && p.v.includes('{'));
    if (!hasBrace) return [word];
    // tokenize: lit chars individually, other parts opaque
    const toks = [];
    for (const p of word.parts) {
      if (p.t === 'lit') for (const ch of p.v) toks.push({ ch });
      else toks.push({ part: p });
    }
    const results = expandBraceTokens(toks, 0);
    return results.map(ts => {
      const parts = [];
      let buf = '';
      for (const t of ts) {
        if (t.ch !== undefined) buf += t.ch;
        else { if (buf) { parts.push({ t: 'lit', v: buf }); buf = ''; } parts.push(t.part); }
      }
      if (buf) parts.push({ t: 'lit', v: buf });
      return { parts };
    });
  }

  // a redirection that couldn't open its file; dash says "cannot open/create FILE: ..." and fails with 2
  redirFail(target, e, write) {
    if (!this.dash) return new RedirError(`${target}: ${e.message}`);
    const missing = e.code === 'ENOENT' || e.code === 'ENOTDIR';
    return new RedirError(write ? `cannot create ${target}: ${missing ? 'Directory nonexistent' : e.message}` : `cannot open ${target}: ${missing ? 'No such file' : e.message}`, 2);
  }

  // Pathname expansion of one field.
  globField(f, out) {
    if (!f.g || this.opts.noglob || !hasGlob(f.p, this.shopt.extglob)) { out.push(f.v); return; }
    let matches = this.glob(f.p);
    // GLOBIGNORE: drop matches of its patterns (and . and ..)
    const gi = this.getVar('GLOBIGNORE');
    if (gi) {
      const pats = gi.split(':').filter(Boolean);
      matches = matches.filter((m) => { const b = m.replace(/.*\//, ''); return b !== '.' && b !== '..' && !pats.some((p) => fnmatch(p, m, { extglob: this.shopt.extglob })); });
    }
    if (matches.length) { out.push(...matches); return; }
    if (this.shopt.nullglob) return;
    if (this.shopt.failglob) throw new ShellAbort(1, `no match: ${f.v}`, true);
    out.push(f.v);
  }

  glob(pattern) {
    // Leading components without glob characters are kept exactly as typed ("sub//*" -> "sub//c.txt");
    // after the first wildcard component, matches are joined with single slashes.
    let prefix = '', restStart = 0;
    for (let i = 0; ;) {
      const j = pattern.indexOf('/', i);
      if (j < 0) break;
      const comp = pattern.slice(i, j);
      if (hasGlob(comp, this.shopt.extglob)) break;
      let k = j;
      while (pattern[k] === '/') k++;
      prefix += unescapeGlob(comp) + pattern.slice(j, k);
      i = restStart = k;
    }
    let comps = pattern.slice(restStart).split('/');
    if (this.shopt.globstar) comps = comps.filter((c, i) => !(c === '**' && comps[i + 1] === '**'));
    let bases = [{ disp: prefix }];
    const startIdx = 0;
    const fs = this.fs;
    const nocase = this.shopt.nocaseglob;
    const dotglob = this.shopt.dotglob || !!this.getVar('GLOBIGNORE');
    const listDir = (dispPath) => {
      try {
        const r = fs.resolve(dispPath === '' ? '.' : dispPath, this.cwd);
        if (r.node.type !== 'd') return null;
        return [...r.node.entries.keys()].sort(byteCmp);
      } catch { return null; }
    };
    const join = (d, n) => d === '' ? n : d.endsWith('/') ? d + n : d + '/' + n;
    for (let ci = startIdx; ci < comps.length; ci++) {
      const comp = comps[ci];
      const lastComp = ci === comps.length - 1;
      if (comp === '') {
        // trailing slash or '//' : only directories
        if (lastComp) bases = bases.filter(b => { if (b.disp === '') return false; try { return fs.stat(b.disp, this.cwd).type === 'd'; } catch { return false; } }).map(b => ({ ...b, disp: b.disp.endsWith('/') ? b.disp : b.disp + '/' }));
        continue;
      }
      const next = [];
      if (comp === '**' && this.shopt.globstar) {
        // zero or more directories
        for (const b of bases) {
          const stack = [b.disp];
          if (lastComp) {
            // trailing **: everything below the base, plus the base directory itself ("sub/**" -> "sub/", "s*/**" -> "sub")
            if (b.disp !== '' && listDir(b.disp)) next.push({ disp: b.disp });
            const walk = (d) => {
              const names = listDir(d);
              if (!names) return;
              for (const n of names) {
                if (!dotglob && n.startsWith('.')) continue;
                const p = join(d, n);
                next.push({ disp: p });
                let isDir = false;
                try { const st = fs.lstat(p, this.cwd); isDir = st.type === 'd'; } catch {}
                if (isDir) walk(p);
              }
            };
            walk(b.disp);
          } else {
            const walk = (d) => {
              next.push({ disp: d });
              const names = listDir(d);
              if (!names) return;
              for (const n of names) {
                if (!dotglob && n.startsWith('.')) continue;
                const p = join(d, n);
                let isDir = false;
                try { const st = fs.lstat(p, this.cwd); isDir = st.type === 'd'; } catch {}
                if (isDir) walk(p);
              }
            };
            walk(b.disp);
          }
        }
        bases = next;
        continue;
      }
      if (!hasGlob(comp, this.shopt.extglob)) {
        const lit = unescapeGlob(comp);
        for (const b of bases) {
          const p = join(b.disp, lit);
          if (lastComp) { if (fs.exists(p === '' ? '.' : p, this.cwd, false)) next.push({ disp: p }); }
          else next.push({ disp: p });
        }
        bases = next;
        continue;
      }
      const re = globRegex(comp, { nocase, extglob: this.shopt.extglob });
      const explicitDot = comp.startsWith('.') || comp.startsWith('\\.');
      for (const b of bases) {
        const names = listDir(b.disp);
        if (!names) continue;
        const cand = explicitDot ? ['.', '..', ...names] : names;
        for (const n of cand) {
          if (n.startsWith('.') && !explicitDot && !dotglob) continue;
          if (dotglob && !explicitDot && (n === '.' || n === '..')) continue;
          if (re.test(n)) {
            const p = join(b.disp, n);
            if (!lastComp) { try { if (fs.stat(p, this.cwd).type !== 'd') continue; } catch { continue; } }
            next.push({ disp: p });
          }
        }
      }
      bases = next;
      if (!bases.length) break;
    }
    const res = [...new Set(bases.map(b => b.disp).filter(x => x !== ''))];
    // bash sorts each pattern's matches
    return res.sort(byteCmp);
  }
}

class RedirError extends Error { constructor(msg, status = 1) { super(msg); this.status = status; } }

function isDeclWord(w) {
  const t = w.parts.length === 1 && w.parts[0].t === 'lit' ? w.parts[0].v : null;
  return t === 'declare' || t === 'typeset' || t === 'local' || t === 'export' || t === 'readonly';
}

// Brace expansion over token arrays.
function expandBraceTokens(toks) {
  // find first '{' with matching '}' containing a top-level ',' or a valid sequence
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].ch !== '{') continue;
    if (i > 0 && toks[i - 1].ch === '$') continue;
    let depth = 0, commas = [], end = -1;
    for (let j = i; j < toks.length; j++) {
      const c = toks[j].ch;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
      else if (c === ',' && depth === 1) commas.push(j);
    }
    if (end < 0) continue;
    const pre = toks.slice(0, i), post = toks.slice(end + 1);
    if (commas.length) {
      const alts = [];
      let s = i + 1;
      for (const c of [...commas, end]) { alts.push(toks.slice(s, c)); s = c + 1; }
      const out = [];
      for (const a of alts) for (const r of expandBraceTokens([...pre, ...a, ...post])) out.push(r);
      return out;
    }
    // sequence?
    const inner = toks.slice(i + 1, end);
    if (inner.every(t => t.ch !== undefined)) {
      const text = inner.map(t => t.ch).join('');
      const seq = braceSequence(text);
      if (seq) {
        const out = [];
        for (const item of seq) for (const r of expandBraceTokens([...pre, ...[...item].map(ch => ({ ch })), ...post])) out.push(r);
        return out;
      }
    }
    // not expandable: keep scanning after this brace
    const rest = expandBraceTokens(toks.slice(i + 1));
    return rest.map(r => [...toks.slice(0, i + 1), ...r]);
  }
  return [toks];
}

function braceSequence(text) {
  let m = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(text);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    let step = m[3] ? Math.abs(parseInt(m[3], 10)) || 1 : 1;
    const pad = (/^-?0\d/.test(m[1]) || /^-?0\d/.test(m[2])) ? Math.max(m[1].length, m[2].length) : 0;
    const out = [];
    const fmt = (n) => { if (!pad) return String(n); const neg = n < 0; let s = String(Math.abs(n)); while (s.length < pad - (neg ? 1 : 0)) s = '0' + s; return (neg ? '-' : '') + s; };
    if (Math.abs(b - a) / step > 100000) return null;
    if (a <= b) for (let n = a; n <= b; n += step) out.push(fmt(n));
    else for (let n = a; n >= b; n -= step) out.push(fmt(n));
    return out;
  }
  m = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(text);
  if (m) {
    const a = m[1].charCodeAt(0), b = m[2].charCodeAt(0);
    const step = m[3] ? Math.abs(parseInt(m[3], 10)) || 1 : 1;
    const out = [];
    if (a <= b) for (let n = a; n <= b; n += step) out.push(String.fromCharCode(n));
    else for (let n = a; n >= b; n -= step) out.push(String.fromCharCode(n));
    return out;
  }
  return null;
}

export function decodeEscapes(s, { echo = false, dash = false } = {}) {
  // echo -e / printf %b style escapes. Returns { text, stop } when echo=true.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) { out += c; continue; }
    const d = s[++i];
    if (dash) {
      // dash's echo: \\ \a \b \c \e \f \n \r \t \v and octal (\NNN or \0NNN); others stay as typed
      if (d === 'c') return echo ? { text: out, stop: true } : out;
      if (d >= '0' && d <= '7') {
        let j = i;
        if (d === '0' && /[0-7]/.test(s[j + 1] || '')) j++;
        let o = '';
        while (o.length < 3 && /[0-7]/.test(s[j] || '')) o += s[j++];
        out += String.fromCharCode(parseInt(o, 8) & 255);
        i = j - 1;
        continue;
      }
      const m = { '\\': '\\', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }[d];
      if (m !== undefined) out += m; else { out += '\\'; i--; }
      continue;
    }
    switch (d) {
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'c': return echo ? { text: out, stop: true } : out;
      case 'e': case 'E': out += '\x1b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      case '0': {
        let o = '';
        while (o.length < 3 && /[0-7]/.test(s[i + 1] || '')) o += s[++i];
        out += String.fromCharCode(parseInt(o || '0', 8) & 255);
        break;
      }
      case 'x': {
        let h = '';
        while (h.length < 2 && /[0-9a-fA-F]/.test(s[i + 1] || '')) h += s[++i];
        if (h) out += String.fromCharCode(parseInt(h, 16)); else out += '\\x';
        break;
      }
      case 'u': case 'U': {
        const max = d === 'u' ? 4 : 8;
        let h = '';
        while (h.length < max && /[0-9a-fA-F]/.test(s[i + 1] || '')) h += s[++i];
        if (!h) { out += '\\' + d; break; }
        const u8 = new TextEncoder().encode(String.fromCodePoint(parseInt(h, 16)));
        for (const b of u8) out += String.fromCharCode(b);
        break;
      }
      default:
        if (d >= '1' && d <= '7' && !echo) {
          let o = d;
          while (o.length < 3 && /[0-7]/.test(s[i + 1] || '')) o += s[++i];
          out += String.fromCharCode(parseInt(o, 8) & 255);
        } else out += '\\' + d;
    }
  }
  return echo ? { text: out, stop: false } : out;
}
