// Text-processing coreutils: cat tac rev head tail wc sort uniq cut paste tr nl seq yes tee fold fmt
// expand unexpand column join comm split shuf strings ul basename dirname
import { parseArgs, eachInput, splitLines, qa, qf, filevercmp, readErrMsg, getopt, xstrtol, xdectoumax, UINTMAX_MAX, LONGINT_OK, LONGINT_OVERFLOW, LONGINT_INVALID_SUFFIX_CHAR, quotearg } from './util.js';
import { FsError } from '../vfs.js';
import { formatOne } from '../cfmt.js';
import { strtold, ldFromInt, ldAdd, ldMul, ldCmp, ldTrunc } from '../ldouble.js';
import { helpText } from './man.js';

const C = {};

// ---------------------------------------------------------------- cat
C.cat = (ctx) => {
  const a = parseArgs(ctx, { short: 'AbeEnstTuv', long: { 'show-all': 'A', 'number-nonblank': 'b', 'show-ends': 'E', number: 'n', 'squeeze-blank': 's', 'show-tabs': 'T', 'show-nonprinting': 'v', help: 'help', version: 'version' } });
  if (!a) return 1;
  let showEnds = false, showTabs = false, showNP = false, number = false, numberNB = false, squeeze = false;
  for (const [k] of a.all) {
    if (k === 'A') { showNP = showEnds = showTabs = true; }
    else if (k === 'e') { showNP = showEnds = true; }
    else if (k === 't') { showNP = showTabs = true; }
    else if (k === 'E') showEnds = true;
    else if (k === 'T') showTabs = true;
    else if (k === 'v') showNP = true;
    else if (k === 'n') number = true;
    else if (k === 'b') numberNB = true;
    else if (k === 's') squeeze = true;
  }
  const plain = !(showEnds || showTabs || showNP || number || numberNB || squeeze);
  let lineNo = 0, prevBlank = false, atLineStart = true;
  return eachInput(ctx, a.operands, (data, name) => {
    if (plain) { ctx.out(data); return 0; }
    let outp = '';
    let i = 0;
    while (i < data.length) {
      let j = data.indexOf('\n', i);
      const hasNl = j >= 0;
      if (!hasNl) j = data.length;
      let line = data.slice(i, j);
      i = hasNl ? j + 1 : j;
      const blank = line === '' && hasNl;
      if (atLineStart) {
        if (squeeze && blank && prevBlank) { continue; }
        prevBlank = blank;
        if ((number && !numberNB) || (numberNB && !blank)) outp += String(++lineNo).padStart(6) + '\t';
      }
      if (showNP || showTabs) {
        let s = '';
        for (const ch of line) {
          const c = ch.charCodeAt(0);
          if (ch === '\t') s += showTabs ? '^I' : '\t';
          else if (showNP && c < 32) s += '^' + String.fromCharCode(c + 64);
          else if (showNP && c === 127) s += '^?';
          else if (showNP && c >= 128) { const d = c - 128; s += 'M-' + (d < 32 ? '^' + String.fromCharCode(d + 64) : d === 127 ? '^?' : String.fromCharCode(d)); }
          else s += ch;
        }
        line = s;
      }
      outp += line + (hasNl ? (showEnds ? '$\n' : '\n') : '');
      atLineStart = hasNl;
    }
    ctx.out(outp);
    return 0;
  }, { sameOutputMsg: 'input file is output file' });
};

// ---------------------------------------------------------------- tac / rev
C.tac = (ctx) => {
  const a = parseArgs(ctx, { short: 'brs:', long: { before: 'b', regex: 'r', separator: ['s', 'required'] } });
  if (!a) return 1;
  const sep = a.has('s') ? a.get('s') : '\n';
  const before = a.has('b');
  return eachInput(ctx, a.operands, (data) => {
    if (data === '') return 0;
    let recs = [];
    if (a.has('r')) {
      const re = new RegExp(sep, 'g');
      let last = 0, m;
      while ((m = re.exec(data))) { if (m[0] === '') { re.lastIndex++; continue; } recs.push(before ? data.slice(last, m.index) : data.slice(last, m.index + m[0].length)); last = before ? m.index : m.index + m[0].length; }
      recs.push(data.slice(last));
    } else if (before) {
      let idx = data.indexOf(sep), prev = 0;
      const parts = [];
      while (idx >= 0) { parts.push(data.slice(prev, idx)); prev = idx; idx = data.indexOf(sep, idx + sep.length); }
      parts.push(data.slice(prev));
      recs = parts;
    } else {
      let prev = 0, idx;
      while ((idx = data.indexOf(sep, prev)) >= 0) { recs.push(data.slice(prev, idx + sep.length)); prev = idx + sep.length; }
      if (prev < data.length) recs.push(data.slice(prev));
    }
    recs = recs.filter(r => r !== '');
    ctx.out(recs.reverse().join(''));
    return 0;
  });
};

C.rev = (ctx) => {
  const files = ctx.argv.slice(1).filter(x => x !== '--');
  return eachInput(ctx, files, (data) => {
    let out = '';
    let i = 0;
    while (i < data.length) {
      let j = data.indexOf('\n', i);
      const nl = j >= 0;
      if (!nl) j = data.length;
      out += reverseUtf8(data.slice(i, j)) + (nl ? '\n' : '');
      i = nl ? j + 1 : j;
    }
    ctx.out(out);
    return 0;
  });
};

function reverseUtf8(s) {
  // keep multi-byte UTF-8 sequences intact (util-linux rev is locale aware; in C locale bytes,
  // but players expect emoji-safe output — matches a UTF-8 locale).
  const chars = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let len = 1;
    if (c >= 0xc0 && c < 0xe0) len = 2; else if (c >= 0xe0 && c < 0xf0) len = 3; else if (c >= 0xf0 && c < 0xf8) len = 4;
    chars.push(s.slice(i, i + len));
    i += len - 1;
  }
  return chars.reverse().join('');
}

// ---------------------------------------------------------------- head / tail
function obsoleteNum(argv, allowPlus, maxFiles) {
  // returns { n, unit, fromStart, rest } for -N / +N legacy syntax or null
  const a = argv[0];
  if (!a) return null;
  const m = /^([+-])(\d*)([bcl]?)(f?)$/.exec(a);
  if (!m) return null;
  if (m[1] === '+' && !allowPlus) return null;
  if (a === '-c' || a === '-' || a === '+') return null;
  if (m[2] === '' && m[3] === '' && m[4] === '') return null;
  if (argv.length - 1 > maxFiles) return null;
  if (m[1] === '-' && argv.length === 2 && argv[1].startsWith('-') && argv[1].length > 1) return null;
  return { n: m[2] === '' ? 10 : parseInt(m[2], 10), unit: m[3] || 'l', fromStart: m[1] === '+', rest: argv.slice(1) };
}

function headerName(f) { return f === '-' ? 'standard input' : f; }

C.head = (ctx) => {
  let argv = ctx.argv.slice(1);
  let n = 10n, countLines = true, allBut = false, header = 'multiple', zero = false;
  const usage = () => { ctx.stderr.write("Try 'head --help' for more information.\n"); return 1; };
  const toInt = (str) => {
    const r = xdectoumax(str, { suffixes: 'bkKmMGTPEZY0', err: countLines ? 'invalid number of lines' : 'invalid number of bytes' });
    if (!r.ok) { ctx.err(r.msg); return null; }
    return r.val;
  };
  // obsolete syntax: -NUM followed by option letters
  if (argv.length && argv[0][0] === '-' && /[0-9]/.test(argv[0][1] || '')) {
    const m = /^-(\d+)(.*)$/.exec(argv[0]);
    let mult = '';
    for (const c of m[2]) {
      if (c === 'c') { countLines = false; mult = ''; }
      else if (c === 'b' || c === 'k' || c === 'm') { countLines = false; mult = c; }
      else if (c === 'l') countLines = true;
      else if (c === 'q') header = 'never';
      else if (c === 'v') header = 'always';
      else if (c === 'z') zero = true;
      else { ctx.err(`invalid trailing option -- ${c}`); return usage(); }
    }
    const v = toInt(m[1] + mult);
    if (v === null) return 1;
    n = v;
    argv = argv.slice(1);
  }
  const HSPEC = { short: 'c:n:qvz0123456789', long: { bytes: ['c', 'required'], lines: ['n', 'required'], quiet: 'q', silent: 'q', verbose: 'v', 'zero-terminated': 'z', 'presume-input-pipe': 'P' } };
  const r = getopt(argv, { ...HSPEC, name: 'head' });
  for (const [k, v] of r.opts) {
    if (k === 'n' || k === 'c') {
      countLines = k === 'n';
      let str = v;
      allBut = str[0] === '-';
      if (allBut) str = str.slice(1);
      const x = toInt(str);
      if (x === null) return 1;
      n = x;
    } else if (k === 'q') header = 'never';
    else if (k === 'v') header = 'always';
    else if (k === 'z') zero = true;
    else if (/^[0-9]$/.test(k)) { ctx.err(`invalid trailing option -- ${k}`); return usage(); }
  }
  if (r.error) { ctx.stderr.write(r.error + '\n'); return usage(); }
  if (!countLines && allBut && n > (1n << 63n) - 1n) { ctx.err(`invalid number of bytes: ${qa(n.toString())}: Value too large for defined data type`); return 1; }
  const N = n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n);
  const files = r.operands.length ? r.operands : ['-'];
  const showHdr = header === 'always' || (header === 'multiple' && files.length > 1);
  const sep = zero ? '\0' : '\n';
  let first = true;
  const seekStdin = ctx.stdin.seekable;
  const stdinBase = ctx.stdin.pos;
  return eachInput(ctx, files, (data, f) => {
    if (showHdr) { ctx.out((first ? '' : '\n') + `==> ${headerName(f)} <==\n`); }
    first = false;
    // from a pipe, head reads 8 KiB blocks and stops once it has enough: the rest stays unread
    const piped = (used) => { if (f === '-' && !seekStdin) ctx.stdin.pos = stdinBase + Math.min(data.length, Math.max(8192, Math.ceil(used / 8192) * 8192)); };
    if (!countLines) { const o = allBut ? data.slice(0, Math.max(0, data.length - N)) : data.slice(0, N); ctx.out(o); if (f === '-' && seekStdin && !allBut) ctx.stdin.pos = stdinBase + o.length; else if (!allBut) piped(o.length); return 0; }
    if (!allBut) {
      let pos = 0, cnt = 0;
      while (cnt < N && pos < data.length) { const j = data.indexOf(sep, pos); if (j < 0) { pos = data.length; break; } pos = j + 1; cnt++; }
      ctx.out(data.slice(0, pos));
      if (f === '-' && seekStdin) ctx.stdin.pos = stdinBase + pos;
      else piped(pos);
    } else {
      // all but last n lines
      const recs = [];
      let pos = 0;
      while (pos < data.length) { const j = data.indexOf(sep, pos); const e = j < 0 ? data.length : j + 1; recs.push(data.slice(pos, e)); pos = e; }
      ctx.out(recs.slice(0, Math.max(0, recs.length - N)).join(''));
    }
    return 0;
  }, { quoteStyle: 'a' });
};

C.tail = (ctx) => {
  let argv = ctx.argv.slice(1);
  let n = 10n, countLines = true, fromStart = false, forever = false, header = 'multiple', zero = false;
  // parse_obsolete_option: one option string and at most one file
  const obsolete = (() => {
    const c = argv.length + 1;
    if (!(c === 2 || (c === 3 && !(argv[1][0] === '-' && argv[1].length > 1)) || (c >= 3 && c <= 4 && argv[1] === '--'))) return false;
    const a = argv[0];
    let p = 1;
    let tFromStart;
    if (a[0] === '+') tFromStart = true;
    else if (a[0] === '-') {
      const k = a[1] === 'c' ? 2 : 1;
      if (a[k] === undefined) return false;
      tFromStart = false;
    } else return false;
    const ns = p;
    while (/[0-9]/.test(a[p] || '')) p++;
    const ne = p;
    let def = 10n, tLines = true, tForever = false;
    if (a[p] === 'b') { def *= 512n; tLines = false; p++; } else if (a[p] === 'c') { tLines = false; p++; } else if (a[p] === 'l') p++;
    if (a[p] === 'f') { tForever = true; p++; }
    if (p < a.length) return false;
    if (ns === ne) n = def;
    else {
      const x = xstrtol(a.slice(ns), 'b', { max: UINTMAX_MAX, unsigned: true });
      if ((x.err & ~LONGINT_INVALID_SUFFIX_CHAR) !== LONGINT_OK) {
        ctx.err(`invalid number: ${qa(a)}${x.err & LONGINT_OVERFLOW ? ': Numerical result out of range' : ''}`);
        return null;
      }
      n = x.val;
    }
    fromStart = tFromStart; countLines = tLines; forever = tForever;
    return true;
  })();
  if (obsolete === null) return 1;
  if (obsolete) argv = argv.slice(1);
  const r = getopt(argv, { name: 'tail', short: 'c:n:fFqs:vz0123456789', long: { bytes: ['c', 'required'], lines: ['n', 'required'], follow: ['f', 'optional'], quiet: 'q', silent: 'q', verbose: 'v', 'zero-terminated': 'z', 'sleep-interval': ['s', 'required'], retry: 'retry', pid: ['pid', 'required'], 'max-unchanged-stats': ['mus', 'required'], 'disable-inotify': 'di', 'presume-input-pipe': 'pip' } });
  let followName = false;
  for (const [k, v] of r.opts) {
    if (k === 'n' || k === 'c') {
      countLines = k === 'n';
      let str = v;
      if (str[0] === '+') fromStart = true;
      else if (str[0] === '-') str = str.slice(1);
      const x = xdectoumax(str, { suffixes: 'bkKmMGTPEZY0', err: countLines ? 'invalid number of lines' : 'invalid number of bytes' });
      if (!x.ok) { ctx.err(x.msg); return 1; }
      n = x.val;
    } else if (k === 'f') { forever = true; if (v === 'name') followName = true; }
    else if (k === 'F') { forever = true; followName = true; }
    else if (k === 'q') header = 'never';
    else if (k === 'v') header = 'always';
    else if (k === 'z') zero = true;
    else if (/^[0-9]$/.test(k)) { ctx.err(`option used in invalid context -- ${k}`); return 1; }
  }
  if (r.error) { ctx.stderr.write(r.error + '\n'); ctx.stderr.write("Try 'tail --help' for more information.\n"); return 1; }
  if (fromStart && n) n -= 1n;
  const files = r.operands.length ? r.operands : ['-'];
  if (followName && files.includes('-')) { ctx.err("cannot follow '-' by name"); return 1; }
  if (!n && !forever && !fromStart) return 0;
  const N = n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n);
  const showHdr = header === 'always' || (header === 'multiple' && files.length > 1);
  const sep = zero ? '\0' : '\n';
  let first = true;
  let st = 0, live = 0;
  for (const f of files) {
    let data;
    try { data = ctx.readFile(f); }
    catch (e) {
      if (e instanceof FsError) { ctx.err(readErrMsg(ctx, f, e)); st = 1; continue; }
      throw e;
    }
    if (f !== '-' || ctx.stdin.seekable) live++;
    if (showHdr) { ctx.out((first ? '' : '\n') + `==> ${headerName(f)} <==\n`); }
    first = false;
    if (!countLines) { ctx.out(fromStart ? data.slice(N) : (N === 0 ? '' : data.slice(-N))); continue; }
    const recs = [];
    let pos = 0;
    while (pos < data.length) { const j = data.indexOf(sep, pos); const e = j < 0 ? data.length : j + 1; recs.push(data.slice(pos, e)); pos = e; }
    if (fromStart) ctx.out(recs.slice(N).join(''));
    else ctx.out(N === 0 ? '' : recs.slice(-N).join(''));
  }
  // -f: nothing left to follow
  if (forever && !live && files.some(f => f !== '-')) ctx.err('no files remaining');
  return st;
};

// ---------------------------------------------------------------- wc
C.wc = (ctx) => {
  const a = parseArgs(ctx, { short: 'clLmw', long: { bytes: 'c', chars: 'm', lines: 'l', 'max-line-length': 'L', words: 'w', 'files0-from': ['F', 'required'] } });   // (--total arrived in coreutils 9.1)
  if (!a) return 1;
  let pl = a.has('l'), pw = a.has('w'), pc = a.has('c'), pm = a.has('m'), pL = a.has('L');
  if (!pl && !pw && !pc && !pm && !pL) { pl = pw = pc = true; }
  let files = a.operands;
  if (a.has('F')) {
    try { files = ctx.readFile(a.get('F')).split('\0').filter(Boolean); } catch (e) { ctx.err(`cannot open ${qa(a.get('F'))} for reading: ${e.message}`); return 1; }
  }
  const useStdin = files.length === 0;
  const list = useStdin ? ['-'] : files;
  let st = 0;
  const nCounts = [pl, pw, pm, pc, pL].filter(Boolean).length;
  // width computation (coreutils compute_number_width)
  let width = 1;
  const stats = [];
  for (const f of list) {
    if (f === '-') { stats.push({ reg: false }); continue; }
    try { const n = ctx.fs.stat(f, ctx.cwd); stats.push({ reg: n.type === 'f', size: n.size, dir: n.type === 'd' }); }
    catch { stats.push({ failed: true }); }
  }
  if (!(list.length === 1 && nCounts === 1) && !(stats[0] && stats[0].failed)) {
    let minw = 1, total = 0;
    for (const s of stats) { if (s.failed) continue; if (s.reg) total += s.size; else minw = 7; }
    for (; total >= 10; total = Math.floor(total / 10)) width++;
    if (width < minw) width = minw;
  }
  const fmt = (r) => {
    const parts = [];
    if (pl) parts.push(String(r.l).padStart(width));
    if (pw) parts.push(String(r.w).padStart(width));
    if (pm) parts.push(String(r.m).padStart(width));
    if (pc) parts.push(String(r.c).padStart(width));
    if (pL) parts.push(String(r.L).padStart(width));
    return parts.join(' ') + (r.name !== null && r.name !== undefined ? ' ' + r.name : '') + '\n';
  };
  const T = { l: 0, w: 0, m: 0, c: 0, L: 0 };
  for (const f of list) {
    let data;
    try {
      data = ctx.readFile(f);
    } catch (e) {
      if (e instanceof FsError) {
        ctx.err(`${qf(f)}: ${e.message}`);
        st = 1;
        if (e.code === 'EISDIR') ctx.out(fmt({ name: f, l: 0, w: 0, m: 0, c: 0, L: 0 }));
        continue;
      }
      throw e;
    }
    let l = 0, w = 0, L = 0, col = 0, inWord = false;
    for (let i = 0; i < data.length; i++) {
      const ch = data.charCodeAt(i);
      if (ch === 10) { l++; if (col > L) L = col; col = 0; inWord = false; continue; }
      if (ch === 32 || ch === 9 || ch === 11 || ch === 12 || ch === 13) {
        inWord = false;
        if (ch === 9) col = col + 8 - (col % 8); else if (ch === 32) col++; else if (ch === 13 || ch === 12) col = 0;
        continue;
      }
      if (ch >= 32 && ch < 127) col++;
      if (!inWord) { w++; inWord = true; }
    }
    if (col > L) L = col;
    const c = data.length;
    // one line per file as it goes (error() flushes stdout, so messages stay in program order)
    ctx.out(fmt({ name: useStdin ? null : f, l, w, m: c, c, L }));
    T.l += l; T.w += w; T.m += c; T.c += c; T.L = Math.max(T.L, L);
  }
  if (list.length > 1) ctx.out(fmt({ ...T, name: 'total' }));
  return st;
};

// ---------------------------------------------------------------- sort
const isBlank = (c) => c === ' ' || c === '\t';

