// jq 1.6 value layer, ported from jv.c, jv_aux.c, jv_print.c, jv_parse.c, jv_unicode.c and
// jvp_dtoa_fmt (as shipped in Ubuntu 22.04's jq 1.6-2.1ubuntu3.2, CVE patches included).
//
// Representation: null, booleans, numbers and strings are JS primitives (strings are UTF-16 JS
// strings holding the decoded UTF-8 text), arrays are JS arrays and objects are Maps (jq keeps
// object keys in insertion order, a deleted key re-added goes last, exactly like a Map). Values
// are never mutated once shared, so jq's copy-on-write is plain copying here. Invalid values
// (jq's error carrier) are JvInvalid instances. I/O happens on byte strings (one char per byte).

export const K_INVALID = 0, K_NULL = 1, K_FALSE = 2, K_TRUE = 3, K_NUMBER = 4, K_STRING = 5, K_ARRAY = 6, K_OBJECT = 7;
const KIND_NAMES = ['<invalid>', 'null', 'boolean', 'boolean', 'number', 'string', 'array', 'object'];

export class JvInvalid {
  constructor(msg) { this.msg = msg; }
}
export const INVALID = new JvInvalid(undefined);
// jv_invalid_with_msg: a null message makes a plain invalid
export const invalidMsg = (m) => (m === null || m === undefined ? INVALID : new JvInvalid(m));
export const isValid = (v) => !(v instanceof JvInvalid);
export const hasMsg = (v) => v instanceof JvInvalid && v.msg !== undefined;
export const getMsg = (v) => (v.msg === undefined ? null : v.msg);

export function kind(v) {
  if (v === null) return K_NULL;
  switch (typeof v) {
    case 'boolean': return v ? K_TRUE : K_FALSE;
    case 'number': return K_NUMBER;
    case 'string': return K_STRING;
  }
  if (Array.isArray(v)) return K_ARRAY;
  if (v instanceof Map) return K_OBJECT;
  return K_INVALID;
}
export const kindName = (k) => KIND_NAMES[k];
export const typeName = (v) => KIND_NAMES[kind(v)];

// ---------------------------------------------------------------- UTF-8 (jv_unicode.c)

const CONT = 255;
const CODING_LENGTH = new Uint8Array(256);
const CODING_BITS = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  if (i < 0x80) { CODING_LENGTH[i] = 1; CODING_BITS[i] = 0x7f; }
  else if (i < 0xc0) { CODING_LENGTH[i] = CONT; CODING_BITS[i] = 0x3f; }
  else if (i < 0xc2) { CODING_LENGTH[i] = 0; CODING_BITS[i] = 0; }
  else if (i < 0xe0) { CODING_LENGTH[i] = 2; CODING_BITS[i] = 0x1f; }
  else if (i < 0xf0) { CODING_LENGTH[i] = 3; CODING_BITS[i] = 0x0f; }
  else if (i < 0xf5) { CODING_LENGTH[i] = 4; CODING_BITS[i] = 0x07; }
  else { CODING_LENGTH[i] = 0; CODING_BITS[i] = 0; }
}
const FIRST_CODEPOINT = [0, 0, 0x80, 0x800, 0x10000];

// jvp_utf8_next over a byte string: returns the next index and stores the code point (-1 when
// the sequence is bad) in UTF8.cp
export const UTF8 = { cp: 0 };
export function utf8Next(b, i, end) {
  const first = b.charCodeAt(i);
  let length = CODING_LENGTH[first];
  let cp = -1;
  if ((first & 0x80) === 0) { cp = first; length = 1; }
  else if (length === 0 || length === CONT) length = 1;
  else if (i + length > end) length = end - i;
  else {
    cp = first & CODING_BITS[first];
    for (let k = 1; k < length; k++) {
      const ch = b.charCodeAt(i + k);
      if (CODING_LENGTH[ch] !== CONT) { cp = -1; length = k; break; }
      cp = (cp << 6) | (ch & 0x3f);
    }
    if (cp < FIRST_CODEPOINT[length]) cp = -1;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = -1;
    if (cp > 0x10ffff) cp = -1;
  }
  UTF8.cp = cp;
  return i + length;
}

// jv_string_sized: bytes -> string, bad sequences become U+FFFD
export function decodeUtf8(b, start = 0, end = b.length) {
  let out = '';
  let i = start;
  let run = start;
  while (i < end) {
    const c = b.charCodeAt(i);
    if (c < 0x80) { i++; continue; }
    if (run < i) out += b.slice(run, i);
    const n = utf8Next(b, i, end);
    const cp = UTF8.cp;
    out += cp < 0 ? '�' : String.fromCodePoint(cp);
    i = n;
    run = i;
  }
  if (run === start && end === b.length) return start === 0 ? b : b.slice(start);
  if (run < end) out += b.slice(run, end);
  return out;
}

// string -> UTF-8 bytes (jvp_utf8_encode; a lone surrogate, which only implode can make, is
// encoded as its 3-byte form like jq does)
export function encodeUtf8(s) {
  let ascii = true;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x80) { ascii = false; break; }
  if (ascii) return s;
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  let r = '';
  for (let i = 0; i < out.length; i += 8192) r += String.fromCharCode.apply(null, out.slice(i, i + 8192));
  return r;
}

export function byteLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n++;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// jv_string_length_codepoints
export function cpLength(s) {
  let n = s.length;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n--; i++; }
  }
  return n;
}

export function codepoints(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if ((d & 0xfc00) === 0xdc00) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    out.push(c);
  }
  return out;
}

// jv_string_explode: a lone surrogate (an invalid 3-byte sequence for jq) decodes to -1
export function explode(s) {
  const out = codepoints(s);
  for (let i = 0; i < out.length; i++) if (out[i] >= 0xd800 && out[i] <= 0xdfff) out[i] = -1;
  return out;
}

// memcmp order of the UTF-8 encodings (= code point order)
export function cmpStr(a, b) {
  if (a === b) return 0;
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x !== y) {
      if (x >= 0xd800 && y >= 0xd800) {
        // surrogates (supplementary planes) sort above U+E000..U+FFFF in UTF-8
        x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
        y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
      }
      return x - y;
    }
  }
  return a.length - b.length;
}

// ---------------------------------------------------------------- numbers

const INT_MAX = 2147483647, INT_MIN = -2147483648;
// C (int)double on aarch64: truncation, saturating, NaN -> 0
export function toInt(d) {
  if (d !== d) return 0;
  if (d >= INT_MAX) return INT_MAX;
  if (d <= INT_MIN) return INT_MIN;
  return Math.trunc(d);
}
// (intmax_t)double on aarch64
export function toIntmax(d) {
  if (d !== d) return 0n;
  if (d >= 9223372036854775807) return 9223372036854775807n;
  if (d <= -9223372036854775808) return -9223372036854775808n;
  return BigInt(Math.trunc(d));
}
export function isInteger(v) {
  if (typeof v !== 'number') return false;
  if (v !== v || v > INT_MAX || v < INT_MIN) return false;
  return v === Math.trunc(v);
}

