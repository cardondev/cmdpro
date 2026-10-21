// C printf-compatible formatting with exact (glibc-like, round-half-even) rounding.
// A float is a JS number (C double) or a long double value from ldouble.js.
import { ldIsLd, ldRational, ldLog10Est, ldHex } from './ldouble.js';

const absOf = (x) => (ldIsLd(x) ? x : Math.abs(x));
const isZero = (x) => (ldIsLd(x) ? x.m === 0n : x === 0);

function exactRational(x) {
  // x finite, non-negative double (or a long double) -> [num, den] BigInt with x = num/den
  if (ldIsLd(x)) return ldRational(x);
  if (x === 0) return [0n, 1n];
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (expBits === 0) e = -1074; else { mant |= 1n << 52n; e = expBits - 1075; }
  if (e >= 0) return [mant << BigInt(e), 1n];
  return [mant, 1n << BigInt(-e)];
}

function roundDiv(num, den) {
  // round-half-even of num/den, num>=0, den>0
  const q = num / den, r = num - q * den;
  const twice = r * 2n;
  if (twice > den || (twice === den && (q & 1n))) return q + 1n;
  return q;
}

const P10 = [];
function pow10(n) { if (n < 0) throw new Error('neg'); if (n < 400) return P10[n] ||= 10n ** BigInt(n); return 10n ** BigInt(n); }

export function fixedDigits(x, prec) {
  // |x| formatted with prec decimals, no sign
  const [num, den] = exactRational(absOf(x));
  const q = roundDiv(num * pow10(prec), den);
  let s = q.toString();
  if (prec === 0) return s;
  if (s.length <= prec) s = '0'.repeat(prec - s.length + 1) + s;
  return s.slice(0, s.length - prec) + '.' + s.slice(s.length - prec);
}

export function expParts(x, prec) {
  // returns { digits (string of prec+1 digits), exp } for |x|
  const ax = absOf(x);
  if (isZero(ax)) return { digits: '0'.repeat(prec + 1), exp: 0 };
  const [num, den] = exactRational(ax);
  let X = ldIsLd(ax) ? ldLog10Est(ax) : Math.floor(Math.log10(ax));
  for (let iter = 0; iter < 6; iter++) {
    const shift = prec - X;
    const q = shift >= 0 ? roundDiv(num * pow10(shift), den) : roundDiv(num, den * pow10(-shift));
    const s = q.toString();
    if (s.length > prec + 1) { X++; continue; }
    if (s.length < prec + 1) { X--; continue; }
    return { digits: s, exp: X };
  }
  const s = ax.toExponential(prec);
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  return { digits: m[1] + (m[2] || ''), exp: parseInt(m[3], 10) };
}

export function fmtE(x, prec, upper = false, alt = false) {
  const { digits, exp } = expParts(x, prec);
  let s = digits[0] + (prec > 0 || alt ? '.' : '') + digits.slice(1);
  const es = Math.abs(exp) < 10 ? '0' + Math.abs(exp) : String(Math.abs(exp));
  s += (upper ? 'E' : 'e') + (exp < 0 ? '-' : '+') + es;
  return s;
}

