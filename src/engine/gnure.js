// GNU regular expressions (glibc regcomp) translated to JS RegExp source.
// The parser follows glibc's regcomp.c (peek_token, parse_reg_exp, parse_branch,
// parse_expression, parse_dup_op, parse_bracket_exp) for a given set of syntax bits, so the
// same patterns are accepted, the same errors reported and the same operators recognised.
// Patterns and subjects are byte strings (C locale).

export const RE = {
  BACKSLASH_ESCAPE_IN_LISTS: 1 << 0,
  BK_PLUS_QM: 1 << 1,
  CHAR_CLASSES: 1 << 2,
  CONTEXT_INDEP_ANCHORS: 1 << 3,
  CONTEXT_INDEP_OPS: 1 << 4,
  CONTEXT_INVALID_OPS: 1 << 5,
  DOT_NEWLINE: 1 << 6,
  DOT_NOT_NULL: 1 << 7,
  HAT_LISTS_NOT_NEWLINE: 1 << 8,
  INTERVALS: 1 << 9,
  LIMITED_OPS: 1 << 10,
  NEWLINE_ALT: 1 << 11,
  NO_BK_BRACES: 1 << 12,
  NO_BK_PARENS: 1 << 13,
  NO_BK_REFS: 1 << 14,
  NO_BK_VBAR: 1 << 15,
  NO_EMPTY_RANGES: 1 << 16,
  UNMATCHED_RIGHT_PAREN_ORD: 1 << 17,
  NO_POSIX_BACKTRACKING: 1 << 18,
  NO_GNU_OPS: 1 << 19,
  DEBUG: 1 << 20,
  INVALID_INTERVAL_ORD: 1 << 21,
  ICASE: 1 << 22,
  CARET_ANCHORS_HERE: 1 << 23,
  CONTEXT_INVALID_DUP: 1 << 24,
  NO_SUB: 1 << 25,
};

const POSIX_COMMON = RE.CHAR_CLASSES | RE.DOT_NEWLINE | RE.DOT_NOT_NULL | RE.INTERVALS | RE.NO_EMPTY_RANGES;
export const SYNTAX_POSIX_BASIC = POSIX_COMMON | RE.BK_PLUS_QM | RE.CONTEXT_INVALID_DUP;
export const SYNTAX_POSIX_EXTENDED = POSIX_COMMON | RE.CONTEXT_INDEP_ANCHORS | RE.CONTEXT_INDEP_OPS
  | RE.NO_BK_BRACES | RE.NO_BK_PARENS | RE.NO_BK_VBAR | RE.CONTEXT_INVALID_OPS | RE.UNMATCHED_RIGHT_PAREN_ORD;

// regerror() wording
const MESSAGES = {
  BADPAT: 'Invalid regular expression',
  ECOLLATE: 'Invalid collation character',
  ECTYPE: 'Invalid character class name',
  EESCAPE: 'Trailing backslash',
  ESUBREG: 'Invalid back reference',
  EBRACK: 'Unmatched [, [^, [:, [., or [=',
  EPAREN: 'Unmatched ( or \\(',
  EBRACE: 'Unmatched \\{',
  BADBR: 'Invalid content of \\{\\}',
  ERANGE: 'Invalid range end',
  ESPACE: 'Memory exhausted',
  BADRPT: 'Invalid preceding regular expression',
  EEND: 'Premature end of regular expression',
  ESIZE: 'Regular expression too big',
  ERPAREN: 'Unmatched ) or \\)',
};

export class RegexError extends Error {
  constructor(code) { super(MESSAGES[code]); this.code = code; }
}

const RE_DUP_MAX = 0x7fff;
const BRACKET_NAME_BUF_SIZE = 32;

// token types
const CHARACTER = 1, END_OF_RE = 2, BACK_SLASH = 3, OP_ALT = 4, OP_BACK_REF = 5, ANCHOR = 6,
  OP_WORD = 7, OP_NOTWORD = 8, OP_SPACE = 9, OP_NOTSPACE = 10, OP_OPEN_SUBEXP = 11,
  OP_CLOSE_SUBEXP = 12, OP_DUP_PLUS = 13, OP_DUP_QUESTION = 14, OP_DUP_ASTERISK = 15,
  OP_OPEN_DUP_NUM = 16, OP_CLOSE_DUP_NUM = 17, OP_OPEN_BRACKET = 18, OP_PERIOD = 19,
  // bracket tokens
  OP_CLOSE_BRACKET = 20, OP_CHARSET_RANGE = 21, OP_NON_MATCH_LIST = 22, OP_OPEN_COLL_ELEM = 23,
  OP_OPEN_EQUIV_CLASS = 24, OP_OPEN_CHAR_CLASS = 25;
