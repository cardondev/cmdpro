// jq 1.6 lexer (lexer.l) and parser (parser.y): a flex-equivalent longest-match scanner over the
// program bytes, and bison's LALR(1) driver (yacc.c skeleton, Bison 3.0.4 verbose errors) over
// the tables of jq's shipped parser.c, with the grammar actions ported one by one.
import * as T from './jq-tables.js';
import {
  OP, IS_CALL_PSEUDO, BLOCK, gen_noop, block_is_noop, gen_op_simple, gen_const, gen_op_unbound,
  gen_op_var_fresh, gen_op_bound, gen_location, block_is_single, block_is_const, block_is_const_inf,
  block_const_kind, block_const, block_join, block_bind, block_bind_referenced, gen_module, gen_import,
  gen_import_meta, gen_function, gen_param_regular, gen_param, gen_lambda, gen_call, gen_subexp, gen_both,
  gen_const_object, gen_collect, gen_reduce, gen_foreach, gen_definedor, gen_cond, gen_and, gen_or,
  gen_try, gen_try_handler, gen_label, gen_destructure, gen_destructure_alt, gen_array_matcher,
  gen_object_matcher, gen_dictpair, checkObjectKey, block_has_main, block_has_only_binders_and_imports,
  UNKNOWN_LOCATION,
} from './jqcomp.js';
import { parseSized, decodeUtf8, isValid, getMsg, kind, K_NULL, K_NUMBER, K_STRING, K_OBJECT } from './jqjv.js';

const TOK = T.TOK;
const EOF = 0;
const S_INITIAL = 0, S_PAREN = 1, S_BRACKET = 2, S_BRACE = 3, S_QQINTERP = 4, S_QQSTRING = 5;

// rules of the INITIAL (and inclusive) start conditions that match fixed text, in file order
const FIXED = [
  ['!=', TOK.NEQ], ['==', TOK.EQ], ['as', TOK.AS], ['import', TOK.IMPORT], ['include', TOK.INCLUDE],
  ['module', TOK.MODULE], ['def', TOK.DEF], ['if', TOK.IF], ['then', TOK.THEN], ['else', TOK.ELSE],
  ['elif', TOK.ELSE_IF], ['and', TOK.AND], ['or', TOK.OR], ['end', TOK.END], ['reduce', TOK.REDUCE],
  ['foreach', TOK.FOREACH], ['//', TOK.DEFINEDOR], ['try', TOK.TRY], ['catch', TOK.CATCH],
  ['label', TOK.LABEL], ['break', TOK.BREAK], ['__loc__', TOK.LOC], ['|=', TOK.SETPIPE],
  ['+=', TOK.SETPLUS], ['-=', TOK.SETMINUS], ['*=', TOK.SETMULT], ['/=', TOK.SETDIV], ['%=', TOK.SETMOD],
  ['//=', TOK.SETDEFINEDOR], ['<=', TOK.LESSEQ], ['>=', TOK.GREATEREQ], ['..', TOK.REC], ['?//', TOK.ALTERNATION],
];
const SINGLE = '.?=;,:|+-*/%$<>';
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isAlnum = (c) => isAlpha(c) || (c >= 48 && c <= 57);
const isDigit = (c) => c >= 48 && c <= 57;

class Lexer {
  constructor(data) {
    this.s = data;
    this.pos = 0;
    this.state = S_INITIAL;
    this.stack = [];
  }
  push(st) { this.stack.push(this.state); this.state = st; }
  pop() { this.state = this.stack.pop(); }

  enter(c, ret) {
    let st = 0;
    if (c === '(') st = S_PAREN;
    else if (c === '[') st = S_BRACKET;
    else if (c === '{') st = S_BRACE;
    else st = S_QQINTERP;
    this.push(st);
    return ret;
  }
  tryExit(c) {
    let match, ret;
    switch (this.state) {
      case S_PAREN: match = ret = ')'; break;
      case S_BRACKET: match = ret = ']'; break;
      case S_BRACE: match = ret = '}'; break;
      case S_QQINTERP: match = ')'; ret = TOK.QQSTRING_INTERP_END; break;
      default: return TOK.INVALID_CHARACTER;
    }
    if (match === c) {
      this.pop();
      return typeof ret === 'string' ? ret.charCodeAt(0) : ret;
    }
    return TOK.INVALID_CHARACTER;
  }

