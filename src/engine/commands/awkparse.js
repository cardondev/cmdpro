// The awk parser of gawk 5.1. yylex(), the source buffering it depends on and yyerror() follow
// awkgram.y, the LALR(1) tables are bison's for tools/awk-grammar.y (the same automaton as
// gawk's), and the actions build the syntax tree awk.js interprets — with gawk's checks and
// diagnostics along the way.
import { AWK_TABLES as T } from './awk-tables.js';

const TK = T.tokens;
const END_FILE = -1000, END_SRC = -2000;
const YYEMPTY = -2, YYEOF = 0, YYTERROR = 1, YYUNDEFTOK = 2, YYMAXDEPTH = 10000;

// ruletab
const BEGIN = 1, RULE = 2, END = 3, BEGINFILE = 4, ENDFILE = 5;
const RULENAME = ['?', 'BEGIN', 'Rule', 'END', 'BEGINFILE', 'ENDFILE'];
const DONT_CHECK = 0, FUNC_HEADER = 1, FUNC_BODY = 2;

const A = (...ns) => ns.reduce((m, n) => m | (1 << n), 0);
const GAWKX = 0x400, NOT_POSIX = 0x200, BREAK = 0x800, CONTINUE = 0x1000;
// tokentab: name, lexical class, flags (argument counts allowed in the low byte)
const TOKENTAB = [
  ['BEGIN', 'LEX_BEGIN', 0], ['BEGINFILE', 'LEX_BEGINFILE', GAWKX], ['END', 'LEX_END', 0], ['ENDFILE', 'LEX_ENDFILE', GAWKX],
  ['and', 'LEX_BUILTIN', GAWKX], ['asort', 'LEX_BUILTIN', GAWKX | A(1, 2, 3)], ['asorti', 'LEX_BUILTIN', GAWKX | A(1, 2, 3)],
  ['atan2', 'LEX_BUILTIN', A(2)], ['bindtextdomain', 'LEX_BUILTIN', GAWKX | A(1, 2)], ['break', 'LEX_BREAK', 0],
  ['case', 'LEX_CASE', GAWKX], ['close', 'LEX_BUILTIN', A(1, 2)], ['compl', 'LEX_BUILTIN', GAWKX | A(1)], ['continue', 'LEX_CONTINUE', 0],
  ['cos', 'LEX_BUILTIN', A(1)], ['dcgettext', 'LEX_BUILTIN', GAWKX | A(1, 2, 3)], ['dcngettext', 'LEX_BUILTIN', GAWKX | A(1, 2, 3, 4, 5)],
  ['default', 'LEX_DEFAULT', GAWKX], ['delete', 'LEX_DELETE', 0], ['do', 'LEX_DO', BREAK | CONTINUE], ['else', 'LEX_ELSE', 0],
  ['eval', 'LEX_EVAL', 0], ['exit', 'LEX_EXIT', 0], ['exp', 'LEX_BUILTIN', A(1)], ['fflush', 'LEX_BUILTIN', A(0, 1)],
  ['for', 'LEX_FOR', BREAK | CONTINUE], ['func', 'LEX_FUNCTION', NOT_POSIX], ['function', 'LEX_FUNCTION', 0],
  ['gensub', 'LEX_BUILTIN', GAWKX | A(3, 4)], ['getline', 'LEX_GETLINE', 0], ['gsub', 'LEX_BUILTIN', A(2, 3)], ['if', 'LEX_IF', 0],
  ['in', 'LEX_IN', 0], ['include', 'LEX_INCLUDE', GAWKX], ['index', 'LEX_BUILTIN', A(2)], ['int', 'LEX_BUILTIN', A(1)],
  ['isarray', 'LEX_BUILTIN', GAWKX | A(1)], ['length', 'LEX_LENGTH', A(0, 1)], ['load', 'LEX_LOAD', GAWKX], ['log', 'LEX_BUILTIN', A(1)],
  ['lshift', 'LEX_BUILTIN', GAWKX | A(2)], ['match', 'LEX_BUILTIN', A(2, 3)], ['mktime', 'LEX_BUILTIN', GAWKX | A(1, 2)],
  ['namespace', 'LEX_NAMESPACE', GAWKX], ['next', 'LEX_NEXT', 0], ['nextfile', 'LEX_NEXTFILE', 0], ['or', 'LEX_BUILTIN', GAWKX],
  ['patsplit', 'LEX_BUILTIN', GAWKX | A(2, 3, 4)], ['print', 'LEX_PRINT', 0], ['printf', 'LEX_PRINTF', 0], ['rand', 'LEX_BUILTIN', A(0)],
  ['return', 'LEX_RETURN', 0], ['rshift', 'LEX_BUILTIN', GAWKX | A(2)], ['sin', 'LEX_BUILTIN', A(1)], ['split', 'LEX_BUILTIN', A(2, 3, 4)],
  ['sprintf', 'LEX_BUILTIN', 0], ['sqrt', 'LEX_BUILTIN', A(1)], ['srand', 'LEX_BUILTIN', A(0, 1)], ['strftime', 'LEX_BUILTIN', GAWKX | A(0, 1, 2, 3)],
  ['strtonum', 'LEX_BUILTIN', GAWKX | A(1)], ['sub', 'LEX_BUILTIN', A(2, 3)], ['substr', 'LEX_BUILTIN', A(2, 3)],
  ['switch', 'LEX_SWITCH', GAWKX | BREAK], ['system', 'LEX_BUILTIN', A(1)], ['systime', 'LEX_BUILTIN', GAWKX | A(0)],
  ['tolower', 'LEX_BUILTIN', A(1)], ['toupper', 'LEX_BUILTIN', A(1)], ['typeof', 'LEX_BUILTIN', GAWKX | A(1, 2)],
  ['while', 'LEX_WHILE', BREAK | CONTINUE], ['xor', 'LEX_BUILTIN', GAWKX],
];
const TOKMAP = new Map(TOKENTAB.map((t, i) => [t[0], i]));

// the special variables (is_std_var)
export const STD_VARS = new Set(['ARGC', 'ARGIND', 'ARGV', 'BINMODE', 'CONVFMT', 'ENVIRON', 'ERRNO', 'FIELDWIDTHS', 'FILENAME', 'FNR', 'FPAT',
  'FS', 'FUNCTAB', 'IGNORECASE', 'LINT', 'NF', 'NR', 'OFMT', 'OFS', 'ORS', 'PROCINFO', 'RLENGTH', 'RS', 'RSTART', 'RT', 'SUBSEP', 'SYMTAB', 'TEXTDOMAIN']);

const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isIdent = (c) => isLetter(c) || (c >= 48 && c <= 57);
const isDigit = (c) => c >= 48 && c <= 57;
const isXdigit = (c) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isSpace = (c) => c === 32 || (c >= 9 && c <= 13);

// MID_POS: for each mid-rule action, the number of symbols before it in its rule
const MID_POS = {};
T.rules.forEach((r, i) => {
  const m = /^(@\d+):$/.exec(r);
  if (!m) return;
  for (const r2 of T.rules) {
    const k = r2.indexOf(': ');
    const rhs = r2.slice(k + 2).split(' ');
    const at = rhs.indexOf(m[1]);
    if (at >= 0) { MID_POS[i] = at; break; }
  }
});

class Abort { }

export class AwkParser {
  // sources: [{ stype: 'cmdline' | 'file' | 'inc', src, text }]
  // io: { error(text), warn(text) } — text without the "awk: " prefix
  constructor(sources, io, opts = {}) {
    this.sources = sources.map(s => ({ ...s, buf: null, started: false }));
    this.io = io;
    this.opts = opts;
    this.srcIdx = 0;
    this.items = [];          // rules in program order
    this.funcs = new Map();
    this.symbols = new Map(); // name -> 'func' | 'var' | 'param'
    this.errcount = 0;
    this.rule = 0;
    this.inFunction = null;
    this.wantParamNames = DONT_CHECK;
    this.inPrint = false;
    this.inParens = 0;
    this.wantRegexp = false;
    this.wantSource = false;
    this.atSeen = false;
    this.breakAllowed = 0;
    this.continueAllowed = 0;
    this.inBraces = 0;
    this.didNewline = false;
    this.qmColCount = 0;
    this.subCounter = 0;
    this.lasttok = 0;
    this.lexeof = false;
    this.lexptr = null;
    this.escWarned = new Set();
    this.funcUseMap = new Map();
    this.sourceline = 0;
    this.source = null;
  }

