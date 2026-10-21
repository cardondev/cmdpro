// The libm functions jq 1.6 exposes (libm.h), with C (glibc) semantics for the special cases.
// erf/erfc and lgamma follow fdlibm (as glibc's dbl-64 code does):
//   Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//   Developed at SunSoft, a Sun Microsystems, Inc. business. Permission to use, copy, modify, and
//   distribute this software is freely granted, provided that this notice is preserved.
// The Bessel functions and tgamma are numerically equivalent approximations, not bit-exact ports.

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const HI = (x) => { f64[0] = x; return u32[1] | 0; };
const LO = (x) => { f64[0] = x; return u32[0] | 0; };
const withLo0 = (x) => { f64[0] = x; u32[0] = 0; return f64[0]; };

const tiny = 1e-300;
const erx = 8.45062911510467529297e-01, efx = 1.28379167095512586316e-01, efx8 = 1.02703333676410069053e+00;
const pp0 = 1.28379167095512558561e-01, pp1 = -3.25042107247001499370e-01, pp2 = -2.84817495755985104766e-02,
  pp3 = -5.77027029648944159157e-03, pp4 = -2.37630166566501626084e-05, qq1 = 3.97917223959155352819e-01,
  qq2 = 6.50222499887672944485e-02, qq3 = 5.08130628187576562776e-03, qq4 = 1.32494738004321644526e-04,
  qq5 = -3.96022827877536812320e-06;
const pa0 = -2.36211856075265944077e-03, pa1 = 4.14856118683748331666e-01, pa2 = -3.72207876035701323847e-01,
  pa3 = 3.18346619901161753674e-01, pa4 = -1.10894694282396677476e-01, pa5 = 3.54783043256182359371e-02,
  pa6 = -2.16637559486879084300e-03, qa1 = 1.06420880400844228286e-01, qa2 = 5.40397917702171048937e-01,
  qa3 = 7.18286544141962662868e-02, qa4 = 1.26171219808761642112e-01, qa5 = 1.36370839120290507362e-02,
  qa6 = 1.19844998467991074170e-02;
const ra0 = -9.86494403484714822705e-03, ra1 = -6.93858572707181764372e-01, ra2 = -1.05586262253232909814e+01,
  ra3 = -6.23753324503260060396e+01, ra4 = -1.62396669462573470355e+02, ra5 = -1.84605092906711035994e+02,
  ra6 = -8.12874355063065934246e+01, ra7 = -9.81432934416914548592e+00, sa1 = 1.96512716674392571292e+01,
  sa2 = 1.37657754143519042600e+02, sa3 = 4.34565877475229228821e+02, sa4 = 6.45387271733267880336e+02,
  sa5 = 4.29008140027567833386e+02, sa6 = 1.08635005541779435134e+02, sa7 = 6.57024977031928170135e+00,
  sa8 = -6.04244152148580987438e-02;
const rb0 = -9.86494292470009928597e-03, rb1 = -7.99283237680523006574e-01, rb2 = -1.77579549177547519889e+01,
  rb3 = -1.60636384855821916062e+02, rb4 = -6.37566443368389627722e+02, rb5 = -1.02509513161107724954e+03,
  rb6 = -4.83519191608651397019e+02, sb1 = 3.03380607434824582924e+01, sb2 = 3.25792512996573918826e+02,
  sb3 = 1.53672958608443695994e+03, sb4 = 3.19985821950859553908e+03, sb5 = 2.55305040643316442583e+03,
  sb6 = 4.74528541206955367215e+02, sb7 = -2.24409524465858183362e+01;