// GNU sort (coreutils 8.32 sort.c) in the C locale: blanks are space, tab and newline; -d keeps
// letters, digits and blanks; -i keeps printable ASCII; -f folds a-z to upper case.
const sortBlank = (c) => c === ' ' || c === '\t' || c === '\n';
const sortNonprinting = (c) => { const x = c.charCodeAt(0); return x < 0x20 || x > 0x7e; };
const sortNondictionary = (c) => !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) && !sortBlank(c);
const sortToupper = (c) => (c >= 'a' && c <= 'z' ? String.fromCharCode(c.charCodeAt(0) - 32) : c);
const sortDigit = (c) => c >= '0' && c <= '9';
const sortAt = (s, i) => (i < s.length ? s[i] : '\0');
// gnulib fraccompare() / numcompare() (strnumcmp-in.h), no thousands separator; A and B are C
// strings and I, J the positions reached in them
function sortFraccmp(a, i, b, j) {
  if (sortAt(a, i) === '.' && sortAt(b, j) === '.') {
    for (;;) { const x = sortAt(a, ++i), y = sortAt(b, ++j); if (x !== y) break; if (!sortDigit(x)) return 0; }
    const x = sortAt(a, i), y = sortAt(b, j);
    if (sortDigit(x) && sortDigit(y)) return x.charCodeAt(0) - y.charCodeAt(0);
    if (sortDigit(x)) { while (sortAt(a, i) === '0') i++; return sortDigit(sortAt(a, i)) ? 1 : 0; }
    if (sortDigit(y)) { while (sortAt(b, j) === '0') j++; return sortDigit(sortAt(b, j)) ? -1 : 0; }
    return 0;
  }
  if (sortAt(a, i++) === '.') { while (sortAt(a, i) === '0') i++; return sortDigit(sortAt(a, i)) ? 1 : 0; }
  if (sortAt(b, j++) === '.') { while (sortAt(b, j) === '0') j++; return sortDigit(sortAt(b, j)) ? -1 : 0; }
  return 0;
}
function sortNumcmp(a, b) {
  let i = 0, j = 0, ta = sortAt(a, 0), tb = sortAt(b, 0);
  const D = sortDigit;
  if (ta === '-') {
    do ta = sortAt(a, ++i); while (ta === '0');
    if (tb !== '-') {
      if (ta === '.') do ta = sortAt(a, ++i); while (ta === '0');
      if (D(ta)) return -1;
      while (tb === '0') tb = sortAt(b, ++j);
      if (tb === '.') do tb = sortAt(b, ++j); while (tb === '0');
      return D(tb) ? -1 : 0;
    }
    do tb = sortAt(b, ++j); while (tb === '0');
    while (ta === tb && D(ta)) { ta = sortAt(a, ++i); tb = sortAt(b, ++j); }
    if ((ta === '.' && !D(tb)) || (tb === '.' && !D(ta))) return sortFraccmp(b, j, a, i);
    const tmp = tb.charCodeAt(0) - ta.charCodeAt(0);
    let la = 0, lb = 0;
    for (; D(ta); ++la) ta = sortAt(a, ++i);
    for (; D(tb); ++lb) tb = sortAt(b, ++j);
    if (la !== lb) return la < lb ? 1 : -1;
    return la ? tmp : 0;
  }
  if (tb === '-') {
    do tb = sortAt(b, ++j); while (tb === '0');
    if (tb === '.') do tb = sortAt(b, ++j); while (tb === '0');
    if (D(tb)) return 1;
    while (ta === '0') ta = sortAt(a, ++i);
    if (ta === '.') do ta = sortAt(a, ++i); while (ta === '0');
    return D(ta) ? 1 : 0;
  }
  while (ta === '0') ta = sortAt(a, ++i);
  while (tb === '0') tb = sortAt(b, ++j);
  while (ta === tb && D(ta)) { ta = sortAt(a, ++i); tb = sortAt(b, ++j); }
  if ((ta === '.' && !D(tb)) || (tb === '.' && !D(ta))) return sortFraccmp(a, i, b, j);
  const tmp = ta.charCodeAt(0) - tb.charCodeAt(0);
  let la = 0, lb = 0;
  for (; D(ta); ++la) ta = sortAt(a, ++i);
  for (; D(tb); ++lb) tb = sortAt(b, ++j);
  if (la !== lb) return la < lb ? -1 : 1;
  return la ? tmp : 0;
}
const sortSkipBlanks = (s) => { let i = 0; while (i < s.length && sortBlank(s[i])) i++; return s.slice(i); };
// human_numcompare(): the unit (K/k M G T P E Z Y) first, then the number
function sortUnitOrder(s) {
  const minus = s[0] === '-';
  let p = minus ? 1 : 0, nonzero = false, ch;
  while (sortDigit(ch = sortAt(s, p++))) if (ch !== '0') nonzero = true;
  if (ch === '.') while (sortDigit(ch = sortAt(s, p++))) if (ch !== '0') nonzero = true;
  if (!nonzero) return 0;
  const order = { K: 1, k: 1, M: 2, G: 3, T: 4, P: 5, E: 6, Z: 7, Y: 8 }[ch] || 0;
  return minus ? -order : order;
}
function sortHumancmp(a, b) {
  a = sortSkipBlanks(a); b = sortSkipBlanks(b);
  return sortUnitOrder(a) - sortUnitOrder(b) || sortNumcmp(a, b);
}
// getmonth(): binary search of the C locale's month table
const SORT_MONTHS = [['APR', 4], ['AUG', 8], ['DEC', 12], ['FEB', 2], ['JAN', 1], ['JUL', 7], ['JUN', 6], ['MAR', 3], ['MAY', 5], ['NOV', 11], ['OCT', 10], ['SEP', 9]];
function sortMonth(s) {
  s = sortSkipBlanks(s);
  let lo = 0, hi = 12;
  do {
    const ix = (lo + hi) >> 1, [name, val] = SORT_MONTHS[ix];
    for (let k = 0; ; k++) {
      if (k === name.length) return val;
      const c = sortToupper(sortAt(s, k));
      if (c < name[k]) { hi = ix; break; }
      if (c > name[k]) { lo = ix + 1; break; }
    }
  } while (lo < hi);
  return 0;
}
// strtold() into x86-64's 80-bit extended long double (64-bit significand), for -g. Returns
// { end: 0 } when nothing converts, else { end, kind: num|inf|nan, neg, m, e } (value m·2^e).
const SORT_LDP = 64;
function sortLdRound(neg, m, e) {
  if (m === 0n) return { kind: 'num', neg, m, e: 0 };
  const sh = m.toString(2).length - SORT_LDP;
  if (sh > 0) {
    const B = BigInt(sh);
    let q = m >> B;
    const rem = m & ((1n << B) - 1n), half = 1n << (B - 1n);
    if (rem > half || (rem === half && (q & 1n))) { q += 1n; if (q >> BigInt(SORT_LDP)) { q >>= 1n; e++; } }
    m = q; e += sh;
  }
  if (m.toString(2).length + e - 1 > 16383) return { kind: 'inf', neg };
  return { kind: 'num', neg, m, e };
}
function sortStrtold(s) {
  let i = 0;
  while (i < s.length && ' \t\n\v\f\r'.includes(s[i])) i++;
  let neg = false;
  if (s[i] === '+' || s[i] === '-') { neg = s[i] === '-'; i++; }
  const rest = s.slice(i);
  let m;
  if ((m = /^inf(inity)?/i.exec(rest))) return { end: i + m[0].length, kind: 'inf', neg };
  if ((m = /^nan(\([A-Za-z0-9_]*\))?/i.exec(rest))) return { end: i + m[0].length, kind: 'nan', neg };
  let v;
  if ((m = /^0[xX](?=[0-9a-fA-F]|\.[0-9a-fA-F])([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?/.exec(rest))) {
    const frac = m[2] || '', pe = m[3] ? Number(m[3]) : 0;
    const H = BigInt('0x' + (m[1] + frac || '0'));
    const e = pe - 4 * frac.length;
    if (H === 0n || e < -17000) v = { kind: 'num', neg, m: 0n, e: 0 };
    else if (e > 17000) v = { kind: 'inf', neg };
    else v = sortLdRound(neg, H, e);
  } else if ((m = /^(\d*)(?:\.(\d*))?/.exec(rest)) && (m[1] + (m[2] || '')).length) {
    let len = m[0].length, E = 0;
    const x = /^[eE]([+-]?\d+)/.exec(rest.slice(len));
    if (x) { E = Number(x[1]); len += x[0].length; }
    const digits = m[1] + (m[2] || '');
    const D = BigInt(digits);
    E -= (m[2] || '').length;
    const mag = digits.replace(/^0+/, '').length + E;
    if (D === 0n || mag < -4970) v = { kind: 'num', neg, m: 0n, e: 0 };
    else if (mag > 4935) v = { kind: 'inf', neg };
    else if (E >= 0) v = sortLdRound(neg, D * 10n ** BigInt(E), 0);
    else {
      const Q = 10n ** BigInt(-E);
      const k = Math.max(0, SORT_LDP + 3 + Q.toString(2).length - D.toString(2).length);
      const num = D << BigInt(k);
      v = sortLdRound(neg, ((num / Q) << 1n) | (num % Q ? 1n : 0n), -k - 1);
    }
    return { end: i + len, ...v };
  } else return { end: 0 };
  return { end: i + m[0].length, ...v };
}
// general_numcompare() of two sortStrtold() results
function sortGeneralcmp(a, b) {
  if (!a.end) return b.end ? -1 : 0;
  if (!b.end) return 1;
  const an = a.kind === 'nan', bn = b.kind === 'nan';
  if (an || bn) {
    if (!an) return 1;
    if (!bn) return -1;
    // nan_compare(): memcmp() of the two values; only the sign byte differs
    return a.neg === b.neg ? 0 : a.neg ? 1 : -1;
  }
  const sign = (v) => (v.kind === 'inf' ? (v.neg ? -2 : 2) : v.m === 0n ? 0 : v.neg ? -1 : 1);
  const sa2 = sign(a), sb2 = sign(b);
  if (sa2 !== sb2 || Math.abs(sa2) !== 1) return sa2 < sb2 ? -1 : sa2 > sb2 ? 1 : 0;
  const e = Math.min(a.e, b.e);
  const ma = a.m << BigInt(a.e - e), mb = b.m << BigInt(b.e - e);
  const c = ma < mb ? -1 : ma > mb ? 1 : 0;
  return sa2 < 0 ? -c : c;
}

// A sort key: fields and characters count from 0 (sword/schar/eword; echar 0 = the whole end
// field), eword Infinity = to the end of the line, fromStart = the key starts at the line start.
const sortNewKey = () => ({ sword: 0, schar: 0, eword: Infinity, echar: 0, fromStart: false, skipsblanks: false, skipeblanks: false,
  ignore: null, translate: false, numeric: false, general: false, human: false, month: false, random: false, version: false, reverse: false });
// set_ordering(): the option letters at the start of S; returns the rest
function sortSetOrdering(s, key, blanks) {
  let i = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === 'b') { if (blanks !== 'end') key.skipsblanks = true; if (blanks !== 'start') key.skipeblanks = true; }
    else if (c === 'd') key.ignore = 'd';
    else if (c === 'f') key.translate = true;
    else if (c === 'g') key.general = true;
    else if (c === 'h') key.human = true;
    else if (c === 'i') { if (!key.ignore) key.ignore = 'i'; }
    else if (c === 'M') key.month = true;
    else if (c === 'n') key.numeric = true;
    else if (c === 'R') key.random = true;
    else if (c === 'r') key.reverse = true;
    else if (c === 'V') key.version = true;
    else break;
  }
  return s.slice(i);
}
const sortDefaultKey = (k) => !(k.ignore || k.translate || k.skipsblanks || k.skipeblanks || k.month || k.numeric || k.general || k.human || k.version || k.random);
// -k POS1[,POS2]; throws the diagnostic
function sortParseKey(spec) {
  const lq = (s) => quotearg(s, 'locale');
  const bad = (msg) => `${msg}: invalid field specification ${lq(spec)}`;
  // parse_field_count(): xstrtoumax() of a count, which may be followed by more text
  const count = (s, what) => {
    const m = /^[ \t\n\v\f\r]*\+?(\d+)/.exec(s);
    if (!m) throw `${what}: invalid count at start of ${lq(s)}`;
    const v = BigInt(m[1]);
    return [v >= 9007199254740991n ? Infinity : Number(v), s.slice(m[0].length)];
  };
  const key = sortNewKey();
  let [n, s] = count(spec, 'invalid number at field start');
  if (n === 0) throw bad('field number is zero');
  key.sword = n - 1;
  if (s[0] === '.') {
    [n, s] = count(s.slice(1), "invalid number after '.'");
    if (n === 0) throw bad('character offset is zero');
    key.schar = n - 1;
  }
  if (!(key.sword || key.schar)) key.fromStart = true;
  s = sortSetOrdering(s, key, 'start');
  if (s[0] === ',') {
    [n, s] = count(s.slice(1), "invalid number after ','");
    if (n === 0) throw bad('field number is zero');
    key.eword = n - 1;
    if (s[0] === '.') [key.echar, s] = count(s.slice(1), "invalid number after '.'");
    s = sortSetOrdering(s, key, 'end');
  }
  if (s.length) throw bad('stray character in field spec');
  return key;
}
// begfield() / limfield(): where KEY starts and ends in LINE
function sortBegfield(line, key, tab) {
  let ptr = 0, sword = key.sword;
  const lim = line.length;
  if (tab !== null) while (ptr < lim && sword-- > 0) { while (ptr < lim && line[ptr] !== tab) ++ptr; if (ptr < lim) ++ptr; }
  else while (ptr < lim && sword-- > 0) { while (ptr < lim && sortBlank(line[ptr])) ++ptr; while (ptr < lim && !sortBlank(line[ptr])) ++ptr; }
  if (key.skipsblanks) while (ptr < lim && sortBlank(line[ptr])) ++ptr;
  return Math.min(lim, ptr + key.schar);
}
function sortLimfield(line, key, tab) {
  let ptr = 0, eword = key.eword, echar = key.echar;
  const lim = line.length;
  if (echar === 0) eword++;
  if (tab !== null) while (ptr < lim && eword-- > 0) { while (ptr < lim && line[ptr] !== tab) ++ptr; if (ptr < lim && (eword || echar)) ++ptr; }
  else while (ptr < lim && eword-- > 0) { while (ptr < lim && sortBlank(line[ptr])) ++ptr; while (ptr < lim && !sortBlank(line[ptr])) ++ptr; }
  if (echar !== 0) {
    if (key.skipeblanks) while (ptr < lim && sortBlank(line[ptr])) ++ptr;
    ptr = Math.min(lim, ptr + echar);
  }
  return ptr;
}

// compare() and keycompare(); KEYS have the global options already applied
function makeComparator(o) {
  const { keys, tab, stable, unique, reverse } = o;
  const parsed = new Map();   // strtold() results, which are costly to redo on every comparison
  const strtold = (s) => { let v = parsed.get(s); if (!v) { v = sortStrtold(s); parsed.set(s, v); } return v; };
  const keyText = (line, key) => {
    const lim = key.eword === Infinity ? line.length : sortLimfield(line, key, tab);
    let beg;
    if (!key.fromStart) beg = sortBegfield(line, key, tab);
    else { beg = 0; if (key.skipsblanks) while (beg < lim && sortBlank(line[beg])) beg++; }
    return lim > beg ? line.slice(beg, lim) : '';
  };
  const keycompare = (a, b) => {
    for (const key of keys) {
      let A = keyText(a, key), B = keyText(b, key);
      const ignore = key.ignore === 'd' ? sortNondictionary : key.ignore === 'i' ? sortNonprinting : null;
      const tr = key.translate ? sortToupper : null;
      let diff;
      if (key.numeric || key.general || key.human || key.month || key.random || key.version) {
        // compared as C strings, after dropping ignored and folding characters
        if (ignore || tr) {
          const conv = (s) => { let r = ''; for (const c of s) if (!(ignore && ignore(c))) r += tr ? tr(c) : c; return r; };
          A = conv(A); B = conv(B);
        }
        const ca = A.split('\0')[0], cb = B.split('\0')[0];
        if (key.numeric) diff = sortNumcmp(sortSkipBlanks(ca), sortSkipBlanks(cb));
        else if (key.general) diff = sortGeneralcmp(strtold(ca), strtold(cb));
        else if (key.human) diff = sortHumancmp(ca, cb);
        else if (key.month) diff = sortMonth(ca) - sortMonth(cb);
        else if (key.random) { diff = hashStr(A, o.seed) - hashStr(B, o.seed); if (!diff) diff = A < B ? -1 : A > B ? 1 : 0; }
        else diff = filevercmp(ca, cb);
      } else if (ignore) {
        let i = 0, j = 0;
        diff = null;
        for (;;) {
          while (i < A.length && ignore(A[i])) i++;
          while (j < B.length && ignore(B[j])) j++;
          if (!(i < A.length && j < B.length)) break;
          const x = tr ? tr(A[i]) : A[i], y = tr ? tr(B[j]) : B[j];
          if (x !== y) { diff = x < y ? -1 : 1; break; }
          i++; j++;
        }
        if (diff === null) diff = (i < A.length) - (j < B.length);
      } else if (!A.length) diff = B.length ? -1 : 0;
      else if (!B.length) diff = 1;
      else if (tr) {
        diff = 0;
        const n = Math.min(A.length, B.length);
        for (let i = 0; i < n && !diff; i++) { const x = tr(A[i]), y = tr(B[i]); if (x !== y) diff = x < y ? -1 : 1; }
        if (!diff) diff = A.length < B.length ? -1 : A.length !== B.length ? 1 : 0;
      } else diff = A < B ? -1 : A > B ? 1 : 0;
      if (diff) return key.reverse ? -diff : diff;
    }
    return 0;
  };
  return (a, b) => {
    if (keys.length) {
      const d = keycompare(a, b);
      if (d || unique || stable) return d;
    }
    const r = a < b ? -1 : a > b ? 1 : 0;
    return reverse ? -r : r;
  };
}

function hashStr(s, seed) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// GNU sort's mergefps(): the inputs are not sorted, only merged. Each step writes the smallest
// current line (ties go to the earliest input); with -u only the first line of each run of
// equal lines is kept.
function mergeRuns(runs, cmp, unique) {
  runs = runs.filter((r) => r.length);
  const pos = runs.map(() => 0);
  const cur = (i) => runs[i][pos[i]];
  let nfiles = runs.length;
  const ord = runs.map((_, i) => i);
  for (let i = 1; i < nfiles; ++i) if (cmp(cur(ord[i - 1]), cur(ord[i])) > 0) { const t = ord[i - 1]; ord[i - 1] = ord[i]; ord[i] = t; i = 0; }
  const out = [];
  let saved = null;
  while (nfiles) {
    const smallest = cur(ord[0]);
    if (unique) {
      if (saved !== null && cmp(saved, smallest)) { out.push(saved); saved = null; }
      if (saved === null) saved = smallest;
    } else out.push(smallest);
    const f = ord[0];
    if (++pos[f] >= runs[f].length) {
      // EOF on this input: drop it
      for (let i = 1; i < nfiles; ++i) if (ord[i] > f) --ord[i];
      --nfiles;
      runs.splice(f, 1); pos.splice(f, 1);
      for (let i = 0; i < nfiles; ++i) ord[i] = ord[i + 1];
      ord.length = nfiles;
      continue;
    }
    // push the new line back into the queue (binary search, first probe at 1)
    let lo = 1, hi = nfiles, probe = lo;
    while (lo < hi) {
      const c = cmp(cur(f), cur(ord[probe]));
      if (c < 0 || (c === 0 && f < ord[probe])) hi = probe; else lo = probe + 1;
      probe = (lo + hi) >> 1;
    }
    for (let j = 0; j < lo - 1; j++) ord[j] = ord[j + 1];
    ord[lo - 1] = f;
  }
  if (unique && saved !== null) out.push(saved);
  return out;
}

// GNU sort's merge(): more than NMERGE (--batch-size) inputs are merged in rounds through
// temporary files, which shows when the inputs are not sorted.
function mergeAll(runs, cmp, unique, nmerge) {
  let files = runs.slice();
  while (nmerge < files.length) {
    const nfiles = files.length;
    let inp = 0, out = 0;
    for (; nmerge <= nfiles - inp; out++) { files[out] = mergeRuns(files.slice(inp, inp + nmerge), cmp, unique); inp += nmerge; }
    const remainder = nfiles - inp, cheap = nmerge - (out % nmerge);
    if (cheap < remainder) {
      const ns = remainder - cheap + 1;
      files[out++] = mergeRuns(files.slice(inp, inp + ns), cmp, unique);
      inp += ns;
    }
    files = files.slice(0, out).concat(files.slice(inp));
  }
  return mergeRuns(files, cmp, unique);
}

