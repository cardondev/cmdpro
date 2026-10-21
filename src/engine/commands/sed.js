// GNU sed 4.8. The script compiler follows sed's compile.c and the interpreter its execute.c,
// so scripts are parsed, diagnosed and run the way GNU sed does it (C locale).
import { FsError } from '../vfs.js';
import { OutBuf } from '../streams.js';
import { getopt } from './util.js';
import { compileGnuRegex, RegexError, RE, SYNTAX_POSIX_BASIC, SYNTAX_POSIX_EXTENDED } from '../gnure.js';

const C = {};

const EXIT_BAD_USAGE = 1, EXIT_BAD_INPUT = 2, EXIT_PANIC = 4;
const POSIXLY_EXTENDED = 0, POSIXLY_CORRECT = 1, POSIXLY_BASIC = 2;

// Thrown to end sed once its diagnostic has been written.
class SedExit { constructor(status) { this.status = status; } }

const EOF = null;
const isBlank = (c) => c === ' ' || c === '\t';
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
const isDigit = (c) => c !== EOF && c !== undefined && c >= '0' && c <= '9';

const ERR = {
  BAD_BANG: "multiple `!'s",
  BAD_COMMA: "unexpected `,'",
  BAD_STEP: 'invalid usage of +N or ~N as first address',
  EXCESS_OPEN_BRACE: "unmatched `{'",
  EXCESS_CLOSE_BRACE: "unexpected `}'",
  EXCESS_JUNK: 'extra characters after command',
  EXPECTED_SLASH: "expected \\ after `a', `c' or `i'",
  NO_CLOSE_BRACE_ADDR: "`}' doesn't want any addresses",
  NO_COLON_ADDR: ": doesn't want any addresses",
  NO_SHARP_ADDR: "comments don't accept any addresses",
  NO_COMMAND: 'missing command',
  ONE_ADDR: 'command only uses one address',
  UNTERM_ADDR_RE: 'unterminated address regex',
  UNTERM_S_CMD: "unterminated `s' command",
  UNTERM_Y_CMD: "unterminated `y' command",
  UNKNOWN_S_OPT: "unknown option to `s'",
  EXCESS_P_OPT: "multiple `p' options to `s' command",
  EXCESS_G_OPT: "multiple `g' options to `s' command",
  EXCESS_N_OPT: "multiple number options to `s' command",
  ZERO_N_OPT: "number option to `s' command may not be zero",
  Y_CMD_LEN: "strings for `y' command are different lengths",
  ANCIENT_VERSION: 'expected newer version of sed',
  INVALID_LINE_0: 'invalid usage of line address 0',
  INCOMPLETE_CMD: 'incomplete command',
  COLON_LACKS_LABEL: '":" lacks a label',
  RECURSIVE_ESCAPE_C: 'recursive escaping after \\c not allowed',
  DISALLOWED_CMD: 'e/r/w commands disabled in sandbox mode',
  MISSING_FILENAME: 'missing filename in r/R/w/W commands',
  NO_REGEX: 'no previous regular expression',
  BAD_MODIF: 'cannot specify modifiers on empty regexp',
};

const ADDR_IS_NULL = 0, ADDR_IS_REGEX = 1, ADDR_IS_NUM = 2, ADDR_IS_NUM_MOD = 3, ADDR_IS_STEP = 4,
  ADDR_IS_STEP_MOD = 5, ADDR_IS_LAST = 6;
const RANGE_INACTIVE = 0, RANGE_ACTIVE = 1, RANGE_CLOSED = 2;
const TEXT_BUFFER = 0, TEXT_REPLACEMENT = 1, TEXT_REGEX = 2;
const REPL_ASIS = 0, REPL_UPPERCASE = 1, REPL_LOWERCASE = 2, REPL_UPPERCASE_FIRST = 4, REPL_LOWERCASE_FIRST = 8;
const REPL_MODIFIERS = REPL_UPPERCASE_FIRST | REPL_LOWERCASE_FIRST;

const USAGE = `Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...

  -n, --quiet, --silent
                 suppress automatic printing of pattern space
      --debug
                 annotate program execution
  -e script, --expression=script
                 add the script to the commands to be executed
  -f script-file, --file=script-file
                 add the contents of script-file to the commands to be executed
  --follow-symlinks
                 follow symlinks when processing in place
  -i[SUFFIX], --in-place[=SUFFIX]
                 edit files in place (makes backup if SUFFIX supplied)
  -l N, --line-length=N
                 specify the desired line-wrap length for the \`l' command
  --posix
                 disable all GNU extensions.
  -E, -r, --regexp-extended
                 use extended regular expressions in the script
                 (for portability use POSIX -E).
  -s, --separate
                 consider files as separate rather than as a single,
                 continuous long stream.
      --sandbox
                 operate in sandbox mode (disable e/r/w commands).
  -u, --unbuffered
                 load minimal amounts of data from the input files and flush
                 the output buffers more often
  -z, --null-data
                 separate lines by NUL characters
      --help     display this help and exit
      --version  output version information and exit

If no -e, --expression, -f, or --file option is given, then the first
non-option argument is taken as the sed script to interpret.  All
remaining arguments are names of input files; if no input files are
specified, then the standard input is read.

GNU sed home page: <https://www.gnu.org/software/sed/>.
General help using GNU software: <https://www.gnu.org/gethelp/>.
`;
const BUG_ADDRESS = 'E-mail bug reports to: <bug-sed@gnu.org>.\n';
const VERSION = `sed (GNU sed) 4.8
Packaged by Debian
Copyright (C) 2020 Free Software Foundation, Inc.
License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.

Written by Jay Fenlason, Tom Lord, Ken Pizzini,
Paolo Bonzini, Jim Meyering, and Assaf Gordon.

This sed program was built with SELinux support.
SELinux is disabled on this system.

GNU sed home page: <https://www.gnu.org/software/sed/>.
General help using GNU software: <https://www.gnu.org/gethelp/>.
` + BUG_ADDRESS;

// The long options, in getopt_long's order (it matters for "ambiguous" messages).
const LONG_OPTS = {
  'binary': 'b', 'regexp-extended': 'r', 'debug': 'debug', 'expression': ['e', 'required'],
  'file': ['f', 'required'], 'in-place': ['i', 'optional'], 'line-length': ['l', 'required'],
  'null-data': 'z', 'zero-terminated': 'z', 'quiet': 'n', 'posix': 'p', 'silent': 'n',
  'sandbox': 'sandbox', 'separate': 's', 'unbuffered': 'u', 'version': 'v', 'help': 'h',
  'follow-symlinks': 'F',
};

const toUpper = (c) => (c >= 'a' && c <= 'z' ? String.fromCharCode(c.charCodeAt(0) - 32) : c);
const toLower = (c) => (c >= 'A' && c <= 'Z' ? String.fromCharCode(c.charCodeAt(0) + 32) : c);
// towupper/towlower through btowc/wctob in the C locale: bytes above 0x7f come out as 0xff
const caseConv = (c, up) => (c.charCodeAt(0) > 0x7f ? '\xff' : up ? toUpper(c) : toLower(c));

function atoi(s) {
  const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(s || '');
  if (!m) return 0;
  const v = parseInt(m[1], 10);
  return Number.isFinite(v) ? v : 0;
}