  // ------------------------------------------------------------- messages (msg.c err())
  where() {
    if (this.sourceline > 0) return (this.source !== null ? `${this.source}:` : 'cmd. line:') + `${this.sourceline}: `;
    return '';
  }
  msg(text) { this.io.error(this.where() + text); }
  warning(text) { this.io.error(this.where() + 'warning: ' + text); }
  errorLn(line, text) {
    const save = this.sourceline;
    this.sourceline = line;
    this.errcount++;
    this.io.error(this.where() + 'error: ' + text);
    this.sourceline = save;
  }
  warningLn(line, text) {
    const save = this.sourceline;
    this.sourceline = line;
    this.warning(text);
    this.sourceline = save;
  }

  // yyerror: the source line and a caret under the token that went wrong
  yyerror(m) {
    let mesg = null;
    this.errcount++;
    let thisline, bp, buf;
    const generic = m.startsWith('syntax error');
    if (this.lexptr !== null && this.lexeme !== null) {
      buf = this.buf;
      if (this.thisline === null) {
        let cp = this.lexeme;
        if (buf[cp] === '\n') {
          if (cp > this.lexptrBegin) cp--;
          mesg = 'unexpected newline or end of string';
        }
        for (; cp !== this.lexptrBegin && buf[cp] !== '\n'; --cp);
        if (buf[cp] === '\n') cp++;
        this.thisline = cp;
      }
      thisline = this.thisline;
      bp = this.lexeme;
      if (bp < thisline) bp = thisline + 1;
      while (bp < this.lexend && bp < buf.length && buf[bp] !== '\n') bp++;
    }
    let line;
    if (this.lexptr === null) {
      line = '(END OF FILE)';
    } else line = null;
    if (this.lexeof && mesg === null && generic) {
      this.msg('(END OF FILE)');
      mesg = 'source files / command-line arguments must contain complete functions or rules';
    } else this.msg(line !== null ? line : buf.slice(thisline, bp));
    if (mesg === null) mesg = m;
    let caret = '';
    if (this.lexptr !== null) {
      for (let s = thisline; s < this.lexeme; s++) caret += buf[s] === '\t' ? '\t' : ' ';
      caret += '^ ';
    }
    this.msg(caret + mesg);
  }

  // ------------------------------------------------------------- reading the source
  get cur() { return this.sources[this.srcIdx]; }

  // get_src_buf: false when there is no more source
  getSrcBuf() {
    const s = this.cur;
    if (!s) return false;
    if (s.stype === 'cmdline') {
      if (!s.started) {
        s.started = true;
        this.buf = s.text;
        this.lexptr = this.lexptrBegin = this.lexeme = 0;
        this.lexend = s.text.length;
        this.sourceline = 1;
        if (s.text.length === 0) this.lexeof = true;
      } else if (s.buf === null && this.buf[this.lexptr - 1] !== '\n') {
        // make the source end in a newline, keeping the whole current line for messages
        const offset = this.lexptr - this.lexeme;
        let scan = this.lexeme;
        for (; scan > this.lexptrBegin; scan--) if (this.buf[scan] === '\n') { scan++; break; }
        const nb = this.buf.slice(scan, this.lexptr) + '\n';
        this.thisline = 0;
        this.lexptr = nb.length - 1;
        this.lexeme = this.lexptr - offset;
        this.lexptrBegin = 0;
        this.lexend = this.lexptr + 1;
        this.buf = nb;
        s.buf = nb;
      } else this.lexeof = true;
      return true;
    }
    // a program file
    if (!s.started) {
      s.started = true;
      this.source = s.src;
      if (s.error) {
        // read() failed (a directory): the message carries the file name and line 1
        this.sourceline = 1;
        this.buf = '';
        this.lexptr = this.lexptrBegin = this.lexeme = this.lexend = 0;
        this.io.error(`${s.src}:1: error: cannot read source file \`${s.src}': ${s.error}`);
        this.errcount++;
        this.lexeof = true;
        return true;
      }
      this.buf = s.text;
      this.lexptr = this.lexptrBegin = this.lexeme = 0;
      this.lexend = s.text.length;
      this.sourceline = 1;
      this.thisline = null;
      if (s.text.length === 0) this.lexeof = true;
      return true;
    }
    // past the end: keep the current line at the start of the buffer, then there is nothing more
    let scan = this.lexeme;
    for (; scan > this.lexptrBegin; scan--) if (this.buf[scan] === '\n') { scan++; break; }
    const savelen = this.lexptr - scan, offset = this.lexptr - this.lexeme;
    if (savelen > 0) {
      const nb = this.buf.slice(scan, this.lexptr);
      this.thisline = 0;
      this.buf = nb;
      this.lexptr = savelen;
      this.lexeme = this.lexptr - offset;
    } else {
      this.buf = '';
      this.lexptr = this.lexeme = 0;
      this.thisline = null;
    }
    this.lexptrBegin = 0;
    this.lexend = this.lexptr;
    this.lexeof = true;
    return true;
  }

  nextc(checkBad) {
    do {
      if (this.lexeof) return END_FILE;
      if (this.lexptr !== null && this.lexptr < this.lexend) {
        const c = this.buf.charCodeAt(this.lexptr);
        if (checkBad || c === 0) this.checkBadChar(c);
        this.lexptr++;
        return c;
      }
    } while (this.getSrcBuf());
    return END_SRC;
  }

  checkBadChar(c) {
    if (c === 7 || c === 8 || c === 12 || c === 10 || c === 13 || c === 9) return;
    if ((c < 32 || c === 127) && !isSpace(c)) {
      this.io.fatal(this.where() + `fatal: error: invalid character '\\${(c & 255).toString(8).padStart(3, '0')}' in source code`);
    }
  }

  pushback() {
    if (!this.lexeof && this.lexptr !== null && this.lexptr > this.lexptrBegin) this.lexptr--;
  }

  allowNewline() {
    for (;;) {
      let c = this.nextc(true);
      if (c === END_FILE) { this.pushback(); break; }
      if (c === 35) {   // '#'
        while ((c = this.nextc(false)) !== 10 && c !== END_FILE);
        if (c === END_FILE) { this.pushback(); break; }
      }
      if (c === 10) this.sourceline++;
      if (!isSpace(c)) { this.pushback(); break; }
    }
  }

  newlineEof() {
    if (this.lasttok !== TK.NEWLINE) {
      this.pushback();
      this.sourceline++;
      return TK.NEWLINE;
    }
    this.sourceline--;
    return TK.LEX_EOF;
  }

  nextSourcefile() {
    this.lexeof = false;
    this.srcIdx++;
    while (this.cur && this.cur.stype === 'lib') this.srcIdx++;
    const s = this.cur;
    if (s && s.saved) {
      Object.assign(this, s.saved);
      s.saved = null;
    } else {
      this.lexptr = null;
      this.sourceline = 0;
      this.source = null;
      this.lasttok = 0;
    }
  }