// anchor kinds
const LINE_FIRST = 1, LINE_LAST = 2, BUF_FIRST = 3, BUF_LAST = 4, WORD_FIRST = 5, WORD_LAST = 6,
  WORD_DELIM = 7, NOT_WORD_DELIM = 8;
// bracket element kinds
const SB_CHAR = 1, COLL_SYM = 2, EQUIV_CLASS = 3, CHAR_CLASS = 4;

const isWordChar = (c) => /[A-Za-z0-9_]/.test(c);

// C-locale character classes as byte predicates
const CTYPE = {
  alpha: (b) => (b >= 65 && b <= 90) || (b >= 97 && b <= 122),
  upper: (b) => b >= 65 && b <= 90,
  lower: (b) => b >= 97 && b <= 122,
  digit: (b) => b >= 48 && b <= 57,
  xdigit: (b) => (b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102),
  space: (b) => b === 32 || (b >= 9 && b <= 13),
  print: (b) => b >= 32 && b <= 126,
  punct: (b) => (b >= 33 && b <= 47) || (b >= 58 && b <= 64) || (b >= 91 && b <= 96) || (b >= 123 && b <= 126),
  graph: (b) => b >= 33 && b <= 126,
  cntrl: (b) => b < 32 || b === 127,
  blank: (b) => b === 32 || b === 9,
  alnum: (b) => (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122),
};

const hex2 = (b) => '\\x' + b.toString(16).padStart(2, '0');
// A byte as a JS regex atom outside a class.
function litByte(b) {
  const c = String.fromCharCode(b);
  if (/[A-Za-z0-9_ ]/.test(c)) return c;
  return hex2(b);
}
// A byte set (Uint8Array(256)) as a JS character class.
function classSrc(set) {
  let n = 0;
  for (let b = 0; b < 256; b++) if (set[b]) n++;
  if (n === 256) return '[\\s\\S]';
  if (n === 0) return '[]';
  const neg = n > 128;
  const want = (b) => (neg ? !set[b] : !!set[b]);
  let out = '';
  for (let b = 0; b < 256; b++) {
    if (!want(b)) continue;
    let e = b;
    while (e + 1 < 256 && want(e + 1)) e++;
    const one = (x) => (/[A-Za-z0-9]/.test(String.fromCharCode(x)) ? String.fromCharCode(x) : hex2(x));
    out += e === b ? one(b) : e === b + 1 ? one(b) + one(e) : one(b) + '-' + one(e);
    b = e;
  }
  return '[' + (neg ? '^' : '') + out + ']';
}

class Parser {
  constructor(p, syntax, opts) {
    this.p = p;
    this.n = p.length;
    this.i = 0;
    this.syntax = syntax;
    this.opts = opts;
    this.nsub = 0;
    this.completed = 0;     // completed_bkref_map
    this.tok = null;
    this.longest = false;   // the JS (leftmost-first) match may not be the POSIX longest
    this.dfaWarning = null;
  }

