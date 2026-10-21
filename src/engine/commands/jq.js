// jq 1.6 command line (main.c and the input handling of util.c), as in Ubuntu 22.04's
// jq 1.6-2.1ubuntu3.2. The language itself lives in jqjv.js (values, JSON parser/printer),
// jqparse.js (lexer/parser), jqcomp.js (compiler), jqexec.js (VM, builtins, modules),
// jqre.js (Oniguruma regexps), jqtime.js and jqmath.js.
import { FsError } from '../vfs.js';
import {
  JvParser, PARSE_SEQ, PARSE_STREAMING, PARSE_STREAM_ERRORS, INVALID, invalidMsg, isValid, hasMsg, getMsg, dump,
  decodeUtf8, encodeUtf8, parseCString, PRINT_PRETTY, PRINT_ASCII, PRINT_COLOR, PRINT_SORTED, PRINT_TAB,
  indentFlags, setColors, resetColors, JqAbort, utf8Next, UTF8,
} from './jqjv.js';
import { JqState } from './jqexec.js';

const C = {};

const SLURP = 1, RAW_INPUT = 2, PROVIDE_NULL = 4, RAW_OUTPUT = 8, ASCII_OUTPUT = 32, COLOR_OUTPUT = 64,
  NO_COLOR_OUTPUT = 128, SORTED_OUTPUT = 256, FROM_FILE = 512, RAW_NO_LF = 1024, UNBUFFERED_OUTPUT = 2048,
  EXIT_STATUS = 4096, EXIT_STATUS_EXACT = 8192, SEQ = 16384, RUN_TESTS = 32768, DUMP_DISASM = 65536;

const JQ_VERSION = '1.6';

class Exit {
  constructor(code) { this.code = code; }
}

// glibc stdout to a pipe: fully buffered in 4096-byte blocks
class StdoutBuf {
  constructor(sink) { this.sink = sink; this.buf = ''; }
  write(s) {
    if (!s) return;
    this.buf += s;
    if (this.buf.length >= 4096) {
      const n = this.buf.length - (this.buf.length % 4096);
      this.sink.write(this.buf.slice(0, n));
      this.buf = this.buf.slice(n);
    }
  }
  flush() { if (this.buf) { const b = this.buf; this.buf = ''; this.sink.write(b); } }
}

// FILE* emulation for fgets(): byte string data, EOF flag set when a read hits the end
class InFile {
  constructor(data, isStdin) { this.data = data; this.pos = 0; this.eof = false; this.err = null; this.isStdin = isStdin; }
  fgets(n) {
    if (this.err) return null;
    const d = this.data;
    if (this.pos >= d.length) { this.eof = true; return null; }
    const limit = Math.min(this.pos + n - 1, d.length);
    let nl = d.indexOf('\n', this.pos);
    let end;
    if (nl >= 0 && nl < limit) end = nl + 1;
    else end = limit;
    const chunk = d.slice(this.pos, end);
    this.pos = end;
    if (chunk[chunk.length - 1] !== '\n' && chunk.length < n - 1) this.eof = true;
    return chunk;
  }
}

// jq_util_input_state
class InputState {
  constructor(ctx, errfn) {
    this.ctx = ctx;
    this.errfn = errfn;
    this.parser = null;
    this.current = null;
    this.files = [];
    this.currFile = 0;
    this.failures = 0;
    this.slurped = INVALID;
    this.buf = '';
    this.currentFilename = INVALID;
    this.currentLine = 0;
    this.stdinData = null;
  }

  setParser(parser, slurp) {
    this.parser = parser;
    if (parser === null && slurp) this.slurped = '';
    else if (slurp) this.slurped = [];
    else this.slurped = INVALID;
  }

  openFile(f) {
    const ctx = this.ctx;
    if (f === '-') {
      if (this.stdinData === null) this.stdinData = ctx.stdin.readAll();
      const fh = new InFile(this.stdinData, true);
      // stdin keeps its position between uses
      fh.pos = this.stdinPos || 0;
      return fh;
    }
    try {
      const st = ctx.fs.stat(f, ctx.cwd);
      if (st && st.type === 'd') {
        const fh = new InFile('', false);
        fh.err = 'EISDIR';
        return fh;
      }
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
    }
    try {
      return new InFile(ctx.readFile(f), false);
    } catch (e) {
      if (e instanceof FsError) return { error: e };
      throw e;
    }
  }

