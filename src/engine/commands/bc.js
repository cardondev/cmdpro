// bc — GNU bc 1.07.1, reimplemented — and a small dc.
//
// bc is built the way the original is: a scanner that follows bc's lexical rules (longest match,
// first rule wins), an LR parser running the bc grammar's LALR(1) automaton (tables made by
// bison from tools/bc-grammar.y), semantic actions that emit bc's byte code, and the byte-code
// machine, over arbitrary-precision decimals with bc's scale and sign rules. Keeping that shape
// is what makes the output, the warnings, the error recovery and even the "adr=" of a runtime
// error match the real program.
import { BC_TABLES as T } from './bc-tables.js';
import { getopt } from './util.js';

const C = {};

// ---------------------------------------------------------------- numbers
// value = v / 10^s. `neg` is the sign: bc can make a "negative zero" (it prints as -0 and
// compares below 0), so the sign is kept apart from v.
class Num {
  constructor(v, s, neg = v < 0n) { this.v = v; this.s = s; this.neg = neg; }
  static int(n) { return new Num(BigInt(n), 0); }
}
class BcFatal extends Error {}
const P10C = [];
const MAX_DIGITS = 4_000_000;   // beyond this the real bc would exhaust memory long before finishing
const P10 = (n) => {
  if (n < 400) return P10C[n] ??= 10n ** BigInt(n);
  if (n > MAX_DIGITS) throw new BcFatal('Fatal error: Out of memory for malloc.');
  return 10n ** BigInt(n);
};
const absB = (x) => (x < 0n ? -x : x);
const ZERO = new Num(0n, 0), ONE = new Num(1n, 0);
const LONG_MAX = 9223372036854775807n;
const BC_BASE_MAX = 2147483647, BC_SCALE_MAX = 2147483647, BC_DIM_MAX = 16777215, MAX_STORE = 32767;
const isZero = (a) => a.v === 0n;
const intPart = (a) => absB(a.v) / P10(a.s);
const nLen = (a) => { const ip = intPart(a); return ip === 0n ? 1 : ip.toString().length; };
const int2num = (n) => new Num(BigInt(n), 0);
// the integer part as a C long; 0 when it does not fit
function num2long(a) { const ip = intPart(a); if (ip > LONG_MAX) return 0n; return a.neg ? -ip : ip; }
function magAt(a, s) { return absB(a.v) * P10(s - a.s); }
function cmpMag(a, b) { const s = Math.max(a.s, b.s); const x = magAt(a, s), y = magAt(b, s); return x < y ? -1 : x > y ? 1 : 0; }
function compare(a, b) {
  if (a.neg !== b.neg) return a.neg ? -1 : 1;
  const c = cmpMag(a, b);
  return a.neg ? -c : c;
}
const signed = (m, neg, s) => new Num(neg ? -m : m, s, neg);
function bcAdd(a, b, smin = 0) {
  const s = Math.max(a.s, b.s, smin);
  if (a.neg === b.neg) return signed(magAt(a, s) + magAt(b, s), a.neg, s);
  const c = cmpMag(a, b);
  if (c === 0) return new Num(0n, s);
  return c < 0 ? signed(magAt(b, s) - magAt(a, s), b.neg, s) : signed(magAt(a, s) - magAt(b, s), a.neg, s);
}
function bcSub(a, b, smin = 0) {
  const s = Math.max(a.s, b.s, smin);
  if (a.neg !== b.neg) return signed(magAt(a, s) + magAt(b, s), a.neg, s);
  const c = cmpMag(a, b);
  if (c === 0) return new Num(0n, s);
  return c < 0 ? signed(magAt(b, s) - magAt(a, s), !b.neg, s) : signed(magAt(a, s) - magAt(b, s), a.neg, s);
}
function bcMul(a, b, scale) {
  const full = a.s + b.s;
  const ps = Math.min(full, Math.max(scale, a.s, b.s));
  let v = a.v * b.v;
  if (ps < full) v /= P10(full - ps);
  return new Num(v, ps);
}
// null for a zero divisor
function bcDiv(a, b, scale) {
  if (b.v === 0n) return null;
  return new Num((a.v * P10(b.s + scale)) / (b.v * P10(a.s)), scale);
}
function bcMod(a, b, scale) {
  if (b.v === 0n) return null;
  const rscale = Math.max(a.s, b.s + scale);
  return bcSub(a, bcMul(bcDiv(a, b, scale), b, rscale), rscale);
}
// rt: { warn(msg), error(msg) } — bc reports these as runtime warnings/errors and carries on
function bcRaise(a, b, scale, rt) {
  if (b.s !== 0) rt.warn('non-zero scale in exponent');
  const e = num2long(b);
  if (e === 0n && intPart(b) !== 0n) rt.error('exponent too large in raise');
  if (e === 0n) return ONE;
  const neg = e < 0n, ue = neg ? -e : e;
  const cap = BigInt(Math.max(scale, a.s)), full = BigInt(a.s) * ue;
  const rscale = neg ? scale : Number(full < cap ? full : cap);
  const mag = absB(a.v);
  let temp;
  if (ue === 1n) temp = a;
  else if (mag === 0n) temp = new Num(0n, neg ? 0 : rscale);
  else {
    // bc's repeated squaring keeps every digit, so the exact power is computed, then truncated
    if ((mag > 1n && ue * BigInt(mag.toString().length) > BigInt(MAX_DIGITS)) || full > BigInt(MAX_DIGITS)) throw new BcFatal('Fatal error: Out of memory for malloc.');
    temp = signed(mag ** ue, a.neg && (ue & 1n) === 1n, Number(full));
  }
  if (neg) return bcDiv(ONE, temp, rscale);
  if (temp.s > rscale) temp = new Num(temp.v / P10(temp.s - rscale), rscale, temp.neg);   // keeps the sign: -0 is possible
  return temp;
}
function nearZero(a, scale) { const sc = Math.min(scale, a.s); return absB(a.v) / P10(a.s - sc) <= 1n; }
// Newton's method exactly as bc runs it (the guesses and their scales decide the last digit); null if negative
function bcSqrt(num, scale, tick) {
  const c0 = compare(num, ZERO);
  if (c0 < 0) return null;
  if (c0 === 0) return ZERO;
  const c1 = compare(num, ONE);
  if (c1 === 0) return ONE;
  const rscale = Math.max(scale, num.s);
  const point5 = new Num(5n, 1);
  let guess, cscale;
  if (c1 < 0) { guess = ONE; cscale = num.s; }
  else {
    let g1 = bcMul(int2num(nLen(num)), point5, 0);
    g1 = new Num(g1.v / P10(g1.s), 0);
    guess = bcRaise(int2num(10), g1, 0, { warn() {}, error() {} });
    cscale = 3;
  }
  for (;;) {
    tick();
    const guess1 = guess;
    guess = bcDiv(num, guess, cscale);
    guess = bcAdd(guess, guess1, 0);
    guess = bcMul(guess, point5, cscale);
    const diff = bcSub(guess, guess1, cscale + 1);
    if (nearZero(diff, cscale)) {
      if (cscale < rscale + 1) cscale = Math.min(cscale * 3, rscale + 1);
      else break;
    }
  }
  return bcDiv(guess, ONE, rscale);
}
// bc_out_num: the digits of a number in base `base`, one character at a time
function outNum(a, base, put) {
  if (a.neg) put('-');
  if (isZero(a)) { put('0'); return; }
  const m = absB(a.v);
  if (base === 10) {
    const str = m.toString().padStart(a.s + 1, '0');
    const ip = str.slice(0, str.length - a.s);
    if (ip !== '0') for (const ch of ip) put(ch);
    if (a.s > 0) { put('.'); for (const ch of str.slice(str.length - a.s)) put(ch); }
    return;
  }
  const one = P10(a.s);
  const ip = m / one;
  let frac = m % one;
  const wide = base > 16, width = String(base - 1).length;
  const B = BigInt(base);
  const digit = (d, space) => {
    if (!wide) { put('0123456789ABCDEF'[Number(d)]); return; }
    if (space) put(' ');
    for (const ch of String(d).padStart(width, '0')) put(ch);
  };
  if (ip > 0n) {
    let digs;
    if (base <= 36) digs = [...ip.toString(base)].map((ch) => BigInt(parseInt(ch, 36)));
    else { digs = []; for (let x = ip; x > 0n; x /= B) digs.push(x % B); digs.reverse(); }
    for (const d of digs) digit(d, true);
  }
  if (a.s > 0) {
    put('.');
    let pre = false;
    for (let t = 1n; t < one; t *= B) {
      frac *= B;
      digit(frac / one, pre);
      frac %= one;
      pre = true;
    }
  }
}

