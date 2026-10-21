// awk / gawk / nawk / mawk — GNU Awk 5.1.0. This file is gawk's main.c: the command line, the
// program sources, -v and -F assignments, ARGV. awkparse.js parses the program (awkgram.y) and
// awkrt.js runs it.
import { AwkParser } from './awkparse.js';
import { AwkRuntime, FatalExit, makeRegexp, BUILTIN_NAMES } from './awkrt.js';
import { UserStr, TypedRe } from './awkvals.js';
import { FsError } from '../vfs.js';
import { PipeLimit } from '../streams.js';

const C = {};

const VERSION = 'GNU Awk 5.1.0, API: 3.0 (GNU MPFR 4.1.0, GNU MP 6.2.1)\n';
const COPYLEFT = `Copyright (C) 1989, 1991-2020 Free Software Foundation.

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see http://www.gnu.org/licenses/.
`;
const usageText = (me) => `Usage: ${me} [POSIX or GNU style options] -f progfile [--] file ...
Usage: ${me} [POSIX or GNU style options] [--] 'program' file ...
POSIX options:\t\tGNU long options: (standard)
\t-f progfile\t\t--file=progfile
\t-F fs\t\t\t--field-separator=fs
\t-v var=val\t\t--assign=var=val
Short options:\t\tGNU long options: (extensions)
\t-b\t\t\t--characters-as-bytes
\t-c\t\t\t--traditional
\t-C\t\t\t--copyright
\t-d[file]\t\t--dump-variables[=file]
\t-D[file]\t\t--debug[=file]
\t-e 'program-text'\t--source='program-text'
\t-E file\t\t\t--exec=file
\t-g\t\t\t--gen-pot
\t-h\t\t\t--help
\t-i includefile\t\t--include=includefile
\t-l library\t\t--load=library
\t-L[fatal|invalid|no-ext]\t--lint[=fatal|invalid|no-ext]
\t-M\t\t\t--bignum
\t-N\t\t\t--use-lc-numeric
\t-n\t\t\t--non-decimal-data
\t-o[file]\t\t--pretty-print[=file]
\t-O\t\t\t--optimize
\t-p[file]\t\t--profile[=file]
\t-P\t\t\t--posix
\t-r\t\t\t--re-interval
\t-s\t\t\t--no-optimize
\t-S\t\t\t--sandbox
\t-t\t\t\t--lint-old
\t-V\t\t\t--version

To report bugs, see node \`Bugs' in \`gawk.info'
which is section \`Reporting Problems and Bugs' in the
printed version.  This same information may be found at
https://www.gnu.org/software/gawk/manual/html_node/Bugs.html.
PLEASE do NOT try to report bugs by posting in comp.lang.awk,
or by using a web forum such as Stack Overflow.

gawk is a pattern scanning and processing language.
By default it reads standard input and writes standard output.

Examples:
\t${me} '{ sum += $1 }; END { print sum }' file
\t${me} -F: '{ print $1 }' /etc/passwd
`;

// the short options ("+F:f:v:W;bcCd::D::e:E:ghi:l:L::nNo::Op::MPrSstVYZ:") and the long ones
const OPTLIST = '+F:f:v:W;bcCd::D::e:E:ghi:l:L::nNo::Op::MPrSstVYZ:';
const SHORT = {};
for (let i = 1; i < OPTLIST.length; i++) {
  const c = OPTLIST[i];
  if (c === ':' || c === ';') continue;
  let arg = 'none';
  if (OPTLIST[i + 1] === ':') arg = OPTLIST[i + 2] === ':' ? 'optional' : 'required';
  if (OPTLIST[i + 1] === ';') arg = 'W';
  SHORT[c] = arg;
}
const LONG = [
  ['assign', 'required', 'v'], ['bignum', 'none', 'M'], ['characters-as-bytes', 'none', 'b'], ['copyright', 'none', 'C'],
  ['debug', 'optional', 'D'], ['dump-variables', 'optional', 'd'], ['exec', 'required', 'E'], ['field-separator', 'required', 'F'],
  ['file', 'required', 'f'], ['gen-pot', 'none', 'g'], ['help', 'none', 'h'], ['include', 'required', 'i'], ['lint', 'optional', 'L'],
  ['lint-old', 'none', 't'], ['load', 'required', 'l'], ['non-decimal-data', 'none', 'n'], ['no-optimize', 'none', 's'],
  ['nostalgia', 'none', 'nostalgia'], ['optimize', 'none', 'O'], ['posix', 'none', 'P'], ['pretty-print', 'optional', 'o'],
  ['profile', 'optional', 'p'], ['re-interval', 'none', 'r'], ['sandbox', 'none', 'S'], ['source', 'required', 'e'],
  ['traditional', 'none', 'c'], ['use-lc-numeric', 'none', 'N'], ['version', 'none', 'V'],
];