function erf(x) {
  const hx = HI(x), ix = hx & 0x7fffffff;
  if (ix >= 0x7ff00000) { const i = (hx >>> 31) << 1; return (1 - i) + 1 / x; }
  if (ix < 0x3feb0000) {
    if (ix < 0x3e300000) {
      if (ix < 0x00800000) return 0.125 * (8.0 * x + efx8 * x);
      return x + efx * x;
    }
    const z = x * x;
    const r = pp0 + z * (pp1 + z * (pp2 + z * (pp3 + z * pp4)));
    const s = 1 + z * (qq1 + z * (qq2 + z * (qq3 + z * (qq4 + z * qq5))));
    return x + x * (r / s);
  }
  if (ix < 0x3ff40000) {
    const s = Math.abs(x) - 1;
    const P = pa0 + s * (pa1 + s * (pa2 + s * (pa3 + s * (pa4 + s * (pa5 + s * pa6)))));
    const Q = 1 + s * (qa1 + s * (qa2 + s * (qa3 + s * (qa4 + s * (qa5 + s * qa6)))));
    return hx >= 0 ? erx + P / Q : -erx - P / Q;
  }
  if (ix >= 0x40180000) return hx >= 0 ? 1 - tiny : tiny - 1;
  x = Math.abs(x);
  const s = 1 / (x * x);
  let R, S;
  if (ix < 0x4006DB6E) {
    R = ra0 + s * (ra1 + s * (ra2 + s * (ra3 + s * (ra4 + s * (ra5 + s * (ra6 + s * ra7))))));
    S = 1 + s * (sa1 + s * (sa2 + s * (sa3 + s * (sa4 + s * (sa5 + s * (sa6 + s * (sa7 + s * sa8)))))));
  } else {
    R = rb0 + s * (rb1 + s * (rb2 + s * (rb3 + s * (rb4 + s * (rb5 + s * rb6)))));
    S = 1 + s * (sb1 + s * (sb2 + s * (sb3 + s * (sb4 + s * (sb5 + s * (sb6 + s * sb7))))));
  }
  const z = withLo0(x);
  const r = Math.exp(-z * z - 0.5625) * Math.exp((z - x) * (z + x) + R / S);
  return hx >= 0 ? 1 - r / x : r / x - 1;
}

function erfc(x) {
  const hx = HI(x), ix = hx & 0x7fffffff;
  if (ix >= 0x7ff00000) return ((hx >>> 31) << 1) + 1 / x;
  if (ix < 0x3feb0000) {
    if (ix < 0x3c700000) return 1 - x;
    const z = x * x;
    const r = pp0 + z * (pp1 + z * (pp2 + z * (pp3 + z * pp4)));
    const s = 1 + z * (qq1 + z * (qq2 + z * (qq3 + z * (qq4 + z * qq5))));
    const y = r / s;
    if (hx < 0x3fd00000) return 1 - (x + x * y);
    let rr = x * y;
    rr += x - 0.5;
    return 0.5 - rr;
  }
  if (ix < 0x3ff40000) {
    const s = Math.abs(x) - 1;
    const P = pa0 + s * (pa1 + s * (pa2 + s * (pa3 + s * (pa4 + s * (pa5 + s * pa6)))));
    const Q = 1 + s * (qa1 + s * (qa2 + s * (qa3 + s * (qa4 + s * (qa5 + s * qa6)))));
    if (hx >= 0) return (1 - erx) - P / Q;
    return 1 + (erx + P / Q);
  }
  if (ix < 0x403c0000) {
    x = Math.abs(x);
    const s = 1 / (x * x);
    let R, S;
    if (ix < 0x4006DB6D) {
      R = ra0 + s * (ra1 + s * (ra2 + s * (ra3 + s * (ra4 + s * (ra5 + s * (ra6 + s * ra7))))));
      S = 1 + s * (sa1 + s * (sa2 + s * (sa3 + s * (sa4 + s * (sa5 + s * (sa6 + s * (sa7 + s * sa8)))))));
    } else {
      if (hx < 0 && ix >= 0x40180000) return 2 - tiny;
      R = rb0 + s * (rb1 + s * (rb2 + s * (rb3 + s * (rb4 + s * (rb5 + s * rb6)))));
      S = 1 + s * (sb1 + s * (sb2 + s * (sb3 + s * (sb4 + s * (sb5 + s * (sb6 + s * sb7))))));
    }
    const z = withLo0(x);
    const r = Math.exp(-z * z - 0.5625) * Math.exp((z - x) * (z + x) + R / S);
    return hx > 0 ? r / x : 2 - r / x;
  }
  return hx > 0 ? tiny * tiny : 2 - tiny;
}

