// tar (GNU tar 1.34 semantics, gnu format), gzip/gunzip/zcat (gzip 1.10: its deflate in gzdeflate.js, inflate here)
import { FsError, joinPath, byteCmp, modeString } from '../vfs.js';
import { TAR_HELP, TAR_USAGE } from './tar-help.js';
import { gzipDeflate } from './gzdeflate.js';
import { quotearg } from './util.js';
import { OutBuf } from '../streams.js';

const C = {};

// ---------------------------------------------------------------- CRC32 (gzip)
let CRC = null;
function crc32(s) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) c = CRC[(c ^ s.charCodeAt(i)) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const le32 = (n) => String.fromCharCode(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);


// A gzip member: optional original name (FNAME) and mtime, XFL from the level, OS=Unix.
export function gzipEncode(data, { name = null, mtimeSec = 0, level = 6 } = {}) {
  const xfl = level === 9 ? 2 : level === 1 ? 4 : 0;
  let out = '\x1f\x8b\x08' + String.fromCharCode(name ? 8 : 0) + le32(mtimeSec) + String.fromCharCode(xfl) + '\x03';
  if (name) out += name + '\0';
  return out + gzipDeflate(data, level) + le32(crc32(data)) + le32(data.length);
}
export const gzipStored = (data) => gzipEncode(data);   // (kept for tar -z)

// ---------------------------------------------------------------- inflate (RFC 1951)
function inflate(src, start) {
  let pos = start, bitbuf = 0, bitcnt = 0;
  const out = [];
  const bits = (n) => {
    while (bitcnt < n) { if (pos >= src.length) throw new Error('unexpected end of file'); bitbuf |= (src.charCodeAt(pos++) & 255) << bitcnt; bitcnt += 8; }
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n; bitcnt -= n;
    return v;
  };
  const build = (lengths) => {
    const count = new Array(16).fill(0), symbol = [];
    for (const l of lengths) count[l]++;
    count[0] = 0;
    const offs = [0];
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    lengths.forEach((l, s) => { if (l) symbol[offs[l]++] = s; });
    return { count, symbol };
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count; first += count; first <<= 1; code <<= 1;
    }
    throw new Error('invalid code');
  };
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const codes = (lit, dist) => {
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) out.push(sym);
      else if (sym === 256) return;
      else {
        sym -= 257;
        const len = LBASE[sym] + bits(LEXT[sym]);
        const ds = decode(dist);
        const d = DBASE[ds] + bits(DEXT[ds]);
        for (let k = 0; k < len; k++) out.push(out[out.length - d]);
      }
    }
  };
  let fixedLit = null, fixedDist = null;
  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0; bitcnt = 0;
      const len = (src.charCodeAt(pos) & 255) | ((src.charCodeAt(pos + 1) & 255) << 8);
      pos += 4;
      if (pos + len > src.length) throw new Error('unexpected end of file');
      for (let k = 0; k < len; k++) out.push(src.charCodeAt(pos++) & 255);
    } else if (type === 1) {
      if (!fixedLit) {
        const l = [];
        for (let i = 0; i < 288; i++) l.push(i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8);
        fixedLit = build(l);
        fixedDist = build(new Array(30).fill(5));
      }
      codes(fixedLit, fixedDist);
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const lengths = new Array(19).fill(0);
      for (let i = 0; i < ncode; i++) lengths[ORDER[i]] = bits(3);
      const lencode = build(lengths);
      const all = [];
      while (all.length < nlen + ndist) {
        const sym = decode(lencode);
        if (sym < 16) all.push(sym);
        else if (sym === 16) { const prev = all[all.length - 1]; for (let k = 3 + bits(2); k > 0; k--) all.push(prev); }
        else if (sym === 17) { for (let k = 3 + bits(3); k > 0; k--) all.push(0); }
        else { for (let k = 11 + bits(7); k > 0; k--) all.push(0); }
      }
      codes(build(all.slice(0, nlen)), build(all.slice(nlen)));
    } else throw new Error('invalid block type');
  } while (!last);
  let s = '';
  for (let i = 0; i < out.length; i += 8192) s += String.fromCharCode.apply(null, out.slice(i, i + 8192));
  return { data: s, end: pos };
}

// Decode a gzip stream (one or more members). Returns { data, name, trailing, error } where
// error is 'format' (not gzip at all) or 'eof' (truncated), and trailing marks garbage after
// valid members (gzip warns "decompression OK, trailing garbage ignored").
export function gunzipStream(d) {
  let out = '', p = 0, name = null, members = 0, mtime = 0;
  while (p < d.length) {
    if (d.charCodeAt(p) !== 0x1f || d.charCodeAt(p + 1) !== 0x8b) {
      if (members === 0) return { data: out, error: p + 1 >= d.length && d.charCodeAt(p) === 0x1f ? 'eof' : 'format' };
      return { data: out, name, mtime, trailing: true };
    }
    if (p + 10 > d.length) return { data: out, error: 'eof' };
    const flg = d.charCodeAt(p + 3);
    let q = p + 10;
    if (flg & 4) { const xlen = d.charCodeAt(q) | (d.charCodeAt(q + 1) << 8); q += 2 + xlen; }
    if (members === 0) mtime = (d.charCodeAt(p + 4) | (d.charCodeAt(p + 5) << 8) | (d.charCodeAt(p + 6) << 16) | (d.charCodeAt(p + 7) << 24)) >>> 0;
    if (flg & 8) { const e = d.indexOf('\0', q); if (e < 0) return { data: out, error: 'eof' }; if (members === 0) name = d.slice(q, e); q = e + 1; }
    if (flg & 16) { const e = d.indexOf('\0', q); if (e < 0) return { data: out, error: 'eof' }; q = e + 1; }
    if (flg & 2) q += 2;
    let r;
    try { r = inflate(d, q); } catch (e) { return { data: out, error: /end of file/.test(e.message) ? 'eof' : 'format' }; }
    if (r.end + 8 > d.length) return { data: out, error: 'eof' };
    out += r.data;
    members++;
    p = r.end + 8;
  }
  if (members === 0) return { data: out, error: 'eof' };
  return { data: out, name, mtime };
}
export function gunzipData(d) {
  const r = gunzipStream(d);
  if (r.error) throw new Error(r.error === 'eof' ? 'unexpected end of file' : 'not in gzip format');
  return r.data;
}