// ---------------------------------------------------------------- the math library (-l)
// bc's library routines; the results depend on every scale change and truncation, so these
// follow the original algorithms step for step.
const LIBMATH = `scale = 20

/* exp: halve x until it is at most 1, sum the series, then square the sum back up */
define e(x) {
  auto a, b, d, e, f, i, m, n, v, z
  if (ibase != A) {
    b = ibase
    ibase = A
    v = e(x)
    ibase = b
    return (v)
  }
  if (x < 0) {
    m = 1
    x = -x
  }
  z = scale
  n = 6 + z + .44*x
  scale = scale(x) + 1
  while (x > 1) {
    f += 1
    x /= 2
    scale += 1
  }
  scale = n
  v = 1 + x
  a = x
  d = 1
  for (i = 2; 1; i++) {
    e = (a *= x) / (d *= i)
    if (e == 0) {
      if (f > 0) while (f--) v = v*v
      scale = z
      if (m) return (1/v)
      return (v/1)
    }
    v += e
  }
}

/* natural log: square roots bring x into (.5, 2), then 2(a + a^3/3 + ...), a = (x-1)/(x+1) */
define l(x) {
  auto b, e, f, i, m, n, v, z
  if (ibase != A) {
    b = ibase
    ibase = A
    v = l(x)
    ibase = b
    return (v)
  }
  if (x <= 0) return ((1 - 10^scale)/1)
  z = scale
  scale = 6 + scale
  f = 2
  i = 0
  while (x >= 2) {
    f *= 2
    x = sqrt(x)
  }
  while (x <= .5) {
    f *= 2
    x = sqrt(x)
  }
  v = n = (x-1)/(x+1)
  m = n*n
  for (i = 3; 1; i += 2) {
    e = (n *= m) / i
    if (e == 0) {
      v = f*v
      scale = z
      return (v/1)
    }
    v += e
  }
}

/* sine: reduce by multiples of 2 pi, then x - x^3/3! + x^5/5! - ... */
define s(x) {
  auto b, e, i, m, n, s, v, z
  if (ibase != A) {
    b = ibase
    ibase = A
    v = s(x)
    ibase = b
    return (v)
  }
  z = scale
  scale = 1.1*z + 2
  v = a(1)
  if (x < 0) {
    m = 1
    x = -x
  }
  scale = 0
  n = (x / v + 2)/4
  x = x - 4*n*v
  if (n%2) x = -x
  scale = z + 2
  v = e = x
  s = -x*x
  for (i = 3; 1; i += 2) {
    e *= s/(i*(i-1))
    if (e == 0) {
      scale = z
      if (m) return (-v/1)
      return (v/1)
    }
    v += e
  }
}

/* cosine, as the sine shifted by pi/2 */
define c(x) {
  auto b, v, z
  if (ibase != A) {
    b = ibase
    ibase = A
    v = c(x)
    ibase = b
    return (v)
  }
  z = scale
  scale = scale*1.2
  v = s(x + a(1)*2)
  scale = z
  return (v/1)
}

/* arctangent: atan(x) = atan(.2) + atan((x-.2)/(1+.2x)) until x <= .2, then the series;
   atan(1) and atan(.2) are known constants for the common scales */
define a(x) {
  auto a, b, e, f, i, m, n, s, v, z
  if (ibase != A) {
    b = ibase
    ibase = A
    v = a(x)
    ibase = b
    return (v)
  }
  m = 1
  if (x < 0) {
    m = -1
    x = -x
  }
  if (x == 1) {
    if (scale <= 25) return (.7853981633974483096156608/m)
    if (scale <= 40) return (.7853981633974483096156608458198757210492/m)
    if (scale <= 60) return (.785398163397448309615660845819875721049292349843776455243736/m)
  }
  if (x == .2) {
    if (scale <= 25) return (.1973955598498807583700497/m)
    if (scale <= 40) return (.1973955598498807583700497651947902934475/m)
    if (scale <= 60) return (.197395559849880758370049765194790293447585103787852101517688/m)
  }
  z = scale
  if (x > .2) {
    scale = z + 5
    a = a(.2)
  }
  scale = z + 3
  while (x > .2) {
    f += 1
    x = (x - .2) / (1 + x*.2)
  }
  v = n = x
  s = -x*x
  for (i = 3; 1; i += 2) {
    e = (n *= s) / i
    if (e == 0) {
      scale = z
      return ((f*a + v)/m)
    }
    v += e
  }
}

/* Bessel function of integer order n: x^n/(2^n n!) (1 - x^2/(2^2 1!(n+1)) + ...) */
define j(n,x) {
  auto a, b, d, e, f, i, m, s, v, z
  if (ibase != A) {
    b = ibase
    ibase = A
    v = j(n,x)
    ibase = b
    return (v)
  }
  z = scale
  scale = 0
  n = n/1
  if (n < 0) {
    n = -n
    if (n%2 == 1) m = 1
  }
  f = 1
  for (i = 2; i <= n; i++) f = f*i
  scale = 1.5*z
  f = x^n / 2^n / f
  v = e = 1
  s = -x*x/4
  scale = 1.5*z + length(f) - scale(f)
  for (i = 1; 1; i++) {
    e = e * s / i / (n+i)
    if (e == 0) {
      scale = z
      if (m) return (-f*v/1)
      return (f*v/1)
    }
    v += e
  }
}
`;

// ---------------------------------------------------------------- scanner
// token numbers as bison assigns them (the %token order in tools/bc-grammar.y)
const TK = {
  ENDOFLINE: 258, AND: 259, OR: 260, NOT: 261, STRING: 262, NAME: 263, NUMBER: 264, ASSIGN_OP: 265, REL_OP: 266,
  INCR_DECR: 267, Define: 268, Break: 269, Quit: 270, Length: 271, Return: 272, For: 273, If: 274, While: 275,
  Sqrt: 276, Else: 277, Scale: 278, Ibase: 279, Obase: 280, Auto: 281, Read: 282, Random: 283, Warranty: 284,
  Halt: 285, Last: 286, Continue: 287, Print: 288, Limits: 289, HistoryVar: 291, Void: 292,
};
const KEYWORDS = new Map(Object.entries({
  define: TK.Define, break: TK.Break, quit: TK.Quit, length: TK.Length, return: TK.Return, for: TK.For, if: TK.If,
  while: TK.While, sqrt: TK.Sqrt, scale: TK.Scale, ibase: TK.Ibase, obase: TK.Obase, auto: TK.Auto, else: TK.Else,
  read: TK.Read, random: TK.Random, halt: TK.Halt, last: TK.Last, void: TK.Void, history: TK.HistoryVar,
  warranty: TK.Warranty, continue: TK.Continue, print: TK.Print, limits: TK.Limits,
}));
const NUM_RE = /[0-9A-Z](?:[0-9A-Z]|\\\n)*(?:\.(?:[0-9A-Z]|\\\n)*)?|\.(?:\\\n)*[0-9A-Z](?:[0-9A-Z]|\\\n)*/y;
const NAME_RE = /[a-z][a-z0-9_]*/y;
const STR_RE = /"[^"]*"/y;
const WS_RE = /[ \t]+/y;
const stickyLen = (re, t, i) => { re.lastIndex = i; return re.test(t) ? re.lastIndex - i : 0; };

class Scanner {
  // more(): called at the end of the text; returns true when it has appended more input
  constructor(bc, text = '', more = () => false) { this.bc = bc; this.text = text; this.pos = 0; this.more = more; this.comment = false; this.lval = undefined; }
  // the longest match among the rules that apply in the INITIAL state: [length, kind, extra]
  match(t, i) {
    const c = t[i], d = t[i + 1];
    switch (c) {
      case '#': return [1, 'hash'];
      case '\n': return [1, 'eol'];
      case ' ': case '\t': return [stickyLen(WS_RE, t, i), 'skip'];
      case '\\': return d === '\n' ? [2, 'cont'] : [1, 'bad'];
      case '"': { const n = stickyLen(STR_RE, t, i); return n ? [n, 'str'] : [1, 'bad']; }
      case '+': case '-': return d === '=' ? [2, 'asg', c] : d === c ? [2, 'incdec', c] : [1, 'char'];
      case '*': case '%': case '^': return d === '=' ? [2, 'asg', c] : [1, 'char'];
      case '/': return d === '*' ? [2, 'comment'] : d === '=' ? [2, 'asg', '/'] : [1, 'char'];
      case '=': return d === '=' ? [2, 'rel', '=='] : d !== undefined && '+-*/%^'.includes(d) ? [2, 'asg1'] : [1, 'asg', '='];
      case '<': case '>': return d === '=' ? [2, 'rel', c + '='] : [1, 'rel', c];
      case '!': return d === '=' ? [2, 'rel', '!='] : [1, 'not'];
      case '&': return d === '&' ? [2, 'and'] : [1, 'char'];
      case '|': return d === '|' ? [2, 'or'] : [1, 'bad'];
      case ';': case '(': case ')': case '{': case '}': case '[': case ']': case ',': return [1, 'char'];
      case '.': { const n = stickyLen(NUM_RE, t, i); return n ? [n, 'num'] : [1, 'last']; }
    }
    if (c >= 'a' && c <= 'z') return [stickyLen(NAME_RE, t, i), 'name'];
    if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z')) return [stickyLen(NUM_RE, t, i), 'num'];
    return [1, 'bad'];
  }
  // flex's input(): the next character, crossing into the next file; null at the very end
  input() {
    while (this.pos >= this.text.length) if (!this.more() && !this.bc.yywrap()) return null;
    return this.text[this.pos++];
  }
  lex() {
    const bc = this.bc;
    for (;;) {
      if (this.pos >= this.text.length) { if (this.more() || bc.yywrap()) continue; return 0; }
      const t = this.text, i = this.pos;
      let [len, kind, x] = this.match(t, i);
      if (this.comment) {
        // inside a # comment the rest of the line wins unless another rule matches more
        let e = t.indexOf('\n', i);
        if (e < 0) e = t.length;
        if (e - i > 0 && e - i >= len) { this.pos = e; this.comment = false; continue; }
        if (kind === 'eol') { this.comment = false; }
      }
      switch (kind) {
        case 'hash': this.pos++; if (!bc.stdOnly) this.comment = true; else bc.yyerror('illegal character: #'); continue;
        case 'eol': this.pos++; bc.lineNo++; return TK.ENDOFLINE;
        case 'skip': this.pos += len; continue;
        case 'cont': this.pos += 2; bc.lineNo++; continue;
        case 'str': {
          let s = t.slice(i, i + len);
          this.pos += len;
          bc.lineNo += s.split('\n').length - 1;
          const nul = s.indexOf('\0');
          if (nul >= 0) { s = s.slice(0, nul); bc.yyerror('NUL character in string.'); }
          this.lval = s;
          return TK.STRING;
        }
        case 'char': this.pos++; this.lval = t[i]; return t.charCodeAt(i);
        case 'asg': this.pos += len; this.lval = x; return TK.ASSIGN_OP;
        case 'asg1': this.pos += 1; this.lval = '='; return TK.ASSIGN_OP;
        case 'rel': this.pos += len; this.lval = x; return TK.REL_OP;
        case 'incdec': this.pos += 2; this.lval = x; return TK.INCR_DECR;
        case 'not': this.pos++; return TK.NOT;
        case 'and': this.pos += 2; return TK.AND;
        case 'or': this.pos += 2; return TK.OR;
        case 'last': this.pos++; return TK.Last;
        case 'comment': this.pos += 2; this.skipComment(); continue;
        case 'name': {
          const w = t.slice(i, i + len);
          this.pos += len;
          const k = KEYWORDS.get(w);
          if (k) return k;
          this.lval = w;
          return TK.NAME;
        }
        case 'num': this.pos += len; this.lval = this.number(t.slice(i, i + len)); return TK.NUMBER;
        default: {
          this.pos++;
          const code = t.charCodeAt(i);
          bc.yyerror(code < 0x20 ? `illegal character: ^${String.fromCharCode(code + 64)}`
            : code > 0x7e ? `illegal character: \\${code.toString(8).padStart(3, '0')}` : `illegal character: ${t[i]}`);
          continue;
        }
      }
    }
  }
  skipComment() {
    const bc = this.bc;
    for (;;) {
      let c;
      while ((c = this.input()) !== '*' && c !== null) if (c === '\n') bc.lineNo++;
      if (c === '*') {
        while ((c = this.input()) === '*');
        if (c === '/') return;
        if (c === '\n') bc.lineNo++;
      }
      if (c === null) { bc.errOut('EOF encountered in a comment.\n'); return; }
    }
  }
  // a numeric constant as bc keeps it: no trailing '.', no leading zeros, no line continuations
  number(s) {
    if (s.endsWith('.')) s = s.slice(0, -1);
    let k = 0;
    while (s[k] === '0') k++;
    if (k === s.length) k--;
    let out = '';
    while (k < s.length) {
      if (s[k] === '\\') { k += 2; this.bc.lineNo++; if (k >= s.length) break; }
      out += s[k++];
    }
    return out;
  }
}

