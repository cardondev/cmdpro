// The gawk 5.1 runtime: the interpreter for the tree awkparse.js builds, with gawk's value typing
// (node.c, eval.c), records and fields (field.c), input files, redirections and getline (io.c),
// regexps (re.c over gnure.js) and the builtins (builtin.c, array.c).
import { AwkArray, AK, assocList, cmpStrings, KEYMAKERS } from './awkarr.js';
import {
  UserStr, NULL_FIELD, NullField, TypedRe, AwkFatal, forceNumber, formatTree, formatNanInf, GawkRandom,
  toLong, toUintmax, doubleToInt, adjustUint, getNumbase, nondec2awknum, signbit, cFloat,
} from './awkvals.js';
import { compileGnuRegex, RE, RegexError } from '../gnure.js';
import { parseEscape } from './awkparse.js';
import { FsError } from '../vfs.js';
import { OutBuf, PipeLimit } from '../streams.js';
import { strftime } from '../timefmt.js';
import { fmtG } from '../cfmt.js';

KEYMAKERS.strnum = (s) => new UserStr(s);
KEYMAKERS.regex = (s) => new TypedRe(s);

// rule kinds (ruletab)
const R_NONE = 0, R_BEGIN = 1, R_RULE = 2, R_END = 3, R_BEGINFILE = 4, R_ENDFILE = 5;
const RULETAB = ['?', 'BEGIN', 'Rule', 'END', 'BEGINFILE', 'ENDFILE'];

class NextSig { }
class NextFileSig { }
class ExitSig { }
class RetSig { constructor(v) { this.v = v; } }
class BrkSig { }
class ContSig { }
export class FatalExit { constructor(code = 2) { this.code = code; } }

const RE_SYNTAX_GNU_AWK = ((RE.CHAR_CLASSES | RE.DOT_NEWLINE | RE.DOT_NOT_NULL | RE.INTERVALS | RE.NO_EMPTY_RANGES
  | RE.CONTEXT_INDEP_ANCHORS | RE.CONTEXT_INDEP_OPS | RE.NO_BK_BRACES | RE.NO_BK_PARENS | RE.NO_BK_VBAR
  | RE.CONTEXT_INVALID_OPS | RE.UNMATCHED_RIGHT_PAREN_ORD) | RE.BACKSLASH_ESCAPE_IN_LISTS | RE.INVALID_INTERVAL_ORD)
  & ~(RE.DOT_NOT_NULL | RE.CONTEXT_INDEP_OPS | RE.CONTEXT_INVALID_OPS);
const RE_SYNTAX_POSIX_AWK = (RE.CHAR_CLASSES | RE.DOT_NEWLINE | RE.DOT_NOT_NULL | RE.INTERVALS | RE.NO_EMPTY_RANGES
  | RE.CONTEXT_INDEP_ANCHORS | RE.CONTEXT_INDEP_OPS | RE.NO_BK_BRACES | RE.NO_BK_PARENS | RE.NO_BK_VBAR
  | RE.CONTEXT_INVALID_OPS | RE.UNMATCHED_RIGHT_PAREN_ORD | RE.NO_GNU_OPS) & ~(0);
const RE_SYNTAX_AWK = RE.BACKSLASH_ESCAPE_IN_LISTS | RE.DOT_NOT_NULL | RE.NO_BK_PARENS | RE.NO_BK_REFS | RE.NO_BK_VBAR
  | RE.NO_EMPTY_RANGES | RE.DOT_NEWLINE | RE.CONTEXT_INDEP_ANCHORS | RE.CHAR_CLASSES | RE.UNMATCHED_RIGHT_PAREN_ORD | RE.NO_GNU_OPS;

const lowerAscii = (s) => (/[A-Z]/.test(s) ? s.replace(/[A-Z]+/g, (m) => m.toLowerCase()) : s);
const isUpperC = (c) => c >= 65 && c <= 90;

const STRERROR = {
  ENOENT: 'No such file or directory', EISDIR: 'Is a directory', EACCES: 'Permission denied', ENOTDIR: 'Not a directory',
  EEXIST: 'File exists', EROFS: 'Read-only file system', ENOSPC: 'No space left on device', EPERM: 'Operation not permitted',
  EINVAL: 'Invalid argument', ELOOP: 'Too many levels of symbolic links', ENAMETOOLONG: 'File name too long',
};
const strerror = (e) => (e && STRERROR[e.code]) || (e && e.message) || 'Unknown error';
const errnoOf = (e) => (e && e.code) || 'EIO';

// ---------------------------------------------------------------- regular expressions (re.c)
// The compiled form of a gawk regexp. Matching is done on the subject itself, or on its ASCII
// lowercase form for IGNORECASE (gawk's casetable translation).
export class Regexp {
  constructor(buf, c, icase) {
    this.buf = buf;
    this.icase = icase;
    this.src = c.src;
    this.nsub = c.nsub;
    this.maxLen = c.maxLen;
    this.longest = c.longest;
    this.re = new RegExp(c.src, 'gd');
    this.ext = new Map();
    this.hasMeta = /[.*+(){}[\]|?^$\\]/.test(buf);
    this.maybeLong = /[*+|?]/.test(buf);
  }
  // research(): the leftmost-longest match at or after `start`; null when there is none.
  // The result's indices give the subexpressions.
  exec(str, start) {
    const re = this.re;
    re.lastIndex = start;
    let m = re.exec(str);
    if (!m) return null;
    const s = m.index, e = s + m[0].length;
    if (this.longest && this.maxLen > e - s) {
      const top = Math.min(str.length, s + this.maxLen, e + 4096);
      for (let end = top; end > e; end--) {
        const k = str.length - end;
        let r = this.ext.get(k);
        if (!r) {
          if (this.ext.size > 2048) this.ext.clear();
          r = new RegExp('(?:' + this.src + ')(?=[\\s\\S]{' + k + '}$)', 'yd');
          this.ext.set(k, r);
        }
        r.lastIndex = s;
        const m2 = r.exec(str);
        if (m2) { m = m2; break; }
      }
    }
    return m;
  }
  // is the regexp a plain string (reisstring)
  isString(text, matched) { return !this.hasMeta && text === matched; }
}

// make_regexp()'s escape processing; warn(msg) reports, once per kind like gawk's static flags
export function regexBuf(s, opts, warn, warned) {
  const okToEscape = opts.posix ? '{}()|*+?.^$\\[]/-' : opts.traditional ? '()|*+?.^$\\[]/-' : "<>`'BywWsS{}()|*+?.^$\\[]/-";
  let buf = '';
  for (let i = 0; i < s.length;) {
    if (s[i] !== '\\') { buf += s[i++]; continue; }
    const c = s[i + 1];
    if (c === undefined) { buf += '\\'; i++; continue; }
    switch (c) {
      case '\0':
        throw new AwkFatal('invalid NUL byte in dynamic regexp');
      case 'a': case 'b': case 'f': case 'n': case 'r': case 't': case 'v': case 'x':
      case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': {
        const r = parseEscape(s, i + 1, opts, (m) => warn(m));
        const c2 = String.fromCharCode(r.c & 255);
        if (opts.traditional && !opts.posix && (/[0-9x]/.test(c)) && '()|*+?.^$\\[]'.includes(c2)) buf += '\\';
        buf += c2;
        i = r.i;
        break;
      }
      case '8': case '9':
        buf += c;
        i += 2;
        if (!warned.has('re' + c)) { warned.add('re' + c); warn(`regexp escape sequence \`\\${c}' treated as plain \`${c}'`); }
        break;
      case 'y':
        if (!opts.traditional) { buf += '\\b'; i += 2; break; }
        // fall through
      default:
        if (!okToEscape.includes(c)) {
          const key = 're:' + c;
          if (!warned.has(key)) { warned.add(key); warn(`regexp escape sequence \`\\${c}' is not a known regexp operator`); }
        }
        buf += '\\' + c;
        i += 2;
        break;
    }
  }
  return buf;
}

// the casetable translation of a pattern for IGNORECASE: literal letters lowercased, GNU operator
// escapes and [:class:] names kept
function translatePattern(p) {
  let out = '';
  let i = 0;
  const n = p.length;
  while (i < n) {
    const c = p[i];
    if (c === '\\' && i + 1 < n) {
      const d = p[i + 1];
      out += '\\' + ("wWsSbB<>`'".includes(d) ? d : d.toLowerCase().length === 1 && isUpperC(d.charCodeAt(0)) ? d.toLowerCase() : d);
      i += 2;
      continue;
    }
    if (c === '[') {
      out += '[';
      i++;
      if (p[i] === '^') { out += '^'; i++; }
      if (p[i] === ']') { out += ']'; i++; }
      while (i < n && p[i] !== ']') {
        if (p[i] === '[' && (p[i + 1] === ':' || p[i + 1] === '.' || p[i + 1] === '=')) {
          const delim = p[i + 1];
          const end = p.indexOf(delim + ']', i + 2);
          if (end < 0) { out += p.slice(i); i = n; break; }
          const body = p.slice(i + 2, end);
          // under the casetable translation upper-case letters only exist as lower-case ones
          out += '[' + delim + (delim === ':' ? (body === 'upper' ? 'lower' : body) : lowerAscii(body)) + delim + ']';
          i = end + 2;
          continue;
        }
        if (p[i] === '\\' && i + 1 < n) { out += '\\' + lowerAscii(p[i + 1]); i += 2; continue; }
        out += lowerAscii(p[i]);
        i++;
      }
      if (i < n) { out += ']'; i++; }
      continue;
    }
    out += isUpperC(c.charCodeAt(0)) ? c.toLowerCase() : c;
    i++;
  }
  return out;
}

// make_regexp(): returns { rp } or { err, buf } (err: the regerror() text)
export function makeRegexp(s, icase, opts, warn, warned) {
  const buf = regexBuf(s, opts, warn, warned);
  const syntax = opts.posix ? RE_SYNTAX_POSIX_AWK : opts.traditional ? RE_SYNTAX_AWK : RE_SYNTAX_GNU_AWK;
  let c;
  try {
    c = compileGnuRegex(icase ? translatePattern(buf) : buf, syntax, { newlineAnchor: false });
  } catch (e) {
    if (e instanceof RegexError) return { err: e.message, buf };
    throw e;
  }
  return { rp: new Regexp(buf, c, icase) };
}

// ---------------------------------------------------------------- variables
// A variable or a function parameter: type 'new' (untyped), 'var' (scalar), 'array' or 'ref' (a
// parameter standing for the caller's untyped variable or array).
class Var {
  constructor(name, type = 'new') { this.name = name; this.type = type; this.value = undefined; this.arr = null; this.orig = null; this.hook = null; }
}

const SPECIAL_ASSIGN = new Set(['FS', 'RS', 'NF', 'NR', 'FNR', 'OFS', 'ORS', 'SUBSEP', 'CONVFMT', 'OFMT', 'IGNORECASE',
  'FIELDWIDTHS', 'FPAT', 'BINMODE', 'LINT', 'TEXTDOMAIN']);

// ---------------------------------------------------------------- the interpreter
export class AwkRuntime {
  constructor(ctx, prog, opts) {
    this.ctx = ctx;
    this.opts = opts;
    this.name = opts.name || 'awk';
    this.items = [];
    this.funcs = new Map();
    if (prog) this.setProgram(prog);
    this.warned = opts.warned || new Set();
    this.vars = new Map();
    this.frames = [];
    this.currule = R_NONE;
    this.sourceline = 0;
    this.source = null;
    this.exitVal = 0;
    this.exiting = false;
    this.linenoVal = null;
    this.random = new GawkRandom();
    this.reCache = new Map();
    this.ticks = 0;
    // output
    this.stdout = new StdBuf(ctx.stdout);
    this.redirs = [];        // most recently opened first (red_head)
    // input
    this.curfile = null;
    this.argIdx = 1;
    this.filesSeen = false;
    this.NR = 0;
    this.FNR = 0;
    // fields
    this.fields = [NULL_FIELD];
    this.recStr = '';
    this.nf = -1;
    this.parseHighWater = 0;
    this.parseExtent = 0;
    this.field0Valid = true;
    this.resaveFs = false;
    this.initVars();
    this.saveFS = { s: ' ', regex: false };
    this.setRS();
    this.resaveFs = false;
  }
  setProgram(prog) {
    this.items = prog.items;
    this.funcs = new Map();
    for (const [name, f] of prog.funcs) {
      const idx = new Map();
      f.params.forEach((p, k) => idx.set(p, k));
      this.funcs.set(name, { name, params: f.params, body: f.body, idx, src: f.src === undefined ? null : f.src });
    }
    for (const g of prog.globals || []) if (!this.vars.has(g)) this.vars.set(g, new Var(g));
    this.loadSymbols();
  }
  // load_symbols(): PROCINFO["identifiers"]
  loadSymbols() {
    const pi = this.vars.get('PROCINFO');
    if (!pi || pi.type !== 'array') return;
    const ids = new AwkArray('identifiers', pi.arr);
    for (const name of this.funcs.keys()) this.arrSet(ids, name, 'user');
    for (const b of STD_BUILTINS) if (!this.opts.posix || b !== 'fflush') this.arrSet(ids, b, 'builtin');
    for (const [name, v] of this.vars) {
      if (name === 'PROCINFO' && false) continue;
      this.arrSet(ids, name, v.type === 'array' ? 'array' : v.type === 'new' ? 'untyped' : 'scalar');
    }
    this.arrayLookup(pi.arr, 'identifiers').v = ids;
  }

  // ------------------------------------------------------------ messages (msg.c)
  err(prefix, msg) {
    this.flushStdoutQuiet();
    if (this.linenoVal === null) {
      const v = this.vars.get('LINENO');
      this.linenoVal = v && v.type === 'var' ? Math.trunc(this.num(v.value)) : 0;
    }
    let s = `${this.name}: `;
    if (this.sourceline > 0) s += (this.source !== null ? `${this.source}:` : 'cmd. line:') + `${this.sourceline + this.linenoVal}: `;
    if (this.FNR > 0) s += `(FILENAME=${this.str(this.vars.get('FILENAME').value)} FNR=${this.FNR}) `;
    this.ctx.stderr.write(s + prefix + msg + '\n');
  }
  warning(msg) { this.err('warning: ', msg); }
  error(msg) { this.err('error: ', msg); }
  fatal(msg) { this.err('fatal: ', msg); return new FatalExit(2); }
  msgFatal(msg) { this.err('', msg); return new FatalExit(2); }
  rethrow(e) {
    if (e instanceof AwkFatal) throw e.plain ? this.msgFatal(e.message) : this.fatal(e.message);
    throw e;
  }
  tick() { if ((++this.ticks & 1023) === 0) this.ctx.tick(); }

