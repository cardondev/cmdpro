// gawk 5.1 scalar values: the string/number/strnum typing of node.c, number <-> string conversion,
// the [s]printf formatter (format_tree() of builtin.c) and gawk's own random() (support/random.c).
import { fixedDigits, fmtE, fmtG } from '../cfmt.js';

// ---------------------------------------------------------------- value kinds
// JS number        NUMBER
// JS string        STRING
// undefined        the null string of an unassigned variable (both STRING and NUMBER)
// UserStr          user input (USER_INPUT): fields, getline vars, ARGV, ENVIRON, -v; a strnum when
//                  it looks numeric, else a string
// NULL_FIELD       a field past NF ($n not there): STRING only, typeof() "unassigned"
// TypedRe          a regexp constant @/.../ (REGEX)
export class UserStr {
  constructor(s) { this.s = s; this.st = 0; this.n = 0; }   // st: 0 not yet checked, 1 strnum, 2 string
}
export class NullField { constructor() { this.s = ''; } }
export const NULL_FIELD = new NullField();
export class TypedRe { constructor(src) { this.src = src; this.s = src; } }

export class AwkFatal extends Error {
  // msg: text after "fatal: "; plain: print msg without the "fatal: " prefix (msg() + exit)
  constructor(msg, { plain = false, code = 2 } = {}) { super(msg); this.plain = plain; this.code = code; }
}

const isSpaceC = (c) => c === 32 || (c >= 9 && c <= 13);
const isDigitC = (c) => c >= 48 && c <= 57;
const isAlphaC = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isXdigitC = (c) => isDigitC(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

// C strtod() in the C locale over s[i, e): returns { v, end }
export function strtod(s, i = 0, e = s.length) {
  const start = i;
  let j = i;
  let neg = false;
  if (j < e && (s[j] === '+' || s[j] === '-')) { neg = s[j] === '-'; j++; }
  const rest = s.slice(j, Math.min(e, j + 8)).toLowerCase();
  if (rest.startsWith('inf')) {
    const end = rest.startsWith('infinity') ? j + 8 : j + 3;
    return { v: neg ? -Infinity : Infinity, end };
  }
  if (rest.startsWith('nan')) {
    let end = j + 3;
    if (s[end] === '(') {
      let k = end + 1;
      while (k < e && /[A-Za-z0-9_]/.test(s[k])) k++;
      if (s[k] === ')') end = k + 1;
    }
    return { v: neg ? negNaN() : NaN, end };
  }
  if (j + 1 < e && s[j] === '0' && (s[j + 1] === 'x' || s[j + 1] === 'X') && (isXdigitC(s.charCodeAt(j + 2)) || (s[j + 2] === '.' && isXdigitC(s.charCodeAt(j + 3))))) {
    // hexadecimal floating constant
    let k = j + 2, mant = 0, exp = 0, any = false;
    while (k < e && isXdigitC(s.charCodeAt(k))) { mant = mant * 16 + parseInt(s[k], 16); k++; any = true; }
    if (s[k] === '.') { k++; while (k < e && isXdigitC(s.charCodeAt(k))) { mant = mant * 16 + parseInt(s[k], 16); exp -= 4; k++; any = true; } }
    if (!any) return { v: 0, end: start };
    if ((s[k] === 'p' || s[k] === 'P')) {
      let q = k + 1, eneg = false;
      if (s[q] === '+' || s[q] === '-') { eneg = s[q] === '-'; q++; }
      if (q < e && isDigitC(s.charCodeAt(q))) {
        let ev = 0;
        while (q < e && isDigitC(s.charCodeAt(q))) { ev = ev * 10 + (s.charCodeAt(q) - 48); q++; }
        exp += eneg ? -ev : ev;
        k = q;
      }
    }
    const v = mant * Math.pow(2, exp);
    return { v: neg ? -v : v, end: k };
  }
  let k = j, digits = 0;
  while (k < e && isDigitC(s.charCodeAt(k))) { k++; digits++; }
  if (k < e && s[k] === '.') { k++; while (k < e && isDigitC(s.charCodeAt(k))) { k++; digits++; } }
  if (!digits) return { v: 0, end: start };
  if (k < e && (s[k] === 'e' || s[k] === 'E')) {
    let q = k + 1;
    if (q < e && (s[q] === '+' || s[q] === '-')) q++;
    if (q < e && isDigitC(s.charCodeAt(q))) { while (q < e && isDigitC(s.charCodeAt(q))) q++; k = q; }
  }
  return { v: parseFloat(s.slice(start, k)), end: k };
}

let NEG_NAN;
export function negNaN() {
  if (NEG_NAN === undefined) { const b = new DataView(new ArrayBuffer(8)); b.setUint32(0, 0xfff80000); b.setUint32(4, 0); NEG_NAN = b.getFloat64(0); }
  return NEG_NAN;
}
export function signbit(x) {
  if (x === 0) return Object.is(x, -0);
  if (!Number.isNaN(x)) return x < 0;
  const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); return (b.getUint8(0) & 0x80) !== 0;
}

