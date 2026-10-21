// x86-64 `long double`: the x87 80-bit extended format, a 64-bit significand with an explicit
// integer bit and a 15-bit exponent. GNU printf, bash's printf builtin and seq compute in it, and it
// shows in their output (printf '%.3f' 1.0005 prints 1.001, printf '%a' 1 prints 0x8p-3), so it is
// emulated exactly here. A value is { kind: 'num' | 'inf' | 'nan', neg, m, e }; a 'num' is m·2^e,
// where m is a BigInt below 2^64 (at least 2^63 unless the value is subnormal or zero).
// Results of rounding also carry `range`: strtold's ERANGE (overflow, or an inexact subnormal).

const P = 64;
const TWO63 = 1n << 63n, TWO64 = 1n << 64n;
const EMIN = -16445;               // the smallest subnormal is 1·2^-16445; normals reach down to 2^63·2^-16445
const EMAX = 16383 - 63;           // the largest finite value is (2^64 - 1)·2^16320
const bitlen = (n) => (n === 0n ? 0 : n.toString(2).length);

export const ldZero = (neg = false) => ({ kind: 'num', neg, m: 0n, e: 0 });
export const ldInf = (neg = false) => ({ kind: 'inf', neg });
export const ldNan = (neg = false) => ({ kind: 'nan', neg });
export const ldIsLd = (v) => v !== null && typeof v === 'object' && 'kind' in v;

// round neg·M·2^E (M >= 0 exact) to the nearest long double, ties to even
function roundME(neg, M, E) {
  if (M === 0n) return ldZero(neg);
  let sh = bitlen(M) - P;
  if (E + sh < EMIN) sh = EMIN - E;
  let m = M, e = E, inexact = false;
  if (sh > 0) {
    const B = BigInt(sh);
    m = M >> B;
    const rem = M & ((1n << B) - 1n), half = 1n << (B - 1n);
    inexact = rem !== 0n;
    if (rem > half || (rem === half && (m & 1n))) m += 1n;
    e = E + sh;
    if (m === TWO64) { m = TWO63; e++; }
  } else if (sh < 0) { m = M << BigInt(-sh); e = E + sh; }
  if (e > EMAX) return { kind: 'inf', neg, range: true };
  if (m === 0n) return { ...ldZero(neg), range: true };
  return { kind: 'num', neg, m, e, range: inexact && m < TWO63 };
}

// round neg·num/den (num, den > 0) to the nearest long double: enough quotient bits plus a
// sticky bit for any remainder, then roundME
function roundRat(neg, num, den) {
  const k = Math.max(0, P + 3 + bitlen(den) - bitlen(num));
  const n = num << BigInt(k);
  const q = n / den;
  return roundME(neg, (q << 1n) | (n % den ? 1n : 0n), -k - 1);
}

export const ldFromInt = (n) => (n < 0n ? roundME(true, -n, 0) : roundME(false, n, 0));

// glibc strtold in the C locale. Returns { v, end }; end is 0 when nothing converts (v is then 0)
export function strtold(s) {
  let i = 0;
  while (i < s.length && ' \t\n\v\f\r'.includes(s[i])) i++;
  let neg = false;
  if (s[i] === '+' || s[i] === '-') { neg = s[i] === '-'; i++; }
  const rest = s.slice(i);
  let m;
  if ((m = /^inf(inity)?/i.exec(rest))) return { v: ldInf(neg), end: i + m[0].length };
  if ((m = /^nan(\([A-Za-z0-9_]*\))?/i.exec(rest))) return { v: ldNan(neg), end: i + m[0].length };
  const expOf = (t) => (t.length > 9 ? (t[0] === '-' ? -1e9 : 1e9) : Number(t));
  if ((m = /^0[xX](?:([0-9a-fA-F]+)(?:\.([0-9a-fA-F]*))?|\.([0-9a-fA-F]+))/.exec(rest))) {
    const int = m[3] === undefined ? m[1] : '', frac = m[3] === undefined ? m[2] || '' : m[3];
    let len = m[0].length, pe = 0;
    const x = /^[pP]([+-]?)0*(\d+)/.exec(rest.slice(len));
    if (x) { pe = expOf(x[1] + x[2]); len += x[0].length; }
    const H = BigInt('0x' + ((int + frac).replace(/^0+/, '') || '0'));
    const E = pe - 4 * frac.length, mag = bitlen(H) + E;           // H·2^E < 2^mag
    let v;
    if (H === 0n) v = ldZero(neg);
    else if (mag > 16385) v = { ...ldInf(neg), range: true };
    else if (mag < EMIN - 1) v = { ...ldZero(neg), range: true };
    else v = roundME(neg, H, E);
    return { v, end: i + len };
  }
  if ((m = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))/.exec(rest))) {
    const int = m[3] === undefined ? m[1] : '', frac = m[3] === undefined ? m[2] || '' : m[3];
    let len = m[0].length, X = 0;
    const x = /^[eE]([+-]?)0*(\d+)/.exec(rest.slice(len));
    if (x) { X = expOf(x[1] + x[2]); len += x[0].length; }
    const digits = (int + frac).replace(/^0+/, '');
    const E = X - frac.length, mag = digits.length + E;              // value < 10^mag
    let v;
    if (!digits) v = ldZero(neg);
    else if (mag > 4934) v = { ...ldInf(neg), range: true };
    else if (mag < -4952) v = { ...ldZero(neg), range: true };
    else if (E >= 0) v = roundME(neg, BigInt(digits) * 10n ** BigInt(E), 0);
    else v = roundRat(neg, BigInt(digits), 10n ** BigInt(-E));
    return { v, end: i + len };
  }
  return { v: ldZero(false), end: 0 };
}