  // ------------------------------------------------------------ values
  get CONVFMT() { return this._convfmt; }
  formatVal(n, fmt) {
    if (!Number.isFinite(n)) return formatNanInf(n, 'g');
    if (Number.isInteger(n)) return n === 0 ? '0' : (Math.abs(n) < 1e21 ? n.toFixed(0) : BigInt(n).toString());
    if (fmt === '%.6g') return (n < 0 ? '-' : '') + fmtG(Math.abs(n), 6, false, false);
    if (this.fmtDepth > 8) return String(n);
    this.fmtDepth = (this.fmtDepth || 0) + 1;
    try { return formatTree(this.fmtRT, fmt, [fmt, n], this.opts); }
    catch (e) { this.rethrow(e); }
    finally { this.fmtDepth--; }
  }
  str(v) {
    switch (typeof v) {
      case 'string': return v;
      case 'number': return this.formatVal(v, this._convfmt);
      case 'undefined': return '';
    }
    if (v instanceof UserStr || v instanceof NullField || v instanceof TypedRe) return v.s;
    if (v instanceof AwkArray) throw this.fatal(`attempt to use array \`${this.arrayVname(v)}' in a scalar context`);
    return String(v);
  }
  outStr(v) { return typeof v === 'number' ? this.formatVal(v, this._ofmt) : this.str(v); }
  userNum(u) {
    if (u.st === 0) {
      const r = forceNumber(u.s, this.opts);
      u.n = r.n;
      u.st = r.ok ? 1 : 2;
    }
    return u.n;
  }
  num(v) {
    switch (typeof v) {
      case 'number': return v;
      case 'undefined': return 0;
      case 'string': return forceNumber(v, this.opts).n;
    }
    if (v instanceof UserStr) return this.userNum(v);
    if (v instanceof NullField || v instanceof TypedRe) return 0;
    if (v instanceof AwkArray) throw this.fatal(`attempt to use array \`${this.arrayVname(v)}' in a scalar context`);
    return 0;
  }
  // the NUMBER flag after fixtype()
  isNumeric(v) {
    if (typeof v === 'number' || v === undefined) return true;
    if (v instanceof UserStr) { this.userNum(v); return v.st === 1; }
    return false;
  }
  // the STRING flag after fixtype()
  isString(v) {
    if (typeof v === 'string' || v === undefined || v instanceof NullField) return true;
    if (v instanceof UserStr) { this.userNum(v); return v.st === 2; }
    return false;
  }
  bool(v) {
    if (this.isNumeric(v)) return this.num(v) !== 0;
    return this.str(v).length > 0;
  }
  cmpNumbers(a, b) {
    if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
    if (Number.isNaN(b)) return -1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  cmpNodes(a, b) {
    if (this.isNumeric(a) && this.isNumeric(b)) return this.cmpNumbers(this.num(a), this.num(b));
    const s1 = this.str(a), s2 = this.str(b);
    const ldiff = s1.length - s2.length;
    if (s1.length === 0 || s2.length === 0) return ldiff;
    const l = ldiff <= 0 ? s1.length : s2.length;
    let ret = 0;
    if (this.ignorecase) {
      for (let i = 0; i < l && ret === 0; i++) {
        let x = s1.charCodeAt(i), y = s2.charCodeAt(i);
        if (isUpperC(x)) x += 32;
        if (isUpperC(y)) y += 32;
        ret = x - y;
      }
    } else {
      for (let i = 0; i < l; i++) { const d = s1.charCodeAt(i) - s2.charCodeAt(i); if (d) { ret = d; break; } }
    }
    return ret === 0 ? ldiff : ret;
  }
  typeOf(v) {
    if (v instanceof AwkArray) return 'array';
    if (typeof v === 'number') return 'number';
    if (v === undefined || v instanceof NullField) return 'unassigned';
    if (v instanceof TypedRe) return 'regexp';
    if (v instanceof UserStr) { this.userNum(v); return v.st === 1 ? 'strnum' : 'string'; }
    return 'string';
  }
  // the subscript record the array code works with
  makeSub(v) {
    if (typeof v === 'number') {
      if (Number.isInteger(v)) {
        const int = v >= -2147483648 && v <= 2147483647;
        return { s: this.formatVal(v), int, k: int ? v + 0 : 0, kind: 'num', v: v + 0 };
      }
      return { s: this.formatVal(v, this._convfmt), int: false, k: 0, kind: 'str', v: null };
    }
    let s, kind;
    if (v === undefined || v instanceof NullField) { s = ''; kind = 'str'; }
    else if (typeof v === 'string') { s = v; kind = 'str'; }
    else if (v instanceof UserStr) { s = v.s; kind = 'strnum'; }
    else if (v instanceof TypedRe) { s = v.src; kind = 'regex'; }
    else if (v instanceof AwkArray) throw this.fatal(`attempt to use array \`${this.arrayVname(v)}' in a scalar context`);
    else { s = String(v); kind = 'str'; }
    const int = isStdInt(s);
    return { s, int, k: int ? Number(s) : 0, kind, v: s };
  }

  // ------------------------------------------------------------ variables
  initVars() {
    const set = (name, value) => { const v = new Var(name, 'var'); v.value = value; this.vars.set(name, v); return v; };
    set('ARGIND', 0); set('BINMODE', 0); set('CONVFMT', '%.6g'); set('ERRNO', ''); set('FIELDWIDTHS', '');
    set('FILENAME', ''); set('FNR', 0); set('FS', ' '); set('FPAT', '[^[:space:]]+'); set('IGNORECASE', 0); set('LINT', 0);
    set('PREC', 53); set('NF', -1); set('NR', 0); set('OFMT', '%.6g'); set('OFS', ' '); set('ORS', '\n'); set('RLENGTH', 0);
    set('ROUNDMODE', 'N'); set('RS', '\n'); set('RSTART', 0); set('RT', ''); set('SUBSEP', '\x1c'); set('TEXTDOMAIN', 'messages');
    this._convfmt = '%.6g'; this._ofmt = '%.6g'; this.OFS = ' '; this.ORS = '\n'; this.SUBSEP = '\x1c';
    this.ignorecase = false;
    for (const n of SPECIAL_ASSIGN) { const v = this.vars.get(n); if (v) v.hook = n; }
    this.fmtRT = { num: (v) => this.num(v), str: (v) => this.str(v), isNumeric: (v) => this.isNumeric(v) };
    // ENVIRON
    const env = this.newArrayVar('ENVIRON');
    this.environArr = env.arr;
    this.envCopy = null;
    const envObj = { ...(this.ctx.env || {}) };
    if (!envObj.AWKPATH) envObj.AWKPATH = '.:/usr/share/awk';
    if (!envObj.AWKLIBPATH) envObj.AWKLIBPATH = '/usr/lib/aarch64-linux-gnu/gawk';
    for (const [k, val] of Object.entries(envObj)) this.arrSet(env.arr, k, new UserStr(String(val)));
    if (!this.opts.traditional) {
      const pi = this.newArrayVar('PROCINFO');
      const sh = this.ctx.sh || {};
      const pid = sh.pid || 1000;
      const entries = [['version', '5.1.0'], ['strftime', '%a %b %e %H:%M:%S %Z %Y'], ['platform', 'posix'],
        ['mpfr_version', 'GNU MPFR 4.1.0'], ['gmp_version', 'GNU MP 6.2.1'], ['prec_max', 9223372036854775807 - 256 + 1], ['prec_min', 1],
        ['api_major', 3], ['api_minor', 0], ['pgrpid', pid], ['pid', pid], ['ppid', sh.ppid || 1], ['uid', 0], ['euid', 0], ['gid', 0], ['egid', 0],
        ['FS', 'FS'], ['group1', 0]];
      for (const [k, val] of entries) this.arrSet(pi.arr, k, val);
      const argvArr = new AwkArray('argv', pi.arr);
      (this.opts.dArgv || []).forEach((a, i) => this.arrSet(argvArr, i, a));
      this.arrayLookup(pi.arr, 'argv').v = argvArr;
    }
  }
  newArrayVar(name) { const v = new Var(name, 'array'); v.arr = new AwkArray(name); this.vars.set(name, v); return v; }
  arrSet(arr, key, val) { this.arrayLookup(arr, key).v = val; }
  arrayLookup(arr, key) { return arr.lookup(this.makeSub(key)); }

  // where a name lives: a parameter slot of the current function, or a global
  slot(name) {
    const f = this.frames.length ? this.frames[this.frames.length - 1] : null;
    if (f) { const i = f.fn.idx.get(name); if (i !== undefined) return f.slots[i]; }
    let v = this.vars.get(name);
    if (!v) { v = new Var(name); this.vars.set(name, v); }
    return v;
  }
  // follow a parameter that stands for a caller's variable
  deref(v) { while (v.type === 'ref') v = v.orig; return v; }
  arrayVname(a) {
    if (a.parent) return `${this.arrayVname(a.parent)}["${a.vname}"]`;
    return a.vname;
  }
  slotVname(v) {
    if (v.type !== 'ref') return v.name;
    const chain = [];
    let p = v;
    while (p.type === 'ref') { chain.push(p.name); p = p.orig; }
    return `${v.name} (` + chain.slice(1).map(n => `from ${n}, `).join('') + `from ${p.name})`;
  }
  // value of a variable used as a scalar (Op_push)
  getVar(name) {
    const v = this.slot(name);
    if (v.hook) return this.readSpecial(v);
    if (v.type === 'var') return v.value;
    let o = v;
    if (o.type === 'ref') {
      o = this.deref(o);
      if (o.type === 'var') return undefined;     // the caller's variable became a scalar meanwhile
    }
    if (o.type === 'new') { o.type = 'var'; o.value = undefined; return undefined; }
    if (o.type === 'array') throw this.fatal(`attempt to use array \`${this.slotVname(v)}' in a scalar context`);
    return v.value;
  }
  readSpecial(v) {
    switch (v.hook) {
      case 'NF':
        if (this.nf === -1) this.getField(Infinity);
        if (this.num(v.value) !== this.nf) v.value = this.nf;
        break;
      case 'NR': if (this.num(v.value) !== this.NR) v.value = this.NR; break;
      case 'FNR': if (this.num(v.value) !== this.FNR) v.value = this.FNR; break;
    }
    return v.value;
  }
  // assignment to a variable (get_lhs + store + set_FOO)
  setVar(name, val) {
    const v = this.slot(name);
    if (v.type === 'array') throw this.fatal(`attempt to use array \`${this.slotVname(v)}' in a scalar context`);
    if (v.type === 'ref') {
      const o = this.deref(v);
      if (o.type === 'array') throw this.fatal(`attempt to use array \`${this.slotVname(v)}' in a scalar context`);
      if (o.type !== 'var') { o.type = 'var'; o.value = undefined; }
      v.type = 'var';
      v.orig = null;
    } else if (v.type === 'new') v.type = 'var';
    if (val instanceof AwkArray) throw this.fatal(`attempt to use array \`${this.arrayVname(val)}' in a scalar context`);
    v.value = val;
    if (v.hook) this.assignSpecial(v.hook);
    return val;
  }
  assignSpecial(hook) {
    const val = this.vars.get(hook).value;
    switch (hook) {
      case 'FS': this.setFS(); break;
      case 'RS': this.setRS(); break;
      case 'NF': this.setNF(); break;
      case 'NR': this.NR = toLong(this.num(val)); break;
      case 'FNR': this.FNR = toLong(this.num(val)); break;
      case 'OFS':
        if (!this.field0Valid) { this.getField(Infinity); this.rebuildRecord(); }
        this.OFS = this.str(val);
        break;
      case 'ORS': this.ORS = this.str(val); break;
      case 'SUBSEP': this.SUBSEP = this.str(val); break;
      case 'CONVFMT': this._convfmt = this.str(val); break;
      case 'OFMT': this._ofmt = this.str(val); break;
      case 'IGNORECASE': this.setIgnorecase(); break;
      case 'FIELDWIDTHS': this.setFieldwidths(); break;
      case 'FPAT': this.setFPAT(); break;
      default: break;
    }
  }
  setIgnorecase() {
    const v = this.vars.get('IGNORECASE').value;
    if (this.opts.traditional) { this.ignorecase = false; return; }
    if (this.isNumeric(v)) this.ignorecase = this.num(v) !== 0;
    else this.ignorecase = this.str(v).length > 0;
    this.setRS();
  }
  // the array a name refers to, creating it if the variable was untyped (force_array)
  getArray(name) {
    const v = this.slot(name);
    if (v.type === 'array') return v.arr;
    let o = v;
    if (o.type === 'ref') {
      o = this.deref(o);
      if (o.type === 'array') return o.arr;
    }
    if (o.type === 'new') { o.type = 'array'; o.arr = new AwkArray(o.name); return o.arr; }
    throw this.fatal(v.type === 'ref' || this.isParam(name) ? `attempt to use scalar parameter \`${v.name}' as an array` : `attempt to use scalar \`${v.name}' as an array`);
  }
  isParam(name) {
    const f = this.frames.length ? this.frames[this.frames.length - 1] : null;
    return !!(f && f.fn.idx.has(name));
  }
  // an array element as an array (Op_sub_array)
  subArray(arr, key) {
    const sub = this.makeSub(key);
    const c = arr.exists(sub);
    if (c === null) {
      const na = new AwkArray(sub.s, arr);
      arr.lookup(sub).v = na;
      return na;
    }
    if (!(c.v instanceof AwkArray)) throw this.fatal(`attempt to use scalar \`${this.arrayVname(arr)}["${sub.s}"]' as an array`);
    return c.v;
  }
  // the array an idx/var node names (for `in`, for-in, delete, split targets)
  arrayOf(node) {
    if (node.t === 'var') return this.getArray(node.name);
    if (node.t === 'idx') {
      let arr = this.getArray(node.name);
      const dims = node.dims || [node.subs];
      for (const d of dims) arr = this.subArray(arr, this.subValue(d));
      return arr;
    }
    if (node.t === 'group') return this.arrayOf(node.e);
    throw this.fatal('attempt to use a scalar value as array');
  }
  subValue(list) {
    if (list.length === 1) return this.evalScalar(list[0]);
    return list.map(e => this.str(this.evalScalar(e))).join(this.SUBSEP);
  }
  // the cell of an element, for reading or assignment
  elemCell(node) {
    let arr = this.getArray(node.name);
    const dims = node.dims || [node.subs];
    for (let i = 0; i < dims.length - 1; i++) arr = this.subArray(arr, this.subValue(dims[i]));
    const key = this.subValue(dims[dims.length - 1]);
    return { arr, sub: this.makeSub(key) };
  }

  // ------------------------------------------------------------ fields (field.c)
  setRecord(s) {
    this.purgeRecord();
    this.fields[0] = new UserStr(s);
    this.recStr = s;
  }
  resetRecord() {
    this.recStr = this.str(this.fields[0]);
    this.purgeRecord();
  }
  purgeRecord() {
    this.nf = -1;
    for (let i = 1; i <= this.parseHighWater; i++) this.fields[i] = NULL_FIELD;
    this.fields.length = 1;
    this.parseHighWater = 0;
    this.parseExtent = 0;
    if (this.resaveFs) {
      this.resaveFs = false;
      this.saveFS = { s: this.str(this.vars.get('FS').value), regex: this.vars.get('FS').value instanceof TypedRe };
    }
    this.field0Valid = true;
  }
  setField(num, s, start, len) { this.fields[num] = new UserStr(s.substr(start, len)); }
  // get_field(): the value of $requested (Infinity: parse the whole record and set NF)
  getField(requested, assign = false) {
    if (requested === 0) {
      if (!this.field0Valid) {
        if (this.nf === -1) {
          const inMiddle = this.parseHighWater !== 0;
          const r = this.parseField(Infinity, this.recStr, this.parseExtent, this.recStr.length - this.parseExtent, this.parserFS(), null, inMiddle, true);
          this.nf = r.nf;
          this.parseHighWater = this.nf;
        }
        this.rebuildRecord();
      }
      return this.fields[0];
    }
    if (requested <= this.parseHighWater) return this.fields[requested];
    if (this.nf === -1) {
      let inMiddle = false;
      if (this.parseHighWater === 0) this.parseExtent = 0;
      else inMiddle = true;
      const r = this.parseField(requested, this.recStr, this.parseExtent, this.recStr.length - this.parseExtent, this.saveFS, null, inMiddle, false);
      this.parseHighWater = r.nf;
      this.parseExtent = r.end;
      if (this.parseExtent === this.recStr.length) this.nf = this.parseHighWater;
      if (requested === Infinity) requested = this.parseHighWater;
    }
    if (requested === Infinity) return undefined;
    if (this.parseHighWater < requested) {
      if (assign) {
        for (let i = this.fields.length; i <= requested; i++) this.fields[i] = NULL_FIELD;
        this.nf = requested;
        this.parseHighWater = requested;
      } else return NULL_FIELD;
    }
    return this.fields[requested];
  }
  rebuildRecord() {
    const parts = [];
    for (let i = 1; i <= this.nf; i++) parts.push(this.str(this.fields[i] === undefined ? NULL_FIELD : this.fields[i]));
    const s = parts.join(this.OFS);
    this.fields[0] = s;
    this.recStr = s;
    this.field0Valid = true;
  }
  setNF() {
    let nf = toLong(this.num(this.vars.get('NF').value));
    if (nf < 0) throw this.fatal('NF set to negative value');
    if (this.nf === -1) this.getField(Infinity);
    if (this.parseHighWater < nf) {
      for (let i = this.parseHighWater + 1; i <= nf; i++) this.fields[i] = NULL_FIELD;
    } else {
      this.fields.length = nf + 1;
    }
    this.parseHighWater = nf;
    this.nf = nf;
    this.field0Valid = false;
  }
  fieldIndex(v) {
    const n = toLong(this.num(v));
    if (n < 0) throw this.fatal(`attempt to access field ${n}`);
    return n;
  }
  fieldGet(n) {
    if (n === 0 && this.field0Valid) return this.fields[0];
    return this.getField(n);
  }
  // assignment to $n (Op_store_field)
  fieldSet(n, val) {
    if (val instanceof AwkArray) throw this.fatal(`attempt to use array \`${this.arrayVname(val)}' in a scalar context`);
    if (n === 0) {
      if (!this.field0Valid) this.getField(0);
      this.resetRecordBefore();
      this.fields[0] = val;
      this.recStr = this.str(val);
      return val;
    }
    this.getField(n, true);
    this.fields[n] = val;
    this.field0Valid = false;
    return val;
  }
  resetRecordBefore() { this.purgeRecord(); }

  // set_FS()
  setFS() {
    if (this.fields) this.getField(Infinity);
    const fsv = this.vars.get('FS').value;
    const rsv = this.vars.get('RS').value;
    const fs = this.str(fsv);
    const rs = this.str(rsv);
    const isRe = fsv instanceof TypedRe;
    if (this.saveFsStr === fs && this.saveRsStr === rs && this.saveFsRe === isRe && this.fsKind) {
      if (this.fsRegex) this.fsRegex = this.ignorecase ? this.fsReNoCase : this.fsReYesCase;
      if (this.curFieldSep() === 'FS') return;
    } else {
      this.saveFsStr = fs; this.saveRsStr = rs; this.saveFsRe = isRe;
      this.resaveFs = true;
    }
    this.defaultFS = false;
    let buf = '';
    let parser;
    if (!this.opts.traditional && fs.length === 0) parser = 'null';
    else if (fs.length > 1 || isRe) parser = 're';
    else if (this.rsIsNull) {
      parser = 'sc';
      if (fs.length === 1) {
        if (fs === ' ') { this.defaultFS = true; buf = '[ \t\n]+'; }
        else if (fs === '\\') buf = '[\\\\\n]';
        else if (fs === '\0') buf = '[\\000\n]';
        else if (fs !== '\n') buf = `[${fs}\n]`;
      }
    } else {
      parser = 'def';
      if (fs.length === 1) {
        if (fs === ' ') this.defaultFS = true;
        else if (fs === '\\') buf = '[\\\\]';
        else parser = 'sc';
      }
    }
    this.fsReYesCase = this.fsReNoCase = this.fsRegex = null;
    if (buf) {
      this.fsReYesCase = this.compileFatal(buf, false);
      this.fsReNoCase = this.compileFatal(buf, true);
      this.fsRegex = this.ignorecase ? this.fsReNoCase : this.fsReYesCase;
      parser = 're';
    } else if (parser === 're') {
      this.fsReYesCase = this.compileFatal(fs, false);
      this.fsReNoCase = this.compileFatal(fs, true);
      this.fsRegex = this.ignorecase ? this.fsReNoCase : this.fsReYesCase;
    }
    if (fs.length === 1 && parser === 're') this.fsRegex = this.fsReYesCase;
    this.fsKind = parser;
    this.setParser(parser);
  }
  setParser(p) {
    this.parser = p;
    const pi = this.vars.get('PROCINFO');
    if (pi && pi.type === 'array') this.arrSet(pi.arr, 'FS', this.curFieldSepStr());
  }
  curFieldSep() { return this.parser === 'fw' ? 'FIELDWIDTHS' : this.parser === 'fpat' ? 'FPAT' : 'FS'; }
  curFieldSepStr() { return this.curFieldSep(); }
  parserFS() { return this.curFieldSep() === 'FPAT' ? this.saveFPAT : this.saveFS; }
  setRS() {
    const rsv = this.vars.get('RS').value;
    const rs = this.str(rsv);
    const isRe = rsv instanceof TypedRe;
    if (this.saveRsText === rs && this.saveRsRe === isRe) {
      this.rsRegex = this.rsRe ? this.rsRe[this.ignorecase ? 1 : 0] : null;
    } else {
      this.saveRsText = rs; this.saveRsRe = isRe;
      this.rsIsNull = false;
      this.rsRe = null; this.rsRegex = null;
      if (rs.length === 0) { this.rsIsNull = true; this.matchrec = 'null'; }
      else if ((rs.length > 1 || isRe) && !this.opts.traditional) {
        this.rsRe = [this.compileFatal(rs, false), this.compileFatal(rs, true)];
        this.rsRegex = this.rsRe[this.ignorecase ? 1 : 0];
        this.matchrec = 're';
      } else this.matchrec = '1';
      this.rs1 = rs[0];
    }
    if (this.curFieldSep() === 'FS') this.setFS();
  }
  setFieldwidths() {
    if (this.opts.traditional) return;
    this.getField(Infinity);
    this.setParser('fw');
    const s = this.str(this.vars.get('FIELDWIDTHS').value);
    const fields = [];
    let i = 0, fatal = false;
    const isBlank = (c) => c === ' ' || c === '\t';
    for (;;) {
      while (isBlank(s[i])) i++;
      if (s[i] === '-') { fatal = true; break; }
      if (i >= s.length) break;
      let skip = 0, m = /^\d+/.exec(s.slice(i)), tmp = m ? Number(m[0]) : NaN, end = m ? i + m[0].length : i;
      if (m && s[end] === ':' && tmp > 0 && tmp <= 4294967295) {
        skip = tmp;
        i = end + 1;
        if (s[i] === '-' || isBlank(s[i])) { fatal = true; break; }
        m = /^\d+/.exec(s.slice(i)); tmp = m ? Number(m[0]) : NaN; end = m ? i + m[0].length : i;
      }
      if (!m || (end < s.length && !isBlank(s[end])) || !(tmp > 0 && tmp <= 4294967295)) {
        if (s[i] === '*') {
          let k = i + 1;
          while (isBlank(s[k])) k++;
          if (k < s.length) throw this.fatal("`*' must be the last designator in FIELDWIDTHS");
          fields.push({ skip, len: Infinity });
        } else fatal = true;
        break;
      }
      fields.push({ skip, len: tmp });
      i = end;
      while (isBlank(s[i])) i++;
      if (i >= s.length) break;
    }
    if (fatal) throw this.fatal(`invalid FIELDWIDTHS value, for field ${fields.length + 1}, near \`${s.slice(i)}'`);
    this.fieldwidths = fields;
  }
  setFPAT() {
    if (this.opts.traditional) return;
    this.getField(Infinity);
    const fp = this.str(this.vars.get('FPAT').value);
    if (this.saveFpatStr !== fp) {
      this.saveFpatStr = fp;
      this.fpatYes = this.compileFatal(fp, false);
      this.fpatNo = this.compileFatal(fp, true);
    }
    this.fpatRegex = this.ignorecase ? this.fpatNo : this.fpatYes;
    this.saveFPAT = { s: fp, regex: false };
    this.setParser('fpat');
  }
  compileFatal(s, icase) {
    const key = (icase ? 'i' : 'c') + s;
    let rp = this.reCache.get(key);
    if (rp) return rp;
    let r;
    try { r = makeRegexp(s, icase, this.opts, (m) => this.warning(m), this.warned); }
    catch (e) { this.rethrow(e); }
    if (r.err) throw this.fatal(`invalid regexp: ${r.err}: /${r.buf}/`);
    if (this.reCache.size > 1000) this.reCache.clear();
    this.reCache.set(key, r.rp);
    return r.rp;
  }
  // research() over the right form of the subject
  search(rp, str, start) {
    if (rp.icase) {
      if (this._lcSrc !== str) { this._lcSrc = str; this._lcStr = lowerAscii(str); }
      return rp.exec(this._lcStr, start);
    }
    return rp.exec(str, start);
  }
  // (*parse_field)(): returns { nf, end }. fs: { s, regex }; setFn(nf, start, len) stores a field,
  // setSep(nf, start, len) a separator (split() with four arguments)
  parseField(upTo, s, start, len, fs, sepFn, inMiddle, isUnlimited, setFn, rp, parserOverride) {
    const parser = parserOverride || this.parser;
    const set = setFn || ((n, b, l) => this.setField(n, s, b, l));
    let nf = setFn ? 0 : this.parseHighWater;
    const end = start + len;
    if (len === 0) return { nf, end: start };
    let scan = start;
    switch (parser) {
      case 'def': {
        if (fs.s.length === 0) { set(++nf, scan, len); return { nf, end: end }; }
        let sep = scan;
        for (; nf < upTo; scan++) {
          while (scan < end && (s[scan] === ' ' || s[scan] === '\t' || s[scan] === '\n')) scan++;
          if (sepFn && scan > sep) sepFn(nf, sep, scan - sep);
          if (scan >= end) break;
          const field = scan;
          while (scan < end && s[scan] !== ' ' && s[scan] !== '\t' && s[scan] !== '\n') scan++;
          set(++nf, field, scan - field);
          if (scan === end) break;
          sep = scan;
        }
        return { nf, end: Math.min(scan, end) };
      }
      case 'null': {
        for (; nf < upTo && scan < end; scan++) {
          if (sepFn && nf > 0) sepFn(nf, scan, 0);
          set(++nf, scan, 1);
        }
        return { nf, end: scan };
      }
      case 'sc': {
        const fschar = this.rsIsNull && fs.s.length === 0 ? '\n' : fs.s[0];
        for (; nf < upTo;) {
          const field = scan;
          while (scan < end && s[scan] !== fschar) scan++;
          set(++nf, field, scan - field);
          if (scan === end) break;
          if (sepFn) sepFn(nf, scan, 1);
          scan++;
          if (scan === end) { set(++nf, field, 0); break; }
        }
        return { nf, end: scan };
      }
      case 're': {
        let flagsNoBol = inMiddle;
        void flagsNoBol;
        const dfs = this.rsIsNull && this.defaultFS && !rp;
        if (dfs) {
          const sep = scan;
          while (scan < end && (s[scan] === ' ' || s[scan] === '\t' || s[scan] === '\n')) scan++;
          if (sepFn && sep < scan) sepFn(nf, sep, scan - sep);
        }
        const re = rp || this.fsRegex;
        let field = scan;
        while (scan < end && nf < upTo) {
          const m = this.search(re, s, scan);
          if (!m || m.index >= end) break;
          const ms = m.index, me = m.index + m[0].length;
          if (me === ms) {
            scan++;
            if (scan === end) { set(++nf, field, scan - field); upTo = nf; break; }
            continue;
          }
          set(++nf, field, ms - field);
          if (sepFn) sepFn(nf, ms, me - ms);
          scan = me;
          field = scan;
          if (scan === end && !dfs) set(++nf, field, 0);
        }
        if (nf !== upTo && scan < end) { set(++nf, scan, end - scan); scan = end; }
        return { nf, end: scan };
      }
      case 'fw': {
        const fw = this.fieldwidths || [];
        while (nf < upTo && scan < end) {
          if (nf >= fw.length) return { nf, end };
          let skip = fw[nf].skip;
          if (skip > end - scan) skip = end - scan;
          scan += skip;
          let flen = fw[nf].len;
          if (flen > end - scan) flen = end - scan;
          set(++nf, scan, flen);
          scan += flen;
        }
        return { nf, end: scan };
      }
      case 'fpat':
        return this.fpatParseField(upTo, s, start, len, sepFn, set, nf, rp || this.fpatRegex);
    }
    return { nf, end };
  }
  // fpat_parse_field(): fields are what FPAT matches
  fpatParseField(upTo, s, start, len, sepFn, set, nf, re) {
    const end = start + len;
    let scan = start;
    let needToSetSep = true;
    let nonEmpty = false;
    let eosflag = false;
    const startIdx = scan;
    if (len === 0) return { nf, end: scan };
    while (nf < upTo) {
      const m = scan <= end ? this.search(re, s, scan) : null;
      if (m && m.index <= end) {
        const ms = m.index, me = m.index + m[0].length;
        if (me > ms) {
          if (sepFn && needToSetSep) sepFn(nf, scan, ms - scan);
          set(++nf, ms, me - ms);
          nonEmpty = true;
          scan = me;
          needToSetSep = true;
        } else if (nonEmpty) {
          // null match right after a non-null one: skip a character
          if (sepFn) sepFn(nf, scan, 1);
          if (scan === end) { nonEmpty = false; break; }
          scan++;
          nonEmpty = false;
          needToSetSep = false;
          continue;
        } else {
          if (sepFn && needToSetSep) sepFn(nf, scan, ms - scan);
          set(++nf, ms, 0);
          if (scan === end) break;
          scan = ms + 1;
          needToSetSep = true;
        }
        if (scan >= end) { if (eosflag) break; eosflag = true; }
      } else {
        if (sepFn && needToSetSep) sepFn(nf, scan, end - scan);
        scan = end;
        break;
      }
    }
    void startIdx;
    return { nf, end: scan };
  }

  // ------------------------------------------------------------ input records (io.c)
  // get_a_record(): the next record (setting RT), or null at EOF. The whole input is in the
  // buffer, so when a scanner wants more data (NOTERM, TERMATEND) the input has ended.
  getRecord(iop) {
    const d = iop.data;
    if (iop.eof && iop.off >= d.length) return null;
    if (iop.off >= d.length) { iop.eof = true; return null; }
    let recStart = iop.off, recLen = 0, rtStart = -1, rtLen = 0, ret = 'ok';
    switch (this.matchrec) {
      case '1': {
        const j = d.indexOf(this.rs1, iop.off);
        if (j < 0) { recLen = d.length - iop.off; ret = 'noterm'; }
        else { recLen = j - iop.off; rtStart = j; rtLen = 1; }
        break;
      }
      case 'null': {
        // rsnullscan()
        let bp = iop.off;
        while (bp < d.length && d[bp] === '\n') bp++;
        if (bp >= d.length) { recStart = iop.off; recLen = 0; ret = 'noterm'; break; }
        iop.off = recStart = bp;
        for (;;) {
          const j = d.indexOf('\n', bp);
          if (j < 0) { recLen = d.length - recStart; ret = 'noterm'; break; }
          if (j + 1 >= d.length) { recLen = j - recStart; rtStart = j; rtLen = 1; ret = 'noterm'; break; }
          if (d[j + 1] !== '\n') { bp = j + 1; continue; }
          recLen = j - recStart;
          rtStart = j;
          let k = j;
          while (k < d.length && d[k] === '\n') k++;
          rtLen = k - j;
          if (k >= d.length) ret = 'termatend';
          break;
        }
        break;
      }
      case 're': {
        // rsrescan()
        let bp = iop.off;
        const re = this.rsRegex;
        for (;;) {
          const m = this.search(re, d, bp);
          if (!m) { recLen = d.length - iop.off; ret = 'noterm'; break; }
          const restart = m.index - bp, reend = restart + m[0].length;
          if (restart === reend) {
            const scanoff = reend + 1;
            if (bp + scanoff < d.length) { bp += scanoff; continue; }
            recLen = (bp - iop.off) + restart;
            ret = 'noterm';
            break;
          }
          recLen = restart;
          rtStart = bp + restart;
          rtLen = reend - restart;
          if (iop.off + reend >= d.length) ret = re.isString(this.str(this.vars.get('RS').value), m[0]) ? 'ok' : 'termatend';
          break;
        }
        iop.atStart = false;
        break;
      }
    }
    if (ret !== 'ok') iop.eof = true;
    this.vars.get('RT').value = rtLen ? d.substr(rtStart, rtLen) : '';
    iop.off = recStart + recLen + rtLen;
    if (recLen === 0 && rtLen === 0 && iop.eof) return null;
    return d.substr(recStart, recLen);
  }
  // nextfile(): >0 run BEGINFILE (curfile set) or ENDFILE (curfile null), 0 read a record, -1 end
  nextFile(skipping) {
    if (skipping) {
      let errcode = 0;
      if (this.curfile) errcode = this.curfile.errcode || 0;
      this.curfile = null;
      return errcode === 0 ? 1 : 0;
    }
    const iop = this.curfile;
    if (iop) {
      if (iop.eof) { this.curfile = null; return 1; }
      return 0;
    }
    const argcV = this.vars.get('ARGC');
    for (;;) {
      const argc = toLong(this.num(argcV.type === 'var' ? argcV.value : 0));
      if (!(this.argIdx < argc)) break;
      const i = this.argIdx;
      const argv = this.vars.get('ARGV');
      const c = argv && argv.type === 'array' ? argv.arr.exists(this.makeSub(i)) : null;
      if (c === null || c.v instanceof AwkArray || this.str(c.v).length === 0) { this.argIdx++; continue; }
      const arg = this.str(c.v);
      if (!this.opts.traditional) this.vars.get('ARGIND').value = i;
      if (!this.argAssign(arg, false)) {
        this.filesSeen = true;
        this.vars.get('FILENAME').value = c.v instanceof UserStr ? c.v : arg;
        this.FNR = 0;
        this.argIdx++;
        let data = '', errcode = 0;
        try { data = this.ctx.readFile(arg); }
        catch (e) { if (e instanceof FsError) errcode = e; else throw e; }
        this.curfile = { name: arg, data, off: 0, eof: false, errcode: errcode ? errnoOf(errcode) : 0, err: errcode, valid: !errcode, atStart: true };
        if (!this.opts.traditional) this.vars.get('ERRNO').value = errcode ? strerror(errcode) : '';
        return 1;
      }
      this.argIdx++;
    }
    if (!this.filesSeen) {
      this.filesSeen = true;
      const fn = this.vars.get('FILENAME');
      fn.value = new UserStr('-');
      let data = '';
      try { data = this.ctx.stdin.readAll(); } catch (e) { if (!(e instanceof FsError)) throw e; }
      this.curfile = { name: '-', data, off: 0, eof: false, errcode: 0, valid: true, atStart: true };
      return 1;
    }
    return -1;
  }
  // after_beginfile(): a file that could not be opened is a fatal error, a directory a warning
  afterBeginfile() {
    const iop = this.curfile;
    if (iop && !iop.valid) {
      this.curfile = null;
      if (iop.errcode === 'EISDIR' && !this.opts.traditional) {
        this.warning(`command line argument \`${iop.name}' is a directory: skipped`);
        return;
      }
      throw this.fatal(`cannot open file \`${iop.name}' for reading: ${strerror(iop.err)}`);
    }
  }
  inrec(iop) {
    const r = this.getRecord(iop);
    if (r === null) return false;
    this.NR++;
    this.FNR++;
    this.setRecord(r);
    return true;
  }
  // arg_assign() for a command-line var=value operand; false when it is a file name
  argAssign(arg, initing) {
    if (!initing && this.opts.disallowAssign) return false;
    const eq = arg.indexOf('=');
    if (eq < 0) return false;
    const name = arg.slice(0, eq), val = arg.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
    const saveFNR = this.FNR, saveLine = this.sourceline, saveSrc = this.source;
    this.FNR = 0; this.sourceline = 0; this.source = null;
    try {
      if (BUILTIN_NAMES.has(name)) throw this.fatal(`cannot use gawk builtin \`${name}' as variable name`);
      if (this.funcs.has(name)) throw this.fatal(`cannot use function \`${name}' as variable name`);
      let it;
      if (!this.opts.traditional && val[0] === '@' && val[1] === '/' && val[val.length - 1] === '/' && val.length >= 3) it = new TypedRe(val.slice(2, -1));
      else {
        if (this.opts.posix && val.includes('\n')) throw this.fatal('POSIX does not allow physical newlines in string values');
        it = new UserStr(this.scanEscapes(val, true));
      }
      const v = this.vars.get(name) || this.slot(name);
      if (v.type === 'array') throw this.fatal(`attempt to use array \`${name}' in a scalar context`);
      if (v.hook) this.readSpecial(v);
      v.type = 'var';
      v.value = it;
      if (v.hook) this.assignSpecial(v.hook);
    } finally {
      this.FNR = saveFNR; this.sourceline = saveLine; this.source = saveSrc;
    }
    return true;
  }
  // make_str_node(..., SCAN [| ELIDE_BACK_NL])
  scanEscapes(s, elide) {
    if (!s.includes('\\')) return s;
    let out = '';
    for (let i = 0; i < s.length;) {
      const ch = s[i++];
      if (ch !== '\\') { out += ch; continue; }
      const r = parseEscape(s, i, this.opts, (m) => this.escWarn(m));
      if (r.c < 0) { if (elide) { i = r.c === -2 ? r.i : i; continue; } out += '\\'; continue; }
      out += String.fromCharCode(r.c & 255);
      i = r.i;
    }
    return out;
  }
  escWarn(m) {
    if (m.startsWith('no hex')) { this.warning(m); return; }
    if (this.warned.has(m)) return;
    this.warned.add(m);
    this.warning(m);
  }

  // ------------------------------------------------------------ output and redirections
  flushStdoutQuiet() { try { this.stdout.flush(); } catch (e) { if (!(e instanceof PipeLimit)) throw e; } }
  // flush_io()
  flushIo() {
    this.stdout.flush();
    for (const rp of this.redirs) if (rp.out && rp.out.flush) rp.out.flush();
  }
  // redirect(): find or open the redirection; null when it could not be opened (errflg set)
  redirect(nameV, type, failureFatal, ret) {
    if (this.opts.sandbox) throw this.fatal('redirection not allowed in sandbox mode');
    const str = this.str(nameV);
    const what = { '>': '>', '>>': '>>', '|': '|', '<': '<', '|&': '|&', 'pipein': '|' }[type];
    if (str.length === 0) throw this.fatal(`expression for \`${what}' redirection has null string value`);
    const tflag = type === '>' || type === '>>' ? 'wfile' : type === '|' ? 'wpipe' : type === 'pipein' ? 'rpipe' : type === '<' ? 'rfile' : 'twoway';
    let rp = this.redirs.find(r => r.value === str && r.kind === tflag);
    if (!rp) {
      rp = { value: str, kind: tflag, out: null, iop: null, eofSticky: false, status: 0, append: type === '>>' };
      if (!this.openRedir(rp, type, failureFatal, ret)) return null;
      this.redirs.unshift(rp);
    } else if (!rp.out && !rp.iop && !rp.eofSticky && rp.kind !== 'rpipe') {
      if (!this.openRedir(rp, type, failureFatal, ret)) return null;
    }
    return rp;
  }
  openRedir(rp, type, failureFatal, ret) {
    const name = rp.value;
    switch (rp.kind) {
      case 'wfile': {
        if (name === '/dev/stdout' || name === '-') { rp.out = this.stdout; rp.std = true; return true; }
        if (name === '/dev/stderr') { rp.out = new Unbuf(this.ctx.stderr); rp.std = true; return true; }
        let sink;
        try { sink = this.ctx.openWrite(name, type === '>>'); }
        catch (e) {
          if (e instanceof FsError) {
            if (ret) ret.errno = e;
            if (failureFatal) throw this.fatal(`cannot redirect to \`${name}': ${strerror(e)}`);
            return false;
          }
          throw e;
        }
        rp.out = /^\/dev\/fd\/[12]$/.test(name) ? new Unbuf(sink) : new StdBuf(sink);
        return true;
      }
      case 'wpipe':
        this.flushIo();
        rp.out = new PipeBuf();
        return true;
      case 'rpipe': {
        const buf = new OutBuf(64 * 1024 * 1024);
        let status = 0;
        try { status = this.ctx.runShell(name, { stdout: buf, env: this.childEnv() }); }
        catch (e) { if (!(e instanceof PipeLimit)) throw e; }
        rp.iop = { name, data: buf.data, off: 0, eof: false, atStart: true };
        rp.status = sanitizeStatus(status);
        return true;
      }
      case 'rfile': {
        let data;
        try {
          data = this.ctx.readFile(name);
        } catch (e) {
          if (e instanceof FsError) { if (ret) ret.errno = e; return false; }
          throw e;
        }
        rp.iop = { name, data, off: 0, eof: false, atStart: true };
        return true;
      }
      case 'twoway':
        rp.out = new PipeBuf();
        rp.twoway = true;
        return true;
    }
    return false;
  }
  // the output stream for print/printf
  outTarget(redir) {
    if (!redir) return this.stdout;
    const nameV = this.evalScalar(redir.e);
    const ret = {};
    const rp = this.redirect(nameV, redir.op, true, ret);
    if (!rp) { if (ret.errno) this.setErrno(ret.errno); return null; }
    if (rp.twoway && !rp.out) throw this.fatal('print: attempt to write to closed write end of two-way pipe');
    return rp.out;
  }
  setErrno(e) { if (!this.opts.traditional) this.vars.get('ERRNO').value = typeof e === 'string' ? e : strerror(e); }
  // close_redir(): returns the status
  closeRedir(rp, how = 'all') {
    let status = 0;
    if (rp.std) { this.removeRedir(rp); return 0; }
    if (rp.kind === 'twoway') {
      if ((how === 'all' || how === 'to') && rp.out) { rp.data = rp.out.data; rp.out = null; }
      if (how === 'all' || how === 'from') {
        if (rp.iop === null && rp.data !== undefined) status = this.runPipeOut(rp.value, rp.data, null);
        else status = rp.status;
        rp.iop = null;
      }
      if (how === 'all' || (rp.iop === null && rp.out === null)) this.removeRedir(rp);
      return status;
    }
    if (rp.kind === 'wpipe') {
      status = this.runPipeOut(rp.value, rp.out ? rp.out.data : '', null);
      rp.out = null;
    } else if (rp.kind === 'wfile') {
      if (rp.out) rp.out.flush();
      rp.out = null;
    } else if (rp.kind === 'rpipe') {
      status = rp.status;
      rp.iop = null;
    } else rp.iop = null;
    this.removeRedir(rp);
    return status;
  }
  removeRedir(rp) { const i = this.redirs.indexOf(rp); if (i >= 0) this.redirs.splice(i, 1); }
  runPipeOut(cmd, data) {
    let st = 0;
    try { st = this.ctx.runShell(cmd, { stdin: data, env: this.childEnv() }); }
    catch (e) { if (!(e instanceof PipeLimit)) throw e; }
    return sanitizeStatus(st);
  }
  // close_io(): every redirection, then the standard output
  closeIo() {
    for (const rp of [...this.redirs]) this.closeRedir(rp);
    this.stdout.flush();
  }
  // after a fatal error: what exit() would still write
  fatalCleanup() {
    for (const rp of [...this.redirs]) {
      try {
        if (rp.kind === 'wfile' && rp.out && !rp.std) rp.out.flush();
        else if (rp.kind === 'wpipe' && rp.out) this.runPipeOut(rp.value, rp.out.data);
      } catch (e) { if (!(e instanceof PipeLimit) && !(e instanceof FatalExit)) throw e; }
    }
    this.redirs = [];
    this.flushStdoutQuiet();
  }

  // getline from a file, command or co-process (do_getline_redir)
  getlineRedir(e) {
    const type = e.kind === 'file' ? '<' : e.coproc ? '|&' : 'pipein';
    const nameV = this.evalScalar(e.src);
    const ret = {};
    const rp = this.redirect(nameV, type, false, ret);
    if (!rp) { if (ret.errno) this.setErrno(ret.errno); return -1; }
    if (rp.kind === 'twoway' && !rp.iop) {
      // run the co-process on what it has been sent so far
      if (rp.out) { rp.data = rp.out.data; }
      const buf = new OutBuf(64 * 1024 * 1024);
      let st = 0;
      try { st = this.ctx.runShell(rp.value, { stdout: buf, stdin: rp.data || '', env: this.childEnv() }); } catch (err) { if (!(err instanceof PipeLimit)) throw err; }
      rp.status = sanitizeStatus(st);
      rp.iop = { name: rp.value, data: buf.data, off: 0, eof: false, atStart: true };
    }
    const iop = rp.iop;
    if (!iop) return 0;
    const r = this.getRecord(iop);
    if (r === null) {
      if (rp.kind === 'rfile') rp.iop = null;
      rp.eofSticky = true;
      return 0;
    }
    if (e.target) this.assignTo(e.target, new UserStr(r), true);
    else { this.setRecord(r); }
    return 1;
  }
  // plain getline / getline var (Op_K_getline)
  getlineSimple(e) {
    if (!this.currule || this.currule === R_BEGINFILE || this.currule === R_ENDFILE)
      throw this.fatal(`non-redirected \`getline' invalid inside \`${RULETAB[this.currule]}' rule`);
    for (;;) {
      const ret = this.nextFile(false);
      if (ret <= 0) {
        const iop = this.curfile;
        if (!iop) return 0;
        const r = this.getRecord(iop);
        if (r === null) continue;
        this.NR++;
        this.FNR++;
        if (e.target) this.assignTo(e.target, new UserStr(r), true);
        else this.setRecord(r);
        return 1;
      }
      if (this.curfile === null) this.runFileRules(R_ENDFILE);
      else { this.runFileRules(R_BEGINFILE); this.afterBeginfile(); }
    }
  }
  runFileRules(kind) {
    const save = this.currule;
    this.currule = kind;
    try {
      for (const it of this.items) if (it.rk === kind) this.execAction(it);
    } finally { this.currule = save; }
  }

  // argv_store(): in sandbox mode only the original operands may be put in ARGV
  argvStore(val) {
    const s = this.str(val);
    if (s.length === 0) return;
    const eq = s.indexOf('=');
    const known = (this.opts.dArgv || []).includes(s);
    if (eq < 0) { if (!known) throw this.fatal(`cannot add a new file (${s}) to ARGV in sandbox mode`); return; }
    if (!/^[A-Za-z_][A-Za-z0-9_:]*$/.test(s.slice(0, eq)) && !known) throw this.fatal(`cannot add a new file (${s}) to ARGV in sandbox mode`);
  }

  // the environment of child processes: the original one, with ENVIRON's changes applied
  childEnv() { return this.envCopy || undefined; }
  envTouch(arr, op, sub, val) {
    if (arr !== this.environArr) return;
    if (!this.envCopy) this.envCopy = { ...(this.ctx.env || {}) };
    if (op === 'clear') { this.envCopy = {}; return; }
    if (op === 'set') this.envCopy[sub.s] = this.str(val);
    else delete this.envCopy[sub.s];
  }

  // ------------------------------------------------------------ assignment
  // assign a value to an lvalue node; fromInput: getline's assignment context
  assignTo(target, val, fromInput = false) {
    void fromInput;
    switch (target.t) {
      case 'var': return this.setVar(target.name, val);
      case 'idx': {
        const { arr, sub } = this.elemCell(target);
        const c = arr.lookup(sub);
        if (c.v instanceof AwkArray) throw this.fatal(`attempt to use array \`${this.arrayVname(arr)}["${sub.s}"]' in a scalar context`);
        if (val instanceof AwkArray) throw this.fatal(`attempt to use array \`${this.arrayVname(val)}' in a scalar context`);
        c.v = val;
        if (this.opts.sandbox && arr === this.argvArr) this.argvStore(val);
        if (arr === this.environArr) this.envTouch(arr, 'set', sub, val);
        return val;
      }
      case 'field': {
        const n = this.fieldIndex(this.evalScalar(target.e));
        return this.fieldSet(n, val);
      }
      case 'group': return this.assignTo(target.e, val, fromInput);
    }
    throw this.fatal('invalid target of assignment');
  }
  // an lvalue reference: { get(), set(v) } with the subscript/field index evaluated once
  lref(target) {
    switch (target.t) {
      case 'var': {
        const name = target.name;
        return { get: () => { const v = this.slot(name); if (v.type === 'array' || (v.type === 'ref' && this.deref(v).type === 'array')) throw this.fatal(`attempt to use array \`${this.slotVname(v)}' in a scalar context`); return this.getVar(name); }, set: (v) => this.setVar(name, v) };
      }
      case 'idx': {
        const { arr, sub } = this.elemCell(target);
        const c = arr.lookup(sub);
        if (c.v instanceof AwkArray) throw this.fatal(`attempt to use array \`${this.arrayVname(arr)}["${sub.s}"]' in a scalar context`);
        return { get: () => c.v, set: (v) => { c.v = v; if (this.opts.sandbox && arr === this.argvArr) this.argvStore(v); if (arr === this.environArr) this.envTouch(arr, 'set', sub, v); return v; } };
      }
      case 'field': {
        const n = this.fieldIndex(this.evalScalar(target.e));
        this.getField(n, true);
        return { get: () => this.fieldGet(n), set: (v) => this.fieldSet(n, v) };
      }
      case 'group': return this.lref(target.e);
    }
    throw this.fatal('invalid target of assignment');
  }

  // ------------------------------------------------------------ expressions
  evalScalar(e) {
    const v = this.eval(e);
    if (v instanceof AwkArray) throw this.fatal(`attempt to use array \`${this.arrayVname(v)}' in a scalar context`);
    return v;
  }
  eval(e) {
    switch (e.t) {
      case 'num': return e.v;
      case 'str': return e.v;
      case 'group': return this.eval(e.e);
      case 'var': return this.getVar(e.name);
      case 'idx': {
        const { arr, sub } = this.elemCell(e);
        const c = arr.lookup(sub);
        return c.v;
      }
      case 'field': {
        if (e.line) this.sourceline = e.line;
        return this.fieldGet(this.fieldIndex(this.evalScalar(e.e)));
      }
      case 'regex': {
        const rp = this.regexOf(e);
        const rec = this.fieldGet(0);
        return this.search(rp, this.str(rec), 0) ? 1 : 0;
      }
      case 'typedregex': return new TypedRe(e.src);
      case 'assign': return this.evalAssign(e);
      case 'cond': return this.bool(this.evalScalar(e.c)) ? this.eval(e.a) : this.eval(e.b);
      case 'or': return this.bool(this.evalScalar(e.a)) || this.bool(this.evalScalar(e.b)) ? 1 : 0;
      case 'and': return this.bool(this.evalScalar(e.a)) && this.bool(this.evalScalar(e.b)) ? 1 : 0;
      case 'not': {
        if (e.e.t === 'regex') return this.eval(e.e) ? 0 : 1;
        return this.bool(this.evalScalar(e.e)) ? 0 : 1;
      }
      case 'neg': return -this.num(this.evalScalar(e.e));
      case 'pos': return this.num(this.evalScalar(e.e));
      case 'in': {
        const key = e.subs.length === 1 ? this.evalScalar(e.subs[0]) : e.subs.map(x => this.str(this.evalScalar(x))).join(this.SUBSEP);
        const arr = e.nameNode ? this.arrayOf(e.nameNode) : this.getArray(e.name);
        return arr.exists(this.makeSub(key)) ? 1 : 0;
      }
      case 'match': {
        const s = this.str(this.evalScalar(e.a));
        const rp = this.regexOf(e.re);
        const m = this.search(rp, s, 0);
        return (m ? !e.neg : e.neg) ? 1 : 0;
      }
      case 'cmp': {
        const a = this.evalScalar(e.a), b = this.evalScalar(e.b);
        const c = this.cmpNodes(a, b);
        switch (e.op) {
          case '<': return c < 0 ? 1 : 0;
          case '<=': return c <= 0 ? 1 : 0;
          case '>': return c > 0 ? 1 : 0;
          case '>=': return c >= 0 ? 1 : 0;
          case '==': return c === 0 ? 1 : 0;
          case '!=': return c !== 0 ? 1 : 0;
        }
        return 0;
      }
      case 'concat': {
        // Op_concat over the whole chain of adjacent expressions, left to right
        const parts = [];
        let n = e;
        const stack = [];
        while (n.t === 'concat') { stack.push(n.b); n = n.a; }
        parts.push(this.str(this.evalScalar(n)));
        for (let i = stack.length - 1; i >= 0; i--) parts.push(this.str(this.evalScalar(stack[i])));
        return parts.join('');
      }
      case 'bin': {
        const a = this.num(this.evalScalar(e.a)), b = this.num(this.evalScalar(e.b));
        switch (e.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/':
            if (b === 0) { if (e.line) this.sourceline = e.line; throw this.fatal('division by zero attempted'); }
            return a / b;
          case '%':
            if (b === 0) { if (e.line) this.sourceline = e.line; throw this.fatal("division by zero attempted in `%'"); }
            return a % b;
        }
        return 0;
      }
      case 'pow': return calcExp(this.num(this.evalScalar(e.a)), this.num(this.evalScalar(e.b)));
      case 'preinc': {
        const r = this.lref(e.target);
        const v = this.num(r.get()) + (e.op === '++' ? 1 : -1);
        r.set(v);
        return v;
      }
      case 'postinc': {
        const r = this.lref(e.target);
        const old = this.num(r.get());
        r.set(old + (e.op === '++' ? 1 : -1));
        return old;
      }
      case 'call': return this.callUser(e, e.name);
      case 'indirect': return this.callIndirect(e);
      case 'builtin': {
        if (e.line) this.sourceline = e.line;
        return this.builtin(e);
      }
      case 'getline':
        return e.kind === 'simple' ? this.getlineSimple(e) : this.getlineRedir(e);
      case 'stmtexpr': this.exec(e.s); return 1;
    }
    throw this.fatal(`internal error: unknown expression ${e.t}`);
  }
  evalAssign(e) {
    if (e.op === '=') {
      // the right-hand side first, then the target's subscripts or field number
      let v = this.eval(e.e);
      if (v instanceof AwkArray) throw this.fatal(`attempt to use array \`${this.arrayVname(v)}' in a scalar context`);
      if (v instanceof UserStr) v = copyUser(v);
      return this.assignTo(e.target, v);
    }
    const r2 = this.num(this.evalScalar(e.e));
    const ref = this.lref(e.target);
    const x1 = this.num(ref.get());
    let x;
    switch (e.op) {
      case '+=': x = x1 + r2; break;
      case '-=': x = x1 - r2; break;
      case '*=': x = x1 * r2; break;
      case '/=': if (r2 === 0) throw this.fatal("division by zero attempted in `/='"); x = x1 / r2; break;
      case '%=': if (r2 === 0) throw this.fatal("division by zero attempted in `%='"); x = x1 % r2; break;
      case '^=': x = calcExp(x1, r2); break;
    }
    return ref.set(x);
  }
  // the compiled regexp of a regex constant or of an expression's string value (re_update)
  regexOf(node) {
    if (node.t === 'regex' || node.t === 'typedregex') return this.compileFatal(node.src, this.ignorecase);
    const v = this.evalScalar(node);
    if (v instanceof TypedRe) return this.compileFatal(v.src, this.ignorecase);
    return this.compileFatal(this.str(v), this.ignorecase);
  }

  // ------------------------------------------------------------ user functions
  callIndirect(e) {
    const fv = this.getVar(e.name);
    const fname = this.str(fv);
    if (this.funcs.has(fname)) return this.callUser(e, fname);
    if (INDIRECT_BUILTINS.has(fname)) return this.builtin({ t: 'builtin', name: fname, args: e.args, line: e.line, indirect: true });
    throw this.fatal(`\`${fname}' is not a function, so it cannot be called indirectly`);
  }
  callUser(e, name) {
    const f = this.funcs.get(name);
    if (!f) { if (e.line) this.sourceline = e.line; throw this.fatal(`function \`${name}' not defined`); }
    const pcount = f.params.length;
    const args = e.args || [];
    // evaluate the arguments: a bare variable is passed as itself (arrays by reference)
    const vals = [];
    for (let i = 0; i < args.length; i++) {
      let a = args[i];
      while (a.t === 'group') a = a.e;
      if (a.t === 'var') {
        const v = this.slot(a.name);
        if (v.hook) { vals.push({ val: this.readSpecial(v) }); continue; }
        if (v.type === 'var') { vals.push({ val: v.value }); continue; }
        vals.push({ ref: v });
        continue;
      }
      const val = this.eval(a);
      if (val instanceof AwkArray) vals.push({ arr: val });
      else vals.push({ val: val instanceof UserStr ? copyUser(val) : val });
    }
    if (vals.length > pcount) {
      this.warning(`function \`${name}' called with more arguments than declared`);
      vals.length = pcount;
    }
    const slots = [];
    for (let i = 0; i < pcount; i++) {
      const s = new Var(f.params[i]);
      if (i < vals.length) {
        const a = vals[i];
        if (a.ref) {
          const r = a.ref;
          if (r.type === 'var') { s.type = 'var'; s.value = undefined; }
          else if (r.type === 'ref') { s.type = 'ref'; s.orig = this.deref(r) === r ? r : r; s.orig = r; }
          else { s.type = 'ref'; s.orig = r; }
        } else if (a.arr) { s.type = 'array'; s.arr = a.arr; }
        else { s.type = 'var'; s.value = a.val; }
      }
      slots.push(s);
    }
    if (this.frames.length > 20000) throw this.fatal('function call nesting too deep');
    const saveLine = this.sourceline, saveSrc = this.source;
    this.frames.push({ fn: f, slots });
    this.source = f.src;
    try {
      this.execBlock(f.body);
      return undefined;
    } catch (s) {
      if (s instanceof RetSig) return s.v;
      throw s;
    } finally {
      this.frames.pop();
      this.sourceline = saveLine;
      this.source = saveSrc;
    }
  }
  isFunction(name) { return this.funcs.has(name); }
  // a sorted_in / asort comparison function
  callCompare(fname, a, b) {
    const f = this.funcs.get(fname);
    const vals = [a.key, a.cell.v, b.key, b.cell.v];
    const slots = f.params.map((p, i) => {
      const s = new Var(p);
      if (i < 4) {
        const v = vals[i];
        if (v instanceof AwkArray) { s.type = 'array'; s.arr = v; } else { s.type = 'var'; s.value = v; }
      }
      return s;
    });
    const saveRule = this.currule;
    this.currule = R_NONE;
    this.frames.push({ fn: f, slots });
    let r;
    try { this.execBlock(f.body); r = undefined; }
    catch (s) { if (s instanceof RetSig) r = s.v; else throw s; }
    finally { this.frames.pop(); this.currule = saveRule; }
    const n = this.num(r);
    return n < 0 ? -1 : n > 0 ? 1 : 0;
  }

  // ------------------------------------------------------------ statements
  execBlock(b) { for (const s of b.body) this.exec(s); }
  exec(s) {
    this.tick();
    if (s.line) this.sourceline = s.line;
    switch (s.t) {
      case 'block': this.execBlock(s); return;
      case 'expr': this.eval(s.e); return;
      case 'print': return this.doPrint(s);
      case 'printf': return this.doPrintf(s);
      case 'if': if (this.bool(this.evalScalar(s.c))) this.exec(s.then); else if (s.els) this.exec(s.els); return;
      case 'while':
        while (this.bool(this.evalScalar(s.c))) {
          try { this.exec(s.body); } catch (x) { if (x instanceof BrkSig) break; if (x instanceof ContSig) continue; throw x; }
        }
        return;
      case 'do':
        do {
          try { this.exec(s.body); } catch (x) { if (x instanceof BrkSig) break; if (x instanceof ContSig) continue; throw x; }
        } while (this.bool(this.evalScalar(s.c)));
        return;
      case 'for':
        if (s.init) this.evalInit(s.init);
        while (!s.c || this.bool(this.evalScalar(s.c))) {
          try { this.exec(s.body); } catch (x) { if (x instanceof BrkSig) break; if (!(x instanceof ContSig)) throw x; }
          if (s.step) this.evalInit(s.step);
        }
        return;
      case 'forin': return this.execForIn(s);
      case 'switch': return this.execSwitch(s);
      case 'break': throw new BrkSig();
      case 'continue': throw new ContSig();
      case 'next':
        if (this.currule !== R_RULE) throw this.fatal(`\`next' cannot be called from a \`${RULETAB[this.currule]}' rule`);
        throw new NextSig();
      case 'nextfile':
        if (this.currule !== R_RULE && this.currule !== R_BEGINFILE) throw this.fatal(`\`nextfile' cannot be called from a \`${RULETAB[this.currule]}' rule`);
        throw new NextFileSig();
      case 'exit': {
        if (!this.currule) throw this.fatal("`exit' cannot be called in the current context");
        this.exiting = true;
        if (s.e) this.exitVal = Number(BigInt.asIntN(32, BigInt(toLong(this.num(this.evalScalar(s.e))))));
        throw new ExitSig();
      }
      case 'return': {
        let v = s.e ? this.eval(s.e) : undefined;
        if (v instanceof AwkArray) throw this.fatal(`attempt to use array \`${this.arrayVname(v)}' in a scalar context`);
        if (v instanceof UserStr) v = copyUser(v);
        throw new RetSig(v);
      }
      case 'delete': return this.execDelete(s);
    }
    throw this.fatal(`internal error: unknown statement ${s.t}`);
  }
  evalInit(x) { if (x.t === 'stmtexpr') this.exec(x.s); else this.eval(x); }
  execForIn(s) {
    const arr = s.arrNode ? this.arrayOf(s.arrNode) : this.getArray(s.arr);
    if (isDeleteLoop(s)) {
      // `for (k in a) delete a[k]': k gets one index and the array is cleared in one go
      if (arr.size === 0) return;
      const one = arr.listRaw(AK.AINDEX | AK.ADELETE, []);
      this.setVar(s.v, one[0].key);
      arr.clear();
      return;
    }
    if (arr.size === 0) return;
    let how = '@unsorted';
    if (!this.opts.posix) {
      const pi = this.vars.get('PROCINFO');
      if (pi && pi.type === 'array') {
        const c = pi.arr.exists(this.makeSub('sorted_in'));
        if (c && !(c.v instanceof AwkArray)) { const h = this.str(c.v); if (h.length) how = h; }
      }
    }
    const list = assocList(arr, how, 'SORTED_IN', this.sortRT());
    for (const ent of list) {
      this.tick();
      this.setVar(s.v, typeof ent.key === 'object' && ent.key instanceof UserStr ? new UserStr(ent.key.s) : ent.key);
      try { this.exec(s.body); } catch (x) { if (x instanceof BrkSig) break; if (x instanceof ContSig) continue; throw x; }
    }
  }
  sortRT() {
    return this._sortRT ||= {
      cmpNumbers: (a, b) => this.cmpNumbers(a, b), num: (v) => this.num(v), str: (v) => this.str(v),
      isNumeric: (v) => this.isNumeric(v), isString: (v) => this.isString(v), ignoreCase: () => this.ignorecase,
      isFunction: (n) => this.funcs.has(n), callCompare: (f, a, b) => this.callCompare(f, a, b), fatal: (m) => this.fatal(m),
    };
  }
  execSwitch(s) {
    const v = this.evalScalar(s.e);
    let start = -1;
    for (let i = 0; i < s.cases.length && start < 0; i++) {
      const c = s.cases[i];
      if (c.dflt) continue;
      if (c.v.t === 'regex' || c.v.t === 'typedregex') {
        const rp = this.compileFatal(c.v.src, this.ignorecase);
        if (this.search(rp, this.str(v), 0)) start = i;
      } else if (this.cmpNodes(v, c.v.v) === 0) start = i;
    }
    if (start < 0) start = s.cases.findIndex(c => c.dflt);
    if (start < 0) return;
    try {
      for (let i = start; i < s.cases.length; i++) this.execBlock(s.cases[i].body);
    } catch (x) { if (!(x instanceof BrkSig)) throw x; }
  }
  execDelete(s) {
    if (!s.dims) {
      const arr = this.getArray(s.name);
      arr.clear();
      this.envTouch(arr, 'clear');
      return;
    }
    let arr = this.getArray(s.name);
    const dims = s.dims;
    const keys = dims.map(d => this.subValue(d));
    for (let i = 0; i < keys.length; i++) {
      const sub = this.makeSub(keys[i]);
      const c = arr.exists(sub);
      if (c === null) return;
      if (i < keys.length - 1) {
        if (!(c.v instanceof AwkArray)) throw this.fatal(`attempt to use scalar \`${this.arrayVname(arr)}["${sub.s}"]' as an array`);
        arr = c.v;
        continue;
      }
      if (c.v instanceof AwkArray) c.v.clear();
      arr.remove(sub);
      this.envTouch(arr, 'remove', sub);
    }
  }
  doPrint(s) {
    // the redirection first, then the expressions
    let out = this.stdout;
    if (s.redir) { out = this.outTarget(s.redir); }
    let line;
    if (!s.args.length || (s.args.length === 1 && s.args[0].t === 'field' && s.args[0].e.t === 'num' && s.args[0].e.v === 0)) line = this.str(this.fieldGet(0));
    else {
      const parts = [];
      for (const a of s.args) parts.push(this.outStr(this.evalScalar(a)));
      line = parts.join(this.OFS);
    }
    if (out) out.write(line + this.ORS);
  }
  doPrintf(s) {
    let out = this.stdout;
    if (s.redir) out = this.outTarget(s.redir);
    if (!s.args.length) {
      if (this.opts.traditional) return;
      throw this.fatal('printf: no arguments');
    }
    const vals = s.args.map(a => this.evalScalar(a));
    const fmt = this.str(vals[0]);
    let r;
    try { r = formatTree(this.fmtRT, fmt, vals, this.opts); }
    catch (e) { this.rethrow(e); }
    if (out) out.write(r);
  }

  // ------------------------------------------------------------ the program
  execAction(it) {
    this.source = it.src === undefined ? null : it.src;
    if (it.line) this.sourceline = it.line;
    this.execBlock(it.action);
  }
  // interpret(): BEGIN, the records, END, then everything is closed
  run() {
    for (const it of this.items) it.rk = it.kind === 'BEGIN' ? R_BEGIN : it.kind === 'END' ? R_END : it.kind === 'BEGINFILE' ? R_BEGINFILE : it.kind === 'ENDFILE' ? R_ENDFILE : R_RULE;
    const rules = this.items.filter(it => it.rk === R_RULE);
    const hasMain = this.items.some(it => it.rk !== R_BEGIN);
    let toEnd = false;
    try {
      this.currule = R_BEGIN;
      for (const it of this.items) if (it.rk === R_BEGIN) this.execAction(it);
    } catch (s) {
      if (s instanceof ExitSig) toEnd = true;
      else throw s;
    }
    if (hasMain && !toEnd) {
      try { this.mainLoop(rules); }
      catch (s) { if (!(s instanceof ExitSig)) throw s; }
    }
    if (!(this.exiting && this.currule === R_END)) {
      try {
        this.currule = R_END;
        for (const it of this.items) if (it.rk === R_END) this.execAction(it);
      } catch (s) { if (!(s instanceof ExitSig)) throw s; }
    }
    // Op_atexit
    this.source = null;
    this.sourceline = 0;
    this.curfile = null;
    this.closeIo();
    return this.exitVal & 255;
  }
  mainLoop(rules) {
    for (;;) {
      // Op_newfile
      const ret = this.nextFile(false);
      if (ret < 0) return;
      if (ret > 0) {
        if (this.curfile === null) { this.runFileRules(R_ENDFILE); continue; }
        let skipped = false;
        try { this.runFileRules(R_BEGINFILE); }
        catch (x) {
          if (!(x instanceof NextFileSig)) throw x;
          // nextfile in BEGINFILE: skip the file (ENDFILE runs unless it could not be opened)
          const ok = this.nextFile(true);
          if (ok) this.runFileRules(R_ENDFILE);
          skipped = true;
        }
        if (skipped) continue;
        this.afterBeginfile();
        if (this.curfile === null) continue;
      }
      // Op_get_record
      if (!this.curfile) return;
      if (!this.inrec(this.curfile)) continue;
      this.currule = R_RULE;
      try {
        for (const rule of rules) {
          if (rule.pattern2) {
            if (!rule.triggered) {
              if (!this.bool(this.evalPattern(rule.pattern, rule))) continue;
              rule.triggered = true;
              if (this.bool(this.evalPattern(rule.pattern2, rule))) rule.triggered = false;
            } else if (this.bool(this.evalPattern(rule.pattern2, rule))) rule.triggered = false;
          } else if (rule.pattern && !this.bool(this.evalPattern(rule.pattern, rule))) continue;
          if (rule.action) this.execAction(rule);
          else this.stdout.write(this.str(this.fieldGet(0)) + this.ORS);
        }
      } catch (s) {
        if (s instanceof NextSig) continue;
        if (s instanceof NextFileSig) {
          this.nextFile(true);
          this.runFileRules(R_ENDFILE);
          continue;
        }
        throw s;
      }
    }
  }
  evalPattern(p, it) {
    if (it) this.source = it.src === undefined ? null : it.src;
    if (p.line) this.sourceline = p.line;
    return this.evalScalar(p);
  }

  // ------------------------------------------------------------ builtins (builtin.c)
  builtin(e) {
    const name = e.name;
    const args = e.args;
    let A;
    if (PLAIN_BUILTINS.has(name)) {
      const vals = args.map(a => this.evalScalar(a));
      A = (k) => vals[k];
    } else A = (k) => this.evalScalar(args[k]);
    switch (name) {
      case 'length': {
        if (!args.length) return this.str(this.fieldGet(0)).length;
        let a = args[0];
        while (a.t === 'group') a = a.e;
        if (a.t === 'var') {
          const v = this.slot(a.name);
          const o = v.type === 'ref' ? this.deref(v) : v;
          if (v.type === 'array') return v.arr.size;
          if (o.type === 'array') return o.arr.size;
          if (this.opts.posix && o.type === 'array') throw this.fatal('length: received array argument');
          return this.str(this.getVar(a.name)).length;
        }
        const val = this.eval(a);
        if (val instanceof AwkArray) return val.size;
        return this.str(val).length;
      }
      case 'substr': {
        let dLength = 0;
        if (args.length === 3) dLength = this.num(A(2));
        let dIndex = this.num(A(1));
        const s = this.str(A(0));
        let length;
        if (args.length === 3) {
          if (!(dLength >= 1)) return '';
          length = dLength < Number.MAX_SAFE_INTEGER ? Math.trunc(dLength) : Number.MAX_SAFE_INTEGER;
        }
        if (!(dIndex >= 1)) dIndex = 1;
        const indx = dIndex <= Number.MAX_SAFE_INTEGER ? Math.trunc(dIndex - 1) : Number.MAX_SAFE_INTEGER;
        if (args.length === 2) length = s.length - indx;
        if (s.length === 0) return '';
        if (indx >= s.length) return '';
        if (length > s.length - indx) length = s.length - indx;
        return s.substr(indx, length);
      }
      case 'index': {
        const s1 = this.str(A(0)), s2 = this.str(A(1));
        if (s2.length === 0) return 1;
        if (this.ignorecase) return lowerAscii(s1).indexOf(lowerAscii(s2)) + 1;
        return s1.indexOf(s2) + 1;
      }
      case 'split': return this.doSplit(e);
      case 'patsplit': return this.doPatsplit(e);
      case 'sub': case 'gsub': case 'gensub': return this.doSub(e);
      case 'match': return this.doMatch(e);
      case 'sprintf': {
        if (!args.length) throw this.fatal('sprintf: no arguments');
        const vals = args.map((a, k) => A(k));
        try { return formatTree(this.fmtRT, this.str(vals[0]), vals, this.opts); }
        catch (err) { this.rethrow(err); }
        return '';
      }
      case 'sin': return Math.sin(this.num(A(0)));
      case 'cos': return Math.cos(this.num(A(0)));
      case 'atan2': { const a = this.num(A(0)), b = this.num(A(1)); return Math.atan2(a, b); }
      case 'exp': {
        const d = this.num(A(0));
        const r = Math.exp(d);
        if (Number.isFinite(d) && (!Number.isFinite(r) || r < 2.2250738585072014e-308)) this.warning(`exp: argument ${cg(d)} is out of range`);
        return r;
      }
      case 'log': {
        const x = this.num(A(0));
        if (x < 0) this.warning(`log: received negative argument ${cg(x)}`);
        return Math.log(x);
      }
      case 'sqrt': {
        const x = this.num(A(0));
        if (x < 0) this.warning(`sqrt: received negative argument ${cg(x)}`);
        return Math.sqrt(x);
      }
      case 'int': return doubleToInt(this.num(A(0)));
      case 'rand': return this.random.rand();
      case 'srand': return this.random.srand(args.length ? this.num(A(0)) : undefined);
      case 'tolower': return this.str(A(0)).replace(/[A-Z]+/g, (m) => m.toLowerCase());
      case 'toupper': return this.str(A(0)).replace(/[a-z]+/g, (m) => m.toUpperCase());
      case 'system': {
        if (this.opts.sandbox) throw this.fatal("'system' function not allowed in sandbox mode");
        this.flushIo();
        const cmd = this.str(A(0));
        if (!cmd.length) return 0;
        let st = 0;
        try { st = this.ctx.runShell(cmd, { env: this.childEnv() }); }
        catch (err) { if (!(err instanceof PipeLimit)) throw err; }
        return this.opts.traditional ? st : sanitizeStatus(st);
      }
      case 'close': {
        let how = 'all';
        if (args.length === 2) {
          const h = this.str(A(1)).toLowerCase();
          if (h === 'to') how = 'to'; else if (h === 'from') how = 'from';
          else throw this.fatal("close: second argument must be `to' or `from'");
        }
        const nm = this.str(A(0));
        const rp = this.redirs.find(r => r.value === nm);
        if (!rp) {
          this.setErrno('close of redirection that was never opened');
          return -1;
        }
        this.stdout.flush();
        const st = this.closeRedir(rp, how);
        return this.opts.posix ? 0 : st;
      }
      case 'fflush': {
        if (!args.length) { this.flushIo(); return 0; }
        const nm = this.str(A(0));
        if (nm === '') { this.flushIo(); return 0; }
        const rp = this.redirs.find(r => r.value === nm);
        if (rp) {
          if (rp.kind === 'rfile' || rp.kind === 'rpipe') {
            this.warning(rp.kind === 'rpipe' ? `fflush: cannot flush: pipe \`${nm}' opened for reading, not writing` : `fflush: cannot flush: file \`${nm}' opened for reading, not writing`);
            return -1;
          }
          if (rp.out && rp.out.flush) rp.out.flush();
          return 0;
        }
        if (nm === '/dev/stdout') { this.stdout.flush(); return 0; }
        if (nm === '/dev/stderr') return 0;
        this.warning(`fflush: \`${nm}' is not an open file, pipe or co-process`);
        return -1;
      }
      case 'systime': return Math.floor(Date.now() / 1000);
      case 'strftime': {
        let fmt = '%a %b %e %H:%M:%S %Z %Y';
        const pi = this.vars.get('PROCINFO');
        if (pi && pi.type === 'array') { const c = pi.arr.exists(this.makeSub('strftime')); if (c && !(c.v instanceof AwkArray)) fmt = this.str(c.v); }
        let clock = Math.floor(Date.now() / 1000);
        if (args.length) {
          if (args.length === 3) void this.bool(A(2));
          if (args.length >= 2) {
            const cv = this.num(A(1));
            if (!(cv >= -67768040609740800 && cv <= 67767976233316800)) return '';
            clock = Math.trunc(cv);
          }
          fmt = this.str(A(0));
          if (fmt.length === 0) return '';
        }
        const d = new Date(clock * 1000);
        if (Number.isNaN(d.getTime())) return '';
        return strftime(fmt, d);
      }
      case 'mktime': {
        if (args.length === 2) void this.bool(A(1));
        const s = this.str(A(0));
        const vals = scanInts(s, 7);
        if (vals.length < 6) return -1;
        const [year, month, day, hour, minute, second] = vals;
        const dt = new Date(0);
        dt.setUTCFullYear(year, month - 1, day);
        dt.setUTCHours(hour, minute, second, 0);
        const v = Math.floor(dt.getTime() / 1000);
        return Number.isFinite(v) ? v : -1;
      }
      case 'asort': case 'asorti': return this.doAsort(e);
      case 'and': case 'or': case 'xor': {
        if (args.length < 2) throw this.fatal(`${name}: called with less than two arguments`);
        let res = name === 'and' ? (1n << 64n) - 1n : 0n;
        for (let k = args.length; k > 0; k--) {
          const val = this.num(A(k - 1));
          if (val < 0) throw this.fatal(`${name}: argument ${k} negative value ${cg(val)} is not allowed`);
          const u = toUintmax(val);
          if (name === 'and') res &= u; else if (name === 'or') res |= u; else res ^= u;
        }
        return Number(adjustUint(res));
      }
      case 'lshift': case 'rshift': {
        const val = this.num(A(0)), shift = this.num(A(1));
        if (val < 0 || shift < 0) throw this.fatal(`${name}(${cFloat(val, 'f')}, ${cFloat(shift, 'f')}): negative values are not allowed`);
        const u = toUintmax(val), sh = toUintmax(shift);
        let res;
        if (name === 'lshift') res = sh >= 64n ? 0n : BigInt.asUintN(64, u << sh);
        else res = sh >= 64n ? 0n : u >> sh;
        return Number(adjustUint(res));
      }
      case 'compl': {
        const d = this.num(A(0));
        if (d < 0) throw this.fatal(`compl(${cFloat(d, 'f')}): negative value is not allowed`);
        return Number(adjustUint(BigInt.asUintN(64, ~toUintmax(d))));
      }
      case 'strtonum': {
        const v = A(0);
        if (this.isNumeric(v)) return this.num(v);
        const s = this.str(v);
        if (getNumbase(s) !== 10) return nondec2awknum(s).v;
        return this.num(v);
      }
      case 'typeof': {
        if (args.length === 2) { const dbg = this.arrayOf(args[1]); dbg.clear(); }
        let a = args[0];
        while (a.t === 'group') a = a.e;
        if (a.t === 'var') {
          const v = this.slot(a.name);
          if (v.type === 'array') return 'array';
          if (v.type === 'new') return 'untyped';
          if (v.type === 'ref') return this.deref(v).type === 'array' ? 'array' : 'untyped';
          return this.typeOf(v.hook ? this.readSpecial(v) : v.value);
        }
        const val = this.eval(a);
        return this.typeOf(val);
      }
      case 'isarray': {
        let a = args[0];
        while (a.t === 'group') a = a.e;
        if (a.t === 'var') {
          const v = this.slot(a.name);
          if (v.type === 'array') return 1;
          if (v.type === 'ref') return this.deref(v).type === 'array' ? 1 : 0;
          return 0;
        }
        return this.eval(a) instanceof AwkArray ? 1 : 0;
      }
      case 'dcgettext': return this.str(A(0));
      case 'dcngettext': { const n = this.num(A(2)); return this.str(n === 1 ? A(0) : A(1)); }
      case 'bindtextdomain': return args.length ? '' : '';
      case 'intdiv0': {
        const n = doubleToInt(this.num(A(0))), d = doubleToInt(this.num(A(1)));
        if (d === 0) throw this.fatal('intdiv: division by zero attempted');
        const arr = this.arrayOf(args[2]);
        arr.clear();
        this.arrSet(arr, 'quotient', doubleToInt(n / d));
        this.arrSet(arr, 'remainder', n % d);
        return 0;
      }
    }
    throw this.fatal(`function \`${name}' not defined`);
  }
  // the target array of split()-like builtins
  targetArray(node, fname, which) {
    let a = node;
    while (a.t === 'group') a = a.e;
    if (a.t === 'var' || a.t === 'idx') return this.arrayOf(a);
    const v = this.eval(a);
    if (v instanceof AwkArray) return v;
    throw this.fatal(`${fname}: ${which} argument is not an array`);
  }
  doSplit(e) {
    const args = e.args;
    let sepArr = null;
    if (args.length === 4) {
      if (this.opts.traditional || this.opts.posix) throw this.fatal('split: fourth argument is a gawk extension');
      sepArr = this.targetArray(args[3], 'split', 'fourth');
    }
    // evaluation order: the string, then the separator
    const src = this.str(this.evalScalar(args[0]));
    let sepNode = args[2], fsDefault = false, sepVal;
    if (args.length === 2) { fsDefault = true; sepVal = this.vars.get('FS').value; }
    else if (sepNode.t === 'regex' || sepNode.t === 'typedregex') sepVal = new TypedRe(sepNode.src);
    else sepVal = this.evalScalar(sepNode);
    const arr = this.targetArray(args[1], 'split', 'second');
    if (sepArr !== null) {
      if (sepArr === arr) throw this.fatal('split: cannot use the same array for second and fourth args');
      sepArr.clear();
    }
    arr.clear();
    if (src.length === 0) return 0;
    const setEl = (a) => (n, b, l) => this.arrSet(a, n, new UserStr(src.substr(b, l)));
    const set = setEl(arr);
    const sepFn = sepArr ? setEl(sepArr) : null;
    let r;
    if (fsDefault && this.curFieldSep() === 'FS' && !this.rsIsNull) {
      r = this.parseField(Infinity, src, 0, src.length, { s: this.str(this.vars.get('FS').value) }, sepFn, false, true, set, this.fsRegex, this.parser);
    } else {
      const isConst = sepVal instanceof TypedRe && (sepNode && (sepNode.t === 'regex' || sepNode.t === 'typedregex'));
      const fs = sepVal instanceof TypedRe ? sepVal.src : this.str(sepVal);
      if (fs.length === 0) r = this.parseField(Infinity, src, 0, src.length, { s: '' }, sepFn, false, true, set, null, 'null');
      else if (fs.length === 1 && !isConst && !(sepVal instanceof TypedRe)) {
        if (fs === ' ') r = this.parseField(Infinity, src, 0, src.length, { s: ' ' }, sepFn, false, true, set, null, 'def');
        else r = this.parseField(Infinity, src, 0, src.length, { s: fs }, sepFn, false, true, set, null, 'sc');
      } else {
        const rp = this.compileFatal(fs, this.ignorecase);
        r = this.parseField(Infinity, src, 0, src.length, { s: fs }, sepFn, false, true, set, rp, 're');
      }
    }
    return r.nf;
  }
  doPatsplit(e) {
    const args = e.args;
    let sepArr = null;
    if (args.length === 4) sepArr = this.targetArray(args[3], 'patsplit', 'fourth');
    const src = this.str(this.evalScalar(args[0]));
    let fpat;
    if (args.length >= 3) {
      const n = args[2];
      fpat = n.t === 'regex' || n.t === 'typedregex' ? n.src : this.str(this.evalScalar(n));
    } else fpat = this.str(this.vars.get('FPAT').value);
    const arr = this.targetArray(args[1], 'patsplit', 'second');
    if (fpat.length === 0) throw this.fatal('patsplit: third argument must be non-null');
    if (sepArr !== null) {
      if (sepArr === arr) throw this.fatal('patsplit: cannot use the same array for second and fourth args');
      sepArr.clear();
    }
    arr.clear();
    if (src.length === 0) return 0;
    const rp = this.compileFatal(fpat, this.ignorecase);
    const set = (n, b, l) => this.arrSet(arr, n, new UserStr(src.substr(b, l)));
    const sepFn = sepArr ? (n, b, l) => this.arrSet(sepArr, n, new UserStr(src.substr(b, l))) : null;
    return this.fpatParseField(Infinity, src, 0, src.length, sepFn, set, 0, rp).nf;
  }
  doMatch(e) {
    const args = e.args;
    let dest = null;
    if (args.length === 3) dest = this.targetArray(args[2], 'match', 'third');
    const s = this.str(this.evalScalar(args[0]));
    const rp = this.regexOf(args[1]);
    if (dest) dest.clear();
    const m = this.search(rp, s, 0);
    let rstart, rlength;
    if (m) {
      rstart = m.index + 1;
      rlength = m[0].length;
      if (dest) {
        const ind = m.indices;
        for (let ii = 0; ii <= rp.nsub; ii++) {
          const se = ind && ind[ii];
          if (!se) continue;
          const st = se[0], ln = se[1] - se[0];
          this.arrSet(dest, ii, new UserStr(s.substr(st, ln)));
          this.arrSet(dest, `${ii}${this.SUBSEP}start`, st + 1);
          this.arrSet(dest, `${ii}${this.SUBSEP}length`, ln);
        }
      }
    } else { rstart = 0; rlength = -1; }
    this.vars.get('RSTART').value = rstart;
    this.vars.get('RLENGTH').value = rlength;
    return rstart;
  }
  doAsort(e) {
    const name = e.name, args = e.args;
    const ctxt = name === 'asort' ? 'ASORT' : 'ASORTI';
    let sortStr = args.length === 3 ? this.str(this.evalScalar(args[2])) : '';
    if (sortStr.length === 0) sortStr = ctxt === 'ASORT' ? '@val_type_asc' : '@ind_str_asc';
    let dest = null;
    if (args.length >= 2) dest = this.targetArray(args[1], name, 'second');
    const array = this.targetArray(args[0], name, 'first');
    const list = assocList(array, sortStr, ctxt, this.sortRT());
    const n = array.size;
    if (n === 0 || !list.length) {
      if (dest && dest !== array) dest.clear();
      return 0;
    }
    const result = dest && dest !== array ? dest : new AwkArray(array.vname, array.parent);
    if (result === dest) dest.clear();
    list.forEach((ent, i) => {
      if (ctxt === 'ASORTI') this.arrSet(result, i + 1, ent.key instanceof UserStr ? new UserStr(ent.key.s) : ent.key);
      else {
        const v = ent.cell.v;
        if (v instanceof AwkArray) {
          const na = copyArray(v, String(i + 1), array);
          this.arrayLookup(result, i + 1).v = na;
        } else this.arrSet(result, i + 1, v instanceof UserStr ? copyUser(v) : v);
      }
    });
    if (result !== dest) { array.t = result.t; }
    return n;
  }
  doSub(e) {
    const name = e.name, args = e.args;
    const flagsGensub = name === 'gensub';
    let howMany = 1, global = false, rp, target, lref = null, literal = false;
    if (flagsGensub) {
      rp = this.regexOf(args[0]);
      const repl = this.str(this.evalScalar(args[1]));
      const glob = this.evalScalar(args[2]);
      target = this.str(this.evalScalar(args[3]));
      if (this.isString(glob) && !(glob instanceof NullField) && glob !== undefined && this.str(glob).length > 0 && /^[gG]/.test(this.str(glob))) howMany = -1;
      else {
        const d = this.num(glob);
        if (d < 1) howMany = 1;
        else if (d < 9223372036854775807) howMany = Math.trunc(d);
        else howMany = 9223372036854775807;
        if (d <= 0) this.warning(`gensub: third argument \`${this.str(glob)}' treated as 1`);
      }
      global = howMany === -1;
      const r = this.subCommon(rp, target, repl, howMany, global, true);
      return r.matches > 0 ? r.out : target;
    }
    rp = this.regexOf(args[0]);
    if (name === 'gsub') howMany = -1;
    let tnode = args[2];
    while (tnode.t === 'group') tnode = tnode.e;
    literal = e.literal || tnode.t === 'num' || tnode.t === 'str';
    // the replacement, then the target (an lvalue unless it is a constant)
    const repl = this.str(this.evalScalar(args[1]));
    if (literal) target = this.str(this.evalScalar(tnode));
    else { lref = this.lref(tnode); target = this.str(lref.get()); }
    global = howMany === -1;
    const r = this.subCommon(rp, target, repl, howMany, global, false);
    if (r.matches > 0 && !literal) lref.set(r.out);
    return r.matches;
  }
  // the heart of do_sub()
  subCommon(rp, target, repl, howMany, global, gensub) {
    let m = this.search(rp, target, 0);
    if (!m) return { matches: 0, out: target };
    let matches = 0;
    let out = '';
    let text = 0;
    const textEnd = target.length;
    let lastmatchnonzero = false;
    for (let current = 1; ; current++) {
      matches++;
      const matchstart = m.index;
      let matchend = m.index + m[0].length;
      out += target.slice(text, matchstart);
      let skipped = false;
      if (global || current === howMany) {
        if (matchstart === matchend && lastmatchnonzero && matchstart === text) {
          lastmatchnonzero = false;
          matches--;
          skipped = true;
        } else {
          out += this.replText(repl, target, matchstart, matchend, m, rp, gensub);
          if (matchstart !== matchend) lastmatchnonzero = true;
        }
      } else out += target.slice(matchstart, matchend);
      void skipped;
      // empty match: copy a character and move on
      if (matchstart === matchend && matchend < textEnd) { out += target[matchend]; matchend++; }
      text = matchend;
      const textlen = textEnd - text;
      if ((current >= howMany && !global) || (textlen <= 0 && matchstart === matchend)) break;
      m = this.search(rp, target, text);
      if (!m) break;
    }
    out += target.slice(text);
    return { matches, out };
  }
  replText(repl, target, ms, me, m, rp, gensub) {
    let out = '';
    const matched = target.slice(ms, me);
    for (let i = 0; i < repl.length; i++) {
      const c = repl[i];
      if (c === '&') { out += matched; continue; }
      if (c !== '\\') { out += c; continue; }
      if (gensub) {
        const d = repl[i + 1];
        if (d !== undefined && d >= '0' && d <= '9') {
          const dig = d.charCodeAt(0) - 48;
          const ind = m.indices;
          if (dig <= rp.nsub && ind && ind[dig]) out += target.slice(ind[dig][0], ind[dig][1]);
          i++;
        } else { if (d !== undefined) out += d; i++; }
        continue;
      }
      if (this.opts.posix) {
        if (repl[i + 1] === '&' || repl[i + 1] === '\\') i++;
        out += repl[i];
        continue;
      }
      if (repl.startsWith('\\\\\\&', i) || repl.startsWith('\\\\\\\\', i)) { out += '\\' + repl[i + 3]; i += 3; }
      else if (repl.startsWith('\\\\&', i)) { out += '\\' + matched; i += 2; }
      else if (repl[i + 1] === '&') { out += '&'; i++; }
      else out += '\\';
    }
    return out;
  }
}

// ---------------------------------------------------------------- helpers
const STD_BUILTINS = ['atan2', 'close', 'cos', 'exp', 'fflush', 'gsub', 'index', 'int', 'length', 'log', 'match', 'rand', 'sin', 'split',
  'sprintf', 'sqrt', 'srand', 'sub', 'substr', 'system', 'tolower', 'toupper'];
const PLAIN_BUILTINS = new Set(['substr', 'index', 'sprintf', 'sin', 'cos', 'atan2', 'exp', 'log', 'sqrt', 'int', 'rand', 'srand', 'tolower',
  'toupper', 'system', 'close', 'fflush', 'systime', 'strftime', 'mktime', 'and', 'or', 'xor', 'lshift', 'rshift', 'compl', 'strtonum',
  'dcgettext', 'dcngettext', 'bindtextdomain']);
const INDIRECT_BUILTINS = new Set(['and', 'asort', 'asorti', 'atan2', 'bindtextdomain', 'close', 'compl', 'cos', 'dcgettext', 'dcngettext',
  'exp', 'fflush', 'gensub', 'gsub', 'index', 'int', 'isarray', 'length', 'log', 'lshift', 'match', 'mktime', 'or', 'patsplit', 'rand',
  'rshift', 'sin', 'split', 'sprintf', 'sqrt', 'srand', 'strftime', 'strtonum', 'sub', 'substr', 'system', 'systime', 'tolower', 'toupper',
  'typeof', 'xor']);
const BUILTIN_NAMES = new Set(['BEGIN', 'BEGINFILE', 'END', 'ENDFILE', 'and', 'asort', 'asorti', 'atan2', 'bindtextdomain', 'break', 'case',
  'close', 'compl', 'continue', 'cos', 'dcgettext', 'dcngettext', 'default', 'delete', 'do', 'else', 'eval', 'exit', 'exp', 'fflush', 'for',
  'func', 'function', 'gensub', 'getline', 'gsub', 'if', 'in', 'include', 'index', 'int', 'intdiv0', 'isarray', 'length', 'load', 'log',
  'lshift', 'match', 'mktime', 'namespace', 'next', 'nextfile', 'or', 'patsplit', 'print', 'printf', 'rand', 'return', 'rshift', 'sin',
  'split', 'sprintf', 'sqrt', 'srand', 'strftime', 'strtonum', 'sub', 'substr', 'switch', 'system', 'systime', 'tolower', 'toupper',
  'typeof', 'while', 'xor']);
export { BUILTIN_NAMES };

// the body of `for (v in a)' is just `delete a[v]'
function isDeleteLoop(s) {
  let b = s.body;
  if (b && b.t === 'block' && b.body.length === 1) b = b.body[0];
  if (!b || b.t !== 'delete' || !b.dims || b.dims.length !== 1 || b.dims[0].length !== 1) return false;
  const sub = b.dims[0][0];
  if (sub.t !== 'var' || sub.name !== s.v || ['NR', 'FNR', 'NF'].includes(s.v)) return false;
  return s.arrNode && s.arrNode.t === 'var' && s.arrNode.name === b.name;
}
function isStdInt(s) {
  const n = s.length;
  if (n === 0) return false;
  if (s === '0') return true;
  let i = 0;
  if (s[0] === '-') { if (n === 1) return false; i = 1; }
  const c = s.charCodeAt(i);
  if (c < 49 || c > 57) return false;
  for (let k = i + 1; k < n; k++) { const d = s.charCodeAt(k); if (d < 48 || d > 57) return false; }
  if (n - i > 10) return false;
  const v = Number(s);
  return v >= -2147483648 && v <= 2147483647;
}
function copyUser(u) { const c = new UserStr(u.s); c.st = u.st; c.n = u.n; return c; }
function copyArray(a, vname, parent) {
  const na = new AwkArray(vname, parent);
  const list = a.listRaw(AK.AINDEX | AK.AVALUE, []);
  // keep the original element order by re-inserting in listing order
  for (const ent of list) {
    const key = ent.key;
    const sub = typeof key === 'number' ? { s: String(key), int: Number.isInteger(key) && Math.abs(key) <= 2147483647, k: key, kind: 'num', v: key }
      : { s: ent.ks, int: isStdInt(ent.ks), k: Number(ent.ks), kind: key instanceof UserStr ? 'strnum' : 'str', v: ent.ks };
    na.lookup(sub).v = ent.cell.v instanceof AwkArray ? copyArray(ent.cell.v, ent.ks, na) : ent.cell.v;
  }
  return na;
}
// calc_exp()
function calcExp(x1, x2) {
  if (Number.isInteger(x2) && Math.abs(x2) <= 9223372036854775807) {
    let lx = x2;
    if (lx === 0) return 1;
    const posint = (x, n) => {
      let mult = 1;
      while (n > 1) { if (n % 2 === 1) mult *= x; x *= x; n = Math.floor(n / 2); }
      return mult * x;
    };
    return lx > 0 ? posint(x1, lx) : 1 / posint(x1, -lx);
  }
  return Math.pow(x1, x2);
}
// sanitize_exit_status() of a shell exit code (128+n: killed by signal n)
function sanitizeStatus(st) {
  if (typeof st !== 'number') return 0;
  if (st > 128 && st < 160) return 256 + (st - 128);
  return st;
}
const cg = (x) => (Number.isFinite(x) ? cFloat(x, 'g', { prec: 6 }) : (Number.isNaN(x) ? (signbit(x) ? '-nan' : 'nan') : (x < 0 ? '-inf' : 'inf')));
// sscanf(s, "%ld %d %d %d %d %d %d")
function scanInts(s, max) {
  const out = [];
  let i = 0;
  while (out.length < max) {
    while (i < s.length && /[ \t\n\v\f\r]/.test(s[i])) i++;
    const m = /^[+-]?\d+/.exec(s.slice(i));
    if (!m) break;
    out.push(Number(m[0]));
    i += m[0].length;
  }
  return out;
}

// stdio-like output streams
class StdBuf {
  constructor(sink) { this.sink = sink; this.buf = ''; }
  write(s) {
    if (!s) return;
    this.buf += s;
    if (this.buf.length >= 4096) {
      const n = this.buf.length - (this.buf.length % 4096);
      const chunk = this.buf.slice(0, n);
      this.buf = this.buf.slice(n);
      this.sink.write(chunk);
    }
  }
  flush() { if (this.buf) { const b = this.buf; this.buf = ''; this.sink.write(b); } }
}
class Unbuf {
  constructor(sink) { this.sink = sink; }
  write(s) { if (s) this.sink.write(s); }
  flush() { }
}
class PipeBuf {
  constructor() { this.data = ''; }
  write(s) { this.data += s; }
  flush() { }
}