  // returns { tok, val, start, end }
  lex() {
    const s = this.s, n = s.length;
    for (;;) {
      const start = this.pos;
      if (start >= n) return { tok: EOF, val: undefined, start, end: start };
      if (this.state === S_QQSTRING) return this.lexString(start);
      const c = s.charCodeAt(start);
      let bestLen = 0, best = -1;
      const consider = (len, rule) => { if (len > bestLen) { bestLen = len; best = rule; } };
      // 0: comment
      if (c === 35) {
        let e = start + 1;
        while (e < n && s[e] !== '\n' && s[e] !== '\r') e++;
        consider(e - start, 0);
      }
      // 1..33: fixed strings
      for (let k = 0; k < FIXED.length; k++) {
        const f = FIXED[k][0];
        if (f.length > bestLen && s.startsWith(f, start)) consider(f.length, 1 + k);
      }
      const ch = s[start];
      if (SINGLE.includes(ch)) consider(1, 34);
      if (ch === '[' || ch === '{' || ch === '(') consider(1, 35);
      if (ch === ']' || ch === '}' || ch === ')') consider(1, 36);
      // 37: format
      if (c === 64) {
        let e = start + 1;
        while (e < n && isAlnum(s.charCodeAt(e))) e++;
        if (e > start + 1) consider(e - start, 37);
      }
      // 38: number-ish literal
      if (isDigit(c) || c === 46) {
        let e = start;
        while (e < n && (isDigit(s.charCodeAt(e)) || s.charCodeAt(e) === 46)) e++;
        if (e < n && (s[e] === 'e' || s[e] === 'E')) {
          let f = e + 1;
          if (f < n && (s[f] === '+' || s[f] === '-')) f++;
          if (f < n && isDigit(s.charCodeAt(f))) {
            while (f < n && isDigit(s.charCodeAt(f))) f++;
            e = f;
          }
        }
        consider(e - start, 38);
      }
      if (c === 34) consider(1, 39);
      // 40: identifier (with optional module:: prefixes)
      if (isAlpha(c)) {
        let e = start;
        for (;;) {
          let f = e;
          if (!isAlpha(s.charCodeAt(f))) break;
          f++;
          while (f < n && isAlnum(s.charCodeAt(f))) f++;
          e = f;
          if (s[f] === ':' && s[f + 1] === ':' && f + 2 < n && isAlpha(s.charCodeAt(f + 2))) { e = f + 2; continue; }
          break;
        }
        consider(e - start, 40);
      }
      // 41: .field
      if (c === 46 && start + 1 < n && isAlpha(s.charCodeAt(start + 1))) {
        let e = start + 2;
        while (e < n && isAlnum(s.charCodeAt(e))) e++;
        consider(e - start, 41);
      }
      // 42: whitespace
      if (c === 32 || c === 10 || c === 9) {
        let e = start + 1;
        while (e < n && (s[e] === ' ' || s[e] === '\n' || s[e] === '\t')) e++;
        consider(e - start, 42);
      }
      // 43: any other single byte
      if (c !== 10) consider(1, 43);

      const end = start + bestLen;
      this.pos = end;
      const text = s.slice(start, end);
      let tok, val;
      if (best === 0 || best === 42) continue;
      if (best >= 1 && best <= 33) tok = FIXED[best - 1][1];
      else switch (best) {
        case 34: tok = c; break;
        case 35: tok = this.enter(ch, c); break;
        case 36: tok = this.tryExit(ch); break;
        case 37: tok = TOK.FORMAT; val = decodeUtf8(text, 1); break;
        case 38: tok = TOK.LITERAL; val = parseSized(text); break;
        case 39: this.push(S_QQSTRING); tok = TOK.QQSTRING_START; break;
        case 40: tok = TOK.IDENT; val = decodeUtf8(text); break;
        case 41: tok = TOK.FIELD; val = decodeUtf8(text, 1); break;
        default: tok = TOK.INVALID_CHARACTER;
      }
      return { tok, val, start, end };
    }
  }