// jvp_dtoa_fmt: shortest round-trip digits, %.17g-like layout
export function dtoaFmt(x) {
  if (x !== x) return 'NaN';
  let sign = '';
  if (x < 0 || (x === 0 && 1 / x < 0)) { sign = '-'; x = -x; }
  if (x === Infinity) return sign + 'Infinity';
  if (x === 0) return sign + '0';
  const e = x.toExponential();
  const p = e.indexOf('e');
  const digits = e[0] + (p > 1 ? e.slice(2, p) : '');
  const decpt = +e.slice(p + 1) + 1;
  const nd = digits.length;
  if (decpt <= -4 || decpt > nd + 15) {
    let s = digits[0];
    if (nd > 1) s += '.' + digits.slice(1);
    let ex = decpt - 1;
    s += ex < 0 ? 'e-' : 'e+';
    if (ex < 0) ex = -ex;
    s += ex < 10 ? '0' + ex : String(ex);
    return sign + s;
  }
  if (decpt <= 0) return sign + '0.' + '0'.repeat(-decpt) + digits;
  if (decpt >= nd) return sign + digits + '0'.repeat(decpt - nd);
  return sign + digits.slice(0, decpt) + '.' + digits.slice(decpt);
}

// jvp_strtod on a byte string: { v, end } where end is the index where conversion stopped
// (end === start when nothing was converted). Hex floats are disabled in jq's build.
export function strtod(s, start = 0) {
  let i = start;
  const n = s.length;
  let neg = false;
  for (;; i++) {
    const c = s[i];
    if (c === '-' || c === '+') {
      if (c === '-') neg = true;
      i++;
      if (i < n && s[i] !== '\0') break;
      return { v: 0, end: start };
    }
    if (c === undefined || c === '\0') return { v: 0, end: start };
    if (c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r' || c === ' ') continue;
    break;
  }
  const numStart = i;
  let nd = 0, nz0 = false, nzf = 0, dplen = 0;
  if (s[i] === '0') { nz0 = true; while (s[++i] === '0'); }
  while (i < n && s[i] >= '0' && s[i] <= '9') { i++; nd++; }
  if (s[i] === '.') {
    i++;
    dplen = 1;
    while (i < n && s[i] >= '0' && s[i] <= '9') { if (s[i] !== '0' || nd) nd++; else nzf++; i++; }
  }
  let mantEnd = i;
  if ((s[i] === 'e' || s[i] === 'E') && (nd || nzf || nz0)) {
    let j = i + 1;
    if (s[j] === '-' || s[j] === '+') j++;
    if (j < n && s[j] >= '0' && s[j] <= '9') {
      while (j < n && s[j] >= '0' && s[j] <= '9') j++;
      i = j;
    }
  }
  if (!nd && !nzf && !nz0) {
    // no digits: Infinity / NaN (case-insensitive), only without a decimal point
    if (!dplen) {
      const rest = s.slice(numStart, numStart + 8).toLowerCase();
      if (rest.startsWith('inf')) {
        const end = rest.startsWith('infinity') ? numStart + 8 : numStart + 3;
        return { v: neg ? -Infinity : Infinity, end };
      }
      if (rest.startsWith('nan')) {
        let end = numStart + 3;
        if (s[end] === '(') {
          // hexnan: nan(hexdigits) is consumed only when well formed
          let j = end + 1;
          while (j < n && /[0-9a-fA-F]/.test(s[j])) j++;
          if (s[j] === ')') end = j + 1;
        }
        return { v: NaN, end };
      }
    }
    return { v: 0, end: start };
  }
  const text = s.slice(numStart, i);
  let v = Number(text.endsWith('.') ? text.slice(0, -1) : text);
  if (text[0] === '.' || mantEnd === numStart) v = Number('0' + text);
  if (neg) v = -v;
  return { v, end: i };
}

// ---------------------------------------------------------------- comparison (jv.c, jv_aux.c)

export function jvEqual(a, b) {
  const ka = kind(a);
  if (ka !== kind(b)) return false;
  switch (ka) {
    case K_NUMBER: return a === b;
    case K_STRING: return a === b;
    case K_ARRAY: {
      if (a === b) return true;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!jvEqual(a[i], b[i])) return false;
      return true;
    }
    case K_OBJECT: {
      if (a === b) return true;
      if (a.size !== b.size) return false;
      for (const [k, v] of a) {
        if (!b.has(k)) return false;
        if (!jvEqual(v, b.get(k))) return false;
      }
      return true;
    }
    default: return true;
  }
}

export function jvIdentical(a, b) {
  return Object.is(a, b);
}

export function sortedKeys(o) {
  return [...o.keys()].sort(cmpStr);
}

export function jvCmp(a, b) {
  const ka = kind(a), kb = kind(b);
  if (ka !== kb) return ka - kb;
  switch (ka) {
    case K_NUMBER: {
      if (a !== a) return jvCmp(null, b);
      if (b !== b) return jvCmp(a, null);
      return a < b ? -1 : a === b ? 0 : 1;
    }
    case K_STRING: return cmpStr(a, b);
    case K_ARRAY: {
      for (let i = 0; ; i++) {
        const ad = i >= a.length, bd = i >= b.length;
        if (ad || bd) return (bd ? 1 : 0) - (ad ? 1 : 0);
        const r = jvCmp(a[i], b[i]);
        if (r) return r;
      }
    }
    case K_OBJECT: {
      const ka2 = sortedKeys(a), kb2 = sortedKeys(b);
      let r = jvCmp(ka2, kb2);
      if (r === 0) {
        for (const k of ka2) {
          r = jvCmp(a.get(k), b.get(k));
          if (r) break;
        }
      }
      return r;
    }
    default: return 0;
  }
}

export function jvContains(a, b) {
  const ka = kind(a);
  if (ka !== kind(b)) return false;
  if (ka === K_OBJECT) {
    for (const [k, bv] of b) {
      if (!a.has(k)) return false;
      if (!jvContains(a.get(k), bv)) return false;
    }
    return true;
  }
  if (ka === K_ARRAY) {
    for (const be of b) {
      let found = false;
      for (const ae of a) if (jvContains(ae, be)) { found = true; break; }
      if (!found) return false;
    }
    return true;
  }
  if (ka === K_STRING) {
    // strstr: stops at NUL bytes
    const z1 = a.indexOf('\0'), z2 = b.indexOf('\0');
    return (z1 < 0 ? a : a.slice(0, z1)).includes(z2 < 0 ? b : b.slice(0, z2));
  }
  return jvEqual(a, b);
}