  // peek_token
  peek(syntax) {
    const p = this.p, i = this.i;
    if (i >= this.n) return { type: END_OF_RE, c: '', len: 0 };
    const c = p[i];
    if (c === '\\') {
      if (i + 1 >= this.n) return { type: BACK_SLASH, c, len: 1 };
      const c2 = p[i + 1];
      const t = { type: CHARACTER, c: c2, len: 2 };
      const gnu = !(syntax & RE.NO_GNU_OPS);
      switch (c2) {
        case '|': if (!(syntax & RE.LIMITED_OPS) && !(syntax & RE.NO_BK_VBAR)) t.type = OP_ALT; break;
        case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
          if (!(syntax & RE.NO_BK_REFS)) { t.type = OP_BACK_REF; t.idx = c2.charCodeAt(0) - 49; }
          break;
        case '<': if (gnu) { t.type = ANCHOR; t.ctx = WORD_FIRST; } break;
        case '>': if (gnu) { t.type = ANCHOR; t.ctx = WORD_LAST; } break;
        case 'b': if (gnu) { t.type = ANCHOR; t.ctx = WORD_DELIM; } break;
        case 'B': if (gnu) { t.type = ANCHOR; t.ctx = NOT_WORD_DELIM; } break;
        case 'w': if (gnu) t.type = OP_WORD; break;
        case 'W': if (gnu) t.type = OP_NOTWORD; break;
        case 's': if (gnu) t.type = OP_SPACE; break;
        case 'S': if (gnu) t.type = OP_NOTSPACE; break;
        case '`': if (gnu) { t.type = ANCHOR; t.ctx = BUF_FIRST; } break;
        case "'": if (gnu) { t.type = ANCHOR; t.ctx = BUF_LAST; } break;
        case '(': if (!(syntax & RE.NO_BK_PARENS)) t.type = OP_OPEN_SUBEXP; break;
        case ')': if (!(syntax & RE.NO_BK_PARENS)) t.type = OP_CLOSE_SUBEXP; break;
        case '+': if (!(syntax & RE.LIMITED_OPS) && (syntax & RE.BK_PLUS_QM)) t.type = OP_DUP_PLUS; break;
        case '?': if (!(syntax & RE.LIMITED_OPS) && (syntax & RE.BK_PLUS_QM)) t.type = OP_DUP_QUESTION; break;
        case '{': if ((syntax & RE.INTERVALS) && !(syntax & RE.NO_BK_BRACES)) t.type = OP_OPEN_DUP_NUM; break;
        case '}': if ((syntax & RE.INTERVALS) && !(syntax & RE.NO_BK_BRACES)) t.type = OP_CLOSE_DUP_NUM; break;
      }
      return t;
    }
    const t = { type: CHARACTER, c, len: 1 };
    switch (c) {
      case '\n': if (syntax & RE.NEWLINE_ALT) t.type = OP_ALT; break;
      case '|': if (!(syntax & RE.LIMITED_OPS) && (syntax & RE.NO_BK_VBAR)) t.type = OP_ALT; break;
      case '*': t.type = OP_DUP_ASTERISK; break;
      case '+': if (!(syntax & RE.LIMITED_OPS) && !(syntax & RE.BK_PLUS_QM)) t.type = OP_DUP_PLUS; break;
      case '?': if (!(syntax & RE.LIMITED_OPS) && !(syntax & RE.BK_PLUS_QM)) t.type = OP_DUP_QUESTION; break;
      case '{': if ((syntax & RE.INTERVALS) && (syntax & RE.NO_BK_BRACES)) t.type = OP_OPEN_DUP_NUM; break;
      case '}': if ((syntax & RE.INTERVALS) && (syntax & RE.NO_BK_BRACES)) t.type = OP_CLOSE_DUP_NUM; break;
      case '(': if (syntax & RE.NO_BK_PARENS) t.type = OP_OPEN_SUBEXP; break;
      case ')': if (syntax & RE.NO_BK_PARENS) t.type = OP_CLOSE_SUBEXP; break;
      case '[': t.type = OP_OPEN_BRACKET; break;
      case '.': t.type = OP_PERIOD; break;
      case '^':
        if (!(syntax & (RE.CONTEXT_INDEP_ANCHORS | RE.CARET_ANCHORS_HERE)) && i !== 0) {
          if (!(syntax & RE.NEWLINE_ALT) || p[i - 1] !== '\n') break;
        }
        t.type = ANCHOR; t.ctx = LINE_FIRST;
        break;
      case '$':
        if (!(syntax & RE.CONTEXT_INDEP_ANCHORS) && i + 1 !== this.n) {
          this.i++;
          const next = this.peek(syntax);
          this.i--;
          if (next.type !== OP_ALT && next.type !== OP_CLOSE_SUBEXP) break;
        }
        t.type = ANCHOR; t.ctx = LINE_LAST;
        break;
    }
    return t;
  }

  fetch(syntax = this.syntax) {
    this.tok = this.peek(syntax);
    this.i += this.tok.len;
  }

  parse() {
    this.fetch(this.syntax | RE.CARET_ANCHORS_HERE);
    const tree = this.parseRegExp(0);
    return tree ?? { s: '', max: 0 };
  }