// gzip 1.10 (gunzip and zcat are scripts around it, so every message says "gzip:")
const GZ_SUFFIXES = ['.gz', '-gz', '.z', '-z', '_z', '.Z', '.tgz', '.taz'];
function gzImpl(ctx, mode) {
  const say = (m) => ctx.stderr.write(`gzip: ${m}\n`);
  const usage = () => ctx.stderr.write("Try `gzip --help' for more information.\n");
  let decompress = mode === 'd' || mode === 'c', toStdout = mode === 'c', keep = false, force = false;
  let recursive = false, list = false, test = false, verbose = 0, quiet = false, level = 6, suffix = '.gz';
  let noName = -1, noTime = -1;
  const files = [];
  const args = ctx.argv.slice(1);
  const LONG = { stdout: 'c', 'to-stdout': 'c', decompress: 'd', uncompress: 'd', force: 'f', keep: 'k', list: 'l', name: 'N', 'no-name': 'n', quiet: 'q', silent: 'q', recursive: 'r', test: 't', verbose: 'v', fast: '1', best: '9', suffix: 'S', help: 'h', version: 'V', license: 'L', synchronous: 'Y', rsyncable: 'R' };
  const opt = (c, val) => {
    switch (c) {
      case 'c': toStdout = true; break;
      case 'd': decompress = true; break;
      case 'f': force = true; break;
      case 'k': keep = true; break;
      case 'l': list = true; decompress = true; break;
      case 'q': quiet = true; verbose = 0; break;
      case 'r': recursive = true; break;
      case 't': test = true; decompress = true; toStdout = true; break;
      case 'v': verbose++; quiet = false; break;
      case 'S': suffix = val; break;
      case 'N': noName = noTime = 0; break;
      case 'n': noName = noTime = 1; break;
      case 'Y': case 'R': break;
      default: if (/^[1-9]$/.test(c)) level = +c; else return false;
    }
    return true;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { files.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('='), nm = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const hits = Object.keys(LONG).filter(k => k.startsWith(nm));
      const key = LONG[nm] ? nm : hits.length === 1 ? hits[0] : null;
      if (!key) { say(`unrecognized option '${a}'`); usage(); return 1; }
      if (LONG[key] === 'S') { if (!opt('S', eq >= 0 ? a.slice(eq + 1) : args[++i])) return 1; continue; }
      if (LONG[key] === 'h' || LONG[key] === 'V' || LONG[key] === 'L') { ctx.out('gzip 1.10\n'); return 0; }
      opt(LONG[key]);
      continue;
    }
    if (a.length > 1 && a[0] === '-') {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (c === 'S') { const v = a.slice(j + 1) || args[++i]; if (v === undefined) { say("option requires an argument -- 'S'"); usage(); return 1; } suffix = v; break; }
        if (c === 'h' || c === 'V' || c === 'L') { ctx.out('gzip 1.10\n'); return 0; }
        if (!opt(c)) { say(`invalid option -- '${c}'`); usage(); return 1; }
      }
      continue;
    }
    files.push(a);
  }
  if (mode === 'c') toStdout = true;
  if (suffix.length === 0 || suffix.length > 30) { say(`invalid suffix '${suffix}'`); return 1; }
  if (noTime < 0) noTime = decompress ? 1 : 0;
  if (noName < 0) noName = decompress ? 1 : 0;
  let st = 0;
  const warn = (m) => { if (!quiet) say(m); if (st === 0) st = 2; };
  const ratio = (num, den) => `${(den === 0 ? 0 : 100 * num / den).toFixed(1).padStart(5)}%`;
  // do_list(): a header before the first entry, "defla crc date" columns with -v, totals at the end
  let listed = false;
  let totalIn = 0, totalOut = 0, lastHdr = 0;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const listLine = (comp, uncomp, name, hdr, gzData, fileMtime) => {
    if (!listed) {
      if (verbose) ctx.out('method  crc     date  time  ');
      if (!quiet) ctx.out(`${'compressed'.padStart(19)} ${'uncompressed'.padStart(19)}  ratio uncompressed_name\n`);
      listed = true;
    }
    if (verbose) {
      const crc = gzData.length >= 8 ? (gzData.charCodeAt(gzData.length - 8) | (gzData.charCodeAt(gzData.length - 7) << 8) | (gzData.charCodeAt(gzData.length - 6) << 16) | (gzData.charCodeAt(gzData.length - 5) << 24)) >>> 0 : 0xffffffff;
      const stamp = gzData.length >= 8 ? (gzData.charCodeAt(4) | (gzData.charCodeAt(5) << 8) | (gzData.charCodeAt(6) << 16) | (gzData.charCodeAt(7) << 24)) >>> 0 : 0;
      const d = new Date(stamp !== 0 ? stamp * 1000 : fileMtime);
      const p2 = (n) => String(n).padStart(2, '0');
      ctx.out(`defla ${crc.toString(16).padStart(8, '0')} ${MON[d.getUTCMonth()]}${String(d.getUTCDate()).padStart(3)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} `);
    }
    ctx.out(`${String(comp).padStart(19)} ${String(uncomp).padStart(19)} ${ratio(uncomp - (comp - hdr), uncomp)} ${name}\n`);
    totalIn += comp; totalOut += uncomp; lastHdr = hdr;
  };
  const listTotals = () => {
    if (totalIn <= 0 || totalOut <= 0) return;
    if (verbose) ctx.out(' '.repeat(28));
    ctx.out(`${String(totalIn).padStart(19)} ${String(totalOut).padStart(19)} ${ratio(totalOut - (totalIn - lastHdr), totalOut)} (totals)\n`);
  };
  const decodeOrReport = (data, label) => {
    const r = gunzipStream(data);
    if (r.error === 'format') { if (!quiet) ctx.stderr.write(`\ngzip: ${label}: not in gzip format\n`); st = 1; return null; }
    if (r.error === 'eof') { if (!quiet) ctx.stderr.write(`\ngzip: ${label}: unexpected end of file\n`); st = 1; return null; }
    return r;
  };
  const stripSuffix = (f) => {
    const base = f.slice(f.lastIndexOf('/') + 1);
    for (const sfx of [suffix, ...GZ_SUFFIXES]) {
      // gzip compares suffixes case-insensitively ("A.GZ" -> "A")
      if (base.length > sfx.length && base.toLowerCase().endsWith(sfx.toLowerCase())) {
        const stem = f.slice(0, f.length - sfx.length);
        return sfx === '.tgz' || sfx === '.taz' ? stem + '.tar' : stem;
      }
    }
    return null;
  };

  const one = (f) => {
    if (f === '') { ctx.stderr.write('gzip: No such file or directory\n'); st = 1; return; }
    let n = null, path = f;
    try { n = ctx.fs.stat(f, ctx.cwd); } catch {}
    if (!n && decompress && stripSuffix(f) === null) { try { n = ctx.fs.stat(f + suffix, ctx.cwd); path = f + suffix; } catch {} }
    if (!n) { if (!quiet || true) say(`${decompress && stripSuffix(f) === null ? f + suffix : f}: No such file or directory`); st = 1; return; }
    if (n.type === 'd') {
      if (!recursive) { warn(`${path} is a directory -- ignored`); return; }
      for (const c of [...n.entries.keys()]) one(joinPath(path, c));
      return;
    }
    const data = n.data || '';
    if (decompress) {
      if (list) {
        const r = gunzipStream(data);
        if (r.error) { ctx.stderr.write(`\ngzip: ${path}: not in gzip format\n`); st = 1; return; }
        const out = stripSuffix(path) ?? path;
        listLine(data.length, r.data.length, out, data.length - deflatedSize(data), data, n.mtime || 0);
        return;
      }
      if (!toStdout && stripSuffix(path) === null) { warn(`${path}: unknown suffix -- ignored`); return; }
      const r = gunzipStream(data);
      if (r.error && force && toStdout) { ctx.out(data); return; }
      if (r.error === 'format') { ctx.stderr.write(`\ngzip: ${path}: not in gzip format\n`); st = 1; return; }
      if (r.error === 'eof') { ctx.stderr.write(`\ngzip: ${path}: unexpected end of file\n`); st = 1; return; }
      if (test) { if (verbose) ctx.stderr.write(`${path}:\t OK\n`); return; }
      if (toStdout) { ctx.out(r.data); if (r.trailing) { if (!quiet) ctx.stderr.write(`\ngzip: ${path}: decompression OK, trailing garbage ignored\n`); if (st === 0) st = 2; } return; }
      let target = stripSuffix(path);
      // -N: the name (and time) saved in the header, in the input's directory
      if (!noName && r.name) target = path.slice(0, path.lastIndexOf('/') + 1) + r.name.slice(r.name.lastIndexOf('/') + 1);
      if (ctx.fs.tryResolve(target, ctx.cwd, {}) && !force) { warn(`${target} already exists;\tnot overwritten`); return; }
      const out = ctx.fs.writeFile(target, r.data, ctx.cwd);
      out.mode = n.mode; out.mtime = !noTime && r.mtime ? r.mtime * 1000 : n.mtime;
      if (verbose) ctx.stderr.write(`${path}:\t${ratio(r.data.length - deflatedSize(data), r.data.length)} -- replaced with ${target}\n`);
      if (!keep) ctx.fs.unlink(path, ctx.cwd);
      if (r.trailing) { if (!quiet) ctx.stderr.write(`\ngzip: ${path}: decompression OK, trailing garbage ignored\n`); if (st === 0) st = 2; }
      return;
    }
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (!toStdout && base.endsWith(suffix)) { if (!quiet) say(`${path} already has ${suffix} suffix -- unchanged`); return; }
    const gz = gzipEncode(data, { name: noName ? null : base, mtimeSec: noTime ? 0 : Math.floor((n.mtime || 0) / 1000), level });
    if (toStdout) { ctx.out(gz); return; }
    const target = path + suffix;
    if (ctx.fs.tryResolve(target, ctx.cwd, {}) && !force) { warn(`${target} already exists;\tnot overwritten`); return; }
    const out = ctx.fs.writeFile(target, gz, ctx.cwd);
    out.mode = n.mode; out.mtime = n.mtime;
    if (verbose) ctx.stderr.write(`${path}:\t${ratio(data.length - (gz.length - (gz.length - deflatedSize(gz))), data.length)} -- replaced with ${target}\n`);
    if (!keep) ctx.fs.unlink(path, ctx.cwd);
  };

  const doStdin = () => {
    const data = ctx.stdin.readAll();
    if (decompress) {
      if (list) { const r = gunzipStream(data); if (!r.error) listLine(data.length, r.data.length, 'stdout', data.length - deflatedSize(data), data, ctx.fs.now()); return st; }
      const r = gunzipStream(data);
      if (r.error && force) { ctx.out(data); return 0; }
      if (r.error === 'format') { ctx.stderr.write('\ngzip: stdin: not in gzip format\n'); return 1; }
      if (r.error === 'eof') { ctx.stderr.write('\ngzip: stdin: unexpected end of file\n'); return 1; }
      if (!test) ctx.out(r.data);
      if (r.trailing) { if (!quiet) ctx.stderr.write('\ngzip: stdin: decompression OK, trailing garbage ignored\n'); return 2; }
      return 0;
    }
    // stdin's time stamp: the file's if it is a regular file, else none (0)
    let stamp = 0;
    if (!noTime) {
      let node = null;
      try { if (ctx.stdin.name) node = ctx.fs.stat(ctx.stdin.name, ctx.cwd); } catch { /* a pipe */ }
      stamp = node && node.type === 'f' ? Math.floor(node.mtime / 1000) : 0;
    }
    ctx.out(gzipEncode(data, { level, mtimeSec: stamp }));
    return 0;
  };
  if (!files.length) return doStdin();
  for (const f of files) {
    if (f === '-') { const r = doStdin(); if (r > st) st = r; continue; }
    one(f);
  }
  if (list && !quiet && files.length > 1) listTotals();
  return st;
}
// bytes of a gzip member that are compressed payload (total minus header and trailer)
function deflatedSize(gz) {
  const flg = gz.charCodeAt(3);
  let q = 10;
  if (flg & 4) q += 2 + (gz.charCodeAt(10) | (gz.charCodeAt(11) << 8));
  if (flg & 8) q = gz.indexOf('\0', q) + 1;
  if (flg & 16) q = gz.indexOf('\0', q) + 1;
  if (flg & 2) q += 2;
  return gz.length - q - 8;
}
C.gzip = (ctx) => gzImpl(ctx, null);
C.gunzip = (ctx) => gzImpl(ctx, 'd');
C.zcat = (ctx) => gzImpl(ctx, 'c');