  // ------------------------------------------------------------- yylex
  lex() {
    this.lval = null;
    if (this.lasttok === TK.SUBSCRIPT) { this.lasttok = 0; return TK.SUBSCRIPT; }
    if (this.lasttok === TK.LEX_EOF) return 0;
    let c = this.nextc(!this.wantRegexp);
    if (c === END_SRC) return 0;
    if (c === END_FILE) return this.lasttok = this.newlineEof();
    this.pushback();
    this.lexeme = this.lexptr;
    this.thisline = null;
    const tok = (t, extra) => { this.lval = { line: this.sourceline, ...extra }; return this.lasttok = t; };
    let collectingTyped = false;

    if (this.wantRegexp) return this.collectRegexp(false);

    for (;;) {
      // retry:
      while ((c = this.nextc(true)) === 32 || c === 9 || c === 13);
      this.lexeme = this.lexptr !== null ? this.lexptr - 1 : this.lexptr;
      this.thisline = null;
      switch (c) {
        case END_SRC: return 0;
        case END_FILE: return this.lasttok = this.newlineEof();
        case 10: this.sourceline++; return this.lasttok = TK.NEWLINE;
        case 35:   // comment
          while ((c = this.nextc(false)) !== 10) if (c === END_FILE) return this.lasttok = this.newlineEof();
          this.sourceline++;
          return this.lasttok = TK.NEWLINE;
        case 64: {  // '@'
          c = this.nextc(true);
          if (c === 47) { this.wantRegexp = true; collectingTyped = true; return this.collectRegexp(true); }
          this.pushback();
          this.atSeen = true;
          return tok(64);
        }
        case 92: {  // '\\' continuation
          c = this.nextc(true);
          if (c === 13) c = this.nextc(true);
          if (c === 10) { this.sourceline++; continue; }
          this.yyerror('backslash not last character on line');
          return this.lasttok = TK.LEX_EOF;
        }
        case 63: case 58: {   // '?' ':'
          if (c === 63) this.qmColCount++;
          if (this.qmColCount > 0) {
            if (!this.opts.posix) this.allowNewline();
            if (c === 58) this.qmColCount--;
          }
          return tok(c);
        }
        case 41: this.inParens--; return tok(41);
        case 40: this.inParens++; return tok(40);
        case 36: return tok(36);
        case 123: if (++this.inBraces === 1) this.firstline = this.sourceline; return tok(123);
        case 59: case 44: case 91: return tok(c);
        case 93: {
          c = this.nextc(true);
          this.pushback();
          if (c === 91) { this.lval = { line: this.sourceline, subArray: true }; this.lasttok = 93; }
          else { this.lval = { line: this.sourceline }; this.lasttok = TK.SUBSCRIPT; }
          return 93;
        }
        case 42: {   // '*'
          if ((c = this.nextc(true)) === 61) return tok(TK.ASSIGNOP, { op: '*=' });
          if (this.opts.posix) { this.pushback(); return tok(42); }
          if (c === 42) {
            if (this.nextc(true) === 61) { this.lval = { line: this.sourceline, op: '^=' }; return TK.ASSIGNOP; }
            this.pushback();
            return tok(94);
          }
          this.pushback();
          return tok(42);
        }
        case 47: {   // '/'
          if (this.nextc(false) === 61) { this.pushback(); return tok(TK.SLASH_BEFORE_EQUAL); }
          this.pushback();
          return tok(47);
        }
        case 37:
          if (this.nextc(true) === 61) return tok(TK.ASSIGNOP, { op: '%=' });
          this.pushback();
          return tok(37);
        case 94:
          if (this.nextc(true) === 61) return tok(TK.ASSIGNOP, { op: '^=' });
          this.pushback();
          return tok(94);
        case 43:
          if ((c = this.nextc(true)) === 61) return tok(TK.ASSIGNOP, { op: '+=' });
          if (c === 43) return tok(TK.INCREMENT);
          this.pushback();
          return tok(43);
        case 33:
          if ((c = this.nextc(true)) === 61) return tok(TK.RELOP, { op: '!=' });
          if (c === 126) return tok(TK.MATCHOP, { op: '!~' });
          this.pushback();
          return tok(33);
        case 60:
          if (this.nextc(true) === 61) return tok(TK.RELOP, { op: '<=' });
          this.lval = { line: this.sourceline, op: '<' };
          this.pushback();
          return this.lasttok = 60;
        case 61:
          if (this.nextc(true) === 61) return tok(TK.RELOP, { op: '==' });
          this.lval = { line: this.sourceline, op: '=' };
          this.pushback();
          return this.lasttok = TK.ASSIGN;
        case 62:
          if ((c = this.nextc(true)) === 61) return tok(TK.RELOP, { op: '>=' });
          if (c === 62) return tok(TK.IO_OUT, { redir: '>>' });
          this.pushback();
          if (this.inPrint && this.inParens === 0) return tok(TK.IO_OUT, { redir: '>' });
          return tok(62, { op: '>' });
        case 126: return tok(TK.MATCHOP, { op: '~' });
        case 125:   // '}': a NEWLINE first
          if (this.didNewline) {
            this.didNewline = false;
            if (--this.inBraces === 0) this.lastline = this.sourceline;
            return tok(125);
          }
          this.didNewline = true;
          --this.lexptr;
          return this.lasttok = TK.NEWLINE;
        case 34: return this.lexString(false);
        case 45:
          if ((c = this.nextc(true)) === 61) return tok(TK.ASSIGNOP, { op: '-=' });
          if (c === 45) return tok(TK.DECREMENT);
          this.pushback();
          return tok(45);
        case 46: {
          c = this.nextc(true);
          this.pushback();
          if (!isDigit(c)) return tok(46);
          return this.lexNumber(46);
        }
        case 38:
          if ((c = this.nextc(true)) === 38) { const t = tok(TK.LEX_AND); this.allowNewline(); return t; }
          this.pushback();
          return tok(38);
        case 124:
          if ((c = this.nextc(true)) === 124) { const t = tok(TK.LEX_OR); this.allowNewline(); return t; }
          if (!this.opts.traditional && c === 38) return tok(this.inPrint && this.inParens === 0 ? TK.IO_OUT : TK.IO_IN, { redir: '|&' });
          this.pushback();
          if (this.inPrint && this.inParens === 0) return tok(TK.IO_OUT, { redir: '|' });
          return tok(TK.IO_IN, { redir: '|' });
        default:
          if (isDigit(c)) return this.lexNumber(c);
          break;
      }
      if (!isLetter(c)) {
        this.yyerror(`invalid char '${String.fromCharCode(c & 255)}' in expression`);
        return this.lasttok = TK.LEX_EOF;
      }
      return this.lexName(c);
    }
  }

  collectRegexp(typed) {
    let inBrack = 0, bIndex = -1;
    this.wantRegexp = false;
    let t = '';
    for (;;) {
      let c = this.nextc(false);
      const curIndex = t.length;
      switch (c) {
        case 91:
          if (this.nextc(false) === 58 || inBrack === 0) { inBrack++; if (inBrack === 1) bIndex = t.length; }
          this.pushback();
          break;
        case 93:
          if (inBrack > 0 && (curIndex === bIndex + 1 || (curIndex === bIndex + 2 && t[t.length - 1] === '^'))) { /* nothing */ }
          else { inBrack--; if (inBrack === 0) bIndex = -1; }
          break;
        case 92:
          if ((c = this.nextc(false)) === END_FILE) {
            this.pushback();
            this.yyerror('unterminated regexp ends with `\\\' at end of file');
            return this.endRegexp(t, typed);
          }
          if (c === 13) c = this.nextc(true);
          if (c === 10) { this.sourceline++; continue; }
          t += '\\' + String.fromCharCode(c);
          continue;
        case 47:
          if (inBrack > 0) break;
          return this.endRegexp(t, typed);
        case 10:
          this.pushback();
          this.yyerror('unterminated regexp');
          return this.endRegexp(t, typed);
        case END_FILE:
          this.pushback();
          this.yyerror('unterminated regexp at end of file');
          return this.endRegexp(t, typed);
      }
      t += String.fromCharCode(c);
    }
  }

  endRegexp(t, typed) {
    this.lval = { line: this.sourceline, re: t };
    return this.lasttok = typed ? TK.TYPED_REGEXP : TK.REGEXP;
  }

  lexString(intl) {
    let t = '', escSeen = false;
    let c;
    while ((c = this.nextc(false)) !== 34) {
      if (c === 10) { this.pushback(); this.yyerror('unterminated string'); return this.lasttok = TK.LEX_EOF; }
      if (c === 92) {
        c = this.nextc(true);
        if (c === 13) c = this.nextc(true);
        if (c === 10) {
          if (this.opts.posix) this.io.fatal(this.where() + 'fatal: POSIX does not allow physical newlines in string values');
          this.sourceline++;
          continue;
        }
        escSeen = true;
        if (!this.wantSource || c !== 34) t += '\\';
      }
      if (c === END_FILE) { this.pushback(); this.yyerror('unterminated string'); return this.lasttok = TK.LEX_EOF; }
      t += String.fromCharCode(c);
    }
    if (this.wantSource) { this.lval = { line: this.sourceline, file: t }; return this.lasttok = TK.FILENAME; }
    const v = escSeen ? this.scanEscapes(t) : t;
    this.lval = { line: this.sourceline, str: v, intl };
    return this.lasttok = TK.YSTRING;
  }

  // make_str_node(..., SCAN): parse_escape over a string constant
  scanEscapes(s) {
    let out = '';
    for (let i = 0; i < s.length;) {
      const ch = s[i++];
      if (ch !== '\\') { out += ch; continue; }
      const r = parseEscape(s, i, this.opts, (msg) => this.warnEscape(msg));
      if (r.c === -1) { out += '\\'; continue; }
      if (r.c === -2) { i = r.i; continue; }
      out += String.fromCharCode(r.c & 255);
      i = r.i;
    }
    return out;
  }

  // parse_escape() warns once per character (shared with -v and command-line assignments), but
  // every time about \x without hex digits
  warnEscape(msg) {
    const seen = this.opts.warned || this.escWarned;
    if (!msg.startsWith('no hex')) {
      if (seen.has(msg)) return;
      seen.add(msg);
    }
    this.warning(msg);
  }

