// Helpers shared by command implementations.
import { FsError } from '../vfs.js';

export class UsageError extends Error {}

// GNU getopt_long emulation.
// spec.short: e.g. 'an:c::' (':' = required arg, '::' = optional attached arg)
// spec.long: { name: key | [key, 'none'|'required'|'optional'] }
// Returns { opts: [[key, value]], operands, error }
export function getopt(argv, spec, { permute = true, stopAtFirstOperand = false } = {}) {
  const shortSpec = {};
  const s = spec.short || '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ':') continue;
    let arg = 'none';
    if (s[i + 1] === ':') { arg = s[i + 2] === ':' ? 'optional' : 'required'; }
    shortSpec[c] = arg;
  }
  const longSpec = {};
  for (const [name, v] of Object.entries(spec.long || {})) {
    if (Array.isArray(v)) longSpec[name] = { key: v[0], arg: v[1] || 'none' };
    else longSpec[name] = { key: v, arg: 'none' };
  }
  const opts = [];
  const operands = [];
  let i = 0;
  const prog = spec.name || 'cmd';
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { operands.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') && spec.long) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      let match = longSpec[name] ? name : null;
      if (!match) {
        // glibc: the first abbreviation match wins unless a later one differs from it
        const cands = Object.keys(longSpec).filter(n => n.startsWith(name));
        const same = (c) => longSpec[c].key === longSpec[cands[0]].key && longSpec[c].arg === longSpec[cands[0]].arg;
        const amb = cands.filter((c, k) => k === 0 || !same(c));
        if (amb.length === 1) match = cands[0];
        else if (amb.length > 1) return { opts, operands, error: `${prog}: option '${a}' is ambiguous; possibilities:${amb.map(c => " '--" + c + "'").join('')}` };
        else return { opts, operands, error: `${prog}: unrecognized option '${a}'` };
      }
      const L = longSpec[match];
      if (L.arg === 'none') {
        if (eq >= 0) return { opts, operands, error: `${prog}: option '--${match}' doesn't allow an argument` };
        opts.push([L.key, true]);
      } else if (L.arg === 'required') {
        if (eq >= 0) opts.push([L.key, a.slice(eq + 1)]);
        else if (i + 1 < argv.length) { opts.push([L.key, argv[i + 1]]); i++; }
        else return { opts, operands, error: `${prog}: option '--${match}' requires an argument` };
      } else opts.push([L.key, eq >= 0 ? a.slice(eq + 1) : null]);
      i++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      let j = 1;
      while (j < a.length) {
        const c = a[j];
        const t = shortSpec[c];
        if (t === undefined) return { opts, operands, error: `${prog}: invalid option -- '${c}'`, badChar: c };
        if (t === 'none') { opts.push([c, true]); j++; continue; }
        if (t === 'optional') { opts.push([c, a.length > j + 1 ? a.slice(j + 1) : null]); break; }
        // required
        if (a.length > j + 1) { opts.push([c, a.slice(j + 1)]); break; }
        if (i + 1 < argv.length) { opts.push([c, argv[i + 1]]); i++; break; }
        return { opts, operands, error: `${prog}: option requires an argument -- '${c}'` };
      }
      i++;
      continue;
    }
    if (!permute || stopAtFirstOperand) { operands.push(...argv.slice(i)); break; }
    operands.push(a);
    i++;
  }
  return { opts, operands, error: null };
}

// Convenience: returns { o: Map key->last value, all: [[k,v]], operands } or prints error.
export function parseArgs(ctx, spec, argv = ctx.argv.slice(1), extra = {}) {
  const r = getopt(argv, { ...spec, name: ctx.name }, extra);
  if (r.error) {
    ctx.stderr.write(r.error + '\n');
    if (spec.usage !== false) ctx.stderr.write(spec.usageText || `Try '${ctx.name} --help' for more information.\n`);
    return null;
  }
  const o = new Map();
  for (const [k, v] of r.opts) o.set(k, v);
  return { o, all: r.opts, operands: r.operands, has: (k) => o.has(k), get: (k) => o.get(k) };
}