// get_numbase()
export function getNumbase(s, i = 0, e = s.length) {
  const len = e - i;
  if (len < 2 || s[i] !== '0') return 10;
  if (s[i + 1] === 'x' || s[i + 1] === 'X') return 16;
  for (let k = i; k < e; k++) {
    const c = s[k];
    if (c === 'e' || c === 'E' || c === '.') return 10;
    if (!isDigitC(s.charCodeAt(k))) break;
  }
  const c1 = s.charCodeAt(i + 1);
  if (!isDigitC(c1) || s[i + 1] === '8' || s[i + 1] === '9') return 10;
  return 8;
}

// nondec2awknum(): returns { v, end }
export function nondec2awknum(s, i = 0, e = s.length) {
  const len = e - i;
  if (len >= 2 && s[i] === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X')) {
    if (len <= 2) return { v: 0, end: i };
    let v = 0, k = i + 2;
    for (; k < e; k++) {
      const c = s.charCodeAt(k);
      if (!isXdigitC(c)) break;
      v = v * 16 + parseInt(s[k], 16);
    }
    return { v, end: k };
  }
  if (len >= 1 && s[i] === '0') {
    let v = 0, k = i;
    for (; k < e; k++) {
      const c = s.charCodeAt(k);
      if (!isDigitC(c)) return { v, end: k };
      if (c === 56 || c === 57) return strtod(s, i, e);
      v = v * 8 + (c - 48);
    }
    return { v, end: k };
  }
  return strtod(s, i, e);
}

const isMagic = (s, i) => {
  const a = s[i], b = s.slice(i + 1, i + 4).toLowerCase();
  return (a === '+' || a === '-') && (b === 'inf' || b === 'nan');
};

// r_force_number(): { n, ok } — ok means the whole string is a number (a strnum when USER_INPUT)
export function forceNumber(s, opts = {}) {
  let i = 0, e = s.length;
  while (i < e && isSpaceC(s.charCodeAt(i))) i++;
  if (i === e) return { n: 0, ok: false };
  while (isSpaceC(s.charCodeAt(e - 1))) e--;
  const c0 = s.charCodeAt(i);
  if (!opts.posix) {
    if (isAlphaC(c0)) return { n: 0, ok: false };
    if (e === i + 4 && isMagic(s, i)) {
      const neg = s[i] === '-';
      if (s[i + 1] === 'i' || s[i + 1] === 'I') return { n: neg ? -Infinity : Infinity, ok: true };
      return { n: neg ? negNaN() : NaN, ok: true };
    }
    let h = i;
    if (s[h] === '-' || s[h] === '+') h++;
    if (!opts.nonDecimal && h + 1 < e && s[h] === '0' && (s[h + 1] === 'x' || s[h + 1] === 'X')) return { n: 0, ok: false };
  }
  if (e - i === 1) {
    if (isDigitC(c0)) return { n: c0 - 48, ok: true };
    return { n: 0, ok: false };
  }
  let r;
  if (opts.nonDecimal && !opts.traditional && getNumbase(s, i, e) !== 10) r = nondec2awknum(s, i, e);
  else r = strtod(s, i, e);
  return { n: r.v, ok: r.end === e };
}

// ---------------------------------------------------------------- C conversions (aarch64: saturating)
export function toLong(d) {
  if (Number.isNaN(d)) return 0;
  const t = Math.trunc(d);
  if (t >= 9223372036854775807) return 9223372036854775807;
  if (t <= -9223372036854775808) return -9223372036854775808;
  return t;
}
export function toLongBig(d) {
  if (Number.isNaN(d)) return 0n;
  const t = Math.trunc(d);
  if (t >= 9223372036854775807) return 9223372036854775807n;
  if (t <= -9223372036854775808) return -9223372036854775808n;
  return BigInt(t);
}
const U64_MAX = (1n << 64n) - 1n;
export function toUintmax(d) {
  if (Number.isNaN(d) || d <= 0) return 0n;
  const t = Math.trunc(d);
  if (t >= 18446744073709551615) return U64_MAX;
  return BigInt(t);
}
export function doubleToInt(d) { return d >= 0 ? Math.floor(d) : Math.ceil(d); }