// ---------------------------------------------------------------- tar (GNU tar 1.34, "gnu" format)
const oct = (n, w) => n.toString(8).padStart(w - 1, '0') + '\0';
// owner: { uid, gid, uname, gname } (root by default)
const ROOT_OWNER = { uid: 0, gid: 0, uname: 'root', gname: 'root' };
function header(name, node, typeflag, linkname = '', owner = ROOT_OWNER) {
  const f = (str, w) => (str + '\0'.repeat(w)).slice(0, w);
  let h = f(name, 100) + oct(node.mode & 0o7777, 8) + oct(owner.uid, 8) + oct(owner.gid, 8) + oct(typeflag === '0' ? node.size : 0, 12) +
    oct(Math.floor(node.mtime / 1000), 12) + '        ' + typeflag + f(linkname, 100) + 'ustar  \0' + f(owner.uname, 32) + f(owner.gname, 32);
  h = f(h, 512);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h.charCodeAt(i);
  return h.slice(0, 148) + sum.toString(8).padStart(6, '0') + '\0 ' + h.slice(156);
}
// GNU tar stores names longer than 100 bytes in a preceding ././@LongLink entry
function entryHeader(name, node, typeflag, linkname = '', owner = ROOT_OWNER) {
  let pre = '';
  const long = (str, flag) => {
    const body = str + '\0';
    return header('././@LongLink', { mode: 0o644, size: body.length, mtime: 0 }, '0').replace(/^(.{156})0/s, `$1${flag}`) + body + '\0'.repeat((512 - (body.length % 512)) % 512);
  };
  if (linkname.length > 100) pre += fixSum(long(linkname, 'K'));
  if (name.length > 100) pre += fixSum(long(name, 'L'));
  return pre + header(name.slice(0, 100), node, typeflag, linkname.slice(0, 100), owner);
}
function fixSum(block) {
  let h = block.slice(0, 148) + '        ' + block.slice(156, 512);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h.charCodeAt(i);
  return h.slice(0, 148) + sum.toString(8).padStart(6, '0') + '\0 ' + h.slice(156) + block.slice(512);
}

function tarListLine(type, mode, size, mtime, name, link) {
  const d = new Date(mtime);
  const p2 = (n) => String(n).padStart(2, '0');
  const ts = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  const t = type === '5' ? 'd' : type === '2' ? 'l' : '-';
  const ms = modeString({ type: t === '-' ? 'f' : t, mode }).slice(1);
  return `${t}${ms} root/root ${String(size).padStart(9)} ${ts} ${name}${type === '2' ? ' -> ' + link : ''}\n`;
}