  lexString(start) {
    const s = this.s, n = s.length;
    const c = s[start];
    let end, tok, val;
    if (c === '\\' && s[start + 1] === '(') {
      end = start + 2;
      tok = this.enter('', TOK.QQSTRING_INTERP_START);
    } else if (c === '"') {
      end = start + 1;
      this.pop();
      tok = TOK.QQSTRING_END;
    } else if (c === '\\') {
      // (\\[^u(]|\\u[a-zA-Z0-9]{0,4})+
      let e = start;
      while (s[e] === '\\' && e + 1 < n) {
        const d = s[e + 1];
        if (d === 'u') {
          e += 2;
          let k = 0;
          while (k < 4 && e < n && isAlnum(s.charCodeAt(e)) && s[e] !== '_') { e++; k++; }
        } else if (d !== '(') e += 2;
        else break;
      }
      if (e > start) {
        end = e;
        tok = TOK.QQSTRING_TEXT;
        val = parseSized('"' + s.slice(start, e) + '"');
      } else {
        end = start + 1;
        tok = TOK.INVALID_CHARACTER;
      }
    } else {
      let e = start;
      while (e < n && s[e] !== '\\' && s[e] !== '"') e++;
      end = e;
      tok = TOK.QQSTRING_TEXT;
      val = decodeUtf8(s, start, e);
    }
    this.pos = end;
    return { tok, val, start, end };
  }
}

// ---------------------------------------------------------------- grammar helpers (parser.y)

const EQ = TOK.EQ, NEQ = TOK.NEQ, LESSEQ = TOK.LESSEQ, GREATEREQ = TOK.GREATEREQ;

function gen_index(obj, key) { return BLOCK(gen_subexp(key), obj, gen_op_simple(OP.INDEX)); }
function gen_index_opt(obj, key) { return BLOCK(gen_subexp(key), obj, gen_op_simple(OP.INDEX_OPT)); }
function gen_slice_index(obj, start, end, idxOp) {
  const key = BLOCK(gen_subexp(gen_const(new Map())), gen_subexp(gen_const('start')), gen_subexp(start),
    gen_op_simple(OP.INSERT), gen_subexp(gen_const('end')), gen_subexp(end), gen_op_simple(OP.INSERT));
  return BLOCK(key, obj, gen_op_simple(idxOp));
}

function constantFold(a, b, op) {
  if (!block_is_single(a) || !block_is_const(a) || !block_is_single(b) || !block_is_const(b)) return gen_noop();
  if (op === '+') {
    if (block_const_kind(a) === K_NULL) return b;
    if (block_const_kind(b) === K_NULL) return a;
  }
  if (block_const_kind(a) !== block_const_kind(b)) return gen_noop();
  let res;
  if (block_const_kind(a) === K_NUMBER) {
    const na = block_const(a), nb = block_const(b);
    switch (op) {
      case '+': res = na + nb; break;
      case '-': res = na - nb; break;
      case '*': res = na * nb; break;
      case '/': res = na / nb; break;
      case EQ: res = na === nb; break;
      case NEQ: res = na !== nb; break;
      case '<': res = na < nb; break;
      case '>': res = na > nb; break;
      case LESSEQ: res = na <= nb; break;
      case GREATEREQ: res = na >= nb; break;
      default: return gen_noop();
    }
  } else if (op === '+' && block_const_kind(a) === K_STRING) {
    res = block_const(a) + block_const(b);
  } else return gen_noop();
  return gen_const(res);
}