// ---- lgamma_r (fdlibm e_lgamma_r.c)
const two52 = 4.50359962737049600000e+15, PI = 3.14159265358979311600e+00;
const a0 = 7.72156649015328655494e-02, a1 = 3.22467033424113591611e-01, a2 = 6.73523010531292681824e-02,
  a3 = 2.05808084325167332806e-02, a4 = 7.38555086081402883957e-03, a5 = 2.89051383673415629091e-03,
  a6 = 1.19270763183362067845e-03, a7 = 5.10069792153511336608e-04, a8 = 2.20862790713908385557e-04,
  a9 = 1.08011567247583939954e-04, a10 = 2.52144565451257326939e-05, a11 = 4.48640949618915160150e-05;
const tc = 1.46163214496836224576e+00, tf = -1.21486290535849611461e-01, tt = -3.63867699703950536541e-18;
const t0 = 4.83836122723810047042e-01, t1 = -1.47587722994593911752e-01, t2 = 6.46249402391333854778e-02,
  t3 = -3.27885410759859649565e-02, t4 = 1.79706750811820387126e-02, t5 = -1.03142241298341437450e-02,
  t6 = 6.10053870246291332635e-03, t7 = -3.68452016781138256760e-03, t8 = 2.25964780900612472250e-03,
  t9 = -1.40346469989232843813e-03, t10 = 8.81081882437654011382e-04, t11 = -5.38595305356740546715e-04,
  t12 = 3.15632070903625950361e-04, t13 = -3.12754168375120860518e-04, t14 = 3.35529192635519073543e-04;
const u0 = -7.72156649015328655494e-02, u1 = 6.32827064025093366517e-01, u2 = 1.45492250137234768737e+00,
  u3 = 9.77717527963372745603e-01, u4 = 2.28963728064692451092e-01, u5 = 1.33810918536787660377e-02,
  v1 = 2.45597793713041134822e+00, v2 = 2.12848976379893395361e+00, v3 = 7.69285150456672783825e-01,
  v4 = 1.04222645593369134254e-01, v5 = 3.21709242282423911810e-03;
const s0 = -7.72156649015328655494e-02, s1 = 2.14982415960608852501e-01, s2 = 3.25778796408930981787e-01,
  s3 = 1.46350472652464452805e-01, s4 = 2.66422703033638609560e-02, s5 = 1.84028451407337715652e-03,
  s6 = 3.19475326584100867617e-05, r1 = 1.39200533467621045958e+00, r2 = 7.21935547567138069525e-01,
  r3 = 1.71933865632803078993e-01, r4 = 1.86459191715652901344e-02, r5 = 7.77942496381893596434e-04,
  r6 = 7.32668430744625636189e-06;
const w0 = 4.18938533204672725052e-01, w1 = 8.33333333333329678849e-02, w2 = -2.77777777728775536470e-03,
  w3 = 7.93650558643019558500e-04, w4 = -5.95187557450339963135e-04, w5 = 8.36339918996282139126e-04,
  w6 = -1.63092934096575273989e-03;

function sinPi(x) {
  const ix = 0x7fffffff & HI(x);
  if (ix < 0x3fd00000) return Math.sin(PI * x);
  let y = -x;
  let z = Math.floor(y);
  let n;
  if (z !== y) {
    y *= 0.5;
    y = 2.0 * (y - Math.floor(y));
    n = Math.trunc(y * 4.0);
  } else {
    if (ix >= 0x43400000) { y = 0; n = 0; }
    else {
      if (ix < 0x43300000) z = y + two52;
      n = LO(z) & 1;
      y = n;
      n <<= 2;
    }
  }
  switch (n) {
    case 0: y = Math.sin(PI * y); break;
    case 1: case 2: y = Math.cos(PI * (0.5 - y)); break;
    case 3: case 4: y = Math.sin(PI * (1 - y)); break;
    case 5: case 6: y = -Math.cos(PI * (y - 1.5)); break;
    default: y = Math.sin(PI * (y - 2.0)); break;
  }
  return -y;
}