class Usage { constructor(code, toStdout) { this.code = code; this.toStdout = toStdout; } }

// getopt_long() for gawk's options: yields [c, optarg] until the first operand. `?` comes with
// optopt (0 for a bad long option); stop() reports where the operands start.
function* getopts(argv, st) {
  let optind = 1;
  while (optind < argv.length) {
    const a = argv[optind];
    if (a === '--') { optind++; break; }
    if (a.length < 2 || a[0] !== '-') break;
    st.oldOptind = optind;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      let found = LONG.find(l => l[0] === name);
      if (!found) {
        const cands = LONG.filter(l => l[0].startsWith(name));
        if (cands.length === 1) found = cands[0];
      }
      optind++;
      if (!found) { st.optind = optind; yield ['?', null, 0]; continue; }
      const [, has, val] = found;
      if (has === 'none') {
        if (eq >= 0) { st.optind = optind; yield ['?', null, val.length === 1 ? val : 0]; continue; }
        st.optind = optind; yield [val, null];
      } else if (has === 'required') {
        let arg;
        if (eq >= 0) arg = a.slice(eq + 1);
        else if (optind < argv.length) arg = argv[optind++];
        else { st.optind = optind; yield ['?', null, val]; continue; }
        st.optind = optind; yield [val, arg];
      } else { st.optind = optind; yield [val, eq >= 0 ? a.slice(eq + 1) : null]; }
      continue;
    }
    // a cluster of short options
    let j = 1;
    let advanced = false;
    while (j < a.length) {
      const c = a[j++];
      const kind = SHORT[c];
      if (kind === undefined) {
        if (j >= a.length) { optind++; advanced = true; }
        st.optind = optind; yield ['?', null, c]; if (st.stop) return;
        continue;
      }
      if (kind === 'none') {
        if (j >= a.length) { optind++; advanced = true; }
        st.optind = optind; yield [c, null]; if (st.stop) return;
        continue;
      }
      if (kind === 'optional') {
        const arg = j < a.length ? a.slice(j) : null;
        optind++; advanced = true;
        st.optind = optind; yield [c, arg];
        break;
      }
      // required (and W;)
      let arg;
      if (j < a.length) { arg = a.slice(j); optind++; }
      else if (optind + 1 < argv.length) { arg = argv[optind + 1]; optind += 2; }
      else { optind++; advanced = true; st.optind = optind; yield ['?', null, c]; break; }
      advanced = true;
      if (kind === 'W') {
        const eq = arg.indexOf('=');
        const name = eq >= 0 ? arg.slice(0, eq) : arg;
        let found = LONG.find(l => l[0] === name);
        if (!found) { const cands = LONG.filter(l => l[0].startsWith(name)); if (cands.length === 1) found = cands[0]; }
        st.optind = optind;
        if (!found) yield ['W', arg];
        else if (found[1] === 'none') yield [found[2], null];
        else yield [found[2], eq >= 0 ? arg.slice(eq + 1) : found[1] === 'required' ? (optind < argv.length ? argv[optind++] : null) : null];
        st.optind = optind;
        break;
      }
      st.optind = optind;
      yield [c, arg];
      break;
    }
    if (!advanced) optind++;
    st.optind = optind;
  }
  st.optind = optind;
}