C.sort = (ctx) => {
  // options take effect as getopt returns them, so a bad argument is reported before a later
  // option error
  const a = getopt(ctx.argv.slice(1), {
    name: 'sort',
    short: 'bcCdfghik:mMno:rRsS:t:T:uVz',
    long: {
      'ignore-leading-blanks': 'b', check: ['c', 'optional'], 'dictionary-order': 'd', 'ignore-case': 'f', 'general-numeric-sort': 'g', 'human-numeric-sort': 'h',
      'ignore-nonprinting': 'i', key: ['k', 'required'], merge: 'm', 'month-sort': 'M', 'numeric-sort': 'n', output: ['o', 'required'], reverse: 'r', 'random-sort': 'R',
      stable: 's', 'batch-size': ['bs', 'required'], 'buffer-size': ['S', 'required'], 'field-separator': ['t', 'required'], 'temporary-directory': ['T', 'required'], unique: 'u', 'version-sort': 'V',
      'zero-terminated': 'z', sort: ['sort', 'required'], parallel: ['parallel', 'required'], debug: 'debug', 'random-source': ['rs', 'required'], 'files0-from': ['F', 'required'], 'compress-program': ['cp', 'required'],
    },
  });
  a.all = a.opts;
  const gkey = sortNewKey();
  const keys = [];
  let tab = null, unique = false, stable = false, check = false, quietCheck = false, outFile = null, zero = false, merge = false, nmerge = 16;
  // XARGMATCH(): an exact name or an unambiguous abbreviation, else usage(EXIT_FAILURE)
  const xargmatch = (opt, arg, names, vals) => {
    let found = -1, ambiguous = false;
    for (let i = 0; i < names.length; i++) {
      if (names[i] === arg) return vals[i];
      if (names[i].startsWith(arg)) { if (found < 0) found = i; else if (vals[found] !== vals[i]) ambiguous = true; }
    }
    if (found >= 0 && !ambiguous) return vals[found];
    let m = `sort: ${ambiguous ? 'ambiguous' : 'invalid'} argument ${quotearg(arg, 'locale')} for ${quotearg(opt, 'locale')}\nValid arguments are:`;
    names.forEach((n, i) => { m += i && vals[i] === vals[i - 1] ? `, ${quotearg(n, 'locale')}` : `\n  - ${quotearg(n, 'locale')}`; });
    ctx.stderr.write(m + "\nTry 'sort --help' for more information.\n");
    return null;
  };
  for (const [k, v] of a.all) {
    if ('bdfgiMhnRrV'.includes(k) && k.length === 1) sortSetOrdering(k, gkey, 'both');
    else if (k === 'k') { try { keys.push(sortParseKey(v)); } catch (e) { if (typeof e !== 'string') throw e; ctx.err(e); return 2; } }
    else if (k === 't') {
      let c = v[0];
      if (c === undefined) { ctx.err('empty tab'); return 2; }
      if (v.length > 1) { if (v === '\\0') c = '\0'; else { ctx.err(`multi-character tab ${quotearg(v, 'locale')}`); return 2; } }
      if (tab !== null && tab !== c) { ctx.err('incompatible tabs'); return 2; }
      tab = c;
    }
    else if (k === 'u') unique = true;
    else if (k === 's') stable = true;
    else if (k === 'm') merge = true;
    else if (k === 'c') {
      check = typeof v !== 'string' ? 'c' : xargmatch('--check', v, ['quiet', 'silent', 'diagnose-first'], ['C', 'C', 'c']);
      if (check === null) return 1;
      quietCheck = check === 'C';
    }
    else if (k === 'C') { check = 'C'; quietCheck = true; }
    else if (k === 'o') {
      if (outFile !== null && outFile !== v) { ctx.err('multiple output files specified'); return 2; }
      outFile = v;
    }
    else if (k === 'z') zero = true;
    else if (k === 'sort') {
      const c = xargmatch('--sort', v, ['general-numeric', 'human-numeric', 'month', 'numeric', 'random', 'version'], ['g', 'h', 'M', 'n', 'R', 'V']);
      if (c === null) return 1;
      sortSetOrdering(c, gkey, 'both');
    }
    else if (k === 'bs') {
      // specify_nmerge(); the limit is RLIMIT_NOFILE - 3 (524288 on the reference system)
      const MAXN = 524285n;
      const r = xstrtol(v, '', { max: UINTMAX_MAX, unsigned: true });
      let e = r.err;
      if (e === LONGINT_OK) {
        if (r.val > 4294967295n || r.val > MAXN) e = LONGINT_OVERFLOW;
        else if (r.val < 2n) { ctx.err(`invalid --batch-size argument ${quotearg(v, 'locale')}`); ctx.err("minimum --batch-size argument is '2'"); return 2; }
        else nmerge = Number(r.val);
      }
      if (e === LONGINT_OVERFLOW) { ctx.err(`--batch-size argument ${quotearg(v, 'locale')} too large`); ctx.err(`maximum --batch-size argument with current rlimit is ${MAXN}`); return 2; }
      if (e !== LONGINT_OK) { ctx.err(`invalid ${e & LONGINT_INVALID_SUFFIX_CHAR ? 'suffix in ' : ''}--batch-size argument '${v}'`); return 2; }
    }
  }
  if (a.error) { ctx.stderr.write(a.error + "\nTry 'sort --help' for more information.\n"); return 2; }
  // a key without ordering options of its own takes the global ones; with no -k at all, the
  // global options make one key of the whole line
  for (const key of keys) {
    if (sortDefaultKey(key) && !key.reverse) {
      for (const f of ['ignore', 'translate', 'skipsblanks', 'skipeblanks', 'month', 'numeric', 'general', 'human', 'version', 'random', 'reverse']) key[f] = gkey[f];
    }
  }
  if (!keys.length && !sortDefaultKey(gkey)) keys.push(gkey);
  // check_ordering_compatibility()
  for (const key of keys) {
    if (key.numeric + key.general + key.human + key.month + (key.version || key.random || !!key.ignore) > 1) {
      const opts = (key.ignore === 'd' ? 'd' : '') + (key.translate ? 'f' : '') + (key.general ? 'g' : '') + (key.human ? 'h' : '') + (key.ignore === 'i' ? 'i' : '')
        + (key.month ? 'M' : '') + (key.numeric ? 'n' : '') + (key.random ? 'R' : '') + (key.version ? 'V' : '');
      ctx.err(`options '-${opts}' are incompatible`);
      return 2;
    }
  }
  const reverse = gkey.reverse;
  const sep = zero ? '\0' : '\n';
  let lines = [];
  const files = a.operands.length ? a.operands : ['-'];
  if (check) {
    if (files.length > 1) { ctx.err(`extra operand ${qa(files[1])} not allowed with -${check}`); return 2; }
    if (outFile !== null) { ctx.err(`options '-${check}o' are incompatible`); return 2; }
  } else {
    // check_inputs(): every input must be readable before anything happens; check_output():
    // the output file is created (not yet truncated) next
    for (const f of files) {
      if (f === '-' || /^\/dev\/(stdin|fd\/\d+)$/.test(f)) continue;
      try { ctx.fs.stat(f, ctx.cwd); } catch (e) { if (e instanceof FsError) { ctx.err(`cannot read: ${qf(f)}: ${e.message}`); return 2; } throw e; }
    }
    if (outFile !== null) {
      try { ctx.openWrite(outFile, true); } catch (e) { if (e instanceof FsError) { ctx.err(`open failed: ${qf(outFile)}: ${e.message}`); return 2; } throw e; }
    }
  }
  const runs = [];
  for (const f of files) {
    let data;
    try { data = ctx.readFile(f); }
    catch (e) {
      // (unreadable inputs were reported by check_inputs() already, except with -c/-C)
      if (e instanceof FsError) { ctx.err(e.code === 'EISDIR' ? `read failed: ${qf(f)}: Is a directory` : `open failed: ${qf(f)}: ${e.message}`); return 2; }
      throw e;
    }
    const ls = splitLines(data, sep);
    runs.push(ls);
    for (const l of ls) lines.push(l);
  }
  const cmp = makeComparator({ keys, tab, stable, unique, reverse, seed: ctx.sh.random() });
  if (check) {
    for (let i = 1; i < lines.length; i++) {
      const r = cmp(lines[i - 1], lines[i]);
      if (r > 0 || (unique && r === 0)) {
        if (!quietCheck) ctx.stderr.write(`sort: ${files[0] === '-' ? '-' : files[0]}:${i + 1}: disorder: ${lines[i]}\n`);
        return 1;
      }
    }
    return 0;
  }
  if (merge) lines = mergeAll(runs, cmp, unique, nmerge);
  else {
    // stable sort with index tiebreak (JS sort is stable)
    lines.sort(cmp);
    if (unique) {
      const out = [];
      for (const l of lines) if (!out.length || cmp(out[out.length - 1], l) !== 0) out.push(l);
      lines = out;
    }
  }
  const text = lines.length ? lines.join(sep) + sep : '';
  if (outFile) {
    try { const s = ctx.openWrite(outFile, false); s.write(text); }
    catch (e) { if (e instanceof FsError) { ctx.err(`open failed: ${qf(outFile)}: ${e.message}`); return 2; } throw e; }
    return 0;
  }
  ctx.out(text);
  return 0;
};

// ---------------------------------------------------------------- uniq
C.uniq = (ctx) => {
  const a = parseArgs(ctx, { short: 'cdDf:is:uw:z', long: { count: 'c', repeated: 'd', 'all-repeated': ['D', 'optional'], 'skip-fields': ['f', 'required'], 'ignore-case': 'i', 'skip-chars': ['s', 'required'], unique: 'u', 'check-chars': ['w', 'required'], 'zero-terminated': 'z', group: ['group', 'optional'] } });
  if (!a) return 1;
  const count = a.has('c'), dup = a.has('d'), allDup = a.has('D'), uniqOnly = a.has('u'), icase = a.has('i');
  const skipF = a.has('f') ? parseInt(a.get('f'), 10) : 0, skipC = a.has('s') ? parseInt(a.get('s'), 10) : 0, checkC = a.has('w') ? parseInt(a.get('w'), 10) : null;
  const group = a.has('group') ? (a.get('group') || 'separate') : null;
  const zero = a.has('z');
  const sep = zero ? '\0' : '\n';
  if (count && (allDup || group)) { ctx.err('printing all duplicated lines and repeat counts is meaningless'); ctx.stderr.write("Try 'uniq --help' for more information.\n"); return 1; }
  const [inF, outF] = a.operands;
  let data;
  try { data = ctx.readFile(inF || '-'); } catch (e) { if (e instanceof FsError) { ctx.err(readErrMsg(ctx, inF, e)); return 1; } throw e; }
  const lines = splitLines(data, sep);
  const keyOf = (l) => {
    let i = 0;
    for (let f = 0; f < skipF; f++) { while (i < l.length && isBlank(l[i])) i++; while (i < l.length && !isBlank(l[i])) i++; }
    i += skipC;
    let k = l.slice(i);
    if (checkC !== null) k = k.slice(0, checkC);
    return icase ? k.toUpperCase() : k;
  };
  let out = '';
  let i = 0;
  let firstGroup = true;
  while (i < lines.length) {
    let j = i + 1;
    const k = keyOf(lines[i]);
    while (j < lines.length && keyOf(lines[j]) === k) j++;
    const n = j - i;
    if (group) {
      if ((group === 'prepend' || group === 'both') || (!firstGroup && (group === 'separate' || group === 'append'))) out += sep;
      for (let q = i; q < j; q++) out += lines[q] + sep;
      firstGroup = false;
    } else if (allDup) {
      if (n > 1) {
        const method = a.get('D') || 'none';
        if (!firstGroup && method === 'separate') out += sep;
        if (method === 'prepend') out += sep;
        for (let q = i; q < j; q++) out += lines[q] + sep;
        firstGroup = false;
      }
    } else if ((!dup && !uniqOnly) || (dup && n > 1 && !uniqOnly) || (uniqOnly && n === 1 && !dup)) {
      out += (count ? String(n).padStart(7) + ' ' : '') + lines[i] + sep;
    }
    i = j;
  }
  if (group === 'append' || group === 'both') if (lines.length) out += sep;
  if (outF) { try { ctx.openWrite(outF).write(out); } catch (e) { ctx.err(`${qf(outF)}: ${e.message}`); return 1; } }
  else ctx.out(out);
  return 0;
};

// ---------------------------------------------------------------- cut
// coreutils set_fields(): returns merged [lo, hi] ranges or { error } with cut's exact wording.
function parseList(str, usePos = false) {
  const ranges = [];
  let initial = 1, value = 0, lhs = false, rhs = false, dash = false, inDigits = false, numStart = 0;
  const numbered = usePos ? 'byte/character positions are numbered from 1' : 'fields are numbered from 1';
  for (let i = 0; ; ) {
    const c = str[i];
    if (c === '-') {
      inDigits = false;
      if (dash) return { error: usePos ? 'invalid byte or character range' : 'invalid field range' };
      dash = true; i++;
      if (lhs && !value) return { error: numbered };
      initial = lhs ? value : 1;
      value = 0;
    } else if (c === ',' || c === ' ' || c === '\t' || c === undefined) {
      inDigits = false;
      if (dash) {
        dash = false;
        if (!lhs && !rhs) return { error: 'invalid range with no endpoint: -' };
        if (!rhs) ranges.push([initial, Infinity]);
        else { if (value < initial) return { error: 'invalid decreasing range' }; ranges.push([initial, value]); }
        value = 0;
      } else {
        if (value === 0) return { error: numbered };
        ranges.push([value, value]);
        value = 0;
      }
      if (c === undefined) break;
      i++; lhs = false; rhs = false;
    } else if (c >= '0' && c <= '9') {
      if (!inDigits) numStart = i;
      inDigits = true;
      if (dash) rhs = true; else lhs = true;
      value = value * 10 + (c.charCodeAt(0) - 48);
      if (value >= Number.MAX_SAFE_INTEGER) {
        const bad = /^\d*/.exec(str.slice(numStart))[0];
        return { error: usePos ? `byte/character offset '${bad}' is too large` : `field number '${bad}' is too large` };
      }
      i++;
    } else {
      return { error: usePos ? `invalid byte/character position '${str.slice(i)}'` : `invalid field value '${str.slice(i)}'` };
    }
  }
  if (!ranges.length) return { error: usePos ? 'missing list of byte/character positions' : 'missing list of fields' };
  ranges.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of ranges) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else merged.push([...r]); }
  return merged;
}

C.cut = (ctx) => {
  const a = parseArgs(ctx, { short: 'b:c:d:f:nsz', long: { bytes: ['b', 'required'], characters: ['c', 'required'], delimiter: ['d', 'required'], fields: ['f', 'required'], 'only-delimited': 's', complement: 'complement', 'output-delimiter': ['O', 'required'], 'zero-terminated': 'z' } });
  if (!a) return 1;
  const fatal = (msg) => { ctx.err(msg); ctx.stderr.write("Try 'cut --help' for more information.\n"); return 1; };
  // options are checked as getopt hands them over, the rest once they are all in
  let mode = null, spec = null, delimSpecified = false, delim = '\t';
  for (const [k, v] of a.all) {
    if (k === 'b' || k === 'c' || k === 'f') {
      if (mode !== null) return fatal('only one type of list may be specified');
      mode = k === 'f' ? 'f' : k;
      spec = v;
    } else if (k === 'd') {
      if (v.length > 1) return fatal('the delimiter must be a single character');
      delim = v === '' ? '\0' : v;
      delimSpecified = true;
    }
  }
  if (mode === null) return fatal('you must specify a list of bytes, characters, or fields');
  if (delimSpecified && mode !== 'f') return fatal('an input delimiter may be specified only when operating on fields');
  if (a.has('s') && mode !== 'f') return fatal('suppressing non-delimited lines makes sense\n\tonly when operating on fields');
  const list = parseList(spec, mode !== 'f');
  if (list.error) return fatal(list.error);
  const complement = a.has('complement');
  const onlyDelim = a.has('s');
  const outDelim = a.has('O') ? a.get('O') : null;
  const sep = a.has('z') ? '\0' : '\n';
  const inList = (n) => { const r = list.some(([lo, hi]) => n >= lo && n <= hi); return complement ? !r : r; };
  if (mode === 'f' && delim === sep) {
    // the delimiter is the line terminator: the whole input is a single record
    return eachInput(ctx, a.operands, (data) => {
      const body = data.endsWith(sep) ? data.slice(0, -1) : data;
      const fields = body.split(delim);
      const sel = fields.filter((_, i) => inList(i + 1));
      ctx.out(sel.join(outDelim ?? delim) + sep);
      return 0;
    });
  }
  return eachInput(ctx, a.operands, (data) => {
    let out = '';
    let pos = 0;
    while (pos < data.length) {
      let j = data.indexOf(sep, pos);
      const hasSep = j >= 0;
      if (!hasSep) j = data.length;
      const line = data.slice(pos, j);
      pos = hasSep ? j + 1 : j;
      if (mode === 'f') {
        if (!line.includes(delim)) { if (!onlyDelim) out += line + sep; continue; }
        const fields = line.split(delim);
        const sel = [];
        for (let i = 0; i < fields.length; i++) if (inList(i + 1)) sel.push(fields[i]);
        out += sel.join(outDelim ?? delim) + sep;
      } else {
        let s = '';
        let prevIn = false, first = true;
        for (let i = 0; i < line.length; i++) {
          if (inList(i + 1)) {
            if (outDelim !== null && !prevIn && !first) s += outDelim;
            s += line[i];
            prevIn = true; first = false;
          } else prevIn = false;
        }
        out += s + sep;
      }
    }
    ctx.out(out);
    return 0;
  });
};

// ---------------------------------------------------------------- paste
function pasteDelims(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const d = s[++i];
      out.push(d === 'n' ? '\n' : d === 't' ? '\t' : d === '0' ? '' : d === '\\' ? '\\' : d === 'b' ? '\b' : d === 'f' ? '\f' : d === 'r' ? '\r' : d === 'v' ? '\v' : d);
    } else out.push(s[i]);
  }
  return out;
}

C.paste = (ctx) => {
  const a = parseArgs(ctx, { short: 'd:sz', long: { delimiters: ['d', 'required'], serial: 's', 'zero-terminated': 'z' } });
  if (!a) return 1;
  const delims = a.has('d') ? pasteDelims(a.get('d')) : ['\t'];
  if (a.has('d') && delims.length === 0) delims.push('');
  const sep = a.has('z') ? '\0' : '\n';
  const files = a.operands.length ? a.operands : ['-'];
  const contents = [];
  let st = 0;
  // multiple '-' share stdin line by line
  let stdinLines = null, stdinPos = 0;
  for (const f of files) {
    if (f === '-') { if (!stdinLines) stdinLines = splitLines(ctx.stdin.readAll(), sep); contents.push({ stdin: true }); continue; }
    try { contents.push({ lines: splitLines(ctx.readFile(f), sep) }); }
    catch (e) { if (e instanceof FsError) { ctx.err(`${qf(f)}: ${e.message}`); return 1; } throw e; }
  }
  let out = '';
  if (a.has('s')) {
    for (const c of contents) {
      const lines = c.stdin ? stdinLines.slice(stdinPos) : c.lines;
      if (c.stdin) stdinPos = stdinLines.length;
      let s = '';
      lines.forEach((l, i) => { if (i > 0) s += delims[(i - 1) % delims.length]; s += l; });
      out += s + sep;
    }
    ctx.out(out);
    return st;
  }
  const idx = contents.map(() => 0);
  for (;;) {
    let any = false;
    const row = [];
    for (let k = 0; k < contents.length; k++) {
      const c = contents[k];
      if (c.stdin) { if (stdinPos < stdinLines.length) { row.push(stdinLines[stdinPos++]); any = true; } else row.push(null); }
      else if (idx[k] < c.lines.length) { row.push(c.lines[idx[k]++]); any = true; }
      else row.push(null);
    }
    if (!any) break;
    let s = '';
    row.forEach((v, k) => { if (k > 0) s += delims[(k - 1) % delims.length]; s += v ?? ''; });
    out += s + sep;
  }
  ctx.out(out);
  return st;
};