// glob match for --exclude / --wildcards (no special meaning for '/')
function tarGlob(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '[\\s\\S]*';
    else if (c === '?') re += '[\\s\\S]';
    else if (c === '[') { const j = pattern.indexOf(']', i + 2); if (j < 0) re += '\\['; else { re += '[' + pattern.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; } }
    else if (c === '\\' && i + 1 < pattern.length) re += '\\' + pattern[++i];
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

// GNU tar 1.34 long options, in the order of tar's option table (getopt lists ambiguous
// possibilities in this order); [name, argument, key]
const TAR_OPTIONS = [
  ['append', 0, 'r'], ['atime-preserve', 2, 'atime'], ['acls', 0, 'acls'], ['auto-compress', 0, 'a'], ['absolute-names', 0, 'P'],
  ['after-date', 1, 'N'], ['add-file', 1, 'addfile'], ['anchored', 0, 'anchored'],
  ['blocking-factor', 1, 'b'], ['bzip2', 0, 'j'], ['backup', 2, 'backup'], ['block-number', 0, 'R'],
  ['create', 0, 'c'], ['compare', 0, 'd'], ['catenate', 0, 'A'], ['concatenate', 0, 'A'], ['check-device', 0, 'checkdev'],
  ['clamp-mtime', 0, 'clamp'], ['compress', 0, 'Z'], ['checkpoint', 2, 'checkpoint'], ['checkpoint-action', 1, 'cpaction'],
  ['check-links', 0, 'l'], ['confirmation', 0, 'w'],
  ['diff', 0, 'd'], ['delete', 0, 'delete'], ['delay-directory-restore', 0, 'delay'], ['dereference', 0, 'h'], ['directory', 1, 'C'],
  ['extract', 0, 'x'], ['exclude', 1, 'exclude'], ['exclude-from', 1, 'X'], ['exclude-caches', 0, 'xc'], ['exclude-caches-under', 0, 'xcu'],
  ['exclude-caches-all', 0, 'xca'], ['exclude-tag', 1, 'xt'], ['exclude-ignore', 1, 'xi'], ['exclude-ignore-recursive', 1, 'xir'],
  ['exclude-tag-under', 1, 'xtu'], ['exclude-tag-all', 1, 'xta'], ['exclude-vcs', 0, 'xvcs'], ['exclude-vcs-ignores', 0, 'xvcsi'],
  ['exclude-backups', 0, 'xbak'],
  ['file', 1, 'f'], ['force-local', 0, 'forcelocal'], ['format', 1, 'H'], ['full-time', 0, 'fulltime'], ['files-from', 1, 'T'],
  ['get', 0, 'x'], ['group', 1, 'group'], ['group-map', 1, 'groupmap'], ['gzip', 0, 'z'], ['gunzip', 0, 'z'],
  ['hole-detection', 1, 'hole'], ['hard-dereference', 0, 'hardderef'], ['help', 0, '?'],
  ['incremental', 0, 'G'], ['ignore-failed-read', 0, 'ifr'], ['ignore-command-error', 0, 'ice'], ['info-script', 1, 'F'],
  ['ignore-zeros', 0, 'i'], ['index-file', 1, 'indexfile'], ['interactive', 0, 'w'], ['ignore-case', 0, 'icase'],
  ['keep-old-files', 0, 'k'], ['keep-newer-files', 0, 'keepnewer'], ['keep-directory-symlink', 0, 'keepdirsym'],
  ['list', 0, 't'], ['listed-incremental', 1, 'g'], ['level', 1, 'level'], ['label', 1, 'V'], ['lzip', 0, 'lzip'], ['lzma', 0, 'lzma'],
  ['lzop', 0, 'lzop'],
  ['mtime', 1, 'mtime'], ['mode', 1, 'mode'], ['multi-volume', 0, 'M'],
  ['no-seek', 0, 'noseek'], ['no-check-device', 0, 'nocheckdev'], ['no-overwrite-dir', 0, 'nooverwritedir'],
  ['no-ignore-command-error', 0, 'noice'], ['no-same-owner', 0, 'nosameowner'], ['numeric-owner', 0, 'numeric'],
  ['no-same-permissions', 0, 'nosameperms'], ['no-delay-directory-restore', 0, 'nodelay'], ['no-xattrs', 0, 'noxattrs'],
  ['no-selinux', 0, 'noselinux'], ['no-acls', 0, 'noacls'], ['new-volume-script', 1, 'F'], ['no-auto-compress', 0, 'noauto'],
  ['newer', 1, 'N'], ['newer-mtime', 1, 'newermtime'], ['no-quote-chars', 1, 'noquotechars'], ['null', 0, 'null'],
  ['no-null', 0, 'nonull'], ['no-unquote', 0, 'nounquote'], ['no-verbatim-files-from', 0, 'noverbatim'], ['no-recursion', 0, 'norec'],
  ['no-anchored', 0, 'noanchored'], ['no-ignore-case', 0, 'noicase'], ['no-wildcards', 0, 'nowildcards'],
  ['no-wildcards-match-slash', 0, 'nowms'],
  ['occurrence', 2, 'occurrence'], ['overwrite', 0, 'overwrite'], ['overwrite-dir', 0, 'overwritedir'], ['one-top-level', 2, 'onetop'],
  ['owner', 1, 'owner'], ['owner-map', 1, 'ownermap'], ['old-archive', 0, 'o'], ['one-file-system', 0, 'ofs'],
  ['preserve-permissions', 0, 'p'], ['preserve-order', 0, 's'], ['portability', 0, 'o'], ['posix', 0, 'posix'], ['pax-option', 1, 'pax'],
  ['program-name', 1, 'progname'],
  ['quoting-style', 1, 'quoting'], ['quote-chars', 1, 'quotechars'],
  ['remove-files', 0, 'removefiles'], ['recursive-unlink', 0, 'recunlink'], ['rmt-command', 1, 'rmt'], ['rsh-command', 1, 'rsh'],
  ['record-size', 1, 'recsize'], ['read-full-records', 0, 'B'], ['restrict', 0, 'restrict'], ['recursion', 0, 'rec'],
  ['sparse', 0, 'S'], ['sparse-version', 1, 'sparsever'], ['seek', 0, 'n'], ['skip-old-files', 0, 'skipold'], ['same-owner', 0, 'sameowner'],
  ['same-permissions', 0, 'p'], ['same-order', 0, 's'], ['sort', 1, 'sort'], ['selinux', 0, 'selinux'], ['starting-file', 1, 'K'],
  ['suffix', 1, 'suffix'], ['strip-components', 1, 'strip'], ['show-defaults', 0, 'showdefaults'],
  ['show-snapshot-field-ranges', 0, 'showsnap'], ['show-omitted-dirs', 0, 'showomitted'], ['show-transformed-names', 0, 'showtrans'],
  ['show-stored-names', 0, 'showtrans'],
  ['test-label', 0, 'testlabel'], ['to-stdout', 0, 'O'], ['to-command', 1, 'tocommand'], ['touch', 0, 'm'], ['tape-length', 1, 'L'],
  ['transform', 1, 'transform'], ['totals', 2, 'totals'],
  ['update', 0, 'u'], ['unlink-first', 0, 'U'], ['use-compress-program', 1, 'I'], ['ungzip', 0, 'z'], ['uncompress', 0, 'Z'],
  ['utc', 0, 'utc'], ['unquote', 0, 'unquote'], ['usage', 0, 'usage'],
  ['verify', 0, 'W'], ['volno-file', 1, 'volno'], ['verbose', 0, 'v'], ['verbatim-files-from', 0, 'verbatim'], ['version', 0, 'version'],
  ['warning', 1, 'warning'], ['wildcards', 0, 'wildcards'], ['wildcards-match-slash', 0, 'wms'],
  ['xattrs', 0, 'xattrs'], ['xattrs-include', 1, 'xattrsinc'], ['xattrs-exclude', 1, 'xattrsexc'], ['xz', 0, 'J'], ['xform', 1, 'transform'],
  ['zstd', 0, 'zstd'],
];
// short options: letters followed by ':' take an argument
const TAR_SHORT = 'Aa?Bb:cC:dF:f:Gg:H:hI:iJjK:kL:lMmN:nOoPpRrSsT:tUuV:vWwX:xZz';
const shortTakesArg = (c) => { const i = TAR_SHORT.indexOf(c); return i >= 0 && TAR_SHORT[i + 1] === ':'; };
const shortValid = (c) => c !== ':' && TAR_SHORT.includes(c);

// the programs tar runs (this tar is built with LZMA_PROGRAM="xz")
const UTIL_FOR = { j: 'bzip2', J: 'xz', Z: 'compress', lzip: 'lzip', lzma: 'xz', lzop: 'lzop', zstd: 'zstd' };
const AUTO_SUFFIX = [[/\.(tar\.)?gz$|\.tgz$|\.taz$/, 'z'], [/\.(tar\.)?Z$|\.taZ$/, 'Z'], [/\.(tar\.)?bz2$|\.tbz2?$|\.tz2$/, 'j'],
  [/\.(tar\.)?lz$/, 'lzip'], [/\.(tar\.)?lzma$|\.tlz$/, 'lzma'], [/\.(tar\.)?lzo$/, 'lzop'], [/\.(tar\.)?xz$|\.txz$/, 'J'],
  [/\.(tar\.)?zst$|\.tzst$/, 'zstd']];

// fnmatch_pattern_has_wildcards()
function hasWildcards(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '?' || c === '*' || c === '[' || c === ']') return true;
  }
  return false;
}

// tar's print_total_stats
function totalsLine(what, bytes) {
  const units = ['', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const h = u === 0 ? String(bytes) : (v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '')) + units[u];
  return `Total bytes ${what}: ${bytes} (${h}, 49MiB/s)\n`;
}

