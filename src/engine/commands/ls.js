// ls / dir / vdir (GNU coreutils 8.32): option decoding, sorting, the long format and the
// many-per-line, horizontal and with-commas layouts follow ls.c. Output is never a terminal
// here, so the defaults are those of `ls | ...`: one name per line, literal quoting.
import { getopt, qa, filevercmp, fileNameConcat, quotearg, QUOTING_STYLES, xstrtol, LONGINT_OK, LONGINT_OVERFLOW } from './util.js';
import { FsError, modeString, byteCmp } from '../vfs.js';
import { strftime } from '../timefmt.js';
import { fnmatch } from '../pattern.js';

const C = {};

const USERS = { 0: 'root', 1: 'daemon', 2: 'bin', 3: 'sys', 65534: 'nobody', 1000: 'player' };
const GROUPS = { 0: 'root', 1: 'daemon', 2: 'bin', 3: 'sys', 65534: 'nogroup', 1000: 'player' };
const blocksK = (n) => (n.type === 'd' ? 4 : n.type === 'f' ? Math.ceil(n.size / 4096) * 4 : 0);
const RDEV = { null: [1, 3], zero: [1, 5], full: [1, 7], random: [1, 8], urandom: [1, 9], tty: [5, 0] };

// argmatch tables: [names, values]
const ARGS = {
  sort: [['none', 'time', 'size', 'extension', 'version'], ['none', 'time', 'size', 'extension', 'version']],
  time: [['atime', 'access', 'use', 'ctime', 'status', 'birth', 'creation'], ['atime', 'atime', 'atime', 'ctime', 'ctime', 'btime', 'btime']],
  format: [['verbose', 'long', 'commas', 'horizontal', 'across', 'vertical', 'single-column'], ['long', 'long', 'commas', 'horizontal', 'horizontal', 'many', 'one']],
  color: [['always', 'yes', 'force', 'never', 'no', 'none', 'auto', 'tty', 'if-tty'], ['always', 'always', 'always', 'never', 'never', 'never', 'tty', 'tty', 'tty']],
  'indicator-style': [['none', 'slash', 'file-type', 'classify'], ['none', 'slash', 'file-type', 'classify']],
  'quoting-style': [QUOTING_STYLES, QUOTING_STYLES],
};
const TIME_STYLES = ['full-iso', 'long-iso', 'iso', 'locale'];

class LsExit { constructor(st) { this.st = st; } }

// the TERM types dircolors knows to have colors
const COLOR_TERMS = ['Eterm', 'ansi', '*color*', 'con[0-9]*x[0-9]*', 'cons25', 'console', 'cygwin', 'dtterm', 'gnome', 'hurd', 'jfbterm', 'konsole', 'kterm', 'linux', 'linux-c', 'mlterm', 'putty', 'rxvt*', 'screen*', 'st', 'terminator', 'tmux*', 'vt100', 'xterm*'];
function lsColors(env) {
  const c = {
    lc: '\x1b[', rc: 'm', ec: null, rs: '0', no: null, fi: null, di: '01;34', ln: '01;36', pi: '33', so: '01;35', bd: '01;33',
    cd: '01;33', mi: null, or: null, ex: '01;32', do: '01;35', su: '37;41', sg: '30;43', st: '37;44', ow: '34;42', tw: '30;42',
    ca: '30;41', mh: null, cl: '\x1b[K', ext: [], lnTarget: false,
  };
  const spec = env.LS_COLORS;
  if (!spec) {
    const term = env.TERM;
    if (!env.COLORTERM && !(term && COLOR_TERMS.some(p => fnmatch(p, term, { extglob: false })))) return null;
    return c;
  }
  for (const item of spec.split(':')) {
    const eq = item.indexOf('=');
    if (eq < 0) continue;
    const k = item.slice(0, eq), v = item.slice(eq + 1);
    if (k[0] === '*') c.ext.push([k.slice(1).toLowerCase(), v]);
    else if (k === 'ln' && v === 'target') c.lnTarget = true;
    else if (Object.prototype.hasOwnProperty.call(c, k)) c[k] = v;
  }
  return c;
}

// argmatch: exact match, else a unique abbreviation (or several naming the same value)
function argmatch(arg, names, values) {
  let found = -1, ambiguous = false;
  for (let i = 0; i < names.length; i++) {
    if (names[i] === arg) return i;
    if (names[i].startsWith(arg)) {
      if (found < 0) found = i;
      else if (values[found] !== values[i]) ambiguous = true;
    }
  }
  return ambiguous ? -2 : found;
}