// ---------------------------------------------------------------- tr
// tr (coreutils 8.32 tr.c): spec lists of chars, ranges, [:class:], [=c=] and [c*n]
const TR_CLASS = {
  alnum: (b) => (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122),
  alpha: (b) => (b >= 65 && b <= 90) || (b >= 97 && b <= 122),
  blank: (b) => b === 32 || b === 9,
  cntrl: (b) => b < 32 || b === 127,
  digit: (b) => b >= 48 && b <= 57,
  graph: (b) => b >= 33 && b <= 126,
  lower: (b) => b >= 97 && b <= 122,
  print: (b) => b >= 32 && b <= 126,
  punct: (b) => (b >= 33 && b <= 47) || (b >= 58 && b <= 64) || (b >= 91 && b <= 96) || (b >= 123 && b <= 126),
  space: (b) => b === 32 || (b >= 9 && b <= 13),
  upper: (b) => b >= 65 && b <= 90,
  xdigit: (b) => (b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102),
};
class TrExit { constructor(st) { this.st = st; } }
const trPrintable = (codes) => codes.map(c => ({ 92: '\\', 7: '\\a', 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t', 11: '\\v' }[c] ?? (c >= 32 && c < 127 ? String.fromCharCode(c) : '\\' + c.toString(8).padStart(3, '0')))).join('');

C.tr = (ctx) => {
  const die = (msg) => { ctx.err(msg); throw new TrExit(1); };
  const usage = () => { ctx.stderr.write("Try 'tr --help' for more information.\n"); throw new TrExit(1); };
  try {
    const r = getopt(ctx.argv.slice(1), { name: 'tr', short: 'AcCdst', long: { complement: 'c', delete: 'd', 'squeeze-repeats': 's', 'truncate-set1': 't', help: 'help', version: 'version' } }, { permute: false });
    let complement = false, del = false, squeeze = false, truncate = false;
    for (const [k] of r.opts) {
      if (k === 'c' || k === 'C') complement = true;
      else if (k === 'd') del = true;
      else if (k === 's') squeeze = true;
      else if (k === 't') truncate = true;
    }
    if (r.error) { ctx.stderr.write(r.error + '\n'); usage(); }
    const ops = r.operands;
    const n = ops.length;
    const translating = n === 2 && !del;
    const minOps = 1 + (del === squeeze ? 1 : 0), maxOps = 1 + (del <= squeeze ? 1 : 0);
    const q = (x) => quotearg(x, 'locale');
    if (n < minOps) {
      if (n === 0) ctx.err('missing operand');
      else {
        ctx.err(`missing operand after ${q(ops[n - 1])}`);
        ctx.stderr.write((squeeze ? 'Two strings must be given when both deleting and squeezing repeats.' : 'Two strings must be given when translating.') + '\n');
      }
      usage();
    }
    if (maxOps < n) {
      ctx.err(`extra operand ${q(ops[maxOps])}`);
      if (n === 2) ctx.stderr.write('Only one string may be given when deleting without squeezing repeats.\n');
      usage();
    }
    // unquote: the escapes, remembering which characters were escaped
    const unquote = (str) => {
      const cs = [], esc = [];
      for (let i = 0; i < str.length; i++) {
        if (str[i] !== '\\') { cs.push(str.charCodeAt(i)); esc.push(false); continue; }
        let c, e = true;
        const d = str[i + 1];
        if (d === undefined) {
          ctx.err('warning: an unescaped backslash at end of string is not portable');
          cs.push(92); esc.push(false);
          continue;
        }
        const simple = { '\\': 92, a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 }[d];
        if (simple !== undefined) c = simple;
        else if (d >= '0' && d <= '7') {
          c = d.charCodeAt(0) - 48;
          let o = (str[i + 2] || '').charCodeAt(0) - 48;
          if (o >= 0 && o <= 7) {
            c = 8 * c + o; i++;
            o = (str[i + 2] || '').charCodeAt(0) - 48;
            if (o >= 0 && o <= 7) {
              if (8 * c + o < 256) { c = 8 * c + o; i++; }
              else ctx.err(`warning: the ambiguous octal escape \\${str[i]}${str[i + 1]}${str[i + 2]} is being\n\tinterpreted as the 2-byte sequence \\0${str[i]}${str[i + 1]}, ${str[i + 2]}`);
            }
          }
        } else c = d.charCodeAt(0);
        i++;
        cs.push(c & 255); esc.push(e);
      }
      return { s: cs, esc };
    };
    const buildSpecList = (es) => {
      const list = [];
      const p = es.s, len = p.length;
      const match = (i, ch) => i < len && p[i] === ch.charCodeAt(0) && !es.esc[i];
      const starDigitsClose = (idx) => {
        if (!match(idx, '*')) return false;
        for (let i = idx + 1; i < len; i++) if (!(p[i] >= 48 && p[i] <= 57) || es.esc[i]) return match(i, ']');
        return false;
      };
      const bracketedRepeat = (start) => {
        if (!match(start + 1, '*')) return null;
        for (let i = start + 2; i < len && !es.esc[i]; i++) {
          if (p[i] === 93) {
            const digits = p.slice(start + 2, i).map(c => String.fromCharCode(c)).join('');
            let count = 0;
            if (digits.length) {
              const ok = /^[0-9]+$/.test(digits) && (digits[0] !== '0' || /^[0-7]+$/.test(digits));
              const v = ok ? BigInt((digits[0] === '0' ? '0o' : '') + digits) : null;
              if (!ok || v > 4294967295n) die(`invalid repeat count ${q(trPrintable(p.slice(start + 2, i)))} in [c*n] construct`);
              count = Number(v);
            }
            return { c: p[start], count, close: i };
          }
        }
        return null;
      };
      let i = 0;
      while (i + 2 < len) {
        if (match(i, '[')) {
          let tryRepeat = true;
          if (match(i + 1, ':') || match(i + 1, '=')) {
            const delim = p[i + 1];
            let close = -1;
            for (let k = i + 2; k < len - 1; k++) if (p[k] === delim && p[k + 1] === 93 && !es.esc[k] && !es.esc[k + 1]) { close = k; break; }
            if (close >= 0) {
              const opnd = p.slice(i + 2, close);
              if (!opnd.length) die(delim === 58 ? "missing character class name '[::]'" : "missing equivalence class character '[==]'");
              const name = opnd.map(c => String.fromCharCode(c)).join('');
              if (delim === 58) {
                if (Object.prototype.hasOwnProperty.call(TR_CLASS, name)) { list.push({ t: 'class', name }); i = close + 2; continue; }
                if (!starDigitsClose(i + 2)) die(`invalid character class ${q(trPrintable(opnd))}`);
              } else {
                if (opnd.length === 1) { list.push({ t: 'equiv', c: opnd[0] }); i = close + 2; continue; }
                if (!starDigitsClose(i + 2)) die(`${trPrintable(opnd)}: equivalence class operand must be a single character`);
              }
            }
          }
          if (tryRepeat) {
            const rep = bracketedRepeat(i + 1);
            if (rep) { list.push({ t: 'repeat', c: rep.c, count: rep.count }); i = rep.close + 1; continue; }
          }
        }
        if (match(i + 1, '-')) {
          if (p[i + 2] < p[i]) die(`range-endpoints of '${trPrintable([p[i]])}-${trPrintable([p[i + 2]])}' are in reverse collating sequence order`);
          list.push({ t: 'range', first: p[i], last: p[i + 2] });
          i += 3;
        } else { list.push({ t: 'char', c: p[i] }); i++; }
      }
      for (; i < len; i++) list.push({ t: 'char', c: p[i] });
      return list;
    };
    // expansion of a spec list: [{ c, cls, first }] (cls: 'upper'/'lower' for those classes)
    const expand = (list) => {
      const out = [];
      list.forEach((e, ei) => {
        if (e.t === 'char' || e.t === 'equiv') out.push({ c: e.c, el: ei });
        else if (e.t === 'range') for (let c = e.first; c <= e.last; c++) out.push({ c, el: ei });
        else if (e.t === 'class') { const f = TR_CLASS[e.name]; for (let c = 0; c < 256; c++) if (f(c)) out.push({ c, el: ei, cls: e.name === 'upper' || e.name === 'lower' ? e.name : null }); }
        else for (let k = 0; k < e.count; k++) out.push({ c: e.c, el: ei });
      });
      return out;
    };
    const stats = (list) => {
      let length = 0, indef = 0, hasEquiv = false, hasRestricted = false, hasClass = false, indefEl = null;
      for (const e of list) {
        if (e.t === 'char') length += 1;
        else if (e.t === 'range') length += e.last - e.first + 1;
        else if (e.t === 'class') { hasClass = true; for (let c = 0; c < 256; c++) if (TR_CLASS[e.name](c)) length++; if (e.name !== 'upper' && e.name !== 'lower') hasRestricted = true; }
        else if (e.t === 'equiv') { length += 1; hasEquiv = true; }
        else if (e.count > 0) length += e.count;
        else { indef++; indefEl = e; }
        if (length > 4294967295) die('too many characters in set');
      }
      return { length, indef, hasEquiv, hasRestricted, hasClass, indefEl };
    };
    const s1 = buildSpecList(unquote(ops[0]));
    const s2 = n === 2 ? buildSpecList(unquote(ops[1])) : null;
    // validate
    const st1 = stats(s1);
    if (complement) { const seen = new Set(expand(s1).map(x => x.c)); st1.length = 256 - seen.size; }
    if (st1.indef > 0) die('the [c*] repeat construct may not appear in string1');
    if (s2) {
      const st2 = stats(s2);
      if (st1.length >= st2.length && st2.indef === 1) { st2.indefEl.count = st1.length - st2.length; st2.length = st1.length; }
      if (st2.indef > 1) die('only one [c*] repeat construct may appear in string2');
      if (translating) {
        if (st2.hasEquiv) die('[=c=] expressions may not appear in string2 when translating');
        if (st2.hasRestricted) die("when translating, the only character classes that may appear in\nstring2 are 'upper' and 'lower'");
        // validate_case_classes
        if (st2.hasClass) {
          const e1 = expand(s1), e2 = expand(s2);
          let i1 = 0, i2 = 0, new1 = true, new2 = true;
          while (i1 <= e1.length && i2 <= e2.length) {
            const a1 = e1[i1], a2 = e2[i2];
            const c1 = a1 ? a1.cls : null, c2 = a2 ? a2.cls : null;
            if (new2 && c2 && !(new1 && c1)) die('misaligned [:upper:] and/or [:lower:] construct');
            if (!a1 || !a2) break;
            if (c2) {
              // skip both constructs; their lengths count as one character
              const el1 = a1.el, el2 = a2.el;
              const n1 = e1.filter(x => x.el === el1).length, n2 = e2.filter(x => x.el === el2).length;
              while (i1 < e1.length && e1[i1].el === el1) i1++;
              while (i2 < e2.length && e2[i2].el === el2) i2++;
              st1.length -= (c1 === 'upper' ? 26 : 26) - 1; st2.length -= 26 - 1;
              void n1; void n2;
              new1 = true; new2 = true;
            } else {
              i1++; i2++;
              new1 = !e1[i1] || e1[i1].el !== a1.el;
              new2 = !e2[i2] || e2[i2].el !== a2.el;
            }
          }
        }
        if (st1.length > st2.length && !truncate) {
          if (st2.length === 0) die('when not truncating set1, string2 must be non-empty');
          const last = s2[s2.length - 1];
          if (last.t === 'class') die('when translating with string1 longer than string2,\nthe latter string must not end with a character class');
          const ch = last.t === 'char' ? last.c : last.t === 'range' ? last.last : last.c;
          s2.push({ t: 'repeat', c: ch, count: st1.length - st2.length });
          st2.length = st1.length;
        }
        if (complement && st1.hasClass) {
          const e2 = expand(s2);
          if (!(st2.length === st1.length && e2.length && e2.every(x => x.c === e2[0].c))) die('when translating with complemented character classes,\nstring2 must map all characters in the domain to one');
        }
      } else if (st2.indef > 0) die('the [c*] construct may appear in string2 only when translating');
    }
    const setOf = (list, comp) => {
      const set = new Uint8Array(256);
      for (const x of expand(list)) set[x.c] = 1;
      if (comp) for (let c = 0; c < 256; c++) set[c] ^= 1;
      return set;
    };
    const data = ctx.stdin.readAll();
    const squeezeOut = (str, sq) => {
      let out = '', last = -1;
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (sq[c] && c === last) continue;
        out += str[i];
        last = c;
      }
      return out;
    };
    let out;
    if (squeeze && n === 1) out = squeezeOut(data, setOf(s1, complement));
    else if (del && n === 1) {
      const d = setOf(s1, complement);
      out = '';
      for (let i = 0; i < data.length; i++) if (!d[data.charCodeAt(i)]) out += data[i];
    } else if (squeeze && del && n === 2) {
      const d = setOf(s1, complement);
      let kept = '';
      for (let i = 0; i < data.length; i++) if (!d[data.charCodeAt(i)]) kept += data[i];
      out = squeezeOut(kept, setOf(s2, false));
    } else {
      const xlate = new Array(256);
      for (let c = 0; c < 256; c++) xlate[c] = c;
      if (complement) {
        const in1 = setOf(s1, false);
        const e2 = expand(s2);
        let k = 0;
        for (let c = 0; c < 256; c++) {
          if (in1[c]) continue;
          if (k >= e2.length) break;
          xlate[c] = e2[k++].c;
        }
      } else {
        const e1 = expand(s1), e2 = expand(s2);
        let i1 = 0, i2 = 0;
        for (;;) {
          const a1 = e1[i1], a2 = e2[i2];
          const c1 = a1 ? a1.cls : null, c2 = a2 ? a2.cls : null;
          if (c1 === 'lower' && c2 === 'upper') { for (let c = 97; c <= 122; c++) xlate[c] = c - 32; }
          else if (c1 === 'upper' && c2 === 'lower') { for (let c = 65; c <= 90; c++) xlate[c] = c + 32; }
          else {
            if (!a1 || !a2) break;
            xlate[a1.c] = a2.c;
          }
          if (c2) {
            const el1 = a1.el, el2 = a2.el;
            while (i1 < e1.length && e1[i1].el === el1) i1++;
            while (i2 < e2.length && e2[i2].el === el2) i2++;
          } else { i1++; i2++; }
        }
      }
      out = '';
      for (let i = 0; i < data.length; i++) out += String.fromCharCode(xlate[data.charCodeAt(i)]);
      if (squeeze) out = squeezeOut(out, setOf(s2, false));
    }
    ctx.out(out);
    return 0;
  } catch (e) {
    if (e instanceof TrExit) return e.st;
    throw e;
  }
};

// ---------------------------------------------------------------- nl
C.nl = (ctx) => {
  const a = parseArgs(ctx, { short: 'b:d:f:h:i:l:n:ps:v:w:', long: { 'body-numbering': ['b', 'required'], 'section-delimiter': ['d', 'required'], 'footer-numbering': ['f', 'required'], 'header-numbering': ['h', 'required'], 'line-increment': ['i', 'required'], 'join-blank-lines': ['l', 'required'], 'number-format': ['n', 'required'], 'no-renumber': 'p', 'number-separator': ['s', 'required'], 'starting-line-number': ['v', 'required'], 'number-width': ['w', 'required'] } });
  if (!a) return 1;
  const style = a.get('b') || 't';
  const fmt = a.get('n') || 'rn';
  const width = a.has('w') ? parseInt(a.get('w'), 10) : 6;
  const sep = a.has('s') ? a.get('s') : '\t';
  let num = a.has('v') ? parseInt(a.get('v'), 10) : 1;
  const inc = a.has('i') ? parseInt(a.get('i'), 10) : 1;
  let re = null;
  if (style.startsWith('p')) { try { re = new RegExp(style.slice(1)); } catch { re = null; } }
  return eachInput(ctx, a.operands, (data) => {
    let out = '';
    for (const line of splitLines(data)) {
      let numbered;
      if (style === 'a') numbered = true;
      else if (style === 'n') numbered = false;
      else if (style === 't') numbered = line !== '';
      else numbered = re ? re.test(line) : false;
      if (numbered) {
        let n = String(num);
        if (fmt === 'ln') n = n.padEnd(width);
        else if (fmt === 'rz') n = (num < 0 ? '-' + String(-num).padStart(width - 1, '0') : n.padStart(width, '0'));
        else n = n.padStart(width);
        out += n + sep + line + '\n';
        num += inc;
      } else out += ' '.repeat(width + sep.length) + line + '\n';
    }
    ctx.out(out.replace(/[ \t]+\n/g, (m) => m));
    return 0;
  });
};

// ---------------------------------------------------------------- seq
// GNU seq (coreutils 8.32, seq.c). Integer runs take seq_fast's exact string arithmetic; anything
// else is computed in x86-64 long double (ldouble.js) exactly as seq does, which decides both the
// digits printed and where a sequence like 0 0.1 1 stops.
const SEQ_FAST_STEP_LIMIT = 200;
const SEQ_VERSION = `seq (GNU coreutils) 8.32
Copyright (C) 2020 Free Software Foundation, Inc.
License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.

Written by Ulrich Drepper.
`;
class SeqExit { constructor(code) { this.code = code; } }
C.seq = (ctx) => {
  try { return seqMain(ctx); } catch (e) { if (e instanceof SeqExit) return e.code; throw e; }
};
function seqMain(ctx) {
  const argv = ctx.argv, ql = (s) => quotearg(s, 'locale');
  const usage = () => { ctx.stderr.write("Try 'seq --help' for more information.\n"); return new SeqExit(1); };
  let fmt = null, sep = '\n', equalWidth = false;
  let i = 1;
  // getopt_long "+f:s:w", stopping first at anything that looks like a negative number
  while (i < argv.length) {
    const a = argv[i];
    if (a[0] === '-' && (a[1] === '.' || /[0-9]/.test(a[1] || ''))) break;
    if (a === '--') { i++; break; }
    if (a[0] !== '-' || a === '-') break;
    if (a.startsWith('--')) {
      const eq = a.indexOf('='), name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const longs = ['equal-width', 'format', 'separator', 'help', 'version'];
      const cands = longs.includes(name) ? [name] : longs.filter((l) => l.startsWith(name));
      if (!cands.length) { ctx.err(`unrecognized option '${a}'`); throw usage(); }
      if (cands.length > 1) { ctx.err(`option '${a}' is ambiguous; possibilities:${cands.map((c) => ` '--${c}'`).join('')}`); throw usage(); }
      const opt = cands[0];
      if (opt === 'format' || opt === 'separator') {
        let v;
        if (eq >= 0) v = a.slice(eq + 1);
        else if (i + 1 < argv.length) v = argv[++i];
        else { ctx.err(`option '--${opt}' requires an argument`); throw usage(); }
        if (opt === 'format') fmt = v; else sep = v;
      } else if (eq >= 0) { ctx.err(`option '--${opt}' doesn't allow an argument`); throw usage(); }
      else if (opt === 'equal-width') equalWidth = true;
      else if (opt === 'version') { ctx.out(SEQ_VERSION); return 0; }
      else { const t = helpText('seq'); ctx.out(t ?? ''); return 0; }
      i++;
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const c = a[k];
      if (c === 'w') { equalWidth = true; continue; }
      if (c === 'f' || c === 's') {
        let v;
        if (k + 1 < a.length) v = a.slice(k + 1);
        else if (i + 1 < argv.length) v = argv[++i];
        else { ctx.err(`option requires an argument -- '${c}'`); throw usage(); }
        if (c === 'f') fmt = v; else sep = v;
        break;
      }
      ctx.err(`invalid option -- '${c}'`);
      throw usage();
    }
    i++;
  }
  const args = argv.slice(i);
  if (args.length < 1) { ctx.err('missing operand'); throw usage(); }
  if (args.length > 3) { ctx.err(`extra operand ${ql(args[3])}`); throw usage(); }

  // long_double_format(): exactly one float directive; %% elsewhere
  let layout = { prefix: 0, suffix: 0 }, out = null;
  if (fmt !== null) {
    const die = (m) => { ctx.err(m); return new SeqExit(1); };
    let j = 0;
    for (; !(fmt[j] === '%' && fmt[j + 1] !== '%'); j += (fmt[j] === '%') + 1) {
      if (j >= fmt.length) throw die(`format ${ql(fmt)} has no % directive`);
      layout.prefix++;
    }
    const at = j;
    j++;
    const span = (set) => { const k0 = j; while (j < fmt.length && set.includes(fmt[j])) j++; return fmt.slice(k0, j); };
    const flags = span("-+#0 '"), width = span('0123456789');
    let prec;
    if (fmt[j] === '.') { j++; prec = span('0123456789'); }
    if (fmt[j] === 'L') j++;
    if (j >= fmt.length) throw die(`format ${ql(fmt)} ends in %`);
    if (!'efgaEFGA'.includes(fmt[j])) throw die(`format ${ql(fmt)} has unknown %${fmt[j]} directive`);
    const spec = { flags, width: width ? parseInt(width, 10) : undefined, prec: prec === undefined ? undefined : prec ? parseInt(prec, 10) : 0, conv: fmt[j] };
    const tail = j + 1;
    for (j = tail; ; j += (fmt[j] === '%') + 1) {
      if (fmt[j] === '%' && fmt[j + 1] !== '%') throw die(`format ${ql(fmt)} has too many % directives`);
      else if (j < fmt.length) layout.suffix++;
      else break;
    }
    const pre = fmt.slice(0, at).replace(/%%/g, '%'), suf = fmt.slice(tail).replace(/%%/g, '%');
    out = (x) => pre + formatOne(spec, x) + suf;
  }
  if (fmt !== null && equalWidth) { ctx.err('format string may not be specified when printing equal width strings'); throw usage(); }

  const ONE = ldFromInt(1n), ZERO = ldFromInt(0n), LIMIT = ldFromInt(BigInt(SEQ_FAST_STEP_LIMIT));
  const isZero = (v) => v.kind === 'num' && v.m === 0n;
  // xstrtold(): the whole string converts, and no overflow (underflow to zero is fine)
  const xstrtold = (s) => { const r = strtold(s); return r.end > 0 && r.end === s.length && !(r.v.range && !isZero(r.v)) ? r.v : null; };
  const allDigits = (s) => /^[0-9]+$/.test(s);
  // seq_fast(): A..B (digit strings, B maybe "inf") by an integer STEP; false when B < A
  const seqFast = (a, b, step) => {
    const inf = b === 'inf';
    let p = BigInt(a);
    const q = inf ? 0n : BigInt(b), st = BigInt(step);
    if (!inf && p > q) return false;
    let buf = p.toString(), n = 0;
    for (;;) {
      p += st;
      if (!inf && p > q) break;
      buf += sep[0] + p.toString();
      if (buf.length > 65536) { ctx.out(buf); buf = ''; }
      if ((++n & 1023) === 0) ctx.tick();
    }
    ctx.out(buf + '\n');
    return true;
  };

  let stepVal = ONE, fastStepOk = false;
  if (args.length !== 3) fastStepOk = true;
  else if (allDigits(args[1])) {
    const v = xstrtold(args[1]);
    if (v && ldCmp(ZERO, v) < 0 && ldCmp(v, LIMIT) <= 0) { fastStepOk = true; stepVal = v; }
  }
  if (allDigits(args[0]) && (args.length === 1 || allDigits(args[1])) && (args.length < 3 || (fastStepOk && allDigits(args[2])))
      && !equalWidth && fmt === null && sep.length === 1) {
    if (seqFast(args.length === 1 ? '1' : args[0], args[args.length - 1], ldTrunc(stepVal))) return 0;
  }

  // scan_arg(): the value, plus the width and precision the operand was written with
  const INT_MAX = 2147483647;
  const scan = (arg) => {
    const v = xstrtold(arg);
    if (!v) { ctx.err(`invalid floating point argument: ${ql(arg)}`); throw usage(); }
    if (v.kind === 'nan') { ctx.err(`invalid ${ql('not-a-number')} argument: ${ql(arg)}`); throw usage(); }
    let k = 0;
    while (k < arg.length && (' \t\n\v\f\r'.includes(arg[k]) || arg[k] === '+')) k++;
    const s = arg.slice(k);
    let width = 0, precision = INT_MAX;
    const dp = s.indexOf('.');
    if (dp < 0 && !s.includes('p')) precision = 0;
    if (!/[xX]/.test(s) && v.kind === 'num') {
      let fractionLen = 0;
      width = s.length;
      if (dp >= 0) {
        const fr = s.slice(dp + 1);
        fractionLen = fr.search(/[eE]/) < 0 ? fr.length : fr.search(/[eE]/);
        precision = fractionLen;
        width += fractionLen === 0 ? -1 : dp === 0 || !/[0-9]/.test(s[dp - 1]) ? 1 : 0;
      }
      let e = s.indexOf('e');
      if (e < 0) e = s.indexOf('E');
      if (e >= 0) {
        const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(s.slice(e + 1));
        let exponent = m ? Math.max(-9223372036854775808, Math.min(9223372036854775807, Number(m[1]))) : 0;
        precision += exponent < 0 ? -exponent : -Math.min(precision, exponent);
        width -= s.length - e;
        if (exponent < 0) {
          if (dp >= 0) { if (e === dp + 1) width++; } else width++;
          exponent = -exponent;
        } else {
          if (dp >= 0 && precision === 0 && fractionLen) width--;
          exponent -= Math.min(fractionLen, exponent);
        }
        width += exponent;
      }
    }
    return { v, width, precision };
  };
  let first = { v: ONE, width: 1, precision: 0 }, step = { v: ONE, width: 1, precision: 0 };
  let k = 0;
  let last = scan(args[k++]);
  if (k < args.length) {
    first = last;
    last = scan(args[k++]);
    if (k < args.length) {
      step = last;
      if (isZero(step.v)) { ctx.err(`invalid Zero increment value: ${ql(args[k - 1])}`); throw usage(); }
      last = scan(args[k++]);
    }
  }
  // the fast path again, with the parsed values
  if (first.v.kind === 'num' && first.precision === 0 && step.precision === 0 && last.precision === 0
      && ldCmp(ZERO, first.v) <= 0 && ldCmp(ZERO, step.v) < 0 && ldCmp(ZERO, last.v) <= 0 && ldCmp(step.v, LIMIT) <= 0
      && !equalWidth && fmt === null && sep.length === 1) {
    const s1 = formatOne({ conv: 'f', prec: 0 }, first.v), s2 = last.v.kind === 'inf' ? 'inf' : formatOne({ conv: 'f', prec: 0 }, last.v);
    if (s1[0] !== '-' && s2[0] !== '-' && seqFast(s1, s2, ldTrunc(step.v))) return 0;
  }
  if (!out) {
    // get_default_format()
    const prec = Math.max(first.precision, step.precision);
    let spec = { conv: 'g' };
    if (prec !== INT_MAX && last.precision !== INT_MAX) {
      if (!equalWidth) spec = { conv: 'f', prec };
      else {
        let firstWidth = first.width + (prec - first.precision), lastWidth = last.width + (prec - last.precision);
        if (last.precision && prec === 0) lastWidth--;
        if (last.precision === 0 && prec) lastWidth++;
        if (first.precision === 0 && prec) firstWidth++;
        const w = Math.max(firstWidth, lastWidth);
        if (w >= 0 && w <= INT_MAX) spec = { flags: '0', width: w, prec, conv: 'f' };
      }
    }
    out = (x) => formatOne(spec, x);
  }

  // print_numbers()
  const stepNeg = ldCmp(step.v, ZERO) < 0;
  const beyond = (x) => (stepNeg ? ldCmp(x, last.v) < 0 : ldCmp(last.v, x) < 0);
  let outOfRange = stepNeg ? ldCmp(first.v, last.v) < 0 : ldCmp(last.v, first.v) < 0;
  if (outOfRange) return 0;
  let x = first.v, buf = '';
  for (let n = 1n; ; n++) {
    const x0 = x;
    buf += out(x);
    if (outOfRange) break;
    x = ldAdd(first.v, ldMul(ldFromInt(n), step.v));
    outOfRange = beyond(x);
    if (outOfRange) {
      // print a number just past LAST that prints as LAST but unlike its predecessor
      // ("seq 0 0.000001 0.000003" still ends at 0.000003)
      const xs = out(x);
      const xstr = xs.slice(0, xs.length - layout.suffix);
      const xv = xstrtold(xstr.slice(layout.prefix));
      if (!(xv && ldCmp(xv, last.v) === 0 && out(x0) !== xstr)) break;
    }
    buf += sep;
    if (buf.length > 65536) { ctx.out(buf); buf = ''; }
    ctx.tick();
  }
  ctx.out(buf + '\n');
  return 0;
}

// ---------------------------------------------------------------- yes / tee
// yes takes only --help and --version (gnulib parse_gnu_standard_options_only, permuting)
C.yes = (ctx) => {
  const argv = ctx.argv.slice(1), dd = argv.indexOf('--');
  const opt = (dd < 0 ? argv : argv.slice(0, dd)).find((a) => a.length > 1 && a[0] === '-');
  if (opt !== undefined) {
    let bad;
    if (opt.startsWith('--')) {
      const eq = opt.indexOf('='), name = opt.slice(2, eq < 0 ? undefined : eq);
      const hit = ['help', 'version'].filter((n) => n.startsWith(name));
      if (hit.length !== 1) bad = `unrecognized option '${opt}'`;
      else if (eq >= 0) bad = `option '--${hit[0]}' doesn't allow an argument`;
      else if (hit[0] === 'help') { ctx.out(helpText('yes') ?? ''); return 0; }
      else { ctx.out('yes (GNU coreutils) 8.32\nCopyright (C) 2020 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by David MacKenzie.\n'); return 0; }
    } else bad = `invalid option -- '${opt[1]}'`;
    ctx.err(bad);
    ctx.stderr.write("Try 'yes --help' for more information.\n");
    return 1;
  }
  const args = dd < 0 ? argv : [...argv.slice(0, dd), ...argv.slice(dd + 1)];
  const line = (args.length ? args.join(' ') : 'y') + '\n';
  const chunk = line.repeat(Math.max(1, Math.floor(65536 / line.length)));
  for (let i = 0; i < 4096; i++) { ctx.out(chunk); ctx.tick(); }
  return 0;
};

C.tee = (ctx) => {
  const a = parseArgs(ctx, { short: 'aip', long: { append: 'a', 'ignore-interrupts': 'i', 'output-error': ['p', 'optional'] } });
  if (!a) return 1;
  // the files are opened (truncated) before any input is read
  let st = 0;
  const sinks = [];
  for (const f of a.operands) {
    try { sinks.push(ctx.openWrite(f, a.has('a'))); }
    catch (e) { if (e instanceof FsError) { ctx.err(`${qf(f)}: ${e.message}`); st = 1; continue; } throw e; }
  }
  const data = ctx.stdin.readAll();
  ctx.out(data);
  for (const s of sinks) s.write(data);
  return st;
};

// ---------------------------------------------------------------- fold / fmt / expand / unexpand
C.fold = (ctx) => {
  let argv = ctx.argv.slice(1).map(x => (/^-\d+$/.test(x) ? '-w' + x.slice(1) : x));
  const a = parseArgs(ctx, { short: 'bsw:', long: { bytes: 'b', spaces: 's', width: ['w', 'required'] } }, argv);
  if (!a) return 1;
  const width = a.has('w') ? parseInt(a.get('w'), 10) : 80;
  if (!(width > 0)) { ctx.err(`invalid number of columns: ${qa(a.get('w'))}`); return 1; }
  const bytes = a.has('b'), spaces = a.has('s');
  return eachInput(ctx, a.operands, (data) => {
    let out = '';
    for (const rawLine of data.split(/(?<=\n)/)) {
      const nl = rawLine.endsWith('\n');
      let line = nl ? rawLine.slice(0, -1) : rawLine;
      let cur = '', col = 0;
      const adv = (ch, c) => { if (bytes) return c + 1; if (ch === '\t') return c + 8 - (c % 8); if (ch === '\b') return c > 0 ? c - 1 : 0; if (ch === '\r') return 0; return c + 1; };
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        let nc = adv(ch, col);
        if (nc > width && cur !== '') {
          if (spaces) {
            const sp = Math.max(cur.lastIndexOf(' '), cur.lastIndexOf('\t'));
            if (sp >= 0) {
              out += cur.slice(0, sp + 1) + '\n';
              cur = cur.slice(sp + 1);
              col = 0; for (const c2 of cur) col = adv(c2, col);
              nc = adv(ch, col);
              if (nc <= width) { cur += ch; col = nc; continue; }
            }
          }
          out += cur + '\n';
          cur = ''; col = 0;
          nc = adv(ch, col);
        }
        cur += ch; col = nc;
      }
      out += cur + (nl ? '\n' : '');
    }
    ctx.out(out);
    return 0;
  });
};

C.fmt = (ctx) => {
  const argv = ctx.argv.slice(1).map(x => (/^-\d+$/.test(x) ? '-w' + x.slice(1) : x));
  const a = parseArgs(ctx, { short: 'csutw:p:g:', long: { 'crown-margin': 'c', 'split-only': 's', 'uniform-spacing': 'u', 'tagged-paragraph': 't', width: ['w', 'required'], prefix: ['p', 'required'], goal: ['g', 'required'] } }, argv);
  if (!a) return 1;
  const num = (v, max) => (/^\d+$/.test(v) && +v <= max ? +v : null);
  let width = 75, goal;
  if (a.has('w')) { width = num(a.get('w'), 2500); if (width === null) { ctx.err(`invalid width: ${qa(a.get('w'))}`); return 1; } }
  if (a.has('g')) {
    goal = num(a.get('g'), width);
    if (goal === null) { ctx.err(`invalid width: ${qa(a.get('g'))}`); return 1; }
    if (!a.has('w')) width = goal + 10;
  }
  const opts = { width, goal, uniform: a.has('u'), split: a.has('s'), crown: a.has('c'), tagged: a.has('t'), prefix: a.get('p') };
  return eachInput(ctx, a.operands, (data) => { ctx.out(gnuFmt(data, opts)); return 0; });
};

// ---------------------------------------------------------------- fmt
// GNU coreutils 8.32 fmt.c, ported: paragraph detection, prefixes, tab handling and the
// least-cost line breaking (including the chunked flush of very long paragraphs).
// opts: { width, goal, uniform, split, crown, tagged, prefix }
const TABWIDTH = 8;
const MAXWORDS = 1000, MAXCHARS = 5000;
const EQUIV = (n) => n * n;
const SHORT_COST = (n) => EQUIV(n * 10);
const RAGGED_COST = (n) => Math.trunc(SHORT_COST(n) / 2);
const LINE_COST = EQUIV(70);
const WIDOW_COST = (n) => Math.trunc(EQUIV(200) / (n + 2));
const ORPHAN_COST = (n) => Math.trunc(EQUIV(150) / (n + 2));
const SENTENCE_BONUS = EQUIV(50), NOBREAK_COST = EQUIV(600);
const PAREN_BONUS = EQUIV(40), PUNCT_BONUS = EQUIV(40), LINE_CREDIT = EQUIV(3);
const MAXCOST = Number.MAX_SAFE_INTEGER;
const isopen = (c) => '([`\'"'.includes(c);
const isclose = (c) => ')]\'"'.includes(c);
const isperiod = (c) => '.?!'.includes(c);
const ispunct = (c) => /[!-\/:-@\[-`{-~]/.test(c);
const isspace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';

function gnuFmt(text, opts = {}) {
  const maxWidth = opts.width ?? 75;
  const goalWidth = opts.goal ?? Math.trunc(maxWidth * (2 * (100 - 7) + 1) / 200);
  const { uniform = false, split = false, crown = false, tagged = false } = opts;
  // set_prefix(): leading blanks are counted separately, trailing blanks are not printed
  let rawPrefix = opts.prefix ?? '';
  let prefixLeadSpace = 0;
  while (rawPrefix[prefixLeadSpace] === ' ') prefixLeadSpace++;
  rawPrefix = rawPrefix.slice(prefixLeadSpace);
  const prefixFullLength = rawPrefix.length;
  const prefix = rawPrefix.replace(/ +$/, '');
  const prefixLength = prefix.length;

  let pos = 0, out = '', tabs = false;
  let inColumn = 0, outColumn = 0, nextPrefixIndent = 0, prefixIndent = 0;
  let firstIndent = 0, otherIndent = 0, lastLineLength = 0;
  let words = [];               // completed words of the current paragraph
  let partial = '';             // the word being scanned
  let chars = 0;                // characters held in the paragraph buffer (parabuf)
  const getc = () => (pos < text.length ? text[pos++] : null);

  const getSpace = (c) => {
    for (;;) {
      if (c === ' ') inColumn++;
      else if (c === '\t') { tabs = true; inColumn = (Math.floor(inColumn / TABWIDTH) + 1) * TABWIDTH; }
      else return c;
      c = getc();
    }
  };
  const getPrefix = () => {
    inColumn = 0;
    let c = getSpace(getc());
    if (prefixLength === 0) nextPrefixIndent = prefixLeadSpace < inColumn ? prefixLeadSpace : inColumn;
    else {
      nextPrefixIndent = inColumn;
      for (const p of prefix) {
        if (c !== p) return c;
        inColumn++;
        c = getc();
      }
      c = getSpace(c);
    }
    return c;
  };
  const samePara = (c) => nextPrefixIndent === prefixIndent && inColumn >= nextPrefixIndent + prefixFullLength && c !== '\n' && c !== null;

  const putSpace = (space) => {
    const target = outColumn + space;
    if (tabs) {
      const tabTarget = Math.floor(target / TABWIDTH) * TABWIDTH;
      if (outColumn + 1 < tabTarget) while (outColumn < tabTarget) { out += '\t'; outColumn = (Math.floor(outColumn / TABWIDTH) + 1) * TABWIDTH; }
    }
    while (outColumn < target) { out += ' '; outColumn++; }
  };
  const copyRest = (c) => {
    outColumn = 0;
    if (inColumn > nextPrefixIndent || (c !== '\n' && c !== null)) {
      putSpace(nextPrefixIndent);
      for (let k = 0; outColumn !== inColumn && k < prefix.length; k++, outColumn++) out += prefix[k];
      if (c !== null && c !== '\n') putSpace(inColumn - outColumn);
      if (c === null && inColumn >= nextPrefixIndent + prefixLength) out += '\n';
    }
    while (c !== '\n' && c !== null) { out += c; c = getc(); }
    return c;
  };
  const setOtherIndent = (same) => {
    if (split) otherIndent = firstIndent;
    else if (crown) otherIndent = same ? inColumn : firstIndent;
    else if (tagged) {
      if (same && inColumn !== firstIndent) otherIndent = inColumn;
      else if (otherIndent === firstIndent) otherIndent = firstIndent === 0 ? 3 : 0;
    } else otherIndent = firstIndent;
  };

  let sentinel = { length: maxWidth, bestCost: 0 };
  const W = (i) => (i === words.length ? sentinel : words[i]);
  const baseCost = (i) => {
    let cost = LINE_COST;
    if (i > 0) {
      const prev = words[i - 1];
      if (prev.period) cost += prev.final ? -SENTENCE_BONUS : NOBREAK_COST;
      else if (prev.punct) cost -= PUNCT_BONUS;
      else if (i > 1 && words[i - 2].final) cost += WIDOW_COST(prev.length);
    }
    const w = words[i];
    if (w.paren) cost -= PAREN_BONUS;
    else if (w.final) cost += ORPHAN_COST(w.length);
    return cost;
  };
  const lineCost = (next, len) => {
    if (next === words.length) return 0;
    let cost = SHORT_COST(goalWidth - len);
    if (W(next).nextBreak !== words.length) cost += RAGGED_COST(len - W(next).lineLength);
    return cost;
  };
  const fmtParagraph = () => {
    const n = words.length;
    sentinel = { length: maxWidth, bestCost: 0 };
    for (let start = n - 1; start >= 0; start--) {
      let best = MAXCOST;
      let len = start === 0 ? firstIndent : otherIndent;
      let w = start;
      len += words[w].length;
      do {
        w++;
        let wcost = lineCost(w, len) + W(w).bestCost;
        if (start === 0 && lastLineLength > 0) wcost += RAGGED_COST(len - lastLineLength);
        if (wcost < best) { best = wcost; words[start].nextBreak = w; words[start].lineLength = len; }
        if (w === n) break;
        len += words[w - 1].space + words[w].length;
      } while (len < maxWidth);
      words[start].bestCost = best + baseCost(start);
    }
  };
  const putLine = (i, indent) => {
    outColumn = 0;
    putSpace(prefixIndent);
    out += prefix;
    outColumn += prefixLength;
    putSpace(indent - outColumn);
    const end = words[i].nextBreak - 1;
    for (; i < end; i++) { out += words[i].text; outColumn += words[i].length; putSpace(words[i].space); }
    out += words[i].text; outColumn += words[i].length;
    lastLineLength = outColumn;
    out += '\n';
  };
  const putParagraph = (finish) => {
    putLine(0, firstIndent);
    for (let w = words[0].nextBreak; w !== finish; w = words[w].nextBreak) putLine(w, otherIndent);
  };
  // the paragraph buffer is full: print a good leading part of it and keep the rest
  const flushParagraph = () => {
    if (!words.length) { out += partial; chars -= partial.length; partial = ''; return; }
    fmtParagraph();
    let splitPoint = words.length, bestBreak = MAXCOST;
    for (let w = words[0].nextBreak; w !== words.length; w = words[w].nextBreak) {
      const d = words[w].bestCost - W(words[w].nextBreak).bestCost;
      if (d < bestBreak) { splitPoint = w; bestBreak = d; }
      if (bestBreak <= MAXCOST - LINE_CREDIT) bestBreak += LINE_CREDIT;
    }
    putParagraph(splitPoint);
    for (const w of words.slice(0, splitPoint)) chars -= w.length;
    words = words.slice(splitPoint);
  };

  const checkPunctuation = (w) => {
    const t = w.text;
    w.paren = isopen(t[0]);
    w.punct = ispunct(t[t.length - 1]);
    let f = t.length - 1;
    while (f > 0 && isclose(t[f])) f--;
    w.period = isperiod(t[f]);
  };
  const getLine = (c) => {
    do {
      partial = '';
      do {
        if (chars === MAXCHARS) { setOtherIndent(true); flushParagraph(); }
        partial += c; chars++;
        c = getc();
      } while (c !== null && !isspace(c));
      const w = { text: partial, length: partial.length };
      partial = '';
      inColumn += w.length;
      checkPunctuation(w);
      const start = inColumn;
      c = getSpace(c);
      w.space = inColumn - start;
      w.final = c === null || (w.period && (c === '\n' || w.space > 1));
      if (c === '\n' || c === null || uniform) w.space = w.final ? 2 : 1;
      words.push(w);
      if (words.length === MAXWORDS - 2) { setOtherIndent(true); flushParagraph(); }
    } while (c !== '\n' && c !== null);
    return getPrefix();
  };

  let c = getPrefix();
  for (;;) {
    // get_paragraph(): copy blank lines and lines without the prefix
    lastLineLength = 0;
    while (c === '\n' || c === null || nextPrefixIndent < prefixLeadSpace || inColumn < nextPrefixIndent + prefixFullLength) {
      c = copyRest(c);
      if (c === null) return out;
      out += '\n';
      c = getPrefix();
    }
    prefixIndent = nextPrefixIndent;
    firstIndent = inColumn;
    words = []; chars = 0;
    c = getLine(c);
    setOtherIndent(samePara(c));
    if (split) { /* every line is its own paragraph */ }
    else if (crown) { if (samePara(c)) { do { c = getLine(c); } while (samePara(c) && inColumn === otherIndent); } }
    else if (tagged) { if (samePara(c) && inColumn !== firstIndent) { do { c = getLine(c); } while (samePara(c) && inColumn === otherIndent); } }
    else { while (samePara(c) && inColumn === otherIndent) c = getLine(c); }
    words[words.length - 1].period = words[words.length - 1].final = true;
    fmtParagraph();
    putParagraph(words.length);
    if (c === null) return out;
  }
}

function tabStops(spec) {
  if (!spec) return { every: 8 };
  const parts = spec.split(/[,\s]+/).filter(Boolean).map(Number);
  if (parts.length === 1) return { every: parts[0] };
  return { list: parts };
}
function nextStop(col, ts) {
  if (ts.every) return col + ts.every - (col % ts.every);
  for (const t of ts.list) if (t > col) return t;
  return col + 1;
}

C.expand = (ctx) => {
  let argv = ctx.argv.slice(1).map(x => (/^-\d+(,\d+)*$/.test(x) ? '-t' + x.slice(1) : x));
  const a = parseArgs(ctx, { short: 'it:', long: { initial: 'i', tabs: ['t', 'required'] } }, argv);
  if (!a) return 1;
  const ts = tabStops(a.get('t'));
  return eachInput(ctx, a.operands, (data) => {
    let out = '';
    for (const line of data.split(/(?<=\n)/)) {
      let col = 0, initial = true;
      for (const ch of line) {
        if (ch === '\t' && (!a.has('i') || initial)) { const n = nextStop(col, ts); out += ' '.repeat(n - col); col = n; continue; }
        if (ch !== ' ' && ch !== '\t') initial = false;
        if (ch === '\b') col = Math.max(0, col - 1); else if (ch !== '\n') col++;
        out += ch;
      }
    }
    ctx.out(out);
    return 0;
  });
};

C.unexpand = (ctx) => {
  const a = parseArgs(ctx, { short: 'at:', long: { all: 'a', 'first-only': 'f', tabs: ['t', 'required'] } });
  if (!a) return 1;
  const ts = tabStops(a.get('t'));
  const all = a.has('a') || (a.has('t') && !a.has('f'));
  const every = ts.every || 8;
  return eachInput(ctx, a.operands, (data) => {
    let out = '';
    for (const line of data.split(/(?<=\n)/)) {
      let res = '', col = 0, spaces = 0, leading = true;
      for (const ch of line) {
        if (ch === ' ' && (all || leading)) {
          spaces++; col++;
          if (col % every === 0) { res += spaces > 1 ? '\t' : ' '; spaces = 0; }
          continue;
        }
        if (spaces) { res += ' '.repeat(spaces); spaces = 0; }
        if (ch === '\t') { col = col + every - (col % every); res += ch; continue; }
        leading = false;
        res += ch; col++;
      }
      res += ' '.repeat(spaces);
      out += res;
    }
    ctx.out(out);
    return 0;
  });
};

// ---------------------------------------------------------------- column
// util-linux 2.37.2 column(1). The fill modes are column.c itself; -t and -J print through
// libsmartcols (calculate.c, print.c), which this mirrors in the C locale: a line holding a byte
// above 0x7f is not valid text there and gets its bytes shown as \xHH.
const COLUMN_USAGE = `
Usage:
 column [options] [<file>...]

Columnate lists.

Options:
 -t, --table                      create a table
 -n, --table-name <name>          table name for JSON output
 -O, --table-order <columns>      specify order of output columns
 -N, --table-columns <names>      comma separated columns names
 -l, --table-columns-limit <num>  maximal number of input columns
 -E, --table-noextreme <columns>  don't count long text from the columns to column width
 -d, --table-noheadings           don't print header
 -e, --table-header-repeat        repeat header for each page
 -H, --table-hide <columns>       don't print the columns
 -R, --table-right <columns>      right align text in these columns
 -T, --table-truncate <columns>   truncate text in the columns when necessary
 -W, --table-wrap <columns>       wrap text in the columns when necessary
 -L, --keep-empty-lines           don't ignore empty lines
 -J, --json                       use JSON output format for table

 -r, --tree <column>              column to use tree-like output for the table
 -i, --tree-id <column>           line ID to specify child-parent relation
 -p, --tree-parent <column>       parent to specify child-parent relation

 -c, --output-width <width>       width of output in number of characters
 -o, --output-separator <string>  columns separator for table output (default is two spaces)
 -s, --separator <string>         possible table delimiters
 -x, --fillrows                   fill rows before columns

 -h, --help                       display this help
 -V, --version                    display version

For more details see column(1).
`;
class ColumnExit { constructor(code) { this.code = code; } }
// mbs_width(): printable ASCII is one cell; control characters take none, and one followed by
// "[...m" hides that whole (colour) sequence; other bytes are not valid characters here
function colMbsWidth(s) {
  let w = 0;
  const last = s.length - 1;
  for (let p = 0; p < s.length;) {
    const c = s.charCodeAt(p);
    if (c < 0x20 || c === 0x7f) {
      p++;
      if (s[p] === '[') {
        let e = p;
        while (e < s.length && e < last && s[e] !== 'm') e++;
        if (s[e] === 'm') p = e + 1;
      }
      continue;
    }
    if (c < 0x7f) w++;
    p++;
  }
  return w;
}
// mbs_truncate() to WIDTH cells: { bytes (-1 when the result can't be encoded), cells }
function colTruncate(s, width) {
  if (/[\x80-\xff]/.test(s)) return { bytes: s.length, cells: width };
  let cells = 0, i = 0, bad = false;
  for (; i < s.length; i++) {
    if (cells + 1 > width) break;
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) bad = true;    // becomes U+FFFD, which the C locale can't write
    cells++;
  }
  return bad ? { bytes: -1, cells } : { bytes: i, cells };
}
// JSON string as util-linux writes it (fputs_quoted_case_json); LOWER lowercases ASCII
function colJsonStr(s, lower) {
  let o = '"';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === '"' || ch === '\\') o += '\\' + ch;
    else if (c >= 0x20) o += lower && ch >= 'A' && ch <= 'Z' ? ch.toLowerCase() : ch;
    else o += { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' }[c] || '\\u00' + c.toString(16).padStart(2, '0');
  }
  return o + '"';
}
// scols_print_table() for a table built by column -t/-J; returns [output, rc]
function scolsPrintTable(tb) {
  const cols = tb.cols, json = tb.json;
  if (!cols.length) return ['', -22];
  const isTree = cols.some((c) => c.tree);
  const isLastCol = (ci) => { for (let j = ci + 1; j < cols.length; j++) if (!cols[j].hidden) return false; return true; };
  const isLastChild = (ln) => !!ln.parent && ln.parent.children[ln.parent.children.length - 1] === ln;
  const artOf = (ln) => (ln.parent ? artOf(ln.parent) + (isLastChild(ln) ? '  ' : '| ') : '');
  // __cell_to_buffer(): [text, tree art length]
  const cellText = (ln, ci) => {
    const data = ln.cells[ci] ?? null;
    if (!cols[ci].tree) return [data ?? '', 0];
    let art = '';
    if (ln.parent && !json) art = artOf(ln.parent) + (isLastChild(ln) ? '`-' : '|-');
    return [art + (data ?? ''), art.length];
  };
  let order = tb.lines;
  if (isTree) { order = []; const visit = (ln) => { order.push(ln); ln.children.forEach(visit); }; tb.lines.filter((l) => !l.parent).forEach(visit); }

  if (json) {
    // ul_jsonwrt
    let out = '', indent = 0, after = false;
    const ind = () => '   '.repeat(indent);
    const open = (name, type) => {
      if (name !== null) { if (after) out += ',\n'; out += ind() + colJsonStr(name, true); } else if (after) out += ','; else out += ind();
      if (type === 'o') { out += name !== null ? ': {\n' : '{\n'; indent++; } else if (type === 'a') { out += name !== null ? ': [\n' : '[\n'; indent++; } else out += name !== null ? ': ' : ' ';
      after = false;
    };
    const close = (type) => {
      if (indent === 1) { out += '\n}\n'; indent--; after = true; return; }
      if (type === 'o') { indent--; out += '\n' + ind() + '}'; } else if (type === 'a') { indent--; out += '\n' + ind() + ']'; }
      after = true;
    };
    const line = (ln) => cols.forEach((cl, ci) => { if (cl.hidden) return; const d = cellText(ln, ci)[0]; open(cl.name, 'v'); out += d ? colJsonStr(d, false) : 'null'; close('v'); });
    open(null, 'o');
    open(tb.name, 'a');
    if (!isTree) for (const ln of tb.lines) { open(null, 'o'); line(ln); close('o'); }
    else {
      const lastRoot = tb.lines.filter((l) => !l.parent).pop();
      for (let ln of order) {
        open(null, 'o');
        line(ln);
        if (ln.children.length) { open('children', 'a'); continue; }
        let last;
        do {
          last = (ln.parent && isLastChild(ln)) || (!ln.parent && ln === lastRoot);
          close('o');
          if (last && ln.parent) close('a');
          ln = ln.parent;
        } while (ln && last);
      }
    }
    close('a');
    close('o');
    return [out, 0];
  }

  // __scols_calculate()
  const tw = tb.termwidth;
  const countColumn = (ci) => {
    const cl = cols[ci];
    let noHeader = false;
    cl.width = 0;
    if (!cl.widthMin) {
      if (cl.name !== null) cl.widthMin = Math.max(cl.widthMin, colMbsWidth(cl.name)); else noHeader = true;
      if (!cl.widthMin) cl.widthMin = 1;
    }
    for (const ln of order) {
      const [text, art] = cellText(ln, ci);
      const len = colMbsWidth(text);
      if (len > cl.widthMax) cl.widthMax = len;
      if (cl.isExtreme && cl.widthAvg && len > cl.widthAvg * 2) continue;
      if (cl.noextremes) { cl.extremeSum += len; cl.extremeCount++; }
      if (len > cl.width) cl.width = len;
      if (cl.tree && art > cl.widthTreeart) cl.widthTreeart = art;
    }
    if (cl.extremeCount && cl.widthAvg === 0) {
      cl.widthAvg = Math.floor(cl.extremeSum / cl.extremeCount);
      if (cl.widthAvg && cl.widthMax > cl.widthAvg * 2) cl.isExtreme = true;
    }
    if (cl.width < cl.widthMin) cl.width = cl.widthMin;
    if (cl.widthMax === 0 && noHeader && cl.widthMin === 1 && cl.width <= 1) cl.width = cl.widthMin = 0;
  };
  const colsepsz = colMbsWidth(tb.colsep);
  let width = 0, extremes = 0;
  cols.forEach((cl, ci) => {
    if (cl.hidden) return;
    countColumn(ci);
    width += cl.width + (isLastCol(ci) ? 0 : colsepsz);
    if (cl.isExtreme) extremes++;
  });
  if (width > tw && extremes) {
    cols.forEach((cl, ci) => {
      if (!cl.isExtreme || cl.hidden) return;
      const org = cl.width;
      countColumn(ci);
      if (org > cl.width) width -= org - cl.width; else extremes--;
    });
  }
  if (width < tw) {
    if (extremes) {
      for (const cl of cols) {
        if (!cl.isExtreme || cl.hidden) continue;
        let add = tw - width;
        if (add && cl.width + add > cl.widthMax) add = cl.widthMax - cl.width;
        cl.width += add; width += add;
        if (width === tw) break;
      }
    }
    if (width < tw) {
      const col = cols[cols.length - 1];
      if (!col.right) { col.width += tw - width; width = tw; }
    }
  }
  for (let stage = 1; width > tw && stage <= 3;) {
    const org = width;
    for (const cl of cols) {
      if (cl.hidden) continue;
      if (width <= tw) break;
      if (cl.width === cl.widthMin) continue;
      if (cl.tree && width <= cl.widthTreeart) continue;
      if (cl.width === 0) continue;
      // only "truncate everything flagged" applies: column sets no relative width hints
      if (stage === 2 && (cl.trunc || cl.wrap)) { cl.width--; width--; }
      if (cl.width === 0) cl.hidden = true;
    }
    if (org === width) stage++;
  }

  // printing
  let termlines = 0, headerNext = 0, headerPrinted = false;
  const hasPending = () => cols.some((c) => !c.hidden && c.pending !== null);
  const stepPending = (cl, bytes) => { cl.pending = bytes >= cl.pending.length ? null : cl.pending.slice(bytes); };
  const emptyCell = (ci, ln) => {
    const cl = cols[ci];
    let s = '', lenPad = 0;
    if (ln && cl.tree) {
      if (!ln.parent) { if (ln.children.length) { s += '| '; lenPad = 2; } } else {
        let art = artOf(ln);
        if (ln.children.length && hasPending()) art += '| ';
        const w = colMbsWidth(art);
        if (w) { s += art; lenPad = w; }
      }
    }
    if (isLastCol(ci)) return s;
    for (; lenPad < cl.width; lenPad++) s += ' ';
    return s + tb.colsep;
  };
  const printData = (ci, ln, raw) => {
    const cl = cols[ci];
    let len = colMbsWidth(raw);
    let data = len ? raw : '';
    let bytes = data.length, width = cl.width;
    const isLast = isLastCol(ci);
    if (isLast && len < width && !cl.right) width = len;
    if (len > width && cl.trunc) { const t = colTruncate(data, width); len = t.cells; bytes = t.bytes; if (bytes >= 0) data = data.slice(0, bytes); }
    if (len > width && cl.wrap) {
      cl.pending = data || null;
      const t = colTruncate(data, width);
      len = t.cells; bytes = t.bytes;
      if (bytes >= 0) { data = data.slice(0, bytes); if (bytes > 0) stepPending(cl, bytes); }
    }
    if (bytes === -1) { len = 0; data = ''; }
    let s = '';
    if (data) { if (cl.right) { for (let i = len; i < width; i++) s += ' '; len = width; } s += data; }
    if (isLast) return s;
    for (let i = len; i < width; i++) s += ' ';
    if (len > width && !cl.trunc) {
      // print_newline_padding(): the next column starts on a new line
      s += '\n'; termlines++;
      for (let i = 0; i <= ci; i++) s += emptyCell(i, ln);
    } else s += tb.colsep;
    return s;
  };
  // print_pending_data(); null is an error, which ends the line's extra lines but keeps the data
  const printPending = (ci) => {
    const cl = cols[ci];
    if (!cl.width) return null;
    const t = colTruncate(cl.pending, cl.width);
    if (t.bytes === -1) return null;
    const data = cl.pending.slice(0, t.bytes);
    if (t.bytes) stepPending(cl, t.bytes);
    if (isLastCol(ci)) return data;
    return data + ' '.repeat(Math.max(0, cl.width - t.cells)) + tb.colsep;
  };
  const printLine = (ln) => {
    let s = '', pending = false, failed = false;
    cols.forEach((cl, ci) => { if (cl.hidden) return; s += printData(ci, ln, cellText(ln, ci)[0]); if (cl.pending !== null) pending = true; });
    while (!failed && pending) {
      pending = false;
      s += '\n'; termlines++;
      for (let ci = 0; !failed && ci < cols.length; ci++) {
        const cl = cols[ci];
        if (cl.hidden) continue;
        if (cl.pending !== null) {
          const p = printPending(ci);
          if (p === null) failed = true; else { s += p; if (cl.pending !== null) pending = true; }
        } else s += emptyCell(ci, ln);
      }
    }
    return s;
  };
  const printHeader = () => {
    if ((headerPrinted && !tb.headerRepeat) || tb.noheadings || !tb.lines.length) return '';
    let s = '';
    cols.forEach((cl, ci) => { if (!cl.hidden) s += printData(ci, null, cl.name ?? ''); });
    s += '\n'; termlines++;
    headerPrinted = true;
    headerNext = termlines + tb.termheight;
    return s;
  };
  let out = printHeader();
  order.forEach((ln, k) => {
    const last = k === order.length - 1;
    out += printLine(ln);
    if (!last) { out += '\n'; termlines++; }
    if (!last && !isTree && (!tb.headerRepeat || headerNext <= termlines)) out += printHeader();
  });
  return [out + '\n', 0];
}

C.column = (ctx) => {
  const spec = { name: 'column', short: 'c:dE:eH:hi:Jl:LN:n:O:o:p:R:r:s:T:tVW:x', long: {
    columns: ['c', 'required'], fillrows: 'x', help: 'h', json: 'J', 'keep-empty-lines': 'L', 'output-separator': ['o', 'required'],
    'output-width': ['c', 'required'], separator: ['s', 'required'], table: 't', 'table-columns': ['N', 'required'],
    'table-columns-limit': ['l', 'required'], 'table-hide': ['H', 'required'], 'table-name': ['n', 'required'],
    'table-noextreme': ['E', 'required'], 'table-noheadings': 'd', 'table-order': ['O', 'required'], 'table-right': ['R', 'required'],
    'table-truncate': ['T', 'required'], 'table-wrap': ['W', 'required'], 'table-empty-lines': 'L', 'table-header-repeat': 'e',
    tree: ['r', 'required'], 'tree-id': ['i', 'required'], 'tree-parent': ['p', 'required'], version: 'V',
  } };
  const r = getopt(ctx.argv.slice(1), spec);
  const errx = (msg) => { ctx.err(msg); throw new ColumnExit(1); };
  // strtou32_or_err(): a negative or too large number is ERANGE even with junk after it
  const u32 = (s, what) => {
    const range = () => errx(`${what}: '${s}': Numerical result out of range`);
    const m = /^[ \t\n\v\f\r]*([+-]?)(\d+)/.exec(s);
    if (m && (m[1] === '-' ? BigInt(m[2]) !== 0n : BigInt(m[2]) > 18446744073709551615n)) range();
    if (!m || m[0].length !== s.length) errx(`${what}: '${s}'`);
    const v = m[1] === '-' ? 0n : BigInt(m[2]);
    if (v > 4294967295n) range();
    return Number(v);
  };
  const strvSplit = (s) => s.split(',').filter((w) => w !== '');
  const env = ctx.env || {};
  const envInt = (name) => { const m = /^[ \t\n\v\f\r]*([+-]?\d+)$/.exec(env[name] ?? ''); const x = m ? Number(m[1]) : -1; return x > 0 && x <= 2147483647 ? x : -1; };
  let mode = 'fillcols', termwidth = -1, greedy = true, json = false, headerRepeat = false, keepEmpty = false, noheadings = false;
  let colnames = null, tabName = null, order = null, right = null, trunc = null, noextrem = null, wrap = null, hide = null;
  let tree = null, treeId = null, treeParent = null, isep = '\t ', osep = '  ', maxncols = 0;
  const excl = [['J', 'x'], ['t', 'x']], exclSt = [0, 0];
  const LONGOF = { J: 'json', x: 'fillrows', t: 'table' };
  try {
    for (const [k, v] of r.opts) {
      // err_exclusive_options()
      for (let e = 0; e < excl.length && excl[e][0] <= k; e++) {
        if (!excl[e].includes(k)) continue;
        if (exclSt[e] === 0) exclSt[e] = k;
        else if (exclSt[e] !== k) { ctx.stderr.write(`column: mutually exclusive arguments:${excl[e].map((o) => ' --' + LONGOF[o]).join('')}\n`); throw new ColumnExit(1); }
      }
      switch (k) {
        case 'c': termwidth = u32(v, 'invalid columns argument'); break;
        case 'd': noheadings = true; break;
        case 'E': noextrem = v; break;
        case 'e': headerRepeat = true; break;
        case 'H': hide = v; break;
        case 'i': treeId = v; break;
        case 'J': json = true; mode = 'table'; break;
        case 'L': keepEmpty = true; break;
        case 'l': maxncols = u32(v, 'invalid columns limit argument'); if (!maxncols) errx('columns limit must be greater than zero'); break;
        case 'N': colnames = strvSplit(v); break;
        case 'n': tabName = v; break;
        case 'O': order = v; break;
        case 'o': osep = v; break;
        case 'p': treeParent = v; break;
        case 'R': right = v; break;
        case 'r': tree = v; break;
        case 's': isep = v; greedy = false; break;
        case 'T': trunc = v; break;
        case 't': mode = 'table'; break;
        case 'W': wrap = v; break;
        case 'x': mode = 'fillrows'; break;
        case 'h': ctx.out(COLUMN_USAGE); return 0;
        case 'V': ctx.out('column from util-linux 2.37.2\n'); return 0;
        default: break;
      }
    }
    if (r.error) { ctx.stderr.write(r.error + '\n'); ctx.stderr.write("Try 'column --help' for more information.\n"); return 1; }
    if (termwidth === -1) { termwidth = envInt('COLUMNS'); if (termwidth <= 0) termwidth = 80; }
    if (tree !== null) {
      mode = 'table';
      if (treeParent === null || treeId === null) errx('options --tree-id and --tree-parent are required for tree formatting');
    }
    if (mode !== 'table' && (order !== null || tabName !== null || wrap !== null || hide !== null || trunc !== null || noextrem !== null || right !== null || colnames !== null)) errx('option --table required for all --table-*');
    if (colnames === null && json) errx('option --table-columns required for --json');

    // read_input()
    let tab = null;
    const ents = [];
    let maxlength = 0;
    const termheight = envInt('LINES') > 0 ? envInt('LINES') : 24;
    const initTable = () => {
      tab = { cols: [], lines: [], colsep: osep, termwidth, termheight, json, name: tabName ?? 'table', headerRepeat: false, noheadings: true };
      if (colnames) { for (const n of colnames) addColumn(n); tab.headerRepeat = headerRepeat; tab.noheadings = noheadings; }
    };
    const addColumn = (name) => tab.cols.push({ name, hidden: false, right: false, trunc: false, wrap: false, noextremes: false, tree: false,
      width: 0, widthMin: 0, widthMax: 0, widthAvg: 0, isExtreme: false, extremeSum: 0, extremeCount: 0, widthTreeart: 0, pending: null });
    const newLine = () => { const ln = { cells: [], parent: null, children: [] }; tab.lines.push(ln); return ln; };
    const isSep = (c) => isep.includes(c);
    const addLine = (s0) => {
      if (!tab) initTable();
      const w = s0.split('');
      w.push('\0');
      const cstr = (i) => { let e = i; while (w[e] !== '\0') e++; return w.slice(i, e).join(''); };
      let save = 0, n = 0, nchars = 0, ln = null;
      for (;;) {
        let tok;
        if (maxncols && n + 1 === maxncols) {
          // the rest of the line, found by counting from its start (not where wcstok left off)
          if (nchars < w.length) tok = cstr(nchars);
          else {
            // one past the string's NUL: still zeroed calloc() memory, or the next heap chunk
            const R = w.length * 4, usable = Math.max(32, (R + 23) & ~15) - 8;
            if (R + 4 > usable) errx('failed to allocate output data: Invalid or incomplete multibyte or wide character');
            tok = '';
          }
        } else {
          if (save < 0) tok = null;
          else {
            let i = save;
            if (greedy) while (w[i] !== '\0' && isSep(w[i])) i++;
            if (greedy && w[i] === '\0') { save = -1; tok = null; } else {
              let e = i;
              while (w[e] !== '\0' && !isSep(w[e])) e++;
              if (w[e] === '\0') save = -1; else { w[e] = '\0'; save = e + 1; }
              tok = cstr(i);
            }
          }
        }
        if (tok === null) break;
        if (tab.cols.length < n + 1) {
          if (json) errx(`line ${tab.lines.length + 1}: for JSON the name of the column ${n + 1} is required`);
          addColumn(null);
        }
        if (!ln) ln = newLine();
        nchars += tok.length + 1;
        ln.cells[n] = tok;
        n++;
        if (maxncols && n === maxncols) break;
      }
    };
    const readInput = (data) => {
      for (let pos = 0; pos < data.length;) {
        const j = data.indexOf('\n', pos);
        let line = j < 0 ? data.slice(pos) : data.slice(pos, j);
        pos = j < 0 ? data.length : j + 1;
        line = line.split('\0')[0];
        if (!/[^ \t\n\v\f\r]/.test(line)) {
          if (keepEmpty) { if (mode === 'table') { if (!tab) initTable(); newLine(); } else ents.push(''); }
          continue;
        }
        // mbstowcs() fails on any byte above 0x7f: mbs_invalid_encode() shows them as \xHH
        if (/[\x80-\xff]/.test(line)) line = line.replace(/[\x80-\xff]|\\(?=x)/g, (ch) => '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
        if (mode === 'table') addLine(line);
        else {
          ents.push(line);
          let len = 0;
          for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c >= 0x20 && c < 0x7f) len++; }
          if (len > maxlength) maxlength = len;
        }
      }
    };
    let ev = 0;
    if (!r.operands.length) readInput(ctx.stdin.readAll());
    for (const f of r.operands) {
      let data;
      try { data = f === '-' ? ctx.fs.readFile(f, ctx.cwd) : ctx.readFile(f); } catch (e) {
        if (!(e instanceof FsError)) throw e;
        if (e.code === 'EISDIR') errx(`read failed: ${e.message}`);
        ctx.err(`${f}: ${e.message}`);
        ev++;
        continue;
      }
      readInput(data);
    }

    if (mode !== 'table') {
      if (!ents.length) return ev;   // exit(eval): one per unreadable file
      if (maxlength >= termwidth) mode = 'simple';
    }
    let out = '';
    const TAB = 8;
    if (mode === 'table') {
      if (tab && tab.lines.length) {
        // modify_table()
        const toColumn = (str) => {
          let k;
          if (/^\d+$/.test(str)) k = (u32(str, 'failed to parse column') - 1) >>> 0;
          else {
            k = (colnames || []).findIndex((n) => n.toLowerCase() === str.toLowerCase());
            if (k < 0) errx(`undefined column name '${str}'`);
          }
          return tab.cols[k] || null;
        };
        const flagList = (list, flag) => {
          if (list === '0') for (const cl of tab.cols) cl[flag] = true;
          let unnamed = false;
          for (const one of strvSplit(list)) {
            if (flag === 'hidden' && one === '-') { unnamed = true; continue; }
            const cl = toColumn(one);
            if (cl) cl[flag] = true;
          }
          if (unnamed) for (const cl of tab.cols) if (cl.name === null) cl.hidden = true;
        };
        if (right !== null) flagList(right, 'right');
        if (trunc !== null) flagList(trunc, 'trunc');
        if (noextrem !== null) flagList(noextrem, 'noextremes');
        if (wrap !== null) flagList(wrap, 'wrap');
        if (hide !== null) flagList(hide, 'hidden');
        if (noextrem === null) { const vis = tab.cols.filter((c) => !c.hidden); if (vis.length) vis[vis.length - 1].noextremes = true; }
        if (tree !== null) {
          const clTree = toColumn(tree), clP = toColumn(treeParent), clI = toColumn(treeId);
          if (clP && clI && clTree) {
            clTree.tree = true;
            const pi = tab.cols.indexOf(clP), ii = tab.cols.indexOf(clI);
            const isAncestor = (ln, of) => { for (let p = of; p; p = p.parent) if (p === ln) return true; return false; };
            for (const lnI of tab.lines) {
              const id = lnI.cells[ii] ?? null;
              if (id === null) continue;
              for (const ln of tab.lines) {
                const parent = ln.cells[pi] ?? null;
                if (parent === null || parent !== id || isAncestor(ln, lnI)) continue;
                if (ln.parent) ln.parent.children.splice(ln.parent.children.indexOf(ln), 1);
                lnI.children.push(ln);
                ln.parent = lnI;
              }
            }
          }
        }
        if (order !== null) {
          // reorder_table() with scols_table_move_column()
          const wanted = strvSplit(order).map(toColumn).filter(Boolean);
          for (const ln of tab.lines) for (let i = 0; i < tab.cols.length; i++) if (ln.cells[i] === undefined) ln.cells[i] = null;
          let pre = null;
          for (const cl of wanted) {
            const old = tab.cols.indexOf(cl);
            const preIdx = pre ? tab.cols.indexOf(pre) : -1;
            if (pre === cl) tab.cols.splice(old, 1);   // moving a column behind itself unlinks it
            else if (old >= 0 && !(pre ? preIdx + 1 === old : old === 0)) {
              tab.cols.splice(old, 1);
              const at = pre ? tab.cols.indexOf(pre) + 1 : 0;
              tab.cols.splice(at, 0, cl);
              for (const ln of tab.lines) { const c = ln.cells.splice(old, 1)[0]; ln.cells.splice(at, 0, c); }
            }
            pre = cl;
          }
        }
        const [o, rc] = scolsPrintTable(tab);
        out = o;
        ev = rc;
      }
    } else if (mode === 'fillcols') {
      const fw = (s) => { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 0x20 && c < 0x7f) n++; } return n; };
      const maxl = (maxlength + TAB) & ~(TAB - 1);
      let numcols = Math.floor(termwidth / maxl);
      if (!numcols) numcols = 1;
      const numrows = Math.ceil(ents.length / numcols);
      for (let row = 0; row < numrows; row++) {
        let endcol = maxl, chcnt = 0;
        for (let base = row, col = 0; col < numcols; col++) {
          out += ents[base];
          chcnt += fw(ents[base]);
          if ((base += numrows) >= ents.length) break;
          let cnt;
          while ((cnt = (chcnt + TAB) & ~(TAB - 1)) <= endcol) { out += '\t'; chcnt = cnt; }
          endcol += maxl;
        }
        out += '\n';
      }
    } else if (mode === 'fillrows') {
      const fw = (s) => { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 0x20 && c < 0x7f) n++; } return n; };
      const maxl = (maxlength + TAB) & ~(TAB - 1);
      const numcols = Math.floor(termwidth / maxl);
      let endcol = maxl, chcnt = 0, col = 0, left = ents.length;
      for (let i = 0; ; i++) {
        out += ents[i];
        chcnt += fw(ents[i]);
        if (!--left) break;
        if (++col === numcols) { chcnt = col = 0; endcol = maxl; out += '\n'; } else {
          let cnt;
          while ((cnt = (chcnt + TAB) & ~(TAB - 1)) <= endcol) { out += '\t'; chcnt = cnt; }
          endcol += maxl;
        }
      }
      if (chcnt) out += '\n';
    } else for (const e of ents) out += e + '\n';
    ctx.out(out);
    return ev === 0 ? 0 : 1;
  } catch (e) { if (e instanceof ColumnExit) return e.code; throw e; }
};