  readMore() {
    let cur = this.current;
    if (!cur || cur.eof || cur.err) {
      if (cur) {
        if (cur.err) this.errfn(`Input error: ${strerror(cur.err)}\n`);
        if (cur.isStdin) { this.stdinPos = cur.pos; }
        this.current = null;
        this.currentFilename = INVALID;
        this.currentLine = 0;
      }
      const f = this.currFile < this.files.length ? this.files[this.currFile++] : null;
      if (f !== null) {
        if (f === '-') {
          this.current = this.openFile('-');
          this.currentFilename = '<stdin>';
        } else {
          const r = this.openFile(f);
          this.currentFilename = decodeUtf8(f);
          if (r.error) {
            this.errfn(`jq: error: Could not open file ${f}: ${strerror(r.error.code)}\n`);
            this.failures++;
            this.current = null;
          } else this.current = r;
        }
        this.currentLine = 0;
      }
    }
    this.buf = '';
    cur = this.current;
    if (cur) {
      const res = cur.fgets(4096);
      if (res === null) {
        this.buf = '';
        if (cur.err) this.failures++;
      } else {
        const nl = res.indexOf('\n');
        if (nl >= 0) this.currentLine++;
        if (nl < 0 && cur.eof) {
          // "we can't know how many bytes we've read": up to the last non-NUL byte
          let p = 0;
          for (let i = 0; i < res.length; i++) if (res[i] !== '\0') p = i;
          this.buf = res.slice(0, p + 1);
          if (res.length === 0) this.buf = '';
        } else if (nl < 0) {
          this.buf = res.slice(0, 4095);
        } else this.buf = res.slice(0, nl + 1);
      }
    }
    return this.currFile === this.files.length && (!this.current || this.current.eof || !!this.current.err);
  }

  // jq_util_input_next_input
  next() {
    let isLast = false, hasMore = false;
    let value = INVALID;
    do {
      if (this.parser === null) {
        isLast = this.readMore();
        if (this.buf.length === 0) continue;
        if (this.slurped !== INVALID) {
          this.slurped += decodeUtf8(this.buf);
        } else {
          if (value === INVALID) value = '';
          if (this.buf[this.buf.length - 1] === '\n') {
            const line = decodeUtf8(this.buf, 0, this.buf.length - 1);
            this.buf = '';
            return value + line;
          }
          value += decodeUtf8(this.buf);
          this.buf = '';
        }
      } else {
        if (this.parser.remaining() === 0) {
          isLast = this.readMore();
          if (isLast && this.buf.length === 0) value = INVALID;
          this.parser.setBuf(this.buf, !isLast);
        }
        value = this.parser.nextValue();
        if (this.slurped !== INVALID) {
          hasMore = this.parser.remaining() > 0;
          if (isValid(value)) { this.slurped.push(value); value = INVALID; }
          else if (hasMsg(value)) return value;
        } else if (isValid(value) || hasMsg(value)) return value;
      }
    } while (!isLast || hasMore);
    if (this.slurped !== INVALID) {
      value = this.slurped;
      this.slurped = INVALID;
    }
    return value;
  }

  position() {
    if (typeof this.currentFilename !== 'string') return '<unknown>';
    return `${this.currentFilename}:${this.currentLine}`;
  }
}

const ERRNO = {
  ENOENT: 'No such file or directory', EISDIR: 'Is a directory', EACCES: 'Permission denied',
  ENOTDIR: 'Not a directory', ELOOP: 'Too many levels of symbolic links', ENAMETOOLONG: 'File name too long',
};
const strerror = (code) => ERRNO[code] || code || 'No such file or directory';

