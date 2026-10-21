// Bash arithmetic ($(( )), (( )), let, subscripts) with 64-bit wraparound, evaluated the way bash
// does it: in one pass with a single token of lookahead, variables read (and their values
// evaluated as expressions) as soon as their token is scanned, short-circuited operands parsed
// but not evaluated, and errors that quote the expression being evaluated and the token the
// scanner had reached.

export class ArithError extends Error {
  constructor(msg, expr, token) { super(msg); this.expr = expr; this.token = token; }
  // bash: "[NAME: ]EXPR: MESSAGE (error token is "TOKEN")"
  text(name = null) { return `${name ? name + ': ' : ''}${this.expr}: ${this.message} (error token is "${this.token}")`; }
}

const wrap = (v) => BigInt.asIntN(64, v);
const INTMAX_MIN = -(2n ** 63n);
const MAX_DEPTH = 1024;
const isWs = (c) => c === ' ' || c === '\t';
const isCrWs = (c) => c === ' ' || c === '\t' || c === '\n';
const isDigit = (c) => c !== undefined && c >= '0' && c <= '9';
const isAlpha = (c) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
const isVarStart = (c) => isAlpha(c) || c === '_';
const isVarChar = (c) => isVarStart(c) || isDigit(c);
const isNumChar = (c) => isAlpha(c) || isDigit(c) || c === '_' || c === '@';
const ARITHOP = new Set(['=', '>', '<', '+', '-', '*', '/', '%', '!', '(', ')', '&', '|', '^', '~', '?', ':', ',']);
const MULTIOP = new Set(['==', '!=', '<=', '>=', '&&', '||', '<<', '>>', 'OPASSIGN', 'COND', '**', 'PREINC', 'PREDEC', 'POSTINC', 'POSTDEC']);

// index of the `]` closing the subscript that starts at s[i] === '[', or -1
function skipSubscript(s, i) {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') { k++; continue; }
    if (c === "'" || c === '"') { const e = s.indexOf(c, k + 1); if (e < 0) return -1; k = e; continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return k;
  }
  return -1;
}

// env: get(name, subscript|null, lval) -> string|undefined (may record lval.key, the resolved
// element), set(name, subscript|null, value, key)
class Evaluator {
  constructor(env) { this.env = env; this.noeval = 0; this.depth = 0; this.c = null; }

  // end: bash cuts the expression short at the end of a number while converting it
  error(msg, end = undefined) {
    const c = this.c;
    const expr = end === undefined ? c.expr : c.expr.slice(0, end);
    let t = 0;
    while (t < expr.length && isWs(expr[t])) t++;
    throw new ArithError(msg, expr.slice(t), c.lasttp !== null && c.lasttp < expr.length ? expr.slice(c.lasttp) : '');
  }
  save() { const c = this.c; return { curtok: c.curtok, lasttok: c.lasttok, tp: c.tp, lasttp: c.lasttp, tokval: c.tokval, tokstr: c.tokstr, noeval: this.noeval, lval: c.lval }; }
  restore(s) { const c = this.c; c.curtok = s.curtok; c.lasttok = s.lasttok; c.tp = s.tp; c.lasttp = s.lasttp; c.tokval = s.tokval; c.tokstr = s.tokstr; this.noeval = s.noeval; c.lval = s.lval; }

  subexpr(expr) {
    let p = 0;
    while (p < expr.length && isCrWs(expr[p])) p++;
    if (p >= expr.length) return 0n;
    if (this.depth >= MAX_DEPTH) this.error('expression recursion level exceeded');
    const outer = this.c;
    this.depth++;
    this.c = { expr, tp: 0, lasttp: outer ? outer.lasttp : null, curtok: 0, lasttok: 0, tokval: 0n, tokstr: null, lval: {}, assigntok: null };
    try {
      this.readtok();
      const v = this.expcomma();
      if (this.c.curtok !== 0) this.error('syntax error in expression');
      return v;
    } finally { this.c = outer; this.depth--; }
  }