  // parse_reg_exp: branches separated by `|'
  parseRegExp(nest) {
    const initial = this.completed;
    const alts = [this.parseBranch(nest)];
    while (this.tok.type === OP_ALT) {
      this.longest = true;
      this.fetch(this.syntax | RE.CARET_ANCHORS_HERE);
      let branch = null;
      const t = this.tok.type;
      if (t !== OP_ALT && t !== END_OF_RE && (nest === 0 || t !== OP_CLOSE_SUBEXP)) {
        const acc = this.completed;
        this.completed = initial;
        branch = this.parseBranch(nest);
        this.completed |= acc;
      }
      alts.push(branch);
    }
    if (alts.length === 1) return alts[0];
    return { s: alts.map(a => (a ? a.s : '')).join('|'), max: Math.max(...alts.map(a => (a ? a.max : 0))) };
  }

  // parse_branch: a concatenation of expressions
  parseBranch(nest) {
    let tree = this.parseExpression(nest);
    while (this.tok.type !== OP_ALT && this.tok.type !== END_OF_RE
      && (nest === 0 || this.tok.type !== OP_CLOSE_SUBEXP)) {
      const expr = this.parseExpression(nest);
      if (tree !== null && expr !== null) tree = { s: tree.s + expr.s, max: tree.max + expr.max };
      else if (tree === null) tree = expr;
    }
    return tree;
  }

  // parse_expression: one atom with its repetition operators
  parseExpression(nest) {
    const syntax = this.syntax;
    const t = this.tok;
    let tree;
    switch (t.type) {
      case CHARACTER:
        tree = { s: litByte(t.c.charCodeAt(0)), max: 1 };
        break;
      case OP_OPEN_SUBEXP:
        tree = this.parseSubExp(nest + 1);
        break;
      case OP_OPEN_BRACKET:
        tree = { s: this.parseBracket(), max: 1 };
        break;
      case OP_BACK_REF:
        if (!(this.completed & (1 << t.idx))) throw new RegexError('ESUBREG');
        tree = { s: `(?:\\${t.idx + 1})`, max: Infinity };
        break;
      case OP_OPEN_DUP_NUM:
        if (syntax & RE.CONTEXT_INVALID_DUP) throw new RegexError('BADRPT');
        // fallthrough
      case OP_DUP_ASTERISK: case OP_DUP_PLUS: case OP_DUP_QUESTION:
        if (syntax & RE.CONTEXT_INVALID_OPS) throw new RegexError('BADRPT');
        if (syntax & RE.CONTEXT_INDEP_OPS) {
          this.fetch();
          return this.parseExpression(nest);
        }
        // fallthrough
      case OP_CLOSE_SUBEXP:
        if (t.type === OP_CLOSE_SUBEXP && !(syntax & RE.UNMATCHED_RIGHT_PAREN_ORD)) throw new RegexError('ERPAREN');
        // fallthrough
      case OP_CLOSE_DUP_NUM:
        // an operator in a place where it's an ordinary character
        tree = { s: litByte(t.c.charCodeAt(0)), max: 1 };
        break;
      case ANCHOR:
        tree = { s: this.anchor(t.ctx), max: 0 };
        // anchors can't be repeated: `^*' is the anchor and then a `*'
        this.fetch();
        return tree;
      case OP_PERIOD: {
        const set = new Uint8Array(256).fill(1);
        if (!(syntax & RE.DOT_NEWLINE)) set[10] = 0;
        if (syntax & RE.DOT_NOT_NULL) set[0] = 0;
        if (this.opts.nulDelim && !(syntax & RE.DOT_NEWLINE)) set[0] = 0;
        tree = { s: classSrc(set), max: 1 };
        break;
      }
      case OP_WORD: tree = { s: '[A-Za-z0-9_]', max: 1 }; break;
      case OP_NOTWORD: tree = { s: '[^A-Za-z0-9_]', max: 1 }; break;
      case OP_SPACE: tree = { s: '[ \\t\\n\\v\\f\\r]', max: 1 }; break;
      case OP_NOTSPACE: tree = { s: '[^ \\t\\n\\v\\f\\r]', max: 1 }; break;
      case OP_ALT: case END_OF_RE:
        return null;
      case BACK_SLASH:
        throw new RegexError('EESCAPE');
      default:
        return null;
    }
    const simple = t.type !== OP_OPEN_SUBEXP;
    this.fetch();
    let quantified = false;
    while (this.tok.type === OP_DUP_ASTERISK || this.tok.type === OP_DUP_PLUS
      || this.tok.type === OP_DUP_QUESTION || this.tok.type === OP_OPEN_DUP_NUM) {
      const r = this.parseDupOp(tree, quantified);
      if (r === undefined) break;   // an interval read as ordinary characters
      tree = r;
      if (!simple || quantified) this.longest = true;
      quantified = true;
      // in BRE consecutive duplications are not allowed
      if ((syntax & RE.CONTEXT_INVALID_DUP) && (this.tok.type === OP_DUP_ASTERISK || this.tok.type === OP_OPEN_DUP_NUM)) {
        throw new RegexError('BADRPT');
      }
    }
    return tree;
  }