const BINOP_FUNCS = { '+': '_plus', '-': '_minus', '*': '_multiply', '/': '_divide', '%': '_mod' };
function gen_binop(a, b, op) {
  const folded = constantFold(a, b, op);
  if (!block_is_noop(folded)) return folded;
  let funcname = BINOP_FUNCS[op];
  if (!funcname) {
    switch (op) {
      case EQ: funcname = '_equal'; break;
      case NEQ: funcname = '_notequal'; break;
      case '<': funcname = '_less'; break;
      case '>': funcname = '_greater'; break;
      case LESSEQ: funcname = '_lesseq'; break;
      case GREATEREQ: funcname = '_greatereq'; break;
    }
  }
  return gen_call(funcname, BLOCK(gen_lambda(a), gen_lambda(b)));
}

function gen_format(a, fmt) { return BLOCK(a, gen_call('format', gen_lambda(gen_const(fmt)))); }

function gen_definedor_assign(object, val) {
  const tmp = gen_op_var_fresh(OP.STOREV, 'tmp');
  return BLOCK(gen_op_simple(OP.DUP), val, tmp,
    gen_call('_modify', BLOCK(gen_lambda(object), gen_lambda(gen_definedor(gen_noop(), gen_op_bound(OP.LOADV, tmp))))));
}

function gen_update(object, val, optype) {
  const tmp = gen_op_var_fresh(OP.STOREV, 'tmp');
  return BLOCK(gen_op_simple(OP.DUP), val, tmp,
    gen_call('_modify', BLOCK(gen_lambda(object), gen_lambda(gen_binop(gen_noop(), gen_op_bound(OP.LOADV, tmp), optype)))));
}

// ---------------------------------------------------------------- the LALR driver

const { yypact, yydefact, yypgoto, yydefgoto, yytable, yycheck, yyr1, yyr2, yytname, yytranslate } = T;
const YYPACT_NINF = T.YYPACT_NINF, YYTABLE_NINF = T.YYTABLE_NINF, YYLAST = T.YYLAST, YYNTOKENS = T.YYNTOKENS,
  YYFINAL = T.YYFINAL, YYMAXUTOK = T.YYMAXUTOK, YYUNDEFTOK = T.YYUNDEFTOK;
const YYEMPTY = -2, YYTERROR = 1, YYMAXDEPTH = 10000, YYINITDEPTH = 200;

const translate = (c) => (c >= 0 && c <= YYMAXUTOK ? yytranslate[c] : YYUNDEFTOK);

// yytnamerr: strip the double quotes unless the name holds an apostrophe, comma or backslash
function tnamerr(name) {
  if (name[0] === '"') {
    let out = '';
    for (let i = 1; ; i++) {
      const c = name[i];
      if (c === "'" || c === ',') return name;
      if (c === '\\') {
        if (name[++i] !== '\\') return name;
        out += '\\';
        continue;
      }
      if (c === '"') return out;
      out += c;
    }
  }
  return name;
}

function syntaxError(state, token) {
  const args = [];
  if (token !== YYEMPTY) {
    const yyn = yypact[state];
    args.push(yytname[token]);
    if (yyn !== YYPACT_NINF) {
      const xbegin = yyn < 0 ? -yyn : 0;
      const checklim = YYLAST - yyn + 1;
      const xend = checklim < YYNTOKENS ? checklim : YYNTOKENS;
      for (let x = xbegin; x < xend; x++) {
        if (yycheck[x + yyn] === x && x !== YYTERROR && yytable[x + yyn] !== YYTABLE_NINF) {
          if (args.length === 5) { args.length = 1; break; }
          args.push(yytname[x]);
        }
      }
    }
  }
  const fmts = ['syntax error', 'syntax error, unexpected %s', 'syntax error, unexpected %s, expecting %s',
    'syntax error, unexpected %s, expecting %s or %s', 'syntax error, unexpected %s, expecting %s or %s or %s',
    'syntax error, unexpected %s, expecting %s or %s or %s or %s'];
  let k = 0;
  return fmts[args.length].replace(/%s/g, () => tnamerr(args[k++]));
}