// ---------------------------------------------------------------- bc
const EX_ASSGN = 0, EX_REG = 1, EX_COMP = 2, EX_PAREN = 4, EX_VOID = 8, EX_EMPTY = 16;
const SIMPLE = 0, ARRAY = 1, FUNCT = 2, FUNCTDEF = 3;
// where each mid-rule action sits inside its rule (for $n inside it)
const MID_POS = { 29: 2, 30: 6, 31: 9, 32: 12, 34: 5, 36: 2, 37: 5, 40: 2, 47: 2, 49: 11, 76: 3, 78: 3, 80: 3 };
const B_DOT = 46, B_COLON = 58, B_TILDE = 126;
const VERSION = 'bc 1.07.1\nCopyright 1991-1994, 1997, 1998, 2000, 2004, 2006, 2008, 2012-2017 Free Software Foundation, Inc.\n';
const WARRANTY = `
    This program is free software; you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation; either version 3 of the License , or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program. If not, write to

       The Free Software Foundation, Inc.
       51 Franklin Street, Fifth Floor
       Boston, MA 02110-1335  USA

`;
const USAGE = (prog) => `usage: ${prog} [options] [file ...]
  -h  --help         print this usage and exit
  -i  --interactive  force interactive mode
  -l  --mathlib      use the predefined math routines
  -q  --quiet        don't print initial banner
  -s  --standard     non-standard bc constructs are errors
  -w  --warn         warn about non-standard bc constructs
  -v  --version      print version information and exit
`;
class BcExit { constructor(code) { this.code = code; } }
const nextarg = (list, name, isVar) => [{ name, isVar }, ...(list || [])];
const argStr = (list) => (list ? list.slice().reverse().map((a) => (a.isVar ? '*' : '') + a.name).join(',') : '');
const callStr = (list) => list.map((a) => (a.name ? '1' : '0')).join('');
const newFunc = () => ({ body: [], size: 0, defined: false, isVoid: false, params: [], autos: [], labels: [] });

class GnuBc {
  constructor(ctx) {
    this.ctx = ctx;
    this.compileOnly = false; this.interactive = false; this.useMath = false; this.quiet = false;
    this.stdOnly = false; this.warnNotStd = false;
    this.obuf = ''; this.outCol = 0; this.lineSize = 70; this.outCount = 0;
    this.fileNames = []; this.fileName = ''; this.isStdIn = false; this.firstFile = true; this.lineNo = 1;
    this.stdio = ''; this.stdioPos = 0;   // stdin as read() sees it (C stdio, 4 KiB at a time)
    this.resetSymbols();
    this.functions = [newFunc()]; this.fNames = ['(main)'];
    this.variables = []; this.arrays = [];
    this.ex = []; this.fn = [];
    this.iBase = 10; this.oBase = 10; this.scale = 0; this.nHistory = -1;
    this.pc = { func: 0, addr: 0 }; this.runtimeError = false;
    this.breakLabel = 0; this.continueLabel = 0; this.nextLabel = 1; this.ifLabel = 0; this.curFunc = -1;
    this.hadError = false; this.didGen = false;
    this.loadAdr = { func: 0, addr: 0 }; this.loadStr = false; this.loadConst = false; this.saveAdr = { func: 0, addr: 0 };
    this.errstatus = 0;
    this.rt = { warn: (m) => this.rtWarn(m), error: (m) => this.rtError(m) };
    this.scanner = new Scanner(this, '', () => this.moreStdin());
  }
  resetSymbols() { this.names = new Map(); this.nextArray = 1; this.nextFunc = 1; this.nextVar = 5; this.aNames = []; this.vNames = []; }

  // ------------------------------------------------------------ output
  rawOut(s) { this.obuf += s; }
  outChar(ch) {
    if (ch === '\n') { this.outCol = 0; this.obuf += '\n'; return; }
    this.outCol++;
    if (this.outCol === this.lineSize - 1 && this.lineSize !== 0) { this.obuf += '\\\n'; this.outCol = 1; }
    this.obuf += ch;
  }
  outSchar(ch) {
    if (ch === '\n') { this.outCol = 0; this.obuf += '\n'; return; }
    if (!this.stdOnly) {
      this.outCol++;
      if (this.outCol === this.lineSize - 1 && this.lineSize !== 0) { this.obuf += '\\\n'; this.outCol = 1; }
    }
    this.obuf += ch;
  }
  flush() { if (this.obuf) { const s = this.obuf; this.obuf = ''; this.ctx.out(s); } }
  errOut(s) { this.flush(); this.ctx.stderr.write(s); }
  exit(code) { throw new BcExit(code); }
  srcName() { return this.isStdIn ? '(standard_in)' : this.fileName; }
  yyerror(msg) { this.errOut(`${this.srcName()} ${this.lineNo}: ${msg}\n`); this.hadError = true; }
  ctWarn(msg) {
    if (this.stdOnly) { this.errOut(`${this.srcName()} ${this.lineNo}: Error: ${msg}\n`); this.hadError = true; }
    else if (this.warnNotStd) this.errOut(`${this.srcName()} ${this.lineNo}: (Warning) ${msg}\n`);
  }
  rtError(msg) { this.errOut(`Runtime error (func=${this.fNames[this.pc.func] ?? '(null)'}, adr=${this.pc.addr}): ${msg}\n`); this.runtimeError = true; }
  rtWarn(msg) { this.errOut(`Runtime warning (func=${this.fNames[this.pc.func] ?? '(null)'}, adr=${this.pc.addr}): ${msg}\n`); }

  // ------------------------------------------------------------ input files
  yywrap() { return this.openNewFile(); }
  openNewFile() {
    this.lineNo = 1;
    if (this.isStdIn) return false;
    if (this.useMath && this.firstFile) this.loadMathLib();
    if (this.fileNames.length) {
      const name = this.fileNames[0];
      let text = null, isDir = false;
      if (name !== '-') {
        try { text = this.ctx.readFile(name); }
        catch (e) { if (e && e.code === 'EISDIR') isDir = true; }
      }
      if (text === null && !isDir) { this.errOut(`File ${name} is unavailable.\n`); this.exit(1); }
      this.fileNames.shift();
      this.fileName = name;
      this.firstFile = false;
      if (isDir) { this.yyerror('read() in flex scanner failed'); this.exit(1); }
      this.scanner.text = text; this.scanner.pos = 0;
      return true;
    }
    this.isStdIn = true;
    this.firstFile = false;
    // flex reads standard input in big blocks; whatever read() buffered earlier is gone
    this.scanner.text = this.interactive ? '' : this.ctx.stdin.readAll();
    this.scanner.pos = 0;
    return true;
  }
  // interactive input arrives a line at a time through readline, which echoes it
  moreStdin() {
    if (!this.isStdIn || !this.interactive) return false;
    const r = this.ctx.stdin.readUntil('\n');
    if (!r) return false;
    this.rawOut(r.text + '\n');
    this.scanner.text = this.scanner.text.slice(this.scanner.pos) + r.text + '\n';
    this.scanner.pos = 0;
    return true;
  }
  getchar() {
    if (this.stdioPos >= this.stdio.length) {
      this.stdio = this.ctx.stdin.read(4096); this.stdioPos = 0;
      if (!this.stdio) return -1;
    }
    return this.stdio.charCodeAt(this.stdioPos++);
  }
  loadMathLib() {
    // compiled from source with a symbol table of its own, like the precompiled library, then
    // the program starts with only the six function names known
    const saved = { scanner: this.scanner, isStdIn: this.isStdIn, compileOnly: this.compileOnly, stdOnly: this.stdOnly, warn: this.warnNotStd, interactive: this.interactive, lineNo: this.lineNo };
    this.compileOnly = false; this.stdOnly = false; this.warnNotStd = false; this.interactive = false; this.useMath = false;
    this.resetSymbols();
    for (const f of ['e', 'l', 's', 'a', 'c', 'j']) this.lookup(f, FUNCT);
    this.scanner = new Scanner(this, LIBMATH);
    this.isStdIn = true;
    const wrap = this.yywrap;
    this.yywrap = () => false;
    try { this.parse(); } finally {
      this.yywrap = wrap;
      Object.assign(this, { scanner: saved.scanner, isStdIn: saved.isStdIn, compileOnly: saved.compileOnly, stdOnly: saved.stdOnly, warnNotStd: saved.warn, interactive: saved.interactive, lineNo: saved.lineNo, useMath: true });
    }
    this.resetSymbols();
    for (const f of ['e', 'l', 's', 'a', 'c', 'j']) this.lookup(f, FUNCT);
  }