// adjust_uint(): keep 53 significant bits from the lowest set bit (at most 11 dropped)
export function adjustUint(n) {
  const sentinel = 1n << 11n;
  let x = n | sentinel, shift = 0n;
  while ((x & 1n) === 0n) { x >>= 1n; shift++; }
  const mask = (1n << 53n) - 1n;
  return n & (mask << shift);
}

// format_nan_inf()
export function formatNanInf(v, conv) {
  let s;
  if (Number.isNaN(v)) s = signbit(v) ? '-nan' : '+nan';
  else if (!Number.isFinite(v)) s = v < 0 ? '-inf' : '+inf';
  else return null;
  return conv >= 'A' && conv <= 'Z' ? s.toUpperCase() : s;
}

// a C "%[flags][width][.prec]conv" floating point conversion of a finite double
export function cFloat(x, conv, { lj = false, sign = '', alt = false, zero = false, fw = 0, prec = 6, havePrec = true } = {}) {
  const neg = signbit(x) && !Number.isNaN(x);
  const ax = Math.abs(x);
  const upper = conv === 'E' || conv === 'G' || conv === 'A' || conv === 'F';
  let body;
  if (!Number.isFinite(x)) {
    body = Number.isNaN(x) ? 'nan' : 'inf';
    if (upper) body = body.toUpperCase();
    zero = false;
  } else switch (conv) {
    case 'f': case 'F': body = fixedDigits(ax, prec); if (alt && prec === 0) body += '.'; break;
    case 'e': case 'E': body = fmtE(ax, prec, upper, alt); break;
    case 'g': case 'G': body = fmtG(ax, prec, upper, alt); break;
    case 'a': case 'A': body = hexFloat(ax, havePrec ? prec : -1, upper, alt); break;
    default: body = String(ax);
  }
  let prefix = neg ? '-' : sign;
  if ((conv === 'a' || conv === 'A') && Number.isFinite(x)) { prefix += upper ? '0X' : '0x'; body = body.slice(2); }
  const len = prefix.length + body.length;
  if (fw <= len) return prefix + body;
  if (lj) return prefix + body + ' '.repeat(fw - len);
  if (zero) return prefix + '0'.repeat(fw - len) + body;
  return ' '.repeat(fw - len) + prefix + body;
}

// glibc %a of |x|: 0x1.hhhp+d (prec < 0: as many hex digits as needed)
function hexFloat(ax, prec, upper, alt) {
  let s;
  if (ax === 0) {
    s = '0x0' + (prec > 0 ? '.' + '0'.repeat(prec) : alt ? '.' : '') + 'p+0';
  } else {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, ax);
    const hi = b.getUint32(0), lo = b.getUint32(4);
    let e = (hi >>> 20) & 0x7ff;
    let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    let lead = 1n;
    if (e === 0) { lead = 0n; e = -1022; } else e -= 1023;
    let full = (lead << 52n) | mant;     // 1.52 bits
    let ndig = 13;
    if (prec >= 0 && prec < 13) {
      const drop = BigInt((13 - prec) * 4);
      const rem = full & ((1n << drop) - 1n), half = 1n << (drop - 1n);
      full >>= drop;
      if (rem > half || (rem === half && (full & 1n))) full += 1n;
      ndig = prec;
      if (full >> BigInt(ndig * 4) >= 2n && lead === 1n) { full >>= 1n; e += 1; }
    }
    const intPart = full >> BigInt(ndig * 4);
    let frac = ndig ? (full & ((1n << BigInt(ndig * 4)) - 1n)).toString(16).padStart(ndig, '0') : '';
    if (prec < 0) frac = frac.replace(/0+$/, '');
    else if (prec > 13) frac += '0'.repeat(prec - 13);
    s = '0x' + intPart.toString(16) + (frac || alt ? '.' + frac : '') + 'p' + (e < 0 ? '-' : '+') + Math.abs(e);
  }
  return upper ? s.toUpperCase() : s;
}