const KEYWORDS = {
  132: 'as', 133: 'def', 134: 'module', 135: 'import', 136: 'include', 137: 'if', 138: 'then', 139: 'else',
  140: 'elif', 141: 'reduce', 142: 'foreach', 143: 'end', 144: 'and', 145: 'or', 146: 'try', 147: 'catch',
  148: 'label', 149: 'break', 150: '__loc__',
};

// jq_parse(): returns { errors, answer }
export function jqParse(locations) {
  const lexer = new Lexer(locations.data);
  const ctx = { errors: 0, answer: gen_noop() };
  const yyerror = (loc, msg) => {
    ctx.errors++;
    if (msg.includes('unexpected')) locations.locate(loc, `jq: error: ${msg} (Unix shell quoting issues?)`);
    else locations.locate(loc, `jq: error: ${msg}`);
  };
  const FAIL = yyerror;

  let yylval, yylloc = { start: 0, end: 0 };
  const yylex = () => {
    const t = lexer.lex();
    yylval = t.val;
    if (t.tok !== EOF) yylloc = { start: t.start, end: t.end };
    if ((t.tok === TOK.LITERAL || t.tok === TOK.QQSTRING_TEXT) && !isValid(yylval)) {
      const msg = getMsg(yylval);
      FAIL(yylloc, typeof msg === 'string' ? msg : 'Invalid literal');
      yylval = null;
    }
    return t.tok;
  };

  const ss = [0], vs = [undefined], ls = [yylloc];
  let state = 0, yychar = YYEMPTY, token = 0, errstatus = 0;
  const errorRange = [null, null, null];

  // semantic action of rule `r`; v(i) = $i (1-based), loc = @$
  const action = (r, len, loc) => {
    const top = vs.length - 1;
    const v = (i) => vs[top - len + i];
    const at = (i) => ls[ls.length - 1 - len + i];
    switch (r) {
      case 2: ctx.answer = BLOCK(v(1), v(2), gen_op_simple(OP.TOP), v(3)); return undefined;
      case 3: ctx.answer = BLOCK(v(1), v(2), v(3)); return undefined;
      case 4: case 6: case 8: return gen_noop();
      case 5:
        if (!block_is_const(v(2))) { FAIL(loc, 'Module metadata must be constant'); return gen_noop(); }
        return gen_module(v(2));
      case 7: return BLOCK(v(1), v(2));
      case 9: return block_bind(v(1), v(2), IS_CALL_PSEUDO);
      case 10: return block_bind_referenced(v(1), v(2), IS_CALL_PSEUDO);
      case 11: return gen_destructure(v(1), v(3), v(5));
      case 12: return gen_reduce(v(2), v(4), v(6), v(8));
      case 13: return gen_foreach(v(2), v(4), v(6), v(8), v(10));
      case 14: return gen_foreach(v(2), v(4), v(6), v(8), gen_noop());
      case 15: return gen_cond(v(2), v(4), v(5));
      case 16: FAIL(loc, "Possibly unterminated 'if' statement"); return v(2);
      case 17: return gen_try(v(2), gen_try_handler(v(4)));
      case 18: return gen_try(v(2), gen_op_simple(OP.BACKTRACK));
      case 19: FAIL(loc, "Possibly unterminated 'try' statement"); return v(2);
      case 20: return gen_location(loc, locations, gen_label(`*label-${v(3)}`, v(5)));
      case 21: return gen_try(v(1), gen_op_simple(OP.BACKTRACK));
      case 22: return gen_call('_assign', BLOCK(gen_lambda(v(1)), gen_lambda(v(3))));
      case 23: return gen_or(v(1), v(3));
      case 24: return gen_and(v(1), v(3));
      case 25: return gen_definedor(v(1), v(3));
      case 26: return gen_definedor_assign(v(1), v(3));
      case 27: return gen_call('_modify', BLOCK(gen_lambda(v(1)), gen_lambda(v(3))));
      case 28: return block_join(v(1), v(3));
      case 29: return gen_both(v(1), v(3));
      case 30: return gen_binop(v(1), v(3), '+');
      case 31: return gen_update(v(1), v(3), '+');
      case 32: return BLOCK(v(2), gen_call('_negate', gen_noop()));
      case 33: return gen_binop(v(1), v(3), '-');
      case 34: return gen_update(v(1), v(3), '-');
      case 35: return gen_binop(v(1), v(3), '*');
      case 36: return gen_update(v(1), v(3), '*');
      case 37: {
        const b = gen_binop(v(1), v(3), '/');
        if (block_is_const_inf(b)) FAIL(loc, 'Division by zero?');
        return b;
      }
      case 38: {
        const b = gen_binop(v(1), v(3), '%');
        if (block_is_const_inf(b)) FAIL(loc, 'Remainder by zero?');
        return b;
      }
      case 39: return gen_update(v(1), v(3), '/');
      case 40: return gen_update(v(1), v(3), '%');
      case 41: return gen_binop(v(1), v(3), EQ);
      case 42: return gen_binop(v(1), v(3), NEQ);
      case 43: return gen_binop(v(1), v(3), '<');
      case 44: return gen_binop(v(1), v(3), '>');
      case 45: return gen_binop(v(1), v(3), LESSEQ);
      case 46: return gen_binop(v(1), v(3), GREATEREQ);
      case 47: return v(1);
      case 48: return v(1);
      case 49:
        if (!block_is_const(v(2))) { FAIL(loc, 'Module metadata must be constant'); return gen_noop(); }
        if (block_const_kind(v(2)) !== K_OBJECT) { FAIL(loc, 'Module metadata must be an object'); return gen_noop(); }
        return gen_import_meta(v(1), v(2));
      case 50: return gen_import(block_const(v(2)), v(5), 1);
      case 51: return gen_import(block_const(v(2)), v(4), 0);
      case 52: return gen_import(block_const(v(2)), null, 0);
      case 53:
        if (!block_is_const(v(1))) { FAIL(loc, 'Import path must be constant'); return gen_const(''); }
        return v(1);
      case 54: return gen_function(v(2), gen_noop(), v(4));
      case 55: return gen_function(v(2), v(4), v(7));
      case 56: return v(1);
      case 57: return BLOCK(v(1), v(3));
      case 58: return gen_param_regular(v(2));
      case 59: return gen_param(v(1));
      case 60: return 'text';
      case 61: return v(3);
      case 62: return vs[top - 1];
      case 63: return v(4);
      case 64: return gen_const('');
      case 65: return gen_binop(v(1), gen_const(v(2)), '+');
      case 66: return gen_binop(v(1), gen_format(v(3), vs[top - 4]), '+');
      case 67: return gen_cond(v(2), v(4), v(5));
      case 68: return v(2);
      case 69: return block_join(v(1), v(3));
      case 70: return BLOCK(v(2), gen_call('_negate', gen_noop()));
      case 71: return v(1);
      case 72: return gen_noop();
      case 73: return gen_call('recurse', gen_noop());
      case 74: return gen_location(loc, locations, BLOCK(gen_op_unbound(OP.LOADV, `*label-${v(3)}`), gen_call('error', gen_noop())));
      case 75: FAIL(loc, 'break requires a label to break to'); return gen_noop();
      case 76: return gen_index_opt(v(1), gen_const(v(2)));
      case 77: return gen_index_opt(gen_noop(), gen_const(v(1)));
      case 78: return gen_index_opt(v(1), v(3));
      case 79: return gen_index_opt(gen_noop(), v(2));
      case 80: return gen_index(v(1), gen_const(v(2)));
      case 81: return gen_index(gen_noop(), gen_const(v(1)));
      case 82: return gen_index(v(1), v(3));
      case 83: return gen_index(gen_noop(), v(2));
      case 84: case 85: FAIL(loc, 'try .["field"] instead of .field for unusually named fields'); return gen_noop();
      case 86: return gen_index_opt(v(1), v(3));
      case 87: return gen_index(v(1), v(3));
      case 88: return block_join(v(1), gen_op_simple(OP.EACH_OPT));
      case 89: return block_join(v(1), gen_op_simple(OP.EACH));
      case 90: return gen_slice_index(v(1), v(3), v(5), OP.INDEX_OPT);
      case 91: return gen_slice_index(v(1), v(3), gen_const(null), OP.INDEX_OPT);
      case 92: return gen_slice_index(v(1), gen_const(null), v(4), OP.INDEX_OPT);
      case 93: return gen_slice_index(v(1), v(3), v(5), OP.INDEX);
      case 94: return gen_slice_index(v(1), v(3), gen_const(null), OP.INDEX);
      case 95: return gen_slice_index(v(1), gen_const(null), v(4), OP.INDEX);
      case 96: return gen_const(v(1));
      case 97: return v(1);
      case 98: return gen_format(gen_noop(), v(1));
      case 99: return v(2);
      case 100: return gen_collect(v(2));
      case 101: return gen_const([]);
      case 102: {
        const o = gen_const_object(v(2));
        if (o.first !== null) return o;
        return BLOCK(gen_subexp(gen_const(new Map())), v(2), gen_op_simple(OP.POP));
      }
      case 103: return gen_const(new Map([['file', locations.fname], ['line', locations.getLine(loc.start) + 1]]));
      case 104: return gen_location(loc, locations, gen_op_unbound(OP.LOADV, v(2)));
      case 105: {
        const s = v(1);
        if (s === 'false') return gen_const(false);
        if (s === 'true') return gen_const(true);
        if (s === 'null') return gen_const(null);
        return gen_location(loc, locations, gen_call(s, gen_noop()));
      }
      case 106: return gen_location(at(1), locations, gen_call(v(1), v(3)));
      case 107: case 108: case 110: return gen_noop();
      case 109: return v(1);
      case 111: return v(1);
      case 112: return BLOCK(v(1), v(3));
      case 113: return gen_lambda(v(1));
      case 114: return BLOCK(v(1), gen_destructure_alt(v(3)));
      case 115: return gen_destructure_alt(v(1));
      case 116: return BLOCK(v(1), v(3));
      case 117: return v(1);
      case 118: return gen_op_unbound(OP.STOREV, v(2));
      case 119: case 120: return BLOCK(v(2), gen_op_simple(OP.POP));
      case 121: return gen_array_matcher(gen_noop(), v(1));
      case 122: return gen_array_matcher(v(1), v(3));
      case 123: return v(1);
      case 124: return BLOCK(v(1), v(3));
      case 125: return gen_object_matcher(gen_const(v(2)), gen_op_unbound(OP.STOREV, v(2)));
      case 126: return gen_object_matcher(gen_const(v(2)), BLOCK(gen_op_simple(OP.DUP), gen_op_unbound(OP.STOREV, v(2)), v(4)));
      case 127: case 128: return gen_object_matcher(gen_const(v(1)), v(3));
      case 129: return gen_object_matcher(v(1), v(3));
      case 130: {
        const msg = checkObjectKey(v(2));
        if (msg !== null) FAIL(loc, msg);
        return gen_object_matcher(v(2), v(5));
      }
      case 131: FAIL(loc, 'May need parentheses around object key expression'); return v(3);
      case 151: return gen_noop();
      case 152: return v(1);
      case 153: return block_join(v(1), v(3));
      case 154: return v(3);
      case 155: case 156: return gen_dictpair(gen_const(v(1)), v(3));
      case 157: return gen_dictpair(v(1), v(3));
      case 158: return gen_dictpair(v(1), BLOCK(gen_op_simple(OP.POP), gen_op_simple(OP.DUP2), gen_op_simple(OP.DUP2), gen_op_simple(OP.INDEX)));
      case 159: return gen_dictpair(gen_const(v(2)), gen_location(loc, locations, gen_op_unbound(OP.LOADV, v(2))));
      case 160: return gen_dictpair(gen_const(v(1)), gen_index(gen_noop(), gen_const(v(1))));
      case 161: {
        const msg = checkObjectKey(v(2));
        if (msg !== null) FAIL(loc, msg);
        return gen_dictpair(v(2), v(5));
      }
      case 162: FAIL(loc, 'May need parentheses around object key expression'); return v(3);
      default:
        if (KEYWORDS[r] !== undefined) return KEYWORDS[r];
        return len ? v(1) : undefined;
    }
  };

  // yyparse
  let yyn;
  for (;;) {
    // yynewstate / yysetstate (state already pushed)
    if (ss.length >= YYMAXDEPTH) {
      yyerror(yylloc, 'memory exhausted');
      return { errors: ctx.errors, answer: ctx.answer };
    }
    if (state === YYFINAL) return { errors: ctx.errors, answer: ctx.answer };
    // yybackup
    let doReduce = false, doError = false;
    yyn = yypact[state];
    if (yyn === YYPACT_NINF) {
      yyn = yydefact[state];
      if (yyn === 0) doError = true; else doReduce = true;
    } else {
      if (yychar === YYEMPTY) yychar = yylex();
      if (yychar <= EOF) { yychar = token = EOF; } else token = translate(yychar);
      yyn += token;
      if (yyn < 0 || YYLAST < yyn || yycheck[yyn] !== token) {
        yyn = yydefact[state];
        if (yyn === 0) doError = true; else doReduce = true;
      } else {
        yyn = yytable[yyn];
        if (yyn <= 0) {
          if (yyn === YYTABLE_NINF) doError = true;
          else { yyn = -yyn; doReduce = true; }
        } else {
          // shift
          if (errstatus) errstatus--;
          ss.push(yyn); vs.push(yylval); ls.push(yylloc);
          state = yyn;
          yychar = YYEMPTY;
          continue;
        }
      }
    }
    if (doReduce) {
      const len = yyr2[yyn];
      let loc;
      if (len) loc = { start: ls[ls.length - len].start, end: ls[ls.length - 1].end };
      else loc = { start: ls[ls.length - 1].end, end: ls[ls.length - 1].end };
      let val = len ? vs[vs.length - len] : undefined;
      const r = action(yyn, len, loc);
      val = r;
      ss.length -= len; vs.length -= len; ls.length -= len;
      vs.push(val); ls.push(loc);
      const lhs = yyr1[yyn];
      let st = yypgoto[lhs - YYNTOKENS] + ss[ss.length - 1];
      if (st >= 0 && st <= YYLAST && yycheck[st] === ss[ss.length - 1]) st = yytable[st];
      else st = yydefgoto[lhs - YYNTOKENS];
      ss.push(st);
      state = st;
      continue;
    }
    // yyerrlab
    token = yychar === YYEMPTY ? YYEMPTY : translate(yychar);
    if (!errstatus) yyerror(yylloc, syntaxError(state, token));
    errorRange[1] = yylloc;
    if (errstatus === 3) {
      if (yychar <= EOF) {
        if (yychar === EOF) return { errors: ctx.errors, answer: ctx.answer };
      } else yychar = YYEMPTY;
    }
    // yyerrlab1
    errstatus = 3;
    for (;;) {
      yyn = yypact[state];
      if (yyn !== YYPACT_NINF) {
        yyn += YYTERROR;
        if (yyn >= 0 && yyn <= YYLAST && yycheck[yyn] === YYTERROR) {
          yyn = yytable[yyn];
          if (yyn > 0) break;
        }
      }
      if (ss.length === 1) return { errors: ctx.errors, answer: ctx.answer };
      errorRange[1] = ls[ls.length - 1];
      ss.pop(); vs.pop(); ls.pop();
      state = ss[ss.length - 1];
    }
    vs.push(yylval);
    errorRange[2] = yylloc;
    ls.push({ start: errorRange[1].start, end: errorRange[2].end });
    ss.push(yyn);
    state = yyn;
  }
}

// jq_parse_library(): definitions only
export function jqParseLibrary(locations) {
  const r = jqParse(locations);
  if (r.errors) return r;
  if (block_has_main(r.answer)) {
    locations.locate(UNKNOWN_LOCATION, 'jq: error: library should only have function definitions, not a main expression');
    return { errors: 1, answer: r.answer };
  }
  return r;
}

export { YYINITDEPTH };