// ---------------------------------------------------------------- join / comm
// GNU join (coreutils 8.32 join.c): a streaming merge of two sorted inputs. Once a line turns out
// to be unpairable, a join key that goes backwards earns one "is not sorted" warning per file
// (stdout is flushed first, like gnulib's error()) and exit status 1.
C.join = (ctx) => {
  const argv = ctx.argv.slice(1);
  const a = parseArgs(ctx, { short: 'a:e:ij:o:t:v:1:2:z', long: { 'ignore-case': 'i', 'check-order': 'check', 'nocheck-order': 'nocheck', header: 'header', 'zero-terminated': 'z' } }, argv);
  if (!a) return 1;
  let jf1 = 0, jf2 = 0, tab = -1, empty = null, outList = null, autoformat = false;
  const icase = a.has('i');
  const printUnp = [false, false];
  let printPairables = true, check = 'default';
  const fieldNum = (v) => { const n = /^\d+$/.test(v) ? parseInt(v, 10) : NaN; return n >= 1 ? n - 1 : null; };
  for (const [k, v] of a.all) {
    if (k === '1' || k === '2' || k === 'j') {
      const f = fieldNum(v);
      if (f === null) { ctx.err(`invalid field number: ${qa(v)}`); return 1; }
      if (k !== '2') jf1 = f;
      if (k !== '1') jf2 = f;
    } else if (k === 't') {
      if (v.length > 1 && v !== '\\0') { ctx.err(`multi-character tab ${qa(v)}`); return 1; }
      tab = v === '' ? '\n' : v === '\\0' ? '\0' : v;
    } else if (k === 'e') empty = v;
    else if (k === 'o') {
      if (v === 'auto') { autoformat = true; continue; }
      outList = [];
      for (const spec of v.split(/[ ,]+/).filter(Boolean)) {
        if (spec === '0') { outList.push({ file: 0, field: 0 }); continue; }
        const m = /^([12])\.(\d+)$/.exec(spec);
        if (!m || +m[2] < 1) { ctx.err(m ? `invalid field number: ${qa(m[2])}` : `invalid field specifier: ${qa(spec)}`); return 1; }
        outList.push({ file: +m[1], field: +m[2] - 1 });
      }
    } else if (k === 'a' || k === 'v') {
      if (v !== '1' && v !== '2') { ctx.err(`invalid file number: ${qa(v)}`); return 1; }
      printUnp[+v - 1] = true;
      if (k === 'v') printPairables = false;
    } else if (k === 'check') check = 'enabled';
    else if (k === 'nocheck') check = 'disabled';
  }
  if (a.operands.length !== 2) { ctx.err(a.operands.length < 2 ? (a.operands.length ? `missing operand after ${qa(a.operands[0])}` : 'missing operand') : `extra operand ${qa(a.operands[2])}`); ctx.stderr.write("Try 'join --help' for more information.\n"); return 1; }
  const names = a.operands;
  let d1, d2;
  try { d1 = ctx.readFile(names[0]); d2 = ctx.readFile(names[1]); }
  catch (e) { if (e instanceof FsError) { ctx.err(readErrMsg(ctx, e.path, e)); return 1; } throw e; }
  const eol = a.has('z') ? '\0' : '\n';
  const isSep = (c) => c === ' ' || c === '\t' || c === '\n';
  const xfields = (buf) => {
    const f = [];
    if (buf === '') return f;
    let p = 0;
    if (tab !== -1 && tab !== '\n') {
      let q;
      while ((q = buf.indexOf(tab, p)) >= 0) { f.push(buf.slice(p, q)); p = q + 1; }
    } else if (tab === -1) {
      while (isSep(buf[p])) if (++p === buf.length) return f;
      for (;;) {
        let q = p + 1;
        while (q < buf.length && !isSep(buf[q])) q++;
        f.push(buf.slice(p, q));
        if (q === buf.length) return f;
        p = q + 1;
        while (p < buf.length && isSep(buf[p])) p++;
        if (p === buf.length) break;
      }
    }
    f.push(buf.slice(p));
    return f;
  };
  const lines = [splitLines(d1, eol), splitLines(d2, eol)].map(ls => ls.map(buf => ({ buf, f: xfields(buf) })));
  const keyOf = (l, jf) => (jf < l.f.length ? l.f[jf] : '');
  const keycmp = (l1, l2, j1, j2) => {
    let k1 = keyOf(l1, j1), k2 = keyOf(l2, j2);
    if (!k1.length) return k2.length ? -1 : 0;
    if (!k2.length) return 1;
    if (icase) { k1 = k1.toLowerCase(); k2 = k2.toLowerCase(); }
    return k1 < k2 ? -1 : k1 > k2 ? 1 : 0;
  };
  let out = '';
  const flush = () => { if (out) { ctx.out(out); out = ''; } };
  class Fatal { }
  const pos = [0, 0], lineNo = [0, 0], prev = [null, null], warned = [false, false];
  let seenUnpairable = false;
  const checkOrder = (p, cur, w) => {
    if (check === 'disabled' || !(check === 'enabled' || seenUnpairable) || warned[w]) return;
    if (keycmp(p, cur, w ? jf2 : jf1, w ? jf2 : jf1) > 0) {
      flush();
      ctx.err(`${names[w]}:${lineNo[w]}: is not sorted: ${cur.buf}`);
      if (check === 'enabled') throw new Fatal();
      warned[w] = true;
    }
  };
  const getLine = (w) => {
    if (pos[w] >= lines[w].length) return null;
    const l = lines[w][pos[w]++];
    lineNo[w]++;
    if (prev[w]) checkOrder(prev[w], l, w);
    prev[w] = l;
    return l;
  };
  const BLANK = { buf: '', f: [] };
  let auto1 = 0, auto2 = 0;
  const osep = tab === -1 ? ' ' : tab;
  const prfield = (n, l) => (n < l.f.length ? (l.f[n].length ? l.f[n] : (empty ?? '')) : (empty ?? ''));
  const prfields = (l, jf, autocount) => {
    const nf = autoformat ? autocount : l.f.length;
    let s = '';
    for (let i = 0; i < jf && i < nf; i++) s += osep + prfield(i, l);
    for (let i = jf + 1; i < nf; i++) s += osep + prfield(i, l);
    return s;
  };
  const prjoin = (l1, l2) => {
    if (outList) {
      out += outList.map(o => (o.file === 0 ? (l1 === BLANK ? prfield(jf2, l2) : prfield(jf1, l1)) : prfield(o.field, o.file === 1 ? l1 : l2))).join(osep) + eol;
    } else {
      out += (l1 === BLANK ? prfield(jf2, l2) : prfield(jf1, l1)) + prfields(l1, jf1, auto1) + prfields(l2, jf2, auto2) + eol;
    }
  };
  try {
    let s1 = [], s2 = [];
    let l = getLine(0); if (l) s1.push(l);
    l = getLine(1); if (l) s2.push(l);
    if (autoformat) { auto1 = s1.length ? s1[0].f.length : 0; auto2 = s2.length ? s2[0].f.length : 0; }
    if (a.has('header') && (s1.length || s2.length)) {
      prjoin(s1.length ? s1[0] : BLANK, s2.length ? s2[0] : BLANK);
      prev[0] = prev[1] = null;
      if (s1.length) { s1 = []; const x = getLine(0); if (x) s1.push(x); }
      if (s2.length) { s2 = []; const x = getLine(1); if (x) s2.push(x); }
    }
    while (s1.length && s2.length) {
      const diff = keycmp(s1[0], s2[0], jf1, jf2);
      if (diff < 0) {
        if (printUnp[0]) prjoin(s1[0], BLANK);
        s1 = []; const x = getLine(0); if (x) s1.push(x);
        seenUnpairable = true;
        continue;
      }
      if (diff > 0) {
        if (printUnp[1]) prjoin(BLANK, s2[0]);
        s2 = []; const x = getLine(1); if (x) s2.push(x);
        seenUnpairable = true;
        continue;
      }
      // every line of file 1 that matches the current line of file 2, then the other way round
      let eof1 = false, eof2 = false, next1 = null, next2 = null;
      for (;;) { const x = getLine(0); if (!x) { eof1 = true; break; } if (keycmp(x, s2[0], jf1, jf2)) { next1 = x; break; } s1.push(x); }
      for (;;) { const x = getLine(1); if (!x) { eof2 = true; break; } if (keycmp(s1[0], x, jf1, jf2)) { next2 = x; break; } s2.push(x); }
      if (printPairables) for (const x of s1) for (const y of s2) prjoin(x, y);
      s1 = eof1 ? [] : [next1];
      s2 = eof2 ? [] : [next2];
    }
    // read the tails too, to check their order (unless both files already got a warning)
    const checkTail = check !== 'disabled' && !(warned[0] && warned[1]);
    if ((printUnp[0] || checkTail) && s1.length) {
      if (printUnp[0]) prjoin(s1[0], BLANK);
      if (s2.length) seenUnpairable = true;
      let x;
      while ((x = getLine(0))) { if (printUnp[0]) prjoin(x, BLANK); if (warned[0] && !printUnp[0]) break; }
    }
    if ((printUnp[1] || checkTail) && s2.length) {
      if (printUnp[1]) prjoin(BLANK, s2[0]);
      if (s1.length) seenUnpairable = true;
      let x;
      while ((x = getLine(1))) { if (printUnp[1]) prjoin(BLANK, x); if (warned[1] && !printUnp[1]) break; }
    }
  } catch (e) {
    if (e instanceof Fatal) { flush(); return 1; }
    throw e;
  }
  flush();
  if (warned[0] || warned[1]) { ctx.err('input is not in sorted order'); return 1; }
  return 0;
};