  // a variable token as it is read: its value is itself an arithmetic expression
  streval(tok, e, lval) {
    if (this.noeval) return 0n;
    let name = tok, sub = null;
    if (e === ']') { const b = tok.indexOf('['); name = tok.slice(0, b); sub = tok.slice(b + 1, -1); }
    const value = this.env.get(name, sub, lval);
    const v = value ? this.subexpr(value) : 0n;
    lval.tokstr = tok;
    return v;
  }
  bind(tokstr, value, lval) {
    const b = tokstr.indexOf('[');
    if (b < 0) this.env.set(tokstr, null, String(value));
    else this.env.set(tokstr.slice(0, b), tokstr.slice(b + 1, -1), String(value), lval && lval.tokstr === tokstr ? lval.key : undefined);
  }

  readtok() {
    const c = this.c, s = c.expr;
    let cp = c.tp;
    while (cp < s.length && isCrWs(s[cp])) cp++;
    if (cp >= s.length) { c.lasttok = c.curtok; c.curtok = 0; c.tp = cp; return; }
    const ch = s[cp++];
    c.lasttp = c.tp = cp - 1;
    if (isVarStart(ch)) {
      while (isVarChar(s[cp])) cp++;
      let e = 0;
      if (s[cp] === '[') {
        const end = skipSubscript(s, cp);
        if (end < 0) this.error('bad array subscript');
        cp = end + 1;
        e = ']';
      }
      c.tokstr = s.slice(c.tp, cp);
      // peek: a name followed by `=` is an assignment target and is not read
      const ec = this.save();
      c.tokstr = null; c.tp = cp; this.noeval = 1; c.curtok = 'STR';
      this.readtok();
      const peek = c.curtok;
      this.restore(ec);
      if (c.lasttok === 'PREINC' || c.lasttok === 'PREDEC' || peek !== '=') {
        c.lval = {};
        c.tokval = this.streval(c.tokstr, e, c.lval);
      } else c.tokval = 0n;
      c.lasttok = c.curtok; c.curtok = 'STR';
      c.tp = cp;
      return;
    }
    if (isDigit(ch)) {
      while (isNumChar(s[cp]) || s[cp] === '#') cp++;
      c.tokval = this.strlong(s.slice(c.tp, cp), cp);
      c.lasttok = c.curtok; c.curtok = 'NUM';
      c.tp = cp;
      return;
    }
    const c1 = s[cp++];
    let tok = ch;
    if (ch === '=' && c1 === '=') tok = '==';
    else if (ch === '!' && c1 === '=') tok = '!=';
    else if (ch === '>' && c1 === '=') tok = '>=';
    else if (ch === '<' && c1 === '=') tok = '<=';
    else if ((ch === '<' || ch === '>') && c1 === ch) {
      if (s[cp] === '=') { c.assigntok = ch + ch; tok = 'OPASSIGN'; cp++; } else tok = ch + ch;
    } else if (ch === '&' && c1 === '&') tok = '&&';
    else if (ch === '|' && c1 === '|') tok = '||';
    else if (ch === '*' && c1 === '*') tok = '**';
    else if ((ch === '-' || ch === '+') && c1 === ch && c.curtok === 'STR') tok = ch === '-' ? 'POSTDEC' : 'POSTINC';
    else if ((ch === '-' || ch === '+') && c1 === ch && c.curtok === 'NUM' && (c.lasttok === 'PREINC' || c.lasttok === 'PREDEC')) {
      this.error(`${ch}${ch}: assignment requires lvalue`);
    } else if ((ch === '-' || ch === '+') && c1 === ch) {
      let xp = cp;
      while (xp < s.length && isCrWs(s[xp])) xp++;
      if (isVarStart(s[xp])) tok = ch === '-' ? 'PREDEC' : 'PREINC';
      else cp--;
    } else if (c1 === '=' && '*/%+-&^|'.includes(ch)) { c.assigntok = ch; tok = 'OPASSIGN'; }
    else if (!ARITHOP.has(ch)) {
      cp--;
      if (c.curtok === 0 || ARITHOP.has(c.curtok) || MULTIOP.has(c.curtok)) this.error('syntax error: operand expected');
      this.error('syntax error: invalid arithmetic operator');
    } else cp--;
    c.lasttok = c.curtok; c.curtok = tok;
    c.tp = cp;
  }