  lexNumber(c) {
    let t = '';
    let seenE = false, seenPoint = false, inhex = false;
    for (;;) {
      let got = false;
      t += String.fromCharCode(c);
      switch (c) {
        case 120: case 88:   // x X
          if (this.opts.traditional) { got = true; break; }
          if (t.length === 2) {
            const peek = this.nextc(true);
            if (isXdigit(peek)) { inhex = true; this.pushback(); }
            else { this.pushback(); got = true; }
          }
          break;
        case 46:
          if (seenPoint || seenE) { got = true; break; }
          seenPoint = true;
          break;
        case 101: case 69:
          if (inhex) break;
          if (seenE) { got = true; break; }
          seenE = true;
          if ((c = this.nextc(true)) === 45 || c === 43) {
            const c2 = this.nextc(true);
            if (isDigit(c2)) { t += String.fromCharCode(c) + String.fromCharCode(c2); }
            else { this.pushback(); this.pushback(); this.pushback(); }
          } else if (!isDigit(c)) { this.pushback(); this.pushback(); }
          else this.pushback();
          break;
        case 97: case 65: case 98: case 66: case 99: case 67: case 68: case 100: case 102: case 70:
          if (this.opts.traditional || !inhex) { got = true; break; }
          break;
        default:
          if (!isDigit(c)) got = true;
      }
      if (got) break;
      c = this.nextc(true);
    }
    this.pushback();
    t = t.slice(0, -1);   // the character that ended it
    let base = 10;
    if (!this.opts.traditional) base = numBase(t);
    const v = base !== 10 ? nondec2num(t) : parseFloat(t);
    this.lval = { line: this.sourceline, num: v, text: t };
    return this.lasttok = TK.YNUMBER;
  }

  lexName(c) {
    if (!this.opts.traditional && c === 95 && this.lasttok !== 36) {
      if ((c = this.nextc(true)) === 34) return this.lexString(true);
      this.pushback();
      c = 95;
    }
    let t = '';
    while (c !== END_FILE && isIdent(c)) {
      t += String.fromCharCode(c);
      c = this.nextc(true);
      if (!this.opts.traditional && c === 58) {
        const peek = this.nextc(true);
        if (peek === 58) { t += '::'; c = this.nextc(true); } else this.pushback();
      }
    }
    this.pushback();
    let name = t;
    if (name.startsWith('awk::')) name = name.slice(5);
    let mid = TOKMAP.has(name) ? TOKMAP.get(name) : -1;
    if (mid >= 0) {
      const [, cls, flags] = TOKENTAB[mid];
      if ((this.opts.traditional && (flags & GAWKX)) || (this.opts.posix && (flags & NOT_POSIX))) mid = -1;
      else if (cls === 'LEX_EVAL') mid = -1;   // only in the debugger's eval context
      else if ((cls === 'LEX_INCLUDE' || cls === 'LEX_LOAD' || cls === 'LEX_NAMESPACE') && this.lasttok !== 64) mid = -1;
      else if (flags & GAWKX) {
        // parameter names may shadow gawk-extension builtins
        if (this.wantParamNames === FUNC_HEADER) mid = -1;
        else if (this.wantParamNames === FUNC_BODY && this.symbols.get(name) === 'param') mid = -1;
      }
    }
    if (mid >= 0) {
      const [, cls, flags] = TOKENTAB[mid];
      if (flags & BREAK) this.breakAllowed++;
      if (flags & CONTINUE) this.continueAllowed++;
      const line = this.sourceline;
      switch (cls) {
        case 'LEX_NAMESPACE': case 'LEX_INCLUDE': case 'LEX_LOAD': this.wantSource = true; break;
        case 'LEX_CONTINUE':
          if (!this.continueAllowed) { this.errorLn(this.sourceline, "`continue' is not allowed outside a loop"); this.errcount++; }
          break;
        case 'LEX_BREAK':
          if (!this.breakAllowed) { this.errorLn(this.sourceline, "`break' is not allowed outside a loop or switch"); this.errcount++; }
          break;
        default: break;
      }
      this.lval = { line, name, builtin: cls === 'LEX_BUILTIN' || cls === 'LEX_LENGTH' ? mid : undefined };
      return this.lasttok = TK[cls];
    }
    this.lval = { line: this.sourceline, name };
    if (this.buf[this.lexptr] === '(') return this.lasttok = TK.FUNC_CALL;
    return this.lasttok = TK.NAME;
  }

  // ------------------------------------------------------------- the parser (bison's yacc.c skeleton)
  parse() {
    const { yypact, yydefact, yypgoto, yydefgoto, yytable, yycheck, yyr1, yyr2, yytranslate, YYFINAL, YYLAST, YYNTOKENS, YYPACT_NINF, YYTABLE_NINF, YYMAXUTOK } = T;
    const ss = [0], vs = [undefined];
    let state = 0, yychar = YYEMPTY, yytoken = 0;
    this.errstatus = 0;
    try {
      for (;;) {
        if (state === YYFINAL) return 0;
        let yyn = yypact[state], act;
        if (yyn === YYPACT_NINF) act = 'default';
        else {
          if (yychar === YYEMPTY) yychar = this.lex();
          if (yychar <= YYEOF) yychar = yytoken = YYEOF;
          else yytoken = yychar <= YYMAXUTOK ? yytranslate[yychar] : YYUNDEFTOK;
          yyn += yytoken;
          if (yyn < 0 || yyn > YYLAST || yycheck[yyn] !== yytoken) act = 'default';
          else {
            yyn = yytable[yyn];
            if (yyn <= 0) {
              if (yyn === YYTABLE_NINF) act = 'error';
              else { yyn = -yyn; act = 'reduce'; }
            }
            else {
              if (this.errstatus) this.errstatus--;
              yychar = YYEMPTY;
              state = yyn;
              ss.push(state); vs.push(this.lval);
              if (ss.length >= YYMAXDEPTH) { this.yyerror('memory exhausted'); return 2; }
              continue;
            }
          }
        }
        if (act === 'default') { yyn = yydefact[state]; act = yyn ? 'reduce' : 'error'; }
        if (act === 'reduce') {
          const len = yyr2[yyn];
          const val = this.reduce(yyn - 1, vs, len, len ? vs[vs.length - len] : undefined);
          ss.length -= len; vs.length -= len;
          vs.push(val);
          const lhs = yyr1[yyn] - YYNTOKENS, top = ss[ss.length - 1];
          const g = yypgoto[lhs] + top;
          state = g >= 0 && g <= YYLAST && yycheck[g] === top ? yytable[g] : yydefgoto[lhs];
          ss.push(state);
          if (ss.length >= YYMAXDEPTH) { this.yyerror('memory exhausted'); return 2; }
          continue;
        }
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
        vs.push(this.lval);
        state = yyn;
        ss.push(state);
      }
    } catch (e) {
      if (e instanceof Abort) return 1;
      throw e;
    }
  }

  yyerrok() { this.errstatus = 0; }

  // ------------------------------------------------------------- symbols
  variable(line, name, arrayish = false) {
    const k = this.symbols.get(name);
    if (k === 'func') this.errorLn(line, `function \`${name}' called with space between name and \`(',\nor used as a variable or an array`);
    else if (!k) this.symbols.set(name, 'var');
    void arrayish;
    return name;
  }

  installFunction(fname, line, params) {
    if (this.symbols.has(fname)) { this.errorLn(line, `function name \`${fname}' previously defined`); return -1; }
    this.symbols.set(fname, 'func');
    const names = [];
    params.forEach((p, i) => {
      const name = p.name;
      if (name === fname) this.errorLn(p.line, `function \`${fname}': cannot use function name as parameter name`);
      else if (STD_VARS.has(name)) this.errorLn(p.line, `function \`${fname}': cannot use special variable \`${name}' as a function parameter`);
      else if (name.includes(':')) this.errorLn(p.line, `function \`${fname}': parameter \`${name}' cannot contain a namespace`);
      for (let j = 0; j < i; j++) if (names[j] === name) this.errorLn(p.line, `function \`${fname}': parameter #${i + 1}, \`${name}', duplicates parameter #${j + 1}`);
      names.push(name);
    });
    this.funcHeader = { name: fname, params: names, line };
    this.savedSymbols = new Map();
    for (const n of names) { this.savedSymbols.set(n, this.symbols.get(n)); this.symbols.set(n, 'param'); }
    return 0;
  }