  // ------------------------------------------------------------ symbol table
  func(i) { return this.functions[i] ??= newFunc(); }
  lookup(name, kind) {
    if (name.length !== 1) this.ctWarn(`multiple letter name - ${name}`);
    let id = this.names.get(name);
    if (!id) { id = { a: 0, f: 0, v: 0 }; this.names.set(name, id); }
    switch (kind) {
      case ARRAY:
        if (id.a) return -id.a;
        id.a = this.nextArray++;
        if (id.a < MAX_STORE) { this.aNames[id.a] = name; return -id.a; }
        this.yyerror('Too many array variables'); this.exit(1);
        break;
      case FUNCT: case FUNCTDEF:
        if (id.f) {
          // redefining a math library function gives it a new number (and, as in bc, no name)
          if (this.useMath && kind === FUNCTDEF && id.f <= 6) id.f = this.nextFunc++;
          this.func(id.f);
          return id.f;
        }
        id.f = this.nextFunc++;
        if (id.f < MAX_STORE) { this.func(id.f); this.fNames[id.f] = name; return id.f; }
        this.yyerror('Too many functions'); this.exit(1);
        break;
      default:
        if (id.v) return id.v;
        id.v = this.nextVar++;
        if (id.v <= MAX_STORE) { this.vNames[id.v - 1] = name; return id.v; }
        this.yyerror('Too many variables'); this.exit(1);
    }
    return 0;
  }
  checkParams(params, autos) {
    if (params) {
      for (let i = 0; i < params.length; i++) {
        for (let j = i + 1; j < params.length; j++) if (params[j].name === params[i].name) this.yyerror('duplicate parameter names');
        if (params[i].isVar) this.ctWarn('Variable array parameter');
      }
    }
    if (autos) {
      for (let i = 0; i < autos.length; i++) {
        for (let j = i + 1; j < autos.length; j++) if (autos[j].name === autos[i].name) this.yyerror('duplicate auto variable names');
        if (autos[i].isVar) this.yyerror('* not allowed here');
      }
    }
    if (params && autos) for (const p of params) for (const a of autos) if (a.name === p.name) this.yyerror('variable in both parameter and auto lists');
  }

  // ------------------------------------------------------------ code generation and loading
  initGen() {
    this.breakLabel = 0; this.continueLabel = 0; this.nextLabel = 1; this.outCount = 2;
    if (this.compileOnly) this.rawOut('@i'); else this.initLoad();
    this.hadError = false; this.didGen = false;
  }
  generate(str) {
    this.didGen = true;
    if (this.compileOnly) {
      this.rawOut(str);
      this.outCount += str.length;
      if (this.outCount > 60) { this.rawOut('\n'); this.outCount = 0; }
    } else this.loadCode(str);
  }
  runCode() {
    if (!this.hadError && this.didGen) {
      if (this.compileOnly) { this.rawOut('@r\n'); this.outCount = 0; }
      else this.execute();
    }
    if (this.didGen) this.initGen(); else this.hadError = false;
  }
  clearFunc(i) { const f = this.func(i); f.defined = false; f.size = 0; f.autos = []; f.params = []; f.labels = []; }
  initLoad() { this.clearFunc(0); this.loadAdr = { func: 0, addr: 0 }; this.loadStr = false; this.loadConst = false; }
  addbyte(b) {
    if (this.hadError) return;
    const f = this.functions[this.loadAdr.func];
    f.body[this.loadAdr.addr++] = b & 0xff;
    f.size++;
  }
  addName(v) { if (v < 128) this.addbyte(v); else { this.addbyte(((v >> 8) & 0xff) | 0x80); this.addbyte(v & 0xff); } }
  loadCode(str) {
    let i = 0;
    const longVal = () => {
      let neg = false, v = 0;
      if (str[i] === '-') { neg = true; i++; }
      while (str[i] >= '0' && str[i] <= '9') v = v * 10 + (str.charCodeAt(i++) - 48);
      return neg ? -v : v;
    };
    while (i < str.length) {
      if (this.hadError) return;
      const c = str[i];
      if (this.loadStr) { if (c === '"') this.loadStr = false; this.addbyte(str.charCodeAt(i++)); continue; }
      if (this.loadConst) {
        if (c === '\n') i++;
        else if (c === ':') { this.loadConst = false; this.addbyte(58); i++; }
        else if (c === '.') { this.addbyte(46); i++; }
        else {
          if (c > 'F' && (this.warnNotStd || this.stdOnly)) {
            if (this.stdOnly) this.yyerror('Error in numeric constant');
            else this.ctWarn('Non-standard base in numeric constant');
          }
          const code = str.charCodeAt(i++);
          this.addbyte(c >= 'A' ? code + 10 - 65 : code - 48);
        }
        continue;
      }
      switch (c) {
        case '"': this.loadStr = true; break;
        case 'N': i++; this.functions[this.loadAdr.func].labels[longVal()] = this.loadAdr.addr; break;
        case 'B': case 'J': case 'Z': {
          this.addbyte(str.charCodeAt(i++));
          const lab = longVal();
          if (lab > 65535) { this.errOut('Program too big.\n'); this.exit(1); }
          this.addbyte(lab & 0xff); this.addbyte(lab >> 8);
          break;
        }
        case 'F': {
          i++;
          const fi = longVal();
          this.clearFunc(fi);
          const f = this.functions[fi];
          while (i < str.length && str[i++] !== '.') {
            if (str[i] === '.') { i++; break; }
            if (str[i] === '*') { i++; f.params = nextarg(f.params, longVal(), true); }
            else f.params = nextarg(f.params, longVal(), false);
          }
          while (i < str.length && str[i] !== '[') { if (str[i] === ',') i++; f.autos = nextarg(f.autos, longVal(), false); }
          this.saveAdr = { ...this.loadAdr };
          this.loadAdr = { func: fi, addr: 0 };
          break;
        }
        case ']': this.functions[this.loadAdr.func].defined = true; this.loadAdr = { ...this.saveAdr }; break;
        case 'C': {
          this.addbyte(67); i++;
          this.addName(longVal());
          if (str[i] === ',') i++;
          while (i < str.length && str[i] !== ':') this.addbyte(str.charCodeAt(i++));
          this.addbyte(58);
          break;
        }
        case 'c': this.addbyte(99); i++; this.addbyte(str.charCodeAt(i)); break;
        case 'K': this.addbyte(75); this.loadConst = true; break;
        case 'd': case 'i': case 'l': case 's': case 'A': case 'M': case 'L': case 'S':
          this.addbyte(str.charCodeAt(i++));
          this.addName(longVal());
          break;
        case '\n': break;
        default: this.addbyte(str.charCodeAt(i));
      }
      i++;
    }
  }