// ---------------------------------------------------------------- arrays, objects, strings

function clampSlice(len, start, end) {
  if (start < 0) start = len + start;
  if (end < 0) end = len + end;
  if (start < 0) start = 0;
  if (start > len) start = len;
  if (end > len) end = len;
  if (end < start) end = start;
  return [start, end];
}

export function arraySet(a, idx, v) {
  if (idx < 0) idx = a.length + idx;
  if (idx < 0) return invalidMsg('Out of bounds negative array index');
  if (idx > (INT_MAX >> 2)) return invalidMsg('Array index too large');
  const r = a.slice();
  for (let j = r.length; j < idx; j++) r[j] = null;
  r[idx] = v;
  return r;
}

export function objectSet(o, k, v) {
  const m = new Map(o);
  m.set(k, v);
  return m;
}

export function objectDelete(o, k) {
  if (!o.has(k)) return o;
  const m = new Map(o);
  m.delete(k);
  return m;
}

export function objectMerge(a, b) {
  const m = new Map(a);
  for (const [k, v] of b) m.set(k, v);
  return m;
}

export function objectMergeRecursive(a, b) {
  const m = new Map(a);
  for (const [k, v] of b) {
    const e = m.get(k);
    if (e instanceof Map && v instanceof Map) m.set(k, objectMergeRecursive(e, v));
    else m.set(k, v);
  }
  return m;
}