  anchor(ctx) {
    const nl = this.opts.nulDelim ? '\\x00' : '\\n';
    switch (ctx) {
      case LINE_FIRST: return this.opts.newlineAnchor ? `(?<![^${nl}])` : '^';
      case LINE_LAST: return this.opts.newlineAnchor ? `(?![^${nl}])` : '$';
      case BUF_FIRST: return '^';
      case BUF_LAST: return '$';
      case WORD_FIRST: return '\\b(?=[A-Za-z0-9_])';
      case WORD_LAST: return '\\b(?<=[A-Za-z0-9_])';
      case WORD_DELIM: return '\\b';
      case NOT_WORD_DELIM: return '\\B';
    }
    return '';
  }

  // parse_sub_exp
  parseSubExp(nest) {
    const idx = this.nsub++;
    this.fetch(this.syntax | RE.CARET_ANCHORS_HERE);
    let tree = { s: '', max: 0 };
    if (this.tok.type !== OP_CLOSE_SUBEXP) {
      tree = this.parseRegExp(nest) ?? tree;
      if (this.tok.type !== OP_CLOSE_SUBEXP) throw new RegexError('EPAREN');
    }
    if (idx <= 8) this.completed |= 1 << idx;
    return { s: '(' + tree.s + ')', max: tree.max };
  }

  // fetch_number
  fetchNumber() {
    let num = -1;
    for (;;) {
      this.fetch();
      const t = this.tok;
      if (t.type === END_OF_RE) return -2;
      if (t.type === OP_CLOSE_DUP_NUM || t.c === ',') break;
      const c = t.c;
      num = (t.type !== CHARACTER || c < '0' || c > '9' || num === -2) ? -2
        : num === -1 ? c.charCodeAt(0) - 48 : Math.min(RE_DUP_MAX + 1, num * 10 + c.charCodeAt(0) - 48);
    }
    return num;
  }

  // parse_dup_op: returns the repeated tree, or undefined when the operator turned out to be
  // ordinary text (RE_INVALID_INTERVAL_ORD)
  parseDupOp(elem, quantified) {
    const startIdx = this.i, startTok = this.tok;
    let start, end;
    if (this.tok.type === OP_OPEN_DUP_NUM) {
      end = 0;
      start = this.fetchNumber();
      if (start === -1) {
        if (this.tok.type === CHARACTER && this.tok.c === ',') start = 0;   // {,m} is {0,m}
        else throw new RegexError('BADBR');
      }
      if (start !== -2) {
        end = this.tok.type === OP_CLOSE_DUP_NUM ? start
          : (this.tok.type === CHARACTER && this.tok.c === ',') ? this.fetchNumber() : -2;
      }
      if (start === -2 || end === -2) {
        if (!(this.syntax & RE.INVALID_INTERVAL_ORD)) {
          throw new RegexError(this.tok.type === END_OF_RE ? 'EBRACE' : 'BADBR');
        }
        this.i = startIdx;
        this.tok = { ...startTok, type: CHARACTER };
        return undefined;
      }
      if ((end !== -1 && start > end) || this.tok.type !== OP_CLOSE_DUP_NUM) throw new RegexError('BADBR');
      if (RE_DUP_MAX < (end === -1 ? start : end)) throw new RegexError('ESIZE');
    } else {
      start = this.tok.type === OP_DUP_PLUS ? 1 : 0;
      end = this.tok.type === OP_DUP_QUESTION ? 1 : -1;
    }
    this.fetch();
    if (elem === null) return null;
    const q = start === 0 && end === -1 ? '*' : start === 1 && end === -1 ? '+' : start === 0 && end === 1 ? '?'
      : end === -1 ? `{${start},}` : start === end ? `{${start}}` : `{${start},${end}}`;
    // JS quantifiers don't stack; POSIX ones apply to the repeated expression
    const max = elem.max === 0 ? 0 : end === -1 ? Infinity : elem.max * end;
    return { s: (quantified ? '(?:' + elem.s + ')' : elem.s) + q, max };
  }