function argmatchDie(ctx, what, arg, res, names, values) {
  let s = `ls: ${res === -2 ? 'ambiguous' : 'invalid'} argument ${qa(arg)} for ${qa(what)}\nValid arguments are:`;
  for (let i = 0; i < names.length; i++) {
    if (i === 0 || values[i] !== values[i - 1]) s += `\n  - ${qa(names[i])}`;
    else s += `, ${qa(names[i])}`;
  }
  ctx.stderr.write(s + "\nTry 'ls --help' for more information.\n");
  throw new LsExit(1);
}

// human_readable with human_autoscale | human_SI | human_base_1024 (ceiling rounding)
function humanSize(n, si = false) {
  const base = si ? 1000 : 1024;
  if (n < base) return String(n);
  const units = 'KMGTPEZY';
  let v = n, u = -1;
  while (v >= base && u < units.length - 1) { v /= base; u++; }
  let s;
  if (v < 10) {
    s = (Math.ceil(v * 10 - 1e-9) / 10).toFixed(1);
    if (parseFloat(s) >= 10) s = '10';
  } else s = String(Math.ceil(v - 1e-9));
  if (s === String(base) && u < units.length - 1) { s = '1.0'; u++; }
  return s + (si && units[u] === 'K' ? 'k' : units[u]);
}

C.ls = C.dir = C.vdir = (ctx) => {
  const out = { s: '', write(x) { this.s += x; } };
  let status = 0;
  try { status = ls(ctx, out); }
  catch (e) {
    ctx.out(out.s);
    if (e instanceof LsExit) return e.st;
    throw e;
  }
  ctx.out(out.s);
  return status;
};