// jv_string_slice by code points
export function stringSlice(s, start, end) {
  const len = byteLength(s);
  [start, end] = clampSlice(len, start, end);
  // walk code points; byte length bounds the count like the C loop does
  let i = 0, k = 0;
  for (; k < start; k++) {
    if (i >= s.length) return '';
    i += (s.charCodeAt(i) & 0xfc00) === 0xd800 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
  }
  let e = i;
  for (; e < s.length && k < end; k++) {
    e += (s.charCodeAt(e) & 0xfc00) === 0xd800 && (s.charCodeAt(e + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
  }
  return s.slice(i, e);
}

// jv_string_indexes: byte offsets of every (non-overlapping) occurrence
export function stringIndexes(j, k) {
  const a = [];
  const jb = encodeUtf8(j), kb = encodeUtf8(k);
  if (kb.length === 0) {
    // memmem with an empty needle matches at every position, stepping by 0 -> jq loops forever;
    // glibc memmem returns the haystack start, p += 0 never advances
    return null;
  }
  let p = 0;
  for (;;) {
    const q = jb.indexOf(kb, p);
    if (q < 0) break;
    a.push(q);
    p = q + kb.length;
  }
  return a;
}

export function stringSplit(j, sep) {
  const a = [];
  if (sep.length === 0) {
    for (const c of codepoints(j)) a.push(String.fromCodePoint(c));
    return a;
  }
  // byte-wise memmem on the UTF-8 encodings
  const jb = encodeUtf8(j), sb = encodeUtf8(sep);
  for (let p = 0; p < jb.length;) {
    let s = jb.indexOf(sb, p);
    if (s < 0) s = jb.length;
    a.push(decodeUtf8(jb, p, s));
    if (s + sb.length === jb.length) a.push('');
    p = s + sb.length;
  }
  return a;
}

export function stringImplode(arr) {
  // jv_string_implode: codepoints above U+10FFFF become U+FFFD, negative ones abort
  let s = '';
  for (const n of arr) {
    let nv = toInt(n);
    if (nv > 0x10ffff) nv = 0xfffd;
    if (nv < 0) throw new JqAbort('src/jv_unicode.c:101: jvp_utf8_encode: Assertion `codepoint >= 0 && codepoint <= 0x10FFFF\' failed.');
    s += nv >= 0xd800 && nv <= 0xdfff ? String.fromCharCode(nv) : String.fromCodePoint(nv);
  }
  return s;
}

// a failed C assertion: jq prints it and aborts (exit 134)
export class JqAbort extends Error {}

// ---------------------------------------------------------------- jv_aux.c

function parseSlice(j, slice) {
  let startJ = slice.has('start') ? slice.get('start') : null;
  let endJ = slice.has('end') ? slice.get('end') : null;
  if (startJ === null) startJ = 0;
  let len;
  if (Array.isArray(j)) len = j.length;
  else if (typeof j === 'string') len = cpLength(j);
  else return null;
  if (endJ === null) endJ = len;
  if (typeof startJ !== 'number' || typeof endJ !== 'number') return null;
  let dstart = startJ, dend = endJ;
  if (dstart < 0) dstart += len;
  if (dend < 0) dend += len;
  if (dstart < 0) dstart = 0;
  if (dstart > len) dstart = len;
  const start = toInt(dstart);
  let end = dend > len ? len : toInt(dend);
  if (end < dend) end += 1;
  if (end > len) end = len;
  if (end < start) end = start;
  return [start, end];
}

export function jvGet(t, k) {
  const kt = kind(t), kk = kind(k);
  if (kt === K_OBJECT && kk === K_STRING) {
    const v = t.get(k);
    return v === undefined ? null : v;
  }
  if (kt === K_ARRAY && kk === K_NUMBER) {
    if (isInteger(k)) {
      let idx = k;
      if (idx < 0) idx += t.length;
      const v = idx >= 0 && idx < t.length ? t[idx] : undefined;
      return v === undefined ? null : v;
    }
    return null;
  }
  if (kt === K_ARRAY && kk === K_OBJECT) {
    const r = parseSlice(t, k);
    if (r) return t.slice(r[0], r[1]);
    return invalidMsg('Start and end indices of an array slice must be numbers');
  }
  if (kt === K_STRING && kk === K_OBJECT) {
    const r = parseSlice(t, k);
    if (r) return stringSlice(t, r[0], r[1]);
    return invalidMsg('Start and end indices of an string slice must be numbers');
  }
  if (kt === K_ARRAY && kk === K_ARRAY) return arrayIndexes(t, k);
  if (kt === K_NULL && (kk === K_STRING || kk === K_NUMBER || kk === K_OBJECT)) return null;
  if (kk === K_STRING && byteLength(k) < 30) return invalidMsg(`Cannot index ${KIND_NAMES[kt]} with string "${k}"`);
  return invalidMsg(`Cannot index ${KIND_NAMES[kt]} with ${KIND_NAMES[kk]}`);
}

function arrayIndexes(a, b) {
  const res = [];
  let idx = -1;
  for (let ai = 0; ai < a.length; ai++) {
    for (let bi = 0; bi < b.length; bi++) {
      if ((bi === 0 && !jvEqual(a[ai], b[bi])) || (bi > 0 && !jvEqual(ai + bi < a.length ? a[ai + bi] : INVALID, b[bi]))) idx = -1;
      else if (bi === 0 && idx === -1) idx = ai;
    }
    if (idx > -1) res.push(idx);
    idx = -1;
  }
  return res;
}

export function jvSet(t, k, v) {
  if (!isValid(v)) return v;
  const kt = kind(t), kk = kind(k);
  const isnull = kt === K_NULL;
  if (kk === K_STRING && (kt === K_OBJECT || isnull)) return objectSet(isnull ? new Map() : t, k, v);
  if (kk === K_NUMBER && (kt === K_ARRAY || isnull)) return arraySet(isnull ? [] : t, toInt(k), v);
  if (kk === K_OBJECT && (kt === K_ARRAY || isnull)) {
    if (isnull) t = [];
    const r = parseSlice(t, k);
    if (!r) return invalidMsg('Start and end indices of an array slice must be numbers');
    if (!Array.isArray(v)) return invalidMsg('A slice of an array can only be assigned another array');
    const [start, end] = r;
    return t.slice(0, start).concat(v, t.slice(end));
  }
  return invalidMsg(`Cannot update field at ${KIND_NAMES[kk]} index of ${KIND_NAMES[kt]}`);
}

export function jvHas(t, k) {
  const kt = kind(t), kk = kind(k);
  if (kt === K_NULL) return false;
  if (kt === K_OBJECT && kk === K_STRING) return t.has(k);
  if (kt === K_ARRAY && kk === K_NUMBER) {
    const i = toInt(k);
    return i >= 0 && i < t.length;
  }
  return invalidMsg(`Cannot check whether ${KIND_NAMES[kt]} has a ${KIND_NAMES[kk]} key`);
}

function jvDels(t, keys) {
  const kt = kind(t);
  if (kt === K_NULL || keys.length === 0) return t;
  if (kt === K_ARRAY) {
    const neg = [], nonneg = [], starts = [], ends = [];
    for (const key of keys) {
      if (typeof key === 'number') (key < 0 ? neg : nonneg).push(key);
      else if (key instanceof Map) {
        const r = parseSlice(t, key);
        if (!r) return invalidMsg('Start and end indices of an array slice must be numbers');
        starts.push(r[0]); ends.push(r[1]);
      } else return invalidMsg(`Cannot delete ${typeName(key)} element of array`);
    }
    let ni = 0, pi = 0;
    const len = t.length;
    const out = [];
    for (let i = 0; i < len; i++) {
      let del = false;
      while (ni < neg.length) {
        const d = len + toInt(neg[ni]);
        if (i === d) del = true;
        if (i < d) break;
        ni++;
      }
      while (pi < nonneg.length) {
        const d = toInt(nonneg[pi]);
        if (i === d) del = true;
        if (i < d) break;
        pi++;
      }
      for (let s = 0; !del && s < starts.length; s++) if (starts[s] <= i && i < ends[s]) del = true;
      if (!del) out.push(t[i]);
    }
    return out;
  }
  if (kt === K_OBJECT) {
    for (const k of keys) {
      if (typeof k !== 'string') return invalidMsg(`Cannot delete ${typeName(k)} field of object`);
      t = objectDelete(t, k);
    }
    return t;
  }
  return invalidMsg(`Cannot delete fields from ${KIND_NAMES[kt]}`);
}

const MAX_PATH_DEPTH = 10000;

export function jvSetpath(root, path, value) {
  if (!Array.isArray(path)) return invalidMsg('Path must be specified as an array');
  if (path.length > MAX_PATH_DEPTH) return invalidMsg('Path too deep');
  return setpathRec(root, path, 0, value);
}
function setpathRec(root, path, i, value) {
  if (!isValid(root)) return root;
  if (i === path.length) return value;
  const cur = path[i];
  return jvSet(root, cur, setpathRec(jvGet(root, cur), path, i + 1, value));
}

export function jvGetpath(root, path) {
  if (!Array.isArray(path)) return invalidMsg('Path must be specified as an array');
  if (path.length > MAX_PATH_DEPTH) return invalidMsg('Path too deep');
  for (let i = 0; i < path.length; i++) {
    if (!isValid(root)) return root;
    root = jvGet(root, path[i]);
  }
  return root;
}

function delpathsSorted(object, paths, start) {
  const delkeys = [];
  for (let i = 0; i < paths.length;) {
    let j = i;
    const delkey = paths[i].length === start + 1;
    const key = paths[i][start];
    while (j < paths.length && jvEqual(key, paths[j][start])) j++;
    if (delkey) delkeys.push(key);
    else {
      const sub = jvGet(object, key);
      if (!isValid(sub)) return sub;
      if (sub !== null) {
        const nsub = delpathsSorted(sub, paths.slice(i, j), start + 1);
        if (!isValid(nsub)) return nsub;
        object = jvSet(object, key, nsub);
        if (!isValid(object)) return object;
      }
    }
    i = j;
  }
  return jvDels(object, delkeys);
}

export function jvDelpaths(object, paths) {
  if (!Array.isArray(paths)) return invalidMsg('Paths must be specified as an array');
  paths = jvSort(paths, paths);
  for (const e of paths) {
    if (!Array.isArray(e)) return invalidMsg(`Path must be specified as array, not ${typeName(e)}`);
    if (e.length > MAX_PATH_DEPTH) return invalidMsg('Path too deep');
  }
  if (paths.length === 0) return object;
  if (paths[0].length === 0) return null;
  return delpathsSorted(object, paths, 0);
}

export function jvKeys(x) {
  if (x instanceof Map) return sortedKeys(x);
  const a = [];
  for (let i = 0; i < x.length; i++) a.push(i);
  return a;
}
export function jvKeysUnsorted(x) {
  if (x instanceof Map) return [...x.keys()];
  return jvKeys(x);
}

function sortItems(objects, keys) {
  const entries = objects.map((o, i) => ({ o, k: keys[i], i }));
  entries.sort((a, b) => jvCmp(a.k, b.k) || a.i - b.i);
  return entries;
}
export function jvSort(objects, keys) {
  return sortItems(objects, keys).map(e => e.o);
}
export function jvGroup(objects, keys) {
  const entries = sortItems(objects, keys);
  const ret = [];
  if (entries.length) {
    let curr = entries[0].k;
    let group = [entries[0].o];
    for (let i = 1; i < entries.length; i++) {
      if (!jvEqual(curr, entries[i].k)) {
        curr = entries[i].k;
        ret.push(group);
        group = [];
      }
      group.push(entries[i].o);
    }
    ret.push(group);
  }
  return ret;
}

// ---------------------------------------------------------------- printing (jv_print.c)

export const PRINT_PRETTY = 1, PRINT_ASCII = 2, PRINT_COLOR = 4, PRINT_SORTED = 8, PRINT_INVALID = 16,
  PRINT_REFCOUNT = 32, PRINT_TAB = 64, PRINT_ISATTY = 128, PRINT_SPACE0 = 256, PRINT_SPACE1 = 512, PRINT_SPACE2 = 1024;
export const indentFlags = (n) => (n < 0 || n > 7 ? PRINT_TAB | PRINT_PRETTY : n === 0 ? 0 : (n << 8) | PRINT_PRETTY);

const ESC = '\x1b';
const COL = (c) => ESC + '[' + c + 'm';
const COLRESET = ESC + '[0m';
const FIELD_COLOR = COL('34;1');
const DEF_COLORS = [COL('1;30'), COL('0;39'), COL('0;39'), COL('0;39'), COL('0;32'), COL('1;39'), COL('1;39')];
let colors = DEF_COLORS;

// jq_set_colors(JQ_COLORS); returns false when the spec is malformed
export function setColors(c) {
  colors = DEF_COLORS;
  const bufs = DEF_COLORS.slice();
  let i = 0;
  let p = 0;
  for (; i < DEF_COLORS.length && p < c.length; i++) {
    let e = c.indexOf(':', p);
    if (e < 0) e = c.length;
    const spec = c.slice(p, e);
    if (spec.length > 12) return false;
    if (!/^[0-9;]*$/.test(spec)) return false;
    bufs[i] = ESC + '[' + spec + 'm';
    p = e < c.length ? e + 1 : e;
  }
  colors = bufs;
  return true;
}
export function resetColors() { colors = DEF_COLORS; }

const MAX_DEPTH = 256;

function dumpString(s, ascii) {
  let out = '"';
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e && c !== 0x22 && c !== 0x5c) continue;
    if (c >= 0xd800 && c <= 0xdfff) {
      // a lone surrogate (only implode makes them) is an invalid UTF-8 sequence for jq
      if (c > 0xdbff || i + 1 >= s.length || (s.charCodeAt(i + 1) & 0xfc00) !== 0xdc00) {
        throw new JqAbort('src/jv_print.c:129: jvp_dump_string: Assertion `c != -1\' failed.');
      }
      if (!ascii) { i++; continue; }
    }
    if (c >= 0x80 && !ascii) continue;
    out += s.slice(run, i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c < 0x20 || c === 0x7f) {
      switch (c) {
        case 8: out += '\\b'; break;
        case 9: out += '\\t'; break;
        case 13: out += '\\r'; break;
        case 10: out += '\\n'; break;
        case 12: out += '\\f'; break;
        default: out += '\\u' + c.toString(16).padStart(4, '0');
      }
    } else {
      // ascii-only: \uXXXX, surrogate pairs for the supplementary planes
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        out += '\\u' + c.toString(16).padStart(4, '0') + '\\u' + s.charCodeAt(i + 1).toString(16).padStart(4, '0');
        i++;
      } else {
        if (c >= 0xd800 && c <= 0xdfff) throw new JqAbort('src/jv_print.c:129: jvp_dump_string: Assertion `c != -1\' failed.');
        out += '\\u' + c.toString(16).padStart(4, '0');
      }
    }
    run = i + 1;
  }
  return out + s.slice(run) + '"';
}