function usageText(progname, keepItShort) {
  let s = `jq - commandline JSON processor [version ${JQ_VERSION}]\n` +
    `\nUsage:\t${progname} [options] <jq filter> [file...]\n` +
    `\t${progname} [options] --args <jq filter> [strings...]\n` +
    `\t${progname} [options] --jsonargs <jq filter> [JSON_TEXTS...]\n\n` +
    'jq is a tool for processing JSON inputs, applying the given filter to\n' +
    'its JSON text inputs and producing the filter\'s results as JSON on\n' +
    'standard output.\n\n' +
    'The simplest filter is ., which copies jq\'s input to its output\n' +
    'unmodified (except for formatting, but note that IEEE754 is used\n' +
    'for number representation internally, with all that that implies).\n\n' +
    'For more advanced filters see the jq(1) manpage ("man jq")\n' +
    'and/or https://stedolan.github.io/jq\n\n' +
    'Example:\n\n\t$ echo \'{"foo": 0}\' | jq .\n' +
    '\t{\n\t\t"foo": 0\n\t}\n\n';
  if (keepItShort) s += `For a listing of options, use ${progname} --help.\n`;
  else {
    s += 'Some of the options include:\n' +
      '  -c               compact instead of pretty-printed output;\n' +
      '  -n               use `null` as the single input value;\n' +
      '  -e               set the exit status code based on the output;\n' +
      '  -s               read (slurp) all inputs into an array; apply filter to it;\n' +
      '  -r               output raw strings, not JSON texts;\n' +
      '  -R               read raw strings, not JSON texts;\n' +
      '  -C               colorize JSON;\n' +
      '  -M               monochrome (don\'t colorize JSON);\n' +
      '  -S               sort keys of objects on output;\n' +
      '  --tab            use tabs for indentation;\n' +
      '  --arg a v        set variable $a to value <v>;\n' +
      '  --argjson a v    set variable $a to JSON value <v>;\n' +
      '  --slurpfile a f  set variable $a to an array of JSON texts read from <f>;\n' +
      '  --rawfile a f    set variable $a to a string consisting of the contents of <f>;\n' +
      '  --args           remaining arguments are string arguments, not files;\n' +
      '  --jsonargs       remaining arguments are JSON arguments, not files;\n' +
      '  --               terminates argument processing;\n\n' +
      'Named arguments are also available as $ARGS.named[], while\n' +
      'positional arguments are available as $ARGS.positional[].\n' +
      '\nSee the manpage for more options.\n';
  }
  return s;
}

const isAlpha = (c) => /[A-Za-z]/.test(c);
const isoptish = (t) => t[0] === '-' && (t[1] === '-' || (t[1] !== undefined && isAlpha(t[1])));

function dirname(p) {
  if (!p.includes('/')) return '.';
  let s = p.replace(/\/+$/, '');
  if (s === '') return '/';
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  s = s.slice(0, i).replace(/\/+$/, '');
  return s === '' ? '/' : s;
}

function skipShebang(p) {
  if (!p.startsWith('#!')) return p;
  let n = p.indexOf('\n');
  if (n < 0 || p[n + 1] !== '#') return p;
  n = p.indexOf('\n', n + 1);
  if (n < 0 || p[n + 1] === '#' || n + 1 >= p.length || p[n - 1] !== '\\' || p[n - 2] === '\\') return p;
  n = p.indexOf('\n', n + 1);
  if (n < 0) return p;
  return p.slice(n + 1);
}