  // peek_token_bracket
  peekBracket() {
    const p = this.p, i = this.i;
    if (i >= this.n) return { type: END_OF_RE, c: '', len: 0 };
    const c = p[i];
    if (c === '\\' && (this.syntax & RE.BACKSLASH_ESCAPE_IN_LISTS) && i + 1 < this.n) {
      return { type: CHARACTER, c: p[i + 1], len: 2 };
    }
    if (c === '[') {
      const c2 = i + 1 < this.n ? p[i + 1] : '';
      if (c2 === '.') return { type: OP_OPEN_COLL_ELEM, c: c2, len: 2 };
      if (c2 === '=') return { type: OP_OPEN_EQUIV_CLASS, c: c2, len: 2 };
      if (c2 === ':' && (this.syntax & RE.CHAR_CLASSES)) return { type: OP_OPEN_CHAR_CLASS, c: c2, len: 2 };
      return { type: CHARACTER, c, len: 1 };
    }
    if (c === '-') return { type: OP_CHARSET_RANGE, c, len: 1 };
    if (c === ']') return { type: OP_CLOSE_BRACKET, c, len: 1 };
    if (c === '^') return { type: OP_NON_MATCH_LIST, c, len: 1 };
    return { type: CHARACTER, c, len: 1 };
  }

  // parse_bracket_symbol: [:name:], [.name.], [=name=]
  parseBracketSymbol(tok) {
    const delim = tok.c;
    let name = '';
    if (this.i >= this.n) throw new RegexError('EBRACK');
    for (let k = 0; ; k++) {
      if (k >= BRACKET_NAME_BUF_SIZE) throw new RegexError('EBRACK');
      const ch = this.p[this.i++];
      if (this.i >= this.n) throw new RegexError('EBRACK');
      if (ch === delim && this.p[this.i] === ']') break;
      name += ch;
    }
    this.i++;
    const type = tok.type === OP_OPEN_COLL_ELEM ? COLL_SYM : tok.type === OP_OPEN_EQUIV_CLASS ? EQUIV_CLASS : CHAR_CLASS;
    return { type, name };
  }

  // parse_bracket_element
  parseBracketElement(tok, acceptHyphen) {
    this.i += tok.len;
    if (tok.type === OP_OPEN_COLL_ELEM || tok.type === OP_OPEN_CHAR_CLASS || tok.type === OP_OPEN_EQUIV_CLASS) {
      return this.parseBracketSymbol(tok);
    }
    if (tok.type === OP_CHARSET_RANGE && !acceptHyphen) {
      // a '-' that doesn't end the list must start a range
      if (this.peekBracket().type !== OP_CLOSE_BRACKET) throw new RegexError('ERANGE');
    }
    return { type: SB_CHAR, ch: tok.c.charCodeAt(0) };
  }