C.awk = C.gawk = C.nawk = C.mawk = (ctx) => {
  const argv = ctx.argv;
  const myname = ctx.name;
  const out = (s) => ctx.stdout.write(s);
  const errw = (s) => ctx.stderr.write(s);
  const opts = { name: myname, warned: new Set(), posix: false, traditional: false, nonDecimal: false, sandbox: false };
  const sources = [];        // { stype: 'cmdline' | 'file' | 'stdin' | 'inc', src, text, error }
  const preassigns = [];     // ['v' | 'F', value]
  let doVersion = false, doNostalgia = false, stoppedEarly = false, doBinary = false, prettyOnly = false;
  let dumpVars = null;

  const usage = (code, toStdout = false) => { throw new Usage(code, toStdout); };
  const findSource = (name) => {
    // find_source(): a name with a slash as is, else the current directory, then AWKPATH
    const tryPath = (p) => {
      try { const st = ctx.fs.stat(p, ctx.sh.cwd); return { path: p, st }; } catch (e) { if (e instanceof FsError) return { err: e }; throw e; }
    };
    let r = tryPath(name);
    if (!r.err || name.includes('/')) return r;
    const awkpath = (ctx.env && ctx.env.AWKPATH) || '.:/usr/share/awk';
    for (const dir of awkpath.split(':')) {
      const p = (dir || '.') + '/' + name;
      const r2 = tryPath(p);
      if (!r2.err) return r2;
    }
    if (!opts.traditional && !name.endsWith('.awk')) {
      const r3 = findSource(name + '.awk');
      if (!r3.err) return r3;
    }
    return r;
  };
  const addSrcfile = (stype, src) => {
    if (stype === 'cmdline') { sources.push({ stype, src, text: src }); return; }
    if (stype === 'stdin') { sources.push({ stype: 'file', src: '-', text: ctx.stdin.readAll() }); return; }
    const r = findSource(src);
    if (r.err) throw new FatalMsg(`${myname}: fatal: ${stype === 'lib' ? 'cannot open shared library' : 'cannot open source file'} \`${src}' for reading: ${errText(r.err)}\n`);
    if (stype === 'lib') throw new FatalMsg(`${myname}: fatal: cannot open shared library \`${src}' for reading: No such file or directory\n`);
    let text = '', error = null;
    try { text = ctx.readFile(r.path); }
    catch (e) { if (e instanceof FsError) error = errText(e); else throw e; }
    sources.push({ stype: 'file', src, path: r.path, text, error, inc: stype === 'inc' });
  };

  let rt = null;
  try {
    if (argv.length < 2) usage(1);
    // ------------------------------------------------------------ parse_args()
    const st = { optind: 1, oldOptind: 1, stop: false };
    const it = getopts(argv, st);
    let optindFinal = 1;
    for (let r = it.next(); !r.done; r = it.next()) {
      const [c, optarg, optopt] = r.value;
      switch (c) {
        case 'F': preassigns.push(['F', optarg]); break;
        case 'E': opts.disallowAssign = true;
          // fall through
        case 'f': {
          let src = optarg;
          if (/^\s*$/.test(src) && src !== '' && st.optind < argv.length) src = argv[st.optind++];
          addSrcfile(src === '-' ? 'stdin' : 'file', src);
          break;
        }
        case 'v': preassigns.push(['v', optarg]); break;
        case 'b': doBinary = true; break;
        case 'c': opts.traditional = true; break;
        case 'C': out(COPYLEFT); return 0;
        case 'd': dumpVars = optarg || 'awkvars.out'; break;
        case 'D': break;
        case 'e':
          if (optarg === '') errw(`${myname}: warning: empty argument to \`-e/--source' ignored\n`);
          else addSrcfile('cmdline', optarg);
          break;
        case 'g': opts.genPot = true; break;
        case 'h': usage(0, true); break;
        case 'i': addSrcfile('inc', optarg); break;
        case 'l': addSrcfile('lib', optarg); break;
        case 'L': opts.lint = true; break;
        case 't': break;
        case 'n': opts.nonDecimal = true; break;
        case 'N': break;
        case 'O': break;
        case 'p': case 'o': prettyOnly = c === 'o'; break;
        case 'M': break;
        case 'P': opts.posix = true; break;
        case 'r': break;
        case 's': break;
        case 'S': opts.sandbox = true; break;
        case 'V': doVersion = true; break;
        case 'nostalgia': doNostalgia = true; break;
        case 'W': errw(`${argv[0]}: option \`-W ${optarg}' unrecognized, ignored\n`); break;
        default: {
          // '?': an unknown option stops option processing (it goes to ARGV), unless posix
          const optlistHas = typeof optopt === 'string' && optopt !== '' && OPTLIST.includes(optopt);
          if (!opts.posix && (optopt === 0 || optopt === '' || !optlistHas)) {
            st.optind = st.oldOptind;
            stoppedEarly = true;
            st.stop = true;
            break;
          }
          if (optopt) { errw(`${myname}: option requires an argument -- ${optopt}\n`); usage(1); }
        }
      }
      if (st.stop) break;
      if (c === 'E') break;
      optindFinal = st.optind;
    }
    let optind = stoppedEarly ? st.optind : st.optind;
    void optindFinal;
    if (doNostalgia) { errw(`${myname}: bailing out near line 1\n`); return 134; }
    if (!opts.posix && ctx.env && ctx.env.POSIXLY_CORRECT !== undefined) opts.posix = true;
    if (opts.posix) {
      if (opts.traditional) errw(`${myname}: warning: \`--posix' overrides \`--traditional'\n`);
      else opts.traditional = true;
    }
    if (opts.traditional && opts.nonDecimal) {
      opts.nonDecimal = false;
      errw(`${myname}: warning: \`--posix'/\`--traditional' overrides \`--non-decimal-data'\n`);
    }
    if (doBinary && opts.posix) errw(`${myname}: warning: \`--posix' overrides \`--characters-as-bytes'\n`);

    // ------------------------------------------------------------ variables, -v and -F
    opts.dArgv = argv.slice();
    rt = new AwkRuntime(ctx, null, opts);
    let dashVErrs = 0;
    for (const [kind, val] of preassigns) {
      if (kind === 'v') {
        if (!val.includes('=')) {
          errw(`${myname}: \`${val}' argument to \`-v' not in \`var=value' form\n\n`);
          usage(1);
        }
        const name = val.slice(0, val.indexOf('='));
        if (!/^[A-Za-z_][A-Za-z0-9_:]*$/.test(name)) throw rt.fatal(`\`${name}' is not a legal variable name`);
        if (name.includes(':') && !/^[A-Za-z_]\w*::[A-Za-z_]\w*$/.test(name)) { dashVErrs++; continue; }
        if (BUILTIN_NAMES.has(name)) throw rt.fatal(`cannot use gawk builtin \`${name}' as variable name`);
        preassign(rt, name, val.slice(val.indexOf('=') + 1), opts);
      } else {
        // cmdline_fs()
        let fs = val;
        if (fs === 't' && opts.traditional && !opts.posix) fs = '\t';
        const v = rt.vars.get('FS');
        v.value = rt.scanEscapes(fs, false);
        rt.assignSpecial('FS');
      }
    }
    if (doVersion) { out(VERSION + COPYLEFT); return 0; }
    const haveSrcfile = sources.some(s => !s.inc);
    if (!haveSrcfile) {
      if (optind > argv.length - 1 || stoppedEarly) usage(1);
      sources.push({ stype: 'cmdline', src: argv[optind], text: argv[optind] });
      optind++;
    }
    // init_args()
    const argvVar = rt.newArrayVar('ARGV');
    rt.argvArr = argvVar.arr;
    rt.arrSet(argvVar.arr, 0, new UserStr(opts.posix ? argv[0] : myname));
    let j = 1;
    for (let i = optind; i < argv.length; i++, j++) rt.arrSet(argvVar.arr, j, new UserStr(argv[i]));
    const argc = rt.vars.get('ARGC') || (() => { const v = rt.slot('ARGC'); return v; })();
    argc.type = 'var';
    argc.value = j;

    // ------------------------------------------------------------ parse_program()
    const parser = new AwkParser(sources.map(s => ({ stype: s.stype === 'cmdline' ? 'cmdline' : 'file', src: s.src, text: s.text, error: s.error, path: s.path })), {
      error: (text) => errw(`${myname}: ${text}\n`),
      fatal: (text) => { errw(`${myname}: ${text}\n`); throw new FatalExit(2); },
    }, {
      posix: opts.posix, traditional: opts.traditional, warned: opts.warned,
      checkRegex: (re, warn, fatal) => {
        let r;
        try { r = makeRegexp(re, false, opts, warn, opts.warned); }
        catch (e) { if (e && e.message) fatal(e.message); throw e; }
        if (r.err) return Object.assign(new String(r.err), { pattern: r.buf });
        return null;
      },
      findSource: (name) => {
        const r = findSource(name);
        if (r.err) return null;
        try { return { path: r.path, text: ctx.readFile(r.path) }; } catch { return null; }
      },
    });
    const res = parser.run();
    if (!res.ok || dashVErrs > 0) { rt.flushStdoutQuiet(); return 1; }
    if (opts.genPot) return 0;
    rt.setProgram(res);
    if (prettyOnly) return 0;
    const code = rt.run();
    if (dumpVars) dumpVariables(rt, ctx, dumpVars);
    return code;
  } catch (e) {
    if (e instanceof Usage) {
      if (e.toStdout) out(usageText(myname));
      else errw(usageText(myname));
      return e.code;
    }
    if (e instanceof FatalMsg) { errw(e.message); return 2; }
    if (e instanceof FatalExit) {
      if (rt) rt.fatalCleanup();
      return e.code;
    }
    if (e instanceof PipeLimit) throw e;
    throw e;
  }
};