  // 0nnn octal, 0xnn hex, base#digits (bases 2..64); anything else decimal
  strlong(num, end) {
    let i = 0, base = 10, found = 0;
    if (num[0] === '0') {
      i = 1;
      if (i >= num.length) return 0n;
      if (num[i] === 'x' || num[i] === 'X') { base = 16; i++; } else base = 8;
      found++;
    }
    let val = 0n;
    for (; i < num.length; i++) {
      const ch = num[i];
      if (ch === '#') {
        if (found) this.error('invalid number', end);
        if (val < 2n || val > 64n) this.error('invalid arithmetic base', end);
        base = Number(val); val = 0n; found++;
        if (!isNumChar(num[i + 1])) this.error('invalid integer constant', end);
        continue;
      }
      if (!isNumChar(ch)) break;
      let d;
      if (isDigit(ch)) d = ch.charCodeAt(0) - 48;
      else if (ch >= 'a' && ch <= 'z') d = ch.charCodeAt(0) - 97 + 10;
      else if (ch >= 'A' && ch <= 'Z') d = ch.charCodeAt(0) - 65 + (base <= 36 ? 10 : 36);
      else d = ch === '@' ? 62 : 63;
      if (d >= base) this.error('value too great for base', end);
      val = wrap(val * BigInt(base) + BigInt(d));
    }
    return val;
  }