// ---------------------------------------------------------------- format_tree()
// rt supplies the conversions of the current interpreter state:
//   rt.num(v), rt.str(v) (CONVFMT), rt.isNumeric(v) (after fixtype)
// args[0] is the format; the values follow. Returns the string, or throws AwkFatal.
export function formatTree(rt, fmt, args, opts = {}) {
  const numArgs = args.length;
  let out = '';
  let curArg = 1;
  let toofew = false;
  let usedDollar = false;
  let s0 = 0, s1 = 0;
  let n0 = fmt.length;
  const fatalOut = (m) => { throw new AwkFatal('fatal: ' + m, { plain: true }); };
  while (n0-- > 0) {
    if (fmt[s1] !== '%') { s1++; continue; }
    out += fmt.slice(s0, s1);
    s0 = s1;
    let cur = 'fw';
    let fw = 0, prec = 0, argnum = 0;
    let havePrec = false, signchar = '', zeroFlag = false, quoteFlag = false;
    let lj = false, alt = false, bigFlag = false, bigbigFlag = false, smallFlag = false, magicPosix = false;
    let fill = ' ';
    let cs1;
    let arg;
    s1++;
    let done = false;
    const setCur = (v) => { if (cur === 'fw') fw = v; else if (cur === 'prec') prec = v; };
    const getCur = () => (cur === 'fw' ? fw : prec);
    const parseNextArg = () => {
      if (argnum > 0) {
        if (curArg > 1) fatalOut("must use `count$' on all formats or none");
        arg = args[argnum];
        return true;
      }
      if (usedDollar) fatalOut("must use `count$' on all formats or none");
      if (curArg >= numArgs) { toofew = true; return false; }
      arg = args[curArg++];
      return true;
    };
    // the retry loop: one character of the conversion specification per pass
    retry: for (;;) {
      if (n0-- === 0) { done = true; break; }
      cs1 = fmt[s1++];
      switch (cs1) {
        case '%':
          out += '%';
          s0 = s1;
          break retry;
        case '0':
          if (cur === 'fw') zeroFlag = true;
          if (lj) continue retry;
          // fall through
        case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9': {
          if (cur === null) break retry;
          if (prec >= 0) setCur(cs1.charCodeAt(0) - 48);
          while (n0 > 0 && fmt[s1] >= '0' && fmt[s1] <= '9') { --n0; setCur(getCur() * 10 + (fmt.charCodeAt(s1++) - 48)); }
          if (prec < 0) havePrec = false;
          if (cur === 'prec') cur = null;
          if (n0 === 0) { done = 'cont'; break retry; }
          continue retry;
        }
        case '$':
          if (opts.traditional) fatalOut("`$' is not permitted in awk formats");
          if (cur === 'fw') {
            argnum = fw;
            fw = 0;
            usedDollar = true;
            if (argnum <= 0) fatalOut("argument index with `$' must be > 0");
            if (argnum >= numArgs) fatalOut(`argument index ${argnum} greater than total number of supplied arguments`);
          } else fatalOut("`$' not permitted after period in format");
          continue retry;
        case '*': {
          if (cur === null) break retry;
          if (!opts.traditional && usedDollar && !isDigitC(fmt.charCodeAt(s1))) {
            throw new AwkFatal("fatal: must use `count$' on all formats or none");
          } else if (!opts.traditional && isDigitC(fmt.charCodeAt(s1))) {
            let val = 0;
            for (; n0 > 0 && isDigitC(fmt.charCodeAt(s1)); s1++, n0--) val = val * 10 + (fmt.charCodeAt(s1) - 48);
            if (fmt[s1] !== '$') fatalOut("no `$' supplied for positional field width or precision");
            s1++; n0--;
            if (val >= numArgs) { toofew = true; break retry; }
            arg = args[val];
          } else if (!parseNextArg()) break retry;
          let v = toLong(rt.num(arg));
          if (v < 0 && cur === 'fw') { v = -v; lj = true; }
          setCur(v);
          if (cur === 'prec') {
            havePrec = v >= 0;
            cur = null;
          }
          continue retry;
        }
        case ' ':
          if (signchar) { if (cur !== 'fw') break retry; continue retry; }
          // fall through
        case '+':
          signchar = cs1;
          if (cur !== 'fw') break retry;
          continue retry;
        case '-':
          if (prec < 0) break retry;
          if (cur === 'prec') { prec = -1; continue retry; }
          fill = ' ';
          lj = true;
          if (cur !== 'fw') break retry;
          continue retry;
        case '.':
          if (cur !== 'fw') break retry;
          cur = 'prec';
          havePrec = true;
          continue retry;
        case '#':
          alt = true;
          if (cur !== 'fw') break retry;
          continue retry;
        case "'":
          quoteFlag = true;
          if (cur !== 'fw') break retry;
          continue retry;
        case 'l':
          if (bigFlag) break retry;
          if (opts.posix) fatalOut("`l' is not permitted in POSIX awk formats");
          bigFlag = true;
          continue retry;
        case 'L':
          if (bigbigFlag) break retry;
          if (opts.posix) fatalOut("`L' is not permitted in POSIX awk formats");
          bigbigFlag = true;
          continue retry;
        case 'h':
          if (smallFlag) break retry;
          if (opts.posix) fatalOut("`h' is not permitted in POSIX awk formats");
          smallFlag = true;
          continue retry;
        case 'P':
          if (magicPosix) break retry;
          magicPosix = true;
          continue retry;
        case 'c': {
          if (!parseNextArg()) break retry;
          let ch;
          if (rt.isNumeric(arg)) ch = String.fromCharCode(Number(toUintmax(rt.num(arg)) & 255n));
          else { const s = rt.str(arg); ch = s.length ? s[0] : '\0'; }
          out += prTail(ch, 1, fw, lj, fill, havePrec);
          s0 = s1;
          break retry;
        }
        case 's': {
          if (!parseNextArg()) break retry;
          const s = rt.str(arg);
          let p;
          if (fw === 0 && !havePrec) p = s.length;
          else p = !havePrec || prec > s.length ? s.length : prec;
          out += prTail(s, p, fw, lj, fill, havePrec);
          s0 = s1;
          break retry;
        }
        case 'd': case 'i': {
          if (!parseNextArg()) break retry;
          const x = rt.num(arg);
          if (!Number.isFinite(x)) { const r = outOfRange(x, cs1); if (r !== null) { out += r; s0 = s1; break retry; } }
          let tmpval = doubleToInt(x);
          if (havePrec && prec === 0 && tmpval === 0) { out += prTail('', 0, fw, lj, fill, havePrec); s0 = s1; break retry; }
          let sgn = false;
          if (tmpval < 0) { tmpval = -tmpval; sgn = true; }
          let digits = BigInt(tmpval).toString();
          if (havePrec) while (digits.length < prec) digits = '0' + digits;
          if (sgn) digits = '-' + digits;
          else if (signchar) digits = signchar + digits;
          if (!lj && ((zeroFlag && !havePrec) || (fw === 0 && havePrec))) fill = '0';
          if (prec > fw) fw = prec;
          let p = digits.length;
          if (fw > p && !lj && fill !== ' ' && (digits[0] === '-' || signchar)) {
            out += digits[0];
            digits = digits.slice(1);
            p--; fw--;
          }
          out += prTail(digits, p, fw, lj, fill, true);
          s0 = s1;
          break retry;
        }
        case 'X': case 'x': case 'u': case 'o': {
          if (!parseNextArg()) break retry;
          const base = cs1 === 'o' ? 8 : cs1 === 'u' ? 10 : 16;
          const x = rt.num(arg);
          if (!Number.isFinite(x)) { const r = outOfRange(x, cs1); if (r !== null) { out += r; s0 = s1; break retry; } }
          const tmpval = x;
          if (!alt && havePrec && prec === 0 && tmpval === 0) { out += prTail('', 0, fw, lj, fill, havePrec); s0 = s1; break retry; }
          let uval;
          let bad = false;
          if (tmpval < 0) {
            const t = toLongBig(tmpval);
            uval = BigInt.asUintN(64, t);
            if (Number(t) !== doubleToInt(tmpval)) bad = true;
          } else {
            uval = toUintmax(tmpval);
            if (Number(uval) !== doubleToInt(tmpval)) bad = true;
          }
          if (bad) {
            // emergency %g
            let c = cs1;
            if (!'aAeEfFgG'.includes(c)) c = 'g';
            out += cFloat(tmpval, c, { lj, sign: signchar, alt, zero: zeroFlag, fw, prec: havePrec ? prec : 6 });
            s0 = s1;
            break retry;
          }
          if (!lj && ((zeroFlag && !havePrec) || (fw === 0 && havePrec))) fill = '0';
          let digits = uval.toString(base);
          if (cs1 === 'X') digits = digits.toUpperCase();
          if (havePrec) while (digits.length < prec) digits = '0' + digits;
          if (alt && tmpval !== 0) {
            if (base === 16) {
              digits = '0' + cs1 + digits;
              if (fill !== ' ') { out += digits.slice(0, 2); digits = digits.slice(2); fw -= 2; }
            } else if (base === 8) digits = '0' + digits;
          }
          if (prec > fw) fw = prec;
          out += prTail(digits, digits.length, fw, lj, fill, true);
          s0 = s1;
          break retry;
        }
        case 'F': case 'g': case 'G': case 'e': case 'f': case 'E': case 'A': case 'a': {
          if (!parseNextArg()) break retry;
          const x = rt.num(arg);
          if (!Number.isFinite(x)) {
            const r = outOfRange(x, cs1);
            if (r !== null) { out += r; s0 = s1; break retry; }
          }
          out += cFloat(x, cs1, { lj, sign: signchar, alt, zero: zeroFlag, fw, prec: havePrec ? prec : 6, havePrec: havePrec || (cs1 !== 'a' && cs1 !== 'A') });
          s0 = s1;
          break retry;
        }
        default:
          break retry;
      }
    }
    if (toofew) {
      throw new AwkFatal(`fatal: not enough arguments to satisfy format string\n\t\`${fmt}'\n\t${' '.repeat(Math.max(0, s1 - 1))}^ ran out for this one`, { plain: true });
    }
    if (done === true) break;
    void quoteFlag; void magicPosix;
  }
  out += fmt.slice(s0, s1);
  return out;

  function outOfRange(x, conv) {
    if (opts.posix) return null;
    return formatNanInf(x, conv);
  }
}