C.jq = (ctx) => {
  const argv = ctx.argv;
  const progname = argv[0];
  const out = new StdoutBuf(ctx.stdout);
  const errw = (s) => ctx.stderr.write(encodeUtf8(s));
  resetColors();
  let options = 0;
  try {
    return main();
  } catch (e) {
    if (e instanceof Exit) { out.flush(); return e.code; }
    if (e instanceof JqAbort) {
      // a failed assertion: glibc prints it and aborts (the shell reports the SIGABRT)
      out.flush();
      errw(`${progname}: ${e.message}\n`);
      return 134;
    }
    throw e;
  }

  function die() {
    errw(`Use ${progname} --help for help with command-line options,\n`);
    errw('or see the jq manpage, or online docs  at https://stedolan.github.io/jq\n');
    throw new Exit(2);
  }
  function usage(code, keepItShort) {
    const text = usageText(progname, keepItShort);
    if (code === 0) out.write(encodeUtf8(text));
    else errw(text);
    throw new Exit(code);
  }

  function loadFile(path, raw) {
    // jv_load_file
    try {
      const st = ctx.fs.stat(path, ctx.cwd);
      if (st && st.type === 'd') return { error: `Could not open ${path}: It's a directory` };
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      return { error: `Could not open ${path}: ${strerror(e.code)}` };
    }
    let data;
    try { data = ctx.readFile(path); }
    catch (e) {
      if (e instanceof FsError) return { error: `Could not open ${path}: ${strerror(e.code)}` };
      throw e;
    }
    if (raw) return { value: decodeChunks(data) };
    const parser = new JvParser(0);
    const values = [];
    for (let i = 0; i < data.length || i === 0; i += 4096) {
      const chunk = data.slice(i, i + 4096);
      parser.setBuf(chunk, i + 4096 < data.length);
      let v;
      while (isValid(v = parser.nextValue())) values.push(v);
      if (hasMsg(v)) return { error: getMsg(v) };
      if (data.length === 0) break;
    }
    return { value: values };
  }

  function main() {
    let ret = 0;
    let parserFlags = 0;
    let nfiles = 0;
    let dumpopts = indentFlags(2);
    let program = null;
    let ARGS = [];
    const programArguments = new Map();
    let furtherArgsAreStrings = false, furtherArgsAreJson = false, argsDone = false;
    let libSearchPaths = null;
    const input = new InputState(ctx, errw);
    const jq = new JqState(host(input));

    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      let shortOpts = 0;
      const isoption = (shortopt, longopt) => {
        if (a[0] !== '-' || a[1] === '-') shortOpts = 0;
        if (a[0] !== '-') return false;
        if (a[1] === '-' && a.slice(2) === longopt) return true;
        if (a[1] === '-') return false;
        if (!shortopt) return false;
        if (a.includes(shortopt)) { shortOpts++; return true; }
        return false;
      };
      if (argsDone) {
        if (furtherArgsAreStrings) ARGS.push(decodeUtf8(a));
        else if (furtherArgsAreJson) ARGS.push(parseCString(a));
        else { input.files.push(a); nfiles++; }
        continue;
      }
      if (a === '--') {
        if (program === null) usage(2, true);
        argsDone = true;
        continue;
      }
      if (!isoptish(a)) {
        if (program !== null) {
          if (furtherArgsAreStrings) ARGS.push(decodeUtf8(a));
          else if (furtherArgsAreJson) ARGS.push(parseCString(a));
          else { input.files.push(a); nfiles++; }
        } else program = a;
        continue;
      }
      if (a[1] === 'L') {
        if (libSearchPaths === null) libSearchPaths = [];
        if (a.length > 2) libSearchPaths.push(realpath(decodeUtf8(a.slice(2))));
        else if (i >= argv.length - 1) {
          errw('-L takes a parameter: (e.g. -L /search/path or -L/search/path)\n');
          die();
        } else {
          libSearchPaths.push(realpath(decodeUtf8(argv[i + 1])));
          i++;
        }
        continue;
      }
      if (isoption('s', 'slurp')) { options |= SLURP; if (!shortOpts) continue; }
      if (isoption('r', 'raw-output')) { options |= RAW_OUTPUT; if (!shortOpts) continue; }
      if (isoption('c', 'compact-output')) { dumpopts &= ~(PRINT_TAB | indentFlags(7)); if (!shortOpts) continue; }
      if (isoption('C', 'color-output')) { options |= COLOR_OUTPUT; if (!shortOpts) continue; }
      if (isoption('M', 'monochrome-output')) { options |= NO_COLOR_OUTPUT; if (!shortOpts) continue; }
      if (isoption('a', 'ascii-output')) { options |= ASCII_OUTPUT; if (!shortOpts) continue; }
      if (isoption(null, 'unbuffered')) { options |= UNBUFFERED_OUTPUT; continue; }
      if (isoption('S', 'sort-keys')) { options |= SORTED_OUTPUT; if (!shortOpts) continue; }
      if (isoption('R', 'raw-input')) { options |= RAW_INPUT; if (!shortOpts) continue; }
      if (isoption('n', 'null-input')) { options |= PROVIDE_NULL; if (!shortOpts) continue; }
      if (isoption('f', 'from-file')) { options |= FROM_FILE; if (!shortOpts) continue; }
      if (isoption('j', 'join-output')) { options |= RAW_OUTPUT | RAW_NO_LF; if (!shortOpts) continue; }
      if (isoption(null, 'tab')) {
        dumpopts &= ~indentFlags(7);
        dumpopts |= PRINT_TAB | PRINT_PRETTY;
        continue;
      }
      if (isoption(null, 'indent')) {
        if (i >= argv.length - 1) {
          errw(`${progname}: --indent takes one parameter\n`);
          die();
        }
        dumpopts &= ~(PRINT_TAB | indentFlags(7));
        const indent = atoi(argv[i + 1]);
        if (indent < -1 || indent > 7) {
          errw(`${progname}: --indent takes a number between -1 and 7\n`);
          die();
        }
        dumpopts |= indentFlags(indent);
        i++;
        continue;
      }
      if (isoption(null, 'seq')) { options |= SEQ; continue; }
      if (isoption(null, 'stream')) { parserFlags |= PARSE_STREAMING; continue; }
      if (isoption(null, 'stream-errors')) { parserFlags |= PARSE_STREAM_ERRORS; continue; }
      if (isoption('e', 'exit-status')) { options |= EXIT_STATUS; if (!shortOpts) continue; }
      if (isoption(null, 'args')) { furtherArgsAreStrings = true; furtherArgsAreJson = false; continue; }
      if (isoption(null, 'jsonargs')) { furtherArgsAreStrings = false; furtherArgsAreJson = true; continue; }
      if (isoption(null, 'arg')) {
        if (i >= argv.length - 2) {
          errw(`${progname}: --arg takes two parameters (e.g. --arg varname value)\n`);
          die();
        }
        const name = decodeUtf8(argv[i + 1]);
        if (!programArguments.has(name)) programArguments.set(name, decodeUtf8(argv[i + 2]));
        i += 2;
        continue;
      }
      if (isoption(null, 'argjson')) {
        if (i >= argv.length - 2) {
          errw(`${progname}: --argjson takes two parameters (e.g. --argjson varname text)\n`);
          die();
        }
        const name = decodeUtf8(argv[i + 1]);
        if (!programArguments.has(name)) {
          const v = parseCString(argv[i + 2]);
          if (!isValid(v)) {
            errw(`${progname}: invalid JSON text passed to --argjson\n`);
            die();
          }
          programArguments.set(name, v);
        }
        i += 2;
        continue;
      }
      if (isoption(null, 'argfile') || isoption(null, 'rawfile') || isoption(null, 'slurpfile')) {
        const raw = a === '--rawfile';
        const which = a === '--argfile' ? 'argfile' : raw ? 'rawfile' : 'slurpfile';
        if (i >= argv.length - 2) {
          errw(`${progname}: --${which} takes two parameters (e.g. --${which} varname filename)\n`);
          die();
        }
        const name = decodeUtf8(argv[i + 1]);
        if (!programArguments.has(name)) {
          const r = loadFile(argv[i + 2], raw);
          if (r.error !== undefined) {
            errw(`${progname}: Bad JSON in --${which} ${argv[i + 1]} ${argv[i + 2]}: ${r.error}\n`);
            throw new Exit(2);
          }
          let data = r.value;
          if (which === 'argfile' && Array.isArray(data) && data.length === 1) data = data[0];
          programArguments.set(name, data);
        }
        i += 2;
        continue;
      }
      if (isoption(null, 'debug-dump-disasm')) { options |= DUMP_DISASM; continue; }
      if (isoption(null, 'debug-trace=all')) { if (!shortOpts) continue; }
      if (isoption(null, 'debug-trace')) { continue; }
      if (isoption('h', 'help')) { usage(0, false); if (!shortOpts) continue; }
      if (isoption('V', 'version')) {
        out.write(`jq-${JQ_VERSION}\n`);
        throw new Exit(0);
      }
      if (isoption(null, 'run-tests')) {
        errw(`${progname}: --run-tests is not supported here\n`);
        throw new Exit(2);
      }
      if (a.length !== shortOpts + 1) {
        errw(`${progname}: Unknown option ${a}\n`);
        die();
      }
    }

    if (options & SORTED_OUTPUT) dumpopts |= PRINT_SORTED;
    if (options & ASCII_OUTPUT) dumpopts |= PRINT_ASCII;
    if (options & COLOR_OUTPUT) dumpopts |= PRINT_COLOR;
    if (options & NO_COLOR_OUTPUT) dumpopts &= ~PRINT_COLOR;

    const env = ctx.env || {};
    if (env.JQ_COLORS !== undefined && !setColors(env.JQ_COLORS)) errw('Failed to set $JQ_COLORS\n');

    if (libSearchPaths === null) libSearchPaths = ['~/.jq', '$ORIGIN/../lib/jq', '$ORIGIN/lib'];
    jq.setAttr('JQ_LIBRARY_PATH', libSearchPaths);
    jq.setAttr('JQ_ORIGIN', decodeUtf8(dirname(progname)));
    jq.setAttr('VERSION_DIR', JQ_VERSION);

    // stdout and stdin are never terminals here: no program means "."
    if (program === null) program = '.';

    let text;
    if (options & FROM_FILE) {
      const r = loadFile(program, true);
      if (r.error !== undefined) {
        errw(`${progname}: ${r.error}\n`);
        throw new Exit(2);
      }
      jq.setAttr('PROGRAM_ORIGIN', realpath(decodeUtf8(dirname(program))));
      text = skipShebang(encodeUtf8(r.value));
    } else {
      jq.setAttr('PROGRAM_ORIGIN', realpath('.'));
      text = program;
    }
    const argsObj = new Map([['positional', ARGS], ['named', new Map(programArguments)]]);
    programArguments.set('ARGS', argsObj);
    // the program is a C string: it ends at a NUL byte
    const z = text.indexOf('\0');
    if (z >= 0) text = text.slice(0, z);
    if (!jq.compileArgs(text, programArguments)) throw new Exit(3);

    if (options & SEQ) parserFlags |= PARSE_SEQ;
    if (options & RAW_INPUT) input.setParser(null, !!(options & SLURP));
    else input.setParser(new JvParser(parserFlags), !!(options & SLURP));

    jq.inputCb = () => input.next();
    jq.debugCb = (v) => errw(dump(['DEBUG:', v], dumpopts & ~PRINT_PRETTY) + '\n');

    if (nfiles === 0) input.files.push('-');

    const process = (value) => {
      let r = 14;
      jq.start(value);
      let result;
      while (isValid(result = jq.next())) {
        if ((options & RAW_OUTPUT) && typeof result === 'string') {
          if (options & ASCII_OUTPUT) out.write(encodeUtf8(dump(result, PRINT_ASCII)));
          else out.write(encodeUtf8(result));
          r = 0;
        } else {
          r = result === false || result === null ? 11 : 0;
          if (options & SEQ) out.write('\x1e');
          out.write(encodeUtf8(dump(result, dumpopts)));
        }
        if (!(options & RAW_NO_LF)) out.write('\n');
        if (options & UNBUFFERED_OUTPUT) out.flush();
      }
      if (jq.halted) {
        options |= EXIT_STATUS_EXACT;
        const exitCode = jq.exitCode;
        if (!isValid(exitCode)) r = 0;
        else if (typeof exitCode === 'number') r = cInt(exitCode);
        else r = 5;
        const em = jq.errorMessage;
        if (typeof em === 'string') errw(em);
        else if (em === null) { /* halt with no output */ }
        else if (isValid(em)) errw(dump(em, 0) + '\n');
      } else if (hasMsg(result)) {
        const msg = getMsg(result);
        const pos = input.position();
        if (typeof msg === 'string') errw(`jq: error (at ${pos}): ${msg}\n`);
        else errw(`jq: error (at ${pos}) (not a string): ${dump(msg, 0)}\n`);
        r = 5;
      }
      return r;
    };

    if (options & PROVIDE_NULL) {
      ret = process(null);
    } else {
      let value;
      while (input.failures === 0 && (isValid(value = input.next()) || hasMsg(value))) {
        if (isValid(value)) { ret = process(value); continue; }
        const msg = getMsg(value);
        if (!(options & SEQ)) {
          ret = 4;
          errw(`parse error: ${msg}\n`);
          break;
        }
        errw(`ignoring parse error: ${msg}\n`);
      }
    }
    if (input.failures !== 0) ret = 2;

    out.flush();
    if (ret >= 10 && (options & EXIT_STATUS)) return (ret - 10) & 255;
    if (ret >= 10 && !(options & EXIT_STATUS_EXACT)) return 0;
    return ret & 255;
  }

  function realpath(p) {
    try { return decodeUtf8(ctx.fs.realpath(encodeUtf8(p), ctx.cwd)); }
    catch (e) { if (e instanceof FsError) return p; throw e; }
  }

  function host(input) {
    return {
      stderr: (s) => errw(s),
      tick: () => ctx.tick(),
      now: () => ctx.fs.now() / 1000,
      getenv: (k) => (ctx.env ? ctx.env[k] : undefined),
      environ: () => envMap(ctx.env, false),
      envObject: () => envMap(ctx.env, true),
      loadFile: (path, raw) => {
        const r = loadFile(encodeUtf8(path), raw);
        if (r.error !== undefined) return invalidMsg(r.error);
        return r.value;
      },
      realpath: (p) => realpath(p),
      stat: (p) => {
        try { ctx.fs.stat(encodeUtf8(p), ctx.cwd); return 'ok'; }
        catch (e) { if (e instanceof FsError) return e.code === 'ENOENT' ? 'ENOENT' : 'error'; throw e; }
      },
      currentFilename: () => input.currentFilename,
      currentLine: () => input.currentLine,
    };
  }
};