// GNU comm (coreutils 8.32 comm.c). Order warnings come out where they happen (stdout is flushed
// first), once per file, and only after an unpairable line has been seen (or with --check-order,
// which makes the first one fatal). At the end of a file the last two lines are checked again.
C.comm = (ctx) => {
  const a = parseArgs(ctx, { short: '123z', long: { 'check-order': 'check', 'nocheck-order': 'nocheck', 'output-delimiter': ['od', 'required'], total: 'total', 'zero-terminated': 'z' } });
  if (!a) return 1;
  if (a.operands.length !== 2) { ctx.err(a.operands.length < 2 ? (a.operands.length ? `missing operand after ${qa(a.operands[0])}` : 'missing operand') : `extra operand ${qa(a.operands[2])}`); ctx.stderr.write("Try 'comm --help' for more information.\n"); return 1; }
  const s1 = !a.has('1'), s2 = !a.has('2'), s3 = !a.has('3');
  const od = a.has('od') ? (a.get('od') === '' ? '\0' : a.get('od')) : '\t';
  const sep = a.has('z') ? '\0' : '\n';
  let check = 'default';
  for (const [k] of a.all) { if (k === 'check') check = 'enabled'; else if (k === 'nocheck') check = 'disabled'; }
  let d1, d2;
  try { d1 = ctx.readFile(a.operands[0]); } catch (e) { if (e instanceof FsError) { ctx.err(`${qf(a.operands[0])}: ${e.message}`); return 1; } throw e; }
  try { d2 = ctx.readFile(a.operands[1]); } catch (e) { if (e instanceof FsError) { ctx.err(`${qf(a.operands[1])}: ${e.message}`); return 1; } throw e; }
  const F = [splitLines(d1, sep), splitLines(d2, sep)];
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const n = [0, 0, 0];
  const warned = [false, false];
  let seenUnpairable = false;
  let out = '';
  const flush = () => { if (out) { ctx.out(out); out = ''; } };
  let fatal = false;
  const checkOrder = (prev, cur, w) => {
    if (check === 'disabled' || !(check === 'enabled' || seenUnpairable) || warned[w]) return;
    if (cmp(prev, cur) > 0) {
      flush();
      ctx.err(`file ${w + 1} is not in sorted order`);
      if (check === 'enabled') fatal = true;
      warned[w] = true;
    }
  };
  const pos = [0, 0];
  const cur = (w) => (pos[w] < F[w].length ? F[w][pos[w]] : null);
  while (!fatal && (cur(0) !== null || cur(1) !== null)) {
    const t0 = cur(0), t1 = cur(1);
    const order = t0 === null ? 1 : t1 === null ? -1 : cmp(t0, t1);
    if (order === 0) { n[2]++; if (s3) out += (s1 ? od : '') + (s2 ? od : '') + t1 + sep; }
    else {
      seenUnpairable = true;
      if (order < 0) { n[0]++; if (s1) out += t0 + sep; }
      else { n[1]++; if (s2) out += (s1 ? od : '') + t1 + sep; }
    }
    for (const w of [0, 1]) {
      if (!((w === 0 && order <= 0) || (w === 1 && order >= 0))) continue;
      const i = ++pos[w];
      if (i < F[w].length) checkOrder(F[w][i - 1], F[w][i], w);
      else if (i >= 2) checkOrder(F[w][i - 2], F[w][i - 1], w);   // EOF: look two lines back again
      if (fatal) break;
    }
  }
  if (fatal) { flush(); return 1; }
  if (a.has('total')) out += `${n[0]}${od}${n[1]}${od}${n[2]}${od}total${sep}`;
  flush();
  if (warned[0] || warned[1]) { ctx.err('input is not in sorted order'); return 1; }
  return 0;
};