function lgammaR(x) {
  const hx = HI(x), lx = LO(x);
  let sign = 1;
  const ix = hx & 0x7fffffff;
  if (ix >= 0x7ff00000) return [x * x, sign];
  if ((ix | lx) === 0) return [1 / 0, hx < 0 ? -1 : 1];
  if (ix < 0x3b900000) {
    if (hx < 0) return [-Math.log(-x), -1];
    return [-Math.log(x), 1];
  }
  let nadj = 0;
  if (hx < 0) {
    if (ix >= 0x43300000) return [1 / 0, sign];
    const t = sinPi(x);
    if (t === 0) return [1 / 0, sign];
    nadj = Math.log(PI / Math.abs(t * x));
    if (t < 0) sign = -1;
    x = -x;
  }
  let r, y, i, z, p, p1, p2, p3, q, w, t;
  if ((((ix - 0x3ff00000) | lx) === 0) || (((ix - 0x40000000) | lx) === 0)) r = 0;
  else if (ix < 0x40000000) {
    if (ix <= 0x3feccccc) {
      r = -Math.log(x);
      if (ix >= 0x3FE76944) { y = 1 - x; i = 0; }
      else if (ix >= 0x3FCDA661) { y = x - (tc - 1); i = 1; }
      else { y = x; i = 2; }
    } else {
      r = 0;
      if (ix >= 0x3FFBB4C3) { y = 2.0 - x; i = 0; }
      else if (ix >= 0x3FF3B4C4) { y = x - tc; i = 1; }
      else { y = x - 1; i = 2; }
    }
    switch (i) {
      case 0:
        z = y * y;
        p1 = a0 + z * (a2 + z * (a4 + z * (a6 + z * (a8 + z * a10))));
        p2 = z * (a1 + z * (a3 + z * (a5 + z * (a7 + z * (a9 + z * a11)))));
        p = y * p1 + p2;
        r += (p - 0.5 * y);
        break;
      case 1:
        z = y * y;
        w = z * y;
        p1 = t0 + w * (t3 + w * (t6 + w * (t9 + w * t12)));
        p2 = t1 + w * (t4 + w * (t7 + w * (t10 + w * t13)));
        p3 = t2 + w * (t5 + w * (t8 + w * (t11 + w * t14)));
        p = z * p1 - (tt - w * (p2 + y * p3));
        r += (tf + p);
        break;
      case 2:
        p1 = y * (u0 + y * (u1 + y * (u2 + y * (u3 + y * (u4 + y * u5)))));
        p2 = 1 + y * (v1 + y * (v2 + y * (v3 + y * (v4 + y * v5))));
        r += (-0.5 * y + p1 / p2);
    }
  } else if (ix < 0x40200000) {
    i = Math.trunc(x);
    y = x - i;
    p = y * (s0 + y * (s1 + y * (s2 + y * (s3 + y * (s4 + y * (s5 + y * s6))))));
    q = 1 + y * (r1 + y * (r2 + y * (r3 + y * (r4 + y * (r5 + y * r6)))));
    r = 0.5 * y + p / q;
    z = 1;
    switch (i) {
      case 7: z *= (y + 6.0); // fallthrough
      case 6: z *= (y + 5.0); // fallthrough
      case 5: z *= (y + 4.0); // fallthrough
      case 4: z *= (y + 3.0); // fallthrough
      case 3: z *= (y + 2.0); r += Math.log(z); break;
    }
  } else if (ix < 0x43900000) {
    t = Math.log(x);
    z = 1 / x;
    y = z * z;
    w = w0 + z * (w1 + y * (w2 + y * (w3 + y * (w4 + y * (w5 + y * w6)))));
    r = (x - 0.5) * (t - 1) + w;
  } else r = x * (Math.log(x) - 1);
  if (hx < 0) r = nadj - r;
  return [r, sign];
}