function ls(ctx, out) {
  const env = ctx.env || {};
  const mode = ctx.name === 'dir' ? 'dir' : ctx.name === 'vdir' ? 'vdir' : 'ls';
  let format = mode === 'dir' ? 'many' : mode === 'vdir' ? 'long' : 'one';
  let quoting = mode === 'ls' ? 'literal' : 'escape';
  let qmark = false;
  let timeType = 'mtime', sortType = 'name', sortReverse = false, numericIds = false, printBlockSize = false;
  let indicatorStyle = 'none', printInode = false, deref = null, recursive = false, immediateDirs = false;
  let ignoreMode = 'default';
  const ignorePatterns = [], hidePatterns = [];
  let printOwner = true, printGroup = true, printAuthor = false, dirsFirst = false;
  let human = null, kibibytes = false, color = false, timeStyle = null, sortSpecified = false;
  let status = 0;
  const fail = (msg, serious) => { ctx.err(msg); status = serious ? 2 : Math.max(status, 1); };

  if (env.QUOTING_STYLE !== undefined) {
    const i = QUOTING_STYLES.indexOf(env.QUOTING_STYLE);
    if (i >= 0) quoting = QUOTING_STYLES[i];
    else ctx.err(`ignoring invalid value of environment variable QUOTING_STYLE: ${qa(env.QUOTING_STYLE)}`);
  }
  let lineLength = 80;
  const setLineLength = (spec) => {
    const r = xstrtol(spec, '', { base: 0, max: (1n << 64n) - 1n, unsigned: true });
    if (r.err === LONGINT_OK) { lineLength = r.val > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(r.val); return true; }
    if (r.err === LONGINT_OVERFLOW) { lineLength = Number.MAX_SAFE_INTEGER; return true; }
    return false;
  };
  if (env.COLUMNS) { if (!setLineLength(env.COLUMNS)) ctx.err(`ignoring invalid width in environment variable COLUMNS: ${qa(env.COLUMNS)}`); }
  let tabsize = 8;
  if (env.TABSIZE !== undefined) {
    const r = xstrtol(env.TABSIZE, '', { base: 0, unsigned: true });
    if (r.err === LONGINT_OK) tabsize = Number(r.val);
    else ctx.err(`ignoring invalid tab size in environment variable TABSIZE: ${qa(env.TABSIZE)}`);
  }

  const r = getopt(ctx.argv.slice(1), {
    name: ctx.name,
    short: 'abcdfghiklmnopqrstuvw:xABCDFGHI:LNQRST:UXZ1',
    long: {
      all: 'a', 'almost-all': 'A', author: 'author', escape: 'b', 'block-size': ['bs', 'required'], 'ignore-backups': 'B',
      color: ['color', 'optional'], colour: ['color', 'optional'], directory: 'd', dired: 'D', classify: 'F', 'file-type': 'ftype',
      format: ['format', 'required'], 'full-time': 'fulltime', 'group-directories-first': 'gdf', 'no-group': 'G',
      'human-readable': 'h', si: 'si', 'dereference-command-line': 'H', 'dereference-command-line-symlink-to-dir': 'Hdir',
      hide: ['hide', 'required'], hyperlink: ['hyperlink', 'optional'], 'indicator-style': ['istyle', 'required'], inode: 'i',
      ignore: ['I', 'required'], kibibytes: 'k', dereference: 'L', literal: 'N', 'numeric-uid-gid': 'n',
      'hide-control-chars': 'q', 'show-control-chars': 'scc', 'quote-name': 'Q', 'quoting-style': ['qstyle', 'required'],
      reverse: 'r', recursive: 'R', size: 's', sort: ['sort', 'required'], time: ['time', 'required'],
      'time-style': ['tstyle', 'required'], tabsize: ['T', 'required'], width: ['w', 'required'], context: 'Z',
      help: 'help', version: 'version',
    },
  });
  const pick = (what, v) => {
    const [names, values] = ARGS[what];
    const i = argmatch(v, names, values);
    if (i < 0) argmatchDie(ctx, `--${what}`, v, i, names, values);
    return values[i];
  };
  for (const [k, v] of r.opts) {
    switch (k) {
      case 'a': ignoreMode = 'minimal'; break;
      case 'b': quoting = 'escape'; break;
      case 'c': timeType = 'ctime'; break;
      case 'd': immediateDirs = true; break;
      case 'f': ignoreMode = 'minimal'; sortType = 'none'; sortSpecified = true; if (format === 'long') format = 'one'; printBlockSize = false; color = false; break;
      case 'ftype': indicatorStyle = 'file-type'; break;
      case 'g': format = 'long'; printOwner = false; break;
      case 'h': human = 'iec'; break;
      case 'i': printInode = true; break;
      case 'k': kibibytes = true; break;
      case 'l': format = 'long'; break;
      case 'm': format = 'commas'; break;
      case 'n': numericIds = true; format = 'long'; break;
      case 'o': format = 'long'; printGroup = false; break;
      case 'p': indicatorStyle = 'slash'; break;
      case 'q': qmark = true; break;
      case 'r': sortReverse = true; break;
      case 's': printBlockSize = true; break;
      case 't': sortType = 'time'; sortSpecified = true; break;
      case 'u': timeType = 'atime'; break;
      case 'v': sortType = 'version'; sortSpecified = true; break;
      case 'w': if (!setLineLength(v)) { ctx.err(`invalid line width: ${qa(v)}`); throw new LsExit(2); } break;
      case 'x': format = 'horizontal'; break;
      case 'A': ignoreMode = 'dotdot'; break;
      case 'B': ignorePatterns.push('*~', '.*~'); break;
      case 'C': format = 'many'; break;
      case 'D': break;
      case 'F': indicatorStyle = 'classify'; break;
      case 'G': printGroup = false; break;
      case 'H': deref = 'cmdline'; break;
      case 'Hdir': deref = 'cmdline-dir'; break;
      case 'I': ignorePatterns.push(v); break;
      case 'L': deref = 'always'; break;
      case 'N': quoting = 'literal'; break;
      case 'Q': quoting = 'c'; break;
      case 'R': recursive = true; break;
      case 'S': sortType = 'size'; sortSpecified = true; break;
      case 'T': {
        const x = xstrtol(v, '', { unsigned: true });
        if (x.err !== LONGINT_OK) { ctx.err(`invalid tab size: ${qa(v)}`); throw new LsExit(2); }
        tabsize = Number(x.val);
        break;
      }
      case 'U': sortType = 'none'; sortSpecified = true; break;
      case 'X': sortType = 'extension'; sortSpecified = true; break;
      case '1': if (format !== 'long') format = 'one'; break;
      case 'author': printAuthor = true; break;
      case 'hide': hidePatterns.push(v); break;
      case 'sort': sortType = pick('sort', v); sortSpecified = true; break;
      case 'gdf': dirsFirst = true; break;
      case 'time': timeType = pick('time', v); break;
      case 'format': format = pick('format', v); break;
      case 'fulltime': format = 'long'; timeStyle = 'full-iso'; break;
      case 'color': { const w = v === null || v === undefined ? 'always' : pick('color', v); color = w === 'always'; if (color) tabsize = 0; break; }
      case 'hyperlink': if (v !== null && v !== undefined) pick('color', v); break;
      case 'istyle': indicatorStyle = pick('indicator-style', v); break;
      case 'qstyle': quoting = pick('quoting-style', v); break;
      case 'tstyle': timeStyle = v; break;
      case 'scc': qmark = false; break;
      case 'bs': break;
      case 'si': human = 'si'; break;
      case 'Z': break;
      default: break;
    }
  }
  if (r.error) { ctx.stderr.write(r.error + '\n' + `Try '${ctx.name} --help' for more information.\n`); throw new LsExit(2); }

  // the time formats of the long listing ([0]: not recent, [1]: recent)
  let timeFormats = ['%b %e  %Y', '%b %e %H:%M'];
  if ((timeType === 'ctime' || timeType === 'atime' || timeType === 'btime') && !sortSpecified && format !== 'long') sortType = 'time';
  if (format === 'long') {
    let style = timeStyle ?? env.TIME_STYLE ?? 'locale';
    let posix = false;
    while (style.startsWith('posix-')) { posix = true; style = style.slice(6); }
    if (!posix) {
      if (style[0] === '+') {
        const p0 = style.slice(1);
        const nl = p0.indexOf('\n');
        if (nl < 0) timeFormats = [p0, p0];
        else {
          if (p0.indexOf('\n', nl + 1) >= 0) { ctx.err(`invalid time style format ${qa(p0)}`); throw new LsExit(2); }
          timeFormats = [p0.slice(0, nl), p0.slice(nl + 1)];
        }
      } else {
        const i = argmatch(style, TIME_STYLES, TIME_STYLES);
        if (i < 0) {
          ctx.stderr.write(`ls: ${i === -2 ? 'ambiguous' : 'invalid'} argument ${qa(style)} for 'time style'\nValid arguments are:\n`
            + TIME_STYLES.map(s => `  - [posix-]${s}\n`).join('') + "  - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n"
            + "Try 'ls --help' for more information.\n");
          throw new LsExit(2);
        }
        switch (TIME_STYLES[i]) {
          case 'full-iso': timeFormats = ['%Y-%m-%d %H:%M:%S.%N %z', '%Y-%m-%d %H:%M:%S.%N %z']; break;
          case 'long-iso': timeFormats = ['%Y-%m-%d %H:%M', '%Y-%m-%d %H:%M']; break;
          case 'iso': timeFormats = ['%Y-%m-%d ', '%m-%d %H:%M']; break;
          default: break;
        }
      }
    }
  }
  if (deref === null) deref = immediateDirs || indicatorStyle === 'classify' || format === 'long' ? 'never' : 'cmdline-dir';

  // quote these too: a space for --escape, the indicator characters when they are shown
  const qtt = new Set();
  if (quoting === 'escape') qtt.add(' ');
  if (indicatorStyle === 'file-type') for (const c of '=>@|') qtt.add(c);
  if (indicatorStyle === 'classify') for (const c of '*=>@|') qtt.add(c);
  const alignQuotes = format !== 'commas' && format !== 'one' && (lineLength || format === 'long')
    && (quoting === 'shell' || quoting === 'shell-escape' || quoting === 'c-maybe');
  const maxIdx = Math.floor(lineLength / 3) + (lineLength % 3 !== 0 ? 1 : 0);
  let curTime = ctx.fs.now();

  const lstat = (p) => ctx.fs.lstat(p, ctx.cwd);
  const stat = (p) => ctx.fs.stat(p, ctx.cwd);
  const quoteName = (name, opts = {}) => {
    let q = quotearg(name, quoting, { quoteTheseToo: opts.qtt ?? qtt });
    if (qmark && (quoting === 'shell' || quoting === 'shell-always' || quoting === 'literal')) q = q.replace(/[^\x20-\x7e]/g, '?');
    return q;
  };
  const dispWidth = (s) => { let w = 0; for (let i = 0; i < s.length; i++) { const b = s.charCodeAt(i); if (b >= 32 && b < 127) w++; } return w; };

  // gobble_file
  const gobble = (list, name, dirname, cmdline) => {
    const full = dirname === null || name[0] === '/' ? name : attach(dirname, name);
    const f = { name, full, node: null, ok: false, linkname: null, linkmode: null, linkok: false, type: null };
    let node = null;
    try {
      if (deref === 'always') node = stat(full);
      else if (cmdline && (deref === 'cmdline' || deref === 'cmdline-dir')) {
        let err = null;
        try { node = stat(full); } catch (e) { err = e; }
        if (deref === 'cmdline-dir' && (err ? err.code === 'ENOENT' : node.type !== 'd')) node = lstat(full);
        else if (err) throw err;
      } else node = lstat(full);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      fail(`cannot access ${qa(full)}: ${e.message}`, cmdline);
      if (cmdline) return;
      list.push(f);
      return;
    }
    f.node = node;
    f.ok = true;
    f.type = node.type === 'd' ? (cmdline && !immediateDirs ? 'argdir' : 'dir') : node.type;
    if (node.type === 'l' && (format === 'long' || indicatorStyle === 'file-type' || indicatorStyle === 'classify')) {
      f.linkname = node.target;
      if (indicatorStyle === 'file-type' || indicatorStyle === 'classify' || format === 'long') {
        try { const t = stat(full); f.linkok = true; f.linkmode = t; } catch { /* dangling */ }
      }
    }
    list.push(f);
  };
  const attach = (dirname, name) => (dirname === '.' ? name : dirname.endsWith('/') ? dirname + name : dirname + '/' + name);

  const isDirectory = (f) => f.type === 'dir' || f.type === 'argdir';
  const isLinkedDir = (f) => isDirectory(f) || (f.type === 'l' && f.linkmode && f.linkmode.type === 'd');
  const timeOf = (n) => n[timeType] ?? n.mtime;
  const extOf = (name) => { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i); };
  const sortFiles = (files) => {
    let cmp;
    switch (sortType) {
      case 'none': cmp = null; break;
      case 'time': cmp = (a, b) => (timeOf(b.node || {}) - timeOf(a.node || {})) || byteCmp(a.name, b.name); break;
      case 'size': cmp = (a, b) => ((b.node ? b.node.size : 0) - (a.node ? a.node.size : 0)) || byteCmp(a.name, b.name); break;
      case 'extension': cmp = (a, b) => byteCmp(extOf(a.name), extOf(b.name)) || byteCmp(a.name, b.name); break;
      case 'version': cmp = (a, b) => filevercmp(a.name, b.name); break;
      default: cmp = (a, b) => byteCmp(a.name, b.name);
    }
    let c = cmp;
    if (c && sortReverse) { const base = c; c = (a, b) => base(b, a); }
    if (dirsFirst) {
      const base = c;
      c = (a, b) => { const ad = isLinkedDir(a), bd = isLinkedDir(b); if (ad && !bd) return -1; if (!ad && bd) return 1; return base ? base(a, b) : 0; };
    }
    if (c) files.sort(c);
  };

  // widths of the columns of a listing
  const humanOrBlocks = (k) => (human ? (k ? humanSize(k * 1024, human === 'si') : '0') : String(k));
  const blocksStr = (f) => (f.ok ? humanOrBlocks(blocksK(f.node)) : '?');
  const sizeStr = (f) => {
    if (!f.ok) return '?';
    if (f.node.type === 'c') return '';
    return human ? humanSize(f.node.size, human === 'si') : String(f.node.size);
  };
  const userStr = (id, names) => (numericIds ? null : names[id] ?? null);
  const widths = (files) => {
    const w = { ino: 0, blocks: 0, nlink: 0, owner: 0, group: 0, author: 0, size: 0, major: 0, minor: 0 };
    for (const f of files) {
      if (printInode) w.ino = Math.max(w.ino, f.ok ? String(f.node.ino).length : 1);
      if (printBlockSize) w.blocks = Math.max(w.blocks, blocksStr(f).length);
      if (format !== 'long') continue;
      w.nlink = Math.max(w.nlink, f.ok ? String(f.node.nlink).length : 1);
      if (f.ok) {
        const ow = (id, names) => { const s = userStr(id, names); return s === null ? String(id).length : s.length; };
        if (printOwner) w.owner = Math.max(w.owner, ow(f.node.uid, USERS));
        if (printGroup) w.group = Math.max(w.group, ow(f.node.gid, GROUPS));
        if (printAuthor) w.author = Math.max(w.author, ow(f.node.uid, USERS));
        if (f.node.type === 'c') {
          const d = RDEV[f.node.dev] || [1, 3];
          w.major = Math.max(w.major, String(d[0]).length);
          w.minor = Math.max(w.minor, String(d[1]).length);
          w.size = Math.max(w.size, w.major + 2 + w.minor);
        } else w.size = Math.max(w.size, sizeStr(f).length);
      } else w.size = Math.max(w.size, 1);
    }
    return w;
  };

  const typeIndicator = (ok, n, type) => {
    // get_type_indicator
    if (ok ? n.type === 'f' : type === 'f') return ok && indicatorStyle === 'classify' && (n.mode & 0o111) ? '*' : '';
    if (ok ? n.type === 'd' : (type === 'dir' || type === 'argdir')) return '/';
    if (indicatorStyle === 'slash') return '';
    if (ok ? n.type === 'l' : type === 'l') return '@';
    if (ok ? n.type === 'p' : type === 'p') return '|';
    if (ok ? n.type === 's' : type === 's') return '=';
    return '';
  };

  const fmtTime = (n) => {
    const t = timeOf(n);
    const d = new Date(t);
    // a file seemingly from the future makes ls look at the clock again
    if (curTime < t) curTime = ctx.fs.now();
    const sixMonthsAgo = curTime - 31556952000 / 2;
    const recent = sixMonthsAgo < t && t <= curTime;
    let fmt = timeFormats[recent ? 1 : 0];
    fmt = fmt.replace(/%N/g, String((t % 1000 + 1000) % 1000 * 1000000).padStart(9, '0'));
    return strftime(fmt, d);
  };

  let someQuoted = false;
  const nameOf = (f, symlinkTarget = false) => quoteName(symlinkTarget ? f.linkname : f.name);
  const padFor = (f) => alignQuotes && someQuoted && nameOf(f) === f.name;

  // --color: the built-in colors, or LS_COLORS; nothing without a known terminal type
  const colors = color ? lsColors(env) : null;
  let usedColor = false;
  const colorOf = (f, target) => {
    if (!colors) return null;
    const n = target ? f.linkmode : f.node;
    const linkok = target ? !!f.linkmode : true;
    let type;
    if (target && !linkok && colors.mi) type = 'mi';
    else if (!f.ok) type = { f: 'fi', d: 'di', dir: 'di', argdir: 'di', l: 'ln', p: 'pi', s: 'so', c: 'cd' }[f.type] || 'fi';
    else {
      const m = (colors.lnTarget && f.node.type === 'l' && f.linkmode && !target) ? f.linkmode : n;
      if (!m) type = 'or';
      else if (m.type === 'f') {
        type = 'fi';
        if ((m.mode & 0o4000) && colors.su) type = 'su';
        else if ((m.mode & 0o2000) && colors.sg) type = 'sg';
        else if ((m.mode & 0o111) && colors.ex) type = 'ex';
        else if (m.nlink > 1 && colors.mh) type = 'mh';
      } else if (m.type === 'd') {
        type = 'di';
        if ((m.mode & 0o1000) && (m.mode & 0o002) && colors.tw) type = 'tw';
        else if ((m.mode & 0o002) && colors.ow) type = 'ow';
        else if ((m.mode & 0o1000) && colors.st) type = 'st';
      } else type = { l: 'ln', p: 'pi', s: 'so', c: 'cd', b: 'bd' }[m.type] || 'or';
    }
    let seq = colors[type];
    if (type === 'fi') {
      const nm = (target ? f.linkname : f.name).toLowerCase();
      for (const [ext, code] of colors.ext) if (nm.endsWith(ext)) { seq = code; break; }
    }
    if (type === 'ln' && !target && f.node.type === 'l' && !f.linkmode && (colors.lnTarget || colors.or)) seq = colors.or;
    return seq || null;
  };
  const reset = () => (colors.ec !== null ? colors.ec : colors.lc + colors.rs + colors.rc);
  const paint = (f, text, target, startCol) => {
    if (!colors) return text;
    const c = colorOf(f, target);
    if (!c && !colors.no) return text;
    let s = '';
    if (!usedColor) { usedColor = true; s += reset(); }
    if (c) s += colors.lc + c + colors.rc;
    s += text + reset();
    if (lineLength && Math.floor(startCol / lineLength) !== Math.floor((startCol + text.length - 1) / lineLength)) s += colors.cl;
    return s;
  };

  const printLong = (files, w) => {
    for (const f of files) {
      let line = '';
      const n = f.node;
      if (printInode) line += String(f.ok ? n.ino : '?').padStart(w.ino) + ' ';
      if (printBlockSize) line += blocksStr(f).padStart(w.blocks) + ' ';
      const mode = f.ok ? modeString(n) : '?' + '?'.repeat(9);
      line += mode + ' ' + String(f.ok ? n.nlink : '?').padStart(w.nlink) + ' ';
      const fmtUser = (id, names, width) => {
        if (!f.ok) return '?'.padEnd(width) + ' ';
        const s = userStr(id, names);
        return s === null ? String(id).padStart(width) + ' ' : s.padEnd(width) + ' ';
      };
      if (printOwner) line += fmtUser(n && n.uid, USERS, w.owner);
      if (printGroup) line += fmtUser(n && n.gid, GROUPS, w.group);
      if (printAuthor) line += fmtUser(n && n.uid, USERS, w.author);
      if (f.ok && n.type === 'c') {
        const d = RDEV[n.dev] || [1, 3];
        const blanks = w.size - (w.major + 2 + w.minor);
        line += String(d[0]).padStart(w.major + Math.max(0, blanks)) + ', ' + String(d[1]).padStart(w.minor) + ' ';
      } else line += sizeStr(f).padStart(w.size) + ' ';
      line += (f.ok ? fmtTime(n) : '?'.padStart(12)) + ' ';
      line += (padFor(f) ? ' ' : '') + paint(f, nameOf(f), false, dispWidth(line));
      if (f.ok && n.type === 'l') {
        if (f.linkname !== null) {
          line += ' -> ' + paint(f, nameOf(f, true), true, dispWidth(line) + 4);
          if (indicatorStyle !== 'none') line += f.linkmode ? typeIndicator(true, f.linkmode, null) : '';
        }
      } else if (indicatorStyle !== 'none') line += typeIndicator(f.ok, n, f.type);
      out.write(line + '\n');
    }
  };

  const frillsLen = (f, w) => {
    let len = 0;
    if (printInode) len += 1 + (format === 'commas' ? String(f.ok ? f.node.ino : '?').length : w.ino);
    if (printBlockSize) len += 1 + (format === 'commas' ? blocksStr(f).length : w.blocks);
    len += dispWidth(nameOf(f)) + (padFor(f) ? 1 : 0);
    if (indicatorStyle !== 'none') len += typeIndicator(f.ok, f.node, f.type) ? 1 : 0;
    return len;
  };
  const frills = (f, w, startCol = 0) => {
    let s = '';
    if (printInode) s += String(f.ok ? f.node.ino : '?').padStart(format === 'commas' ? 0 : w.ino) + ' ';
    if (printBlockSize) s += blocksStr(f).padStart(format === 'commas' ? 0 : w.blocks) + ' ';
    s += (padFor(f) ? ' ' : '') + paint(f, nameOf(f), false, startCol);
    if (indicatorStyle !== 'none') s += typeIndicator(f.ok, f.node, f.type);
    return s;
  };
  const indent = (from, to) => {
    let s = '';
    while (from < to) {
      if (tabsize !== 0 && Math.floor(to / tabsize) > Math.floor((from + 1) / tabsize)) { s += '\t'; from += tabsize - (from % tabsize); }
      else { s += ' '; from++; }
    }
    return s;
  };
  // calculate_columns
  const calcColumns = (files, w, byColumns) => {
    const n = files.length;
    const maxCols = Math.min(maxIdx, n);
    const info = [];
    for (let i = 0; i < maxCols; i++) info.push({ valid: true, lineLen: (i + 1) * 3, cols: new Array(i + 1).fill(3) });
    for (let k = 0; k < n; k++) {
      const len = frillsLen(files[k], w);
      for (let i = 0; i < maxCols; i++) {
        const ci = info[i];
        if (!ci.valid) continue;
        const idx = byColumns ? Math.floor(k / Math.floor((n + i) / (i + 1))) : k % (i + 1);
        const real = len + (idx === i ? 0 : 2);
        if (ci.cols[idx] < real) {
          ci.lineLen += real - ci.cols[idx];
          ci.cols[idx] = real;
          ci.valid = ci.lineLen < lineLength;
        }
      }
    }
    let cols = maxCols;
    for (; cols > 1; cols--) if (info[cols - 1].valid) break;
    return { cols: Math.max(cols, 1), info: info[Math.max(cols, 1) - 1] || { cols: [0] } };
  };

  const printCurrentFiles = (files) => {
    if (!files.length) return;
    someQuoted = alignQuotes && files.some(f => nameOf(f) !== f.name);
    const w = widths(files);
    switch (format) {
      case 'one':
        for (const f of files) out.write(frills(f, w) + '\n');
        break;
      case 'many': {
        const { cols, info } = calcColumns(files, w, true);
        const rows = Math.floor(files.length / cols) + (files.length % cols !== 0 ? 1 : 0);
        for (let row = 0; row < rows; row++) {
          let col = 0, k = row, pos = 0, line = '';
          for (;;) {
            const f = files[k];
            const len = frillsLen(f, w);
            const maxLen = info.cols[col++];
            line += frills(f, w, pos);
            k += rows;
            if (k >= files.length) break;
            line += indent(pos + len, pos + maxLen);
            pos += maxLen;
          }
          out.write(line + '\n');
        }
        break;
      }
      case 'horizontal': {
        const { cols, info } = calcColumns(files, w, false);
        let pos = 0;
        let len = frillsLen(files[0], w), maxLen = info.cols[0];
        let line = frills(files[0], w);
        for (let k = 1; k < files.length; k++) {
          const col = k % cols;
          if (col === 0) { out.write(line + '\n'); line = ''; pos = 0; }
          else { line += indent(pos + len, pos + maxLen); pos += maxLen; }
          line += frills(files[k], w, pos);
          len = frillsLen(files[k], w);
          maxLen = info.cols[col];
        }
        out.write(line + '\n');
        break;
      }
      case 'commas': {
        let pos = 0, line = '';
        files.forEach((f, k) => {
          const len = lineLength ? frillsLen(f, w) : 0;
          if (k) {
            if (!lineLength || pos + len + 2 < lineLength) { pos += 2; line += ', '; }
            else { pos = 0; line += ',\n'; }
          }
          line += frills(f, w, pos);
          pos += len;
        });
        out.write(line + '\n');
        break;
      }
      case 'long':
        printLong(files, w);
        break;
    }
  };

  // fnmatch (pattern, name, FNM_PERIOD)
  const match = (p, name) => (name[0] !== '.' || p[0] === '.') && fnmatch(p, name, { extglob: false });
  const ignored = (name) => {
    if (ignoreMode !== 'minimal' && name[0] === '.' && (ignoreMode === 'default' || !name[1 + (name[1] === '.' ? 1 : 0)])) return true;
    if (ignoreMode === 'default' && hidePatterns.some(p => match(p, name))) return true;
    return ignorePatterns.some(p => match(p, name));
  };

  const pending = [];   // stack of { name, cmdline }
  const extractDirs = (files, dirname, cmdline) => {
    const keep = [];
    const dirs = [];
    for (const f of files) {
      if (isDirectory(f) && (dirname === null || (f.name !== '.' && f.name !== '..'))) {
        dirs.push({ name: dirname === null || f.name[0] === '/' ? f.name : fileNameConcat(dirname, f.name), cmdline });
        if (f.type === 'argdir') continue;
      }
      keep.push(f);
    }
    for (let i = dirs.length - 1; i >= 0; i--) pending.push(dirs[i]);
    return keep;
  };

  let first = true;
  let printDirName = true;
  const printDir = (name, cmdline) => {
    let node;
    try {
      node = stat(name);
      if (node.type !== 'd') throw new FsError('ENOTDIR', name);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      fail(`cannot open directory ${qa(name)}: ${e.message}`, cmdline);
      return;
    }
    if (recursive || printDirName) {
      if (!first) out.write('\n');
      first = false;
      out.write(quotearg(name, quoting, { quoteTheseToo: new Set([...qtt, ':']) }) + ':\n');
    }
    let files = [];
    const names = [...node.entries.keys()];
    if (ignoreMode === 'minimal') names.unshift('.', '..');
    for (const n of names) {
      ctx.tick && ctx.tick();
      if (ignored(n)) continue;
      gobble(files, n, name, false);
    }
    if (format === 'long' || printBlockSize) {
      const total = files.reduce((s, f) => s + (f.ok ? blocksK(f.node) : 0), 0);
      out.write(`total ${humanOrBlocks(total)}\n`);
    }
    sortFiles(files);
    if (recursive) files = extractDirs(files, name, false);
    printCurrentFiles(files);
  };

  let files = [];
  const ops = r.operands;
  if (!ops.length) {
    if (immediateDirs) gobble(files, '.', null, true);
    else pending.push({ name: '.', cmdline: true });
  } else for (const op of ops) gobble(files, op, null, true);
  if (files.length) {
    sortFiles(files);
    if (!immediateDirs) files = extractDirs(files, null, true);
  }
  if (files.length) {
    printCurrentFiles(files);
    if (pending.length) out.write('\n');
  } else if (ops.length <= 1 && pending.length === 1) printDirName = false;
  while (pending.length) {
    const d = pending.pop();
    printDir(d.name, d.cmdline);
  }
  return status;
}

export default C;