// glibc strverscmp, enough for version strings
function strverscmp(a, b) {
  const ra = a.match(/\d+|\D+/g) || [], rb = b.match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const x = ra[i], y = rb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// convert_number: the \dNNN, \oNNN and \xHH escapes. p indexes the d/o/x letter.
function convertNumber(buf, p, n, base) {
  let num = 0, max = 1, q = p + 1;
  for (; q < n && max <= 255; ++q, max *= base) {
    const d = parseInt(buf[q], 16);
    if (Number.isNaN(d) || base <= d) break;
    num = num * base + d;
  }
  return [q === p + 1 ? buf[p] : String.fromCharCode(num & 255), q];
}

// str_append_modified
function strModified(s, type) {
  if (type === REPL_ASIS) return s;
  let out = '';
  let i = 0;
  if (type & REPL_MODIFIERS) {
    out += caseConv(s[0], !!(type & REPL_UPPERCASE_FIRST));
    type &= ~REPL_MODIFIERS;
    if (type === REPL_ASIS) return out + s.slice(1);
    i = 1;
  }
  for (; i < s.length; i++) out += caseConv(s[i], !!(type & REPL_UPPERCASE));
  return out;
}

// stdout as stdio buffers it into a pipe: flushed in 4096-byte blocks and at exit
class StdoutBuffer {
  constructor(sink) { this.sink = sink; this.buf = ''; }
  write(s) {
    this.buf += s;
    if (this.buf.length >= 4096) {
      const n = this.buf.length - (this.buf.length % 4096);
      const chunk = this.buf.slice(0, n);
      this.buf = this.buf.slice(n);
      this.sink.write(chunk);
    }
  }
  flush() { if (this.buf) { const b = this.buf; this.buf = ''; this.sink.write(b); } }
}

let tmpCounter = 0x1c2d3e;

class Sed {
  constructor(ctx) {
    this.ctx = ctx;
    const env = ctx.env || {};
    this.posixEnv = env.POSIXLY_CORRECT !== undefined;
    this.posixicity = this.posixEnv ? POSIXLY_CORRECT : POSIXLY_EXTENDED;
    this.lineLen = 70;
    if (env.COLS !== undefined) { const t = atoi(env.COLS); if (t > 1) this.lineLen = t - 1; }
    this.extended = false;
    this.noDefaultOutput = false;
    this.separate = false;
    this.inPlace = null;
    this.delim = '\n';
    this.unbuffered = false;
    this.sandbox = false;
    this.debug = false;
    this.followSymlinks = false;
    // compiler state
    this.program = null;
    this.blocks = [];
    this.labels = [];
    this.jumps = [];
    this.pendingText = null;
    this.oldTextCmd = null;
    this.firstScript = true;
    this.exprCount = 0;
    this.cur = { name: null, line: 0, expr: 0 };
    this.src = '';
    this.pos = 0;
    this.inString = false;
    this.fileRead = [];
    this.fileWrite = [];
    // run-time state
    this.stdoutBuf = new StdoutBuffer(ctx.stdout);
    this.stdoutOut = { sink: this.stdoutBuf, missingNewline: false };
    this.output = this.stdoutOut;
    this.regexLast = null;
    this.replaced = false;
    this.appendQueue = [];
    this.tmpFiles = [];
  }

  // ------------------------------------------------------------------ diagnostics
  badProg(why) {
    const c = this.cur;
    this.ctx.stderr.write(c.name !== null
      ? `sed: file ${c.name} line ${c.line}: ${why}\n`
      : `sed: -e expression #${c.expr}, char ${this.inString ? this.pos : 0}: ${why}\n`);
    throw new SedExit(EXIT_BAD_USAGE);
  }

  panic(msg) {
    this.ctx.stderr.write(`sed: ${msg}\n`);
    for (const t of this.tmpFiles) { try { this.ctx.fs.unlink(t, this.ctx.cwd); } catch { /* gone */ } }
    this.tmpFiles = [];
    throw new SedExit(EXIT_PANIC);
  }

  usage(status) {
    if (status) this.ctx.stderr.write(USAGE);
    else this.stdoutBuf.write(USAGE + BUG_ADDRESS);
    throw new SedExit(status);
  }

  // ------------------------------------------------------------------ script reader
  inchar() {
    let ch = EOF;
    if (this.pos < this.src.length) ch = this.src[this.pos++];
    if (ch === '\n') this.cur.line++;
    return ch;
  }

  savchar(ch) {
    if (ch === EOF) return;
    if (ch === '\n' && this.cur.line > 0) this.cur.line--;
    this.pos--;
  }

  inNonblank() {
    let ch;
    do ch = this.inchar(); while (isBlank(ch));
    return ch;
  }

  readEndOfCmd() {
    const ch = this.inNonblank();
    if (ch === '}' || ch === '#') this.savchar(ch);
    else if (ch !== EOF && ch !== '\n' && ch !== ';') this.badProg(ERR.EXCESS_JUNK);
  }

  inInteger(ch) {
    let num = 0;
    while (isDigit(ch)) {
      num = num * 10 + (ch.charCodeAt(0) - 48);
      ch = this.inchar();
    }
    this.savchar(ch);
    return num;
  }

  readFilename() {
    if (this.sandbox) this.badProg(ERR.DISALLOWED_CMD);
    let b = '';
    let ch = this.inNonblank();
    while (ch !== EOF && ch !== '\n') { b += ch; ch = this.inchar(); }
    return b;
  }

  getOpenfile(list, write) {
    const name = this.readFilename();
    if (name === '') this.badProg(ERR.MISSING_FILENAME);
    let p = list.find(o => o.name === name);
    if (this.posixicity === POSIXLY_EXTENDED) {
      if (name === '/dev/stdout') return { name, sink: this.stdoutBuf, missingNewline: false, ok: true };
      if (name === '/dev/stderr') return { name, sink: this.ctx.stderr, missingNewline: false, ok: true };
      if (name === '/dev/stdin' && !write) return { name, stdin: true, ok: true, data: null, pos: 0 };
    }
    if (!p) {
      p = { name, missingNewline: false, ok: false };
      if (write) {
        try { p.sink = this.ctx.openWrite(name, false); p.ok = true; }
        catch (e) { if (e instanceof FsError) this.panic(`couldn't open file ${name}: ${e.message}`); throw e; }
      } else {
        p.ok = this.openReadFile(p);
      }
      list.push(p);
    }
    return p;
  }

  // an R file: opened at compile time, read a line at a time
  openReadFile(p) {
    try {
      const n = this.ctx.fs.stat(p.name, this.ctx.cwd);
      if (n.type === 'd') { p.dir = true; return true; }
      p.data = this.ctx.readFile(p.name);
      p.pos = 0;
      return true;
    } catch (e) {
      if (e instanceof FsError) return false;
      throw e;
    }
  }

  readLabel() {
    let b = '';
    let ch = this.inNonblank();
    while (ch !== EOF && ch !== '\n' && !isBlank(ch) && ch !== ';' && ch !== '}' && ch !== '#') { b += ch; ch = this.inchar(); }
    this.savchar(ch);
    return b;
  }

  // snarf_char_class: copy a bracket expression; returns [text, terminating char]
  snarfCharClass() {
    let s = '';
    let state = 0, delim = null;
    let ch = this.inchar();
    if (ch === '^') { s += ch; ch = this.inchar(); }
    if (ch === ']') { s += ch; ch = this.inchar(); }
    for (;; s += ch, ch = this.inchar()) {
      switch (ch) {
        case EOF: case '\n':
          return [s, ch];
        case '.': case ':': case '=':
          if (state === 1) { delim = ch; state = 2; } else if (state === 2 && ch === delim) state = 3;
          else break;
          continue;
        case '[':
          if (state === 0) state = 1;
          continue;
        case ']':
          if (state === 0 || state === 1) return [s, ch];
          if (state === 3) state = 0;
          break;
        default:
          break;
      }
      state &= ~1;
    }
  }

  // match_slash: the text up to an unescaped delimiter, or null
  matchSlash(slash, regex) {
    let b = '';
    let ch;
    while ((ch = this.inchar()) !== EOF && ch !== '\n') {
      if (ch === slash) return b;
      if (ch === '\\') {
        ch = this.inchar();
        if (ch === EOF) break;
        else if (ch === 'n' && regex) ch = '\n';
        else if (ch !== '\n' && (ch !== slash || (!regex && ch === '&'))) b += '\\';
      } else if (ch === '[' && regex) {
        b += ch;
        const [s, end] = this.snarfCharClass();
        b += s;
        ch = end;
        if (ch !== ']') break;
      }
      b += ch;
    }
    if (ch === '\n') this.savchar(ch);
    return null;
  }

  // normalize_text: the \X escapes
  normalizeText(buf, type) {
    let out = '';
    let bracketState = 0;
    const n = buf.length;
    let p = 0;
    while (p < n) {
      if (buf[p] === '\\' && p + 1 < n && bracketState === 0) {
        p++;
        let base = 0;
        switch (buf[p]) {
          case 'a': out += '\x07'; p++; continue;
          case 'f': out += '\f'; p++; continue;
          case '\n': case 'n': out += '\n'; p++; continue;
          case 'r': out += '\r'; p++; continue;
          case 't': out += '\t'; p++; continue;
          case 'v': out += '\v'; p++; continue;
          case 'd': base = 10; break;
          case 'x': base = 16; break;
          case 'o': base = 8; break;
          case 'c':
            if (++p < n) {
              out += String.fromCharCode(toUpper(buf[p]).charCodeAt(0) ^ 0x40);
              if (buf[p] === '\\') {
                p++;
                if (buf[p] !== '\\') this.badProg(ERR.RECURSIVE_ESCAPE_C);
              }
              p++;
              continue;
            }
            if (type !== TEXT_BUFFER) out += '\\';
            continue;
          default:
            if (type !== TEXT_BUFFER) out += '\\';
            out += buf[p++];
            continue;
        }
        const [ch, q] = convertNumber(buf, p, n, base);
        p = q;
        // an ampersand or backslash in a replacement stays literal
        if (type === TEXT_REPLACEMENT && (ch === '&' || ch === '\\')) out += '\\';
        out += ch;
        continue;
      } else if (type === TEXT_REGEX && this.posixicity !== POSIXLY_EXTENDED) {
        // POSIX: no escapes inside bracket expressions
        switch (buf[p]) {
          case '[': if (!bracketState) bracketState = -1; break;
          case ':': case '.': case '=':
            if (bracketState === -1 && buf[p - 1] === '[') bracketState = buf[p];
            break;
          case ']':
            if (bracketState === 0) { /* nothing */ } else if (bracketState === -1) bracketState = 0;
            else if (buf[p - 2] !== bracketState && buf[p - 1] === bracketState) bracketState = -1;
            break;
        }
      }
      out += buf[p++];
    }
    return out;
  }

  // read_text: the text of a/i/c (and the command of `e')
  readText(cmd, leadin) {
    if (cmd) {
      this.pendingText = '';
      cmd.text = null;
      this.oldTextCmd = cmd;
    }
    if (leadin === EOF) return;
    if (leadin !== '\n') this.pendingText += leadin;
    let ch = this.inchar();
    while (ch !== EOF && ch !== '\n') {
      if (ch === '\\') {
        ch = this.inchar();
        if (ch !== EOF) this.pendingText += '\\';
      }
      if (ch === EOF) { this.pendingText += '\n'; return; }   // continues in the next script
      this.pendingText += ch;
      ch = this.inchar();
    }
    this.pendingText += '\n';
    (cmd || this.oldTextCmd).text = this.normalizeText(this.pendingText, TEXT_BUFFER);
    this.pendingText = null;
  }

  compileRegex(b, flags, neededSub) {
    if (b.length === 0) {
      if (flags.icase || flags.newline) this.badProg(ERR.BAD_MODIF);
      return null;   // `//' is the last regex used
    }
    const pattern = this.normalizeText(b, TEXT_REGEX);
    let syntax = this.extended ? SYNTAX_POSIX_EXTENDED : SYNTAX_POSIX_BASIC;
    syntax &= ~RE.DOT_NOT_NULL;
    syntax |= RE.NO_POSIX_BACKTRACKING;
    if (this.posixicity === POSIXLY_EXTENDED) syntax &= ~RE.UNMATCHED_RIGHT_PAREN_ORD;
    else if (this.posixicity === POSIXLY_CORRECT) syntax |= RE.UNMATCHED_RIGHT_PAREN_ORD;
    else {
      syntax |= RE.UNMATCHED_RIGHT_PAREN_ORD | RE.NO_GNU_OPS;
      if (!this.extended) syntax |= RE.LIMITED_OPS;
    }
    if (flags.icase) syntax |= RE.ICASE;
    if (flags.newline) { syntax &= ~RE.DOT_NEWLINE; syntax |= RE.HAT_LISTS_NOT_NEWLINE; }
    let r;
    try {
      r = compileGnuRegex(pattern, syntax, { newlineAnchor: flags.newline && this.delim === '\n', nulDelim: flags.newline && this.delim !== '\n' });
    } catch (e) {
      if (e instanceof RegexError) this.badProg(e.message);
      throw e;
    }
    if (neededSub && r.nsub < neededSub - 1 && this.posixicity === POSIXLY_EXTENDED) {
      this.badProg(`invalid reference \\${neededSub - 1} on \`s' command's RHS`);
    }
    if (r.dfaWarning && !this.posixEnv) this.panic(r.dfaWarning);
    return {
      pattern, cflags: flags, src: r.src, flags: r.flags, nsub: r.nsub, maxLen: r.maxLen, longest: r.longest,
      re: new RegExp(r.src, r.flags + 'gd'), ext: new Map(),
    };
  }

  compileAddress(ch) {
    const addr = { type: ADDR_IS_NULL, step: 0, number: Infinity, regex: null };
    if (ch === '/' || ch === '\\') {
      const flags = { icase: false, newline: false };
      addr.type = ADDR_IS_REGEX;
      if (ch === '\\') ch = this.inchar();
      const b = this.matchSlash(ch, true);
      if (b === null) this.badProg(ERR.UNTERM_ADDR_RE);
      for (;;) {
        ch = this.inNonblank();
        if (this.posixicity !== POSIXLY_BASIC) {
          if (ch === 'I') { flags.icase = true; continue; }
          if (ch === 'M') { flags.newline = true; continue; }
        }
        this.savchar(ch);
        addr.regex = this.compileRegex(b, flags, 0);
        return addr;
      }
    }
    if (isDigit(ch)) {
      addr.number = this.inInteger(ch);
      addr.type = ADDR_IS_NUM;
      ch = this.inNonblank();
      if (ch !== '~' || this.posixicity === POSIXLY_BASIC) this.savchar(ch);
      else {
        const step = this.inInteger(this.inNonblank());
        if (step > 0) { addr.step = step; addr.type = ADDR_IS_NUM_MOD; }
      }
    } else if ((ch === '+' || ch === '~') && this.posixicity !== POSIXLY_BASIC) {
      addr.step = this.inInteger(this.inNonblank());
      if (addr.step === 0) { /* ADDR_IS_NULL: the range ends on the next line */ } else if (ch === '+') addr.type = ADDR_IS_STEP;
      else addr.type = ADDR_IS_STEP_MOD;
    } else if (ch === '$') {
      addr.type = ADDR_IS_LAST;
    } else return null;
    return addr;
  }

  markSubstOpts(sub) {
    const flags = { icase: false, newline: false };
    sub.global = false; sub.print = 0; sub.eval = false; sub.numb = 0; sub.outf = null;
    for (;;) {
      const ch = this.inNonblank();
      switch (ch) {
        case 'i': case 'I':
          if (this.posixicity === POSIXLY_BASIC) this.badProg(ERR.UNKNOWN_S_OPT);
          flags.icase = true;
          break;
        case 'm': case 'M':
          if (this.posixicity === POSIXLY_BASIC) this.badProg(ERR.UNKNOWN_S_OPT);
          flags.newline = true;
          break;
        case 'e':
          if (this.posixicity === POSIXLY_BASIC) this.badProg(ERR.UNKNOWN_S_OPT);
          sub.eval = true;
          break;
        case 'p':
          if (sub.print) this.badProg(ERR.EXCESS_P_OPT);
          sub.print |= 1 << (sub.eval ? 1 : 0);   // 1: before eval, 2: after
          break;
        case 'g':
          if (sub.global) this.badProg(ERR.EXCESS_G_OPT);
          sub.global = true;
          break;
        case 'w':
          sub.outf = this.getOpenfile(this.fileWrite, true);
          return flags;
        case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
          if (sub.numb) this.badProg(ERR.EXCESS_N_OPT);
          sub.numb = this.inInteger(ch);
          if (!sub.numb) this.badProg(ERR.ZERO_N_OPT);
          break;
        case '}': case '#':
          this.savchar(ch);
          return flags;
        case EOF: case '\n': case ';':
          return flags;
        case '\r':
          if (this.inchar() === '\n') return flags;
          this.badProg(ERR.UNKNOWN_S_OPT);
          break;
        default:
          this.badProg(ERR.UNKNOWN_S_OPT);
      }
    }
  }

  setupReplacement(sub, text) {
    sub.maxId = 0;
    const s = this.normalizeText(text, TEXT_REPLACEMENT);
    const parts = [];
    let replType = REPL_ASIS, saveType = REPL_ASIS;
    let base = 0;
    const n = s.length;
    for (let p = 0; p < n; p++) {
      if (s[p] === '\\') {
        const tail = { prefix: s.slice(base, p), id: -1, type: replType };
        parts.push(tail);
        replType = saveType;
        p++;
        if (p === n) tail.prefix += '\\';
        else if (this.posixicity === POSIXLY_BASIC && !isDigit(s[p])) tail.prefix += s[p];
        else {
          switch (s[p]) {
            case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
              tail.id = s.charCodeAt(p) - 48;
              if (sub.maxId < tail.id) sub.maxId = tail.id;
              break;
            case 'L': replType = REPL_LOWERCASE; saveType = REPL_LOWERCASE; break;
            case 'U': replType = REPL_UPPERCASE; saveType = REPL_UPPERCASE; break;
            case 'E': replType = REPL_ASIS; saveType = REPL_ASIS; break;
            case 'l': saveType = replType; replType |= REPL_LOWERCASE_FIRST; break;
            case 'u': saveType = replType; replType |= REPL_UPPERCASE_FIRST; break;
            default: tail.prefix += s[p];
          }
        }
        base = p + 1;
      } else if (s[p] === '&') {
        parts.push({ prefix: s.slice(base, p), id: 0, type: replType });
        replType = saveType;
        base = p + 1;
      }
    }
    if (base < n) parts.push({ prefix: s.slice(base), id: -1, type: replType });
    sub.replacement = parts;
  }

  // compile_program
  compileProgram() {
    if (!this.program) this.program = [];
    if (this.pendingText !== null) this.readText(null, '\n');
    for (;;) {
      let ch;
      while ((ch = this.inchar()) === ';' || isSpace(ch));
      if (ch === EOF) break;
      const cmd = { a1: null, a2: null, rangeState: RANGE_INACTIVE, bang: false, cmd: '' };
      const a = this.compileAddress(ch);
      if (a) {
        if (a.type === ADDR_IS_STEP || a.type === ADDR_IS_STEP_MOD) this.badProg(ERR.BAD_STEP);
        cmd.a1 = a;
        ch = this.inNonblank();
        if (ch === ',') {
          const a2 = this.compileAddress(this.inNonblank());
          if (!a2) this.badProg(ERR.BAD_COMMA);
          cmd.a2 = a2;
          ch = this.inNonblank();
        }
        if (cmd.a1.type === ADDR_IS_NUM && cmd.a1.number === 0
          && ((!cmd.a2 || cmd.a2.type !== ADDR_IS_REGEX) || this.posixicity === POSIXLY_BASIC)) this.badProg(ERR.INVALID_LINE_0);
      }
      if (ch === '!') {
        cmd.bang = true;
        ch = this.inNonblank();
        if (ch === '!') this.badProg(ERR.BAD_BANG);
      }
      if (this.posixicity === POSIXLY_BASIC) {
        switch (ch) {
          case 'e': case 'F': case 'v': case 'z': case 'L': case 'Q': case 'T': case 'R': case 'W':
            this.badProg(`unknown command: \`${ch}'`);
            break;
          case 'a': case 'i': case 'l': case '=': case 'r':
            if (cmd.a2) this.badProg(ERR.ONE_ADDR);
        }
      }
      cmd.cmd = ch;
      switch (ch) {
        case '#': {
          if (cmd.a1) this.badProg(ERR.NO_SHARP_ADDR);
          ch = this.inchar();
          if (ch === 'n' && this.firstScript && this.cur.line < 2 && this.pos === 2) this.noDefaultOutput = true;
          while (ch !== EOF && ch !== '\n') ch = this.inchar();
          continue;
        }
        case 'v': {
          const version = this.readLabel();
          if (strverscmp(version === '' ? '4.0' : version, '4.8') > 0) this.badProg(ERR.ANCIENT_VERSION);
          this.posixicity = POSIXLY_EXTENDED;
          continue;
        }
        case '{':
          this.blocks.push({ idx: this.program.length, err: { ...this.cur } });
          cmd.bang = !cmd.bang;
          break;
        case '}':
          if (!this.blocks.length) this.badProg(ERR.EXCESS_CLOSE_BRACE);
          if (cmd.a1) this.badProg(ERR.NO_CLOSE_BRACE_ADDR);
          this.readEndOfCmd();
          this.program[this.blocks.pop().idx].jump = this.program.length;
          break;
        case 'e':
          if (this.sandbox) this.badProg(ERR.DISALLOWED_CMD);
          ch = this.inNonblank();
          if (ch === EOF || ch === '\n') { cmd.text = ''; break; }
          this.readTextToSlash(cmd, ch);
          break;
        case 'a': case 'i': case 'c':
          ch = this.inNonblank();
          this.readTextToSlash(cmd, ch);
          break;
        case ':': {
          if (cmd.a1) this.badProg(ERR.NO_COLON_ADDR);
          const label = this.readLabel();
          if (!label) this.badProg(ERR.COLON_LACKS_LABEL);
          this.labels.push({ name: label, idx: this.program.length });
          if (this.debug) cmd.labelName = label;
          break;
        }
        case 'T': case 'b': case 't':
          this.jumps.push({ name: this.readLabel(), idx: this.program.length });
          break;
        case 'Q': case 'q':
          if (cmd.a2) this.badProg(ERR.ONE_ADDR);
          // fallthrough
        case 'L': case 'l':
          ch = this.inNonblank();
          if (isDigit(ch) && this.posixicity !== POSIXLY_BASIC) cmd.intArg = this.inInteger(ch);
          else { cmd.intArg = -1; this.savchar(ch); }
          this.readEndOfCmd();
          break;
        case '=': case 'd': case 'D': case 'F': case 'g': case 'G': case 'h': case 'H':
        case 'n': case 'N': case 'p': case 'P': case 'z': case 'x':
          this.readEndOfCmd();
          break;
        case 'r': {
          const b = this.readFilename();
          if (b === '') this.badProg(ERR.MISSING_FILENAME);
          cmd.fname = b;
          break;
        }
        case 'R':
          cmd.inf = this.getOpenfile(this.fileRead, false);
          break;
        case 'W': case 'w':
          cmd.outf = this.getOpenfile(this.fileWrite, true);
          break;
        case 's': {
          const slash = this.inchar();
          const b = this.matchSlash(slash, true);
          if (b === null) this.badProg(ERR.UNTERM_S_CMD);
          const b2 = this.matchSlash(slash, false);
          if (b2 === null) this.badProg(ERR.UNTERM_S_CMD);
          const sub = {};
          this.setupReplacement(sub, b2);
          const flags = this.markSubstOpts(sub);
          sub.regx = this.compileRegex(b, flags, sub.maxId + 1);
          if (sub.eval && this.sandbox) this.badProg(ERR.DISALLOWED_CMD);
          cmd.sub = sub;
          break;
        }
        case 'y': {
          const slash = this.inchar();
          const b = this.matchSlash(slash, false);
          if (b === null) this.badProg(ERR.UNTERM_Y_CMD);
          const src = this.normalizeText(b, TEXT_BUFFER);
          const b2 = this.matchSlash(slash, false);
          if (b2 === null) this.badProg(ERR.UNTERM_Y_CMD);
          const dest = this.normalizeText(b2, TEXT_BUFFER);
          if (src.length !== dest.length) this.badProg(ERR.Y_CMD_LEN);
          const map = new Array(256);
          for (let k = 0; k < 256; k++) map[k] = String.fromCharCode(k);
          for (let k = 0; k < src.length; k++) map[src.charCodeAt(k) & 255] = dest[k];
          cmd.map = map;
          this.readEndOfCmd();
          break;
        }
        case EOF:
          this.badProg(ERR.NO_COMMAND);
          break;
        default:
          this.badProg(`unknown command: \`${ch}'`);
      }
      this.program.push(cmd);
    }
    if (this.posixicity === POSIXLY_BASIC && this.pendingText !== null) this.badProg(ERR.INCOMPLETE_CMD);
  }

  readTextToSlash(cmd, ch) {
    if (ch === EOF) this.badProg(ERR.EXPECTED_SLASH);
    if (ch === '\\') ch = this.inchar();
    else {
      if (this.posixicity === POSIXLY_BASIC) this.badProg(ERR.EXPECTED_SLASH);
      this.savchar(ch);
      ch = '\n';
    }
    this.readText(cmd, ch);
  }

  compileString(str) {
    this.src = str;
    this.pos = 0;
    this.inString = true;
    this.cur = { name: null, line: 0, expr: ++this.exprCount };
    this.compileProgram();
    this.inString = false;
    this.src = '';
    this.pos = 0;
    this.firstScript = false;
  }

  compileFile(name) {
    let data = '';
    if (name === '-') data = this.ctx.stdin.readAll();
    else {
      try { data = this.ctx.readFile(name); }
      catch (e) {
        if (!(e instanceof FsError)) throw e;
        if (e.code !== 'EISDIR') this.panic(`couldn't open file ${name}: ${e.message}`);
        data = '';   // a directory reads as an empty script
      }
    }
    this.src = data;
    this.pos = 0;
    this.inString = false;
    this.cur = { name, line: 1, expr: 0 };
    this.compileProgram();
    this.src = '';
    this.pos = 0;
    this.firstScript = false;
  }

  // check_final_program
  checkFinalProgram() {
    if (this.blocks.length) {
      this.cur = { ...this.blocks[this.blocks.length - 1].err };
      this.inString = false;
      this.badProg(ERR.EXCESS_OPEN_BRACE);
    }
    if (this.pendingText !== null) {
      // an a/i/c text that ran into the end of the script stays as it was typed
      if (this.pendingText.length) this.oldTextCmd.text = this.pendingText;
      this.pendingText = null;
    }
    for (let k = this.jumps.length - 1; k >= 0; k--) {
      const go = this.jumps[k];
      let lbl = null;
      for (let j = this.labels.length - 1; j >= 0; j--) if (this.labels[j].name === go.name) { lbl = this.labels[j]; break; }
      if (lbl) this.program[go.idx].jump = lbl.idx;
      else {
        if (go.name) this.panic(`can't find label for jump to \`${go.name}'`);
        this.program[go.idx].jump = this.program.length;
      }
    }
  }

  // ------------------------------------------------------------------ --debug (debug.c)
  dbg(s) { this.stdoutBuf.write(s); }

  static dbgChar(c) {
    const b = c.charCodeAt(0);
    if (b >= 32 && b < 127 && c !== '\\') return c;
    switch (c) {
      case '\x07': return '\\a';
      case '\f': return '\\f';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\v': return '\\v';
      case '\n': return '\\n';
      case '\\': return '\\\\';
    }
    // printf("o%03o", (unsigned int) c) of a signed char
    return '\\o' + (b > 127 ? (b - 256) >>> 0 : b).toString(8).padStart(3, '0');
  }

  dbgRegex(r) {
    if (!r) return '//';
    let s = '/';
    for (const c of r.pattern) s += c === '/' ? '\\/' : Sed.dbgChar(c);
    return s + '/';
  }

  dbgRegexFlags(r, addr) {
    if (!r) return '';
    return (r.cflags.icase ? (addr ? 'I' : 'i') : '') + (r.cflags.newline ? (addr ? 'M' : 'm') : '');
  }

  dbgAddr(a) {
    if (!a) return '';
    switch (a.type) {
      case ADDR_IS_NULL: return '[ADDR-NULL]';
      case ADDR_IS_REGEX: return this.dbgRegex(a.regex) + this.dbgRegexFlags(a.regex, true);
      case ADDR_IS_NUM: return String(a.number);
      case ADDR_IS_NUM_MOD: return `${a.number}~${a.step}`;
      case ADDR_IS_STEP: return `+${a.step}`;
      case ADDR_IS_STEP_MOD: return `~${a.step}`;
      case ADDR_IS_LAST: return '$';
    }
    return '';
  }

  dbgFunction(cmd) {
    let s = cmd.cmd;
    switch (cmd.cmd) {
      case ':': s += cmd.labelName ?? '(null)'; break;
      case 'a': case 'c': case 'i': s += '\\' + (cmd.text || ''); break;
      case 'b': case 't': case 'T':
        if (cmd.jump < this.program.length && this.program[cmd.jump].labelName) s += ' ' + this.program[cmd.jump].labelName;
        break;
      case 'e': s += ' ' + (cmd.text || ''); break;
      case 'L': case 'l': case 'q': case 'Q': if (cmd.intArg !== -1) s += ' ' + cmd.intArg; break;
      case 'r': s += ' ' + cmd.fname; break;
      case 'R': s += ' ' + cmd.inf.name; break;
      case 'w': case 'W': s += cmd.outf.name; break;
      case 's': {
        const sub = cmd.sub;
        s += this.dbgRegex(sub.regx);
        let last = REPL_ASIS;
        for (const p of sub.replacement) {
          if (p.type !== last) {
            s += '\\';
            if (p.type === 0) s += 'E';
            else if (p.type === REPL_UPPERCASE) s += 'U';
            else if (p.type === REPL_LOWERCASE) s += 'L';
            else if ((p.type & REPL_MODIFIERS) === REPL_UPPERCASE_FIRST) s += 'u';
            else if ((p.type & REPL_MODIFIERS) === REPL_LOWERCASE_FIRST) s += 'l';
            last = p.type;
          }
          s += p.prefix;
          if (p.id !== -1) s += p.id === 0 ? '&' : '\\' + p.id;
        }
        s += '/' + this.dbgRegexFlags(sub.regx, false);
        if (sub.global) s += 'g';
        if (sub.eval) s += 'e';
        if (sub.print) s += 'p';
        if (sub.numb) s += sub.numb;
        if (sub.outf) s += 'w' + sub.outf.name;
        break;
      }
      case 'y': {
        let from = '', to = '';
        for (let k = 0; k < 256; k++) if (cmd.map[k] !== String.fromCharCode(k)) { from += String.fromCharCode(k); to += cmd.map[k]; }
        s += '/' + from + '/' + to + '/';
        break;
      }
    }
    return s;
  }

  dbgCommand(cmd) {
    if (cmd.cmd === '}') this.blockLevel--;
    let s = '  '.repeat(Math.max(0, this.blockLevel));
    s += this.dbgAddr(cmd.a1);
    if (cmd.a2) s += ',';
    s += this.dbgAddr(cmd.a2);
    if (cmd.cmd === '{' ? !cmd.bang : cmd.bang) s += '!';
    if (cmd.a1 || cmd.a2) s += ' ';
    s += this.dbgFunction(cmd) + '\n';
    if (cmd.cmd === '{') this.blockLevel++;
    return s;
  }

  dbgProgram() {
    this.blockLevel = 1;
    let s = 'SED PROGRAM:\n';
    for (const c of this.program) s += this.dbgCommand(c);
    this.blockLevel = 0;
    this.dbg(s);
  }

  dbgLine(ln) {
    let s = ln === this.hold ? 'HOLD:    ' : 'PATTERN: ';
    for (const c of ln.text) s += Sed.dbgChar(c);
    this.dbg(s + '\n');
  }

  dbgEndOfCycle() { if (this.debug) this.dbg('END-OF-CYCLE:\n'); }

  // ------------------------------------------------------------------ output
  outputMissingNewline(o) {
    if (o.missingNewline) { o.sink.write(this.delim); o.missingNewline = false; }
  }

  flushOutput(o) {
    if (this.unbuffered && o.sink === this.stdoutBuf) this.stdoutBuf.flush();
  }

  outputLine(text, nl, o) {
    if (text === null || text === undefined) return;
    this.outputMissingNewline(o);
    if (text.length) o.sink.write(text);
    if (nl) o.sink.write(this.delim);
    else o.missingNewline = true;
    this.flushOutput(o);
  }

  dumpAppendQueue() {
    const o = this.output;
    this.outputMissingNewline(o);
    for (const a of this.appendQueue) {
      if (a.text) o.sink.write(a.text);
      if (a.fname) {
        // a file that can't be read counts as empty
        let data = null;
        try {
          const n = this.ctx.fs.stat(a.fname, this.ctx.cwd);
          if (n.type === 'd') { this.appendQueue = []; this.panic(`read error on ${a.fname}: Is a directory`); }
          data = this.ctx.readFile(a.fname);
        } catch (e) {
          if (!(e instanceof FsError)) throw e;
        }
        if (data) o.sink.write(data);
      }
    }
    this.flushOutput(o);
    this.appendQueue = [];
  }

  // ------------------------------------------------------------------ input
  openNextFile(name) {
    const inp = this.input;
    inp.inFileName = name;
    inp.cur = null;
    const ctx = this.ctx;
    if (name === '-' && this.inPlace === null) {
      const st = ctx.stdin;
      if (this.unbuffered || st.seekable) inp.cur = { name, data: st.data, pos: st.pos, stdin: true, isStdin: true };
      else inp.cur = { name, data: st.readAll(), pos: 0, isStdin: true };
      this.output = this.stdoutOut;
      return;
    }
    let path = name;
    let node;
    try {
      if (this.followSymlinks) { path = ctx.fs.realpath(name, ctx.cwd); inp.inFileName = path; }
      node = ctx.fs.stat(path, ctx.cwd);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      ctx.stderr.write(`sed: can't read ${name}: ${e.message}\n`);
      inp.badCount++;
      return;
    }
    const cur = { name, path, node, data: '', pos: 0 };
    if (node.type === 'd') cur.dir = true;
    else {
      try { cur.data = ctx.readFile(path); }
      catch (e) {
        if (!(e instanceof FsError)) throw e;
        ctx.stderr.write(`sed: can't read ${name}: ${e.message}\n`);
        inp.badCount++;
        return;
      }
    }
    inp.cur = cur;
    if (this.inPlace !== null) {
      if (node.type !== 'f') this.panic(`couldn't edit ${inp.inFileName}: not a regular file`);
      cur.out = { sink: new OutBuf(64 * 1024 * 1024), missingNewline: false };
      this.output = cur.out;
    } else this.output = this.stdoutOut;
  }

  // read_file_line
  readRecord() {
    const cur = this.input.cur;
    if (!cur) return null;
    if (cur.dir) this.panic(`read error on ${cur.name}: Is a directory`);
    if (cur.pos >= cur.data.length) return null;
    const j = cur.data.indexOf(this.delim, cur.pos);
    let rec;
    if (j < 0) { rec = { text: cur.data.slice(cur.pos), found: false }; cur.pos = cur.data.length; }
    else { rec = { text: cur.data.slice(cur.pos, j), found: true }; cur.pos = j + 1; }
    if (cur.stdin) this.ctx.stdin.pos = cur.pos;
    return rec;
  }

  hasData(cur) { return !!cur && !cur.dir && cur.pos < cur.data.length; }

  // closedown: an in-place edit replaces the file
  closedown() {
    const inp = this.input;
    const cur = inp.cur;
    inp.cur = null;
    if (!cur || !cur.out) return;
    const ctx = this.ctx, fs = ctx.fs;
    const target = inp.inFileName;
    const slash = target.lastIndexOf('/');
    const dir = slash < 0 ? '.' : slash === 0 ? '/' : target.slice(0, slash);
    let tmp;
    do tmp = (dir === '/' ? '' : dir) + '/sed' + (++tmpCounter).toString(36).padStart(6, '0');
    while (fs.exists(tmp, ctx.cwd, false));
    const t = fs.writeFile(tmp, cur.out.sink.data, ctx.cwd);
    t.mode = cur.node.mode;
    t.uid = cur.node.uid;
    t.gid = cur.node.gid;
    this.tmpFiles.push(tmp);
    const rename = (from, to) => {
      try { fs.rename(from, to, ctx.cwd); }
      catch (e) { if (e instanceof FsError) this.panic(`cannot rename ${from}: ${e.message}`); throw e; }
    };
    if (this.inPlace !== '*') {
      const base = target;
      const backup = this.inPlace.split('*').join(base);
      rename(target, backup);
    }
    rename(tmp, target);
    this.tmpFiles = this.tmpFiles.filter(f => f !== tmp);
    this.output = this.stdoutOut;
  }

  resetAddresses() {
    for (const c of this.program) {
      c.rangeState = c.a1 && c.a1.type === ADDR_IS_NUM && c.a1.number === 0 ? RANGE_ACTIVE : RANGE_INACTIVE;
    }
  }

  rewindReadFiles() {
    for (const f of this.fileRead) if (f.data !== undefined) f.pos = 0;
  }

  // read_pattern_space
  readPatternSpace(append) {
    const inp = this.input;
    if (this.appendQueue.length) this.dumpAppendQueue();
    this.replaced = false;
    if (!append) this.line.text = '';
    this.line.chomped = true;
    let rec;
    while (!(rec = this.readRecord())) {
      this.closedown();
      if (inp.idx >= inp.files.length) return false;
      if (inp.resetAtNextFile) {
        inp.lineNumber = 0;
        this.hold.text = '';
        this.resetAddresses();
        this.rewindReadFiles();
        if (this.inPlace !== null) this.output.missingNewline = false;
        inp.resetAtNextFile = this.separate;
      }
      this.openNextFile(inp.files[inp.idx++]);
    }
    this.line.text += rec.text;
    if (!rec.found) this.line.chomped = false;
    inp.lineNumber++;
    return true;
  }

  lastFileWithDataP() {
    const inp = this.input;
    for (;;) {
      this.closedown();
      if (inp.idx >= inp.files.length) return true;
      this.openNextFile(inp.files[inp.idx++]);
      if (this.hasData(inp.cur)) return false;
    }
  }

  // test_eof: is this the last line (`$')?
  testEof() {
    if (this.hasData(this.input.cur)) return false;
    return this.separate || this.lastFileWithDataP();
  }

  // ------------------------------------------------------------------ matching
  matchRegex(regex, buf, start, regs) {
    if (!regex) {
      regex = this.regexLast;
      if (!regex) this.badProg(ERR.NO_REGEX);
    } else this.regexLast = regex;
    const re = regex.re;
    re.lastIndex = start;
    let m = re.exec(buf);
    if (!m) return null;
    if (!regs) return m;
    const s = m.index, e = s + m[0].length;
    if (regex.longest && regex.maxLen > e - s) {
      // POSIX wants the longest match starting here (the search is bounded for huge buffers)
      const top = Math.min(buf.length, s + regex.maxLen, e + 4096);
      for (let end = top; end > e; end--) {
        const k = buf.length - end;
        let r = regex.ext.get(k);
        if (!r) {
          if (regex.ext.size > 2048) regex.ext.clear();
          r = new RegExp('(?:' + regex.src + ')(?=[\\s\\S]{' + k + '}$)', regex.flags + 'yd');
          regex.ext.set(k, r);
        }
        r.lastIndex = s;
        const m2 = r.exec(buf);
        if (m2) { m = m2; break; }
      }
    }
    m.nsub = regex.nsub;
    return m;
  }

  matchAnAddressP(addr) {
    const inp = this.input;
    switch (addr.type) {
      case ADDR_IS_NULL: return true;
      case ADDR_IS_REGEX: return !!this.matchRegex(addr.regex, this.line.text, 0, false);
      case ADDR_IS_NUM_MOD: return inp.lineNumber >= addr.number && (inp.lineNumber - addr.number) % addr.step === 0;
      case ADDR_IS_STEP: case ADDR_IS_STEP_MOD: return addr.number <= inp.lineNumber;
      case ADDR_IS_LAST: return this.testEof();
      case ADDR_IS_NUM: return addr.number === inp.lineNumber;
    }
    this.panic('INTERNAL ERROR: bad address type');
    return false;
  }

  // match_address_p
  matchAddressP(cmd) {
    const inp = this.input;
    if (!cmd.a1) return true;
    if (cmd.rangeState !== RANGE_ACTIVE) {
      if (!cmd.a2) return this.matchAnAddressP(cmd.a1);
      // line numbers are absolute: a range can start past its first line
      if (cmd.a1.type === ADDR_IS_NUM) {
        if (cmd.rangeState === RANGE_CLOSED || inp.lineNumber < cmd.a1.number) return false;
      } else if (!this.matchAnAddressP(cmd.a1)) return false;
      cmd.rangeState = RANGE_ACTIVE;
      switch (cmd.a2.type) {
        case ADDR_IS_REGEX:
          return true;   // always include at least two lines
        case ADDR_IS_NUM:
          if (inp.lineNumber >= cmd.a2.number) cmd.rangeState = RANGE_CLOSED;
          return inp.lineNumber <= cmd.a2.number || this.matchAnAddressP(cmd.a1);
        case ADDR_IS_STEP:
          cmd.a2.number = inp.lineNumber + cmd.a2.step;
          return true;
        case ADDR_IS_STEP_MOD:
          cmd.a2.number = inp.lineNumber + cmd.a2.step - (inp.lineNumber % cmd.a2.step);
          return true;
        default:
          break;
      }
    }
    if (cmd.a2.type === ADDR_IS_NUM) {
      if (inp.lineNumber >= cmd.a2.number) cmd.rangeState = RANGE_CLOSED;
      return inp.lineNumber <= cmd.a2.number;
    }
    if (this.matchAnAddressP(cmd.a2)) cmd.rangeState = RANGE_CLOSED;
    return true;
  }

  // ------------------------------------------------------------------ commands
  doList(lineLen) {
    const o = this.output;
    this.outputMissingNewline(o);
    const text = this.line.text;
    let width = 0;
    let s = '';
    for (let i = 0; i < text.length; i++) {
      const b = text.charCodeAt(i);
      let ob;
      if (b >= 32 && b < 127) ob = b === 92 ? '\\\\' : text[i];
      else {
        switch (b) {
          case 7: ob = '\\a'; break;
          case 8: ob = '\\b'; break;
          case 12: ob = '\\f'; break;
          case 10: ob = '\\n'; break;
          case 13: ob = '\\r'; break;
          case 9: ob = '\\t'; break;
          case 11: ob = '\\v'; break;
          default: ob = '\\' + (b & 255).toString(8).padStart(3, '0');
        }
      }
      if (width + ob.length >= lineLen && lineLen > 0) { s += '\\' + this.delim; width = 0; }
      s += ob;
      width += ob.length;
    }
    o.sink.write(s + '$' + this.delim);
    this.flushOutput(o);
  }

  appendReplacement(parts, m) {
    let out = '';
    let replMod = 0;
    const nregs = m.nsub + 2;
    for (const p of parts) {
      const i = p.id;
      let currType = (p.type & REPL_MODIFIERS) ? p.type : p.type | replMod;
      replMod = 0;
      if (p.prefix.length) {
        out += strModified(p.prefix, currType);
        currType &= ~REPL_MODIFIERS;
      }
      if (i >= 0 && i < nregs) {
        const g = m.indices[i];
        const gs = g ? g[0] : -1, ge = g ? g[1] : -1;
        // a modifier before an empty group applies to what follows
        if (ge === gs && (p.type & REPL_MODIFIERS)) replMod = currType & REPL_MODIFIERS;
        else if (ge !== gs) out += strModified(m.input.slice(gs, ge), currType);
      }
    }
    return out;
  }

  runCommand(cmdline) {
    const buf = new OutBuf(64 * 1024 * 1024);
    this.ctx.runShell(cmdline.split('\0')[0], { stdout: buf });
    return buf.data;
  }

  doSubst(sub) {
    const line = this.line;
    const text = line.text;
    const L = text.length;
    let start = 0, lastEnd = 0, count = 0, again = true;
    let m = this.matchRegex(sub.regx, text, start, true);
    if (!m) return;
    if (this.debug) {
      let d = 'MATCHED REGEX REGISTERS\n';
      for (let i = 0; i <= m.nsub; i++) {
        const g = m.indices[i];
        if (!g) break;
        d += `  regex[${i}] = ${g[0]}-${g[1]} '${text.slice(g[0], g[1])}'\n`;
      }
      this.dbg(d);
    }
    let out = '';
    do {
      this.ctx.tick();
      const offset = m.index;
      const end = offset + m[0].length;
      let matched = end - offset;
      if (start < offset) { out += text.slice(start, offset); start = offset; }
      // count this match, unless it is empty and right after the previous one
      if ((matched > 0 || count === 0 || offset > lastEnd) && ++count >= sub.numb) {
        this.replaced = true;
        out += this.appendReplacement(sub.replacement, m);
        again = sub.global;
      } else {
        if (matched === 0) {
          if (start < L) matched = 1;
          else break;
        }
        out += text.slice(offset, offset + matched);
      }
      start = offset + matched;
      lastEnd = end;
    } while (again && start <= L && (m = this.matchRegex(sub.regx, text, start, true)));
    if (start < L) out += text.slice(start);
    line.text = out;
    if (count < sub.numb) return;
    if (sub.print & 1) this.outputLine(line.text, line.chomped, this.output);
    if (sub.eval) {
      let r = this.runCommand(line.text);
      if (r.length && r[r.length - 1] === this.delim) r = r.slice(0, -1);
      line.text = r;
    }
    if (sub.print & 2) this.outputLine(line.text, line.chomped, this.output);
    if (sub.outf) this.writeTo(sub.outf, line.text, line.chomped);
  }

  writeTo(outf, text, nl) {
    if (!outf.ok || !outf.sink) return;
    this.outputLine(text, nl, outf);
  }

  readRLine(f) {
    if (f.stdin) {
      const st = this.ctx.stdin;
      if (st.pos >= st.data.length) return null;
      const j = st.data.indexOf(this.delim, st.pos);
      const e = j < 0 ? st.data.length : j + 1;
      const s = st.data.slice(st.pos, e);
      st.pos = e;
      return s;
    }
    if (f.dir) this.panic(`read error on ${f.name}: Is a directory`);
    if (f.pos >= f.data.length) return null;
    const j = f.data.indexOf(this.delim, f.pos);
    const e = j < 0 ? f.data.length : j + 1;
    const s = f.data.slice(f.pos, e);
    f.pos = e;
    return s;
  }

  // execute_program: -1 to go on with the next cycle, else the exit status
  executeProgram() {
    const prog = this.program;
    const line = this.line, hold = this.hold;
    const D = this.delim;
    let pc = 0;
    while (pc < prog.length) {
      this.ctx.tick();
      const cmd = prog[pc];
      if (this.debug) this.dbg('COMMAND: ' + this.dbgCommand(cmd));
      if (this.matchAddressP(cmd) !== cmd.bang) {
        switch (cmd.cmd) {
          case 'a':
            this.appendQueue.push({ text: cmd.text });
            break;
          case '{': case 'b':
            pc = cmd.jump;
            continue;
          case '}': case '#': case ':':
            break;
          case 'c':
            if (cmd.rangeState !== RANGE_ACTIVE && cmd.text) this.outputLine(cmd.text.slice(0, -1), true, this.output);
            this.dbgEndOfCycle();
            return -1;
          case 'd':
            this.dbgEndOfCycle();
            return -1;
          case 'D': {
            const k = line.text.indexOf(D);
            if (k < 0) return -1;
            line.text = line.text.slice(k + 1);
            if (this.debug) this.dbgLine(line);
            pc = 0;
            continue;
          }
          case 'e': {
            if (!cmd.text) {
              let r = this.runCommand(line.text);
              if (r.length && r[r.length - 1] === D) r = r.slice(0, -1);
              line.text = r;
            } else {
              this.outputMissingNewline(this.output);
              cmd.text = cmd.text.slice(0, -1) + '\0';   // sed terminates the command in place
              const r = this.runCommand(cmd.text);
              if (r) this.output.sink.write(r);
              this.flushOutput(this.output);
            }
            break;
          }
          case 'g':
            line.text = hold.text; line.chomped = hold.chomped;
            if (this.debug) this.dbgLine(hold);
            break;
          case 'G':
            line.text += D + hold.text; line.chomped = hold.chomped;
            if (this.debug) this.dbgLine(line);
            break;
          case 'h':
            hold.text = line.text; hold.chomped = line.chomped;
            if (this.debug) this.dbgLine(hold);
            break;
          case 'H':
            hold.text += D + line.text; hold.chomped = line.chomped;
            if (this.debug) this.dbgLine(hold);
            break;
          case 'i':
            if (cmd.text) this.outputLine(cmd.text.slice(0, -1), true, this.output);
            break;
          case 'l':
            this.doList(cmd.intArg === -1 ? this.lineLen : cmd.intArg);
            break;
          case 'n':
            if (!this.noDefaultOutput) this.outputLine(line.text, line.chomped, this.output);
            if (this.testEof() || !this.readPatternSpace(false)) { this.dbgEndOfCycle(); return -1; }
            if (this.debug) this.dbgLine(line);
            break;
          case 'N':
            line.text += D;
            if (this.testEof() || !this.readPatternSpace(true)) {
              this.dbgEndOfCycle();
              line.text = line.text.slice(0, -1);
              if (this.posixicity === POSIXLY_EXTENDED && !this.noDefaultOutput) this.outputLine(line.text, line.chomped, this.output);
              return -1;
            }
            if (this.debug) this.dbgLine(line);
            break;
          case 'p':
            this.outputLine(line.text, line.chomped, this.output);
            break;
          case 'P': {
            const k = line.text.indexOf(D);
            this.outputLine(k >= 0 ? line.text.slice(0, k) : line.text, k >= 0 ? true : line.chomped, this.output);
            break;
          }
          case 'q':
            if (!this.noDefaultOutput) this.outputLine(line.text, line.chomped, this.output);
            this.dumpAppendQueue();
            return cmd.intArg === -1 ? 0 : cmd.intArg & 255;
          case 'Q':
            return cmd.intArg === -1 ? 0 : cmd.intArg & 255;
          case 'r':
            if (cmd.fname) this.appendQueue.push({ fname: cmd.fname });
            break;
          case 'R':
            if (cmd.inf.ok) {
              const s = this.readRLine(cmd.inf);
              if (s !== null) this.appendQueue.push({ text: s });
            }
            break;
          case 's':
            this.doSubst(cmd.sub);
            if (this.debug) this.dbgLine(line);
            break;
          case 't':
            if (this.replaced) { this.replaced = false; pc = cmd.jump; continue; }
            break;
          case 'T':
            if (!this.replaced) { pc = cmd.jump; continue; }
            this.replaced = false;
            break;
          case 'w':
            this.writeTo(cmd.outf, line.text, line.chomped);
            break;
          case 'W': {
            const k = line.text.indexOf(D);
            this.writeTo(cmd.outf, k >= 0 ? line.text.slice(0, k) : line.text, k >= 0 ? true : line.chomped);
            break;
          }
          case 'x': {
            const t = line.text, tc = line.chomped;
            line.text = hold.text; line.chomped = hold.chomped;
            hold.text = t; hold.chomped = tc;
            if (this.debug) { this.dbgLine(line); this.dbgLine(hold); }
            break;
          }
          case 'y': {
            const map = cmd.map;
            let r = '';
            const s = line.text;
            for (let k = 0; k < s.length; k++) r += map[s.charCodeAt(k) & 255];
            line.text = r;
            if (this.debug) this.dbgLine(line);
            break;
          }
          case 'z':
            line.text = '';
            if (this.debug) this.dbgLine(line);
            break;
          case '=':
            this.outputMissingNewline(this.output);
            this.output.sink.write(this.input.lineNumber + D);
            this.flushOutput(this.output);
            break;
          case 'F':
            this.outputMissingNewline(this.output);
            this.output.sink.write(this.input.inFileName + D);
            this.flushOutput(this.output);
            break;
          default:
            this.panic(`INTERNAL ERROR: Bad cmd ${cmd.cmd}`);
        }
      }
      pc++;
    }
    this.dbgEndOfCycle();
    if (!this.noDefaultOutput) this.outputLine(line.text, line.chomped, this.output);
    return -1;
  }

  // process_files
  processFiles(files) {
    this.line = { text: '', chomped: true };
    this.hold = { text: '', chomped: true };
    if (!files.length) {
      if (this.inPlace !== null) this.panic('no input files');
      files = ['-'];
    }
    this.input = { files, idx: 0, cur: null, lineNumber: 0, badCount: 0, resetAtNextFile: true, inFileName: null };
    let status = 0;
    while (this.readPatternSpace(false)) {
      if (this.debug) {
        const inp = this.input;
        this.dbg(`INPUT:   '${inp.cur && inp.cur.isStdin ? 'STDIN' : inp.inFileName}' line ${inp.lineNumber}\n`);
        this.dbgLine(this.line);
      }
      status = this.executeProgram();
      if (status === -1) status = 0;
      else break;
    }
    this.closedown();
    if (this.input.badCount) status = EXIT_BAD_INPUT;
    return status;
  }

  main(argv) {
    const r = getopt(argv, { name: 'sed', short: 'bsnrzuEe:f:l:i::V:', long: LONG_OPTS }, { permute: !this.posixEnv });
    for (const [k, v] of r.opts) {
      switch (k) {
        case 'n': this.noDefaultOutput = true; break;
        case 'e': this.compileString(v); break;
        case 'f': this.compileFile(v); break;
        case 'z': this.delim = '\0'; break;
        case 'F': this.followSymlinks = true; break;
        case 'i':
          this.separate = true;
          this.inPlace = v === null || v === undefined ? '*' : v.includes('*') ? v : '*' + v;
          break;
        case 'l': this.lineLen = atoi(v); break;
        case 'p': this.posixicity = POSIXLY_BASIC; break;
        case 'b': break;
        case 'E': case 'r': this.extended = true; break;
        case 's': this.separate = true; break;
        case 'sandbox': this.sandbox = true; break;
        case 'debug': this.debug = true; break;
        case 'u': this.unbuffered = true; break;
        case 'v': this.stdoutBuf.write(VERSION); return 0;
        case 'h': this.usage(0); break;
        default: this.usage(EXIT_BAD_USAGE);
      }
    }
    if (r.error) {
      this.ctx.stderr.write(r.error + '\n');
      this.usage(EXIT_BAD_USAGE);
    }
    const files = r.operands.slice();
    if (!this.program) {
      if (files.length) this.compileString(files.shift());
      else this.usage(EXIT_BAD_USAGE);
    }
    this.checkFinalProgram();
    if (this.debug) this.dbgProgram();
    return this.processFiles(files);
  }
}

C.sed = (ctx) => {
  const sed = new Sed(ctx);
  let status;
  try {
    status = sed.main(ctx.argv.slice(1));
  } catch (e) {
    if (!(e instanceof SedExit)) { try { sed.stdoutBuf.flush(); } catch { /* the pipe is gone */ } throw e; }
    status = e.status;
  }
  sed.stdoutBuf.flush();
  return status;
};

export default C;