  // snode: a builtin call, with the argument count checked
  snode(args, tokv) {
    const [name, , flags] = TOKENTAB[tokv.builtin];
    const nexp = args ? args.length : 0;
    const allowed = flags & 0xff;
    if (allowed && (allowed & (1 << nexp)) === 0) {
      this.yyerror(`${nexp} is invalid as number of arguments for ${name}`);
      return null;
    }
    const list = args ? args.slice() : [];
    let literal = false;
    if (name === 'sub' || name === 'gsub') {
      if (nexp === 2) list.push({ t: 'field', e: { t: 'num', v: 0 } });
      let last = list[2];
      while (last && last.t === 'group') last = last.e;
      const lv = last && (last.t === 'var' || last.t === 'idx' || last.t === 'field');
      if (last && (last.t === 'str' || last.t === 'num')) literal = true;
      else if (last && !lv) this.yyerror(`${name} third parameter is not a changeable object`);
    } else if (name === 'gensub') {
      if (nexp === 3) list.push({ t: 'field', e: { t: 'num', v: 0 } });
    } else if (name === 'index') {
      if (list[1] && (list[1].t === 'regex' || list[1].t === 'typedregex')) this.io.fatal(this.where() + 'fatal: index: regexp constant as second argument is not allowed');
    } else if (name === 'match') {
      if (nexp === 3 && this.opts.traditional) { this.yyerror('match: third argument is a gawk extension'); return null; }
    } else if (name === 'close') {
      if (nexp === 2 && this.opts.traditional) { this.yyerror('close: second argument is a gawk extension'); return null; }
    }
    return { t: 'builtin', name, args: list, line: tokv.line, literal };
  }

  funcUse(name, how) {
    const f = this.funcUseMap.get(name) || { defined: 0, used: 0 };
    if (how === 'define') f.defined++; else f.used++;
    this.funcUseMap.set(name, f);
  }

  regexNode(tokv) {
    // make_regnode: constant regexes are compiled now; an error stops the parse
    const err = this.opts.checkRegex ? this.opts.checkRegex(tokv.re, (m) => this.warning(m), (m) => { this.io.fatal(this.where() + 'fatal: ' + m); }) : null;
    if (err) {
      this.errcount++;
      this.io.error(this.where() + `error: ${err}: /${err.pattern ?? tokv.re}/`);
      throw new Abort();
    }
    return { t: 'regex', src: tokv.re, line: tokv.line };
  }

  appendRule(pattern, action) {
    if (this.rule !== RULE) {
      this.items.push({ kind: RULENAME[this.rule], action: action || { t: 'block', body: [] }, line: pattern.line, src: this.source });
      return;
    }
    if (pattern === null) { this.items.push({ kind: 'rule', pattern: null, pattern2: null, action, src: this.source }); return; }
    const pa = pattern.range ? pattern.a : pattern.e;
    this.items.push({ kind: 'rule', pattern: pa, pattern2: pattern.range ? pattern.b : null, action, line: firstLine(pa), src: this.source });
  }