const signedM = (a, e) => { const v = a.m << BigInt(a.e - e); return a.neg ? -v : v; };

export function ldAdd(a, b) {
  if (a.kind === 'nan') return a;
  if (b.kind === 'nan') return b;
  if (a.kind === 'inf') return b.kind === 'inf' && b.neg !== a.neg ? ldNan(true) : a;
  if (b.kind === 'inf') return b;
  if (a.m === 0n && b.m === 0n) return ldZero(a.neg && b.neg);
  if (a.m === 0n) return b;
  if (b.m === 0n) return a;
  const e = Math.min(a.e, b.e);
  const s = signedM(a, e) + signedM(b, e);
  return s === 0n ? ldZero(false) : roundME(s < 0n, s < 0n ? -s : s, e);
}

export function ldMul(a, b) {
  const neg = a.neg !== b.neg;
  if (a.kind === 'nan') return a;
  if (b.kind === 'nan') return b;
  if (a.kind === 'inf' || b.kind === 'inf') return (a.kind === 'num' && a.m === 0n) || (b.kind === 'num' && b.m === 0n) ? ldNan(true) : ldInf(neg);
  return roundME(neg, a.m * b.m, a.e + b.e);
}

// -1, 0 or 1; NaN when either is a NaN (every C comparison with it is false)
export function ldCmp(a, b) {
  if (a.kind === 'nan' || b.kind === 'nan') return NaN;
  const rank = (v) => (v.kind === 'inf' ? (v.neg ? -2 : 2) : v.m === 0n ? 0 : v.neg ? -1 : 1);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb || Math.abs(ra) !== 1) return ra < rb ? -1 : ra > rb ? 1 : 0;
  const e = Math.min(a.e, b.e);
  const x = signedM(a, e), y = signedM(b, e);
  return x < y ? -1 : x > y ? 1 : 0;
}

// conversion to an integer type: truncation toward zero
export function ldTrunc(v) {
  const t = v.e >= 0 ? v.m << BigInt(v.e) : v.m >> BigInt(-v.e);
  return v.neg ? -t : t;
}

// |v| as an exact fraction [num, den]
export const ldRational = (v) => (v.e >= 0 ? [v.m << BigInt(v.e), 1n] : [v.m, 1n << BigInt(-v.e)]);

// floor(log10(|v|)) give or take one, for v != 0
export const ldLog10Est = (v) => Math.floor((bitlen(v.m) - 1 + v.e) * Math.LOG10E * Math.LN2);

// glibc's %La digits for x86-64 (sysdeps/ieee754/ldbl-96/printf_fphex.c): the whole 64-bit
// significand in hex, so the leading digit holds four bits (1 is 0x8p-3). Returns the text
// after the sign: 0x<lead>[.<digits>]p<exp>
export function ldHex(v, prec, upper, alt) {
  let digits = '', lead = '0', exp = 0;
  if (v.m !== 0n) {
    const hex = v.m.toString(16).padStart(16, '0');
    lead = hex[0];
    digits = hex.slice(1).replace(/0+$/, '');
    // the biased exponent of an x87 value; subnormals are printed with exponent -16385
    const biased = v.m >= TWO63 ? v.e + 63 + 16383 : 0;
    exp = biased ? biased - (16383 + 3) : -16385;
    if (prec !== undefined && prec < digits.length) {
      const val = (c) => parseInt(c, 16);
      const last = prec > 0 ? val(digits[prec - 1]) : val(lead), next = val(digits[prec]);
      const more = (next & 7) !== 0 || prec + 1 < digits.length;
      // round to nearest, ties to even
      const up = next >= 8 && (more || (last & 1));
      let d = digits.slice(0, prec).split('');
      if (up) {
        let k = prec - 1;
        for (; k >= 0; k--) {
          if (d[k] === 'f') { d[k] = '0'; continue; }
          d[k] = (val(d[k]) + 1).toString(16);
          break;
        }
        if (k < 0) {
          if (lead !== 'f') lead = (val(lead) + 1).toString(16);
          else { lead = '1'; exp += 4; }
        }
      }
      digits = d.join('');
    }
  }
  if (prec !== undefined && prec > digits.length) digits = digits.padEnd(prec, '0');
  const s = '0x' + lead + (digits || alt ? '.' : '') + digits + 'p' + (exp < 0 ? '-' : '+') + Math.abs(exp);
  return upper ? s.toUpperCase() : s;
}