  // parse_bracket_exp
  parseBracket() {
    const set = new Uint8Array(256);
    const bodyStart = this.i;
    let nonMatch = false;
    let tok = this.peekBracket();
    if (tok.type === END_OF_RE) throw new RegexError('BADPAT');
    if (tok.type === OP_NON_MATCH_LIST) {
      nonMatch = true;
      if (this.syntax & RE.HAT_LISTS_NOT_NEWLINE) set[10] = 1;
      if (this.opts.nulDelim && (this.syntax & RE.HAT_LISTS_NOT_NEWLINE)) set[0] = 1;
      this.i += tok.len;
      tok = this.peekBracket();
      if (tok.type === END_OF_RE) throw new RegexError('BADPAT');
    }
    const listStart = this.i;
    if (tok.type === OP_CLOSE_BRACKET) tok = { ...tok, type: CHARACTER };
    let first = true, sawClass = false;
    const elemByte = (e) => (e.type === SB_CHAR ? e.ch : e.name.charCodeAt(0));
    for (;;) {
      const startElem = this.parseBracketElement(tok, first);
      first = false;
      if (startElem.type !== SB_CHAR) sawClass = true;
      tok = this.peekBracket();
      let isRange = false, tok2 = null;
      if (startElem.type !== CHAR_CLASS && startElem.type !== EQUIV_CLASS) {
        if (tok.type === END_OF_RE) throw new RegexError('EBRACK');
        if (tok.type === OP_CHARSET_RANGE) {
          this.i += tok.len;
          tok2 = this.peekBracket();
          if (tok2.type === END_OF_RE) throw new RegexError('EBRACK');
          if (tok2.type === OP_CLOSE_BRACKET) { this.i -= tok.len; tok = { ...tok, type: CHARACTER }; }
          else isRange = true;
        }
      }
      if (isRange) {
        const endElem = this.parseBracketElement(tok2, true);
        if (endElem.type !== SB_CHAR) sawClass = true;
        tok = this.peekBracket();
        // build_range_exp
        if (startElem.type === EQUIV_CLASS || startElem.type === CHAR_CLASS
          || endElem.type === EQUIV_CLASS || endElem.type === CHAR_CLASS) throw new RegexError('ERANGE');
        if ((startElem.type === COLL_SYM && startElem.name.length !== 1)
          || (endElem.type === COLL_SYM && endElem.name.length !== 1)) throw new RegexError('ECOLLATE');
        const lo = elemByte(startElem), hi = elemByte(endElem);
        if ((this.syntax & RE.NO_EMPTY_RANGES) && lo > hi) throw new RegexError('ERANGE');
        for (let b = lo; b <= hi; b++) set[b] = 1;
      } else {
        switch (startElem.type) {
          case SB_CHAR: set[startElem.ch] = 1; break;
          case EQUIV_CLASS:
          case COLL_SYM:
            if (startElem.name.length !== 1) throw new RegexError('ECOLLATE');
            set[startElem.name.charCodeAt(0)] = 1;
            break;
          case CHAR_CLASS: {
            let name = startElem.name;
            if ((this.syntax & RE.ICASE) && (name === 'upper' || name === 'lower')) name = 'alpha';
            const f = Object.prototype.hasOwnProperty.call(CTYPE, name) ? CTYPE[name] : null;
            if (!f) throw new RegexError('ECTYPE');
            for (let b = 0; b < 256; b++) if (f(b)) set[b] = 1;
            break;
          }
        }
      }
      if (tok.type === END_OF_RE) throw new RegexError('EBRACK');
      if (tok.type === OP_CLOSE_BRACKET) break;
    }
    const bodyEnd = this.i;
    this.i += tok.len;
    // dfa.c: "[:alpha:]" where "[[:alpha:]]" was meant
    const body = this.p.slice(listStart, bodyEnd);
    if (!this.dfaWarning && !sawClass && body.length > 1 && body[0] === ':' && body[body.length - 1] === ':' && /[^:]/.test(body)) {
      this.dfaWarning = 'character class syntax is [[:space:]], not [:space:]';
    }
    void bodyStart;
    if (nonMatch) for (let b = 0; b < 256; b++) set[b] ^= 1;
    return classSrc(set);
  }
}

// Compile a GNU regex. opts.newlineAnchor: ^/$ also match at line boundaries (REG_NEWLINE);
// opts.nulDelim: lines are NUL-separated (sed -z). Throws RegexError.
// Returns { src, maxLen, flags, nsub, longest, dfaWarning }; `longest` tells that a JS match may
// fall short of the POSIX leftmost-longest one, maxLen bounds the length of any match.
export function compileGnuRegex(pattern, syntax, opts = {}) {
  const ps = new Parser(pattern, syntax, opts);
  const tree = ps.parse();
  return { src: tree.s, maxLen: tree.max, flags: (syntax & RE.ICASE) ? 'i' : '', nsub: ps.nsub, longest: ps.longest, dfaWarning: ps.dfaWarning };
}

export const isGnuWordChar = isWordChar;