// pr_tail: pad (fill) to fw and copy the first `prec` characters of s
function prTail(s, prec, fw, lj, fill, havePrec) {
  let out = '';
  if (!lj) while (fw > prec) { out += fill; fw--; }
  out += s.slice(0, prec);
  while (fw > prec) { out += fill; fw--; }
  void havePrec;
  return out;
}

// ---------------------------------------------------------------- gawk's random() (BSD, TYPE_4 + shuffle)
export class GawkRandom {
  constructor() {
    this.deg = 63; this.sep = 1;
    this.state = new Uint32Array(63);
    this.fptr = 1; this.rptr = 0;
    this.shuffleInit = true;
    this.shuffle = new Array(512).fill(0);
    this.s = 0xcafefeed;
    this.first = true;
    this.saveSeed = 1;
  }
  static goodRand(x) {
    x |= 0;
    if (x === 0) x = 123459876;
    const hi = (x / 127773) | 0;
    const lo = x % 127773;
    x = 16807 * lo - 2836 * hi;
    if (x < 0) x += 0x7fffffff;
    return x >>> 0;
  }
  srandom(x) {
    this.shuffleInit = true;
    this.state[0] = x >>> 0;
    for (let i = 1; i < this.deg; i++) this.state[i] = GawkRandom.goodRand(this.state[i - 1]);
    this.fptr = this.sep;
    this.rptr = 0;
    for (let i = 0; i < 10 * this.deg; i++) this.random();
  }
  randomOld() {
    let f = this.fptr, r = this.rptr;
    const st = this.state;
    st[f] = (st[f] + st[r]) >>> 0;
    const i = (st[f] >>> 1) & 0x7fffffff;
    if (++f >= this.deg) { f = 0; ++r; } else if (++r >= this.deg) r = 0;
    this.fptr = f; this.rptr = r;
    return i;
  }
  random() {
    if (this.shuffleInit) {
      for (let k = 0; k < 512; k++) this.shuffle[k] = this.randomOld();
      this.s = this.randomOld();
      this.shuffleInit = false;
    }
    const r = this.randomOld();
    const k = this.s & 511;
    this.s = this.shuffle[k];
    this.shuffle[k] = r;
    return this.s;
  }
  init() { if (this.first) { this.first = false; this.srandom(1); } }
  rand() {
    this.init();
    let t;
    do {
      const d1 = this.random(), d2 = this.random();
      t = 0.5 + ((d1 / 2147483648 + d2) / 2147483648);
      t -= 0.5;
    } while (t === 1.0);
    return t;
  }
  srand(seed) {   // seed: a number, or undefined for the time of day
    const ret = this.saveSeed;
    this.init();
    const s = seed === undefined ? Math.floor(Date.now() / 1000) : toLong(seed);
    this.saveSeed = s;
    this.srandom(Number(BigInt.asUintN(32, BigInt(s))));
    return ret;
  }
}