function indentStr(n, flags) {
  if (flags & PRINT_TAB) return '\t'.repeat(n);
  return ' '.repeat(n * ((flags & (PRINT_SPACE0 | PRINT_SPACE1 | PRINT_SPACE2)) >> 8));
}

// jv_dump_term -> JS string (the caller UTF-8 encodes it)
export function dump(x, flags) {
  const parts = [];
  dumpTerm(parts, x, flags, 0);
  return parts.join('');
}

function dumpTerm(out, x, flags, indent) {
  let color = null;
  const k = kind(x);
  if (flags & PRINT_COLOR) {
    if (k >= K_NULL) { color = colors[k - 1]; out.push(color); }
  }
  if (indent > MAX_DEPTH) {
    out.push('<stripped: exceeds max depth>');
  } else switch (k) {
    case K_INVALID:
      if (flags & PRINT_INVALID) {
        const msg = getMsg(x);
        if (typeof msg === 'string') out.push('<invalid:', dumpString(msg, true), '>');
        else out.push('<invalid>');
      } else throw new JqAbort('src/jv_print.c:223: jv_dump_term: Assertion `0 && "Invalid value"\' failed.');
      break;
    case K_NULL: out.push('null'); break;
    case K_FALSE: out.push('false'); break;
    case K_TRUE: out.push('true'); break;
    case K_NUMBER: {
      let d = x;
      if (d !== d) out.push('null');
      else {
        if (d > Number.MAX_VALUE) d = Number.MAX_VALUE;
        if (d < -Number.MAX_VALUE) d = -Number.MAX_VALUE;
        out.push(dtoaFmt(d));
      }
      break;
    }
    case K_STRING: out.push(dumpString(x, flags & PRINT_ASCII)); break;
    case K_ARRAY: {
      if (x.length === 0) { out.push('[]'); break; }
      out.push('[');
      if (flags & PRINT_PRETTY) out.push('\n', indentStr(indent + 1, flags));
      for (let i = 0; i < x.length; i++) {
        if (i !== 0) {
          if (flags & PRINT_PRETTY) out.push(',\n', indentStr(indent + 1, flags));
          else out.push(',');
        }
        dumpTerm(out, x[i], flags, indent + 1);
        if (color) out.push(color);
      }
      if (flags & PRINT_PRETTY) out.push('\n', indentStr(indent, flags));
      if (color) out.push(color);
      out.push(']');
      break;
    }
    case K_OBJECT: {
      if (x.size === 0) { out.push('{}'); break; }
      out.push('{');
      if (flags & PRINT_PRETTY) out.push('\n', indentStr(indent + 1, flags));
      let first = true;
      const keys = (flags & PRINT_SORTED) ? sortedKeys(x) : x.keys();
      for (const key of keys) {
        const value = x.get(key);
        if (!first) {
          if (flags & PRINT_PRETTY) out.push(',\n', indentStr(indent + 1, flags));
          else out.push(',');
        }
        if (color) out.push(COLRESET);
        first = false;
        if (color) out.push(FIELD_COLOR);
        out.push(dumpString(key, flags & PRINT_ASCII));
        if (color) out.push(COLRESET);
        if (color) out.push(color);
        out.push((flags & PRINT_PRETTY) ? ': ' : ':');
        if (color) out.push(COLRESET);
        dumpTerm(out, value, flags, indent + 1);
        if (color) out.push(color);
      }
      if (flags & PRINT_PRETTY) out.push('\n', indentStr(indent, flags));
      if (color) out.push(color);
      out.push('}');
      break;
    }
  }
  if (color) out.push(COLRESET);
}