  // ------------------------------------------------------------- the actions
  reduce(r, vs, len, dflt) {
    const base = MID_POS[r] !== undefined ? vs.length - MID_POS[r] : vs.length - len - 1;
    const $ = (i) => vs[base + i];
    let $$ = dflt;
    const sig = T.rules[r];
    switch (sig) {
      case 'program:': $$ = null; break;
      case 'program: program rule': this.rule = 0; this.yyerrok(); break;
      case 'program: program nls': $$ = $(1); break;
      case 'program: program LEX_EOF': this.nextSourcefile(); break;
      case 'program: program error': this.rule = 0; break;
      case 'rule: pattern action': this.appendRule($(1), $(2)); break;
      case 'rule: pattern statement_term':
        if (this.rule !== RULE) { this.msg(`${RULENAME[this.rule]} blocks must have an action part`); this.errcount++; }
        else if ($(1) === null) { this.msg('each rule must have a pattern or an action part'); this.errcount++; }
        else this.appendRule($(1), null);
        break;
      case 'rule: function_prologue action': {
        const fh = $(1);
        this.inFunction = null;
        if (fh) {
          this.funcs.set(fh.name, { params: fh.params, body: $(2), src: this.source });
          this.funcUse(fh.name, 'define');
          for (const [n, k] of this.savedSymbols || []) { if (k === undefined) this.symbols.delete(n); else this.symbols.set(n, k); }
        }
        this.wantParamNames = DONT_CHECK;
        this.yyerrok();
        break;
      }
      case "rule: '@' LEX_INCLUDE source statement_term": case "rule: '@' LEX_LOAD library statement_term": case "rule: '@' LEX_NAMESPACE namespace statement_term":
        this.wantSource = false; this.atSeen = false; this.yyerrok();
        break;
      case 'source: FILENAME': {
        if (!this.includeSource($(1))) throw new Abort();
        $$ = null;
        break;
      }
      case 'library: FILENAME': {
        if (this.opts.traditional || this.opts.posix) { this.errorLn($(1).line, '@load is a gawk extension'); throw new Abort(); }
        if ($(1).file !== '') { this.errorLn($(1).line, `cannot open shared library \`${$(1).file}' for reading: No such file or directory`); throw new Abort(); }
        break;
      }
      case 'namespace: FILENAME': $$ = $(1); break;
      case 'source: FILENAME error': case 'source: error': case 'library: FILENAME error': case 'library: error':
      case 'namespace: FILENAME error': case 'namespace: error':
        $$ = null; break;
      case 'pattern:': this.rule = RULE; $$ = null; break;
      case 'pattern: exp': this.rule = RULE; $$ = { e: $(1) }; break;
      case 'pattern: exp comma exp': this.rule = RULE; $$ = { range: true, a: $(1), b: $(3) }; break;
      case 'pattern: LEX_BEGIN': this.rule = BEGIN; $$ = { line: $(1).line }; break;
      case 'pattern: LEX_END': this.rule = END; $$ = { line: $(1).line }; break;
      case 'pattern: LEX_BEGINFILE': this.rule = BEGINFILE; $$ = { line: $(1).line }; break;
      case 'pattern: LEX_ENDFILE': this.rule = ENDFILE; $$ = { line: $(1).line }; break;
      case 'action: l_brace statements r_brace opt_semi opt_nls': $$ = { t: 'block', body: $(2) || [] }; break;
      case 'func_name: NAME': $$ = $(1); break;
      case 'func_name: FUNC_CALL': $$ = $(1); break;
      case 'func_name: lex_builtin':
        this.yyerror(`\`${$(1).name}' is a built-in function, it cannot be redefined`);
        throw new Abort();
      case "func_name: '@' LEX_EVAL": $$ = $(2); this.atSeen = false; break;
      case 'lex_builtin: LEX_BUILTIN': case 'lex_builtin: LEX_LENGTH': $$ = $(1); break;
      case '@1:': this.wantParamNames = FUNC_HEADER; break;
      case "function_prologue: LEX_FUNCTION func_name '(' @1 opt_param_list r_paren opt_nls": {
        const fn = $(2);
        if (this.installFunction(fn.name, $(1).line, $(5) || []) < 0) throw new Abort();
        this.inFunction = fn.name;
        $$ = this.funcHeader;
        this.wantParamNames = FUNC_BODY;
        break;
      }
      case '@2:': this.wantRegexp = true; break;
      case 'regexp: a_slash @2 REGEXP': $$ = this.regexNode($(3)); break;
      case 'typed_regexp: TYPED_REGEXP': {
        const n = this.regexNode($(1));
        $$ = { t: 'typedregex', src: n.src, line: n.line };
        break;
      }
      case "a_slash: '/'": case 'a_slash: SLASH_BEFORE_EQUAL': break;
      case 'statements:': $$ = null; break;
      case 'statements: statements statement': {
        const l = $(1) || [];
        if ($(2) !== null && $(2) !== undefined) l.push($(2));
        $$ = l;
        this.yyerrok();
        break;
      }
      case 'statements: statements error': $$ = null; break;
      case 'statement_term: nls': case 'statement_term: semi opt_nls': $$ = null; break;
      case 'statement: semi opt_nls': $$ = null; break;
      case 'statement: l_brace statements r_brace': $$ = { t: 'block', body: $(2) || [] }; break;
      case 'statement: if_statement': $$ = $(1); break;
      case "statement: LEX_SWITCH '(' exp r_paren opt_nls l_brace case_statements opt_nls r_brace": {
        const cases = $(7) || [];
        let dflt = null;
        const seen = new Set();
        const list = [];
        for (const c of cases) {
          if (c.dflt) {
            if (dflt !== null) this.errorLn(c.line, "duplicate `default' detected in switch body");
            else dflt = list.length;
            list.push(c);
            continue;
          }
          if (c.v.t === 'num' || c.v.t === 'str') {
            const key = c.v.t === 'str' ? c.v.v : numToStrKey(c.v.v);
            if (seen.has(key)) this.errorLn(c.line, `duplicate case values in switch body: ${key}`);
            seen.add(key);
          }
          list.push(c);
        }
        $$ = { t: 'switch', e: $(3), cases: list };
        this.breakAllowed--;
        break;
      }
      case "statement: LEX_WHILE '(' exp r_paren opt_nls statement":
        $$ = { t: 'while', c: $(3), body: $(6) || { t: 'block', body: [] } };
        this.breakAllowed--; this.continueAllowed--;
        break;
      case "statement: LEX_DO opt_nls statement LEX_WHILE '(' exp r_paren opt_nls":
        $$ = { t: 'do', body: $(3) || { t: 'block', body: [] }, c: $(6) };
        this.breakAllowed--; this.continueAllowed--;
        break;
      case "statement: LEX_FOR '(' NAME LEX_IN simple_variable r_paren opt_nls statement": {
        const arr = $(5);
        this.variable($(3).line, $(3).name);
        $$ = { t: 'forin', v: $(3).name, arr: arr.t === 'var' ? arr.name : arr.name, arrNode: arr, body: $(8) || { t: 'block', body: [] } };
        this.breakAllowed--; this.continueAllowed--;
        break;
      }
      case "statement: LEX_FOR '(' opt_simple_stmt semi opt_nls exp semi opt_nls opt_simple_stmt r_paren opt_nls statement":
        $$ = { t: 'for', init: $(3), c: $(6), step: $(9), body: $(12) || { t: 'block', body: [] } };
        this.breakAllowed--; this.continueAllowed--;
        break;
      case "statement: LEX_FOR '(' opt_simple_stmt semi opt_nls semi opt_nls opt_simple_stmt r_paren opt_nls statement":
        $$ = { t: 'for', init: $(3), c: null, step: $(8), body: $(11) || { t: 'block', body: [] } };
        this.breakAllowed--; this.continueAllowed--;
        break;
      case 'statement: non_compound_stmt': $$ = $(1); break;
      case 'non_compound_stmt: LEX_BREAK statement_term':
        if (!this.breakAllowed) this.errorLn($(1).line, "`break' is not allowed outside a loop or switch");
        $$ = { t: 'break' };
        break;
      case 'non_compound_stmt: LEX_CONTINUE statement_term':
        if (!this.continueAllowed) this.errorLn($(1).line, "`continue' is not allowed outside a loop");
        $$ = { t: 'continue' };
        break;
      case 'non_compound_stmt: LEX_NEXT statement_term':
        if (this.rule && this.rule !== RULE) this.errorLn($(1).line, `\`next' used in ${RULENAME[this.rule]} action`);
        $$ = { t: 'next', line: $(1).line };
        break;
      case 'non_compound_stmt: LEX_NEXTFILE statement_term':
        if (this.rule === BEGIN || this.rule === END || this.rule === ENDFILE) this.errorLn($(1).line, `\`nextfile' used in ${RULENAME[this.rule]} action`);
        $$ = { t: 'nextfile', line: $(1).line };
        break;
      case 'non_compound_stmt: LEX_EXIT opt_exp statement_term': $$ = { t: 'exit', e: $(2), line: $(1).line }; break;
      case '@3:': if (!this.inFunction) this.yyerror("`return' used outside function context"); break;
      case 'non_compound_stmt: LEX_RETURN @3 opt_exp statement_term': $$ = { t: 'return', e: $(3) }; break;
      case 'non_compound_stmt: simple_stmt statement_term': $$ = $(1); if ($$ && !$$.line) $$.line = firstLine($$.e || $$); break;
      case '@4:': this.inPrint = true; this.inParens = 0; break;
      case 'simple_stmt: print @4 print_expression_list output_redir': {
        const kind = $(1).name;
        let args = $(3) || [];
        if (args.paren) args = args.list;
        $$ = { t: kind, args, redir: $(4), line: $(1).line };
        break;
      }
      case '@5:': this.subCounter = 0; break;
      case 'simple_stmt: LEX_DELETE NAME @5 delete_subscript_list': {
        this.variable($(2).line, $(2).name);
        const subs = $(4);
        $$ = { t: 'delete', name: $(2).name, subs: subs ? subs.flat() : null, dims: subs };
        break;
      }
      case "simple_stmt: LEX_DELETE '(' NAME ')'":
        if (this.opts.traditional) this.errorLn($(1).line, "`delete(array)' is a non-portable tawk extension");
        this.variable($(3).line, $(3).name);
        $$ = { t: 'delete', name: $(3).name, subs: null };
        break;
      case 'simple_stmt: exp': $$ = { t: 'expr', e: $(1) }; break;
      case 'opt_simple_stmt:': $$ = null; break;
      case 'opt_simple_stmt: simple_stmt': {
        const s = $(1);
        $$ = s.t === 'expr' ? s.e : { t: 'stmtexpr', s };
        break;
      }
      case 'case_statements:': $$ = null; break;
      case 'case_statements: case_statements case_statement': $$ = ($(1) || []).concat([$(2)]); break;
      case 'case_statements: case_statements error': $$ = null; break;
      case 'case_statement: LEX_CASE case_value colon opt_nls statements':
        $$ = { v: $(2), body: { t: 'block', body: $(5) || [] }, line: $(1).line };
        break;
      case 'case_statement: LEX_DEFAULT colon opt_nls statements':
        $$ = { dflt: true, body: { t: 'block', body: $(4) || [] }, line: $(1).line };
        break;
      case 'case_value: YNUMBER': $$ = { t: 'num', v: $(1).num }; break;
      case "case_value: '-' YNUMBER": $$ = { t: 'num', v: -$(2).num }; break;
      case "case_value: '+' YNUMBER": $$ = { t: 'num', v: $(2).num }; break;
      case 'case_value: YSTRING': $$ = { t: 'str', v: $(1).str }; break;
      case 'case_value: regexp': case 'case_value: typed_regexp': $$ = $(1); break;
      case 'print: LEX_PRINT': case 'print: LEX_PRINTF': $$ = $(1); break;
      case 'print_expression_list: opt_expression_list': $$ = $(1); break;
      case "print_expression_list: '(' expression_list r_paren": $$ = { paren: true, list: $(2) || [] }; break;
      case 'output_redir:': this.inPrint = false; this.inParens = 0; $$ = null; break;
      case '@6:': this.inPrint = false; this.inParens = 0; break;
      case 'output_redir: IO_OUT @6 common_exp': {
        const e = $(3);
        if ($(1).redir === '|&' && e.t === 'getline' && e.kind === 'cmd' && e.coproc) this.yyerror("multistage two-way pipelines don't work");
        $$ = { op: $(1).redir, e };
        break;
      }
      case "if_statement: LEX_IF '(' exp r_paren opt_nls statement":
        $$ = { t: 'if', c: $(3), then: $(6) || { t: 'block', body: [] }, els: null };
        break;
      case "if_statement: LEX_IF '(' exp r_paren opt_nls statement LEX_ELSE opt_nls statement":
        $$ = { t: 'if', c: $(3), then: $(6) || { t: 'block', body: [] }, els: $(9) || { t: 'block', body: [] } };
        break;
      case 'nls: NEWLINE': case 'nls: nls NEWLINE': $$ = null; break;
      case 'opt_nls:': case 'opt_nls: nls': $$ = null; break;
      case 'input_redir:': $$ = null; break;
      case "input_redir: '<' simp_exp": $$ = $(2); break;
      case 'opt_param_list:': $$ = null; break;
      case 'opt_param_list: param_list': $$ = $(1); break;
      case 'param_list: NAME': $$ = [{ name: $(1).name, line: $(1).line }]; break;
      case 'param_list: param_list comma NAME':
        if ($(1) !== null && $(3) !== null) { $$ = $(1).concat([{ name: $(3).name, line: $(3).line }]); this.yyerrok(); }
        else $$ = null;
        break;
      case 'param_list: error': $$ = null; break;
      case 'param_list: param_list error': case 'param_list: param_list comma error': $$ = $(1); break;
      case 'opt_exp:': $$ = null; break;
      case 'opt_exp: exp': $$ = $(1); break;
      case 'opt_expression_list:': $$ = null; break;
      case 'opt_expression_list: expression_list': $$ = $(1); break;
      case 'expression_list: exp': case 'fcall_expression_list: fcall_exp': $$ = [$(1)]; break;
      case 'expression_list: expression_list comma exp': case 'fcall_expression_list: fcall_expression_list comma fcall_exp':
        $$ = ($(1) || []).concat([$(3)]); this.yyerrok();
        break;
      case 'expression_list: error': case 'fcall_expression_list: error': $$ = null; break;
      case 'expression_list: expression_list error': case 'fcall_expression_list: fcall_expression_list error': $$ = $(1); break;
      case 'expression_list: expression_list error exp': case 'fcall_expression_list: fcall_expression_list error fcall_exp':
        $$ = ($(1) || []).concat([$(3)]);
        break;
      case 'expression_list: expression_list comma error': case 'fcall_expression_list: fcall_expression_list comma error': $$ = $(1); break;
      case 'opt_fcall_expression_list:': $$ = null; break;
      case 'opt_fcall_expression_list: fcall_expression_list': $$ = $(1); break;
      case 'fcall_exp: exp': case 'fcall_exp: typed_regexp': $$ = $(1); break;
      case 'exp: variable assign_operator exp': $$ = this.mkAssignment($(1), $(3), $(2)); break;
      case 'exp: variable ASSIGN typed_regexp': $$ = this.mkAssignment($(1), $(3), '='); break;
      case 'exp: exp LEX_AND exp': $$ = { t: 'and', a: $(1), b: $(3) }; break;
      case 'exp: exp LEX_OR exp': $$ = { t: 'or', a: $(1), b: $(3) }; break;
      case 'exp: exp MATCHOP typed_regexp': case 'exp: exp MATCHOP exp':
        if ($(1).t === 'regex') this.warningLn($(2).line, "regular expression on left of `~' or `!~' operator");
        $$ = { t: 'match', neg: $(2).op === '!~', a: $(1), re: $(3) };
        break;
      case 'exp: exp LEX_IN simple_variable': {
        const sv = $(3);
        const l = $(1);
        $$ = { t: 'in', subs: [l], name: sv.name, nameNode: sv };
        break;
      }
      case 'exp: exp a_relop exp': $$ = { t: 'cmp', op: $(2), a: $(1), b: $(3) }; break;
      case "exp: exp '?' exp ':' exp": $$ = { t: 'cond', c: $(1), a: $(3), b: $(5) }; break;
      case 'exp: common_exp': $$ = $(1); break;
      case 'assign_operator: ASSIGN': $$ = '='; break;
      case 'assign_operator: ASSIGNOP': $$ = $(1).op; break;
      case 'assign_operator: SLASH_BEFORE_EQUAL ASSIGN': $$ = '/='; break;
      case 'relop_or_less: RELOP': $$ = $(1).op; break;
      case "relop_or_less: '<'": $$ = '<'; break;
      case 'a_relop: relop_or_less': $$ = $(1); break;
      case "a_relop: '>'": $$ = '>'; break;
      case 'common_exp: simp_exp': case 'common_exp: simp_exp_nc': $$ = $(1); break;
      case 'common_exp: common_exp simp_exp':
        if ($(1).t === 'str' && $(2).t === 'str' && !$(1).folded0) $$ = { t: 'str', v: $(1).v + $(2).v };
        else $$ = { t: 'concat', a: $(1), b: $(2) };
        break;
      case 'simp_exp: non_post_simp_exp': $$ = $(1); break;
      case "simp_exp: simp_exp '^' simp_exp": case "simp_exp_nc: simp_exp_nc '^' simp_exp": $$ = this.mkBinary('^', $(1), $(3), $(2)); break;
      case "simp_exp: simp_exp '*' simp_exp": case "simp_exp_nc: simp_exp_nc '*' simp_exp": $$ = this.mkBinary('*', $(1), $(3), $(2)); break;
      case "simp_exp: simp_exp '/' simp_exp": case "simp_exp_nc: simp_exp_nc '/' simp_exp": $$ = this.mkBinary('/', $(1), $(3), $(2)); break;
      case "simp_exp: simp_exp '%' simp_exp": case "simp_exp_nc: simp_exp_nc '%' simp_exp": $$ = this.mkBinary('%', $(1), $(3), $(2)); break;
      case "simp_exp: simp_exp '+' simp_exp": case "simp_exp_nc: simp_exp_nc '+' simp_exp": $$ = this.mkBinary('+', $(1), $(3), $(2)); break;
      case "simp_exp: simp_exp '-' simp_exp": case "simp_exp_nc: simp_exp_nc '-' simp_exp": $$ = this.mkBinary('-', $(1), $(3), $(2)); break;
      case 'simp_exp: LEX_GETLINE opt_variable input_redir':
        if ((this.rule === BEGINFILE || this.rule === ENDFILE) && $(3) === null) this.errorLn($(1).line, `non-redirected \`getline' invalid inside \`${RULENAME[this.rule]}' rule`);
        $$ = $(3) === null ? { t: 'getline', kind: 'simple', target: $(2) } : { t: 'getline', kind: 'file', src: $(3), target: $(2) };
        break;
      case 'simp_exp: variable INCREMENT': $$ = this.mkIncDec('postinc', '++', $(1)); break;
      case 'simp_exp: variable DECREMENT': $$ = this.mkIncDec('postinc', '--', $(1)); break;
      case "simp_exp: '(' expression_list r_paren LEX_IN simple_variable": {
        const list = $(2);
        if (list === null) this.errcount++;
        $$ = { t: 'in', subs: list || [], name: $(5).name, nameNode: $(5) };
        break;
      }
      case 'simp_exp_nc: common_exp IO_IN LEX_GETLINE opt_variable':
        $$ = { t: 'getline', kind: 'cmd', src: $(1), target: $(4), coproc: $(2).redir === '|&' };
        break;
      case 'non_post_simp_exp: regexp': $$ = $(1); break;
      case "non_post_simp_exp: '!' simp_exp": $$ = { t: 'not', e: $(2) }; break;
      case "non_post_simp_exp: '(' exp r_paren": $$ = { t: 'group', e: $(2) }; break;
      case "non_post_simp_exp: LEX_BUILTIN '(' opt_fcall_expression_list r_paren":
      case "non_post_simp_exp: LEX_LENGTH '(' opt_fcall_expression_list r_paren":
        $$ = this.snode($(3), $(1));
        if ($$ === null) throw new Abort();
        break;
      case 'non_post_simp_exp: LEX_LENGTH':
        $$ = this.snode(null, $(1));
        if ($$ === null) throw new Abort();
        break;
      case 'non_post_simp_exp: func_call': case 'non_post_simp_exp: variable': $$ = $(1); break;
      case 'non_post_simp_exp: INCREMENT variable': $$ = this.mkIncDec('preinc', '++', $(2)); break;
      case 'non_post_simp_exp: DECREMENT variable': $$ = this.mkIncDec('preinc', '--', $(2)); break;
      case 'non_post_simp_exp: YNUMBER': $$ = { t: 'num', v: $(1).num }; break;
      case 'non_post_simp_exp: YSTRING': $$ = { t: 'str', v: $(1).str }; break;
      case "non_post_simp_exp: '-' simp_exp": {
        const e = $(2);
        // a numeric constant is negated in place
        $$ = e.t === 'num' ? { t: 'num', v: -e.v } : { t: 'neg', e };
        break;
      }
      case "non_post_simp_exp: '+' simp_exp": $$ = { t: 'pos', e: $(2) }; break;
      case 'func_call: direct_func_call': this.funcUse($(1).name, 'use'); $$ = $(1); break;
      case "func_call: '@' direct_func_call": {
        const f = $(2);
        if (this.opts.traditional || this.opts.posix) this.yyerror('indirect function calls are a gawk extension');
        if (STD_VARS.has(f.name)) this.yyerror(`cannot use special variable \`${f.name}' for indirect function call`);
        this.variable(f.line, f.name);
        $$ = { t: 'indirect', name: f.name, args: f.args, line: f.line };
        this.atSeen = false;
        break;
      }
      case "direct_func_call: FUNC_CALL '(' opt_fcall_expression_list r_paren": {
        const name = $(1).name;
        if (!this.atSeen) {
          const k = this.symbols.get(name);
          if (k && k !== 'func') this.errorLn($(1).line, `attempt to use non-function \`${name}' in function call`);
        }
        const args = $(3) || [];
        args.forEach((a, i) => { if (a && a.t === 'regex') this.warningLn(a.line, `regexp constant for parameter #${i + 1} yields boolean value`); });
        $$ = { t: 'call', name, args, line: $(1).line };
        break;
      }
      case 'opt_variable:': $$ = null; break;
      case 'opt_variable: variable': $$ = $(1); break;
      case 'delete_subscript_list:': $$ = null; break;
      case 'delete_subscript_list: delete_subscript SUBSCRIPT': $$ = $(1); break;
      case 'delete_subscript: delete_exp_list': $$ = [$(1)]; break;
      case 'delete_subscript: delete_subscript delete_exp_list': $$ = $(1).concat([$(2)]); break;
      case 'delete_exp_list: bracketed_exp_list': this.subCounter++; $$ = $(1); break;
      case "bracketed_exp_list: '[' expression_list ']'":
        if ($(2) === null) { this.errorLn($(3).line, 'invalid subscript expression'); $$ = [{ t: 'str', v: '' }]; }
        else $$ = $(2);
        break;
      case 'subscript: bracketed_exp_list': $$ = [$(1)]; break;
      case 'subscript: subscript bracketed_exp_list': $$ = $(1).concat([$(2)]); break;
      case 'subscript_list: subscript SUBSCRIPT': $$ = $(1); break;
      case 'simple_variable: NAME': $$ = { t: 'var', name: this.variable($(1).line, $(1).name), line: $(1).line }; break;
      case 'simple_variable: NAME subscript_list': {
        const dims = $(2);
        $$ = dims.length === 1
          ? { t: 'idx', name: this.variable($(1).line, $(1).name), subs: dims[0], line: $(1).line }
          : { t: 'idx', name: this.variable($(1).line, $(1).name), subs: dims[0], dims, line: $(1).line };
        break;
      }
      case 'variable: simple_variable': $$ = $(1); break;
      case "variable: '$' non_post_simp_exp opt_incdec": {
        const f = { t: 'field', e: $(2), line: $(1).line };
        $$ = $(3) ? { t: 'postinc', op: $(3), target: f, fieldPost: true } : f;
        break;
      }
      case 'opt_incdec: INCREMENT': $$ = '++'; break;
      case 'opt_incdec: DECREMENT': $$ = '--'; break;
      case 'opt_incdec:': $$ = null; break;
      case "l_brace: '{' opt_nls": $$ = null; break;
      case "r_brace: '}' opt_nls": $$ = null; this.yyerrok(); break;
      case "r_paren: ')'": this.yyerrok(); break;
      case 'opt_semi:': $$ = null; break;
      case 'opt_semi: semi': break;
      case "semi: ';'": this.yyerrok(); break;
      case "colon: ':'": this.yyerrok(); break;
      case "comma: ',' opt_nls": $$ = null; this.yyerrok(); break;
      default: break;
    }
    return $$;
  }