// ---------------------------------------------------------------- split / shuf / strings
// GNU split (coreutils 8.32, split.c). Input is read through a 128 KiB buffer (io_blksize), which
// shows in where -C and -n l/N cut large inputs, so those modes walk the data buffer by buffer.
const SPLIT_BUFSIZE = 131072;
// A hex start value with letters (--hex-suffixes=a) makes 8.32 index past "0123456789abcdef";
// these are the bytes that follow that string in Ubuntu 22.04's x86-64 /usr/bin/split.
const SPLIT_HEX = '0123456789abcdef\x00/.libs/\x00lt-\x00/usr/share/locale\x000123456789C:a:b:del:n:t:ux\x00';
const SPLIT_HELP = `Usage: split [OPTION]... [FILE [PREFIX]]
Output pieces of FILE to PREFIXaa, PREFIXab, ...;
default size is 1000 lines, and default PREFIX is 'x'.

With no FILE, or when FILE is -, read standard input.

Mandatory arguments to long options are mandatory for short options too.
  -a, --suffix-length=N   generate suffixes of length N (default 2)
      --additional-suffix=SUFFIX  append an additional SUFFIX to file names
  -b, --bytes=SIZE        put SIZE bytes per output file
  -C, --line-bytes=SIZE   put at most SIZE bytes of records per output file
  -d                      use numeric suffixes starting at 0, not alphabetic
      --numeric-suffixes[=FROM]  same as -d, but allow setting the start value
  -x                      use hex suffixes starting at 0, not alphabetic
      --hex-suffixes[=FROM]  same as -x, but allow setting the start value
  -e, --elide-empty-files  do not generate empty output files with '-n'
      --filter=COMMAND    write to shell COMMAND; file name is $FILE
  -l, --lines=NUMBER      put NUMBER lines/records per output file
  -n, --number=CHUNKS     generate CHUNKS output files; see explanation below
  -t, --separator=SEP     use SEP instead of newline as the record separator;
                            '\\0' (zero) specifies the NUL character
  -u, --unbuffered        immediately copy input to output with '-n r/...'
      --verbose           print a diagnostic just before each
                            output file is opened
      --help     display this help and exit
      --version  output version information and exit

The SIZE argument is an integer and optional unit (example: 10K is 10*1024).
Units are K,M,G,T,P,E,Z,Y (powers of 1024) or KB,MB,... (powers of 1000).
Binary prefixes can be used, too: KiB=K, MiB=M, and so on.

CHUNKS may be:
  N       split into N files based on size of input
  K/N     output Kth of N to stdout
  l/N     split into N files without splitting lines/records
  l/K/N   output Kth of N to stdout without splitting lines/records
  r/N     like 'l' but use round robin distribution
  r/K/N   likewise but only output Kth of N to stdout

GNU coreutils online help: <https://www.gnu.org/software/coreutils/>
Report any translation bugs to <https://translationproject.org/team/>
Full documentation <https://www.gnu.org/software/coreutils/split>
or available locally via: info '(coreutils) split invocation'
`;
const SPLIT_VERSION = `split (GNU coreutils) 8.32
Copyright (C) 2020 Free Software Foundation, Inc.
License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.

Written by Torbjorn Granlund and Richard M. Stallman.
`;
class SplitExit { constructor(code) { this.code = code; } }