  expcomma() {
    let v = this.expassign();
    while (this.c.curtok === ',') { this.readtok(); v = this.expassign(); }
    return v;
  }
  expassign() {
    const c = this.c;
    let value = this.expcond();
    if (c.curtok !== '=' && c.curtok !== 'OPASSIGN') return value;
    const special = c.curtok === 'OPASSIGN';
    if (c.lasttok !== 'STR') this.error('attempted assignment to non-variable');
    let op = null, lvalue = 0n;
    if (special) { op = c.assigntok; lvalue = value; }
    if (c.tokstr === null) this.error('syntax error in variable assignment');
    const lhs = c.tokstr, lval = c.lval;
    this.readtok();
    value = this.expassign();
    if (special) {
      if ((op === '/' || op === '%') && value === 0n) { if (this.noeval === 0) this.error('division by 0'); value = 1n; }
      switch (op) {
        case '*': lvalue = wrap(lvalue * value); break;
        case '/': case '%':
          if (lvalue === INTMAX_MIN && value === -1n) lvalue = op === '/' ? INTMAX_MIN : 0n;
          else lvalue = op === '/' ? lvalue / value : lvalue % value;
          break;
        case '+': lvalue = wrap(lvalue + value); break;
        case '-': lvalue = wrap(lvalue - value); break;
        case '<<': lvalue = wrap(lvalue << (value & 63n)); break;
        case '>>': lvalue = lvalue >> (value & 63n); break;
        case '&': lvalue &= value; break;
        case '|': lvalue |= value; break;
        case '^': lvalue ^= value; break;
      }
      value = lvalue;
    }
    if (this.noeval === 0) this.bind(lhs, value, lval);
    c.tokstr = null;
    return value;
  }
  expcond() {
    const c = this.c;
    const cval = this.explor();
    if (c.curtok !== '?') return cval;
    let set = false;
    if (cval === 0n) { set = true; this.noeval++; }
    this.readtok();
    if (c.curtok === 0 || c.curtok === ':') this.error('expression expected');
    const val1 = this.expcomma();
    if (set) this.noeval--;
    if (c.curtok !== ':') this.error("`:' expected for conditional expression");
    set = false;
    if (cval !== 0n) { set = true; this.noeval++; }
    this.readtok();
    if (c.curtok === 0) this.error('expression expected');
    const val2 = this.expcond();
    if (set) this.noeval--;
    c.lasttok = 'COND';
    return cval !== 0n ? val1 : val2;
  }
  explor() {
    const c = this.c;
    let v1 = this.expland();
    while (c.curtok === '||') {
      let set = false;
      if (v1 !== 0n) { this.noeval++; set = true; }
      this.readtok();
      const v2 = this.expland();
      if (set) this.noeval--;
      v1 = v1 !== 0n || v2 !== 0n ? 1n : 0n;
      c.lasttok = '||';
    }
    return v1;
  }
  expland() {
    const c = this.c;
    let v1 = this.binary(0);
    while (c.curtok === '&&') {
      let set = false;
      if (v1 === 0n) { this.noeval++; set = true; }
      this.readtok();
      const v2 = this.binary(0);
      if (set) this.noeval--;
      v1 = v1 !== 0n && v2 !== 0n ? 1n : 0n;
      c.lasttok = '&&';
    }
    return v1;
  }
  // | ^ & == != < > <= >= << >> + -
  binary(level) {
    const LEVELS = [['|'], ['^'], ['&'], ['==', '!='], ['<=', '>=', '<', '>'], ['<<', '>>'], ['+', '-']];
    if (level === LEVELS.length) return this.expmuldiv();
    const c = this.c;
    let v1 = this.binary(level + 1);
    while (LEVELS[level].includes(c.curtok)) {
      const op = c.curtok;
      this.readtok();
      const v2 = this.binary(level + 1);
      switch (op) {
        case '|': v1 |= v2; break;
        case '^': v1 ^= v2; break;
        case '&': v1 &= v2; break;
        case '==': v1 = v1 === v2 ? 1n : 0n; break;
        case '!=': v1 = v1 !== v2 ? 1n : 0n; break;
        case '<=': v1 = v1 <= v2 ? 1n : 0n; break;
        case '>=': v1 = v1 >= v2 ? 1n : 0n; break;
        case '<': v1 = v1 < v2 ? 1n : 0n; break;
        case '>': v1 = v1 > v2 ? 1n : 0n; break;
        case '<<': v1 = wrap(v1 << (v2 & 63n)); break;
        case '>>': v1 >>= v2 & 63n; break;
        case '+': v1 = wrap(v1 + v2); break;
        case '-': v1 = wrap(v1 - v2); break;
      }
      c.lasttok = 'NUM';
    }
    return v1;
  }
  expmuldiv() {
    const c = this.c;
    let v1 = this.exppower();
    while (c.curtok === '*' || c.curtok === '/' || c.curtok === '%') {
      const op = c.curtok;
      const stp = c.tp;
      this.readtok();
      let v2 = this.exppower();
      if ((op === '/' || op === '%') && v2 === 0n) {
        if (this.noeval === 0) {
          // the error points at the divisor
          let p = stp;
          while (p < c.expr.length && isWs(c.expr[p])) p++;
          c.lasttp = p;
          this.error('division by 0');
        }
        v2 = 1n;
      } else if (op === '%' && v1 === INTMAX_MIN && v2 === -1n) { v1 = 0n; continue; }
      else if (op === '/' && v1 === INTMAX_MIN && v2 === -1n) v2 = 1n;
      if (op === '*') v1 = wrap(v1 * v2);
      else v1 = op === '/' ? v1 / v2 : v1 % v2;
      c.lasttok = 'NUM';
    }
    return v1;
  }
  exppower() {
    const c = this.c;
    let v1 = this.exp1();
    while (c.curtok === '**') {
      this.readtok();
      const v2 = this.exppower();
      c.lasttok = 'NUM';
      if (v2 === 0n) return 1n;
      if (v2 < 0n) this.error('exponent less than 0');
      let r = 1n, b = v1, e = v2;
      while (e > 0n) { if (e & 1n) r = wrap(r * b); e >>= 1n; b = wrap(b * b); }
      v1 = r;
    }
    return v1;
  }
  exp1() {
    const c = this.c;
    switch (c.curtok) {
      case '!': { this.readtok(); const v = this.exp1() === 0n ? 1n : 0n; c.lasttok = 'NUM'; return v; }
      case '~': { this.readtok(); const v = wrap(~this.exp1()); c.lasttok = 'NUM'; return v; }
      case '-': { this.readtok(); const v = wrap(-this.exp1()); c.lasttok = 'NUM'; return v; }
      case '+': { this.readtok(); const v = this.exp1(); c.lasttok = 'NUM'; return v; }
    }
    return this.exp0();
  }
  exp0() {
    const c = this.c;
    let val = 0n;
    if (c.curtok === 'PREINC' || c.curtok === 'PREDEC') {
      const stok = c.lasttok = c.curtok;
      this.readtok();
      if (c.curtok !== 'STR') this.error('identifier expected after pre-increment or pre-decrement');
      const v2 = wrap(c.tokval + (stok === 'PREINC' ? 1n : -1n));
      if (this.noeval === 0 && c.tokstr) this.bind(c.tokstr, v2, c.lval);
      val = v2;
      c.curtok = 'NUM';
      this.readtok();
    } else if (c.curtok === '(') {
      this.readtok();
      val = this.expcomma();
      if (c.curtok !== ')') this.error("missing `)'");
      this.readtok();
    } else if (c.curtok === 'NUM' || c.curtok === 'STR') {
      val = c.tokval;
      if (c.curtok === 'STR') {
        const ec = this.save();
        c.tokstr = null;
        this.noeval = 1;
        this.readtok();
        const stok = c.curtok;
        if (stok === 'POSTINC' || stok === 'POSTDEC') {
          c.tokstr = ec.tokstr; this.noeval = ec.noeval; c.lval = ec.lval; c.lasttok = 'STR';
          const v2 = wrap(val + (stok === 'POSTINC' ? 1n : -1n));
          if (this.noeval === 0) this.bind(c.tokstr, v2, c.lval);
          c.curtok = 'NUM';
        } else this.restore(ec);
      }
      this.readtok();
    } else this.error('syntax error: operand expected');
    return val;
  }
}