  // mk_binary(): two numeric constants are folded now, division by zero reported as an error
  mkBinary(op, a, b, optok) {
    const line = optok && optok.line;
    if (a.t === 'num' && b.t === 'num') {
      const x = a.v, y = b.v;
      switch (op) {
        case '*': return { t: 'num', v: x * y };
        case '+': return { t: 'num', v: x + y };
        case '-': return { t: 'num', v: x - y };
        case '^': return { t: 'num', v: calcExp(x, y) };
        case '/':
          if (y === 0) { this.errorLn(line, 'division by zero attempted'); break; }
          return { t: 'num', v: x / y };
        case '%':
          if (y === 0) { this.errorLn(line, "division by zero attempted in `%'"); break; }
          return { t: 'num', v: x % y };
      }
    }
    if (op === '^') return { t: 'pow', a, b, line };
    return { t: 'bin', op, a, b, line };
  }

  mkAssignment(target, e, op) {
    if (target && target.fieldPost) this.yyerror('cannot assign a value to the result of a field post-increment expression');
    return { t: 'assign', op, target, e };
  }

  mkIncDec(kind, op, target) {
    if (target && target.fieldPost) this.yyerror('cannot assign a value to the result of a field post-increment expression');
    return { t: kind, op, target };
  }

  includeSource(f) {
    if (this.opts.traditional || this.opts.posix) { this.errorLn(f.line, '@include is a gawk extension'); return false; }
    if (f.file === '') return true;
    const r = this.opts.findSource ? this.opts.findSource(f.file) : null;
    if (r === null) { this.errorLn(f.line, `cannot open source file \`${f.file}' for reading: No such file or directory`); return false; }
    if (this.sources.some(s => s.path === r.path && (s.stype === 'file' || s.stype === 'inc'))) return true;
    // the included file is read next, then this one continues
    const cur = this.cur;
    cur.saved = { buf: this.buf, lexptr: this.lexptr, lexend: this.lexend, lexptrBegin: this.lexptrBegin, lexeme: this.lexeme, lasttok: this.lasttok, sourceline: this.sourceline, source: this.source };
    this.sources.splice(this.srcIdx, 0, { stype: 'file', src: f.file, path: r.path, text: r.text, buf: null, started: false });
    this.lexptr = null;
    this.sourceline = 0;
    this.source = null;
    this.lasttok = 0;
    this.lexeof = false;
    return true;
  }