// coreutils quoteaf(): gnulib shell-escape-always quoting in the C locale.
export function qa(name) { return quotearg(name, 'shell-escape-always'); }

// coreutils quotef(): shell-escape quoting, only when needed (':' counts as needing it).
const COLON = new Set([':']);
export function qf(name) { return quotearg(name, 'shell-escape', { quoteTheseToo: COLON }); }

export function errMsg(e) {
  if (e instanceof FsError) return e.message;
  return String(e.message || e);
}

// Read each operand (default '-') and call fn(data, name). Returns exit status.
// Per-command wording when an input operand can't be read (undefined = generic "NAME: strerror").
const isDir = (e) => e.code === 'EISDIR';
const READ_ERRS = {
  head: (f, e) => (isDir(e) ? `error reading ${qa(f)}: ${e.message}` : `cannot open ${qa(f)} for reading: ${e.message}`),
  tail: (f, e) => (isDir(e) ? `error reading ${qa(f)}: ${e.message}` : `cannot open ${qa(f)} for reading: ${e.message}`),
  tac: (f, e) => (isDir(e) ? `${qf(f)}: read error: ${e.message}` : `failed to open ${qa(f)} for reading: ${e.message}`),
  rev: (f, e) => (isDir(e) ? `${f}: 0: ${e.message}` : `cannot open ${f}: ${e.message}`),
  fmt: (f, e) => (isDir(e) ? null : `cannot open ${qa(f)} for reading: ${e.message}`),
  column: (f, e) => (isDir(e) ? `read failed: ${e.message}` : undefined),
  base64: (f, e) => (isDir(e) ? `read error: ${e.message}` : undefined),
  base32: (f, e) => (isDir(e) ? `read error: ${e.message}` : undefined),
  shuf: (f, e) => (isDir(e) ? `read error: ${e.message}` : undefined),
  join: (f, e) => (isDir(e) ? `read error: ${e.message}` : undefined),
  od: (f, e) => (isDir(e) ? `${qf(f)}: read error: ${e.message}` : undefined),
  uniq: (f, e) => (isDir(e) ? `error reading ${qa(f)}` : undefined),
  split: (f, e) => (isDir(e) ? undefined : `cannot open ${qa(f)} for reading: ${e.message}`),
  tsort: (f, e) => (isDir(e) ? null : undefined),
  xxd: (f, e) => (isDir(e) ? null : undefined),
};
export function readErrMsg(ctx, f, e) {
  const fn = READ_ERRS[ctx.name];
  const m = fn ? fn(f, e) : undefined;
  return m === undefined ? `${qf(f)}: ${e.message}` : m;
}

// `cmd f >> f`: is this (non-empty) input file the very file stdout is appending to?
// Is the file being read also where stdout goes? coreutils only minds when there is data left
// to read (`anySize` drops that condition, as grep does). '-' looks at where stdin comes from.
export function inputIsOutput(ctx, path, { anySize = false } = {}) {
  const out = ctx.stdout && ctx.stdout.node;
  if (!out) return false;
  if (path === '-') { path = ctx.stdin && ctx.stdin.name; if (!path) return false; }
  try { const n = ctx.fs.stat(path, ctx.cwd); return n === out && n.type === 'f' && (anySize || n.data.length > 0); } catch { return false; }
}

// errFmt(name, err) -> message (without the "cmd: " prefix), or null to stay silent.
export function eachInput(ctx, files, fn, { quoteStyle = 'f', errFmt = null, sameOutputMsg = null } = {}) {
  const list = files.length ? files : ['-'];
  let st = 0;
  for (const f of list) {
    let data;
    if (sameOutputMsg && inputIsOutput(ctx, f)) { ctx.err(`${qf(f)}: ${sameOutputMsg}`); st = 1; continue; }
    try { data = ctx.readFile(f); }
    catch (e) {
      if (e instanceof FsError) {
        let msg = (errFmt || READ_ERRS[ctx.name] || (() => undefined))(f, e);
        if (msg === undefined) msg = `${quoteStyle === 'a' ? qa(f) : qf(f)}: ${e.message}`;
        if (msg !== null) ctx.err(msg);
        st = 1; continue;
      }
      throw e;
    }
    const r = fn(data, f);
    if (r) st = r;
  }
  return st;
}