class FatalMsg extends Error { }

const errText = (e) => ({ ENOENT: 'No such file or directory', EISDIR: 'Is a directory', EACCES: 'Permission denied', ENOTDIR: 'Not a directory' }[e.code] || e.message);

// arg_assign(..., true) for -v
function preassign(rt, name, val, opts) {
  let it;
  if (!opts.traditional && val[0] === '@' && val[1] === '/' && val[val.length - 1] === '/' && val.length >= 3) it = new TypedRe(val.slice(2, -1));
  else {
    if (opts.posix && val.includes('\n')) throw rt.fatal('POSIX does not allow physical newlines in string values');
    it = new UserStr(rt.scanEscapes(val, true));
  }
  const v = rt.slot(name);
  if (v.type === 'array') throw rt.fatal(`attempt to use array \`${name}' in a scalar context`);
  if (v.hook) rt.readSpecial(v);
  v.type = 'var';
  v.value = it;
  if (v.hook) rt.assignSpecial(v.hook);
}

// --dump-variables: the globals, sorted by name
function dumpVariables(rt, ctx, file) {
  const names = [...rt.vars.keys()].filter(n => !rt.funcs.has(n)).sort();
  let s = '';
  for (const n of names) {
    const v = rt.vars.get(n);
    if (v.type === 'array') s += `${n}: array, ${v.arr.size} elements\n`;
    else if (v.type === 'new') s += `${n}: untyped variable\n`;
    else {
      const val = v.hook ? rt.readSpecial(v) : v.value;
      if (typeof val === 'number') s += `${n}: ${rt.formatVal(val, '%.6g')}\n`;
      else if (val === undefined) s += `${n}: untyped variable\n`;
      else s += `${n}: "${rt.str(val)}"\n`;
    }
  }
  try {
    if (file === '/dev/stdout' || file === '-') ctx.stdout.write(s);
    else if (file === '/dev/stderr') ctx.stderr.write(s);
    else { const w = ctx.openWrite(file, false); w.write(s); if (w.close) w.close(); }
  } catch { /* ignore */ }
}

export default C;