export function fmtG(x, prec, upper = false, alt = false) {
  let P = prec === 0 ? 1 : prec;
  const ax = absOf(x);
  let X;
  if (isZero(ax)) X = 0;
  else X = expParts(ax, P - 1).exp;
  let s;
  if (P > X && X >= -4) {
    s = fixedDigits(ax, P - 1 - X);
    if (alt && !s.includes('.')) s += '.';
  } else {
    s = fmtE(ax, P - 1, upper, alt);
  }
  if (!alt) {
    // strip trailing zeros in the fraction
    if (s.includes('e') || s.includes('E')) {
      const k = s.search(/[eE]/);
      let mant = s.slice(0, k), ex = s.slice(k);
      if (mant.includes('.')) mant = mant.replace(/0+$/, '').replace(/\.$/, '');
      s = mant + ex;
    } else if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
}

function special(x, upper) {
  if (Number.isNaN(x)) return upper ? 'NAN' : 'nan';
  if (!Number.isFinite(x)) return (x < 0 ? '-' : '') + (upper ? 'INF' : 'inf');
  return null;
}

function pad(s, width, left, zero, signLen = 0) {
  if (width === undefined || s.length >= width) return s;
  if (left) return s + ' '.repeat(width - s.length);
  if (zero) return s.slice(0, signLen) + '0'.repeat(width - s.length) + s.slice(signLen);
  return ' '.repeat(width - s.length) + s;
}

// Format one conversion. spec: { flags: string, width, prec, conv }
// value: number | bigint | string
export function formatOne(spec, value) {
  const { flags = '', conv } = spec;
  let width = spec.width, prec = spec.prec;
  const left = flags.includes('-');
  if (width !== undefined && width < 0) { width = -width; }
  const leftAdj = left || (spec.width !== undefined && spec.width < 0);
  const plus = flags.includes('+'), space = flags.includes(' '), alt = flags.includes('#');
  let zero = flags.includes('0') && !leftAdj;
  switch (conv) {
    case 'd': case 'i': case 'u': case 'o': case 'x': case 'X': {
      let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0));
      let neg = v < 0n;
      if (conv === 'u' || conv === 'o' || conv === 'x' || conv === 'X') { if (neg) { v = BigInt.asUintN(64, v); neg = false; } }
      let digits = (neg ? -v : v).toString(conv === 'o' ? 8 : conv === 'x' || conv === 'X' ? 16 : 10);
      if (conv === 'X') digits = digits.toUpperCase();
      if (prec !== undefined) { zero = false; if (prec === 0 && v === 0n) digits = ''; while (digits.length < prec) digits = '0' + digits; }
      let prefix = '';
      if (neg) prefix = '-'; else if (plus && (conv === 'd' || conv === 'i')) prefix = '+'; else if (space && (conv === 'd' || conv === 'i')) prefix = ' ';
      if (alt && conv === 'o' && !digits.startsWith('0')) digits = '0' + digits;
      if (alt && (conv === 'x' || conv === 'X') && v !== 0n) prefix += conv === 'x' ? '0x' : '0X';
      return pad(prefix + digits, width, leftAdj, zero, prefix.length);
    }
    case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': case 'a': case 'A': {
      if (ldIsLd(value)) return formatLd(conv, value, prec, width, leftAdj, zero, plus, space, alt);
      const x = typeof value === 'number' ? value : Number(value);
      const sp = special(x, conv === 'F' || conv === 'E' || conv === 'G' || conv === 'A');
      const neg = x < 0 || Object.is(x, -0);
      let body;
      if (sp) { body = sp.replace('-', ''); zero = false; }
      else {
        const p = prec === undefined ? 6 : prec;
        if (conv === 'f' || conv === 'F') { body = fixedDigits(x, p); if (alt && p === 0) body += '.'; }
        else if (conv === 'e' || conv === 'E' || conv === 'a' || conv === 'A') body = fmtE(Math.abs(x), p, conv === 'E' || conv === 'A', alt);
        else body = fmtG(Math.abs(x), p, conv === 'G', alt);
      }
      let prefix = neg ? '-' : plus ? '+' : space ? ' ' : '';
      if (sp && Number.isNaN(x)) prefix = plus ? '+' : space ? ' ' : '';
      return pad(prefix + body, width, leftAdj, zero, prefix.length);
    }
    case 'c': {
      const s = typeof value === 'number' ? String.fromCharCode(value & 255) : String(value).slice(0, 1);
      return pad(s, width, leftAdj, false);
    }
    case 's': default: {
      let s = String(value);
      if (prec !== undefined) s = s.slice(0, prec);
      return pad(s, width, leftAdj, false);
    }
  }
}

// a float conversion of a long double, as glibc prints it (%Lf and friends)
function formatLd(conv, v, prec, width, left, zero, plus, space, alt) {
  const upper = conv === 'F' || conv === 'E' || conv === 'G' || conv === 'A';
  const prefix = v.neg ? '-' : plus ? '+' : space ? ' ' : '';
  if (v.kind !== 'num') {
    const body = v.kind === 'inf' ? 'inf' : 'nan';
    return pad(prefix + (upper ? body.toUpperCase() : body), width, left, false);
  }
  if (conv === 'a' || conv === 'A') return pad(prefix + ldHex(v, prec, upper, alt), width, left, zero, prefix.length + 2);
  const p = prec === undefined ? 6 : prec;
  let body;
  if (conv === 'f' || conv === 'F') { body = fixedDigits(v, p); if (alt && p === 0) body += '.'; }
  else if (conv === 'e' || conv === 'E') body = fmtE(v, p, upper, alt);
  else body = fmtG(v, p, upper, alt);
  return pad(prefix + body, width, left, zero, prefix.length);
}

// %.6g style number-to-string used by awk OFMT/CONVFMT.
export function fmtNumberG(x, prec = 6) {
  const sp = special(x, false);
  if (sp) return sp === 'nan' ? (Object.is(x, NaN) ? 'nan' : 'nan') : sp;
  return (x < 0 ? '-' : '') + fmtG(Math.abs(x), prec, false, false);
}