  // parse_program
  run() {
    this.lexeof = false;
    this.lexptr = null;
    this.lasttok = 0;
    this.errcount = 0;
    const ret = this.parse();
    this.source = null;
    this.sourceline = 0;
    return { ok: !(ret || this.errcount), items: this.items, funcs: this.funcs, globals: [...this.symbols].filter(([, k]) => k === 'var').map(([n]) => n) };
  }
}

// parse_escape(): returns { c, i } (c -1: lone backslash at the end, -2: escaped newline)
export function parseEscape(s, i, opts, warn) {
  const ch = s[i++];
  if (ch === undefined) return { c: -1, i: i - 1 };
  switch (ch) {
    case 'a': return { c: 7, i };
    case 'b': return { c: 8, i };
    case 'f': return { c: 12, i };
    case 'n': return { c: 10, i };
    case 'r': return { c: 13, i };
    case 't': return { c: 9, i };
    case 'v': return { c: 11, i };
    case '\n': return { c: -2, i };
    case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': {
      let v = ch.charCodeAt(0) - 48;
      for (let count = 1; count < 3; count++) {
        const d = s[i];
        if (d >= '0' && d <= '7') { v = v * 8 + (d.charCodeAt(0) - 48); i++; } else break;
      }
      return { c: v, i };
    }
    case 'x': {
      if (opts.posix) return { c: 120, i };
      if (!isXdigit((s[i] || '').charCodeAt(0))) { warn("no hex digits in `\\x' escape sequence"); return { c: 120, i }; }
      let v = 0;
      for (let j = 0; j < 2; j++) {
        const d = s[i];
        if (d !== undefined && isXdigit(d.charCodeAt(0))) { v = v * 16 + parseInt(d, 16); i++; } else break;
      }
      return { c: v, i };
    }
    case '\\': case '"': return { c: ch.charCodeAt(0), i };
    default:
      warn(`escape sequence \`\\${ch}' treated as plain \`${ch}'`);
      return { c: ch.charCodeAt(0), i };
  }
}

// get_numbase(): 8 for 0[0-7]+, 16 for 0x..., else 10 (a non-octal digit makes it decimal)
function numBase(s) {
  if (s[0] !== '0' || s.length < 2) return 10;
  if (s[1] === 'x' || s[1] === 'X') return 16;
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '8' || c === '9' || c === '.' || c === 'e' || c === 'E') return 10;
  }
  return 8;
}
// nondec2awknum()
export function nondec2num(s) {
  if (/^0[xX]/.test(s)) {
    let v = 0;
    for (let i = 2; i < s.length; i++) { const d = parseInt(s[i], 16); if (Number.isNaN(d)) break; v = v * 16 + d; }
    return v;
  }
  if (s[0] === '0') {
    let v = 0;
    for (let i = 1; i < s.length; i++) { const c = s[i]; if (c < '0' || c > '7') return parseFloat(s); v = v * 8 + (c.charCodeAt(0) - 48); }
    return v;
  }
  return parseFloat(s);
}
// the source line of the first token in an expression that has one
function firstLine(n, depth = 0) {
  if (!n || typeof n !== 'object' || depth > 50) return 0;
  if (n.line) return n.line;
  for (const k of ['e', 'a', 'c', 'target', 'src']) { const l = firstLine(n[k], depth + 1); if (l) return l; }
  if (Array.isArray(n.args)) for (const x of n.args) { const l = firstLine(x, depth + 1); if (l) return l; }
  if (Array.isArray(n.subs)) for (const x of n.subs) { const l = firstLine(x, depth + 1); if (l) return l; }
  return 0;
}
// calc_exp()
function calcExp(x1, x2) {
  if (Number.isInteger(x2)) {
    if (x2 === 0) return 1;
    const posint = (x, n) => { let mult = 1; while (n > 1) { if (n % 2 === 1) mult *= x; x *= x; n = Math.floor(n / 2); } return mult * x; };
    return x2 > 0 ? posint(x1, x2) : 1 / posint(x1, -x2);
  }
  return Math.pow(x1, x2);
}
function numToStrKey(n) { return Number.isInteger(n) ? String(n) : String(n); }