C.tar = (ctx) => {
  const say = (m) => ctx.stderr.write(`tar: ${m}\n`);
  // a file name in a message: quotearg_colon() in tar's default escape style (backslash escapes,
  // ':' too); quote() (locale style) for a second name
  const COLON = new Set([':']);
  const qc = (s) => quotearg(s, 'escape', { quoteTheseToo: COLON });
  const ql = (s) => quotearg(s, 'locale');
  const tryHelp = () => ctx.stderr.write("Try 'tar --help' or 'tar --usage' for more information.\n");
  const usageErr = (m) => { say(m); tryHelp(); return 64; };
  const fatalUsage = (m) => { say(m); tryHelp(); return 2; };
  let args = ctx.argv.slice(1);

  // old-style options: `tar xvf a.tar` (letters taking an argument consume the next words)
  if (args.length && args[0][0] !== '-') {
    const bundle = args[0];
    const rest = args.slice(1);
    const out = [];
    for (const c of bundle) {
      if (!shortValid(c)) { out.push('-' + c); continue; }
      if (shortTakesArg(c)) {
        if (!rest.length) return fatalUsage(`Old option '${c}' requires an argument.`);
        out.push('-' + c, rest.shift());
      } else out.push('-' + c);
    }
    args = [...out, ...rest];
  }

  // ---- option parsing (getopt_long with tar's option table; names and -C/-T are positional)
  const opt = {
    op: null, ops: 0, files: [], verbose: 0, compress: null, auto: false, toStdout: false, strip: 0, deref: false,
    keepOld: false, skipOld: false, absolute: false, totals: false, numeric: false, fullTime: false, removeFiles: false,
    nullSep: false, ignoreZeros: false,
  };
  let wildcards = null;          // null = default (no wildcards for member names), true/false = given
  let wildcardsMatchSlash = true;
  let recursion = true;
  let chdir = null;
  const items = [];              // { name, dir, wildcards, wms, recursion } or { error }
  const excludes = [];
  const afterOperand = [];
  let sawOperand = false;
  const longOf = (key) => TAR_OPTIONS.find(o => o[2] === key)[0];
  const apply = (key, val, spelled) => {
    switch (key) {
      case 'A': case 'c': case 'd': case 'r': case 't': case 'u': case 'x': case 'delete': case 'testlabel':
        if (opt.op !== key) opt.ops++;
        opt.op = key;
        break;
      case 'f': opt.files.push(val); break;
      case 'C': chdir = val; items.push({ chdir: val }); break;
      case 'T': items.push({ filesFrom: val }); break;
      case 'v': opt.verbose++; break;
      case 'z': opt.compress = 'gzip'; break;
      case 'j': case 'J': case 'Z': case 'lzip': case 'lzma': case 'lzop': case 'zstd': opt.compress = UTIL_FOR[key]; break;
      case 'I': opt.compress = val; break;
      case 'a': opt.auto = true; break;
      case 'noauto': opt.auto = false; break;
      case 'O': opt.toStdout = true; break;
      case 'h': opt.deref = true; break;
      case 'k': opt.keepOld = true; break;
      case 'skipold': opt.skipOld = true; break;
      case 'P': opt.absolute = true; break;
      case 'numeric': opt.numeric = true; break;
      case 'fulltime': opt.fullTime = true; break;
      case 'removefiles': opt.removeFiles = true; break;
      case 'totals': opt.totals = true; break;
      case 'null': opt.nullSep = true; break;
      case 'nonull': opt.nullSep = false; break;
      case 'i': opt.ignoreZeros = true; break;
      case 'm': opt.touch = true; break;
      case 'exclude': excludes.push({ pat: val, late: sawOperand }); if (sawOperand) afterOperand.push(`--exclude '${val}'`); break;
      case 'X': excludes.push({ from: val }); break;
      case 'wildcards': wildcards = true; if (sawOperand) afterOperand.push('--wildcards'); break;
      case 'nowildcards': wildcards = false; if (sawOperand) afterOperand.push('--no-wildcards'); break;
      case 'wms': wildcardsMatchSlash = true; break;
      case 'nowms': wildcardsMatchSlash = false; break;
      case 'norec': recursion = false; if (sawOperand) afterOperand.push('--no-recursion'); break;
      case 'rec': recursion = true; if (sawOperand) afterOperand.push('--recursion'); break;
      case 'strip':
        if (!/^\d+$/.test(val)) { say(`${qc(val)}: Invalid number of elements`); tryHelp(); return 2; }
        opt.strip = +val;
        break;
      case '?': ctx.out(TAR_HELP); return 0;
      case 'usage': ctx.out(TAR_USAGE); return 0;
      case 'owner': opt.owner = val; break;
      case 'group': opt.group = val; break;
      case 'version':
        ctx.out('tar (GNU tar) 1.34\nCopyright (C) 2021 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by John Gilmore and Jay Fenlason.\n');
        return 0;
      default: break;     // accepted, no effect here
    }
    void spelled;
    return null;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      for (const n of args.slice(i + 1)) { items.push({ name: n, wildcards, wms: wildcardsMatchSlash, recursion }); sawOperand = true; }
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const nm = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      let o = TAR_OPTIONS.find(x => x[0] === nm);
      if (!o) {
        const hits = TAR_OPTIONS.filter(x => x[0].startsWith(nm));
        if (hits.length === 0) return usageErr(`unrecognized option '${a}'`);
        const same = hits.every(h => h[1] === hits[0][1] && h[2] === hits[0][2]);
        if (!same) return usageErr(`option '${a}' is ambiguous; possibilities:${hits.map(h => ` '--${h[0]}'`).join('')}`);
        o = hits[0];
      }
      let val = null;
      if (o[1] === 1) {
        if (eq >= 0) val = a.slice(eq + 1);
        else if (i + 1 < args.length) val = args[++i];
        else return usageErr(`option '--${o[0]}' requires an argument`);
      } else if (o[1] === 2) {
        if (eq >= 0) val = a.slice(eq + 1);
      } else if (eq >= 0) return usageErr(`option '--${o[0]}' doesn't allow an argument`);
      const r = apply(o[2], val, o[0]);
      if (r !== null) return r;
      continue;
    }
    if (a.length > 1 && a[0] === '-') {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (!shortValid(c)) return usageErr(`invalid option -- '${c}'`);
        if (shortTakesArg(c)) {
          let val = a.slice(j + 1);
          if (val === '') {
            if (i + 1 >= args.length) return usageErr(`option requires an argument -- '${c}'`);
            val = args[++i];
          }
          const r = apply(c, val, c);
          if (r !== null) return r;
          break;
        }
        const r = apply(c, null, c);
        if (r !== null) return r;
      }
      continue;
    }
    items.push({ name: a, wildcards, wms: wildcardsMatchSlash, recursion });
    sawOperand = true;
  }
  void longOf;

  if (opt.ops > 1) return fatalUsage("You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option");
  if (!opt.op) return fatalUsage("You must specify one of the '-Acdtrux', '--delete' or '--test-label' options");
  if (opt.files.length > 1) return fatalUsage("Multiple archive files require '-M' option");
  const op = opt.op;
  const creating = op === 'c' || op === 'r' || op === 'u';
  const file = opt.files.length ? opt.files[0] : '-';
  const toArchiveStdout = file === '-';
  if (opt.auto && op === 'c' && !toArchiveStdout) {
    for (const [re, k] of AUTO_SUFFIX) if (re.test(file)) { opt.compress = k === 'z' ? 'gzip' : UTIL_FOR[k]; break; }
  }
  if (opt.compress && (op === 'r' || op === 'u' || op === 'delete')) return fatalUsage('Cannot update compressed archives');
  if (opt.compress && op === 'A') return fatalUsage('Cannot concatenate compressed archives');
  const finalWildcardsDefault = wildcards === null;

  // -X files and -T files are read while the name list is built
  const exPatterns = [];
  for (const x of excludes) {
    if (x.pat !== undefined) { if (!(creating && x.late)) exPatterns.push(x.pat); continue; }
    let data;
    try { data = ctx.readFile(x.from); }
    catch (e) { if (!(e instanceof FsError)) throw e; say(`${qc(x.from)}: ${e.message}`); say('Error is not recoverable: exiting now'); return 2; }
    for (const l of data.split('\n')) if (l !== '') exPatterns.push(l);
  }
  const names = [];
  {
    let cd = null;
    let w = null, wms = true, rec = true;
    for (const it of items) {
      if (it.chdir !== undefined) { cd = it.chdir; continue; }
      if (it.filesFrom !== undefined) {
        let data;
        try {
          if (it.filesFrom !== '-') ctx.fs.stat(it.filesFrom, ctx.cwd);
          data = ctx.readFile(it.filesFrom);
        } catch (e) {
          if (!(e instanceof FsError)) throw e;
          say(`${qc(it.filesFrom)}: Cannot stat: ${e.message}`); say('Error is not recoverable: exiting now'); return 2;
        }
        for (const l of data.split(opt.nullSep ? '\0' : '\n')) if (l !== '') names.push({ name: l, dir: cd, wildcards: w, wms, recursion: rec });
        continue;
      }
      w = it.wildcards; wms = it.wms; rec = it.recursion;
      names.push({ name: it.name, dir: cd, wildcards: it.wildcards, wms: it.wms, recursion: it.recursion });
    }
  }

  // ---- the compression program (buffer.c, system.c). gzip is built in; any other program has
  // to exist. Compressing runs `/bin/sh -c PROG` in a child that creates the archive file first
  // (through a grandchild when the archive isn't a regular file); decompressing execvp()s PROG -d.
  let gz = false, gzLevel = 6, filterProg = null, missingProg = null;
  const progWords = opt.compress ? opt.compress.split(/[ \t\n]+/).filter(Boolean) : [];
  if (opt.compress) {
    const w0 = progWords[0] || '';
    if (opt.compress === 'gzip' || /(^|\/)gzip$/.test(w0)) {
      gz = true;
      for (const w of progWords.slice(1)) { const m = /^-([1-9])$/.exec(w); if (m) gzLevel = +m[1]; }
    } else if (w0 && ctx.sh.findExecutable(w0)) filterProg = opt.compress;
    else missingProg = opt.compress;
  }
  const NOT_RECOVERABLE = 'Error is not recoverable: exiting now\n';
  const archiveStat = () => {
    // is_regular_file(): a regular file, or one that doesn't exist yet
    try { const n = ctx.fs.stat(file, ctx.cwd); return { n, code: null, regular: n.type === 'f' }; }
    catch (e) { if (!(e instanceof FsError)) throw e; return { n: null, code: e.code, regular: e.code === 'ENOENT' }; }
  };
  const childCannotOpen = (msg) => `tar (child): ${qc(file)}: Cannot open: ${msg}\ntar (child): ${NOT_RECOVERABLE}`;
  const resolveDir = (d) => (d === null ? ctx.cwd : joinPath(ctx.cwd, d));
  const checkDir = (d) => {
    let n = null;
    try { n = ctx.fs.stat(resolveDir(d), '/'); } catch { /* missing */ }
    if (!n || n.type !== 'd') { say(`${qc(d)}: Cannot open: ${n ? 'Not a directory' : 'No such file or directory'}`); say('Error is not recoverable: exiting now'); return false; }
    return true;
  };
  const exRes = exPatterns.map(tarGlob);
  const excluded = (name) => exRes.some(re => { const parts = name.replace(/\/$/, '').split('/'); for (let k = 0; k < parts.length; k++) if (re.test(parts.slice(k).join('/'))) return true; return false; });
  const archiveNode = !toArchiveStdout ? (() => { try { return ctx.fs.stat(file, ctx.cwd); } catch { return null; } })() : null;
  let ugswidth = 19;
  const listLine = (type, mode, size, mtime, name, link, own = ROOT_OWNER) => {
    const d = new Date(mtime);
    const p2 = (n) => String(n).padStart(2, '0');
    let ts = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
    if (opt.fullTime) ts += ':' + p2(d.getUTCSeconds());
    const t = type === '5' ? 'd' : type === '2' ? 'l' : type === '1' ? 'h' : '-';
    const ms = modeString({ type: t === 'd' ? 'd' : t === 'l' ? 'l' : 'f', mode }).slice(1);
    const user = opt.numeric || !own.uname ? String(own.uid) : own.uname;
    const group = opt.numeric || !own.gname ? String(own.gid) : own.gname;
    const sz = String(size);
    const pad = user.length + 1 + group.length + 1 + sz.length;
    if (pad > ugswidth) ugswidth = pad;
    let s = `${t}${ms} ${user}/${group} ${sz.padStart(ugswidth - pad + sz.length)} ${ts} ${name}`;
    if (type === '2') s += ' -> ' + link;
    else if (type === '1') s += ' link to ' + link;
    return s + '\n';
  };

  // ---- create / append / update
  if (creating) {
    if (!names.length) return fatalUsage('Cowardly refusing to create an empty archive');
    // a missing compression program: the child creat()s the archive (or fails to), the shell
    // can't find PROG, and tar fails once it has been through the names
    let compressFailure = null;
    if (missingProg) {
      const notFound = `/bin/sh: 1: ${progWords[0]}: not found\n`;
      if (toArchiveStdout) compressFailure = notFound + 'tar: Child returned status 127\n';
      else {
        const as = archiveStat();
        if (as.regular) {
          try { ctx.openWrite(file); compressFailure = notFound + 'tar: Child returned status 127\n'; }
          catch (e) { if (!(e instanceof FsError)) throw e; compressFailure = childCannotOpen(e.message) + 'tar: Child returned status 2\n'; }
        } else if (as.n && as.n.type !== 'd') compressFailure = notFound + 'tar: Child returned status 127\n';
        else compressFailure = childCannotOpen(as.n ? 'Is a directory' : new FsError(as.code, file).message) + notFound + 'tar: Child returned status 2\n';
      }
      compressFailure += `tar: ${NOT_RECOVERABLE}`;
    }
    for (const n of names) if (n.dir !== null && !checkDir(n.dir)) return 2;
    let arc = '';
    let st = 0;
    const warned = new Set();
    const vout = toArchiveStdout ? ctx.stderr : ctx.stdout;
    let outNode = !missingProg && archiveNode && archiveNode.type === 'f' ? archiveNode : null;
    const oldData = outNode ? outNode.data : '';
    if (!toArchiveStdout && op === 'c' && !missingProg) {
      try { outNode = ctx.openWrite(file).node || ctx.fs.stat(file, ctx.cwd); }
      catch (e) { say(`${qc(file)}: Cannot open: ${e.message}`); say('Error is not recoverable: exiting now'); return 2; }
    }
    const links = new Map();      // node -> first member name (hard links; a file named twice links too)
    const removed = [];
    // --owner/--group: names from /etc/passwd and /etc/group, or numbers
    const lookup = (file, val) => {
      if (/^\+?\d+$/.test(val)) return { id: +val.replace('+', ''), name: '' };
      try {
        for (const l of ctx.readFile(file).split('\n')) {
          const f = l.split(':');
          if (f[0] === val) return { id: +f[2], name: val };
        }
      } catch { /* no such file */ }
      return null;
    };
    const owner = { ...ROOT_OWNER };
    if (opt.owner !== undefined) {
      const r = lookup('/etc/passwd', opt.owner);
      if (!r) { say(`${qc(opt.owner)}: Invalid owner`); tryHelp(); return 2; }
      owner.uid = r.id; owner.uname = r.name;
    }
    if (opt.group !== undefined) {
      const r = lookup('/etc/group', opt.group);
      if (!r) { say(`${qc(opt.group)}: Invalid group`); tryHelp(); return 2; }
      owner.gid = r.id; owner.gname = r.name;
    }
    // -u: only files newer than their copy in the archive
    const archived = new Map();
    if (op === 'u' && oldData) {
      let q = 0;
      while (q + 512 <= oldData.length && !/^\0*$/.test(oldData.slice(q, q + 512))) {
        const nm = oldData.slice(q, q + 100).replace(/\0[\s\S]*$/, '');
        const size = parseInt(oldData.slice(q + 124, q + 136).replace(/\0[\s\S]*$/, ''), 8) || 0;
        const mt = parseInt(oldData.slice(q + 136, q + 148).replace(/\0[\s\S]*$/, ''), 8) || 0;
        archived.set(nm.replace(/\/+$/, ''), Math.max(archived.get(nm) || 0, mt));
        q += 512 + Math.ceil(size / 512) * 512;
      }
    }
    const add = (rel, base, rec) => {
      let n;
      try { n = opt.deref ? ctx.fs.stat(rel, base) : ctx.fs.lstat(rel, base); }
      catch (e) { say(`${qc(rel)}: Cannot stat: ${e instanceof FsError ? e.message : 'No such file or directory'}`); st = 2; return; }
      if (outNode && n === outNode) { say(`${qc(rel)}: file is the archive; not dumped`); return; }
      let name = rel;
      if (!opt.absolute) {
        const m = /^(\/|(\.\.\/)+|\/(\.\.\/)*)+/.exec(name);
        if (m && m[0]) {
          const pfx = m[0];
          name = name.slice(pfx.length);
          if (!warned.has(pfx)) { say(`Removing leading \`${pfx}' from member names`); warned.add(pfx); }
        }
      }
      if (excluded(name)) return;
      if (op === 'u' && n.type !== 'd' && archived.has(name) && Math.floor(n.mtime / 1000) <= archived.get(name)) return;
      const showName = (shown, type, size, link) => {
        if (!opt.verbose) return;
        if (opt.verbose > 1) vout.write(listLine(type, n.mode & 0o7777, size, n.mtime, shown, link, owner));
        else vout.write(shown + '\n');
      };
      if (n.type === 'd') {
        const dn = name === '' ? '' : name.replace(/\/*$/, '/');
        if (dn) { showName(rel.replace(/\/*$/, '/'), '5', 0); arc += entryHeader(dn, n, '5', '', owner); }
        if (rec) for (const c of [...n.entries.keys()]) add(rel.replace(/\/+$/, '') + '/' + c, base, true);
      } else if (n.type === 'l') {
        showName(rel, '2', 0, n.target);
        arc += entryHeader(name, n, '2', n.target, owner);
      } else if (n.type === 'f') {
        const first = links.get(n);
        if (first !== undefined) {
          showName(rel, '1', 0, first);
          arc += entryHeader(name, n, '1', first, owner);
        } else {
          links.set(n, name);
          showName(rel, '0', n.data.length);
          arc += entryHeader(name, n, '0', '', owner) + n.data + '\0'.repeat((512 - (n.data.length % 512)) % 512);
        }
      }
      if (opt.removeFiles) removed.push([rel, base, n]);
    };
    for (const nm of names) add(nm.name, resolveDir(nm.dir), nm.recursion);
    if (compressFailure !== null) { ctx.stderr.write(compressFailure); return 2; }
    if (op !== 'c' && outNode) {
      let p = 0;
      while (p + 512 <= oldData.length && !/^\0*$/.test(oldData.slice(p, p + 512))) {
        const size = parseInt(oldData.slice(p + 124, p + 136).replace(/\0[\s\S]*$/, ''), 8) || 0;
        p += 512 + Math.ceil(size / 512) * 512;
      }
      arc = oldData.slice(0, p) + arc;
    }
    arc += '\0'.repeat(1024);
    arc += '\0'.repeat((10240 - (arc.length % 10240)) % 10240);
    const rawLen = arc.length;
    let filterStatus = 0;
    if (gz) arc = gzipEncode(arc, { level: gzLevel });
    else if (filterProg) {
      // `/bin/sh -c PROG` writes the archive
      const sink = new OutBuf();
      filterStatus = ctx.runShell(filterProg, { stdin: arc, stdout: sink });
      arc = sink.data;
    }
    if (toArchiveStdout) ctx.out(arc);
    else {
      try { ctx.openWrite(file).write(arc); }
      catch (e) { say(`${qc(file)}: Cannot open: ${e.message}`); say('Error is not recoverable: exiting now'); return 2; }
    }
    if (filterStatus) { say(`Child returned status ${filterStatus}`); say('Error is not recoverable: exiting now'); return 2; }
    for (const [rel, base, n] of removed.reverse()) {
      try { if (n.type === 'd') ctx.fs.rmdir(rel, base); else ctx.fs.unlink(rel, base); } catch { /* ignore */ }
    }
    if (opt.totals) ctx.stderr.write(totalsLine('written', rawLen));
    if (afterOperand.length) {
      say('The following options were used after any non-optional arguments in archive create or update mode.  These options are positional and affect only arguments that follow them.  Please, rearrange them properly.');
      for (const o of afterOperand) say(`${o} has no effect`);
      st = 2;
    }
    if (st) say('Exiting with failure status due to previous errors');
    return st;
  }

  // ---- concatenate (-A) and --delete rewrite the archive file member by member
  const members = (data) => {
    const out = [];
    let p = 0;
    while (p + 512 <= data.length) {
      const h = data.slice(p, p + 512);
      if (/^\0*$/.test(h)) break;
      const size = parseInt(h.slice(124, 136).replace(/\0[\s\S]*$/, ''), 8) || 0;
      const len = 512 + Math.ceil(size / 512) * 512;
      out.push({ name: h.slice(0, 100).replace(/\0[\s\S]*$/, ''), type: h[156], raw: data.slice(p, p + len) });
      p += len;
    }
    return out;
  };
  const finish = (ms) => {
    let arc = ms.map(m => m.raw).join('') + '\0'.repeat(1024);
    arc += '\0'.repeat((10240 - (arc.length % 10240)) % 10240);
    return arc;
  };
  if (op === 'A' || op === 'delete') {
    if (toArchiveStdout) return fatalUsage(op === 'A' ? 'Options \'-Aru\' are incompatible with \'-f -\'' : 'Cannot update compressed archives');
    let cur = '';
    try { cur = ctx.readFile(file); }
    catch (e) {
      if (!(e instanceof FsError)) throw e;
      if (op === 'delete') { say(`${qc(file)}: Cannot open: ${e.message}`); say('Error is not recoverable: exiting now'); return 2; }
    }
    let ms = cur ? members(cur) : [];
    let st = 0;
    if (op === 'A') {
      for (const nm of names) {
        let d;
        try { d = ctx.readFile(nm.name); }
        catch (e) { if (!(e instanceof FsError)) throw e; say(`${qc(nm.name)}: Cannot open: ${e.message}`); st = 2; continue; }
        ms = ms.concat(members(d));
      }
    } else {
      for (const nm of names) nm.found = false;
      ms = ms.filter(m => {
        const bare = m.name.replace(/\/+$/, '');
        for (const nm of names) {
          const w = nm.name.replace(/\/+$/, '');
          if (bare === w || bare.startsWith(w + '/')) { nm.found = true; return false; }
        }
        return true;
      });
    }
    try { ctx.openWrite(file).write(finish(ms)); }
    catch (e) { say(`${qc(file)}: Cannot open: ${e.message}`); say('Error is not recoverable: exiting now'); return 2; }
    if (op === 'delete') {
      for (const nm of names) if (!nm.found) { say(`${qc(nm.name)}: Not found in archive`); st = 2; }
    }
    if (st) say('Exiting with failure status due to previous errors');
    return st;
  }

  // ---- list / extract / compare
  const notFound = (st0) => {
    let st = st0;
    for (const nm of names) {
      if (nm.found) continue;
      if (finalWildcardsDefault && hasWildcards(nm.name)) {
        say('Pattern matching characters used in file names');
        say('Use --wildcards to enable pattern matching, or --no-wildcards to suppress this warning');
      }
      say(`${qc(nm.name)}: Not found in archive`);
      st = 2;
    }
    if (st) say('Exiting with failure status due to previous errors');
    return st;
  };
  if (missingProg) {
    // sys_child_open_for_uncompress(): the child opens a regular (or missing) archive and execs
    // PROG itself; stdin or anything else goes through a grandchild
    const cantExec = (who) => `tar (${who}): ${qc(missingProg)}: Cannot exec: No such file or directory\ntar (${who}): ${NOT_RECOVERABLE}`;
    const as = toArchiveStdout ? null : archiveStat();
    let msg;
    if (as && as.regular) msg = as.n ? cantExec('child') : childCannotOpen(new FsError(as.code, file).message);
    else if (!as || (as.n && as.n.type !== 'd')) msg = cantExec('grandchild');
    else if (as.n) msg = `tar (child): ${qc(file)}: Cannot read: Is a directory\ntar (child): At beginning of tape, quitting now\ntar (child): ${NOT_RECOVERABLE}${cantExec('grandchild')}`;
    else msg = childCannotOpen(new FsError(as.code, file).message) + cantExec('grandchild');
    ctx.stderr.write(msg);
    say('Child returned status 2'); say('Error is not recoverable: exiting now');
    return 2;
  }
  let data;
  if (toArchiveStdout) data = ctx.stdin.readAll();
  else {
    try { data = ctx.readFile(file); }
    catch (e) {
      if (gz || filterProg) { ctx.stderr.write(childCannotOpen(e.message)); say('Child returned status 2'); say('Error is not recoverable: exiting now'); return 2; }
      say(`${qc(file)}: Cannot open: ${e.message}`); say('Error is not recoverable: exiting now'); return 2;
    }
  }
  if (filterProg) {
    // execvp(PROG -d)
    const sink = new OutBuf();
    const fst = ctx.spawn([...progWords, '-d'], { stdin: data, stdout: sink });
    if (fst) { say(`Child returned status ${fst}`); say('Error is not recoverable: exiting now'); return 2; }
    data = sink.data;
  }
  if (gz || data.startsWith('\x1f\x8b')) {
    const r = gunzipStream(data);
    if (r.error) {
      ctx.stderr.write(r.error === 'eof' ? '\ngzip: stdin: unexpected end of file\n' : '\ngzip: stdin: not in gzip format\n');
      say('Child returned status 1'); say('Error is not recoverable: exiting now');
      return 2;
    }
    data = r.data;
  }
  if (data.length < 512 || (data.slice(257, 262) !== 'ustar' && !/^\0*$/.test(data.slice(0, 512)))) {
    say('This does not look like a tar archive');
    if (data.length >= 512) say('Skipping to next header');
    return notFound(2);
  }
  const extractDir = chdir;
  if (op === 'x' && extractDir !== null && !checkDir(extractDir)) return 2;
  let p = 0, st = 0, longName = null, longLink = null;
  const listWarned = new Set();
  while (p + 512 <= data.length) {
    const h = data.slice(p, p + 512);
    if (/^\0*$/.test(h)) {
      if (opt.ignoreZeros) { p += 512; continue; }
      if (p + 1024 > data.length) say(`A lone zero block at ${p / 512 + 1}`);
      break;
    }
    const str = (o, w) => h.slice(o, o + w).replace(/\0[\s\S]*$/, '');
    const own = { uid: parseInt(str(108, 8), 8) || 0, gid: parseInt(str(116, 8), 8) || 0, uname: str(265, 32), gname: str(297, 32) };
    let name = str(0, 100);
    if (h.slice(257, 263) === 'ustar\0') { const prefix = str(345, 155); if (prefix) name = prefix + '/' + name; }
    const fmode = parseInt(str(100, 8), 8) || 0o644;
    const size = parseInt(str(124, 12), 8) || 0;
    const mtime = (parseInt(str(136, 12), 8) || 0) * 1000;
    const type = h[156] === '\0' ? '0' : h[156];
    let link = str(157, 100);
    const truncated = p + 512 + size > data.length;
    const body = data.slice(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (truncated) {
      if (op === 't' && !/^[LK]$/.test(type)) ctx.out(opt.verbose ? listLine(type, fmode, size, mtime, longName ?? name, link, own) : (longName ?? name) + '\n');
      say('Unexpected EOF in archive'); say('Error is not recoverable: exiting now');
      return 2;
    }
    if (type === 'L') { longName = body.replace(/\0[\s\S]*$/, ''); continue; }
    if (type === 'K') { longLink = body.replace(/\0[\s\S]*$/, ''); continue; }
    if (longName !== null) { name = longName; longName = null; }
    if (longLink !== null) { link = longLink; longLink = null; }
    let bare = name.replace(/\/+$/, '');
    if (!opt.absolute) {
      // safer_name_suffix(): leading "/" and "../" are dropped (the listing still shows them)
      const m = /^(\/|(\.\.\/)+|\/(\.\.\/)*)+/.exec(bare);
      if (m && m[0]) {
        bare = bare.slice(m[0].length);
        if (!listWarned.has(m[0])) { say(`Removing leading \`${m[0]}' from member names`); listWarned.add(m[0]); }
      }
    }
    let match = null;
    if (names.length) {
      // each operand names (at most) one member unless it is a directory prefix
      for (const nm of names) {
        const w = nm.name.replace(/\/+$/, '');
        const m = nm.wildcards ? (tarGlob(w).test(bare) || bare.startsWith(w + '/')) : (bare === w || bare.startsWith(w + '/'));
        if (m && (!nm.found || bare !== w)) { match = nm; break; }
      }
      if (!match) continue;
      match.found = true;
    }
    if (excluded(bare)) continue;
    if (op === 't') { ctx.out(opt.verbose ? listLine(type, fmode, size, mtime, name, link, own) : name + '\n'); continue; }
    if (op === 'd') continue;
    const rel = bare.split('/').slice(opt.strip).join('/');
    if (!rel) continue;
    if (opt.toStdout) {
      if (opt.verbose) ctx.stderr.write(opt.verbose > 1 ? listLine(type, fmode, size, mtime, name, link, own) : name + '\n');
      if (type === '0') ctx.out(body);
      continue;
    }
    if (opt.verbose) ctx.stdout.write(opt.verbose > 1 ? listLine(type, fmode, size, mtime, name, link, own) : name + '\n');
    const base = resolveDir(match && match.dir !== null ? match.dir : extractDir);
    const target = joinPath(base, rel);
    try {
      if (type === '5') { ctx.fs.mkdir(target, '/', { parents: true }); }
      else {
        const parent = target.slice(0, target.lastIndexOf('/')) || '/';
        ctx.fs.mkdir(parent, '/', { parents: true });
        let exists = false;
        try { ctx.fs.lstat(target, '/'); exists = true; } catch { /* missing */ }
        if (exists && opt.skipOld) continue;
        if (exists && opt.keepOld) { say(`${qc(rel)}: Cannot open: File exists`); st = 2; continue; }
        if (type === '2') { if (exists) ctx.fs.unlink(target, '/'); ctx.fs.symlink(link, target, '/'); }
        else if (type === '1') {
          const lrel = link.split('/').slice(opt.strip).join('/');
          if (exists) ctx.fs.unlink(target, '/');
          try { ctx.fs.link(joinPath(base, lrel), target, '/'); }
          catch (e) { if (!(e instanceof FsError)) throw e; say(`${qc(rel)}: Cannot hard link to ${ql(lrel)}: ${e.message}`); st = 2; }
        } else if (type === '0') { const n = ctx.fs.writeFile(target, body, '/'); n.mode = fmode & 0o7777; if (!opt.touch) n.mtime = mtime; }
      }
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      say(`${qc(rel)}: Cannot open: ${e.message}`); st = 2;
    }
  }
  if (opt.totals) ctx.stderr.write(totalsLine('read', Math.ceil(p / 10240) * 10240 || 10240));
  return notFound(st);
};

export default C;