export function evalArith(src, env) {
  return new Evaluator(env).subexpr(src);
}

// ---------------------------------------------------------------- dash
// /bin/sh (dash) has a smaller arithmetic: no ** ++ -- or comma, variables must hold plain
// numbers, and errors read: arithmetic expression: expecting primary: "1+"
export class DashArithError extends Error {}
const D = { ASS: 1, OR: 2, AND: 3, BAD: 4, NUM: 5, VAR: 6, NOT: 7, BINOP_MIN: 8, LE: 8, GE: 9, LT: 10, GT: 11, EQ: 12, REM: 13, BAND: 14, LSHIFT: 15, RSHIFT: 16, MUL: 17, ADD: 18, BOR: 19, SUB: 20, BXOR: 21, DIV: 22, NE: 23, BINOP_MAX: 24, ASS_MIN: 24, ASS_MAX: 34, LPAREN: 34, RPAREN: 35, BNOT: 36, QMARK: 37, COLON: 38 };
const DPREC = { [D.MUL]: 0, [D.DIV]: 0, [D.REM]: 0, [D.ADD]: 1, [D.SUB]: 1, [D.LSHIFT]: 2, [D.RSHIFT]: 2, [D.LT]: 3, [D.LE]: 3, [D.GT]: 3, [D.GE]: 3, [D.EQ]: 4, [D.NE]: 4, [D.BAND]: 5, [D.BXOR]: 6, [D.BOR]: 7 };
const isBinop = (t) => t >= D.BINOP_MIN && t < D.BINOP_MAX;