export function splitLines(data, sep = '\n') {
  if (data === '') return [];
  const lines = data.split(sep);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Parse sizes like 10, 1K, 2M, 512b, 1KB, 1KiB
export function parseSize(s, { allowNeg = false } = {}) {
  const m = /^([+-]?)(\d+)([bkKmMgGtTpPeEzZyY]?)(i?[bB]?)$/.exec(s);
  if (!m) return null;
  let n = BigInt(m[2]);
  const suf = m[3], ib = m[4];
  if (suf === 'b') n *= 512n;
  else if (suf) {
    const pow = 'kmgtpezy'.indexOf(suf.toLowerCase()) + 1;
    const base = ib === 'B' || ib === 'b' ? (ib === 'iB' ? 1024n : 1000n) : 1024n;
    const b2 = ib === 'B' ? 1000n : ib === 'iB' ? 1024n : 1024n;
    n *= (ib === 'B' ? 1000n : b2) ** BigInt(pow);
    void base;
  }
  const v = Number(n);
  return m[1] === '-' ? (allowNeg ? -v : null) : v;
}

export function isBinary(data) { return data.includes('\0'); }

// gnulib file_name_concat(): DIR's trailing slashes are not doubled ("sub//" + "a" -> "sub/a").
export function fileNameConcat(dir, base) {
  let k = 0;
  while (dir[k] === '/') k++;                     // last_component skips leading slashes
  let lastStart = k;
  for (let j = k; j < dir.length; j++) if (dir[j] === '/' && dir[j + 1] && dir[j + 1] !== '/') lastStart = j + 1;
  let baseLen = dir.length - lastStart;
  while (baseLen > 1 && dir[lastStart + baseLen - 1] === '/') baseLen--;
  if (lastStart === dir.length) baseLen = 0;
  const dirLen = lastStart + baseLen;
  let sep = '';
  if (baseLen) { if (dir[dirLen - 1] !== '/' && base[0] !== '/') sep = '/'; }
  else if (base[0] === '/') sep = '.';
  return dir.slice(0, dirLen) + sep + base;
}
export function stripTrailingSlashes(p) { return p.length > 1 ? p.replace(/(.)\/+$/, '$1') : p; }
// last_component(): the final name of a path, keeping any trailing slashes
export function lastComponent(p) {
  let k = 0;
  while (p[k] === '/') k++;
  let start = k;
  for (let j = k; j < p.length; j++) if (p[j] === '/' && p[j + 1] && p[j + 1] !== '/') start = j + 1;
  return p.slice(start);
}

// gnulib filevercmp (coreutils 8.32) — used by ls -v and sort -V
function matchSuffix(s, start) {
  let match = -1, readAlpha = false;
  let i = start;
  for (; i < s.length; i++) {
    const c = s[i];
    if (readAlpha) { readAlpha = false; if (!/[A-Za-z~]/.test(c)) match = -1; }
    else if (c === '.') { readAlpha = true; if (match < 0) match = i; }
    else if (!/[A-Za-z0-9~]/.test(c)) match = -1;
  }
  return { match, end: i };
}
function vorder(c) {
  if (c >= '0' && c <= '9') return 0;
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
  if (c === '~') return -1;
  return c.charCodeAt(0) + 256;
}
function verrevcmp(s1, l1, s2, l2) {
  let p1 = 0, p2 = 0;
  const dig = (s, p) => p < s.length && s[p] >= '0' && s[p] <= '9';
  while (p1 < l1 || p2 < l2) {
    let firstDiff = 0;
    while ((p1 < l1 && !dig(s1, p1)) || (p2 < l2 && !dig(s2, p2))) {
      const c1 = p1 === l1 ? 0 : vorder(s1[p1]);
      const c2 = p2 === l2 ? 0 : vorder(s2[p2]);
      if (c1 !== c2) return c1 - c2;
      p1++; p2++;
    }
    while (s1[p1] === '0') p1++;
    while (s2[p2] === '0') p2++;
    while (dig(s1, p1) && dig(s2, p2)) {
      if (!firstDiff) firstDiff = s1.charCodeAt(p1) - s2.charCodeAt(p2);
      p1++; p2++;
    }
    if (dig(s1, p1)) return 1;
    if (dig(s2, p2)) return -1;
    if (firstDiff) return firstDiff;
  }
  return 0;
}
export function filevercmp(a, b) {
  const simple = a < b ? -1 : a > b ? 1 : 0;
  if (simple === 0) return 0;
  if (!a) return -1; if (!b) return 1;
  if (a === '.') return -1; if (b === '.') return 1;
  if (a === '..') return -1; if (b === '..') return 1;
  if (a[0] === '.' && b[0] !== '.') return -1;
  if (a[0] !== '.' && b[0] === '.') return 1;
  let o1 = 0, o2 = 0;
  if (a[0] === '.' && b[0] === '.') { o1 = 1; o2 = 1; }
  const s1 = a.slice(o1), s2 = b.slice(o2);
  const m1 = matchSuffix(s1, 0), m2 = matchSuffix(s2, 0);
  let l1 = m1.match >= 0 ? m1.match : m1.end;
  let l2 = m2.match >= 0 ? m2.match : m2.end;
  if ((m1.match >= 0 || m2.match >= 0) && l1 === l2 && s1.slice(0, l1) === s2.slice(0, l2)) { l1 = m1.end; l2 = m2.end; }
  const r = verrevcmp(s1, l1, s2, l2);
  return r === 0 ? simple : r;
}

// gnulib xstrtol/xstrtoimax/xstrtoumax: a number with an optional size suffix. Returns
// { err, val (BigInt), rest } where err is 0 (OK) or the LONGINT_* bits: 1 overflow,
// 2 invalid suffix char, 4 invalid. `max` is the type's maximum; `unsigned` rejects '-'.
export const LONGINT_OK = 0, LONGINT_OVERFLOW = 1, LONGINT_INVALID_SUFFIX_CHAR = 2, LONGINT_INVALID = 4;
export function xstrtol(s, validSuffixes, { base = 10, max = (1n << 63n) - 1n, unsigned = false } = {}) {
  let i = 0;
  while (i < s.length && /[ \t\n\v\f\r]/.test(s[i])) i++;
  if (unsigned && s[i] === '-') return { err: LONGINT_INVALID, val: 0n, rest: s };
  // strtol
  let j = i, neg = false;
  if (s[j] === '+' || s[j] === '-') { neg = s[j] === '-'; j++; }
  let b = base;
  if ((b === 0 || b === 16) && s[j] === '0' && (s[j + 1] === 'x' || s[j + 1] === 'X') && /[0-9a-fA-F]/.test(s[j + 2] || '')) { j += 2; b = 16; }
  else if (b === 0) b = s[j] === '0' ? 8 : 10;
  const digit = (c) => { const d = parseInt(c, 36); return Number.isNaN(d) || d >= b ? -1 : d; };
  const start = j;
  let v = 0n;
  while (j < s.length && digit(s[j]) >= 0) { v = v * BigInt(b) + BigInt(digit(s[j])); j++; }
  let err = LONGINT_OK;
  let p;
  if (j === start) {
    p = i;
    if (validSuffixes && s[p] !== undefined && validSuffixes.includes(s[p])) v = 1n;
    else return { err: LONGINT_INVALID, val: 0n, rest: s.slice(i) };
  } else {
    p = j;
    if (neg) v = unsigned ? ((max + 1n) - v) % (max + 1n) : -v;
    if (v > max) { v = max; err = LONGINT_OVERFLOW; }
    if (!unsigned && v < -max - 1n) { v = -max - 1n; err = LONGINT_OVERFLOW; }
  }
  if (validSuffixes === null || validSuffixes === undefined) return { err, val: v, rest: s.slice(p) };
  if (p < s.length) {
    let mult = 1024n, suffixes = 1;
    const c = s[p];
    if (!validSuffixes.includes(c)) return { err: err | LONGINT_INVALID_SUFFIX_CHAR, val: v, rest: s.slice(p) };
    if ('EGgkKMmPTtYZ'.includes(c) && validSuffixes.includes('0')) {
      if (s[p + 1] === 'i') { if (s[p + 2] === 'B') suffixes += 2; }
      else if (s[p + 1] === 'B' || s[p + 1] === 'D') { mult = 1000n; suffixes++; }
    }
    const pow = { E: 6, G: 3, g: 3, k: 1, K: 1, M: 2, m: 2, P: 5, T: 4, t: 4, Y: 8, Z: 7 }[c];
    let scale;
    if (c === 'b') scale = 512n;
    else if (c === 'B') scale = 1024n;
    else if (c === 'c') scale = 1n;
    else if (c === 'w') scale = 2n;
    else if (pow !== undefined) scale = mult ** BigInt(pow);
    else return { err: err | LONGINT_INVALID_SUFFIX_CHAR, val: v, rest: s.slice(p) };
    v *= scale;
    if (v > max) { v = max; err |= LONGINT_OVERFLOW; }
    if (v < -max - 1n) { v = -max - 1n; err |= LONGINT_OVERFLOW; }
    p += suffixes;
    if (p < s.length) err |= LONGINT_INVALID_SUFFIX_CHAR;
  }
  return { err, val: v, rest: s.slice(p) };
}

// stdout as stdio buffers it into a pipe: written out in 4096-byte blocks and at exit. Tools
// that report errors with fprintf(stderr) (not error(), which flushes stdout first) show
// their diagnostics ahead of earlier output this way.
export class StdioBuffer {
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

export const UINTMAX_MAX = (1n << 64n) - 1n;
const STRERROR = { EOVERFLOW: 'Value too large for defined data type', ERANGE: 'Numerical result out of range' };
// gnulib xnumtoumax/xdectoumax: on failure returns { ok: false, msg } with the
// "ERR: 'N'[: strerror]" text, else { ok: true, val (BigInt) }.
export function xdectoumax(s, { min = 0n, max = UINTMAX_MAX, suffixes = '', err = 'invalid number', base = 10 } = {}) {
  const r = xstrtol(s, suffixes, { base, max: UINTMAX_MAX, unsigned: true });
  let e = r.err, errno = null;
  if (e === LONGINT_OK) {
    if (r.val < min || r.val > max) { e = LONGINT_OVERFLOW; errno = r.val > 1073741823n ? 'EOVERFLOW' : 'ERANGE'; }
  } else if (e === LONGINT_OVERFLOW) errno = 'EOVERFLOW';
  if (e !== LONGINT_OK) return { ok: false, msg: `${err}: ${qa(s)}${errno ? ': ' + STRERROR[errno] : ''}` };
  return { ok: true, val: r.val };
}

// gnulib quotearg_buffer_restyled (C locale). style: literal shell shell-always shell-escape
// shell-escape-always c c-maybe escape locale clocale. quoteTheseToo: chars to backslash-escape.
export const QUOTING_STYLES = ['literal', 'shell', 'shell-always', 'shell-escape', 'shell-escape-always', 'c', 'c-maybe', 'escape', 'locale', 'clocale'];
export function quotearg(arg, style, { quoteTheseToo = null, elideOuter = false, elideNull = false } = {}) {
  const FORCE = {};
  // `carry` is gnulib's `goto process_input` second pass after a single quote: it starts over
  // but never resets pending_shell_escape_end, so a name ending in an escape gains a leading ''
  const run = (style, qtt, elide, carry = null) => {
    let out = '';
    let qs = style, quoteString = '', backslashEscapes = false;
    let pending = carry ? carry.pending : false, encounteredSingleQuote = !!carry, allCompat = !carry;
    switch (qs) {
      case 'c-maybe': qs = 'c'; elide = true;
        // fallthrough
      case 'c':
        if (!elide) out += '"';
        backslashEscapes = true; quoteString = '"';
        break;
      case 'escape': backslashEscapes = true; elide = false; break;
      case 'locale': case 'clocale': {
        const q = qs === 'clocale' ? '"' : "'";
        if (!elide) out += q;
        backslashEscapes = true; quoteString = q;
        break;
      }
      case 'shell-escape': backslashEscapes = true;
        // fallthrough
      case 'shell': elide = true;
        // fallthrough
      case 'shell-escape-always': if (!elide) backslashEscapes = true;
        // fallthrough
      case 'shell-always':
        qs = 'shell-always';
        if (!elide) out += "'";
        quoteString = "'";
        break;
      case 'literal': elide = false; break;
      default: break;
    }
    const startEsc = (st) => {
      if (elide) return false;
      st.escaping = true;
      if (qs === 'shell-always' && !pending) { out += "'$'"; pending = true; }
      out += '\\';
      return true;
    };
    for (let i = 0; i < arg.length; i++) {
      let c = arg[i];
      const code = c.charCodeAt(0);
      const st = { escaping: false };
      let isRightQuote = false, compat = false;
      let action = 'default';
      if (backslashEscapes && qs !== 'shell-always' && quoteString && arg.startsWith(quoteString, i)) {
        if (elide) return [FORCE, qs, backslashEscapes];
        isRightQuote = true;
      }
      switch (c) {
        case '\0':
          if (backslashEscapes) {
            if (!startEsc(st)) return [FORCE, qs, backslashEscapes];
            if (qs !== 'shell-always' && i + 1 < arg.length && arg[i + 1] >= '0' && arg[i + 1] <= '9') out += '00';
            c = '0';
          } else if (elideNull) continue;
          break;
        case '?':
          if (qs === 'shell-always' && elide) return [FORCE, qs, backslashEscapes];
          break;
        case '\x07': case '\b': case '\f': case '\v': case '\n': case '\r': case '\t': case '\\': {
          const esc = { '\x07': 'a', '\b': 'b', '\f': 'f', '\v': 'v', '\n': 'n', '\r': 'r', '\t': 't', '\\': '\\' }[c];
          if (c === '\\') {
            if (qs === 'shell-always') { if (elide) return [FORCE, qs, backslashEscapes]; action = 'store_c'; break; }
            if (backslashEscapes && elide && quoteString) { action = 'store_c'; break; }
          }
          if ((c === '\n' || c === '\r' || c === '\t' || c === '\\') && qs === 'shell-always' && elide) return [FORCE, qs, backslashEscapes];
          if (backslashEscapes) { c = esc; action = 'store_escape'; }
          break;
        }
        case '{': case '}': case '#': case '~': case ' ':
        case '!': case '"': case '$': case '&': case '(': case ')': case '*': case ';':
        case '<': case '=': case '>': case '[': case '^': case '`': case '|': {
          if ((c === '{' || c === '}') && arg.length !== 1) break;
          if ((c === '{' || c === '}' || c === '#' || c === '~') && i !== 0) break;
          if (c === '{' || c === '}' || c === '#' || c === '~' || c === ' ') compat = true;
          if (qs === 'shell-always' && elide) return [FORCE, qs, backslashEscapes];
          break;
        }
        case "'":
          encounteredSingleQuote = true;
          compat = true;
          if (qs === 'shell-always') {
            if (elide) return [FORCE, qs, backslashEscapes];
            out += "'\\'";
            pending = false;
          }
          break;
        default:
          if (/[%+,\-./0-9:A-Z\]_a-z]/.test(c)) { compat = true; break; }
          {
            const printable = code >= 32 && code < 127;
            compat = printable;
            if (backslashEscapes && !printable) {
              if (!startEsc(st)) return [FORCE, qs, backslashEscapes];
              out += String.fromCharCode(48 + (code >> 6)) + String.fromCharCode(48 + ((code >> 3) & 7));
              c = String.fromCharCode(48 + (code & 7));
              action = 'store_c';
            } else if (isRightQuote) {
              out += '\\';
              isRightQuote = false;
            }
          }
      }
      if (action === 'default') {
        if (!(((backslashEscapes && qs !== 'shell-always') || elide) && qtt && qtt.has(c)) && !isRightQuote) action = 'store_c';
        else action = 'store_escape';
      }
      if (action === 'store_escape' && !startEsc(st)) return [FORCE, qs, backslashEscapes];
      if (pending && !st.escaping) { out += "''"; pending = false; }
      out += c;
      if (!compat) allCompat = false;
    }
    if (out.length === 0 && qs === 'shell-always' && elide) return [FORCE, qs, backslashEscapes];
    if (qs === 'shell-always' && !elide && encounteredSingleQuote) {
      if (allCompat) return run('c', qtt, false);
      if (!carry) return run(style, qtt, elide, { pending });
    }
    if (quoteString && !elide) out += quoteString;
    return out;
  };
  let r = run(style, quoteTheseToo, elideOuter);
  if (Array.isArray(r) && r[0] === FORCE) {
    let s2 = r[1];
    if (s2 === 'shell-always' && r[2]) s2 = 'shell-escape-always';
    r = run(s2, null, false);
    if (Array.isArray(r)) r = arg;
  }
  return r;
}

// gnulib argmatch: the index of ARG in NAMES (an exact match or an unambiguous abbreviation;
// abbreviations of several names with the same value count as one), -1 invalid, -2 ambiguous.
export function argmatch(arg, names, values = names) {
  let found = -1, ambiguous = false;
  for (let i = 0; i < names.length; i++) {
    if (names[i] === arg) return i;
    if (names[i].startsWith(arg)) {
      if (found < 0) found = i;
      else if (values[found] !== values[i]) ambiguous = true;
    }
  }
  return ambiguous ? -2 : found;
}
// argmatch_invalid + argmatch_valid, as written to stderr (without the usage hint)
export function argmatchMessage(prog, what, arg, res, names, values = names) {
  let s = `${prog}: ${res === -2 ? 'ambiguous' : 'invalid'} argument ${qa(arg)} for ${qa(what)}\nValid arguments are:`;
  for (let i = 0; i < names.length; i++) {
    if (i === 0 || values[i] !== values[i - 1]) s += `\n  - ${qa(names[i])}`;
    else s += `, ${qa(names[i])}`;
  }
  return s + '\n';
}

// gnulib yesno(): a line from stdin starting with y or Y (C locale rpmatch)
export function yesno(ctx) {
  const r = ctx.stdin.readUntil('\n');
  return !!r && /^[yY]/.test(r.text);
}

// gnulib backupfile: --backup types and the backup name for FILE
export const BACKUP_ARGS = [['none', 'off', 'simple', 'never', 'existing', 'nil', 'numbered', 't'], ['none', 'none', 'simple', 'simple', 'existing', 'existing', 'numbered', 'numbered']];
export function simpleBackupSuffix(ctx, s) {
  if (s === null || s === undefined) s = (ctx.env || {}).SIMPLE_BACKUP_SUFFIX;
  return s && !s.includes('/') ? s : '~';
}
// Returns the name FILE gets backed up as (null for none).
export function backupName(ctx, file, type, suffix) {
  if (type === 'none') return null;
  if (type === 'simple') return file + suffix;
  const slash = file.lastIndexOf('/');
  const dir = slash < 0 ? '.' : file.slice(0, slash) || '/';
  const base = file.slice(slash + 1);
  let max = 0, any = false;
  try {
    const d = ctx.fs.stat(dir, ctx.cwd);
    for (const n of d.entries.keys()) {
      if (!n.startsWith(base + '.~') || !n.endsWith('~')) continue;
      const num = n.slice(base.length + 2, -1);
      if (!/^[1-9][0-9]*$/.test(num)) continue;
      any = true;
      max = Math.max(max, Number(num));
    }
  } catch { /* no directory */ }
  if (type === 'existing' && !any) return file + suffix;
  return `${file}.~${max + 1}~`;
}