// jv_dump_string_trunc: compact dump cut to bufsize-1 bytes, "..." marking truncation
export function dumpTrunc(x, bufsize) {
  const s = encodeUtf8(dump(x, 0));
  if (s.length <= bufsize - 1) return decodeUtf8(s);
  let t = s.slice(0, bufsize - 1);
  if (bufsize >= 4) t = t.slice(0, bufsize - 4) + '...';
  return decodeUtf8(t);
}

// ---------------------------------------------------------------- parsing (jv_parse.c)

export const PARSE_SEQ = 1, PARSE_STREAMING = 2, PARSE_STREAM_ERRORS = 4;
const MAX_PARSING_DEPTH = 256;
const OK = 'output produced';
const LAST_NONE = 0, LAST_OPEN_ARRAY = 1, LAST_OPEN_OBJECT = 2, LAST_COLON = 3, LAST_COMMA = 4, LAST_VALUE = 5;
const ST_NORMAL = 0, ST_STRING = 1, ST_STRING_ESCAPE = 2, ST_WAITING_FOR_RS = 3;
const NONE = undefined;   // "jv_invalid()" for parser slots

function unhex4(t, i) {
  let r = 0;
  for (let k = 0; k < 4; k++) {
    const c = t.charCodeAt(i + k);
    let n;
    if (c >= 48 && c <= 57) n = c - 48;
    else if (c >= 97 && c <= 102) n = c - 87;
    else if (c >= 65 && c <= 70) n = c - 55;
    else return -1;
    r = (r << 4) | n;
  }
  return r;
}

function cpBytes(cp) {
  if (cp < 0x80) return String.fromCharCode(cp);
  if (cp < 0x800) return String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  if (cp < 0x10000) return String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  return String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
}

export class JvParser {
  constructor(flags) {
    this.flags = flags;
    if (flags & PARSE_STREAMING) this.path = [];
    else { this.path = NONE; this.flags &= ~PARSE_STREAM_ERRORS; }
    this.stack = [];
    this.stacklen = 0;       // streaming: path length
    this.lastSeen = LAST_NONE;
    this.output = NONE;
    this.next = NONE;
    this.tok = '';
    this.st = (flags & PARSE_SEQ) ? ST_WAITING_FOR_RS : ST_NORMAL;
    this.eof = false;
    this.buf = null;
    this.bufPos = 0;
    this.bufPartial = false;
    this.bomPos = 0;
    this.lastChWasWs = false;
    this.line = 1;
    this.column = 0;
    this.flags = flags;
  }

  reset() {
    if (this.flags & PARSE_STREAMING) { this.path = []; this.stacklen = 0; }
    this.lastSeen = LAST_NONE;
    this.output = NONE;
    this.next = NONE;
    this.stack = [];
    this.tok = '';
    this.st = ST_NORMAL;
  }

  value(v) {
    if (this.flags & PARSE_STREAMING) {
      if (this.next !== NONE || this.lastSeen === LAST_VALUE) return 'Expected separator between values';
      this.lastSeen = this.stacklen > 0 ? LAST_VALUE : LAST_NONE;
    } else if (this.next !== NONE) return 'Expected separator between values';
    this.next = v;
    return null;
  }

  parseToken(ch) {
    const st = this.stack;
    switch (ch) {
      case '[':
        if (st.length >= MAX_PARSING_DEPTH) return 'Exceeds depth limit for parsing';
        if (this.next !== NONE) return 'Expected separator between values';
        st.push({ t: 'a', v: [] });
        break;
      case '{':
        if (st.length >= MAX_PARSING_DEPTH) return 'Exceeds depth limit for parsing';
        if (this.next !== NONE) return 'Expected separator between values';
        st.push({ t: 'o', v: new Map() });
        break;
      case ':':
        if (this.next === NONE) return "Expected string key before ':'";
        if (st.length === 0 || st[st.length - 1].t !== 'o') return "':' not as part of an object";
        if (typeof this.next !== 'string') return 'Object keys must be strings';
        st.push({ t: 'k', v: this.next });
        this.next = NONE;
        break;
      case ',': {
        if (this.next === NONE) return "Expected value before ','";
        if (st.length === 0) return "',' not as part of an object or array";
        const top = st[st.length - 1];
        if (top.t === 'a') { top.v.push(this.next); this.next = NONE; }
        else if (top.t === 'k') {
          st[st.length - 2].v.set(top.v, this.next);
          st.pop();
          this.next = NONE;
        } else return 'Objects must consist of key:value pairs';
        break;
      }
      case ']': {
        if (st.length === 0 || st[st.length - 1].t !== 'a') return "Unmatched ']'";
        const top = st[st.length - 1];
        if (this.next !== NONE) { top.v.push(this.next); this.next = NONE; }
        else if (top.v.length !== 0) return 'Expected another array element';
        this.next = st.pop().v;
        break;
      }
      case '}': {
        if (st.length === 0) return "Unmatched '}'";
        const top = st[st.length - 1];
        if (this.next !== NONE) {
          if (top.t !== 'k') return 'Objects must consist of key:value pairs';
          st[st.length - 2].v.set(top.v, this.next);
          st.pop();
          this.next = NONE;
        } else {
          if (top.t !== 'o') return "Unmatched '}'";
          if (top.v.size !== 0) return 'Expected another key-value pair';
        }
        this.next = st.pop().v;
        break;
      }
    }
    return null;
  }