C.split = (ctx) => {
  const argv = ctx.argv.slice(1);
  const spec = { name: 'split', short: '0123456789C:a:b:del:n:t:ux', long: {
    bytes: ['b', 'required'], lines: ['l', 'required'], 'line-bytes': ['C', 'required'], number: ['n', 'required'],
    'elide-empty-files': 'e', unbuffered: 'u', 'suffix-length': ['a', 'required'], 'additional-suffix': ['addsuf', 'required'],
    'numeric-suffixes': ['d', 'optional'], 'hex-suffixes': ['x', 'optional'], filter: ['filter', 'required'], verbose: 'verbose',
    separator: ['t', 'required'], '-io-blksize': ['blksize', 'required'], help: 'help', version: 'version',
  } };
  const r = getopt(argv, spec);
  // GNU getopt's optind before each option is returned; obsolete -N digits that come from
  // different arguments start the number afresh (`split f -12` splits every 2 lines)
  const optinds = [];
  {
    const longArg = (name) => {
      const names = Object.keys(spec.long);
      const hit = spec.long[name] ? name : names.find((n) => n.startsWith(name));
      const v = hit && spec.long[hit];
      return Array.isArray(v) ? v[1] : 'none';
    };
    let optind = 1;
    for (let i = 0; i < argv.length && optinds.length < r.opts.length; i++) {
      const s = argv[i], p = i + 1;
      if (s === '--') break;
      if (s.startsWith('--')) {
        optinds.push(optind);
        const eq = s.indexOf('=');
        if (eq < 0 && longArg(s.slice(2)) === 'required') { i++; optind = p + 2; } else optind = p + 1;
      } else if (s.length > 1 && s[0] === '-') {
        for (let j = 1; j < s.length; j++) {
          optinds.push(j === 1 ? optind : p);
          if ('Cabnlt'.includes(s[j])) { if (j === s.length - 1) { i++; optind = p + 2; } else optind = p + 1; break; }
          if (j === s.length - 1) optind = p + 1;
        }
      }
    }
  }
  const lq = (s) => quotearg(s, 'locale');
  const die = (msg) => { ctx.err(msg); throw new SplitExit(1); };
  const usageErr = (msg) => { ctx.err(msg); ctx.stderr.write("Try 'split --help' for more information.\n"); throw new SplitExit(1); };
  // xdectoumax(), with quote() (not quoteaf) around the argument
  const num = (v, min, max, sufs, what) => {
    const x = xdectoumax(v, { min, max, suffixes: sufs, err: what });
    if (!x.ok) die(`${what}: ${lq(v)}${x.msg.slice(`${what}: ${qa(v)}`.length)}`);
    return x.val;
  };
  const OFF_T_MAX = (1n << 63n) - 1n, MULT = 'bEGKkMmPTYZ0';
  let type = 'undef', nUnits = 0n, kUnits = 0n, suffixLength = 0n, alphabet = 'abcdefghijklmnopqrstuvwxyz', numStart = null;
  let addSuffix = null, verbose = false, elide = false, eol = null, filter = null, digitsOptind = 0, bufsize = SPLIT_BUFSIZE;
  const oneWay = () => usageErr('cannot split in more than one way');
  try {
    r.opts.forEach(([k, v], idx) => {
      if (k >= '0' && k <= '9') {
        if (type === 'undef') { type = 'digits'; nUnits = 0n; }
        if (type !== 'digits') oneWay();
        if (digitsOptind !== 0 && digitsOptind !== optinds[idx]) nUnits = 0n;
        digitsOptind = optinds[idx];
        const nv = nUnits * 10n + BigInt(k.charCodeAt(0) - 48);
        if (nv > UINTMAX_MAX) die(`line count option -${nUnits}${k}... is too large`);
        nUnits = nv;
        return;
      }
      switch (k) {
        case 'a': suffixLength = num(v, 0n, UINTMAX_MAX / 8n, '', 'invalid suffix length'); break;
        case 'addsuf': {
          // last_component(optarg) != optarg
          let s = 0;
          while (v[s] === '/') s++;
          let last = s;
          for (let j = s; j < v.length; j++) if (v[j] === '/' && v[j + 1] && v[j + 1] !== '/') last = j + 1;
          if (last !== 0) usageErr(`invalid suffix ${lq(v)}, contains directory separator`);
          addSuffix = v;
          break;
        }
        case 'b': if (type !== 'undef') oneWay(); type = 'bytes'; nUnits = num(v, 1n, OFF_T_MAX, MULT, 'invalid number of bytes'); break;
        case 'l': if (type !== 'undef') oneWay(); type = 'lines'; nUnits = num(v, 1n, UINTMAX_MAX, '', 'invalid number of lines'); break;
        case 'C': if (type !== 'undef') oneWay(); type = 'byteslines'; nUnits = num(v, 1n, OFF_T_MAX, MULT, 'invalid number of bytes'); break;
        case 'n': {
          if (type !== 'undef') oneWay();
          let s = v.replace(/^[ \t\n\v\f\r]+/, '');
          if (s.startsWith('r/')) { type = 'rr'; s = s.slice(2); } else if (s.startsWith('l/')) { type = 'chunk_lines'; s = s.slice(2); } else type = 'chunk_bytes';
          const slash = s.indexOf('/');
          if (slash >= 0) {
            nUnits = num(s.slice(slash + 1), 1n, UINTMAX_MAX, '', 'invalid number of chunks');
            if (slash > 0) kUnits = num(s.slice(0, slash), 1n, nUnits, '', 'invalid chunk number');
          } else nUnits = num(s, 1n, UINTMAX_MAX, '', 'invalid number of chunks');
          break;
        }
        case 't': {
          let c = v[0];
          if (c === undefined) die('empty record separator');
          if (v.length > 1) { if (v === '\\0') c = '\0'; else die(`multi-character separator ${lq(v)}`); }
          if (eol !== null && c !== eol) die('multiple separator characters specified');
          eol = c;
          break;
        }
        case 'd': case 'x':
          alphabet = k === 'd' ? '0123456789' : '0123456789abcdef';
          if (typeof v === 'string') {
            if ([...v].some((ch) => !alphabet.includes(ch))) usageErr(`${lq(v)}: invalid start value for ${k === 'd' ? 'numerical' : 'hexadecimal'} suffix`);
            numStart = v.replace(/^0+(?=.)/, '');
          }
          break;
        case 'e': elide = true; break;
        case 'filter': filter = v; break;
        case 'blksize': bufsize = Number(num(v, 1n, UINTMAX_MAX - 4096n, MULT, 'invalid IO block size')); break;
        case 'verbose': verbose = true; break;
        case 'help': ctx.out(SPLIT_HELP); throw new SplitExit(0);
        case 'version': ctx.out(SPLIT_VERSION); throw new SplitExit(0);
        default: break;   // -u: the output is the same
      }
    });
    if (r.error) { ctx.stderr.write(r.error + '\n'); ctx.stderr.write("Try 'split --help' for more information.\n"); return 1; }
    if (kUnits !== 0n && filter !== null) usageErr('--filter does not process a chunk extracted to stdout');
    if (type === 'undef') { type = 'lines'; nUnits = 1000n; }
    if (nUnits === 0n) usageErr(`invalid number of lines: ${lq('0')}`);
    if (eol === null) eol = '\n';
    // set_suffix_length()
    let suffixAuto = numStart === null;
    let needed = 0n;
    if (type === 'chunk_bytes' || type === 'chunk_lines' || type === 'rr') {
      let end = nUnits - 1n;
      if (numStart !== null) {
        const x = xstrtol(numStart, '', { max: UINTMAX_MAX, unsigned: true });
        if (x.err === LONGINT_OK && x.val <= UINTMAX_MAX - nUnits && x.val < nUnits) end += x.val;
      }
      const alen = BigInt(alphabet.length);
      do needed++; while ((end /= alen) > 0n);
      suffixAuto = false;
    }
    if (suffixLength) {
      if (suffixLength < needed) die(`the suffix length needs to be at least ${needed}`);
      suffixAuto = false;
    } else suffixLength = needed > 2n ? needed : 2n;
    const ops = r.operands;
    const infile = ops.length > 0 ? ops[0] : '-';
    const outbase = ops.length > 1 ? ops[1] : 'x';
    if (ops.length > 2) usageErr(`extra operand ${lq(ops[2])}`);
    if (numStart !== null && BigInt(numStart.length) > suffixLength) usageErr('numerical suffix start value is too large for the suffix length');

    // the input
    const isStdin = infile === '-' || /^\/(dev\/stdin|dev\/fd\/0|proc\/self\/fd\/0)$/.test(infile);
    let data = '', isDir = false, inNode = null, seekable = true;
    try {
      if (infile !== '-') { const n = ctx.fs.stat(infile, ctx.cwd); if (!isStdin) inNode = n; isDir = n.type === 'd'; }
      if (!isDir) data = ctx.readFile(infile);
    } catch (e) { if (e instanceof FsError) die(`cannot open ${qa(infile)} for reading: ${e.message}`); throw e; }
    if (isStdin) { seekable = !!ctx.stdin.seekable; inNode = ctx.stdin.node || null; }
    else if (/^\/(dev|proc\/self)\/fd\/\d+$/.test(infile)) seekable = false;   // process substitution: a pipe
    const readFail = () => die(`${qf(infile)}: Is a directory`);

    // output file names (next_file_name)
    const sufLen0 = Number(suffixLength);
    const alpha = alphabet === '0123456789abcdef' ? SPLIT_HEX : alphabet + '\0';
    const at = (i) => (i < alpha.length ? alpha[i] : '\0');
    let base = outbase, mid = null, sufIdx = null, sufLen = sufLen0;
    const fileName = () => base + mid.join('') + (addSuffix ?? '');
    const nextFileName = () => {
      if (mid === null) {
        mid = new Array(sufLen).fill(alphabet[0]);
        sufIdx = new Array(sufLen).fill(0);
        if (numStart !== null) {
          const L = numStart.length;
          for (let j = 0; j < L; j++) { mid[sufLen - L + j] = numStart[j]; sufIdx[sufLen - L + j] = numStart.charCodeAt(j) - 48; }
        }
        return;
      }
      for (let i = sufLen - 1; i >= 0; i--) {
        sufIdx[i]++;
        if (suffixAuto && i === 0 && at(sufIdx[0] + 1) === '\0') {
          // widen: the last letter joins the prefix and the suffix grows by one
          base += at(sufIdx[0]);
          sufLen++;
          mid = new Array(sufLen).fill(alphabet[0]);
          sufIdx = new Array(sufLen).fill(0);
          return;
        }
        mid[i] = at(sufIdx[i]);
        if (mid[i] !== '\0') return;
        sufIdx[i] = 0;
        mid[i] = alphabet[0];
      }
      die('output file suffixes exhausted');
    };
    // an open output: a file sink, or the data for a --filter command
    const create = (name) => {
      if (filter !== null) {
        if (verbose) ctx.out(`executing with FILE=${qf(name)}\n`);
        return { name, buf: '' };
      }
      if (verbose) ctx.out(`creating file ${qa(name)}\n`);
      let sink;
      try { sink = ctx.openWrite(name, true); } catch (e) { if (e instanceof FsError) die(`${qf(name)}: ${e.message}`); throw e; }
      if (inNode && sink.node === inNode) die(`${qa(name)} would overwrite input; aborting`);
      if (sink.node && sink.node.type === 'f') { sink.node.data = ''; sink.node.mtime = ctx.fs.now(); }
      return { name, sink };
    };
    const put = (o, s) => { if (!s) return; if (o.sink) o.sink.write(s); else o.buf += s; };
    const closeout = (o) => {
      if (!o || o.sink) return;
      const st = ctx.runShell(filter, { stdin: o.buf, env: { ...(ctx.env || {}), FILE: o.name } });
      if (st && st !== 141) { ctx.err(`with FILE=${qf(o.name)}, exit ${st} from command: ${filter}`); throw new SplitExit(st); }
    };
    let cur = null;
    const cwrite = (newFile, s) => {
      if (newFile) {
        if (s === null && elide) return;
        closeout(cur);
        cur = null;
        nextFileName();
        cur = create(fileName());
        if (ctx.tick) ctx.tick();
      }
      put(cur, s);
    };
    const memrchr = (buf, start, len) => { if (len <= 0) return -1; const j = buf.lastIndexOf(eol, start + len - 1); return j >= start ? j : -1; };

    // the split modes
    if (type === 'lines' || type === 'digits') {
      if (isDir) readFail();
      let pos = 0;
      while (pos < data.length) {
        let end = pos;
        for (let k = 0n; k < nUnits; k++) { const j = data.indexOf(eol, end); if (j < 0) { end = data.length; break; } end = j + 1; }
        cwrite(true, data.slice(pos, end));
        pos = end;
      }
    } else if (type === 'bytes' || (type === 'chunk_bytes' && kUnits === 0n)) {
      let nb, maxFiles = 0;
      if (type === 'chunk_bytes') {
        if (isDir) die(`${qf(infile)}: cannot determine file size: Is a directory`);
        if (!seekable) die(`${qf(infile)}: cannot determine file size`);
        if (nUnits > OFF_T_MAX) die(`invalid number of chunks: ${lq(String(nUnits))}: Value too large for defined data type`);
        const size = data.length > Number(nUnits) ? data.length : Number(nUnits);
        nb = Math.floor(size / Number(nUnits));
        maxFiles = Number(nUnits);
      } else { if (isDir) readFail(); nb = Number(nUnits); }
      let opened = 0, pos = 0;
      while (pos < data.length) {
        if (maxFiles && opened >= maxFiles) { cwrite(false, data.slice(pos)); break; }
        const end = Math.min(pos + nb, data.length);
        cwrite(true, data.slice(pos, end));
        opened++;
        pos = end;
      }
      while (opened++ < maxFiles) cwrite(true, null);
    } else if (type === 'chunk_bytes' || type === 'chunk_lines') {
      if (isDir) die(`${qf(infile)}: cannot determine file size: Is a directory`);
      if (!seekable) die(`${qf(infile)}: cannot determine file size`);
      if (nUnits > OFF_T_MAX) die(`invalid number of chunks: ${lq(String(nUnits))}: Value too large for defined data type`);
      const n = Number(nUnits), k = Number(kUnits);
      const fileSize = data.length > n ? data.length : n;
      if (type === 'chunk_bytes') {
        // bytes_chunk_extract(). A chunk starting past the first buffer is reached with
        // lseek(start, SEEK_CUR) after that buffer was read, so 8.32 starts that much later.
        const chunk = Math.floor(fileSize / n);
        const start = (k - 1) * chunk, end = k === n ? fileSize : k * chunk;
        const initial = Math.min(data.length, bufsize);
        ctx.out(start < initial ? data.slice(start, end) : data.slice(initial + start, initial + end));
      } else {
        // lines_chunk_split()
        const chunkSize = Math.floor(fileSize / n);
        let chunkNo = 1, chunkEnd = chunkSize - 1, nWritten = 0, newFile = true, truncated = false;
        let initial = data.slice(0, Math.min(data.length, bufsize)), rpos = initial.length;
        if (k > 1) {
          const start = (k - 1) * chunkSize - 1;
          if (start < initial.length) initial = initial.slice(start);
          else { rpos = start; initial = null; }
          nWritten = start;
          chunkNo = k - 1;
          chunkEnd = chunkNo * chunkSize - 1;
        }
        let done = false;
        while (!done && nWritten < fileSize) {
          let buf;
          if (initial !== null) { buf = initial; initial = null; } else { buf = data.slice(rpos, rpos + bufsize); rpos += buf.length; }
          if (!buf.length) break;
          let nRead = Math.min(buf.length, fileSize - nWritten);
          truncated = false;
          let bp = 0;
          const eob = nRead;
          while (bp !== eob) {
            let next = false;
            const skip = Math.min(nRead, Math.max(0, chunkEnd - nWritten));
            let bpOut = buf.indexOf(eol, bp + skip);
            if (bpOut >= 0 && bpOut < eob) { bpOut++; next = true; } else bpOut = eob;
            const piece = buf.slice(bp, bpOut);
            if (k === chunkNo) ctx.out(piece);
            else if (!k) cwrite(newFile, piece);
            nWritten += piece.length;
            bp = bpOut;
            nRead -= piece.length;
            newFile = next;
            // a long line can cover whole chunks: they get empty files
            while (next || chunkEnd <= nWritten - 1) {
              if (!next && bp === eob) { truncated = true; break; }
              chunkNo++;
              if (k && chunkNo > k) { done = true; break; }
              if (chunkNo === n) chunkEnd = fileSize - 1; else chunkEnd += chunkSize;
              if (chunkEnd <= nWritten - 1) { if (!k) cwrite(true, null); } else next = false;
            }
            if (done) break;
          }
        }
        if (!done) {
          if (truncated) chunkNo++;
          while (!k && chunkNo++ <= n) cwrite(true, null);
        }
      }
    } else if (type === 'byteslines') {
      // line_bytes_split()
      if (isDir) readFail();
      const nb = Number(nUnits);
      let rpos = 0, nOut = 0, hold = '', splitLine = false;
      for (;;) {
        const buf = data.slice(rpos, rpos + bufsize);
        rpos += buf.length;
        let nLeft = buf.length, sob = 0;
        while (nLeft) {
          let splitRest = 0, eoc = -1, eolAt;
          if (nb - nOut - hold.length <= nLeft) {
            splitRest = nb - nOut - hold.length;
            eoc = sob + splitRest - 1;
            eolAt = memrchr(buf, sob, splitRest);
          } else eolAt = memrchr(buf, sob, nLeft);
          if (hold.length && !(eolAt < 0 && nOut)) { cwrite(nOut === 0, hold); nOut += hold.length; hold = ''; }
          if (eolAt >= 0) {
            splitLine = true;
            const w = eolAt - sob + 1;
            cwrite(nOut === 0, buf.slice(sob, sob + w));
            nOut += w; nLeft -= w; sob += w;
            if (eoc >= 0) splitRest -= w;
          }
          if (nLeft && !splitLine) {
            const w = eoc >= 0 ? splitRest : nLeft;
            cwrite(nOut === 0, buf.slice(sob, sob + w));
            nOut += w; nLeft -= w; sob += w;
            if (eoc >= 0) splitRest -= w;
          }
          if ((eoc >= 0 && splitRest) || (eoc < 0 && nLeft)) {
            const w = eoc >= 0 ? splitRest : nLeft;
            hold += buf.slice(sob, sob + w);
            nLeft -= w; sob += w;
          }
          if (eoc >= 0) { nOut = 0; splitLine = false; }
        }
        if (!buf.length) break;
      }
      if (hold.length) cwrite(nOut === 0, hold);
    } else {
      // lines_rr(): round robin
      const n = Number(nUnits), k = kUnits;
      if (k) {
        if (isDir) readFail();
        let lineNo = 1n, pos = 0, out = '';
        while (pos < data.length) {
          const j = data.indexOf(eol, pos);
          const end = j < 0 ? data.length : j + 1;
          if (lineNo === k) out += data.slice(pos, end);
          if (j >= 0) lineNo = lineNo === nUnits ? 1n : lineNo + 1n;
          pos = end;
        }
        ctx.out(out);
      } else {
        const files = [];
        for (let i = 0; i < n; i++) { nextFileName(); files.push({ name: fileName(), o: null }); if (ctx.tick) ctx.tick(); }
        if (isDir) readFail();
        let iFile = 0, wrapped = false, pos = 0;
        while (pos < data.length) {
          const j = data.indexOf(eol, pos);
          const end = j < 0 ? data.length : j + 1;
          const f = files[iFile];
          if (!f.o) f.o = create(f.name);
          put(f.o, data.slice(pos, end));
          if (j >= 0 && ++iFile === n) { wrapped = true; iFile = 0; }
          pos = end;
        }
        const ceiling = wrapped ? n : iFile;
        for (let i = 0; i < n; i++) {
          if (i >= ceiling && !elide && !files[i].o) files[i].o = create(files[i].name);
          closeout(files[i].o);
        }
      }
    }
    closeout(cur);
  } catch (e) { if (e instanceof SplitExit) return e.code; throw e; }
  return 0;
};

C.shuf = (ctx) => {
  const a = parseArgs(ctx, { short: 'ei:n:o:rz', long: { echo: 'e', 'input-range': ['i', 'required'], 'head-count': ['n', 'required'], output: ['o', 'required'], repeat: 'r', 'zero-terminated': 'z', 'random-source': ['rs', 'required'] } });
  if (!a) return 1;
  let items;
  if (a.has('e')) items = a.operands;
  else if (a.has('i')) { const [lo, hi] = a.get('i').split('-').map(Number); items = []; for (let k = lo; k <= hi; k++) items.push(String(k)); }
  else { try { items = splitLines(ctx.readFile(a.operands[0] || '-')); } catch (e) { ctx.err(readErrMsg(ctx, a.operands[0], e)); return 1; } }
  const rnd = () => ctx.sh.random() / 4294967296;
  const n = a.has('n') ? parseInt(a.get('n'), 10) : (a.has('r') ? Infinity : items.length);
  let out = [];
  if (a.has('r')) { if (!items.length) return 0; for (let k = 0; k < Math.min(n, 100000); k++) out.push(items[Math.floor(rnd() * items.length)]); }
  else {
    const arr = [...items];
    for (let k = arr.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [arr[k], arr[j]] = [arr[j], arr[k]]; }
    out = arr.slice(0, n);
  }
  const text = out.map(x => x + '\n').join('');
  if (a.has('o')) ctx.openWrite(a.get('o')).write(text); else ctx.out(text);
  return 0;
};

C.strings = (ctx) => {
  let argv = ctx.argv.slice(1).map(x => (/^-\d+$/.test(x) ? '-n' + x.slice(1) : x));
  const a = parseArgs(ctx, { short: 'adfn:t:e:w', long: { all: 'a', 'print-file-name': 'f', bytes: ['n', 'required'], radix: ['t', 'required'], encoding: ['e', 'required'] } }, argv);
  if (!a) return 1;
  const min = a.has('n') ? parseInt(a.get('n'), 10) : 4;
  const radix = a.get('t');
  return eachInput(ctx, a.operands, (data, name) => {
    let out = '';
    const re = new RegExp(`[\\x20-\\x7e\\t]{${min},}`, 'g');
    let m;
    while ((m = re.exec(data))) {
      let pre = a.has('f') ? name + ': ' : '';
      if (radix) pre += (radix === 'x' ? m.index.toString(16) : radix === 'o' ? m.index.toString(8) : String(m.index)).padStart(7) + ' ';
      out += pre + m[0] + '\n';
    }
    ctx.out(out);
    return 0;
  });
};

C.ul = (ctx) => eachInput(ctx, ctx.argv.slice(1).filter(x => !x.startsWith('-')), (d) => { ctx.out(d.replace(/_\x08(.)/g, '$1').replace(/(.)\x08\1/g, '$1')); return 0; });

// ---------------------------------------------------------------- basename / dirname
C.basename = (ctx) => {
  const a = parseArgs(ctx, { short: 'as:z', long: { multiple: 'a', suffix: ['s', 'required'], zero: 'z' } });
  if (!a) return 1;
  const nl = a.has('z') ? '\0' : '\n';
  const strip = (name, suf) => {
    let s = name.replace(/\/+$/, '');
    if (s === '' && name.startsWith('/')) return '/';
    s = s.slice(s.lastIndexOf('/') + 1);
    if (suf && s !== suf && s.endsWith(suf)) s = s.slice(0, -suf.length);
    return s;
  };
  if (!a.operands.length) { ctx.err('missing operand'); ctx.stderr.write("Try 'basename --help' for more information.\n"); return 1; }
  if (a.has('a') || a.has('s')) { ctx.out(a.operands.map(n => strip(n, a.get('s')) + nl).join('')); return 0; }
  if (a.operands.length > 2) { ctx.err(`extra operand ${qa(a.operands[2])}`); ctx.stderr.write("Try 'basename --help' for more information.\n"); return 1; }
  ctx.out(strip(a.operands[0], a.operands[1]) + nl);
  return 0;
};

C.dirname = (ctx) => {
  const a = parseArgs(ctx, { short: 'z', long: { zero: 'z' } });
  if (!a) return 1;
  if (!a.operands.length) { ctx.err('missing operand'); ctx.stderr.write("Try 'dirname --help' for more information.\n"); return 1; }
  const nl = a.has('z') ? '\0' : '\n';
  const dn = (p) => {
    let s = p.replace(/\/+$/, '');
    if (s === '') return p.startsWith('/') ? '/' : '.';
    const i = s.lastIndexOf('/');
    if (i < 0) return '.';
    s = s.slice(0, i).replace(/\/+$/, '');
    return s === '' ? '/' : s;
  };
  ctx.out(a.operands.map(p => dn(p) + nl).join(''));
  return 0;
};

export default C;