  // ------------------------------------------------------------ parser
  parse() {
    const { yypact, yydefact, yypgoto, yydefgoto, yytable, yycheck, yyr1, yyr2, yytranslate, YYFINAL, YYLAST, YYNTOKENS, YYPACT_NINF, YYMAXUTOK } = T;
    const YYEMPTY = -2, YYEOF = 0, YYTERROR = 1, YYUNDEFTOK = 2, YYMAXDEPTH = 10000;
    const ss = [0], vs = [undefined];
    let state = 0, yychar = YYEMPTY, yytoken = 0;
    this.errstatus = 0;
    for (;;) {
      if (state === YYFINAL) return 0;
      let yyn = yypact[state], act;
      if (yyn === YYPACT_NINF) act = 'default';
      else {
        if (yychar === YYEMPTY) yychar = this.scanner.lex();
        if (yychar <= YYEOF) yychar = yytoken = YYEOF;
        else yytoken = yychar <= YYMAXUTOK ? yytranslate[yychar] : YYUNDEFTOK;
        yyn += yytoken;
        if (yyn < 0 || yyn > YYLAST || yycheck[yyn] !== yytoken) act = 'default';
        else {
          yyn = yytable[yyn];
          if (yyn <= 0) { yyn = -yyn; act = yyn ? 'reduce' : 'error'; }
          else {
            if (this.errstatus) this.errstatus--;
            yychar = YYEMPTY;
            state = yyn;
            ss.push(state); vs.push(this.scanner.lval);
            if (ss.length >= YYMAXDEPTH) { this.yyerror('memory exhausted'); return 2; }
            continue;
          }
        }
      }
      if (act === 'default') { yyn = yydefact[state]; act = yyn ? 'reduce' : 'error'; }
      if (act === 'reduce') {
        const len = yyr2[yyn];
        const val = this.reduce(yyn - 1, vs, len, len ? vs[vs.length - len] : undefined);   // the C tables number rules from 1 past bison's listing
        ss.length -= len; vs.length -= len;
        vs.push(val);
        const lhs = yyr1[yyn] - YYNTOKENS, top = ss[ss.length - 1];
        const g = yypgoto[lhs] + top;
        state = g >= 0 && g <= YYLAST && yycheck[g] === top ? yytable[g] : yydefgoto[lhs];
        ss.push(state);
        if (ss.length >= YYMAXDEPTH) { this.yyerror('memory exhausted'); return 2; }
        continue;
      }
      // syntax error, then bison's recovery: pop to a state that can shift `error`
      if (!this.errstatus) this.yyerror('syntax error');
      if (this.errstatus === 3) {
        if (yychar <= YYEOF) { if (yychar === YYEOF) return 1; }
        else yychar = YYEMPTY;
      }
      this.errstatus = 3;
      for (;;) {
        yyn = yypact[state];
        if (yyn !== YYPACT_NINF) {
          yyn += YYTERROR;
          if (yyn >= 0 && yyn <= YYLAST && yycheck[yyn] === YYTERROR) { yyn = yytable[yyn]; if (yyn > 0) break; }
        }
        if (ss.length === 1) return 1;
        ss.pop(); vs.pop();
        state = ss[ss.length - 1];
      }
      vs.push(this.scanner.lval);
      state = yyn;
      ss.push(state);
      if (ss.length >= YYMAXDEPTH) { this.yyerror('memory exhausted'); return 2; }
    }
  }
  // the grammar's actions, by rule number (see the rule list bison prints for tools/bc-grammar.y)
  reduce(r, vs, len, dflt) {
    const base = MID_POS[r] !== undefined ? vs.length - MID_POS[r] : vs.length - len - 1;
    const $ = (i) => vs[base + i];
    const set = (i, v) => { vs[base + i] = v; };
    const gen = (s) => this.generate(s);
    const name = (v, local, arr) => (v < 0 ? `${arr}${-v}:` : `${local}${v}:`);
    let $$ = dflt;
    switch (r) {
      case 1: $$ = 0; if (this.interactive && !this.quiet) this.rawOut(VERSION + "This is free software with ABSOLUTELY NO WARRANTY.\nFor details type `warranty'. \n"); break;
      case 3: case 4: this.runCode(); break;
      case 5: this.errstatus = 0; this.initGen(); break;
      case 7: this.ctWarn('newline not allowed'); break;
      case 8: case 12: $$ = 0; break;
      case 19: $$ = $(2); break;
      case 20: this.rawOut('\n' + VERSION + WARRANTY); break;
      case 21: this.rawOut(`BC_BASE_MAX     = ${BC_BASE_MAX}\nBC_DIM_MAX      = ${BC_DIM_MAX}\nBC_SCALE_MAX    = ${BC_SCALE_MAX}\nBC_STRING_MAX   = 2147483647\nMAX Exponent    = ${LONG_MAX}\nNumber of vars  = ${MAX_STORE}\n`); break;
      case 22: if ($(1) & EX_COMP) this.ctWarn('comparison in expression'); gen($(1) & EX_REG ? 'W' : 'p'); break;
      case 23: $$ = 0; gen('w'); gen($(1)); break;
      case 24: if (this.breakLabel === 0) this.yyerror('Break outside a for/while'); else gen(`J${this.breakLabel}:`); break;
      case 25:
        this.ctWarn('Continue statement');
        if (this.continueLabel === 0) this.yyerror('Continue outside a for'); else gen(`J${this.continueLabel}:`);
        break;
      case 26: this.exit(0); break;
      case 27: gen('h'); break;
      case 28: gen('R'); break;
      case 29: set(1, this.breakLabel); this.breakLabel = this.nextLabel++; break;
      case 30: {
        const e = $(4);
        if (e & EX_COMP) this.ctWarn('Comparison in first for expression');
        if (e & EX_VOID) this.yyerror('first expression is void');
        if (!(e & EX_EMPTY)) gen('p');
        set(4, this.nextLabel++);
        gen(`N${$(4)}:`);
        break;
      }
      case 31: {
        const e = $(7);
        if (e & EX_VOID) this.yyerror('second expression is void');
        if (e & EX_EMPTY) gen('1');
        set(7, this.nextLabel++);
        gen(`B${$(7)}:J${this.breakLabel}:`);
        $$ = this.continueLabel;
        this.continueLabel = this.nextLabel++;
        gen(`N${this.continueLabel}:`);
        break;
      }
      case 32: {
        const e = $(10);
        if (e & EX_COMP) this.ctWarn('Comparison in third for expression');
        if (e & EX_VOID) this.yyerror('third expression is void');
        gen(`${e & EX_EMPTY ? '' : 'p'}J${$(4)}:N${$(7)}:`);
        break;
      }
      case 33: gen(`J${this.continueLabel}:N${this.breakLabel}:`); this.breakLabel = $(1); this.continueLabel = $(9); break;
      case 34:
        if ($(3) & EX_VOID) this.yyerror('void expression');
        set(3, this.ifLabel); this.ifLabel = this.nextLabel++; gen(`Z${this.ifLabel}:`);
        break;
      case 35: gen(`N${this.ifLabel}:`); this.ifLabel = $(3); break;
      case 36: set(1, this.continueLabel); this.continueLabel = this.nextLabel++; gen(`N${this.continueLabel}:`); break;
      case 37:
        if ($(4) & EX_VOID) this.yyerror('void expression');
        set(4, this.breakLabel); this.breakLabel = this.nextLabel++; gen(`Z${this.breakLabel}:`);
        break;
      case 38: gen(`J${this.continueLabel}:N${this.breakLabel}:`); this.breakLabel = $(4); this.continueLabel = $(1); break;
      case 39: $$ = 0; break;
      case 40: this.ctWarn('print statement'); break;
      case 44: gen('O'); gen($(1)); break;
      case 45: if ($(1) & EX_VOID) this.yyerror('void expression in print'); gen('P'); break;
      case 47:
        this.ctWarn('else clause in if statement');
        set(1, this.nextLabel++); gen(`J${$(1)}:N${this.ifLabel}:`); this.ifLabel = $(1);
        break;
      case 49: {
        this.checkParams($(5), $(10));
        const params = argStr($(5)), autos = argStr($(10));
        this.curFunc = this.lookup($(3), FUNCTDEF);
        gen(`F${this.curFunc},${params}.${autos}[`);
        this.functions[this.curFunc].isVoid = !!$(2);
        set(1, this.nextLabel); this.nextLabel = 1;
        break;
      }
      case 50: gen('0R]'); this.nextLabel = $(1); this.curFunc = -1; break;
      case 51: $$ = 0; break;
      case 52: $$ = 1; this.ctWarn('void functions'); break;
      case 53: case 55: case 66: $$ = null; break;
      case 56: case 57: $$ = $(2); break;
      case 58: $$ = nextarg(null, this.lookup($(1), SIMPLE), false); break;
      case 59: $$ = nextarg(null, this.lookup($(1), ARRAY), false); break;
      case 60: case 61: $$ = nextarg(null, this.lookup($(2), ARRAY), true); this.ctWarn('Call by variable arrays'); break;
      case 62: $$ = nextarg($(1), this.lookup($(3), SIMPLE), false); break;
      case 63: $$ = nextarg($(1), this.lookup($(3), ARRAY), false); break;
      case 64: case 65: $$ = nextarg($(1), this.lookup($(4), ARRAY), true); this.ctWarn('Call by variable arrays'); break;
      case 68: case 70: {
        const e = r === 68 ? $(1) : $(3);
        if (e & EX_COMP) this.ctWarn('comparison in argument');
        if (e & EX_VOID) this.yyerror('void argument');
        $$ = nextarg(r === 68 ? null : $(1), 0, false);
        break;
      }
      case 69: gen(`K${-this.lookup($(1), ARRAY)}:`); $$ = nextarg(null, 1, false); break;
      case 71: gen(`K${-this.lookup($(3), ARRAY)}:`); $$ = nextarg($(1), 1, false); break;
      case 72: $$ = EX_EMPTY; this.ctWarn('Missing expression in for statement'); break;
      case 74: $$ = 0; gen('0'); if (this.curFunc === -1) this.yyerror('Return outside of a function.'); break;
      case 75: {
        const e = $(1);
        if (e & EX_COMP) this.ctWarn('comparison in return expresion');
        if (!(e & EX_PAREN)) this.ctWarn('return expression requires parenthesis');
        if (e & EX_VOID) this.yyerror('return requires non-void expression');
        if (this.curFunc === -1) this.yyerror('Return outside of a function.');
        else if (this.functions[this.curFunc].isVoid) this.yyerror('Return expression in a void function.');
        break;
      }
      case 76: if ($(2) !== '=') gen(name($(1), 'l', 'DL')); break;
      case 77:
        if ($(4) & EX_VOID) this.yyerror('Assignment of a void expression');
        if ($(2) !== '=') gen($(2));
        gen(name($(1), 's', 'S'));
        $$ = EX_ASSGN;
        break;
      case 78: this.ctWarn('&& operator'); set(2, this.nextLabel++); gen(`DZ${$(2)}:p`); break;
      case 79:
        if (($(1) & EX_VOID) || ($(4) & EX_VOID)) this.yyerror('void expression with &&');
        gen(`DZ${$(2)}:p1N${$(2)}:`);
        $$ = ($(1) | $(4)) & ~EX_PAREN;
        break;
      case 80: this.ctWarn('|| operator'); set(2, this.nextLabel++); gen(`B${$(2)}:`); break;
      case 81: {
        if (($(1) & EX_VOID) || ($(4) & EX_VOID)) this.yyerror('void expression with ||');
        const t = this.nextLabel++;
        gen(`B${$(2)}:0J${t}:N${$(2)}:1N${t}:`);
        $$ = ($(1) | $(4)) & ~EX_PAREN;
        break;
      }
      case 82:
        if ($(2) & EX_VOID) this.yyerror('void expression with !');
        $$ = $(2) & ~EX_PAREN;
        this.ctWarn('! operator');
        gen('!');
        break;
      case 83: {
        if (($(1) & EX_VOID) || ($(3) & EX_VOID)) this.yyerror('void expression with comparison');
        $$ = EX_REG | EX_COMP;
        const op = $(2);
        gen(op[0] === '=' ? '=' : op[0] === '!' ? '#' : op[0] === '<' ? (op[1] === '=' ? '{' : '<') : op[1] === '=' ? '}' : '>');
        break;
      }
      case 84: case 85: case 86: case 87: case 88: case 89: {
        const op = '+-*/%^'[r - 84];
        if (($(1) & EX_VOID) || ($(3) & EX_VOID)) this.yyerror(`void expression with ${op}`);
        gen(op);
        $$ = ($(1) | $(3)) & ~EX_PAREN;
        break;
      }
      case 90: if ($(2) & EX_VOID) this.yyerror('void expression with unary -'); gen('n'); $$ = $(2) & ~EX_PAREN; break;
      case 91: $$ = EX_REG; gen(name($(1), 'l', 'L')); break;
      case 92: {
        $$ = EX_REG;
        const n = $(1);
        if (n === '0') gen('0');
        else if (n === '1') gen('1');
        else { gen('K'); gen(n); gen(':'); }
        break;
      }
      case 93: if ($(2) & EX_VOID) this.yyerror('void expression in parenthesis'); $$ = $(2) | EX_REG | EX_PAREN; break;
      case 94: {
        const fn = this.lookup($(1), FUNCT);
        $$ = this.functions[fn].isVoid ? EX_VOID : EX_REG;
        gen($(3) ? `C${fn},${callStr($(3))}:` : `C${fn}:`);
        break;
      }
      case 95: {
        $$ = EX_REG;
        const v = $(2), up = $(1) === '+';
        gen(v < 0 ? `${up ? 'DA' : 'DM'}${-v}:L${-v}:` : `${up ? 'i' : 'd'}${v}:l${v}:`);
        break;
      }
      case 96: {
        $$ = EX_REG;
        const v = $(1), up = $(2) === '+';
        if (v < 0) { gen(`DL${-v}:x`); gen(`${up ? 'A' : 'M'}${-v}:`); }
        else { gen(`l${v}:`); gen(`${up ? 'i' : 'd'}${v}:`); }
        break;
      }
      case 97: if ($(3) & EX_VOID) this.yyerror('void expression in length()'); gen('cL'); $$ = EX_REG; break;
      case 98: if ($(3) & EX_VOID) this.yyerror('void expression in sqrt()'); gen('cR'); $$ = EX_REG; break;
      case 99: if ($(3) & EX_VOID) this.yyerror('void expression in scale()'); gen('cS'); $$ = EX_REG; break;
      case 100: this.ctWarn('read function'); gen('cI'); $$ = EX_REG; break;
      case 101: this.ctWarn('random function'); gen('cX'); $$ = EX_REG; break;
      case 102: $$ = this.lookup($(1), SIMPLE); break;
      case 103:
        if ($(3) & EX_VOID) this.yyerror('void expression as subscript');
        if ($(3) & EX_COMP) this.ctWarn('comparison in subscript');
        $$ = this.lookup($(1), ARRAY);
        break;
      case 104: $$ = 0; break;
      case 105: $$ = 1; break;
      case 106: $$ = 2; break;
      case 107: $$ = 3; this.ctWarn('History variable'); break;
      case 108: $$ = 4; this.ctWarn('Last variable'); break;
      case 109: this.ctWarn('End of line required'); break;
      case 111: this.ctWarn('Too many end of lines'); break;
    }
    return $$;
  }