// ---- tgamma: exact factorials for integers, Lanczos elsewhere
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function tgamma(x) {
  if (x !== x) return x;
  if (x === Infinity) return x;
  if (x === -Infinity) return NaN;
  if (x === 0) return 1 / x;
  if (x < 0 && Number.isInteger(x)) return NaN;
  if (Number.isInteger(x) && x <= 171) {
    let f = 1n;
    for (let k = 2n; k < BigInt(x); k++) f *= k;
    return Number(f);
  }
  if (x > 171.62) return Infinity;
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * tgamma(1 - x));
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
}

// ---- Bessel functions of the first and second kind
function besselJ0(x) {
  x = Math.abs(x);
  if (x === Infinity) return 0;
  if (x < 8) {
    // power series
    let sum = 1, term = 1;
    const q = -(x * x) / 4;
    for (let k = 1; k < 60; k++) {
      term *= q / (k * k);
      sum += term;
      if (Math.abs(term) < 1e-17 * Math.abs(sum)) break;
    }
    return sum;
  }
  return hankel(0, x).j;
}
function besselJ1(x) {
  const sgn = x < 0 ? -1 : 1;
  x = Math.abs(x);
  if (x === Infinity) return 0;
  if (x < 8) {
    let term = x / 2, sum = term;
    const q = -(x * x) / 4;
    for (let k = 1; k < 60; k++) {
      term *= q / (k * (k + 1));
      sum += term;
      if (Math.abs(term) < 1e-17 * Math.abs(sum)) break;
    }
    return sgn * sum;
  }
  return sgn * hankel(1, x).j;
}
// asymptotic expansions for large x
function hankel(n, x) {
  const mu = 4 * n * n;
  let P = 1, Q = 0, term = 1;
  const z = 8 * x;
  for (let k = 1; k < 30; k++) {
    const next = term * (mu - (2 * k - 1) * (2 * k - 1)) / (k * z);
    if (Math.abs(next) > Math.abs(term)) break;   // the asymptotic series starts diverging
    term = next;
    if (k % 2 === 1) Q += (k % 4 === 1 ? 1 : -1) * term;
    else P += (k % 4 === 2 ? -1 : 1) * term;
    if (Math.abs(term) < 1e-17) break;
  }
  const chi = x - (n / 2 + 0.25) * Math.PI;
  const f = Math.sqrt(2 / (Math.PI * x));
  return { j: f * (P * Math.cos(chi) - Q * Math.sin(chi)), y: f * (P * Math.sin(chi) + Q * Math.cos(chi)) };
}
const EULER = 0.5772156649015329;
function besselY0(x) {
  if (x !== x || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return 0;
  if (x < 8) {
    let sum = 0, term = 1, h = 0;
    const q = -(x * x) / 4;
    for (let k = 1; k < 60; k++) {
      term *= q / (k * k);
      h += 1 / k;
      sum -= term * h;
      if (Math.abs(term * h) < 1e-17) break;
    }
    return (2 / Math.PI) * ((Math.log(x / 2) + EULER) * besselJ0(x) + sum);
  }
  return hankel(0, x).y;
}
function besselY1(x) {
  if (x !== x || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return 0;
  if (x < 8) {
    // Y1 = (2/pi)(J1 ln(x/2) - 1/x) - (1/pi) sum (-1)^k (h_k + h_{k+1}) (x/2)^(2k+1) / (k!(k+1)!)
    let sum = 0, term = x / 2, hk = 0, hk1 = 1;
    const q = -(x * x) / 4;
    for (let k = 0; k < 60; k++) {
      if (k > 0) { term *= q / (k * (k + 1)); hk += 1 / k; hk1 += 1 / (k + 1); }
      sum += term * (hk + hk1);
      if (Math.abs(term) < 1e-18) break;
    }
    return (2 / Math.PI) * (besselJ1(x) * (Math.log(x / 2) + EULER) - 1 / x) - sum / Math.PI;
  }
  return hankel(1, x).y;
}
function besselJn(n, x) {
  n = Math.trunc(n);
  if (x !== x) return x;
  let sgn = 1;
  if (n < 0) { n = -n; x = -x; }
  if (n === 0) return besselJ0(x);
  if (n === 1) return besselJ1(x);
  if (x < 0 && (n & 1)) sgn = -1;
  x = Math.abs(x);
  if (x === 0 || x === Infinity) return 0;
  if (n < x) {
    let a = besselJ0(x), b = besselJ1(x);
    for (let i = 1; i < n; i++) { const t = b; b = (2 * i / x) * b - a; a = t; }
    return sgn * b;
  }
  // Miller's backward recurrence
  const m = 2 * Math.floor((n + Math.floor(Math.sqrt(40 * n))) / 2);
  let jsum = false, bjp = 0, sum = 0, bj = 1, ans = 0;
  for (let j = m; j > 0; j--) {
    const bjm = (2 * j / x) * bj - bjp;
    bjp = bj;
    bj = bjm;
    if (Math.abs(bj) > 1e10) { bj *= 1e-10; bjp *= 1e-10; ans *= 1e-10; sum *= 1e-10; }
    if (jsum) sum += bj;
    jsum = !jsum;
    if (j === n) ans = bjp;
  }
  sum = 2 * sum - bj;
  return sgn * ans / sum;
}
function besselYn(n, x) {
  n = Math.trunc(n);
  let sgn = 1;
  if (n < 0) { n = -n; if (n & 1) sgn = -1; }
  if (x !== x || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (n === 0) return besselY0(x);
  if (n === 1) return sgn * besselY1(x);
  let a = besselY0(x), b = besselY1(x);
  for (let i = 1; i < n && b !== -Infinity; i++) { const t = b; b = (2 * i / x) * b - a; a = t; }
  return sgn * b;
}

// ---- exp10 (glibc e_exp10.c): split the argument so that arg_high * log10_high is exact
const LOG10_HIGH = 2.302585065364837646484375;           // 0x2.4d7637p0
const LOG10_LOW = 2.7629208037533616e-8;                 // ln(10) - LOG10_HIGH
function exp10(arg) {
  if (!Number.isFinite(arg)) return Math.exp(arg === arg ? arg : arg);
  if (arg < -307 - 15 - 10) return 0;
  if (arg > 308 + 1) return Infinity;
  if (Math.abs(arg) < 1.3877787807814457e-17) return 1;
  f64[0] = arg;
  u32[0] = u32[0] & 0xf8000000;
  const argHigh = f64[0];
  const argLow = arg - argHigh;
  const expHigh = argHigh * LOG10_HIGH;
  const expLow = argHigh * LOG10_LOW + argLow * Math.LN10;
  return Math.exp(expHigh) * Math.exp(expLow);
}

// ---- simple ones with C special cases
function pow(x, y) {
  if (x === 1) return 1;
  if (y === 0) return 1;
  if (x === -1 && (y === Infinity || y === -Infinity)) return 1;
  return x ** y;
}

function fmod(x, y) { return x % y; }

function remainder(x, p) {
  if (x !== x || p !== p) return NaN;
  if (x === Infinity || x === -Infinity || p === 0) return NaN;
  if (p === Infinity || p === -Infinity) return x;
  const neg = x < 0 || (x === 0 && 1 / x < 0);
  p = Math.abs(p);
  if (p <= Number.MAX_VALUE / 2) x = x % (p + p);
  if (x === 0) return neg ? -0 : 0;
  x = Math.abs(x);
  if (p < 2 * 2.2250738585072014e-308) {
    if (x + x > p) { x -= p; if (x + x >= p) x -= p; }
  } else {
    const ph = 0.5 * p;
    if (x > ph) { x -= p; if (x >= ph) x -= p; }
  }
  return neg ? -x : x;
}

function rint(x) {
  if (x !== x || x === Infinity || x === -Infinity || x === 0) return x;
  if (Math.abs(x) >= 4503599627370496) return x;
  const f = Math.floor(x);
  const d = x - f;
  let r;
  if (d < 0.5) r = f;
  else if (d > 0.5) r = f + 1;
  else r = f % 2 === 0 ? f : f + 1;
  if (r === 0 && x < 0) return -0;
  return r;
}

function round(x) {
  if (x !== x || x === Infinity || x === -Infinity) return x;
  const t = Math.trunc(x);
  if (Math.abs(x - t) >= 0.5) return t + Math.sign(x);
  return t;
}

function copysign(x, y) {
  const neg = y < 0 || (y === 0 && 1 / y < 0) || (y !== y && HI(y) < 0);
  const ax = Math.abs(x);
  return neg ? -ax : ax;
}

function fdim(x, y) {
  if (x !== x || y !== y) return NaN;
  return x > y ? x - y : 0;
}
function fmax(x, y) {
  if (x >= y) return x;
  if (x < y) return y;
  return y !== y ? x : y;
}
function fmin(x, y) {
  if (x <= y) return x;
  if (x > y) return y;
  return y !== y ? x : y;
}

function frexp(x) {
  if (x === 0 || x !== x || x === Infinity || x === -Infinity) return [x, 0];
  let e = 0;
  let ax = Math.abs(x);
  if (ax < 2.2250738585072014e-308) { ax *= 18014398509481984; e = -54; }   // 2^54: normalize subnormals
  f64[0] = ax;
  const hi = u32[1];
  e += ((hi >>> 20) & 0x7ff) - 1022;
  u32[1] = (hi & 0x800fffff) | (1022 << 20);
  const m = f64[0];
  return [x < 0 ? -m : m, e];
}

function modf(x) {
  if (x === Infinity || x === -Infinity) return [x < 0 ? -0 : 0, x];
  if (x !== x) return [x, x];
  const i = Math.trunc(x);
  let f = x - i;
  if (f === 0) f = x < 0 || (x === 0 && 1 / x < 0) ? -0 : 0;
  return [f, i];
}

function logb(x) {
  if (x !== x) return x;
  if (x === 0) return -Infinity;
  if (x === Infinity || x === -Infinity) return Infinity;
  return frexp(x)[1] - 1;
}

function scalbn(x, n) {
  if (x === 0 || x !== x || x === Infinity || x === -Infinity) return x;
  if (n > 2098) n = 2098;
  if (n < -2099) n = -2099;
  while (n > 1023) { x *= 8.98846567431158e307; n -= 1023; if (x === Infinity || x === -Infinity) return x; }
  while (n < -1022) {
    // keep enough precision: scale in a single rounding step when the result is subnormal
    if (n >= -1022 - 53) { return x * 2 ** (n + 53) * 2 ** -53; }
    x *= 2.2250738585072014e-308;
    n += 1022;
    if (x === 0) return x;
  }
  return x * 2 ** n;
}
function scalb(x, fn) {
  if (x !== x || fn !== fn) return x * fn;
  if (fn === Infinity || fn === -Infinity) {
    if (fn > 0) return x * fn;
    return x / -fn;
  }
  if (rint(fn) !== fn) return NaN;
  if (fn > 65000) return scalbn(x, 65000);
  if (-fn > 65000) return scalbn(x, -65000);
  return scalbn(x, fn | 0);
}
function scalbln(x, n) {
  if (n !== n) n = 0;
  n = Math.trunc(Math.max(Math.min(n, 9.223372036854776e18), -9.223372036854776e18));
  return scalbn(x, Math.max(Math.min(n, 100000), -100000));
}
function ldexp(x, e) {
  let n = e !== e ? 0 : Math.trunc(e);
  if (n > 2147483647) n = 2147483647;
  if (n < -2147483648) n = -2147483648;
  return scalbn(x, Math.max(Math.min(n, 100000), -100000));
}
function significand(x) {
  if (x === 0 || x !== x || x === Infinity || x === -Infinity) return x;
  const [m] = frexp(x);
  return m * 2;
}

function nextafter(x, y) {
  if (x !== x || y !== y) return x + y;
  if (x === y) return y;
  if (x === 0) return y > 0 ? 5e-324 : -5e-324;
  f64[0] = x;
  let lo = u32[0], hi = u32[1];
  if ((x > 0) === (y > x)) {
    lo = (lo + 1) >>> 0;
    if (lo === 0) hi = (hi + 1) >>> 0;
  } else {
    if (lo === 0) hi = (hi - 1) >>> 0;
    lo = (lo - 1) >>> 0;
  }
  u32[0] = lo; u32[1] = hi;
  return f64[0];
}

// exact fused multiply-add through BigInt arithmetic
function toExact(x) {
  f64[0] = x;
  const hi = u32[1], lo = u32[0];
  const e = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let ex;
  if (e === 0) ex = -1074;
  else { m |= 1n << 52n; ex = e - 1075; }
  if (hi >>> 31) m = -m;
  return [m, ex];
}
function fma(a, b, c) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || a === 0 || b === 0) return a * b + c;
  if (c === 0) return a * b;
  const [ma, ea] = toExact(a), [mb, eb] = toExact(b), [mc, ec] = toExact(c);
  let mp = ma * mb, ep = ea + eb;
  let m, e;
  if (ep <= ec) { m = mp + (mc << BigInt(ec - ep)); e = ep; }
  else { m = (mp << BigInt(ep - ec)) + mc; e = ec; }
  if (m === 0n) return 0;
  const neg = m < 0n;
  if (neg) m = -m;
  // round m * 2^e to a double (ties to even), handling the subnormal range
  const bits = m.toString(2).length;
  let shift = bits - 53;
  const minExp = -1074;
  if (e + shift < minExp) shift = minExp - e;
  let r;
  if (shift > 0) {
    const half = 1n << BigInt(shift - 1);
    const rem = m & ((1n << BigInt(shift)) - 1n);
    r = m >> BigInt(shift);
    if (rem > half || (rem === half && (r & 1n))) r += 1n;
    e += shift;
  } else r = m;
  const v = Number(r) * 2 ** e;
  return neg ? -v : v;
}

export const LIBM = {
  acos: Math.acos, acosh: Math.acosh, asin: Math.asin, asinh: Math.asinh, atan: Math.atan, atan2: Math.atan2,
  atanh: Math.atanh, cbrt: Math.cbrt, cos: Math.cos, cosh: Math.cosh, exp: Math.exp, exp2: (x) => 2 ** x,
  floor: Math.floor, hypot: (x, y) => Math.hypot(x, y), j0: besselJ0, j1: besselJ1, log: Math.log,
  log10: Math.log10, log2: Math.log2, pow, remainder, sin: Math.sin, sinh: Math.sinh, sqrt: Math.sqrt,
  tan: Math.tan, tanh: Math.tanh, tgamma, y0: besselY0, y1: besselY1, jn: besselJn, yn: besselYn,
  ceil: Math.ceil, copysign, drem: remainder, erf, erfc, exp10, expm1: Math.expm1,
  fabs: Math.abs, fdim, fma, fmax, fmin, fmod, gamma: (x) => lgammaR(x)[0], lgamma: (x) => lgammaR(x)[0],
  log1p: Math.log1p, logb, nearbyint: rint, nextafter, nexttoward: nextafter, rint, round, scalb, scalbln,
  significand, trunc: Math.trunc, ldexp, frexp, modf, lgamma_r: lgammaR,
};