  streamToken(ch) {
    switch (ch) {
      case '[':
        if (this.next !== NONE) return 'Expected a separator between values';
        this.path = this.path.concat([0]);
        this.lastSeen = LAST_OPEN_ARRAY;
        this.stacklen++;
        break;
      case '{':
        if (this.lastSeen === LAST_VALUE) return 'Expected a separator between values';
        this.path = this.path.concat([null]);
        this.lastSeen = LAST_OPEN_OBJECT;
        this.stacklen++;
        break;
      case ':':
        if (this.stacklen === 0 || typeof this.path[this.stacklen - 1] === 'number') return "':' not as part of an object";
        if (this.next === NONE || this.lastSeen === LAST_NONE) return "Expected string key before ':'";
        if (typeof this.next !== 'string') return 'Object keys must be strings';
        if (this.lastSeen !== LAST_VALUE) return "':' should follow a key";
        this.lastSeen = LAST_COLON;
        this.path = arraySet(this.path, this.stacklen - 1, this.next);
        this.next = NONE;
        break;
      case ',': {
        if (this.lastSeen !== LAST_VALUE) return "Expected value before ','";
        if (this.stacklen === 0) return "',' not as part of an object or array";
        const last = this.path[this.stacklen - 1];
        if (typeof last === 'number') {
          if (this.next !== NONE) { this.output = [this.path, this.next]; this.next = NONE; }
          this.path = arraySet(this.path, this.stacklen - 1, last + 1);
          this.lastSeen = LAST_COMMA;
        } else if (typeof last === 'string') {
          if (this.next !== NONE) { this.output = [this.path, this.next]; this.next = NONE; }
          this.path = arraySet(this.path, this.stacklen - 1, true);
          this.lastSeen = LAST_COMMA;
        } else return 'Objects must consist of key:value pairs';
        break;
      }
      case ']': {
        if (this.stacklen === 0) return "Unmatched ']' at the top-level";
        if (this.lastSeen === LAST_COMMA) return 'Expected another array element';
        const last = this.path[this.stacklen - 1];
        if (typeof last !== 'number') return "Unmatched ']' in the middle of an object";
        if (this.next !== NONE) { this.output = [this.path, this.next, true]; this.next = NONE; }
        else if (this.lastSeen !== LAST_OPEN_ARRAY) this.output = [this.path];
        this.path = this.path.slice(0, --this.stacklen);
        this.next = NONE;
        if (this.lastSeen === LAST_OPEN_ARRAY) this.output = [this.path, []];
        this.lastSeen = this.stacklen === 0 ? LAST_NONE : LAST_VALUE;
        break;
      }
      case '}': {
        if (this.stacklen === 0) return "Unmatched '}' at the top-level";
        if (this.lastSeen === LAST_COMMA) return 'Expected another key:value pair';
        const last = this.path[this.stacklen - 1];
        if (typeof last === 'number') return "Unmatched '}' in the middle of an array";
        if (this.next !== NONE) {
          if (typeof last !== 'string') return 'Objects must consist of key:value pairs';
          this.output = [this.path, this.next, true];
          this.next = NONE;
        } else {
          if (this.lastSeen === LAST_COLON) return 'Missing value in key:value pair';
          if (this.lastSeen === LAST_COMMA) return 'Expected another key-value pair';
          if (this.lastSeen === LAST_OPEN_ARRAY) return "Unmatched '}' in the middle of an array";
          if (this.lastSeen !== LAST_VALUE && this.lastSeen !== LAST_OPEN_OBJECT) return "Unmatched '}'";
          if (this.lastSeen !== LAST_OPEN_OBJECT) this.output = [this.path];
        }
        this.path = this.path.slice(0, --this.stacklen);
        this.next = NONE;
        if (this.lastSeen === LAST_OPEN_OBJECT) this.output = [this.path, new Map()];
        this.lastSeen = this.stacklen === 0 ? LAST_NONE : LAST_VALUE;
        break;
      }
    }
    return null;
  }

  token(ch) { return (this.flags & PARSE_STREAMING) ? this.streamToken(ch) : this.parseToken(ch); }

  foundString() {
    const t = this.tok;
    const end = t.length;
    let out = '';
    let i = 0;
    while (i < end) {
      let c = t[i++];
      if (c === '\\') {
        if (i >= end) return 'Expected escape character at end of string';
        c = t[i++];
        switch (c) {
          case '\\': case '"': case '/': out += c; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 't': out += '\t'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 'u': {
            if (i + 4 > end) return 'Invalid \\uXXXX escape';
            const hv = unhex4(t, i);
            if (hv < 0) return 'Invalid characters in \\uXXXX escape';
            let cp = hv;
            i += 4;
            if (cp >= 0xd800 && cp <= 0xdbff) {
              if (i + 6 > end || t[i] !== '\\' || t[i + 1] !== 'u') return 'Invalid \\uXXXX\\uXXXX surrogate pair escape';
              const sur = unhex4(t, i + 2);
              if (!(sur >= 0xdc00 && sur <= 0xdfff)) return 'Invalid \\uXXXX\\uXXXX surrogate pair escape';
              i += 6;
              cp = 0x10000 + (((cp - 0xd800) << 10) | (sur - 0xdc00));
            }
            if (cp > 0x10ffff) cp = 0xfffd;
            out += cpBytes(cp);
            break;
          }
          default: return 'Invalid escape';
        }
      } else {
        const cc = c.charCodeAt(0);
        if (cc > 0 && cc < 0x1f) return 'Invalid string: control characters from U+0000 through U+001F must be escaped';
        out += c;
      }
    }
    const err = this.value(decodeUtf8(out));
    if (err) return err;
    this.tok = '';
    return null;
  }

  checkLiteral() {
    const t = this.tok;
    if (t.length === 0) return null;
    let pattern = null, v;
    switch (t[0]) {
      case 't': pattern = 'true'; v = true; break;
      case 'f': pattern = 'false'; v = false; break;
      case 'n': pattern = 'null'; v = null; break;
    }
    if (pattern) {
      if (t !== pattern) return 'Invalid literal';
      const err = this.value(v);
      if (err) return err;
    } else {
      // the token is a C string here: it ends at a NUL byte
      const z = t.indexOf('\0');
      const cs = z < 0 ? t : t.slice(0, z);
      const r = strtod(cs);
      if (r.end !== cs.length) return 'Invalid numeric literal';
      const err = this.value(r.v);
      if (err) return err;
    }
    this.tok = '';
    return null;
  }

  checkDone() {
    if (this.flags & PARSE_STREAMING) {
      if (this.stacklen === 0 && this.next !== NONE) {
        const r = [this.path, this.next];
        this.next = NONE;
        return r;
      }
      if (this.output !== NONE) {
        if (this.output.length > 2) {
          const r = this.output.slice(0, 2);
          this.output = this.output.slice(0, 1);
          return r;
        }
        const r = this.output;
        this.output = NONE;
        return r;
      }
      return NONE;
    }
    if (this.stack.length === 0 && this.next !== NONE) {
      const r = this.next;
      this.next = NONE;
      return r;
    }
    return NONE;
  }

  checkTruncation() {
    if (this.flags & PARSE_STREAMING) {
      const k = this.next === NONE ? K_INVALID : kind(this.next);
      return this.stacklen > 0 || k === K_NUMBER || k === K_TRUE || k === K_FALSE || k === K_NULL;
    }
    return (this.flags & PARSE_SEQ) && !this.lastChWasWs &&
      (this.stack.length > 0 || this.tok.length > 0 || typeof this.next === 'number');
  }

  isTopNum() {
    if (this.flags & PARSE_STREAMING) return this.stacklen === 0 && typeof this.next === 'number';
    return this.stack.length === 0 && typeof this.next === 'number';
  }