// strtoimax(s, &end, 0): returns [value, end]
function strtoimax0(s, i) {
  let base = 10, j = i;
  if (s[j] === '0' && (s[j + 1] === 'x' || s[j + 1] === 'X') && /[0-9a-fA-F]/.test(s[j + 2] || '')) { base = 16; j += 2; }
  else if (s[j] === '0') base = 8;
  const digit = (c) => { const d = parseInt(c, 16); return isNaN(d) || d >= base ? -1 : d; };
  let v = 0n;
  const start = j;
  while (j < s.length && digit(s[j]) >= 0) { v = v * BigInt(base) + BigInt(digit(s[j])); j++; }
  if (j === start && base === 16) return [0n, i + 1];
  const MAX = 2n ** 63n - 1n;
  return [v > MAX ? MAX : v, j];
}

export function evalDashArith(src, env) {
  const s = src;
  let pos = 0, lastToken = 0, yylval;
  const fail = (m) => { throw new DashArithError(`arithmetic expression: ${m}: "${src}"`); };
  const yylex = () => {
    for (;;) {
      const c = s[pos];
      if (c === ' ' || c === '\t' || c === '\n') { pos++; continue; }
      if (c === undefined) return 0;
      if (c >= '0' && c <= '9') { const [v, e] = strtoimax0(s, pos); yylval = v; pos = e; return D.NUM; }
      if (isVarStart(c)) { let e = pos + 1; while (isVarChar(s[e])) e++; yylval = s.slice(pos, e); pos = e; return D.VAR; }
      const eq = (tok) => { pos++; if (s[pos] === '=') { pos++; return tok + 11; } return tok; };
      switch (c) {
        case '=': return eq(D.ASS);
        case '>': pos++; if (s[pos] === '=') { pos++; return D.GE; } if (s[pos] === '>') return eq(D.RSHIFT); return D.GT;
        case '<': pos++; if (s[pos] === '=') { pos++; return D.LE; } if (s[pos] === '<') return eq(D.LSHIFT); return D.LT;
        case '|': pos++; if (s[pos] === '|') { pos++; return D.OR; } if (s[pos] === '=') { pos++; return D.BOR + 11; } return D.BOR;
        case '&': pos++; if (s[pos] === '&') { pos++; return D.AND; } if (s[pos] === '=') { pos++; return D.BAND + 11; } return D.BAND;
        case '!': pos++; if (s[pos] === '=') { pos++; return D.NE; } return D.NOT;
        case '(': pos++; return D.LPAREN;
        case ')': pos++; return D.RPAREN;
        case '*': return eq(D.MUL);
        case '/': return eq(D.DIV);
        case '%': return eq(D.REM);
        case '+': return eq(D.ADD);
        case '-': return eq(D.SUB);
        case '~': pos++; return D.BNOT;
        case '^': return eq(D.BXOR);
        case '?': pos++; return D.QMARK;
        case ':': pos++; return D.COLON;
        default: return D.BAD;
      }
    }
  };
  const lookup = (name) => {
    const v = env.get(name) ?? '';
    const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)?\s*$/.exec(v);
    if (!m || (m[2] === undefined && v.trim() !== '')) throw new DashArithError(`Illegal number: ${v}`);
    if (m[2] === undefined) return 0n;
    const [n] = strtoimax0(m[2], 0);
    return m[1] === '-' ? -n : n;
  };
  const binop = (op, a, b) => {
    switch (op) {
      case D.REM: case D.DIV: if (b === 0n) fail('division by zero'); return wrap(op === D.REM ? a % b : a / b);
      case D.MUL: return wrap(a * b);
      case D.ADD: return wrap(a + b);
      case D.SUB: return wrap(a - b);
      case D.LSHIFT: return wrap(a << (b & 63n));
      case D.RSHIFT: return a >> (b & 63n);
      case D.LT: return a < b ? 1n : 0n;
      case D.LE: return a <= b ? 1n : 0n;
      case D.GT: return a > b ? 1n : 0n;
      case D.GE: return a >= b ? 1n : 0n;
      case D.EQ: return a === b ? 1n : 0n;
      case D.NE: return a !== b ? 1n : 0n;
      case D.BAND: return a & b;
      case D.BXOR: return a ^ b;
      default: return a | b;
    }
  };
  // primary(token, value of token, the token after it, noeval)
  const primary = (token, val, op, noeval) => {
    for (;;) {
      switch (token) {
        case D.LPAREN: {
          const r = assignment(op, noeval);
          if (lastToken !== D.RPAREN) fail("expecting ')'");
          lastToken = yylex();
          return r;
        }
        case D.NUM: lastToken = op; return val;
        case D.VAR: lastToken = op; return noeval ? 0n : lookup(val);
        case D.ADD: token = op; val = yylval; op = yylex(); continue;
        case D.SUB: { const v = yylval; return wrap(-primary(op, v, yylex(), noeval)); }
        case D.NOT: { const v = yylval; return primary(op, v, yylex(), noeval) === 0n ? 1n : 0n; }
        case D.BNOT: { const v = yylval; return ~primary(op, v, yylex(), noeval); }
        default: fail('expecting primary');
      }
    }
  };
  const binop2 = (a, op, prec, noeval) => {
    for (;;) {
      const token = yylex();
      const val = yylval;
      let b = primary(token, val, yylex(), noeval);
      let op2 = lastToken;
      if (isBinop(op2) && DPREC[op2] < DPREC[op]) { b = binop2(b, op2, DPREC[op], noeval); op2 = lastToken; }
      a = noeval ? b : binop(op, a, b);
      if (!isBinop(op2) || DPREC[op2] >= prec) return a;
      op = op2;
    }
  };
  const binary = (token, val, op, noeval) => {
    const a = primary(token, val, op, noeval);
    op = lastToken;
    if (!isBinop(op)) return a;
    return binop2(a, op, 8, noeval);
  };
  const and = (token, val, op, noeval) => {
    const a = binary(token, val, op, noeval);
    if (lastToken !== D.AND) return a;
    const t = yylex();
    const b = and(t, yylval, yylex(), noeval || a === 0n);
    return a !== 0n && b !== 0n ? 1n : 0n;
  };
  const or = (token, val, op, noeval) => {
    const a = and(token, val, op, noeval);
    if (lastToken !== D.OR) return a;
    const t = yylex();
    const b = or(t, yylval, yylex(), noeval || a !== 0n);
    return a !== 0n || b !== 0n ? 1n : 0n;
  };
  const cond = (token, val, op, noeval) => {
    const a = or(token, val, op, noeval);
    if (lastToken !== D.QMARK) return a;
    const b = assignment(yylex(), noeval || a === 0n);
    if (lastToken !== D.COLON) fail("expecting ':'");
    const t = yylex();
    const c = cond(t, yylval, yylex(), noeval || a !== 0n);
    return a !== 0n ? b : c;
  };
  const assignment = (v, noeval) => {
    const val = yylval;
    const op = yylex();
    if (v !== D.VAR) return cond(v, val, op, noeval);
    if (op !== D.ASS && (op < D.ASS_MIN || op >= D.ASS_MAX)) return cond(v, val, op, noeval);
    const result = assignment(yylex(), noeval);
    if (noeval) return result;
    const nv = op === D.ASS ? result : binop(op - 11, lookup(val), result);
    env.set(val, String(nv));
    return nv;
  };
  const r = assignment(yylex(), false);
  if (lastToken) fail('expecting EOF');
  return r;
}