function envMap(env, forEnvVar) {
  const m = new Map();
  for (const [k, v] of Object.entries(env || {})) m.set(decodeUtf8(k), decodeUtf8(String(v)));
  void forEnvVar;
  return m;
}

// atoi(): leading whitespace, optional sign, digits
function atoi(s) {
  const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(s);
  if (!m) return 0;
  const v = parseInt(m[1], 10);
  if (v > 2147483647 || v < -2147483648) return v > 0 ? -1 : 0;
  return v;
}

// (int) of a double on aarch64: saturating, NaN -> 0
function cInt(d) {
  if (d !== d) return 0;
  if (d >= 2147483647) return 2147483647;
  if (d <= -2147483648) return -2147483648;
  return Math.trunc(d);
}

// jv_load_file raw mode: 4096-byte reads, never splitting a UTF-8 sequence that the next read completes
function decodeChunks(data) {
  if (data.length <= 4096) return decodeUtf8(data);
  let out = '';
  let i = 0;
  while (i < data.length) {
    let n = Math.min(4096, data.length - i);
    let end = i + n;
    if (end < data.length) {
      // jvp_utf8_backtrack: complete a trailing partial sequence from the following bytes
      let k = end - 1, seen = 1;
      while (k >= i && (data.charCodeAt(k) & 0xc0) === 0x80) { k--; seen++; }
      if (k >= i) {
        const c = data.charCodeAt(k);
        const len = c < 0x80 ? 1 : c >= 0xf0 && c < 0xf5 ? 4 : c >= 0xe0 ? 3 : c >= 0xc2 ? 2 : 0;
        if (len && len - seen > 0) end = Math.min(data.length, end + (len - seen));
      }
    }
    out += decodeUtf8(data, i, end);
    i = end;
  }
  return out;
}

void utf8Next; void UTF8; void RUN_TESTS;

export default C;