  // ------------------------------------------------------------ the machine
  byte() { const p = this.pc; const b = this.functions[p.func].body[p.addr++]; return b === undefined ? 255 : b; }
  operand() { let v = this.byte(); if (v & 0x80) v = ((v & 0x7f) << 8) + this.byte(); return v; }
  get top() { return this.ex[this.ex.length - 1]; }
  set top(v) { this.ex[this.ex.length - 1] = v; }
  push(n) { this.ex.push(n); }
  pop() { this.ex.pop(); }
  checkStack(n) { if (this.ex.length < n) { this.rtError('Stack error.'); return false; } return true; }
  fpop() { if (this.fn.length) return this.fn.pop(); this.rtError('function stack underflow, contact maintainer.'); return 0; }
  varStack(i) { return this.variables[i] ??= []; }
  arrayMap(ix) {
    const st = this.arrays[ix] ??= [];
    if (!st.length) st.push({ val: null, param: false });
    const top = st[st.length - 1];
    return (top.val ??= new Map());
  }
  subscript(n) {
    const idx = num2long(n);
    if (idx < 0n || idx > BigInt(BC_DIM_MAX) || (idx === 0n && !isZero(n))) return -1;
    return Number(idx);
  }
  outOfBounds(name) { this.rtError(`Array ${this.aNames[name] ?? '(null)'} subscript out of bounds.`); }
  storeVar(n) {
    const top = this.top;
    if (n > 3) { const st = this.varStack(n); if (st.length) st[st.length - 1] = top; else st.push(top); return; }
    let toobig = false, temp = 0n;
    if (top.neg) {
      if (n === 0) { this.rtWarn('negative ibase, set to 2'); temp = 2n; }
      else if (n === 1) { this.rtWarn('negative obase, set to 2'); temp = 2n; }
      else if (n === 2) { this.rtWarn('negative scale, set to 0'); temp = 0n; }
      else temp = -1n;
    } else {
      temp = num2long(top);
      if (!isZero(top) && temp === 0n) toobig = true;
    }
    if (n === 0) {
      if (temp < 2n && !toobig) { this.iBase = 2; this.rtWarn('ibase too small, set to 2'); }
      else if (temp > 16n || toobig) {
        if (this.stdOnly) { this.iBase = 16; this.rtWarn('ibase too large, set to 16'); }
        else if (temp > 36n || toobig) { this.iBase = 36; this.rtWarn('ibase too large, set to 36'); }
        else { if (temp >= 16n && this.warnNotStd) this.rtWarn('ibase larger than 16 is non-standard'); this.iBase = Number(temp); }
      } else this.iBase = Number(temp);
    } else if (n === 1) {
      if (temp < 2n && !toobig) { this.oBase = 2; this.rtWarn('obase too small, set to 2'); }
      else if (temp > BigInt(BC_BASE_MAX) || toobig) { this.oBase = BC_BASE_MAX; this.rtWarn(`obase too large, set to ${BC_BASE_MAX}`); }
      else this.oBase = Number(temp);
    } else if (n === 2) {
      if (temp > BigInt(BC_SCALE_MAX) || toobig) { this.scale = BC_SCALE_MAX; this.rtWarn(`scale too large, set to ${BC_SCALE_MAX}`); }
      else this.scale = Number(temp);
    } else if (toobig) { this.nHistory = -1; this.rtWarn('history too large, set to unlimited'); }
    else this.nHistory = Number(temp);
  }
  loadVar(n) {
    switch (n) {
      case 0: this.push(int2num(this.iBase)); return;
      case 1: this.push(int2num(this.oBase)); return;
      case 2: this.push(int2num(this.scale)); return;
      case 3: this.push(int2num(this.nHistory)); return;
    }
    const st = this.variables[n];
    this.push(st && st.length ? st[st.length - 1] : ZERO);
  }
  incrVar(n, up) {
    if (n === 0) { if (up ? this.iBase < 16 : this.iBase > 2) this.iBase += up ? 1 : -1; else this.rtWarn(up ? 'ibase too big in ++' : 'ibase too small in --'); return; }
    if (n === 1) { if (up ? this.oBase < BC_BASE_MAX : this.oBase > 2) this.oBase += up ? 1 : -1; else this.rtWarn(up ? 'obase too big in ++' : 'obase too small in --'); return; }
    if (n === 2) { if (up ? this.scale < BC_SCALE_MAX : this.scale > 0) this.scale += up ? 1 : -1; else this.rtWarn(up ? 'Scale too big in ++' : 'scale can not be negative in -- '); return; }
    if (n === 3) {
      this.nHistory += up ? 1 : -1;
      if (up ? this.nHistory <= 0 : this.nHistory < 0) { this.nHistory = -1; this.rtWarn(up ? 'history set to unlimited' : 'history is negative, set to unlimited'); }
      return;
    }
    const st = this.varStack(n);
    if (!st.length) st.push(ZERO);
    st[st.length - 1] = (up ? bcAdd : bcSub)(st[st.length - 1], ONE, 0);
  }
  arrayOp(name, op) {
    if (!this.checkStack(op === 'store' ? 2 : 1)) return;
    const idxNum = op === 'store' ? this.ex[this.ex.length - 2] : this.top;
    const idx = this.subscript(idxNum);
    if (idx < 0) { this.outOfBounds(name); return; }
    const m = this.arrayMap(name);
    if (op === 'store') { const v = this.top; m.set(idx, v); this.pop(); this.top = v; return; }
    this.pop();
    const cur = m.get(idx) ?? ZERO;
    if (op === 'load') this.push(cur);
    else m.set(idx, (op === 'incr' ? bcAdd : bcSub)(cur, ONE, 0));
  }
  autoVar(name) {
    if (name > 0) this.varStack(name).push(ZERO);
    else (this.arrays[-name] ??= []).push({ val: null, param: false });
  }
  popVars(list) {
    for (const a of list) {
      if (a.name > 0) { const st = this.variables[a.name]; if (st && st.length) st.pop(); }
      else { const st = this.arrays[-a.name]; if (st && st.length) st.pop(); }
    }
  }
  processParams(fi) {
    const params = this.functions[fi].params;
    let k = 0, lost = false;
    for (;;) {
      const ch = this.byte();
      if (ch === B_COLON) break;
      if (lost) { this.pop(); continue; }   // bc has walked off its parameter list by now
      if (k >= params.length) { this.rtError('Parameter number mismatch'); return; }
      const p = params[k];
      if (ch === 48 && p.name > 0) {
        this.varStack(p.name).push(this.top);
        this.top = ZERO;
      } else if (ch === 49 && p.name < 0) {
        const ix = Number(num2long(this.top));
        this.arrayMap(ix);
        this.autoVar(p.name);
        const ix1 = -p.name;
        const srcSt = this.arrays[ix];
        const src = ix === ix1 ? srcSt[srcSt.length - 2] : srcSt[srcSt.length - 1];
        const destSt = this.arrays[ix1], dest = destSt[destSt.length - 1];
        if (p.isVar) { dest.param = true; dest.val = src.val; }
        else { dest.param = false; dest.val = new Map(src.val); }
      } else {
        if (p.name < 0) this.rtError(`Parameter type mismatch parameter ${this.aNames[-p.name] ?? '(null)'}.`);
        else this.rtError(`Parameter type mismatch, parameter ${this.vNames[p.name] ?? '(null)'}.`);
        lost = true;
      }
      this.pop();
      k++;
    }
    if (lost || k < params.length) this.rtError('Parameter number mismatch');
  }
  // a constant stored in the code, in base 10
  pushB10Const() {
    const body = this.functions[this.pc.func].body;
    let look = this.pc.addr, kdigits = 0, kscale = 0;
    let ch = body[look++] ?? 255;
    while (ch !== B_DOT && ch !== B_COLON && ch !== 255) { kdigits++; ch = body[look++] ?? 255; }
    if (ch === B_DOT) { ch = body[look++] ?? 255; while (ch !== B_COLON && ch !== 255) { kscale++; ch = body[look++] ?? 255; } }
    ch = this.byte();
    if (kdigits === 1 && kscale === 0) {
      if (ch === 0) { this.push(ZERO); this.byte(); return; }
      if (ch === 1) { this.push(ONE); this.byte(); return; }
      if (ch > 9) { this.push(int2num(ch)); this.byte(); return; }
    }
    let digits = kdigits === 0 ? '0' : '';
    while (ch !== B_COLON && ch !== 255) {
      if (ch !== B_DOT) digits += ch > 9 ? '9' : String(ch);
      ch = this.byte();
    }
    this.push(new Num(BigInt(digits), kscale));
  }
  // a constant in another base (from the code), or a number typed for read()
  pushConstant(next, base) {
    const tick = () => this.ctx.tick();
    const mult = int2num(base);
    let build = ZERO, negative = false;
    let ch = next();
    while (ch === B_TILDE) { tick(); ch = next(); }
    if (ch === 43) ch = next();
    else if (ch === 45) { negative = true; ch = next(); }
    if (ch < 36) {
      let first = ch;
      ch = next();
      if (ch < 36 && first >= base) first = base - 1;
      build = int2num(first);
    }
    while (ch < 36) {
      if (ch >= base) ch = base - 1;
      build = bcAdd(bcMul(build, mult, 0), int2num(ch), 0);
      ch = next();
    }
    if (ch === B_DOT) {
      ch = next();
      if (ch >= base) ch = base - 1;
      let result = ZERO, divisor = ONE, digits = 0;
      while (ch < 36) {
        result = bcAdd(bcMul(result, mult, 0), int2num(ch), 0);
        divisor = bcMul(divisor, mult, 0);
        digits++;
        ch = next();
        if (ch < 36 && ch >= base) ch = base - 1;
      }
      build = bcAdd(build, bcDiv(result, divisor, digits), 0);
    }
    if (negative) build = bcSub(ZERO, build, 0);
    this.push(build);
  }
  inputChar() {
    let c = this.getchar();
    if (c === 92) { c = this.getchar(); if (c === 10) { c = this.getchar(); this.outCol = 0; } }
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 65 && c <= 90) return c + 10 - 65;
    if (c >= 97 && c <= 122) return c + 10 - 97;
    if (c === 46 || c === 43 || c === 45) return c;
    if (c === 126) return B_COLON;
    if (c <= 32) return B_TILDE;
    return B_COLON;
  }
  binary(fn) {
    if (!this.checkStack(2)) return;
    const r = fn(this.ex[this.ex.length - 2], this.top);
    this.pop(); this.top = r;
  }
  compareOp(test) { this.binary((a, b) => (test(compare(a, b)) ? ONE : ZERO)); }
  execute() {
    const pc = this.pc;
    pc.func = 0; pc.addr = 0;
    this.runtimeError = false;
    const tick = () => this.ctx.tick();
    while (pc.addr < this.functions[pc.func].size && !this.runtimeError) {
      const inst = this.byte();
      switch (inst) {
        case 65: this.arrayOp(this.operand(), 'incr'); break;                  // A
        case 66: case 90: case 74: {                                           // B Z J
          let take = true;
          if (inst !== 74) { const c = !isZero(this.top); this.pop(); take = inst === 66 ? c : !c; }
          const lab = this.byte() + (this.byte() << 8);
          if (take) {
            tick();
            const adr = this.functions[pc.func].labels[lab];
            if (adr === undefined) { this.rtError('Internal error.'); break; }
            pc.addr = adr;
          }
          break;
        }
        case 67: {                                                             // C
          const fi = this.operand();
          tick();
          const f = this.functions[fi];
          if (!f || !f.defined) { this.rtError(`Function ${this.fNames[fi] ?? '(null)'} not defined.`); break; }
          this.processParams(fi);
          for (const a of f.autos) this.autoVar(a.name);
          if (this.fn.length > 3_000_000) throw new BcFatal('Fatal error: Out of memory for malloc.');
          this.fn.push(pc.func, pc.addr, this.iBase);
          pc.func = fi; pc.addr = 0;
          break;
        }
        case 68: this.push(this.top); break;                                   // D
        case 75: {                                                             // K
          const base = pc.func === 0 ? this.iBase : this.fn[this.fn.length - 1];
          if (base === 10) this.pushB10Const(); else this.pushConstant(() => this.byte(), base);
          break;
        }
        case 76: this.arrayOp(this.operand(), 'load'); break;                  // L
        case 77: this.arrayOp(this.operand(), 'decr'); break;                  // M
        case 79: {                                                             // O
          let ch;
          while ((ch = this.byte()) !== 34 && ch !== 255) {
            if (ch !== 92) { this.outSchar(String.fromCharCode(ch)); continue; }
            ch = this.byte();
            if (ch === 34) break;
            const esc = { 97: '\x07', 98: '\b', 102: '\f', 110: '\n', 113: '"', 114: '\r', 116: '\t', 92: '\\' }[ch];
            if (esc !== undefined) this.outSchar(esc);
          }
          this.flush();
          break;
        }
        case 82:                                                               // R
          if (pc.func !== 0) {
            const f = this.functions[pc.func];
            this.popVars(f.autos); this.popVars(f.params);
            this.fpop(); pc.addr = this.fpop(); pc.func = this.fpop();
          } else this.rtError('Return from main program.');
          break;
        case 83: this.arrayOp(this.operand(), 'store'); break;                 // S
        case 84: this.top = isZero(this.top) ? ONE : ZERO; break;              // T
        case 87: case 80:                                                      // W P
          outNum(this.top, this.oBase, (ch) => this.outChar(ch));
          if (inst === 87) this.outChar('\n');
          this.storeVar(4);
          this.flush();
          this.pop();
          break;
        case 99: {                                                             // c
          const sub = this.byte();
          if (sub === 76) {                                                    // length
            const t = this.top;
            this.top = int2num(nLen(t) === 1 && t.s !== 0 && intPart(t) === 0n ? t.s : nLen(t) + t.s);
          } else if (sub === 83) this.top = int2num(this.top.s);               // scale
          else if (sub === 82) {                                               // sqrt
            const r = bcSqrt(this.top, this.scale, tick);
            if (r === null) this.rtError('Square root of a negative number'); else this.top = r;
          } else if (sub === 73) this.pushConstant(() => this.inputChar(), this.iBase);   // read
          else if (sub === 88) this.push(int2num(Math.floor(Math.random() * 2147483648)));   // random
          break;
        }
        case 100: this.incrVar(this.operand(), false); break;                  // d
        case 104: this.exit(0); break;                                         // h
        case 105: this.incrVar(this.operand(), true); break;                   // i
        case 108: this.loadVar(this.operand()); break;                         // l
        case 110: this.top = bcSub(ZERO, this.top, 0); break;                  // n
        case 112: this.pop(); break;                                           // p
        case 115: this.storeVar(this.operand()); break;                        // s
        case 119: {                                                            // w
          let ch;
          while ((ch = this.byte()) !== 34 && ch !== 255) this.outSchar(String.fromCharCode(ch));
          this.flush();
          break;
        }
        case 120:                                                              // x
          if (this.checkStack(2)) { const n = this.ex.length; [this.ex[n - 1], this.ex[n - 2]] = [this.ex[n - 2], this.ex[n - 1]]; }
          break;
        case 48: this.push(ZERO); break;                                       // 0
        case 49: this.push(ONE); break;                                        // 1
        case 33: this.top = isZero(this.top) ? ONE : ZERO; break;              // !
        case 38: this.binary((a, b) => (!isZero(a) && !isZero(b) ? ONE : ZERO)); break;   // &
        case 124: this.binary((a, b) => (!isZero(a) || !isZero(b) ? ONE : ZERO)); break;  // |
        case 43: this.binary((a, b) => bcAdd(a, b, 0)); break;
        case 45: this.binary((a, b) => bcSub(a, b, 0)); break;
        case 42: this.binary((a, b) => bcMul(a, b, this.scale)); break;
        case 47:
          if (this.checkStack(2)) {
            const r = bcDiv(this.ex[this.ex.length - 2], this.top, this.scale);
            if (r === null) this.rtError('Divide by zero'); else { this.pop(); this.top = r; }
          }
          break;
        case 37:
          if (this.checkStack(2)) {
            if (isZero(this.top)) this.rtError('Modulo by zero');
            else { const r = bcMod(this.ex[this.ex.length - 2], this.top, this.scale); this.pop(); this.top = r; }
          }
          break;
        case 94:
          if (this.checkStack(2)) {
            const a = this.ex[this.ex.length - 2], b = this.top;
            const r = bcRaise(a, b, this.scale, this.rt) ?? ZERO;
            if (isZero(a) && b.neg) this.rtError('divide by zero');
            this.pop(); this.top = r;
          }
          break;
        case 61: this.compareOp((c) => c === 0); break;                        // =
        case 35: this.compareOp((c) => c !== 0); break;                        // #
        case 60: this.compareOp((c) => c === -1); break;                       // <
        case 123: this.compareOp((c) => c <= 0); break;                        // {
        case 62: this.compareOp((c) => c === 1); break;                        // >
        case 125: this.compareOp((c) => c >= 0); break;                        // }
        default: this.rtError(`bad instruction: inst=${String.fromCharCode(inst)}`);
      }
    }
    while (pc.func !== 0) {
      const f = this.functions[pc.func];
      this.popVars(f.autos); this.popVars(f.params);
      this.fpop(); pc.addr = this.fpop(); pc.func = this.fpop();
    }
    this.ex.length = 0;
  }

  // ------------------------------------------------------------ main
  parseArgs(argv) {
    const r = getopt(argv.slice(1), {
      name: argv[0], short: 'chilqswv',
      long: { compile: 'c', help: 'h', interactive: 'i', mathlib: 'l', quiet: 'q', standard: 's', version: 'v', warn: 'w' },
    }, { permute: this.ctx.env.POSIXLY_CORRECT === undefined });
    for (const [k] of r.opts) {
      switch (k) {
        case 'c': this.compileOnly = true; break;
        case 'h': this.rawOut(USAGE(argv[0])); this.exit(0); break;
        case 'i': this.interactive = true; break;
        case 'l': this.useMath = true; break;
        case 'q': this.quiet = true; break;
        case 's': this.stdOnly = true; break;
        case 'v': this.rawOut(VERSION); this.exit(0); break;
        case 'w': this.warnNotStd = true; break;
      }
    }
    if (r.error) { this.errOut(r.error + '\n'); this.rawOut(USAGE(argv[0])); this.exit(1); }
    this.fileNames.push(...r.operands);
  }
  main() {
    const env = this.ctx.env;
    if (env.BC_ENV_ARGS !== undefined) this.parseArgs(['BC_ENV_ARGS', ...env.BC_ENV_ARGS.split(' ').filter(Boolean)]);
    this.parseArgs(this.ctx.argv);
    if (env.POSIXLY_CORRECT !== undefined) this.stdOnly = true;
    if (env.BC_LINE_LENGTH !== undefined) {
      const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(env.BC_LINE_LENGTH);
      this.lineSize = m ? Math.max(-2147483648, Math.min(2147483647, Number(m[1]))) : 0;
      if (this.lineSize < 3 && this.lineSize !== 0) this.lineSize = 70;
    }
    this.initGen();
    if (!this.openNewFile()) this.exit(1);
    this.parse();
    if (this.compileOnly) this.rawOut('\n');
    this.exit(0);
  }
}