  // scan(): returns [msg, value]
  scan(ch) {
    this.column++;
    if (ch === '\n') { this.line++; this.column = 0; }
    if (ch === '\x1e') {
      if (this.checkTruncation()) {
        if (this.checkLiteral() === null && this.isTopNum()) return ['Potentially truncated top-level numeric value', NONE];
        return ['Truncated value', NONE];
      }
      const err = this.checkLiteral();
      if (err) return [err, NONE];
      if (this.st === ST_NORMAL) {
        const v = this.checkDone();
        if (v !== NONE) return [OK, v];
      }
      this.reset();
      return [OK, NONE];
    }
    let answer = null, out = NONE;
    this.lastChWasWs = false;
    if (this.st === ST_NORMAL) {
      let cls;
      switch (ch) {
        case ' ': case '\t': case '\r': case '\n': cls = 'ws'; break;
        case '"': cls = 'q'; break;
        case '[': case ',': case ']': case '{': case ':': case '}': cls = 's'; break;
        default: cls = 'l';
      }
      if (cls === 'ws') this.lastChWasWs = true;
      if (cls !== 'l') {
        const err = this.checkLiteral();
        if (err) return [err, NONE];
        const v = this.checkDone();
        if (v !== NONE) { answer = OK; out = v; }
      }
      if (cls === 'l') this.tok += ch;
      else if (cls === 'q') this.st = ST_STRING;
      else if (cls === 's') {
        const err = this.token(ch);
        if (err) return [err, out];
      }
      const v = this.checkDone();
      if (v !== NONE) { answer = OK; out = v; }
    } else {
      if (ch === '"' && this.st === ST_STRING) {
        const err = this.foundString();
        if (err) return [err, out];
        this.st = ST_NORMAL;
        const v = this.checkDone();
        if (v !== NONE) { answer = OK; out = v; }
      } else {
        this.tok += ch;
        this.st = (ch === '\\' && this.st === ST_STRING) ? ST_STRING_ESCAPE : ST_STRING;
      }
    }
    return [answer, out];
  }

  remaining() {
    if (this.buf === null) return 0;
    return this.buf.length - this.bufPos;
  }

  setBuf(buf, isPartial) {
    let i = 0;
    const BOM = '\xef\xbb\xbf';
    while (i < buf.length && this.bomPos < 3) {
      if (buf[i] === BOM[this.bomPos]) { i++; this.bomPos++; }
      else if (this.bomPos === 0) this.bomPos = 3;
      else this.bomPos = 0xff;
    }
    this.buf = i ? buf.slice(i) : buf;
    this.bufPos = 0;
    this.bufPartial = isPartial;
  }

  makeError(msg) {
    if (this.flags & PARSE_STREAM_ERRORS) return [msg, this.path];
    return invalidMsg(msg);
  }

  // jv_parser_next: a value, INVALID (need more input / nothing), or an invalid with a message
  nextValue() {
    if (this.eof) return INVALID;
    if (this.buf === null) return INVALID;
    if (this.bomPos === 0xff) {
      if (!(this.flags & PARSE_SEQ)) return invalidMsg('Malformed BOM');
      this.st = ST_WAITING_FOR_RS;
      this.reset();
    }
    if (this.flags & PARSE_STREAMING) {
      const v = this.checkDone();
      if (v !== NONE) return v;
    }
    let msg = null, value = NONE, ch = '';
    const buf = this.buf;
    while (!msg && this.bufPos < buf.length) {
      ch = buf[this.bufPos++];
      if (this.st === ST_WAITING_FOR_RS) {
        if (ch === '\n') { this.line++; this.column = 0; }
        else this.column++;
        if (ch === '\x1e') this.st = ST_NORMAL;
        continue;
      }
      [msg, value] = this.scan(ch);
    }
    if (msg === OK) return value === NONE ? INVALID : value;
    if (msg) {
      if (ch !== '\x1e' && (this.flags & PARSE_SEQ)) {
        this.st = ST_WAITING_FOR_RS;
        const e = this.makeError(`${msg} at line ${this.line}, column ${this.column} (need RS to resync)`);
        this.reset();   // (resets st to normal again, as jq does)
        return e;
      }
      const e = this.makeError(`${msg} at line ${this.line}, column ${this.column}`);
      this.reset();
      if (!(this.flags & PARSE_SEQ)) { this.buf = null; this.bufPos = 0; }
      return e;
    }
    if (this.bufPartial) return INVALID;
    this.eof = true;
    if (this.st === ST_WAITING_FOR_RS) return this.makeError(`Unfinished abandoned text at EOF at line ${this.line}, column ${this.column}`);
    if (this.st !== ST_NORMAL) {
      const e = this.makeError(`Unfinished string at EOF at line ${this.line}, column ${this.column}`);
      this.reset();
      this.st = ST_WAITING_FOR_RS;
      return e;
    }
    const lm = this.checkLiteral();
    if (lm) {
      const e = this.makeError(`${lm} at EOF at line ${this.line}, column ${this.column}`);
      this.reset();
      this.st = ST_WAITING_FOR_RS;
      return e;
    }
    if (((this.flags & PARSE_STREAMING) && this.stacklen !== 0) || (!(this.flags & PARSE_STREAMING) && this.stack.length !== 0)) {
      const e = this.makeError(`Unfinished JSON term at EOF at line ${this.line}, column ${this.column}`);
      this.reset();
      this.st = ST_WAITING_FOR_RS;
      return e;
    }
    let v;
    if ((this.flags & PARSE_STREAMING) && this.next !== NONE) v = [this.path, this.next];
    else v = this.next;
    this.next = NONE;
    if ((this.flags & PARSE_SEQ) && !this.lastChWasWs && typeof v === 'number') {
      return this.makeError(`Potentially truncated top-level numeric value at EOF at line ${this.line}, column ${this.column}`);
    }
    return v === NONE ? INVALID : v;
  }
}

// a stream-errors error is a valid array [msg, path]; the parser hands it out as a value
// jv_parse_sized: exactly one JSON text from a byte string
export function parseSized(bytes) {
  const p = new JvParser(0);
  p.setBuf(bytes, false);
  let value = p.nextValue();
  if (isValid(value)) {
    const next = p.nextValue();
    if (isValid(next)) value = invalidMsg('Unexpected extra JSON values');
    else if (hasMsg(next)) value = next;
  } else if (!hasMsg(value)) value = invalidMsg('Expected JSON value');
  if (!isValid(value) && hasMsg(value)) {
    value = invalidMsg(`${getMsg(value)} (while parsing '${decodeUtf8(bytes)}')`);
  }
  return value;
}
// jv_parse: C string (stops at NUL)
export function parseCString(bytes) {
  const z = bytes.indexOf('\0');
  return parseSized(z < 0 ? bytes : bytes.slice(0, z));
}