C.bc = (ctx) => {
  const bc = new GnuBc(ctx);
  try { bc.main(); return 0; }
  catch (e) {
    if (e instanceof BcExit) { bc.flush(); return e.code; }
    if (e instanceof BcFatal) { bc.errOut(e.message + '\n'); return 1; }
    try { bc.flush(); } catch { /* the output is already gone */ }
    throw e;
  }
};

// ---------------------------------------------------------------- dc (RPN calculator, common subset)
function parseNumLit(text, ibase) {
  const [ip, fp = ''] = text.split('.');
  const val = (c) => (c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55);
  const b = BigInt(ibase);
  let iv = 0n;
  for (const c of ip) iv = iv * b + BigInt(val(c));
  if (!fp) return new Num(iv, 0);
  let num = 0n, den = 1n;
  for (const c of fp) { num = num * b + BigInt(val(c)); den *= b; }
  return new Num(iv * P10(fp.length) + (num * P10(fp.length)) / den, fp.length);
}
function toStr(a, obase, lineLen) {
  let out = '', col = 0;
  outNum(a, obase, (ch) => {
    col++;
    if (col === lineLen - 1 && lineLen) { out += '\\\n'; col = 1; }
    out += ch;
  });
  return out;
}
C.dc = (ctx) => {
  const argv = ctx.argv.slice(1);
  let src = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-e' || argv[i] === '--expression') src += argv[++i] + '\n';
    else if (argv[i].startsWith('-e')) src += argv[i].slice(2) + '\n';
    else if (argv[i] === '-f') src += ctx.readFile(argv[++i]);
    else { try { src += ctx.readFile(argv[i]); } catch (e) { ctx.err(`Could not open file ${argv[i]}`); return 1; } }
  }
  if (!argv.length) src = ctx.stdin.readAll();
  const stack = [];
  const regs = new Map();
  let scale = 0, ibase = 10, obase = 10;
  const rt = { warn() {}, error() {} };
  const pop = () => { if (!stack.length) { ctx.err('stack empty'); return null; } return stack.pop(); };
  const run = (code) => {
    let k = 0;
    while (k < code.length) {
      ctx.tick();
      const c = code[k];
      if (/[0-9A-F_.]/.test(c)) {
        let j = k;
        while (j < code.length && /[0-9A-F._]/.test(code[j])) j++;
        let t = code.slice(k, j).replace(/^_/, '-');
        const neg = t.startsWith('-');
        if (neg) t = t.slice(1);
        const n = parseNumLit(t, ibase);
        stack.push(neg ? new Num(-n.v, n.s) : n);
        k = j; continue;
      }
      k++;
      switch (c) {
        case ' ': case '\n': case '\t': break;
        case '+': case '-': case '*': case '/': case '%': case '^': {
          const b = pop(), a = pop();
          if (!a || !b) break;
          const r = c === '+' ? bcAdd(a, b) : c === '-' ? bcSub(a, b) : c === '*' ? bcMul(a, b, scale)
            : c === '/' ? bcDiv(a, b, scale) : c === '%' ? bcMod(a, b, scale) : bcRaise(a, b, scale, rt);
          if (r === null) { ctx.err(c === '/' ? 'divide by zero' : 'remainder by zero'); stack.push(a, b); }
          else stack.push(r);
          break;
        }
        case 'v': { const a = pop(); if (!a) break; const r = bcSqrt(a, scale, () => ctx.tick()); if (r === null) { ctx.err('square root of negative number'); stack.push(a); } else stack.push(r); break; }
        case 'p': if (stack.length) ctx.out(toStr(stack[stack.length - 1], obase, 70) + '\n'); else ctx.err('stack empty'); break;
        case 'n': { const a = pop(); if (a) ctx.out(toStr(a, obase, 70)); break; }
        case 'f': for (let s = stack.length - 1; s >= 0; s--) ctx.out(toStr(stack[s], obase, 70) + '\n'); break;
        case 'c': stack.length = 0; break;
        case 'd': if (stack.length) stack.push(stack[stack.length - 1]); break;
        case 'r': if (stack.length > 1) { const a = stack.pop(), b = stack.pop(); stack.push(a, b); } break;
        case 'z': stack.push(Num.int(stack.length)); break;
        case 'k': { const a = pop(); if (a) scale = Number(num2long(a)); break; }
        case 'i': { const a = pop(); if (a) ibase = Number(num2long(a)); break; }
        case 'o': { const a = pop(); if (a) obase = Number(num2long(a)); break; }
        case 'K': stack.push(Num.int(scale)); break;
        case 's': { const r = code[k++]; const a = pop(); if (a) regs.set(r, a); break; }
        case 'l': { const r = code[k++]; stack.push(regs.get(r) || ZERO); break; }
        case 'q': return 'quit';
        case '[': { let depth = 1, j = k; while (j < code.length && depth) { if (code[j] === '[') depth++; else if (code[j] === ']') depth--; j++; } stack.push({ str: code.slice(k, j - 1) }); k = j; break; }
        case 'x': { const a = pop(); if (a && a.str !== undefined) { if (run(a.str) === 'quit') return 'quit'; } else if (a) stack.push(a); break; }
        case '#': while (k < code.length && code[k] !== '\n') k++; break;
        default: ctx.err(`'${c}' (0${c.charCodeAt(0).toString(8)}) unimplemented`);
      }
    }
    return null;
  };
  try { run(src); } catch (e) { if (e instanceof BcFatal) { ctx.stderr.write(e.message + '\n'); return 1; } throw e; }
  return 0;
};

export default C;
