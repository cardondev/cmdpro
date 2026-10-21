// File utilities: ls cp mv rm mkdir rmdir touch ln chmod chown chgrp stat du df file tree realpath
// readlink mktemp truncate pwd dd install
import { parseArgs, qa, qf, filevercmp, fileNameConcat, stripTrailingSlashes, lastComponent, getopt, argmatch, argmatchMessage, yesno, BACKUP_ARGS, simpleBackupSuffix, backupName, quotearg } from './util.js';
import { FsError, joinPath, normPath, basename as pbase, dirname as pdir, modeString, byteCmp } from '../vfs.js';
import { strftime, parseDate } from '../timefmt.js';
import { isValidUtf8 } from '../bytes.js';
import { StdioBuffer } from './util.js';
import { utf8Encode } from '../bytes.js';
import { fixedDigits } from '../cfmt.js';

const C = {};
const USERS = { 0: 'root', 1: 'daemon', 2: 'bin', 3: 'sys', 65534: 'nobody', 1000: 'player' };
const userName = (uid) => USERS[uid] ?? String(uid);
const groupName = (gid) => ({ 0: 'root', 1: 'daemon', 2: 'bin', 3: 'sys', 65534: 'nogroup', 1000: 'player' })[gid] ?? String(gid);
const blocksK = (n) => n.type === 'd' ? 4 : n.type === 'f' ? Math.ceil(n.size / 4096) * 4 : 0;

function lstatSafe(ctx, p) { try { return ctx.fs.lstat(p, ctx.cwd); } catch { return null; } }
function statSafe(ctx, p) { try { return ctx.fs.stat(p, ctx.cwd); } catch { return null; } }

function humanSize(n, si = false) {
  const base = si ? 1000 : 1024;
  if (n < base) return String(n);
  const units = 'KMGTPE';
  let v = n, u = -1;
  while (v >= base && u < units.length - 1) { v /= base; u++; }
  let s = v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : String(Math.ceil(v));
  if (v < 10 && parseFloat(s) >= 10) s = '10';
  return s + units[u];
}

// ---------------------------------------------------------------- cp / mv / rm
function isSameNode(ctx, a, b) { const x = statSafe(ctx, a), y = statSafe(ctx, b); return x && y && x === y; }

// gnulib mdir_name(): FILE's directory part ("." when it has none)
function mdirName(file) {
  const prefix = file[0] === '/' ? 1 : 0;
  let len = file.length - lastComponent(file).length;
  while (prefix < len && file[len - 1] === '/') len--;
  return len ? file.slice(0, len) : '.';
}

// copy.c copy_internal() for cp -s: a directory (-r) is recreated and walked, anything else
// becomes a symlink holding the source name, which must be absolute unless the link is made in
// the current directory. Returns false on failure.
function cpSymlink(ctx, src, dest, sn, o) {
  const dl = lstatSafe(ctx, dest);
  if (dl) {
    // same_file_ok(): a destination that is the source itself (not a symlink to it)
    if (dl.type !== 'l' && statSafe(ctx, src) === dl) { ctx.err(`${qa(src)} and ${qa(dest)} are the same file`); return false; }
    if (dl === sn && sn.type === 'l') {
      if (normPath(joinPath(ctx.cwd, src)) === normPath(joinPath(ctx.cwd, dest))) { ctx.err(`${qa(src)} and ${qa(dest)} are the same file`); return false; }
      return true;
    }
    if (sn.type !== 'd') {
      if (o.update && dl.mtime >= sn.mtime) return true;
      if (o.noClobber) return true;
    }
    if (dl.type !== 'd' && sn.type === 'd') { ctx.err(`cannot overwrite non-directory ${qa(dest)} with directory ${qa(src)}`); return false; }
    if (dl.type === 'd' && sn.type !== 'd') { ctx.err(`cannot overwrite directory ${qa(dest)} with non-directory`); return false; }
  }
  if (sn.type === 'd') {
    // the first directory made for an operand is remembered: meeting it again as a source is
    // copying a directory into itself, which ends that operand (copy_dir() stops there)
    if (sn === o.firstDir) { ctx.err(`cannot copy a directory, ${qa(o.topSrc)}, into itself, ${qa(o.topDest)}`); o.intoSelf = true; return false; }
    if (!dl) {
      try { ctx.fs.mkdir(dest, ctx.cwd); const dn = ctx.fs.stat(dest, ctx.cwd); dn.mode = sn.mode; if (!o.firstDir) o.firstDir = dn; }
      catch (e) { if (e instanceof FsError) { ctx.err(`cannot create directory ${qa(dest)}: ${e.message}`); return false; } throw e; }
      if (o.verbose) ctx.out(`${qa(src)} -> ${qa(dest)}\n`);
    }
    let ok = true;
    for (const name of [...sn.entries.keys()]) {
      const cs = fileNameConcat(src, name), cd = fileNameConcat(dest, name);
      const cn = o.noDeref ? lstatSafe(ctx, cs) : statSafe(ctx, cs);
      if (!cn) continue;
      if (!cpSymlink(ctx, cs, cd, cn, o)) ok = false;
      if (o.intoSelf) break;
    }
    return ok;
  }
  if (o.verbose) ctx.out(`${qa(src)} -> ${qa(dest)}\n`);
  if (src[0] !== '/') {
    const parent = mdirName(dest);
    const dot = statSafe(ctx, '.'), pn = statSafe(ctx, parent);
    if (!(parent === '.' || !dot || !pn || dot === pn)) {
      ctx.err(`${qf(dest)}: can make relative symbolic links only in current directory`);
      return false;
    }
  }
  try {
    // force_symlinkat(): -f replaces an existing destination
    if (lstatSafe(ctx, dest) && o.force) ctx.fs.unlink(dest, ctx.cwd);
    ctx.fs.symlink(src, dest, ctx.cwd);
  } catch (e) {
    if (e instanceof FsError) { ctx.err(`cannot create symbolic link ${qa(dest)} to ${qa(src)}: ${e.message}`); return false; }
    throw e;
  }
  return true;
}

C.cp = (ctx) => {
  const a = parseArgs(ctx, { short: 'abdfHilLnPprRst:Tuvx', long: { archive: 'a', backup: ['b', 'optional'], force: 'f', interactive: 'i', link: 'l', dereference: 'L', 'no-clobber': 'n', 'no-dereference': 'P', preserve: ['preserve', 'optional'], 'no-preserve': ['nopreserve', 'required'], recursive: 'R', 'symbolic-link': 's', 'target-directory': ['t', 'required'], 'no-target-directory': 'T', update: 'u', verbose: 'v', parents: 'parents', 'remove-destination': 'rd', 'one-file-system': 'x', 'strip-trailing-slashes': 'sts', reflink: ['reflink', 'optional'], sparse: ['sparse', 'required'], 'attributes-only': 'ao' } });
  if (!a) return 1;
  const rec = a.has('r') || a.has('R') || a.has('a');
  const verbose = a.has('v'), noClobber = a.has('n') || a.has('i'), update = a.has('u'), symlinkMode = a.has('s'), hardlinkMode = a.has('l');
  const keep = a.has('a') || a.has('p') || a.has('preserve');
  const noDeref = a.has('P') || a.has('a') || (rec && !a.has('L') && !a.has('H'));
  let ops = a.operands;
  let target = a.get('t');
  if (!ops.length) { ctx.err('missing file operand'); ctx.stderr.write("Try 'cp --help' for more information.\n"); return 1; }
  if (!target) {
    if (ops.length === 1) { ctx.err(`missing destination file operand after ${qa(ops[0])}`); ctx.stderr.write("Try 'cp --help' for more information.\n"); return 1; }
    target = ops[ops.length - 1];
    ops = ops.slice(0, -1);
  }
  const tnode = statSafe(ctx, target);
  const intoDir = !a.has('T') && tnode && tnode.type === 'd';
  if (ops.length > 1 && !intoDir) { ctx.err(`target ${qa(target)} is not a directory`); return 1; }
  let st = 0;
  const seenSrc = new Set();
  for (const src of ops) {
    let sn = noDeref ? lstatSafe(ctx, src) : statSafe(ctx, src);
    if (!sn) { ctx.err(`cannot stat ${qa(src)}: No such file or directory`); st = 1; continue; }
    if (ops.length > 1 && sn.type !== 'd') {
      if (seenSrc.has(sn)) { ctx.err(`warning: source file ${qa(src)} specified more than once`); continue; }
      seenSrc.add(sn);
    }
    const srcBase = pbase(stripTrailingSlashes(src)) || src;
    let dest = intoDir ? (a.has('parents') ? joinPath(target, src.replace(/^\/+/, '')) : srcBase === '..' ? target : fileNameConcat(target, srcBase)) : target;
    if (symlinkMode) {
      if (a.has('parents') && intoDir) { try { ctx.fs.mkdir(pdir(dest), ctx.cwd, { parents: true }); } catch {} }
      if (sn.type === 'd' && !rec) { ctx.err(`-r not specified; omitting directory ${qa(src)}`); st = 1; continue; }
      if (!cpSymlink(ctx, src, dest, sn, { verbose, noClobber, update, force: a.has('f'), noDeref, topSrc: src, topDest: dest, firstDir: null, intoSelf: false })) st = 1;
      continue;
    }
    if (/^\/dev\/(stdout|stderr|null|tty|fd\/[12])$/.test(dest) || /^\/proc\/self\/fd\/[12]$/.test(dest)) {
      if (sn.type === 'd') { ctx.err(`-r not specified; omitting directory ${qa(src)}`); st = 1; continue; }
      ctx.openWrite(dest).write(sn.data || '');
      continue;
    }
    if (a.has('parents') && intoDir) { try { ctx.fs.mkdir(pdir(dest), ctx.cwd, { parents: true }); } catch {} }
    if (sn.type === 'd' && !rec) { ctx.err(`-r not specified; omitting directory ${qa(src)}`); st = 1; continue; }
    if (isSameNode(ctx, src, dest) && !symlinkMode) { ctx.err(`${qa(src)} and ${qa(dest)} are the same file`); st = 1; continue; }
    if (sn.type === 'd') {
      // copying into itself?
      const sAbs = ctx.fs.realpath(src, ctx.cwd);
      const dParent = ctx.fs.tryResolve(pdir(dest), ctx.cwd);
      if (dParent && (dParent.path === sAbs || dParent.path.startsWith(sAbs + '/'))) { ctx.err(`cannot copy a directory, ${qa(src)}, into itself, ${qa(dest)}`); st = 1; continue; }
    }
    const existing = lstatSafe(ctx, dest);
    if (existing && noClobber) continue;
    if (existing && update && existing.mtime >= sn.mtime) continue;
    if (existing && existing.type === 'd' && sn.type !== 'd') { ctx.err(`cannot overwrite directory ${qa(dest)} with non-directory`); st = 1; continue; }
    if (existing && existing.type !== 'd' && sn.type === 'd') { ctx.err(`cannot overwrite non-directory ${qa(dest)} with directory ${qa(src)}`); st = 1; continue; }
    try {
      if (hardlinkMode && sn.type !== 'd') { if (existing) ctx.fs.unlink(dest, ctx.cwd); ctx.fs.link(src, dest, ctx.cwd); }
      else copyNode(ctx, sn, src, dest, keep, existing, noDeref, verbose);
    } catch (e) {
      // copy_reg: EISDIR for "dir/" that doesn't exist reads better as ENOTDIR
      if (e instanceof FsError) { ctx.err(`cannot create regular file ${qa(dest)}: ${e.code === 'EISDIR' && dest.endsWith('/') ? 'Not a directory' : e.message}`); st = 1; continue; }
      throw e;
    }
    if (verbose && hardlinkMode) ctx.out(`${qa(src)} -> ${qa(dest)}\n`);
  }
  return st;
};

function copyNode(ctx, sn, src, dest, keep, existing, noDeref, verbose) {
  const fs = ctx.fs;
  if (verbose) ctx.out(`${qa(src)} -> ${qa(dest)}\n`);
  if (sn.type === 'd') {
    let dn = existing;
    if (!dn) { fs.mkdir(dest, ctx.cwd); dn = fs.stat(dest, ctx.cwd); dn.mode = sn.mode; }
    for (const name of [...sn.entries.keys()]) {
      const child = sn.entries.get(name);
      const cs = joinPath(src, name), cd = joinPath(dest, name);
      let c = child;
      if (c.type === 'l' && !noDeref) { const t = statSafe(ctx, cs); if (t) c = t; }
      copyNode(ctx, c, cs, cd, keep, lstatSafe(ctx, cd), noDeref, verbose);
    }
    if (keep) { dn.mtime = sn.mtime; }
    return;
  }
  if (sn.type === 'l') {
    if (existing) fs.unlink(dest, ctx.cwd);
    fs.symlink(sn.target, dest, ctx.cwd);
    return;
  }
  const n = fs.writeFile(dest, sn.data || '', ctx.cwd);
  if (!existing || keep) n.mode = sn.mode & ~(keep ? 0 : fs.umask) | (keep ? 0 : 0);
  if (!existing) n.mode = sn.mode & ~fs.umask & 0o7777 | (sn.mode & 0o111 ? sn.mode & 0o111 & ~fs.umask : 0);
  if (keep) { n.mode = sn.mode; n.mtime = sn.mtime; n.atime = sn.atime; }
}

// mv (coreutils 8.32 mv.c and copy_internal's move mode; one file system, so rename always works)
class MvExit { constructor(st) { this.st = st; } }
C.mv = (ctx) => {
  const fs = ctx.fs, cwd = ctx.cwd;
  const usage = () => { ctx.stderr.write("Try 'mv --help' for more information.\n"); throw new MvExit(1); };
  const die = (msg) => { ctx.err(msg); throw new MvExit(1); };
  try {
    const r = getopt(ctx.argv.slice(1), { name: 'mv', short: 'bfint:uvS:TZ', long: { backup: ['b', 'optional'], context: 'Z', force: 'f', interactive: 'i', 'no-clobber': 'n', 'no-target-directory': 'T', 'strip-trailing-slashes': 'sts', suffix: ['S', 'required'], 'target-directory': ['t', 'required'], update: 'u', verbose: 'v', help: 'help', version: 'version' } });
    let makeBackups = false, vc = null, interactive = 'unspecified', stripSlashes = false, target = null, noTarget = false, update = false, verbose = false, suffixOpt = null;
    for (const [k, v] of r.opts) {
      switch (k) {
        case 'b': makeBackups = true; if (typeof v === 'string') vc = v; break;
        case 'f': interactive = 'yes'; break;
        case 'i': interactive = 'ask'; break;
        case 'n': interactive = 'no'; break;
        case 'sts': stripSlashes = true; break;
        case 't': {
          if (target !== null) die('multiple target directories specified');
          let n;
          try { n = fs.stat(v, cwd); } catch (e) { if (e instanceof FsError) die(`failed to access ${qa(v)}: ${e.message}`); throw e; }
          if (n.type !== 'd') die(`target ${qa(v)} is not a directory`);
          target = v;
          break;
        }
        case 'T': noTarget = true; break;
        case 'u': update = true; break;
        case 'v': verbose = true; break;
        case 'S': makeBackups = true; suffixOpt = v; break;
        default: break;
      }
    }
    if (r.error) { ctx.stderr.write(r.error + '\n'); usage(); }
    const files = r.operands.slice();
    if (files.length <= (target === null ? 1 : 0)) {
      if (!files.length) ctx.err('missing file operand');
      else ctx.err(`missing destination file operand after ${qa(files[0])}`);
      usage();
    }
    // rename(2), optionally RENAME_NOREPLACE: 0 or the errno name
    const doRename = (src, dst, noreplace) => {
      try {
        const lc = lastComponent(src).replace(/\/+$/, '');
        if (lc === '.' || lc === '..') { try { fs.lstat(src, cwd); return 'EBUSY'; } catch (e) { return e.code || 'ENOENT'; } }
        const sp = fs.parentOf(src, cwd);
        const sn = sp.dir && sp.dir.entries.get(sp.name);
        if (!sn) return lstatErr(src);
        if (noreplace) {
          try { fs.lstat(dst, cwd); return 'EEXIST'; } catch (e) { if (!(e instanceof FsError)) throw e; if (e.code !== 'ENOENT') return e.code; }
        }
        let dn = null;
        try { dn = fs.lstat(dst, cwd); } catch { /* new */ }
        if (dn && dn === sn) return 0;
        fs.rename(src, dst, cwd);
        return 0;
      } catch (e) {
        if (e instanceof FsError) return e.code;
        throw e;
      }
    };
    const lstatErr = (p) => { try { fs.lstat(p, cwd); return 'ENOENT'; } catch (e) { return e.code || 'ENOENT'; } };
    const msg = (code) => new FsError(code, '').message;
    let renameErrno = -1;
    if (noTarget) {
      if (target !== null) die('cannot combine --target-directory (-t) and --no-target-directory (-T)');
      if (files.length > 2) { ctx.err(`extra operand ${qa(files[2])}`); usage(); }
    } else if (target === null) {
      if (files.length === 2) renameErrno = doRename(files[0], files[1], true);
      const last = files[files.length - 1];
      let isDir = false;
      if (renameErrno !== 0) {
        try { isDir = fs.stat(last, cwd).type === 'd'; }
        catch (e) { if (!(e instanceof FsError)) throw e; if (e.code !== 'ENOENT') die(`failed to access ${qa(last)}: ${e.message}`); }
      }
      if (renameErrno !== 0 && isDir) { renameErrno = -1; target = files.pop(); }
      else if (files.length > 2) die(`target ${qa(last)} is not a directory`);
    }
    if (interactive === 'no') update = false;
    if (makeBackups && interactive === 'no') { ctx.err('options --backup and --no-clobber are mutually exclusive'); usage(); }
    let backupType = 'none';
    if (makeBackups) {
      const [names, values] = BACKUP_ARGS;
      const what = vc ? 'backup type' : '$VERSION_CONTROL';
      const spec = vc || (ctx.env || {}).VERSION_CONTROL;
      if (!spec) backupType = 'existing';
      else {
        const i = argmatch(spec, names, values);
        if (i < 0) { ctx.stderr.write(argmatchMessage('mv', what, spec, i, names, values)); usage(); }
        backupType = values[i];
      }
    }
    const suffix = simpleBackupSuffix(ctx, suffixOpt);
    const seenDest = new Set();
    const sameName = (a, b) => {
      const la = lastComponent(a).replace(/\/+$/, ''), lb = lastComponent(b).replace(/\/+$/, '');
      if (la !== lb) return false;
      try { return fs.stat(pdir(stripTrailingSlashes(a)), cwd) === fs.stat(pdir(stripTrailingSlashes(b)), cwd); } catch { return false; }
    };
    const sameFileOk = (src, ss, dst, ds) => {
      const same = ss === ds;
      if (ss.type === 'l' && ds.type === 'l') {
        const sn = sameName(src, dst);
        if (!sn) { if (backupType !== 'none') return true; if (same) return false; }
        return !sn;
      }
      if (backupType !== 'none') return !same ? true : !sameName(src, dst);
      if (ds.type === 'l') return true;
      if (same && ds.nlink > 1 && !sameName(src, dst)) return false;
      if (ss.type !== 'l' && ds.type !== 'l' && !same) return true;
      if (ss.type === 'l' && ds.nlink > 1) {
        try { return !sameName(fs.realpath(src, cwd), dst); } catch { /* dangling */ }
      }
      let ts, td;
      try { ts = ss.type === 'l' ? fs.stat(src, cwd) : ss; } catch { return true; }
      try { td = ds.type === 'l' ? fs.stat(dst, cwd) : ds; } catch { return true; }
      return ts !== td;
    };
    const moveOne = (src, dst, initialErrno, cmdline, lastFile) => {
      let re = initialErrno;
      if (re === -1) re = doRename(src, dst, true);
      let newDst = re === 0;
      let ss = null, ds = null, backup = null;
      if (re === 0 ? !lastFile : (re !== 'EEXIST' || interactive !== 'no')) {
        const name = re === 0 ? dst : src;
        try { ss = fs.lstat(name, cwd); }
        catch (e) { if (!(e instanceof FsError)) throw e; ctx.err(`cannot stat ${qa(name)}: ${e.message}`); return false; }
      }
      if (!newDst) {
        if (!(re === 'EEXIST' && interactive === 'no')) {
          try { ds = fs.lstat(dst, cwd); re = 'EEXIST'; }
          catch (e) {
            if (!(e instanceof FsError)) throw e;
            if (e.code !== 'ENOENT') { ctx.err(`cannot stat ${qa(dst)}: ${e.message}`); return false; }
            newDst = true;
          }
        }
        if (re === 'EEXIST') {
          if (interactive === 'no') return true;
          if (!sameFileOk(src, ss, dst, ds)) { ctx.err(`${qa(src)} and ${qa(dst)} are the same file`); return false; }
          if (update && ss.type !== 'd' && ds.mtime >= ss.mtime) return true;
          if (interactive === 'ask') {
            ctx.stderr.write(`mv: overwrite ${qa(dst)}? `);
            if (!yesno(ctx)) return true;
          }
          if (ds.type !== 'd') {
            if (ss.type === 'd' && backupType === 'none') { ctx.err(`cannot overwrite non-directory ${qa(dst)} with directory ${qa(src)}`); return false; }
            if (cmdline && backupType !== 'numbered' && seenDest.has(dst + '\0' + ds.ino)) { ctx.err(`will not overwrite just-created ${qa(dst)} with ${qa(src)}`); return false; }
          }
          if (ss.type !== 'd' && ds.type === 'd' && backupType === 'none') { ctx.err(`cannot overwrite directory ${qa(dst)} with non-directory`); return false; }
          const srcbase = lastComponent(src);
          if (backupType !== 'none' && srcbase !== '.' && srcbase !== '..') {
            if (backupType !== 'numbered' && srcbase === lastComponent(dst) + suffix) {
              try { if (fs.stat(dst + suffix, cwd) === ss) { ctx.err(`backing up ${qa(dst)} might destroy source;  ${qa(src)} not moved`); return false; } } catch { /* none */ }
            }
            backup = backupName(ctx, dst, backupType, suffix);
            try { fs.rename(dst, backup, cwd); }
            catch (e) { if (!(e instanceof FsError)) throw e; if (e.code !== 'ENOENT') { ctx.err(`cannot backup ${qa(dst)}: ${e.message}`); return false; } backup = null; }
            newDst = true;
          }
        }
      }
      if (re === 'EEXIST') re = doRename(src, dst, false);
      if (re === 0) {
        if (verbose) ctx.out(`renamed ${qa(src)} -> ${qa(dst)}${backup ? ` (backup: ${qa(backup)})` : ''}\n`);
        if (cmdline && !lastFile) { try { seenDest.add(dst + '\0' + fs.lstat(dst, cwd).ino); } catch { /* gone */ } }
        return true;
      }
      if (re === 'EINVAL') { ctx.err(`cannot move ${qa(src)} to a subdirectory of itself, ${qa(dst)}`); return false; }
      ctx.err(`cannot move ${qa(src)} to ${qa(dst)}: ${msg(re)}`);
      return false;
    };
    const movefile = (src, dest, destIsDir, errno, lastFile) => {
      if (stripSlashes) src = stripTrailingSlashes(src);
      if (destIsDir) dest = stripTrailingSlashes(fileNameConcat(dest, lastComponent(src)));
      return moveOne(src, dest, errno, true, lastFile);
    };
    let ok = true;
    if (target !== null) {
      files.forEach((f, i) => { ok = movefile(f, target, true, -1, i + 1 === files.length) && ok; });
    } else ok = movefile(files[0], files[1], false, renameErrno, true);
    return ok ? 0 : 1;
  } catch (e) {
    if (e instanceof MvExit) return e.st;
    throw e;
  }
};

// rm (coreutils 8.32 rm.c / remove.c): stdin is never a terminal here, so only -i and -I ask.
const FILE_TYPES = { f: (n) => (n.size ? 'regular file' : 'regular empty file'), d: () => 'directory', l: () => 'symbolic link', p: () => 'fifo', s: () => 'socket', c: () => 'character special file', b: () => 'block special file' };
C.rm = (ctx) => {
  const fs = ctx.fs, cwd = ctx.cwd;
  const r = getopt(ctx.argv.slice(1), { name: 'rm', short: 'dfirvIR', long: { dir: 'd', force: 'f', interactive: ['interactive', 'optional'], 'one-file-system': 'ofs', 'no-preserve-root': 'npr', 'preserve-root': ['pr', 'optional'], 'presume-input-tty': 'tty', recursive: 'r', verbose: 'v', help: 'help', version: 'version' } });
  let interactive = 'sometimes', ignoreMissing = false, promptOnce = false, recursive = false, removeEmptyDirs = false, verbose = false, preserveRoot = true, stdinTty = false;
  for (const [k, v] of r.opts) {
    switch (k) {
      case 'd': removeEmptyDirs = true; break;
      case 'f': interactive = 'never'; ignoreMissing = true; promptOnce = false; break;
      case 'i': interactive = 'always'; ignoreMissing = false; promptOnce = false; break;
      case 'I': interactive = 'sometimes'; ignoreMissing = false; promptOnce = true; break;
      case 'r': case 'R': recursive = true; break;
      case 'interactive': {
        const names = ['never', 'no', 'none', 'once', 'always', 'yes'], values = ['never', 'never', 'never', 'once', 'always', 'always'];
        const i = v === null || v === undefined ? 4 : argmatch(v, names, values);
        if (i < 0) { ctx.stderr.write(argmatchMessage('rm', '--interactive', v, i, names, values) + "Try 'rm --help' for more information.\n"); return 1; }
        const w = values[i];
        if (w === 'never') { interactive = 'never'; promptOnce = false; }
        else if (w === 'once') { interactive = 'sometimes'; ignoreMissing = false; promptOnce = true; }
        else { interactive = 'always'; ignoreMissing = false; promptOnce = false; }
        break;
      }
      case 'npr': preserveRoot = false; break;
      case 'pr':
        if (v !== null && v !== undefined && v !== 'all') { ctx.err(`unrecognized --preserve-root argument: ${qa(v)}`); return 1; }
        preserveRoot = true;
        break;
      case 'tty': stdinTty = true; break;
      case 'v': verbose = true; break;
      default: break;
    }
  }
  if (r.error) {
    ctx.stderr.write(r.error + '\n');
    // diagnose_leading_hyphen()
    for (const x of ctx.argv.slice(1)) {
      if (x[0] === '-' && x.length > 1 && lstatSafe(ctx, x)) { ctx.stderr.write(`Try '${ctx.argv[0]} ./${qf(x)}' to remove the file ${qa(x)}.\n`); break; }
    }
    ctx.stderr.write("Try 'rm --help' for more information.\n");
    return 1;
  }
  const files = r.operands;
  if (!files.length) {
    if (interactive === 'never') return 0;
    ctx.err('missing operand');
    ctx.stderr.write("Try 'rm --help' for more information.\n");
    return 1;
  }
  if (promptOnce && (recursive || files.length > 3)) {
    const n = files.length;
    ctx.stderr.write(recursive ? `rm: remove ${n} argument${n === 1 ? '' : 's'} recursively? ` : `rm: remove ${n} argument${n === 1 ? '' : 's'}? `);
    if (!yesno(ctx)) return 0;
  }
  let status = 0;   // 0 ok, 1 error
  const OK = 0, DECLINED = 1, ERROR = 2;
  // prompt(): RM_OK, RM_USER_DECLINED or RM_ERROR
  const prompt = (path, node, isDir, descend, isEmpty, childFailed) => {
    if (childFailed) return DECLINED;
    if (interactive === 'never') return OK;
    let wp = false;   // root may write anything
    if (!(wp || interactive === 'always')) return OK;
    let type = isDir ? 'd' : node.type;
    if (type === 'l' && interactive !== 'always') return OK;
    if (type === 'd' && !(recursive || (removeEmptyDirs && isEmpty))) { ctx.err(`cannot remove ${qa(path)}: Is a directory`); return ERROR; }
    if (type === 'd' && descend && !isEmpty) ctx.stderr.write(`rm: descend into directory ${qa(path)}? `);
    else ctx.stderr.write(`rm: remove ${(FILE_TYPES[node.type] || (() => 'file'))(node)} ${qa(path)}? `);
    return yesno(ctx) ? OK : DECLINED;
  };
  const excise = (path, node, isDir) => {
    try {
      if (isDir) fs.rmdir(path, cwd); else fs.unlink(path, cwd);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      if (ignoreMissing && e.code === 'ENOENT') return OK;
      ctx.err(`cannot remove ${qa(path)}: ${e.message}`);
      return ERROR;
    }
    if (verbose) ctx.out(isDir ? `removed directory ${qa(path)}\n` : `removed ${qa(path)}\n`);
    return OK;
  };
  // returns { st, failed } — failed marks the ancestors (a child was kept)
  const visit = (path, node, top) => {
    ctx.tick && ctx.tick();
    if (node.type === 'd') {
      const isEmpty = node.entries.size === 0;
      if (!recursive && !(removeEmptyDirs && isEmpty)) {
        ctx.err(`cannot remove ${qa(path)}: ${removeEmptyDirs ? 'Directory not empty' : 'Is a directory'}`);
        return { st: ERROR, failed: true };
      }
      if (top) {
        const lc = lastComponent(path).replace(/\/+$/, '');
        if (lc === '.' || lc === '..') {
          ctx.err(`refusing to remove '.' or '..' directory: skipping ${qa(path)}`);
          return { st: ERROR, failed: true };
        }
        let isRoot = false;
        try { isRoot = fs.stat(path, cwd) === fs.stat('/', '/'); } catch { /* gone */ }
        if (isRoot && preserveRoot) {
          ctx.err(path === '/' ? "it is dangerous to operate recursively on '/'" : `it is dangerous to operate recursively on ${qa(path)} (same as '/')`);
          ctx.err('use --no-preserve-root to override this failsafe');
          return { st: ERROR, failed: true };
        }
      }
      let s = prompt(path, node, true, true, isEmpty, false);
      if (s === OK && isEmpty) { s = excise(path, node, true); return { st: s, failed: s !== OK }; }
      if (s !== OK) return { st: s, failed: true };
      let childFailed = false, worst = OK;
      for (const name of [...node.entries.keys()]) {
        const child = node.entries.get(name);
        const cp = path.endsWith('/') ? path + name : path + '/' + name;
        const c = visit(cp, child, false);
        if (c.failed) childFailed = true;
        if (c.st === ERROR) worst = ERROR;
      }
      // post-order: the directory itself
      s = prompt(path, node, true, false, node.entries.size === 0, childFailed);
      if (s !== OK) return { st: s === ERROR || worst === ERROR ? ERROR : DECLINED, failed: true };
      const e = excise(path, node, true);
      return { st: e === ERROR ? ERROR : worst, failed: e !== OK };
    }
    const s = prompt(path, node, false, false, false, false);
    if (s !== OK) return { st: s, failed: true };
    const e = excise(path, node, false);
    return { st: e, failed: e !== OK };
  };
  for (const f of files) {
    let node;
    try { node = fs.lstat(f, cwd); }
    catch (e) {
      if (!(e instanceof FsError)) throw e;
      if (ignoreMissing && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) continue;
      ctx.err(`cannot remove ${qa(f)}: ${e.message}`);
      status = 1;
      continue;
    }
    // a trailing slash on a symlink to a directory names the directory
    if (node.type === 'l' && /\/$/.test(f)) { try { node = fs.stat(f, cwd); } catch { /* dangling */ } }
    const res = visit(f, node, true);
    if (res.st === ERROR) status = 1;
  }
  return status;
};

// ---------------------------------------------------------------- mkdir / rmdir / touch
function parseModeArg(spec, base, isDir) {
  if (/^[0-7]+$/.test(spec)) {
    const v = parseInt(spec, 8);
    if (spec.length <= 3 && isDir) return (base & 0o7000 & ~0o7000) | v; // directories keep setgid unless 4+ digits given
    return v;
  }
  let mode = base;
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)([-+=])([rwxXst]*|[ugo])$/.exec(clause);
    if (!m) {
      // multiple ops in one clause like u+x-w
      const mm = /^([ugoa]*)((?:[-+=][rwxXst]*)+)$/.exec(clause);
      if (!mm) return null;
      for (const opm of mm[2].match(/[-+=][rwxXst]*/g)) {
        const r = parseModeArg(mm[1] + opm, mode, isDir);
        if (r === null) return null;
        mode = r;
      }
      continue;
    }
    let who = m[1] || 'a';
    const implicitWho = !m[1];
    if (who.includes('a')) who = 'ugo';
    const op = m[2];
    let perms = m[3];
    let bits = 0;
    if (/^[ugo]$/.test(perms)) {
      const shift = { u: 6, g: 3, o: 0 }[perms];
      const p = (mode >> shift) & 7;
      for (const w of who) bits |= p << { u: 6, g: 3, o: 0 }[w];
    } else {
      for (const w of who) {
        const sh = { u: 6, g: 3, o: 0 }[w];
        for (const p of perms) {
          if (p === 'r') bits |= 4 << sh;
          if (p === 'w') bits |= 2 << sh;
          if (p === 'x') bits |= 1 << sh;
          if (p === 'X' && (isDir || (mode & 0o111))) bits |= 1 << sh;
          if (p === 's' && w === 'u') bits |= 0o4000;
          if (p === 's' && w === 'g') bits |= 0o2000;
          if (p === 't') bits |= 0o1000;
        }
      }
      if (implicitWho && op !== '=') bits &= ~0o022 | 0o7000 | 0o700 | 0o055 & ~0o022;
    }
    if (op === '+') mode |= bits;
    else if (op === '-') mode &= ~bits;
    else {
      let clear = 0;
      for (const w of who) clear |= 7 << { u: 6, g: 3, o: 0 }[w];
      if (who.includes('u')) clear |= 0o4000;
      if (who.includes('g')) clear |= 0o2000;
      mode = (mode & ~clear) | bits;
    }
  }
  return mode;
}

C.mkdir = (ctx) => {
  const a = parseArgs(ctx, { short: 'm:pvZ', long: { mode: ['m', 'required'], parents: 'p', verbose: 'v', context: ['Z', 'optional'] } });
  if (!a) return 1;
  if (!a.operands.length) { ctx.err('missing operand'); ctx.stderr.write("Try 'mkdir --help' for more information.\n"); return 1; }
  let st = 0;
  for (const d of a.operands) {
    try {
      const created = ctx.fs.mkdir(d, ctx.cwd, { parents: a.has('p') });
      if (a.has('m')) { const n = ctx.fs.stat(d, ctx.cwd); const m = parseModeArg(a.get('m'), 0o777 & ~ctx.fs.umask, true); if (m === null) { ctx.err(`invalid mode ${qa(a.get('m'))}`); return 1; } n.mode = m; }
      if (a.has('v')) for (const c of created) ctx.out(`mkdir: created directory ${qa(a.has('p') ? relPath(ctx, c, d) : d)}\n`);
    } catch (e) {
      if (e instanceof FsError) { ctx.err(`cannot create directory ${qa(d)}: ${e.message}`); st = 1; continue; }
      throw e;
    }
  }
  return st;
};

// mkfifo (coreutils 8.32): the fifo's mode is 0666 less the umask unless -m says otherwise
C.mkfifo = (ctx) => {
  const a = parseArgs(ctx, { short: 'm:Z', long: { mode: ['m', 'required'], context: ['Z', 'optional'] } });
  if (!a) return 1;
  let mode = 0o666 & ~ctx.fs.umask;
  if (a.has('m')) {
    const m = parseModeArg(a.get('m'), 0o666, false);
    if (m === null) { ctx.err('invalid mode'); return 1; }
    mode = m;
  }
  if (!a.operands.length) { ctx.err('missing operand'); ctx.stderr.write("Try 'mkfifo --help' for more information.\n"); return 1; }
  let st = 0;
  for (const f of a.operands) {
    try {
      const { dir, name } = ctx.fs.parentOf(f, ctx.cwd);
      if (!dir || name === '') throw new FsError('EEXIST', f);
      if (dir.entries.has(name)) throw new FsError('EEXIST', f);
      const n = ctx.fs.newNode('p', mode & 0o7777);
      dir.entries.set(name, n);
      dir.mtime = ctx.fs.now();
    } catch (e) {
      if (e instanceof FsError) { ctx.err(`cannot create fifo ${qa(f)}: ${e.message}`); st = 1; continue; }
      throw e;
    }
  }
  return st;
};

function relPath(ctx, abs, given) {
  if (given.startsWith('/')) return abs;
  const cwd = ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/';
  return abs.startsWith(cwd) ? abs.slice(cwd.length) : abs;
}

C.rmdir = (ctx) => {
  const a = parseArgs(ctx, { short: 'pv', long: { parents: 'p', verbose: 'v', 'ignore-fail-on-non-empty': 'ign' } });
  if (!a) return 1;
  if (!a.operands.length) { ctx.err('missing operand'); ctx.stderr.write("Try 'rmdir --help' for more information.\n"); return 1; }
  let st = 0;
  for (const d of a.operands) {
    let p = d.replace(/(.)\/+$/, '$1');
    for (;;) {
      try { ctx.fs.rmdir(p, ctx.cwd); if (a.has('v')) ctx.out(`rmdir: removing directory, ${qa(p)}\n`); }
      catch (e) {
        if (e instanceof FsError) {
          if (e.code === 'ENOTEMPTY' && a.has('ign')) break;
          ctx.err(`failed to remove ${qa(p)}: ${e.message}`); st = 1; break;
        }
        throw e;
      }
      if (!a.has('p')) break;
      const parent = pdir(p);
      if (parent === p || parent === '.' || parent === '/') break;
      p = parent;
    }
  }
  return st;
};

// touch (coreutils 8.32 touch.c): options act in order (-t and --time fail as they are read),
// -r gives atime and mtime separately (-d then counts from them), "-" is standard output, and
// only an open(O_CREAT) without -c or -h creates files
C.touch = (ctx) => {
  const a = parseArgs(ctx, { short: 'acd:fhmr:t:', long: { 'no-create': 'c', date: ['d', 'required'], 'no-dereference': 'h', reference: ['r', 'required'], time: ['time', 'required'] } });
  if (!a) return 1;
  const usageFail = () => { ctx.stderr.write("Try 'touch --help' for more information.\n"); return 1; };
  const badDate = (s) => { ctx.err(`invalid date format ${quotearg(s, 'locale')}`); return 1; };
  const CH_ATIME = 1, CH_MTIME = 2;
  const TIME_ARGS = ['atime', 'access', 'use', 'mtime', 'modify'], TIME_MASKS = [CH_ATIME, CH_ATIME, CH_ATIME, CH_MTIME, CH_MTIME];
  // gnulib posixtime(): [[CC]YY]MMDDhhmm[.ss], rejecting dates that don't round-trip (but :60)
  const posixtime = (s) => {
    const m = /^(\d{2})?(\d{2})?(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{2}))?$/.exec(s);
    if (!m) return null;
    const digits = s.split('.')[0];
    let year;
    if (digits.length === 12) year = parseInt(digits.slice(0, 4), 10);
    else if (digits.length === 10) { const yy = parseInt(digits.slice(0, 2), 10); year = yy < 69 ? 2000 + yy : 1900 + yy; }
    else year = new Date(ctx.fs.now()).getUTCFullYear();
    const rest = digits.slice(-8);
    const f = [year, parseInt(rest.slice(0, 2), 10) - 1, parseInt(rest.slice(2, 4), 10), parseInt(rest.slice(4, 6), 10), parseInt(rest.slice(6, 8), 10), m[7] ? parseInt(m[7], 10) : 0];
    const ok = (sec) => {
      const d = new Date(Date.UTC(f[0], f[1], f[2], f[3], f[4], sec));
      if (f[0] < 100) d.setUTCFullYear(f[0]);
      return d.getUTCFullYear() === f[0] && d.getUTCMonth() === f[1] && d.getUTCDate() === f[2] && d.getUTCHours() === f[3] && d.getUTCMinutes() === f[4] && d.getUTCSeconds() === sec;
    };
    if (!ok(f[5]) && !(f[5] === 60 && ok(59))) return null;
    const d = new Date(Date.UTC(f[0], f[1], f[2], f[3], f[4], f[5]));
    if (f[0] < 100) d.setUTCFullYear(f[0]);
    return d.getTime();
  };
  let change = 0, flexDate = null, refFile = null, dateSet = false, tA = 0, tM = 0;
  for (const [k, v] of a.all) {
    if (k === 'a') change |= CH_ATIME;
    else if (k === 'm') change |= CH_MTIME;
    else if (k === 'd') flexDate = v;
    else if (k === 'r') refFile = v;
    else if (k === 't') {
      const t = posixtime(v);
      if (t === null) return badDate(v);
      tA = tM = t; dateSet = true;
    } else if (k === 'time') {
      const i = argmatch(v, TIME_ARGS, TIME_MASKS);
      if (i < 0) { ctx.stderr.write(argmatchMessage('touch', '--time', v, i, TIME_ARGS, TIME_MASKS)); return usageFail(); }
      change |= TIME_MASKS[i];
    }
  }
  const noCreate = a.has('c'), noDeref = a.has('h');
  if (!change) change = CH_ATIME | CH_MTIME;
  if (dateSet && (refFile !== null || flexDate !== null)) { ctx.err('cannot specify times from more than one source'); return usageFail(); }
  if (refFile !== null) {
    let r;
    try { r = noDeref ? ctx.fs.lstat(refFile, ctx.cwd) : ctx.fs.stat(refFile, ctx.cwd); }
    catch (e) { if (e instanceof FsError) { ctx.err(`failed to get attributes of ${qa(refFile)}: ${e.message}`); return 1; } throw e; }
    tA = r.atime; tM = r.mtime; dateSet = true;
    if (flexDate !== null) {
      if (change & CH_ATIME) { const v = parseDate(flexDate, tA); if (v === null) return badDate(flexDate); tA = v; }
      if (change & CH_MTIME) { const v = parseDate(flexDate, tM); if (v === null) return badDate(flexDate); tM = v; }
    }
  } else if (flexDate !== null) {
    const v = parseDate(flexDate, ctx.fs.now());
    if (v === null) return badDate(flexDate);
    tA = tM = v; dateSet = true;
  }
  if (!dateSet) tA = tM = ctx.fs.now();
  if (!a.operands.length) { ctx.err('missing file operand'); return usageFail(); }
  const setTimes = (n) => { if (change & CH_ATIME) n.atime = tA; if (change & CH_MTIME) n.mtime = tM; };
  const errno = (e) => { if (e instanceof FsError) return e.code; throw e; };
  let st = 0;
  for (const f of a.operands) {
    if (f === '-') {
      // futimens(1) on whatever standard output is open on; -c keeps quiet about a closed one
      if (!ctx.io.fds[1]) { if (!noCreate) { ctx.err(`setting times of ${qa(f)}: Bad file descriptor`); st = 1; } continue; }
      if (ctx.stdout.node) setTimes(ctx.stdout.node);
      continue;
    }
    // open(O_WRONLY|O_CREAT): EISDIR (any trailing slash, a directory), EINVAL and EPERM aren't kept
    let openErr = null;
    if (!(noCreate || noDeref)) {
      let code = null;
      if (/\/$|(^|\/)\.\.?$/.test(f)) code = 'EISDIR';
      else {
        try { if (ctx.fs.stat(f, ctx.cwd).type === 'd') code = 'EISDIR'; }
        catch (e) {
          code = errno(e);
          if (code === 'ENOENT') { try { ctx.fs.writeFile(f, '', ctx.cwd); code = null; } catch (e2) { code = errno(e2); } }
        }
      }
      if (code && code !== 'EISDIR' && code !== 'EINVAL' && code !== 'EPERM') openErr = code;
    }
    let n = null, utErr = null;
    try { n = noDeref ? ctx.fs.lstat(f, ctx.cwd) : ctx.fs.stat(f, ctx.cwd); } catch (e) { utErr = errno(e); }
    if (n) { setTimes(n); continue; }
    if (openErr) ctx.err(`cannot touch ${qa(f)}: ${new FsError(openErr, f).message}`);
    else if (noCreate && utErr === 'ENOENT') continue;
    else ctx.err(`setting times of ${qa(f)}: ${new FsError(utErr, f).message}`);
    st = 1;
  }
  return st;
};

// ---------------------------------------------------------------- ln
C.ln = (ctx) => {
  const a = parseArgs(ctx, { short: 'bdfFinLPrst:Tv', long: { backup: ['b', 'optional'], force: 'f', interactive: 'i', logical: 'L', 'no-dereference': 'n', physical: 'P', relative: 'r', symbolic: 's', 'target-directory': ['t', 'required'], 'no-target-directory': 'T', verbose: 'v' } });
  if (!a) return 1;
  const sym = a.has('s'), force = a.has('f'), noDeref = a.has('n'), verbose = a.has('v'), relative = a.has('r');
  let ops = a.operands;
  if (!ops.length) { ctx.err('missing file operand'); ctx.stderr.write("Try 'ln --help' for more information.\n"); return 1; }
  let dir = a.get('t');
  let pairs = [];
  if (dir) pairs = ops.map(t => [t, joinPath(dir, pbase(t))]);
  else if (ops.length === 1) pairs = [[ops[0], './' + (pbase(ops[0].replace(/\/+$/, '')) || ops[0])]];
  else {
    const last = ops[ops.length - 1];
    const ln = noDeref ? lstatSafe(ctx, last) : statSafe(ctx, last);
    if (!a.has('T') && ln && ln.type === 'd') pairs = ops.slice(0, -1).map(t => [t, joinPath(last, pbase(t.replace(/\/+$/, '')))]);
    else if (ops.length > 2) { ctx.err(`target ${qa(last)} is not a directory`); return 1; }
    else pairs = [[ops[0], last]];
  }
  let st = 0;
  for (let [target, link] of pairs) {
    try {
      if (!sym) {
        const tn = lstatSafe(ctx, target);
        if (!tn) { ctx.err(`failed to access ${qa(target)}: No such file or directory`); st = 1; continue; }
        if (tn.type === 'd') { ctx.err(`${qa(target)}: hard link not allowed for directory`); st = 1; continue; }
      }
      const ex = lstatSafe(ctx, link);
      if (ex) {
        if (!force) { ctx.err(`failed to create ${sym ? 'symbolic' : 'hard'} link ${qa(link)}${sym ? '' : ` => ${qa(target)}`}: File exists`); st = 1; continue; }
        if (ex.type === 'd') { ctx.err(`${qa(link)}: cannot overwrite directory`); st = 1; continue; }
        const tn = statSafe(ctx, target);
        if (!sym && tn === ex) { ctx.err(`${qa(target)} and ${qa(link)} are the same file`); st = 1; continue; }
        ctx.fs.unlink(link, ctx.cwd);
      }
      if (sym) {
        let t = target;
        if (relative) {
          const absT = target.startsWith('/') ? normPath(target) : normPath(joinPath(ctx.cwd, target));
          const absL = link.startsWith('/') ? normPath(link) : normPath(joinPath(ctx.cwd, link));
          t = relativePath(pdir(absL), absT);
        }
        ctx.fs.symlink(t, link, ctx.cwd);
      } else ctx.fs.link(target, link, ctx.cwd);
      if (verbose) ctx.out(`${qa(link)} -> ${qa(target)}\n`);
    } catch (e) {
      if (e instanceof FsError) { ctx.err(`failed to create ${sym ? 'symbolic' : 'hard'} link ${qa(link)}: ${e.message}`); st = 1; continue; }
      throw e;
    }
  }
  return st;
};

export function relativePath(from, to) {
  const f = from.split('/').filter(Boolean), t = to.split('/').filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  const up = f.slice(i).map(() => '..');
  const rest = t.slice(i);
  const r = [...up, ...rest].join('/');
  return r || '.';
}

// ---------------------------------------------------------------- chmod / chown / chgrp
C.chmod = (ctx) => {
  // modes like -x look like options; handle manually
  const argv = ctx.argv.slice(1);
  let rec = false, verbose = false, changes = false, quiet = false, ref = null;
  const rest = [];
  let modeArg = null;
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (x === '-R' || x === '--recursive') { rec = true; continue; }
    if (x === '-v' || x === '--verbose') { verbose = true; continue; }
    if (x === '-c' || x === '--changes') { changes = true; continue; }
    if (x === '-f' || x === '--silent' || x === '--quiet') { quiet = true; continue; }
    if (x.startsWith('--reference=')) { ref = x.slice(12); continue; }
    if (/^-[Rvcf]+$/.test(x)) { if (x.includes('R')) rec = true; if (x.includes('v')) verbose = true; if (x.includes('c')) changes = true; if (x.includes('f')) quiet = true; continue; }
    rest.push(x);
  }
  if (!ref) modeArg = rest.shift();
  if (modeArg === undefined) { ctx.err('missing operand'); ctx.stderr.write("Try 'chmod --help' for more information.\n"); return 1; }
  if (!rest.length) { ctx.err(`missing operand after ${qa(modeArg)}`); ctx.stderr.write("Try 'chmod --help' for more information.\n"); return 1; }
  let st = 0;
  const apply = (p, n) => {
    if (n.type === 'l') return;
    let m;
    if (ref) { const r = statSafe(ctx, ref); m = r ? r.mode : n.mode; }
    else m = parseModeArg(modeArg, n.mode, n.type === 'd');
    if (m === null) { ctx.err(`invalid mode: ${qa(modeArg)}`); ctx.stderr.write("Try 'chmod --help' for more information.\n"); throw new Error('badmode'); }
    const old = n.mode;
    n.mode = m & 0o7777;
    n.ctime = ctx.fs.now();
    const oct = (v) => v.toString(8).padStart(4, '0');
    const sym = (v) => modeString({ type: n.type, mode: v }).slice(1);
    if (verbose || (changes && old !== n.mode)) ctx.out(old !== n.mode ? `mode of ${qa(p)} changed from ${oct(old)} (${sym(old)}) to ${oct(n.mode)} (${sym(n.mode)})\n` : `mode of ${qa(p)} retained as ${oct(old)} (${sym(old)})\n`);
    if (rec && n.type === 'd') for (const name of [...n.entries.keys()]) apply(joinPath(p, name), n.entries.get(name));
  };
  for (const f of rest) {
    const n = statSafe(ctx, f);
    if (!n) { if (!quiet) ctx.err(`cannot access ${qa(f)}: No such file or directory`); st = 1; continue; }
    try { apply(f, n); } catch (e) { if (e.message === 'badmode') return 1; throw e; }
  }
  return st;
};

function chownImpl(ctx, group) {
  const a = parseArgs(ctx, { short: 'cfhvRHLP', long: { changes: 'c', silent: 'f', quiet: 'f', 'no-dereference': 'h', verbose: 'v', recursive: 'R', reference: ['ref', 'required'], from: ['from', 'required'] } });
  if (!a) return 1;
  const ops = [...a.operands];
  const spec = a.has('ref') ? null : ops.shift();
  if (!ops.length) { ctx.err(spec ? `missing operand after ${qa(spec)}` : 'missing operand'); return 1; }
  const ids = { root: 0, daemon: 1, bin: 2, sys: 3, nobody: 65534, nogroup: 65534, player: 1000, users: 100 };
  let uid = null, gid = null;
  if (spec) {
    if (group) gid = /^\d+$/.test(spec) ? +spec : ids[spec];
    else {
      const [u, g] = spec.split(/[:.]/);
      if (u) uid = /^\d+$/.test(u) ? +u : ids[u];
      if (g !== undefined && g !== '') gid = /^\d+$/.test(g) ? +g : ids[g];
      if (u && uid === undefined) { ctx.err(`invalid user: ${qa(spec)}`); return 1; }
    }
    if (gid === undefined) { ctx.err(`invalid group: ${qa(spec)}`); return 1; }
  }
  let st = 0;
  const apply = (n) => {
    if (uid !== null) n.uid = uid;
    if (gid !== null) n.gid = gid;
    if (a.has('R') && n.type === 'd') for (const c of n.entries.values()) apply(c);
  };
  for (const f of ops) {
    const n = statSafe(ctx, f);
    if (!n) { ctx.err(`cannot access ${qa(f)}: No such file or directory`); st = 1; continue; }
    apply(n);
  }
  return st;
}
C.chown = (ctx) => chownImpl(ctx, false);
C.chgrp = (ctx) => chownImpl(ctx, true);

// ---------------------------------------------------------------- stat
function fileType(n) {
  if (n.type === 'f') return n.size === 0 ? 'regular empty file' : 'regular file';
  return { d: 'directory', l: 'symbolic link', c: 'character special file', p: 'fifo' }[n.type] || 'unknown';
}

function statTime(t) { return strftime('%Y-%m-%d %H:%M:%S.000000000 +0000', new Date(t)); }

C.stat = (ctx) => {
  const a = parseArgs(ctx, { short: 'c:fLt', long: { format: ['c', 'required'], printf: ['printf', 'required'], dereference: 'L', 'file-system': 'f', terse: 't', cached: ['cached', 'required'] } });
  if (!a) return 1;
  if (!a.operands.length) { ctx.err('missing operand'); ctx.stderr.write("Try 'stat --help' for more information.\n"); return 1; }
  let st = 0;
  let out = '';
  for (const f of a.operands) {
    const n = a.has('L') ? statSafe(ctx, f) : lstatSafe(ctx, f);
    // error() flushes stdout first: messages land between the files' output
    if (!n) { ctx.out(out); out = ''; ctx.err(`cannot statx ${qa(f)}: No such file or directory`); st = 1; continue; }
    const fmt = a.has('printf') ? a.get('printf') : a.has('c') ? a.get('c') + '\n' : null;
    if (fmt !== null) { out += statFormat(fmt, f, n, ctx, a.has('printf')); continue; }
    if (a.has('t')) { out += `${f} ${n.size} ${blocksK(n) * 2} ${n.mode.toString(16)} ${n.uid} ${n.gid} 2f ${n.ino} ${n.nlink} 0 0 ${Math.floor(n.atime / 1000)} ${Math.floor(n.mtime / 1000)} ${Math.floor(n.ctime / 1000)} 0 4096\n`; continue; }
    const name = n.type === 'l' ? `${f} -> ${n.target}` : f;
    out += `  File: ${name}\n`;
    out += `  Size: ${String(n.size).padEnd(10)}\tBlocks: ${String(blocksK(n) * 2).padEnd(10)} IO Block: 4096   ${fileType(n)}\n`;
    out += `Device: 2fh/47d\tInode: ${String(n.ino).padEnd(11)} Links: ${n.nlink}\n`;
    out += `Access: (${(n.mode & 0o7777).toString(8).padStart(4, '0')}/${modeString(n)})  Uid: (${String(n.uid).padStart(5)}/${userName(n.uid).padStart(8)})   Gid: (${String(n.gid).padStart(5)}/${groupName(n.gid).padStart(8)})\n`;
    out += `Access: ${statTime(n.atime)}\nModify: ${statTime(n.mtime)}\nChange: ${statTime(n.ctime)}\n Birth: -\n`;
  }
  ctx.out(out);
  return st;
};

function statFormat(fmt, f, n, ctx, escapes) {
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (escapes && c === '\\' && i + 1 < fmt.length) {
      const d = fmt[++i];
      out += { n: '\n', t: '\t', '\\': '\\', '"': '"', a: '\x07', r: '\r' }[d] ?? ('\\' + d);
      continue;
    }
    if (c !== '%' || i + 1 >= fmt.length) { out += c; continue; }
    let j = i + 1;
    let flags = '';
    while ('-#0 +'.includes(fmt[j]) && j < fmt.length) flags += fmt[j++];
    let w = '';
    while (/[0-9]/.test(fmt[j] || '')) w += fmt[j++];
    const d = fmt[j];
    i = j;
    let v;
    switch (d) {
      case 'n': v = f; break;
      case 'N': v = n.type === 'l' ? `${qa(f)} -> ${qa(n.target)}` : qa(f); break;
      case 's': v = String(n.size); break;
      case 'b': v = String(blocksK(n) * 2); break;
      case 'B': v = '512'; break;
      case 'o': v = '4096'; break;
      case 'f': v = ((n.type === 'd' ? 0o40000 : n.type === 'l' ? 0o120000 : 0o100000) | n.mode).toString(16); break;
      case 'F': v = fileType(n); break;
      case 'a': v = (n.mode & 0o7777).toString(8); break;
      case 'A': v = modeString(n); break;
      case 'h': v = String(n.nlink); break;
      case 'i': v = String(n.ino); break;
      case 'u': v = String(n.uid); break;
      case 'U': v = userName(n.uid); break;
      case 'g': v = String(n.gid); break;
      case 'G': v = groupName(n.gid); break;
      case 'x': v = statTime(n.atime); break;
      case 'X': v = String(Math.floor(n.atime / 1000)); break;
      case 'y': v = statTime(n.mtime); break;
      case 'Y': v = String(Math.floor(n.mtime / 1000)); break;
      case 'z': v = statTime(n.ctime); break;
      case 'Z': v = String(Math.floor(n.ctime / 1000)); break;
      case 'w': v = '-'; break;
      case 'W': v = '0'; break;
      case 'd': v = '47'; break;
      case 'D': v = '2f'; break;
      case 'm': v = '/'; break;
      case 't': case 'T': v = '0'; break;
      case 'C': v = '?'; break;
      case '%': v = '%'; break;
      default: v = '?' + d;
    }
    if (w) v = flags.includes('-') ? v.padEnd(+w) : v.padStart(+w, flags.includes('0') ? '0' : ' ');
    out += v;
  }
  return out;
}

// ---------------------------------------------------------------- du / df
C.du = (ctx) => {
  const a = parseArgs(ctx, { short: 'abcd:hHkLmsSx0', long: { all: 'a', 'apparent-size': 'A', bytes: 'b', total: 'c', 'max-depth': ['d', 'required'], 'human-readable': 'h', si: 'si', kilobytes: 'k', dereference: 'L', megabytes: 'm', summarize: 's', 'separate-dirs': 'S', 'one-file-system': 'x', null: '0', 'block-size': ['B', 'required'], exclude: ['exclude', 'required'], time: ['time', 'optional'] } });
  if (!a) return 1;
  const apparent = a.has('A') || a.has('b');
  const bytes = a.has('b');
  const human = a.has('h');
  const maxDepth = a.has('s') ? 0 : a.has('d') ? parseInt(a.get('d'), 10) : Infinity;
  const nl = a.has('0') ? '\0' : '\n';
  const size = (n) => apparent ? (n.type === 'd' ? 4096 : n.size) : blocksK(n) * 1024;
  const fmt = (b) => {
    if (bytes) return String(b);
    if (human) return b < 1024 ? String(Math.ceil(b / 1024) ? humanSize(b) : '0') : humanSize(b);
    if (a.has('m')) return String(Math.ceil(b / 1048576));
    return String(Math.ceil(b / 1024));
  };
  const ops = a.operands.length ? a.operands : ['.'];
  let out = '';
  let total = 0, st = 0;
  const seen = new Set();
  const walk = (p, n, depth) => {
    if (seen.has(n)) return 0;
    seen.add(n);
    let s = size(n);
    if (n.type === 'd') {
      for (const name of [...n.entries.keys()]) {
        const c = n.entries.get(name);
        const cp = p.endsWith('/') ? p + name : p + '/' + name;
        const cs = walk(cp, c, depth + 1);
        if (!a.has('S') || c.type !== 'd') s += cs;
      }
      if (depth <= maxDepth) out += fmt(s) + '\t' + p + nl;
    } else if (a.has('a') && depth <= maxDepth) out += fmt(s) + '\t' + p + nl;
    else if (depth === 0) out += fmt(s) + '\t' + p + nl;
    return s;
  };
  for (const op of ops) {
    const n = a.has('L') ? statSafe(ctx, op) : lstatSafe(ctx, op);
    if (!n) { ctx.out(out); out = ''; ctx.err(`cannot access ${qa(op)}: No such file or directory`); st = 1; continue; }
    total += walk(op, n, 0);
  }
  if (a.has('c')) out += fmt(total) + '\ttotal' + nl;
  ctx.out(out);
  return st;
};

C.df = (ctx) => {
  const h = ctx.argv.includes('-h');
  if (h) ctx.out('Filesystem      Size  Used Avail Use% Mounted on\noverlay          59G   21G   36G  37% /\ntmpfs            64M     0   64M   0% /dev\nshm              64M     0   64M   0% /dev/shm\n');
  else ctx.out('Filesystem     1K-blocks     Used Available Use% Mounted on\noverlay         61202244 21436172  36624012  37% /\ntmpfs              65536        0     65536   0% /dev\nshm                65536        0     65536   0% /dev/shm\n');
  return 0;
};

// ---------------------------------------------------------------- file
export function magic(data, name) {
  if (data.length === 0) return { desc: 'empty', mime: 'inode/x-empty' };
  const u = (i) => data.charCodeAt(i);
  if (data.startsWith('\x89PNG\r\n\x1a\n')) {
    const be32 = (i) => ((u(i) << 24) | (u(i + 1) << 16) | (u(i + 2) << 8) | u(i + 3)) >>> 0;
    const w = be32(16), h = be32(20), depth = u(24), ct = u(25), inter = u(28);
    const ctn = { 0: 'grayscale', 2: 'RGB', 3: 'colormap', 4: 'gray+alpha', 6: 'RGBA' }[ct] || 'unknown';
    return { desc: `PNG image data, ${w} x ${h}, ${depth}-bit${ct === 3 ? ' colormap' : '/color ' + ctn}, ${inter ? 'interlaced' : 'non-interlaced'}`, mime: 'image/png' };
  }
  if (data.startsWith('GIF87a') || data.startsWith('GIF89a')) {
    const w = u(6) | (u(7) << 8), h = u(8) | (u(9) << 8);
    return { desc: `GIF image data, version ${data.slice(3, 6)}, ${w} x ${h}`, mime: 'image/gif' };
  }
  if (data.startsWith('\xff\xd8\xff')) return { desc: data.slice(6, 10) === 'JFIF' ? 'JPEG image data, JFIF standard 1.01' : 'JPEG image data', mime: 'image/jpeg' };
  if (data.startsWith('%PDF-')) return { desc: `PDF document, version ${data.slice(5, 8)}`, mime: 'application/pdf' };
  if (data.startsWith('PK\x03\x04')) return { desc: 'Zip archive data, at least v2.0 to extract', mime: 'application/zip' };
  if (data.startsWith('\x1f\x8b')) {
    // file(1): name and timestamp from the header, size from the trailer
    const flg = u(3), mt = (u(4) | (u(5) << 8) | (u(6) << 16) | (u(7) << 24)) >>> 0;
    let desc = 'gzip compressed data';
    let q = 10;
    if (flg & 4) q += 2 + (u(10) | (u(11) << 8));
    if (flg & 8) { const e = data.indexOf('\0', q); desc += `, was "${data.slice(q, e)}"`; q = e + 1; }
    if (mt) desc += `, last modified: ${strftime('%a %b %e %H:%M:%S %Y', new Date(mt * 1000))}`;
    if (u(8) === 2) desc += ', max compression';
    else if (u(8) === 4) desc += ', max speed';
    if (u(9) === 3) desc += ', from Unix';
    const n = data.length;
    if (n >= 18) desc += `, original size modulo 2^32 ${(u(n - 4) | (u(n - 3) << 8) | (u(n - 2) << 16) | (u(n - 1) << 24)) >>> 0}`;
    return { desc, mime: 'application/gzip' };
  }
  if (data.length >= 512 && data.slice(257, 265) === 'ustar  \0') return { desc: 'POSIX tar archive (GNU)', mime: 'application/x-tar' };
  if (data.length >= 512 && data.slice(257, 263) === 'ustar\0') return { desc: 'POSIX tar archive', mime: 'application/x-tar' };
  if (data.startsWith('BZh')) return { desc: 'bzip2 compressed data', mime: 'application/x-bzip2' };
  if (data.startsWith('\xfd7zXZ\x00')) return { desc: 'XZ compressed data', mime: 'application/x-xz' };
  if (data.startsWith('\x7fELF')) return { desc: 'ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, stripped', mime: 'application/x-pie-executable' };
  if (data.startsWith('RIFF') && data.slice(8, 12) === 'WAVE') return { desc: 'RIFF (little-endian) data, WAVE audio', mime: 'audio/x-wav' };
  if (data.startsWith('ID3') || (u(0) === 0xff && (u(1) & 0xe0) === 0xe0)) return { desc: 'Audio file with ID3 version 2.4.0', mime: 'audio/mpeg' };
  if (data.startsWith('fLaC')) return { desc: 'FLAC audio bitstream data', mime: 'audio/flac' };
  if (data.startsWith('OggS')) return { desc: 'Ogg data', mime: 'audio/ogg' };
  if (data.slice(4, 8) === 'ftyp') return { desc: 'ISO Media', mime: 'video/mp4' };
  if (data.startsWith('BM')) return { desc: 'PC bitmap', mime: 'image/bmp' };
  if (data.startsWith('SQLite format 3')) return { desc: 'SQLite 3.x database', mime: 'application/vnd.sqlite3' };
  if (data.includes('\0')) return { desc: 'data', mime: 'application/octet-stream' };
  const utf8 = isValidUtf8(data);
  const ascii = /^[\x00-\x7f]*$/.test(data);
  if (!utf8 && !ascii) return { desc: 'ISO-8859 text', mime: 'text/plain' };
  let kind = ascii ? 'ASCII text' : 'Unicode text, UTF-8 text';
  let charset = ascii ? 'us-ascii' : 'utf-8';
  let prefix = '';
  let mime = 'text/plain';
  const sheb = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(data);
  if (sheb) {
    let interp = sheb[1].split('/').pop();
    if (interp === 'env' && sheb[2]) interp = sheb[2];
    const map = { bash: 'Bourne-Again shell script', sh: 'POSIX shell script', dash: 'POSIX shell script', zsh: 'Paul Falstad\'s zsh script', python: 'Python script', python3: 'Python script', perl: 'Perl script', ruby: 'Ruby script', node: 'Node.js script', awk: 'awk or perl script', gawk: 'awk or perl script' };
    prefix = (map[interp] || `a ${sheb[1]} script`) + ', ';
    kind += ' executable';
    mime = interp.startsWith('python') ? 'text/x-script.python' : 'text/x-shellscript';
  } else {
    const t = data.trimStart();
    if (/^[\[{]/.test(t) && looksJson(data)) return { desc: 'JSON data', mime: 'application/json' };
    if (/^<\?xml/.test(t)) { prefix = 'XML 1.0 document, '; mime = 'text/xml'; }
    else if (/^<!doctype html|^<html/i.test(t)) { prefix = 'HTML document, '; mime = 'text/html'; }
    else if (/^\s*#\s*include|^\s*int\s+main\s*\(/m.test(data)) { prefix = 'C source, '; mime = 'text/x-c'; }
    else if (looksCsv(data)) { return { desc: 'CSV text', mime: 'text/csv' }; }
  }
  const lines = data.split('\n');
  const attrs = [];
  if (data.includes('\r\n')) attrs.push('with CRLF line terminators');
  if (!data.includes('\n')) attrs.push('with no line terminators');
  if (lines.some(l => l.length > 300)) attrs.push('with very long lines (' + Math.max(...lines.map(l => l.length)) + ')');
  if (/[\x1b]/.test(data)) attrs.push('with escape sequences');
  return { desc: prefix + kind + (attrs.length ? ', ' + attrs.join(', ') : ''), mime: `${mime}; charset=${charset}` };
}

function looksJson(s) { try { JSON.parse(s); return true; } catch { return false; } }
function looksCsv(s) {
  const lines = s.split('\n').filter(Boolean).slice(0, 10);
  if (lines.length < 2) return false;
  const counts = lines.map(l => (l.match(/,/g) || []).length);
  return counts[0] >= 1 && counts.every(c => c === counts[0]);
}

C.file = (ctx) => {
  const a = parseArgs(ctx, { short: 'bhiLzf:', long: { brief: 'b', mime: 'i', 'mime-type': 'mt', dereference: 'L', 'no-dereference': 'h' } });
  if (!a) return 1;
  if (!a.operands.length) { ctx.stderr.write('Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]\n            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]\n            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]\n            <file> ...\n       file -C [-m <magicfiles>]\n       file [--help]\n'); return 1; }
  const width = Math.max(...a.operands.map(f => f.length)) + 1;
  let out = '';
  for (const f of a.operands) {
    const label = a.has('b') ? '' : (f + ':').padEnd(width + 1);
    const n = a.has('L') ? statSafe(ctx, f) : lstatSafe(ctx, f);
    let desc, mime;
    if (!n) { desc = `cannot open \`${f}' (No such file or directory)`; mime = 'cannot open'; }
    else if (n.type === 'd') { desc = 'directory'; mime = 'inode/directory; charset=binary'; }
    else if (n.type === 'l') { const t = statSafe(ctx, f); desc = t ? `symbolic link to ${n.target}` : `broken symbolic link to ${n.target}`; mime = 'inode/symlink; charset=binary'; }
    else if (n.type === 'c') { desc = 'character special (1/3)'; mime = 'inode/chardevice; charset=binary'; }
    else { const m = magic(n.data, f); desc = m.desc; mime = m.mime.includes('charset') ? m.mime : m.mime + '; charset=binary'; }
    out += label + (a.has('i') ? mime : a.has('mt') ? mime.split(';')[0] : desc) + '\n';
  }
  ctx.out(out);
  return 0;
};

// ---------------------------------------------------------------- tree
// tree 2.0.2 as Ubuntu 22.04 ships it: a port of tree.c, list.c, unix.c, json.c, xml.c, html.c,
// color.c, file.c, filter.c and info.c, quirks included (only the last operand's totals are
// reported, --filelimit compares unsigned, an unreadable operand after a listed one reads freed
// memory and crashes). The C locale escapes names (printit); LC_ALL/LC_CTYPE/LANG=C.UTF-8 doesn't.
const TREE_VERSION = '$Version: $ tree v2.0.2 (c) 1996 - 2022 by Steve Baker, Thomas Moore, Francesc Rocher, Florian Sesser, Kyosuke Tokoro $';
const TREE_USAGE = 'usage: tree [-acdfghilnpqrstuvxACDFJQNSUX] [-L level [-R]] [-H  baseHREF]\n'
  + '\t[-T title] [-o filename] [-P pattern] [-I pattern] [--gitignore]\n'
  + '\t[--matchdirs] [--metafirst] [--ignore-case] [--nolinks] [--inodes]\n'
  + '\t[--device] [--sort[=]<name>] [--dirsfirst] [--filesfirst]\n'
  + '\t[--filelimit #] [--si] [--du] [--prune] [--charset X]\n'
  + '\t[--timefmt[=]format] [--fromfile] [--noreport] [--version] [--help]\n'
  + '\t[--] [directory ...]\n';
const TREE_HELP = `  ------- Listing options -------
  -a            All files are listed.
  -d            List directories only.
  -l            Follow symbolic links like directories.
  -f            Print the full path prefix for each file.
  -x            Stay on current filesystem only.
  -L level      Descend only level directories deep.
  -R            Rerun tree when max dir level reached.
  -P pattern    List only those files that match the pattern given.
  -I pattern    Do not list files that match the given pattern.
  --gitignore   Filter by using .gitignore files.
  --ignore-case Ignore case when pattern matching.
  --matchdirs   Include directory names in -P pattern matching.
  --metafirst   Print meta-data at the beginning of each line.
  --info        Print information about files found in .info files.
  --noreport    Turn off file/directory count at end of tree listing.
  --charset X   Use charset X for terminal/HTML and indentation line output.
  --filelimit # Do not descend dirs with more than # files in them.
  -o filename   Output to file instead of stdout.
  ------- File options -------
  -q            Print non-printable characters as '?'.
  -N            Print non-printable characters as is.
  -Q            Quote filenames with double quotes.
  -p            Print the protections for each file.
  -u            Displays file owner or UID number.
  -g            Displays file group owner or GID number.
  -s            Print the size in bytes of each file.
  -h            Print the size in a more human readable way.
  --si          Like -h, but use in SI units (powers of 1000).
  -D            Print the date of last modification or (-c) status change.
  --timefmt <f> Print and format time according to the format <f>.
  -F            Appends '/', '=', '*', '@', '|' or '>' as per ls -F.
  --inodes      Print inode number of each file.
  --device      Print device ID number to which each file belongs.
  ------- Sorting options -------
  -v            Sort files alphanumerically by version.
  -t            Sort files by last modification time.
  -c            Sort files by last status change time.
  -U            Leave files unsorted.
  -r            Reverse the order of the sort.
  --dirsfirst   List directories before files (-U disables).
  --filesfirst  List files before directories (-U disables).
  --sort X      Select sort: name,version,size,mtime,ctime.
  ------- Graphics options -------
  -i            Don't print indentation lines.
  -A            Print ANSI lines graphic indentation lines.
  -S            Print with CP437 (console) graphics indentation lines.
  -n            Turn colorization off always (-C overrides).
  -C            Turn colorization on always.
  ------- XML/HTML/JSON options -------
  -X            Prints out an XML representation of the tree.
  -J            Prints out an JSON representation of the tree.
  -H baseHREF   Prints out HTML format with baseHREF as top directory.
  -T string     Replace the default HTML title and H1 header with string.
  --nolinks     Turn off hyperlinks in HTML output.
  ------- Input options -------
  --fromfile    Reads paths from files (.=stdin)
  ------- Miscellaneous options -------
  --version     Print version and exit.
  --help        Print usage and this help message and exit.
  --            Options processing terminator.
`;
// color.c initlinedraw(): [names, vert, vert_left, corner, copy, (info comment marks)]
const TREE_LINEDRAW = [
  [['ISO-8859-1', 'ISO-8859-1:1987', 'ISO_8859-1', 'latin1', 'l1', 'IBM819', 'CP819', 'csISOLatin1', 'ISO-8859-3', 'ISO_8859-3:1988', 'ISO_8859-3', 'latin3', 'ls', 'csISOLatin3'], '|  ', '|--', '&middot;--', '&copy;'],
  [['ISO-8859-7', 'ISO_8859-7:1987', 'ISO_8859-7', 'ELOT_928', 'ECMA-118', 'greek', 'greek8', 'csISOLatinGreek', 'ISO-8859-8', 'ISO_8859-8:1988', 'iso-ir-138', 'ISO_8859-8', 'hebrew', 'csISOLatinHebrew', 'ISO-8859-9', 'ISO_8859-9:1989', 'iso-ir-148', 'ISO_8859-9', 'latin5', 'l5', 'csISOLatin5'], '|  ', '|--', '&middot;--', '(c)'],
  [['Shift_JIS', 'MS_Kanji', 'csShiftJIS'], '\x84\xa0 ', '\x84\xa5', '\x84\xa4', '(c)'],
  [['EUC-JP', 'Extended_UNIX_Code_Packed_Format_for_Japanese', 'csEUCPkdFmtJapanese'], '\xa8\xa2 ', '\xa8\xa7', '\xa8\xa6', '(c)'],
  [['EUC-KR', 'csEUCKR'], '\xa6\xa2 ', '\xa6\xa7', '\xa6\xa6', '(c)'],
  [['ISO-2022-JP', 'csISO2022JP', 'ISO-2022-JP-2', 'csISO2022JP2'], '\x1b$B("\x1b(B ', "\x1b$B('\x1b(B", '\x1b$B(&\x1b(B', '(c)'],
  [['IBM437', 'cp437', '437', 'csPC8CodePage437', 'IBM852', 'cp852', '852', 'csPCp852', 'IBM863', 'cp863', '863', 'csIBM863', 'IBM855', 'cp855', '855', 'csIBM855', 'IBM865', 'cp865', '865', 'csIBM865', 'IBM866', 'cp866', '866', 'csIBM866'], '\xb3  ', '\xc3\xc4\xc4', '\xc0\xc4\xc4', '(c)'],
  [['IBM850', 'cp850', '850', 'csPC850Multilingual', 'IBM00858', 'CCSID00858', 'CP00858', 'PC-Multilingual-850+euro'], '\xb3  ', '\xc3\xc4\xc4', '\xc0\xc4\xc4', '\x97'],
  [['IBM869', 'cp869', '869', 'cp-gr', 'csIBM869'], '\xb3  ', '\xc3\xc4\xc4', '\xc0\xc4\xc4', '\xb8'],
  [['GB2312', 'csGB2312'], '\xa9\xa6 ', '\xa9\xc0', '\xa9\xb8', '(c)'],
  [['UTF-8', 'utf8'], '\xe2\x94\x82\xc2\xa0\xc2\xa0', '\xe2\x94\x9c\xe2\x94\x80\xe2\x94\x80', '\xe2\x94\x94\xe2\x94\x80\xe2\x94\x80', '\xc2\xa9', ' \xe2\x8e\xa7', ' \xe2\x8e\xa9', ' \xe2\x8e\xa8', ' \xe2\x8e\xaa', ' {'],
  [['Big5', 'csBig5'], '\xa2x ', '\xa2u', '\xa2|', '(c)'],
  [['VISCII', 'csVISCII'], '|  ', '|--', '`--', '\xf9'],
  [['KOI8-R', 'csKOI8R', 'KOI8-U'], '\x81  ', '\x86\x80\x80', '\x84\x80\x80', '\xbf'],
  [['ISO-8859-1-Windows-3.1-Latin-1', 'csWindows31Latin1', 'ISO-8859-2-Windows-Latin-2', 'csWindows31Latin2', 'windows-1250', 'windows-1251', 'windows-1253', 'windows-1254', 'windows-1255', 'windows-1256', 'windows-1256', 'windows-1257'], '|  ', '|--', '`--', '\xa9'],
  [null, '|  ', '|--', '`--', '(c)'],
].map(([names, vert, vertLeft, corner, copy, ctop = ' [', cbot = ' [', cmid = ' [', cext = ' [', csingle = ' [']) => ({ names, vert, vertLeft, corner, copy, ctop, cbot, cmid, cext, csingle }));
const TREE_COLORS = ':no=00:rs=0:fi=00:di=01;34:ln=01;36:pi=40;33:so=01;35:bd=40;33;01:cd=40;33;01:or=40;31;01:ex=01;32:*.bat=01;32:*.BAT=01;32:*.btm=01;32:*.BTM=01;32:*.cmd=01;32:*.CMD=01;32:*.com=01;32:*.COM=01;32:*.dll=01;32:*.DLL=01;32:*.exe=01;32:*.EXE=01;32:*.arj=01;31:*.bz2=01;31:*.deb=01;31:*.gz=01;31:*.lzh=01;31:*.rpm=01;31:*.tar=01;31:*.taz=01;31:*.tb2=01;31:*.tbz2=01;31:*.tbz=01;31:*.tgz=01;31:*.tz2=01;31:*.z=01;31:*.Z=01;31:*.zip=01;31:*.ZIP=01;31:*.zoo=01;31:*.asf=01;35:*.ASF=01;35:*.avi=01;35:*.AVI=01;35:*.bmp=01;35:*.BMP=01;35:*.flac=01;35:*.FLAC=01;35:*.gif=01;35:*.GIF=01;35:*.jpg=01;35:*.JPG=01;35:*.jpeg=01;35:*.JPEG=01;35:*.m2a=01;35:*.M2a=01;35:*.m2v=01;35:*.M2V=01;35:*.mov=01;35:*.MOV=01;35:*.mp3=01;35:*.MP3=01;35:*.mpeg=01;35:*.MPEG=01;35:*.mpg=01;35:*.MPG=01;35:*.ogg=01;35:*.OGG=01;35:*.ppm=01;35:*.rm=01;35:*.RM=01;35:*.tga=01;35:*.TGA=01;35:*.tif=01;35:*.TIF=01;35:*.wav=01;35:*.WAV=01;35:*.wmv=01;35:*.WMV=01;35:*.xbm=01;35:*.xpm=01;35:';
const TREE_COLOR_CMDS = { rs: 'reset', no: 'normal', fi: 'file', di: 'dir', ln: 'link', pi: 'fifo', do: 'door', bd: 'blk', cd: 'chr', or: 'orphan', so: 'sock', su: 'setuid', sg: 'setgid', tw: 'stickyow', ow: 'ow', st: 'sticky', ex: 'exec', mi: 'missing', lc: 'left', rc: 'right', ec: 'end' };
const S_IFMT = 0o170000, S_IFSOCK = 0o140000, S_IFLNK = 0o120000, S_IFREG = 0o100000, S_IFBLK = 0o060000, S_IFDIR = 0o040000, S_IFCHR = 0o020000, S_IFIFO = 0o010000;
const TREE_IFMT = [[S_IFREG, '-', 'file'], [S_IFDIR, 'd', 'directory'], [S_IFLNK, 'l', 'link'], [S_IFCHR, 'c', 'char'], [S_IFBLK, 'b', 'block'], [S_IFSOCK, 's', 'socket'], [S_IFIFO, 'p', 'fifo']];
const TREE_DEV = 47;   // st_dev of every file (one overlay file system)
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));   // strcasecmp
class TreeExit { constructor(code) { this.code = code; } }
class TreeCrash {}      // SIGSEGV: stdio buffers are lost

// glibc strverscmp
function treeStrverscmp(a, b) {
  const S_N = 0, S_I = 3, S_F = 6, S_Z = 9, CMP = 2, LEN = 3;
  const next = [S_N, S_I, S_Z, S_N, S_I, S_I, S_N, S_F, S_F, S_N, S_F, S_Z];
  const result = [CMP, CMP, CMP, CMP, LEN, CMP, CMP, CMP, CMP,
    CMP, -1, -1, +1, LEN, LEN, +1, LEN, LEN,
    CMP, CMP, CMP, CMP, CMP, CMP, CMP, CMP, CMP,
    CMP, +1, +1, -1, CMP, CMP, -1, CMP, CMP];
  const at = (s, i) => (i < s.length ? s.charCodeAt(i) : 0);
  const isd = (c) => c >= 48 && c <= 57;
  const cls = (c) => (c === 48 ? 1 : 0) + (isd(c) ? 1 : 0);
  if (a === b) return 0;
  let p1 = 0, p2 = 0;
  let c1 = at(a, p1++), c2 = at(b, p2++);
  let state = S_N + cls(c1);
  let diff;
  while ((diff = c1 - c2) === 0) {
    if (c1 === 0) return diff;
    state = next[state];
    c1 = at(a, p1++); c2 = at(b, p2++);
    state += cls(c1);
  }
  state = result[state * 3 + cls(c2)];
  if (state === CMP) return diff;
  if (state === LEN) {
    while (isd(at(a, p1++))) if (!isd(at(b, p2++))) return 1;
    return isd(at(b, p2)) ? -1 : diff;
  }
  return state;
}

// tree.c patmatch(): 1 match, 0 mismatch, -1 bad pattern ('|' alternatives, [], *, **, ?, \)
function treePatmatch(buf, pat, isdir, icase) {
  const bar = pat.indexOf('|');
  if (bar >= 0) {
    if (bar === 0 || bar === pat.length - 1) return -1;
    let m = treePatmatch(buf, pat.slice(0, bar), isdir, icase);
    if (!m) m = treePatmatch(buf, pat.slice(bar + 1), isdir, icase);
    return m;
  }
  const B = (i) => (i < buf.length ? buf.charCodeAt(i) : 0);
  const P = (i) => (i < pat.length ? pat.charCodeAt(i) : 0);
  const low = (c) => (icase && c >= 65 && c <= 90 ? c + 32 : c);
  let b = 0, p = 0, match = 1, pprev = 0;
  while (P(p) && match) {
    switch (P(p)) {
      case 91: {  // [
        p++;
        let n;
        if (P(p) !== 94) { n = 1; match = 0; } else { p++; n = 0; }
        while (P(p) !== 93) {
          if (P(p) === 92) p++;
          if (!P(p)) return -1;
          if (P(p + 1) === 45) {
            const m = P(p);
            p += 2;
            if (P(p) === 92 && P(p)) p++;
            if (low(B(b)) >= low(m) && low(B(b)) <= low(P(p))) match = n;
            if (!P(p)) p--;
          } else if (low(B(b)) === low(P(p))) match = n;
          p++;
        }
        b++;
        break;
      }
      case 42: {  // *
        p++;
        if (!P(p)) return 1;
        match = 0;
        if (P(p) === 42) {
          p++;
          if (!P(p)) return 1;
          while (B(b) && !(match = treePatmatch(buf.slice(b), pat.slice(p), isdir, icase))) {
            if (pprev === 47 && P(p) === 47 && P(p + 1) && (match = treePatmatch(buf.slice(b), pat.slice(p + 1), isdir, icase))) return match;
            b++;
            while (B(b) && B(b) !== 47) b++;
          }
        } else {
          while (B(b) && !(match = treePatmatch(buf.slice(b++), pat.slice(p), isdir, icase)));
        }
        if (!B(b) && !match) match = treePatmatch(buf.slice(b), pat.slice(p), isdir, icase);
        return match;
      }
      case 63:  // ?
        if (!B(b)) return 0;
        b++;
        break;
      case 47:  // /
        if (!P(p + 1) && !B(b)) return isdir ? 1 : 0;
        match = B(b++) === P(p) ? 1 : 0;
        break;
      case 92:  // backslash: the next character is literal
        p++;
        // falls through
      default:
        match = low(B(b++)) === low(P(p)) ? 1 : 0;
        break;
    }
    pprev = P(p++);
    if (match < 1) return match;
  }
  if (!B(b)) return match;
  return 0;
}

// C strtoul(s, NULL, 0) - 1 kept in an int (-L), and atoi()
function treeStrtoulM1(s) {
  let i = 0;
  while (i < s.length && ' \t\n\v\f\r'.includes(s[i])) i++;
  let neg = false;
  if (s[i] === '+' || s[i] === '-') { neg = s[i] === '-'; i++; }
  let base = 10;
  if (s[i] === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X') && /[0-9a-fA-F]/.test(s[i + 2] || '')) { base = 16; i += 2; }
  else if (s[i] === '0') base = 8;
  const MAX = (1n << 64n) - 1n;
  let v = 0n, over = false;
  for (; i < s.length; i++) {
    const d = parseInt(s[i], 16);
    if (Number.isNaN(d) || d >= base) break;
    v = v * BigInt(base) + BigInt(d);
    if (v > MAX) over = true;
  }
  if (over) v = MAX;
  else if (neg) v = (MAX + 1n - v) & MAX;
  return Number(BigInt.asIntN(32, (v - 1n) & MAX));
}
function treeAtoi(s) {
  const m = /^[ \t\n\v\f\r]*([+-]?)(\d+)/.exec(s);
  if (!m) return 0;
  let v = BigInt(m[2]);
  if (m[1] === '-') v = -v;
  const LMAX = (1n << 63n) - 1n;
  if (v > LMAX) v = LMAX; else if (v < -LMAX - 1n) v = -LMAX - 1n;
  return Number(BigInt.asIntN(32, v));
}

C.tree = (ctx) => {
  const env = ctx.env || {};
  const argv = ctx.argv, argc = argv.length;
  const stdoutBuf = new StdioBuffer(ctx.stdout);
  const errw = (s) => ctx.stderr.write(s);
  let outfile = stdoutBuf;
  const out = (s) => outfile.write(s);

  let aflag = false, dflag = false, fflag = false, lflag = false, pflag = false, sflag = false, Fflag = false, uflag = false, gflag = false;
  let Dflag = false, qflag = false, Nflag = false, Qflag = false, Rflag = false, hflag = false, Hflag = false, siflag = false, cflag = false;
  let noindent = false, forceColor = false, nocolor = false, xdev = false, noreport = false, nolinks = false, reverse = false;
  let ignorecase = false, matchdirs = false, inodeflag = false, devflag = false, Xflag = false, Jflag = false;
  let duflag = false, pruneflag = false, metafirst = false, gitignore = false, fromfile = false, showinfo = false, ansilines = false;
  let flimit = 0;                 // a bool (an unsigned enum) holding atoi()'s int: compared unsigned
  let Level = -1;
  let patterns = [], ipatterns = [];
  let host = null, title = 'Directory Tree', sp = ' ', nl = '\n';
  let timefmt = null, outfilename = null;
  let basesort = 'name', topsort = null;
  const dirnames = [];
  const dirs = [0];
  let errors = 0, htmldirlen = 0;

  // the locale: setlocale(LC_CTYPE, "") honours LC_ALL, LC_CTYPE, LANG; only C.UTF-8 exists
  const lcType = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  const utf8Locale = /^C\./.test(lcType) && lcType.slice(2).replace(/@.*/, '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'utf8';
  const mbCurMax = utf8Locale ? 6 : 1;
  let charset = env.TREE_CHARSET ?? null;
  if (charset === null && utf8Locale) charset = 'UTF-8';
  let lcName = 'unix';
  const stddata = env.STDDATA_FD;
  if (stddata !== undefined) {
    let fd = treeAtoi(stddata);
    if (fd <= 0) fd = 3;
    const sink = ctx.io && ctx.io.fds && ctx.io.fds[fd];
    if (sink && sink.write) { Jflag = noindent = true; nl = ''; lcName = 'json'; outfile = new StdioBuffer(sink); }
  }

  const usage = (n) => {
    if (n < 2) { errw(TREE_USAGE); return; }
    stdoutBuf.write(TREE_USAGE + TREE_HELP);
    throw new TreeExit(0);
  };
  const die = (msg) => { errw(msg); throw new TreeExit(1); };
  const SORTS = ['name', 'version', 'size', 'mtime', 'ctime'];
  let lineDraw = null;
  const listCharsets = () => {
    errw('tree: missing argument to --charset, valid charsets include:\n');
    for (const ld of TREE_LINEDRAW) if (ld.names) for (const s of ld.names) errw(`  ${s}\n`);
  };

  const run = () => {
    let optf = true;
    for (let i = 1, n = 1; i < argc; i = n) {
      n++;
      const a = argv[i];
      if (!(optf && a[0] === '-' && a.length > 1)) { dirnames.push(a); continue; }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        switch (c) {
          case 'N': Nflag = true; break;
          case 'q': qflag = true; break;
          case 'Q': Qflag = true; break;
          case 'd': dflag = true; break;
          case 'l': lflag = true; break;
          case 's': sflag = true; break;
          case 'h': hflag = true; sflag = true; break;
          case 'u': uflag = true; break;
          case 'g': gflag = true; break;
          case 'f': fflag = true; break;
          case 'F': Fflag = true; break;
          case 'a': aflag = true; break;
          case 'p': pflag = true; break;
          case 'i': noindent = true; nl = ''; break;
          case 'C': forceColor = true; break;
          case 'n': nocolor = true; break;
          case 'x': xdev = true; break;
          case 'P':
            if (n >= argc) die('tree: missing argument to -P option.\n');
            patterns.push(argv[n++]);
            break;
          case 'I':
            if (n >= argc) die('tree: missing argument to -I option.\n');
            ipatterns.push(argv[n++]);
            break;
          case 'A': ansilines = true; break;
          case 'S': charset = 'IBM437'; break;
          case 'D': Dflag = true; break;
          case 't': basesort = 'mtime'; break;
          case 'c': basesort = 'ctime'; cflag = true; break;
          case 'r': reverse = true; break;
          case 'v': basesort = 'version'; break;
          case 'U': basesort = null; break;
          case 'X': Xflag = true; Hflag = Jflag = false; lcName = 'xml'; break;
          case 'J': Jflag = true; Xflag = Hflag = false; lcName = 'json'; break;
          case 'H':
            Hflag = true; Xflag = Jflag = false; lcName = 'html';
            if (n >= argc) die('tree: missing argument to -H option.\n');
            host = argv[n++];
            sp = '&nbsp;';
            break;
          case 'T':
            if (n >= argc) die('tree: missing argument to -T option.\n');
            title = argv[n++];
            break;
          case 'R': Rflag = true; break;
          case 'L': {
            if (n >= argc) die('tree: Missing argument to -L option.\n');
            Level = treeStrtoulM1(argv[n++]);
            if (Level < 0) die('tree: Invalid level, must be greater than 0.\n');
            break;
          }
          case 'o':
            if (n >= argc) die('tree: missing argument to -o option.\n');
            outfilename = argv[n++];
            break;
          case '-':
            if (j === 1) {
              const is = (name) => a === name;
              const pre = (name) => a.startsWith(name);
              if (a === '--') { optf = false; break; }
              if (is('--help')) usage(2);
              if (is('--version')) { const v = TREE_VERSION.slice(12); stdoutBuf.write(v.slice(0, v.length - 1) + '\n'); throw new TreeExit(0); }
              if (is('--inodes')) { j = a.length - 1; inodeflag = true; break; }
              if (is('--device')) { j = a.length - 1; devflag = true; break; }
              if (is('--noreport')) { j = a.length - 1; noreport = true; break; }
              if (is('--nolinks')) { j = a.length - 1; nolinks = true; break; }
              if (is('--dirsfirst')) { j = a.length - 1; topsort = 'dirsfirst'; break; }
              if (is('--filesfirst')) { j = a.length - 1; topsort = 'filesfirst'; break; }
              if (pre('--filelimit')) {
                j = 11;
                if (a[11] === '=') {
                  if (a.length > 12) { flimit = treeAtoi(a.slice(12)) >>> 0; j = a.length - 1; break; }
                  die('tree: missing argument to --filelimit=\n');
                }
                if (n < argc) { flimit = treeAtoi(argv[n++]) >>> 0; j = a.length - 1; }
                else die('tree: missing argument to --filelimit\n');
                break;
              }
              if (pre('--charset')) {
                j = 9;
                if (a[9] === '=') {
                  charset = a.slice(10);
                  if (charset) { j = a.length - 1; break; }
                  die('tree: missing argument to --charset=\n');
                }
                if (n < argc) { charset = argv[n++]; j = a.length - 1; }
                else { listCharsets(); throw new TreeExit(1); }
                break;
              }
              if (pre('--si')) { j = a.length - 1; sflag = hflag = siflag = true; break; }
              if (pre('--du')) { j = a.length - 1; sflag = duflag = true; break; }
              if (pre('--prune')) { j = a.length - 1; pruneflag = true; break; }
              if (pre('--timefmt')) {
                j = 9;
                if (a[j] === '=') {
                  if (a.length > ++j) { timefmt = a.slice(j); j = a.length - 1; break; }   // (no -D)
                  die('tree: missing argument to --timefmt=\n');
                } else if (n < argc) { timefmt = argv[n++]; j = a.length - 1; }
                else die('tree: missing argument to --timefmt\n');
                Dflag = true;
                break;
              }
              if (pre('--ignore-case')) { j = a.length - 1; ignorecase = true; break; }
              if (pre('--matchdirs')) { j = a.length - 1; matchdirs = true; break; }
              if (pre('--sort')) {
                j = 6;
                let stmp;
                if (a[j] === '=') {
                  if (a.length > ++j) { stmp = a.slice(j); j = a.length - 1; }
                  else die('tree: missing argument to --sort=\n');
                } else if (n < argc) { stmp = argv[n++]; j = a.length - 1; }
                else die('tree: missing argument to --sort\n');
                basesort = SORTS.find((s) => s === asciiLower(stmp)) ?? null;
                if (basesort === null) {
                  errw(`tree: sort type '${stmp}' not valid, should be one of: `);
                  stdoutBuf.write(SORTS.join(',') + '\n');
                  throw new TreeExit(1);
                }
                break;
              }
              if (pre('--fromfile')) { j = a.length - 1; fromfile = true; break; }
              if (pre('--metafirst')) { j = a.length - 1; metafirst = true; break; }
              if (pre('--gitignore')) { j = a.length - 1; gitignore = true; break; }
              if (pre('--info')) { j = a.length - 1; showinfo = true; break; }
              errw(`tree: Invalid argument \`${a}'.\n`);
              usage(1);
              throw new TreeExit(1);
            }
            // falls through
          default:
            stdoutBuf.write(`here i = ${i}, n = ${n}\n`);
            errw(`tree: Invalid argument -\`${c}'.\n`);
            usage(1);
            throw new TreeExit(1);
        }
      }
    }

    const setoutput = (filename) => {
      if (filename === null) return;
      try { outfile = new StdioBuffer(ctx.openWrite(filename)); }
      catch (e) { if (e instanceof FsError) die(`tree: invalid filename '${filename}'\n`); throw e; }
    };
    setoutput(outfilename);

    // color.c parse_dir_colors(): only with $TERM, and only forced (stdout is never a terminal)
    let colorize = false, linktargetcolor = false;
    const colorCode = {};
    let exts = [];
    if (!Hflag && env.TERM !== undefined) {
      let s = env.TREE_COLORS ?? env.LS_COLORS ?? null;
      if (env.CLICOLOR_FORCE !== undefined && !nocolor) forceColor = true;
      if ((s === null || s === '') && (forceColor || env.CLICOLOR !== undefined)) s = TREE_COLORS;
      if (s !== null && forceColor) {
        colorize = true;
        for (const arg of s.split(':').filter(Boolean)) {
          const kv = arg.split('=').filter(Boolean);
          const key = kv[0], val = kv[1];
          if (key === undefined) continue;
          if (key[0] === '*') { if (val !== undefined) exts.unshift([key.slice(1), val]); continue; }
          const col = TREE_COLOR_CMDS[key];
          if (!col) continue;
          if (col === 'link' && val !== undefined && asciiLower(val) === 'target') { linktargetcolor = true; colorCode.link = '01;36'; continue; }
          if (val !== undefined) colorCode[col] = val;
        }
        colorCode.left ??= '\x1b[';
        colorCode.right ??= 'm';
        colorCode.reset ??= '0';
        colorCode.end ??= colorCode.left + colorCode.reset + colorCode.right;
      }
    }
    lineDraw = TREE_LINEDRAW[TREE_LINEDRAW.length - 1];
    if (charset !== null) {
      const cs = asciiLower(charset);
      const hit = TREE_LINEDRAW.find((ld) => ld.names && ld.names.some((x) => asciiLower(x) === cs));
      if (hit) lineDraw = hit;
    }

    if (!dirnames.length) dirnames.push('.');
    if (topsort === null) topsort = basesort;
    if (dflag) pruneflag = false;
    if (Rflag && Level === -1) Rflag = false;

    // ---- file system access
    const lstatP = (p) => { try { return ctx.fs.lstat(p, ctx.cwd); } catch { return null; } };
    const statP = (p) => { try { return ctx.fs.stat(p, ctx.cwd); } catch { return null; } };
    const TYPE_BITS = { f: S_IFREG, d: S_IFDIR, l: S_IFLNK, c: S_IFCHR, b: S_IFBLK, p: S_IFIFO, s: S_IFSOCK };
    const modeOf = (node) => (TYPE_BITS[node.type] || 0) | (node.mode & 0o7777);
    const sec = (ms) => Math.floor(ms / 1000);
    // fopen(): null when it fails; a directory opens but reads nothing
    const readText = (path) => { try { return ctx.readFile(path); } catch (e) { return e instanceof FsError && e.code === 'EISDIR' ? '' : null; } };
    const inodes = new Set();
    const saveino = (ino, dev) => inodes.add(ino + ':' + dev);
    const findino = (ino, dev) => inodes.has(ino + ':' + dev);
    const patinclude = (name, isdir) => patterns.some((p) => treePatmatch(name, p, isdir, ignorecase));
    const patignore = (name, isdir) => ipatterns.some((p) => treePatmatch(name, p, isdir, ignorecase));

    // ---- filter.c (.gitignore) and info.c (.info)
    const gittrim = (s) => {
      let e = s.length - 1;
      if (s[e] === '\n') e--;
      for (let i = e; i >= 0; i--) {
        if (s[i] !== ' ') break;
        if (i && s[i - 1] !== '\\') e--;
      }
      s = s.slice(0, e + 1);
      let r = '';
      for (let i = 0; i < s.length;) {
        if (s[i] === '\\') i++;
        if (i < s.length) r += s[i];
        i++;
      }
      return r;
    };
    const fileLines = (data) => (data.match(/[^\n]*\n|[^\n]+$/g) || []);
    let filterstack = [];
    let infostack = [];
    const newIgnorefile = (path) => {
      const data = readText(`${path}/.gitignore`);
      if (data === null) return null;
      const ig = { path, remove: [], reverse: [] };
      for (let line of fileLines(data)) {
        if (line[0] === '#') continue;
        const rev = line[0] === '!';
        line = gittrim(line);
        if (!line.length) continue;
        (rev ? ig.reverse : ig.remove).push(line.slice(rev ? 1 : 0));
      }
      return ig;
    };
    const filtercheck = (path, isdir) => {
      let filter = false;
      for (const ig of filterstack) {
        if (filter) break;
        for (const p of ig.remove) {
          if (treePatmatch(path, p, isdir, ignorecase) === 1) { filter = true; break; }
          if (p[0] === '/') continue;
          if (treePatmatch(path, `${ig.path}/${p}`, isdir, ignorecase) === 1) { filter = true; break; }
        }
      }
      if (!filter) return false;
      for (const ig of filterstack) {
        for (const p of ig.reverse) {
          if (treePatmatch(path, p, isdir, ignorecase) === 1) return false;
          if (p[0] === '/') continue;
          if (treePatmatch(path, `${ig.path}/${p}`, isdir, ignorecase) === 1) return false;
        }
      }
      return true;
    };
    const INFO_PATH = '/usr/share/finfo/global_info';
    const newInfofile = (path) => {
      const data = readText(path === INFO_PATH ? path : `${path}/.info`);
      if (data === null) return null;
      const comments = [];
      let phead = [], lines = [];
      for (let buf of fileLines(data)) {
        if (buf[0] === '#') continue;
        buf = gittrim(buf);
        if (buf.length < 1) continue;
        if (buf[0] === '\t') lines.push(buf.slice(1));
        else {
          if (lines.length) {
            if (phead.length) comments.push({ patterns: phead, desc: lines });
            phead = []; lines = [];
          }
          phead.push(buf);
        }
      }
      if (phead.length) comments.push({ patterns: phead, desc: lines });
      return { path, comments };
    };
    const infocheck = (path, name, top, isdir) => {
      for (const inf of infostack) {
        for (const com of inf.comments) {
          for (const p of com.patterns) {
            if (treePatmatch(path, p, isdir, ignorecase) === 1) return com;
            if (top && treePatmatch(name, p, isdir, ignorecase) === 1) return com;
          }
        }
        top = false;
      }
      return null;
    };
    const pushFiles = (dir) => {
      const r = { ig: null, inf: null };
      if (gitignore) { r.ig = newIgnorefile(dir); if (r.ig) filterstack.unshift(r.ig); }
      if (showinfo) { r.inf = newInfofile(dir); if (r.inf) infostack.unshift(r.inf); }
      return r;
    };
    const popFiles = (r) => {
      if (r.ig) filterstack.shift();
      if (r.inf) infostack.shift();
    };

    // ---- tree.c getinfo() / read_dir()
    const getinfo = (name, path) => {
      const lst = lstatP(path);
      if (!lst) return null;
      let st = lst;
      if (lst.type === 'l') st = statP(path);
      const stMode = st ? modeOf(st) : 0;
      const isdir = (stMode & S_IFMT) === S_IFDIR;
      if (gitignore && filtercheck(path, isdir)) return null;
      if (lst.type !== 'd' && !(lflag && isdir)) {
        if (patterns.length && !patinclude(name, isdir)) return null;
      }
      if (ipatterns.length && patignore(name, isdir)) return null;
      if (dflag && !isdir) return null;
      const ent = {
        name, lnk: null, orphan: false, mode: modeOf(lst), lnkmode: 0, uid: lst.uid, gid: lst.gid, size: lst.size,
        atime: sec(lst.atime), ctime: sec(lst.ctime), mtime: sec(lst.mtime),
        dev: st ? TREE_DEV : 0, inode: st ? st.ino : 0, ldev: TREE_DEV, linode: lst.ino,
        isdir, issok: (stMode & S_IFMT) === S_IFSOCK, isfifo: (stMode & S_IFMT) === S_IFIFO, isexe: (stMode & 0o111) !== 0,
        err: null, tag: null, comment: null, child: null,
      };
      if (lst.type === 'l') { ent.lnk = lst.target; if (!st) ent.orphan = true; ent.lnkmode = stMode; }
      return ent;
    };
    const readDir = (dir, infotop) => {
      ctx.tick();
      const node = statP(dir);
      if (!node || node.type !== 'd') return { dl: null, n: -1 };
      const es = dir[dir.length - 1] === '/';
      const dl = [];
      for (const name of [...node.entries.keys()]) {
        if (Hflag && name === '00Tree.html') continue;
        if (!aflag && name[0] === '.') continue;
        const path = es ? dir + name : `${dir}/${name}`;
        const info = getinfo(name, path);
        if (!info) continue;
        if (showinfo) { const com = infocheck(path, name, infotop, info.isdir); if (com) info.comment = com.desc.slice(); }
        dl.push(info);
      }
      return dl.length ? { dl, n: dl.length } : { dl: null, n: 0 };
    };

    // ---- sorting (qsort with tree's comparison functions; -U leaves readdir order)
    const strcoll = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    const BASE = {
      name: (x, y) => strcoll(x.name, y.name),
      version: (x, y) => treeStrverscmp(x.name, y.name),
      mtime: (x, y) => (x.mtime === y.mtime ? strcoll(x.name, y.name) : x.mtime < y.mtime ? -1 : 1),
      ctime: (x, y) => (x.ctime === y.ctime ? strcoll(x.name, y.name) : x.ctime < y.ctime ? -1 : 1),
      size: (x, y) => (x.size === y.size ? strcoll(x.name, y.name) : x.size < y.size ? 1 : -1),
    };
    const base = (x, y) => { const v = BASE[basesort](x, y); return reverse ? -v : v; };
    const sortDir = (list) => {
      if (!topsort || list.length < 2) return;
      if (topsort === 'dirsfirst' || topsort === 'filesfirst') {
        const first = topsort === 'dirsfirst' ? -1 : 1;
        // dirsfirst() calls basesort, a null pointer after -U: any two alike entries crash
        if (basesort === null && (list.filter((e) => e.isdir).length > 1 || list.filter((e) => !e.isdir).length > 1)) throw new TreeCrash();
        list.sort((x, y) => (x.isdir !== y.isdir ? (x.isdir ? first : -first) : base(x, y)));
        return;
      }
      list.sort(base);
    };

    // ---- tree.c output helpers
    const prot = (m) => {
      const t = TREE_IFMT.find(([f]) => (m & S_IFMT) === f);
      let s = t ? t[1] : '?';
      const perms = 'rwxrwxrwx';
      for (let i = 0, b = 0o400; i < 9; i++, b >>= 1) s += m & b ? perms[i] : '-';
      const set = (i, ch) => { s = s.slice(0, i) + (s[i] === '-' ? ch.toUpperCase() : ch) + s.slice(i + 1); };
      if (m & 0o4000) set(3, 's');
      if (m & 0o2000) set(6, 's');
      if (m & 0o1000) set(9, 't');
      return s;
    };
    const ftypeName = (m) => { const t = TREE_IFMT.find(([f]) => (m & S_IFMT) === f); return t ? t[2] : 'unknown'; };
    const Ftype = (mode) => {
      const m = mode & S_IFMT;
      if (!dflag && m === S_IFDIR) return '/';
      if (m === S_IFSOCK) return '=';
      if (m === S_IFIFO) return '|';
      if (m === S_IFLNK) return '@';
      if (m === S_IFREG && (mode & 0o111)) return '*';
      return '';
    };
    const psize = (size) => {
      const unit = siflag ? 'dkMGTPEZY' : 'BKMGTPEZY';
      const usize = siflag ? 1000 : 1024;
      if (hflag || siflag) {
        let idx = size < usize ? 0 : 1;
        for (; size >= usize * usize; idx++) size = Math.trunc(size / usize);
        if (!idx) return ' ' + String(size).padStart(4);
        const v = Math.fround(Math.fround(size) / Math.fround(usize));
        return ' ' + fixedDigits(v, Math.trunc(size / usize) >= 10 ? 0 : 1).padStart(3) + unit[idx];
      }
      return ' ' + String(size).padStart(11);
    };
    const doDate = (t) => {
      const d = new Date(t * 1000);
      if (timefmt !== null) return strftime(timefmt, d).slice(0, 255);
      const now = Math.floor(ctx.fs.now() / 1000);
      if (t > now || t + 6 * 31 * 24 * 60 * 60 < now) return strftime('%b %e  %Y', d);
      return strftime('%b %e %R', d);
    };
    const fillinfo = (ent) => {
      let buf = '';
      if (inodeflag) buf += ' ' + String(ent.linode).padStart(7);
      if (devflag) buf += ' ' + String(ent.ldev).padStart(3);
      if (pflag) buf += ' ' + prot(ent.mode);
      if (uflag) buf += ' ' + userName(ent.uid).slice(0, 32).padEnd(8);
      if (gflag) buf += ' ' + groupName(ent.gid).slice(0, 32).padEnd(8);
      if (sflag) buf += psize(ent.size);
      if (Dflag) buf += ' ' + doDate(cflag ? ent.ctime : ent.mtime);
      if (buf[0] === ' ') buf = '[' + buf.slice(1) + ']';
      return buf;
    };
    const iswprint = (ch) => !/[\p{Cc}\p{Cn}\p{Cs}]/u.test(ch);
    const printit = (s) => {
      if (Nflag) { out(Qflag ? `"${s}"` : s); return; }
      if (mbCurMax > 1 && isValidUtf8(s)) {
        let ws = null;
        try { ws = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (ch) => ch.charCodeAt(0))); } catch { ws = null; }
        if (ws !== null) {
          let o = Qflag ? '"' : '';
          for (const ch of ws) {
            if (iswprint(ch)) o += utf8Encode(ch);
            else o += qflag ? '?' : '\\' + ch.codePointAt(0).toString(8).padStart(3, '0');
          }
          out(o + (Qflag ? '"' : ''));
          return;
        }
      }
      let o = Qflag ? '"' : '';
      for (const ch of s) {
        const c = ch.charCodeAt(0);
        if ((c >= 7 && c <= 13) || c === 92 || (c === 34 && Qflag) || (c === 32 && !Qflag)) o += '\\' + (c > 13 ? ch : 'abtnvfr'[c - 7]);
        else if (c >= 32 && c < 127) o += ch;
        else if (qflag) o += mbCurMax > 1 && c > 127 ? ch : '?';
        else o += '\\' + c.toString(8).padStart(3, '0');
      }
      out(o + (Qflag ? '"' : ''));
    };
    const indent = (maxlevel) => {
      if (ansilines) {
        if (dirs[1]) out('\x1b(0');
        for (let i = 1; i <= maxlevel && dirs[i]; i++) {
          if (dirs[i + 1]) { if (dirs[i] === 1) out('x   '); else stdoutBuf.write('    '); }
          else out(dirs[i] === 1 ? 'tqq ' : 'mqq ');
        }
        if (dirs[1]) out('\x1b(B');
        return;
      }
      if (Hflag) out('\t');
      for (let i = 1; i <= maxlevel && dirs[i]; i++) {
        out((dirs[i + 1] ? (dirs[i] === 1 ? lineDraw.vert : (Hflag ? '&nbsp;&nbsp;&nbsp;' : '   ')) : (dirs[i] === 1 ? lineDraw.vertLeft : lineDraw.corner)) + ' ');
      }
    };
    const printcomment = (line, lines, s) => {
      let mark;
      if (lines === 1) mark = lineDraw.csingle;
      else if (line === 0) mark = lineDraw.ctop;
      else if (line < 2) mark = lines === 2 ? lineDraw.cbot : lineDraw.cmid;
      else mark = line === lines - 1 ? lineDraw.cbot : lineDraw.cext;
      out(`${mark} ${s}\n`);
    };
    const printColor = (k) => {
      if (colorCode[k] === undefined) return false;
      out(colorCode.left + colorCode[k] + colorCode.right);
      return true;
    };
    const endcolor = () => { if (colorCode.end !== undefined) out(colorCode.end); };
    const color = (mode, name, orphan, islink) => {
      if (orphan && printColor(islink ? 'missing' : 'orphan')) return true;
      switch (mode & S_IFMT) {
        case S_IFIFO: return printColor('fifo');
        case S_IFCHR: return printColor('chr');
        case S_IFDIR:
          if (mode & 0o1000) {
            if ((mode & 0o2) && printColor('stickyow')) return true;
            if (!(mode & 0o2) && printColor('sticky')) return true;
          }
          if ((mode & 0o2) && printColor('ow')) return true;
          return printColor('dir');
        case S_IFBLK: return printColor('blk');
        case S_IFLNK: return printColor('link');
        case S_IFSOCK: return printColor('sock');
        case S_IFREG: {
          if ((mode & 0o4000) && printColor('setuid')) return true;
          if ((mode & 0o2000) && printColor('setgid')) return true;
          if ((mode & 0o111) && printColor('exec')) return true;
          for (const [ext, flg] of exts) {
            if ((name.length > ext.length ? name.slice(name.length - ext.length) : name) === ext) { out(colorCode.left + flg + colorCode.right); return true; }
          }
          return printColor('file');
        }
        default: return printColor('normal');
      }
    };
    const jsonEncode = (s) => {
      const ctrl = '0-------btn-fr------------------';
      let o = '';
      for (const ch of s) {
        const c = ch.charCodeAt(0);
        if (c < 32) o += ctrl[c] !== '-' ? '\\' + ctrl[c] : '\\u' + c.toString(16).padStart(4, '0');
        else if (ch === '"' || ch === '\\') o += '\\' + ch;
        else o += ch;
      }
      out(o);
    };
    const htmlEncode = (s) => out(s.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]));
    const urlEncode = (s) => {
      let o = '';
      for (const ch of s) {
        const c = ch.charCodeAt(0);
        if (' "#%<>[]^\\?+'.includes(ch)) o += '%' + c.toString(16).toUpperCase().padStart(2, '0');
        else if (ch === '&') o += '&amp;';
        else o += c >= 32 && c < 127 ? ch : '%' + c.toString(16).toUpperCase().padStart(2, '0');
      }
      out(o);
    };

    // ---- the listing calls: unix.c, json.c, xml.c, html.c
    let infoBuf = '';
    const LC = {
      unix: {
        intro() {}, outtro() {},
        printinfo(dirname, file, level) {
          infoBuf = fillinfo(file);
          if (metafirst) { if (infoBuf[0] === '[') out(infoBuf + '  '); if (!noindent) indent(level); }
          else { if (!noindent) indent(level); if (infoBuf[0] === '[') out(infoBuf + '  '); }
        },
        printfile(dirname, filename, file) {
          let colored = false;
          if (file && colorize) colored = file.lnk && linktargetcolor ? color(file.lnkmode, file.name, file.orphan, false) : color(file.mode, file.name, file.orphan, false);
          printit(filename);
          if (colored) endcolor();
          if (file) {
            if (Fflag && !file.lnk) out(Ftype(file.mode));
            if (file.lnk) {
              out(' -> ');
              if (colorize) colored = color(file.lnkmode, file.lnk, file.orphan, true);
              printit(file.lnk);
              if (colored) endcolor();
              if (Fflag) out(Ftype(file.lnkmode));
            }
          }
          return 0;
        },
        error(e) { out(`  [${e}]`); },
        newline(file, level, postdir) {
          if (postdir <= 0) out('\n');
          if (file && file.comment) {
            const infosize = metafirst && infoBuf[0] === '[' ? infoBuf.length + 2 : 0;
            const lines = file.comment.length;
            dirs[level + 1] = 1;
            for (let line = 0; line < lines; line++) {
              if (metafirst) stdoutBuf.write(' '.repeat(infosize));
              indent(level);
              printcomment(line, lines, file.comment[line]);
            }
            dirs[level + 1] = 0;
          }
        },
        close() {},
        report(tot) {
          out('\n');
          if (duflag) out(`${psize(tot.size)}${hflag || siflag ? '' : ' bytes'} used in `);
          if (dflag) out(`${tot.dirs} director${tot.dirs === 1 ? 'y' : 'ies'}\n`);
          else out(`${tot.dirs} director${tot.dirs === 1 ? 'y' : 'ies'}, ${tot.files} file${tot.files === 1 ? '' : 's'}\n`);
        },
      },
      json: {
        intro() { out('[' + (noindent ? '' : nl)); },
        outtro() { out((noindent ? '' : nl) + ']\n'); },
        printinfo(dirname, file, level) {
          if (!noindent) out('  ' + '  '.repeat(Math.max(level, 0)));
          out(`{"type":"${ftypeName(file.mode)}"`);
        },
        printfile(dirname, filename, file, descend) {
          out(',"name":"'); jsonEncode(filename); out('"');
          if (file && file.comment) {
            out(',"info":"');
            file.comment.forEach((c, i) => { jsonEncode(c); if (i + 1 < file.comment.length) out('\\n'); });
            out('"');
          }
          if (file && file.lnk) { out(',"target":"'); jsonEncode(file.lnk); out('"'); }
          if (file) {
            if (inodeflag) out(`,"inode":${file.inode}`);
            if (devflag) out(`,"dev":${file.dev}`);
            if (pflag) out(`,"mode":"${(file.mode & 0o7777).toString(8).padStart(4, '0')}","prot":"${prot(file.mode)}"`);
            if (uflag) out(`,"user":"${userName(file.uid)}"`);
            if (gflag) out(`,"group":"${groupName(file.gid)}"`);
            if (sflag) out(hflag || siflag ? `,"size":"${psize(file.size).replace(/^[ \t\n\v\f\r]+/, '')}"` : `,"size":${file.size}`);
            if (Dflag) out(`,"time":"${doDate(cflag ? file.ctime : file.mtime)}"`);
          }
          out(descend ? ',"contents":[' : '}');
          return descend;
        },
        error(e) { out(`{"error": "${e}"}${noindent ? '' : '\n'}`); },
        newline(file, level, postdir, needcomma) { out((needcomma ? ',' : '') + nl); },
        close(file, level, needcomma) {
          if (!noindent) out('  ' + '  '.repeat(Math.max(level - 1, 0)));
          out(`]}${needcomma ? ',' : ''}${noindent ? '' : '\n'}`);
        },
        report(tot) {
          out(`,${noindent ? '' : '\n  '}{"type":"report"`);
          if (duflag) out(`,"size":${tot.size}`);
          out(`,"directories":${tot.dirs}`);
          if (!dflag) out(`,"files":${tot.files}`);
          out('}');
        },
      },
      xml: {
        intro() { out(`<?xml version="1.0"${charset !== null ? ` encoding="${charset}"` : ''}?>${nl}<tree>${nl}`); },
        outtro() { out('</tree>\n'); },
        printinfo(dirname, file, level) {
          if (!noindent) out('  ' + '  '.repeat(Math.max(level, 0)));
          file.tag = ftypeName(file.mode);
          out('<' + file.tag);
        },
        printfile(dirname, filename, file) {
          out(' name="'); htmlEncode(filename); out('"');
          if (file && file.comment) {
            out(' info="');
            file.comment.forEach((c, i) => { htmlEncode(c); if (i + 1 < file.comment.length) out('\n'); });
            out('"');
          }
          if (file && file.lnk) { out(' target="'); htmlEncode(file.lnk); out('"'); }
          if (file) {
            if (inodeflag) out(` inode="${file.inode}"`);
            if (devflag) out(` dev="${file.dev}"`);
            if (pflag) out(` mode="${(file.mode & 0o7777).toString(8).padStart(4, '0')}" prot="${prot(file.mode)}"`);
            if (uflag) out(` user="${userName(file.uid)}"`);
            if (gflag) out(` group="${groupName(file.gid)}"`);
            if (sflag) out(` size="${file.size}"`);
            if (Dflag) out(` time="${doDate(cflag ? file.ctime : file.mtime)}"`);
          }
          out('>');
          return 1;
        },
        error(e) { out(`<error>${e}</error>`); },
        newline(file, level, postdir) { if (postdir >= 0) out('\n'); },
        close(file, level) {
          if (!file) throw new TreeCrash();
          if (!noindent && level >= 0) out('  ' + '  '.repeat(Math.max(level - 1, 0)));
          out(`</${file.tag}>${noindent ? '' : '\n'}`);
        },
        report(tot) {
          const i2 = noindent ? '' : '  ', i4 = noindent ? '' : '    ';
          out(`${i2}<report>${nl}`);
          if (duflag) out(`${i4}<size>${tot.size}</size>${nl}`);
          out(`${i4}<directories>${tot.dirs}</directories>${nl}`);
          if (!dflag) out(`${i4}<files>${tot.files}</files>${nl}`);
          out(`${i2}</report>${nl}`);
        },
      },
      html: {
        intro() {
          out(`<!DOCTYPE html>\n<html>\n<head>\n <meta http-equiv="Content-Type" content="text/html; charset=${charset !== null ? charset : 'iso-8859-1'}">\n`
            + ` <meta name="Author" content="Made by 'tree'">\n <meta name="GENERATOR" content="${TREE_VERSION}">\n <title>${title}</title>\n`
            + ' <style type="text/css">\n  BODY { font-family : monospace, sans-serif;  color: black;}\n'
            + '  P { font-family : monospace, sans-serif; color: black; margin:0px; padding: 0px;}\n'
            + '  A:visited { text-decoration : none; margin : 0px; padding : 0px;}\n'
            + '  A:link    { text-decoration : none; margin : 0px; padding : 0px;}\n'
            + '  A:hover   { text-decoration: underline; background-color : yellow; margin : 0px; padding : 0px;}\n'
            + '  A:active  { margin : 0px; padding : 0px;}\n'
            + '  .VERSION { font-size: small; font-family : arial, sans-serif; }\n'
            + '  .NORM  { color: black;  }\n  .FIFO  { color: purple; }\n  .CHAR  { color: yellow; }\n  .DIR   { color: blue;   }\n'
            + '  .BLOCK { color: yellow; }\n  .LINK  { color: aqua;   }\n  .SOCK  { color: fuchsia;}\n  .EXEC  { color: green;  }\n'
            + ` </style>\n</head>\n<body>\n\t<h1>${title}</h1><p>\n`);
        },
        outtro() {
          const c = lineDraw.copy;
          out('\t<hr>\n\t<p class="VERSION">\n'
            + `\t\t tree v2.0.2 ${c} 1996 - 2022 by Steve Baker and Thomas Moore <br>\n`
            + `\t\t HTML output hacked and copyleft ${c} 1998 by Francesc Rocher <br>\n`
            + `\t\t JSON output hacked and copyleft ${c} 2014 by Florian Sesser <br>\n`
            + `\t\t Charsets / OS/2 support ${c} 2001 by Kyosuke Tokoro\n`
            + '\t</p>\n</body>\n</html>\n');
        },
        printinfo(dirname, file, level) {
          const info = fillinfo(file);
          const hp = () => { out(info.replace(/ /g, sp) + sp + sp); out(sp + sp); };
          if (metafirst) { if (info[0] === '[') hp(); if (!noindent) indent(level); }
          else { if (!noindent) indent(level); if (info[0] === '[') hp(); }
        },
        printfile(dirname, filename, file, descend) {
          out('<a');
          if (file) {
            if (forceColor) out(` class="${file.isdir ? 'DIR' : file.isexe ? 'EXEC' : file.isfifo ? 'FIFO' : file.issok ? 'SOCK' : 'NORM'}"`);
            if (file.comment) {
              out(' title="');
              file.comment.forEach((c, i) => { htmlEncode(c); if (i + 1 < file.comment.length) out('\n'); });
              out('"');
            }
            if (!nolinks) {
              out(` href="${host}`);
              if (dirname !== null) {
                urlEncode(dirname.slice(dirname.length >= htmldirlen ? htmldirlen : 0));
                out('/');
                urlEncode(filename);
                out(`${descend > 1 ? '/00Tree.html' : ''}${file.isdir ? '/' : ''}"`);
              } else out(`${descend > 1 ? '/00Tree.html' : ''}"`);
            }
          }
          out('>');
          htmlEncode(dirname !== null ? filename : host);
          out('</a>');
          return 0;
        },
        error(e) { out(`  [${e}]`); },
        newline() { out('<br>\n'); },
        close(file) { out(`</${file.tag}><br>\n`); },
        report(tot) {
          out('<br><br><p>\n\n');
          if (duflag) out(`${psize(tot.size)}${hflag || siflag ? '' : ' bytes'} used in `);
          if (dflag) out(`${tot.dirs} director${tot.dirs === 1 ? 'y' : 'ies'}\n`);
          else out(`${tot.dirs} director${tot.dirs === 1 ? 'y' : 'ies'}, ${tot.files} file${tot.files === 1 ? '' : 's'}\n`);
          out('\n</p>\n');
        },
      },
    };
    const lc = LC[lcName];

    // ---- tree.c unix_getfulltree() (--du, --prune, --matchdirs) and file.c (--fromfile)
    const getfulltreeUnix = (d, lev, dev, sizeRef) => {
      if (Level >= 0 && lev > Level) return { dir: null, err: null };
      let saved = null;
      if (matchdirs && patterns.length) {
        let levTmp = lev, k = d.length;
        for (; k !== 0; --k) {
          if (d[k] === '/') --levTmp;
          if (levTmp <= 0) { if (k < d.length) ++k; break; }
        }
        if (k < d.length && patinclude(d.slice(k), true)) { saved = patterns; patterns = []; }
      }
      const pushed = pushFiles(d);
      const r = readDir(d, pushed.inf !== null);
      if (saved) patterns = saved;
      if (!r.dl && r.n) { errors++; return { dir: null, err: 'error opening dir' }; }
      if (r.n === 0) return { dir: null, err: null };
      if (flimit > 0 && (r.n >>> 0) > flimit) return { dir: null, err: `${r.n} entries exceeds filelimit, not opening dir` };
      const list = r.dl;
      for (let k = 0; k < list.length;) {
        const e = list[k];
        if (e.isdir && !(xdev && dev !== e.dev)) {
          if (e.lnk) {
            if (lflag) {
              if (findino(e.inode, e.dev)) e.err = 'recursive, not followed';
              else {
                saveino(e.inode, e.dev);
                const p = e.lnk[0] === '/' ? e.lnk : (fflag && d === '/' ? d + e.lnk : `${d}/${e.lnk}`);
                const sub = getfulltreeUnix(p, lev + 1, dev, e);
                e.child = sub.dir; e.err = sub.err;
              }
            }
          } else {
            const p = fflag && d === '/' ? d + e.name : `${d}/${e.name}`;
            saveino(e.inode, e.dev);
            const sub = getfulltreeUnix(p, lev + 1, dev, e);
            e.child = sub.dir; e.err = sub.err;
          }
          if (pruneflag && e.child === null && !(matchdirs && patterns.length && patinclude(e.name, e.isdir))) { list.splice(k, 1); continue; }
        }
        if (duflag) sizeRef.size += e.size;
        k++;
      }
      sortDir(list);
      if (!list.length) return { dir: null, err: null };
      popFiles(pushed);
      return { dir: list, err: null };
    };
    const fprune = (head, matched, root) => {
      const kept = [];
      for (const ent of head) {
        if (ent.tchild.length) ent.isdir = true;
        let show = true;
        if (dflag && !ent.isdir) show = false;
        if (!aflag && !root && ent.name[0] === '.') show = false;
        if (show && !matched) {
          if (!ent.isdir) {
            if (patterns.length && !patinclude(ent.name, false)) show = false;
            if (ipatterns.length && patignore(ent.name, false)) show = false;
          }
          if (ent.isdir && show && matchdirs && patterns.length && patinclude(ent.name, true)) matched = true;
        }
        if (pruneflag && !matched && ent.isdir && !ent.tchild.length) show = false;
        if (show && ent.tchild.length) ent.child = fprune(ent.tchild, matched, false);
        if (show) kept.push(ent);
      }
      sortDir(kept);
      return kept;
    };
    let nextpcPrev = false;
    const getfulltreeFile = (d) => {
      const data = d === '.' ? ctx.stdin.readAll() : readText(d);
      if (data === null) { errw(`Error opening ${d} for reading.\n`); return { dir: null, err: null }; }
      const root = [];
      const search = (list, name) => {
        let k = 0;
        while (k < list.length && list[k].name < name) k++;
        if (k < list.length && list[k].name === name) return list[k];
        const ent = { name, lnk: null, orphan: false, mode: 0, lnkmode: 0, uid: 0, gid: 0, size: 0, atime: 0, ctime: 0, mtime: 0, dev: 0, inode: 0, ldev: 0, linode: 0, isdir: false, issok: false, isfifo: false, isexe: false, err: null, tag: null, comment: null, child: null, tchild: [] };
        list.splice(k, 0, ent);
        return ent;
      };
      for (let line of fileLines(data)) {
        if (line === '#') continue;
        line = line.replace(/[ \t\n\v\f\r]+$/, '');
        if (!line.length) continue;
        let cwd = root, p = 0;
        for (;;) {
          if (p >= line.length) break;                                        // T_EOP
          if (nextpcPrev) { nextpcPrev = false; continue; }                   // T_PATHSEP
          if (line[p] === '/') { p++; continue; }                             // T_PATHSEP
          const s = p;
          while (p < line.length && line[p] !== '/') p++;
          const ent = search(cwd, line.slice(s, p));
          if (p < line.length) { nextpcPrev = true; p++; ent.isdir = true; ent.mode = S_IFDIR; cwd = ent.tchild; }   // T_DIR
          else { ent.mode = S_IFREG; break; }                                 // T_FILE
        }
      }
      return { dir: fprune(root, false, true), err: null };
    };
    const getfulltree = (d, lev, dev, sizeRef) => (fromfile ? getfulltreeFile(d) : getfulltreeUnix(d, lev, dev, sizeRef));

    // ---- list.c
    const listdir = (dirname, dir, lev, dev, hasfulltree) => {
      const tot = { files: 0, dirs: 0, size: 0 };
      let htmldescend = 0;
      const es = dirname[dirname.length - 1] === '/';
      sortDir(dir);
      dirs[lev] = dir.length > 1 ? 1 : 2;
      for (let k = 0; k < dir.length; k++) {
        const e = dir[k];
        let pushed = null;
        lc.printinfo(dirname, e, lev);
        let path = es ? dirname + e.name : `${dirname}/${e.name}`;
        let filename = fflag ? path : e.name;
        let descend = 0, err = null, newpath = null, subdir = null;
        if (e.isdir) {
          tot.dirs++;
          const found = findino(e.inode, e.dev);
          if (!found) saveino(e.inode, e.dev);
          if (!(xdev && dev !== e.dev) && (!e.lnk || lflag)) {
            descend = 1;
            newpath = path;
            if (e.lnk) {
              if (e.lnk[0] === '/') newpath = e.lnk;
              else {
                // the link's target is written into the same buffer -f prints
                path = fflag && dirname === '/' ? dirname + e.lnk : `${dirname}/${e.lnk}`;
                newpath = path;
                if (fflag) filename = path;
              }
              if (found) { err = 'recursive, not followed'; descend = 0; }
            }
            if (Level >= 0 && lev > Level) {
              if (Rflag) {
                const outsave = outfile, dirsave = dirs.slice(0, lev + 1);
                setoutput(`${newpath}/00Tree.html`);
                emitTree([newpath], hasfulltree);
                outfile.flush();
                outfile = outsave;
                for (let q = 0; q <= lev; q++) dirs[q] = dirsave[q];
                htmldescend = 10;
              } else htmldescend = 0;
              descend = 0;
            }
            if (descend) {
              if (hasfulltree) { subdir = e.child; err = e.err; }
              else {
                pushed = pushFiles(newpath);
                const r = readDir(newpath, pushed.inf !== null);
                subdir = r.dl;
                if (!subdir && r.n) { err = 'error opening dir'; errors++; }
                if (flimit > 0 && (r.n >>> 0) > flimit) { err = `${r.n} entries exceeds filelimit, not opening dir`; errors++; subdir = null; }
              }
              if (!subdir) descend = 0;
            }
          }
        } else tot.files++;
        const needsclosed = lc.printfile(dirname, filename, e, descend + htmldescend);
        if (err) lc.error(err);
        if (descend) {
          lc.newline(e, lev, 0, 0);
          const sub = listdir(newpath, subdir, lev + 1, dev, hasfulltree);
          tot.dirs += sub.dirs; tot.files += sub.files; tot.size += sub.size;
        } else if (!needsclosed) lc.newline(e, lev, 0, k + 1 < dir.length);
        if (needsclosed) lc.close(e, descend ? lev : -1, k + 1 < dir.length);
        if (k + 1 < dir.length && k + 2 >= dir.length) dirs[lev] = 2;
        tot.size += e.size;
        if (pushed) popFiles(pushed);
      }
      dirs[lev] = 0;
      return tot;
    };

    const emitTree = (names, needfulltree) => {
      let tot = { files: 0, dirs: 0, size: 0 };
      let dir = null, dirFreed = false, info = null, n = 0;
      lc.intro();
      for (let i = 0; i < names.length; i++) {
        if (fflag) names[i] = names[i].length > 1 ? names[i].replace(/(.)\/+$/, '$1') : names[i];
        const name = names[i];
        if (Hflag) htmldirlen = name.length;
        const st = lstatP(name);
        let pushed = null;
        if (st) {
          saveino(st.ino, TREE_DEV);
          const m = modeOf(st);
          // stat2info() fills a static struct: dev and inode are never set (JSON/XML show 0)
          info = {
            name, lnk: null, orphan: false, mode: m, lnkmode: 0, uid: st.uid, gid: st.gid, size: st.size,
            atime: sec(st.atime), ctime: sec(st.ctime), mtime: sec(st.mtime), dev: 0, inode: 0, ldev: TREE_DEV, linode: st.ino,
            isdir: (m & S_IFMT) === S_IFDIR, issok: (m & S_IFMT) === S_IFSOCK, isfifo: (m & S_IFMT) === S_IFIFO, isexe: (m & 0o111) !== 0,
            err: null, tag: null, comment: null, child: null,
          };
          if (needfulltree) {
            const r = getfulltree(name, 0, TREE_DEV, info);
            dir = r.dir; n = r.err ? -1 : 0;
          } else {
            pushed = pushFiles(name);
            const r = readDir(name, pushed.inf !== null);
            dir = r.dl; n = r.n;
          }
          dirFreed = false;
          lc.printinfo(name, info, 0);
        } else { info = null; n = -1; }
        const needsclosed = lc.printfile(null, name, info, dir ? 1 : 0);
        if (!dir && n) {
          lc.error('error opening dir');
          lc.newline(info, 0, 0, i + 1 < names.length);
          errors++;
        } else if (flimit > 0 && (n >>> 0) > flimit) {
          lc.error(`${n} entries exceeds filelimit, not opening dir`);
          lc.newline(info, 0, 0, i + 1 < names.length);
          errors++;
        } else {
          lc.newline(info, 0, 0, 0);
          if (dir) {
            // an operand lstat() can't find keeps the previous operand's (freed) listing
            if (dirFreed) throw new TreeCrash();
            tot = listdir(name, dir, 1, 0, needfulltree);
            dirFreed = true;
          } else tot = { files: 0, dirs: 0, size: 0 };
        }
        if (needsclosed) lc.close(info, 0, i + 1 < names.length);
        if (duflag) { if (!info) throw new TreeCrash(); tot.size = info.size; }
        else if (st) tot.size += st.size;
        if (pushed) popFiles(pushed);
      }
      if (!noreport) lc.report(tot);
      lc.outtro();
    };

    if (gitignore && env.GIT_DIR) { const ig = newIgnorefile(`${env.GIT_DIR}/info/exclude`); if (ig) filterstack.unshift(ig); }
    if (showinfo) { const inf = newInfofile(INFO_PATH); if (inf) infostack.unshift(inf); }
    emitTree(dirnames, duflag || pruneflag || matchdirs || fromfile);
    return errors ? 2 : 0;
  };

  let st;
  try { st = run(); }
  catch (e) {
    if (e instanceof TreeCrash) return 139;
    if (!(e instanceof TreeExit)) throw e;
    st = e.code;
  }
  if (outfile !== stdoutBuf) outfile.flush();
  stdoutBuf.flush();
  return st;
};

// ---------------------------------------------------------------- realpath / readlink / mktemp / truncate / pwd
C.realpath = (ctx) => {
  const a = parseArgs(ctx, { short: 'eEmLPqsz', long: { 'canonicalize-existing': 'e', 'canonicalize-missing': 'm', logical: 'L', physical: 'P', quiet: 'q', strip: 's', 'no-symlinks': 's', zero: 'z', 'relative-to': ['rt', 'required'], 'relative-base': ['rb', 'required'] } });
  if (!a) return 1;
  if (!a.operands.length) { ctx.err('missing operand'); ctx.stderr.write("Try 'realpath --help' for more information.\n"); return 1; }
  let st = 0, out = '';
  for (const f of a.operands) {
    let p;
    if (a.has('s')) p = normPath(f.startsWith('/') ? f : joinPath(ctx.cwd, f));
    else {
      try { p = ctx.fs.realpath(f, ctx.cwd); }
      catch (e) {
        if (a.has('e')) { ctx.out(out); out = ''; if (!a.has('q')) ctx.err(`${qf(f)}: ${e.message}`); st = 1; continue; }
        // canonicalize parent, append last component
        try { p = joinPath(ctx.fs.realpath(pdir(f), ctx.cwd), pbase(f)); }
        catch (e2) { if (a.has('m')) p = normPath(f.startsWith('/') ? f : joinPath(ctx.cwd, f)); else { ctx.out(out); out = ''; if (!a.has('q')) ctx.err(`${qf(f)}: ${e2.message}`); st = 1; continue; } }
      }
    }
    if (a.has('rt')) { const base = ctx.fs.tryResolve(a.get('rt'), ctx.cwd); p = relativePath(base ? base.path : normPath(joinPath(ctx.cwd, a.get('rt'))), p); }
    out += p + (a.has('z') ? '\0' : '\n');
  }
  ctx.out(out);
  return st;
};

C.readlink = (ctx) => {
  const a = parseArgs(ctx, { short: 'efmnqsvz', long: { canonicalize: 'f', 'canonicalize-existing': 'e', 'canonicalize-missing': 'm', 'no-newline': 'n', quiet: 'q', silent: 's', verbose: 'v', zero: 'z' } });
  if (!a) return 1;
  if (!a.operands.length) { ctx.err('missing operand'); ctx.stderr.write("Try 'readlink --help' for more information.\n"); return 1; }
  let st = 0, out = '';
  const canon = a.has('f') || a.has('e') || a.has('m');
  for (const f of a.operands) {
    if (canon) {
      try { out += ctx.fs.realpath(f, ctx.cwd) + '\n'; }
      catch {
        if (a.has('e')) { st = 1; continue; }
        try { out += joinPath(ctx.fs.realpath(pdir(f), ctx.cwd), pbase(f)) + '\n'; }
        catch { if (a.has('m')) out += normPath(f.startsWith('/') ? f : joinPath(ctx.cwd, f)) + '\n'; else st = 1; }
      }
      continue;
    }
    try { out += ctx.fs.readlink(f, ctx.cwd) + '\n'; }
    catch (e) { ctx.out(out); out = ''; if (a.has('v')) ctx.err(`${f}: ${e.message}`); st = 1; }
  }
  if (a.has('n')) out = out.replace(/\n$/, '');
  if (a.has('z')) out = out.replace(/\n/g, '\0');
  ctx.out(out);
  return st;
};

// mktemp (coreutils 8.32 mktemp.c)
C.mktemp = (ctx) => {
  const q = (x) => quotearg(x, 'locale');
  const usage = () => { ctx.stderr.write("Try 'mktemp --help' for more information.\n"); return 1; };
  const r = getopt(ctx.argv.slice(1), { name: 'mktemp', short: 'dp:qtuV', long: { directory: 'd', quiet: 'q', 'dry-run': 'u', suffix: ['suffix', 'required'], tmpdir: ['p', 'optional'], help: 'help', version: 'V' } });
  let destDirArg = null, suppress = false, useDestDir = false, tOption = false, mkdir = false, dryRun = false, suffix = null;
  for (const [k, v] of r.opts) {
    if (k === 'd') mkdir = true;
    else if (k === 'p') { destDirArg = typeof v === 'string' ? v : null; useDestDir = true; }
    else if (k === 'q') suppress = true;
    else if (k === 't') { useDestDir = true; tOption = true; }
    else if (k === 'u') dryRun = true;
    else if (k === 'suffix') suffix = v;
  }
  if (r.error) { ctx.stderr.write(r.error + '\n'); return usage(); }
  const ops = r.operands;
  if (ops.length >= 2) { ctx.err('too many templates'); return usage(); }
  let template;
  if (!ops.length) { useDestDir = true; template = 'tmp.XXXXXXXXXX'; } else template = ops[0];
  let suffixStart;
  if (suffix !== null) {
    if (!template.length || template[template.length - 1] !== 'X') { ctx.err(`with --suffix, template ${q(template)} must end in X`); return 1; }
    suffixStart = template.length;
    template += suffix;
  } else {
    const x = template.lastIndexOf('X');
    suffixStart = x < 0 ? template.length : x + 1;
  }
  const suf = template.slice(suffixStart);
  if (suf.length && suf.includes('/')) { ctx.err(`invalid suffix ${q(suf)}, contains directory separator`); return 1; }
  let xCount = 0;
  while (xCount < suffixStart && template[suffixStart - 1 - xCount] === 'X') xCount++;
  if (xCount < 3) { ctx.err(`too few X's in template ${q(template)}`); return 1; }
  if (useDestDir) {
    const env = (ctx.env || {}).TMPDIR;
    let destDir;
    if (tOption) {
      destDir = env ? env : destDirArg ? destDirArg : '/tmp';
      if (template.includes('/')) { ctx.err(`invalid template, ${q(template)}, contains directory separator`); return 1; }
    } else {
      destDir = destDirArg ? destDirArg : env ? env : '/tmp';
      if (template[0] === '/') { ctx.err(`invalid template, ${q(template)}; with --tmpdir, it may not be absolute`); return 1; }
    }
    const shift = fileNameConcat(destDir, template).length - template.length;
    template = fileNameConcat(destDir, template);
    suffixStart += shift;
  }
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let name = null, err = null;
  for (let tries = 0; tries < 100; tries++) {
    let rnd = '';
    for (let k = 0; k < xCount; k++) rnd += chars[ctx.sh.random() % chars.length];
    const cand = template.slice(0, suffixStart - xCount) + rnd + template.slice(suffixStart);
    try {
      const parent = ctx.fs.parentOf(cand, ctx.cwd);
      if (!parent.dir) throw new FsError('ENOENT', cand);
      if (parent.dir.entries.has(parent.name)) { err = new FsError('EEXIST', cand); continue; }
      if (!dryRun) {
        if (mkdir) { ctx.fs.mkdir(cand, ctx.cwd); ctx.fs.stat(cand, ctx.cwd).mode = 0o700; }
        else { const n = ctx.fs.writeFile(cand, '', ctx.cwd); n.mode = 0o600; }
      }
      name = cand;
      break;
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      err = e;
      break;
    }
  }
  if (name === null) {
    if (!suppress) ctx.err(`failed to create ${mkdir ? 'directory' : 'file'} via template ${q(template)}: ${err ? err.message : 'File exists'}`);
    return 1;
  }
  ctx.out(name + '\n');
  return 0;
};

C.truncate = (ctx) => {
  const a = parseArgs(ctx, { short: 'cos:r:', long: { 'no-create': 'c', 'io-blocks': 'o', size: ['s', 'required'], reference: ['r', 'required'] } });
  if (!a) return 1;
  if (!a.has('s') && !a.has('r')) { ctx.err('you must specify either --size or --reference'); return 1; }
  let st = 0;
  for (const f of a.operands) {
    let n = statSafe(ctx, f);
    if (!n) { if (a.has('c')) continue; try { n = ctx.fs.writeFile(f, '', ctx.cwd); } catch (e) { ctx.err(`cannot open ${qa(f)} for writing: ${e.message}`); st = 1; continue; } }
    let size;
    if (a.has('r')) size = statSafe(ctx, a.get('r')).size;
    else {
      const m = /^([+\-<>/%]?)(\d+)([KMG]?)$/.exec(a.get('s'));
      if (!m) { ctx.err(`invalid number: ${qa(a.get('s'))}`); return 1; }
      let v = +m[2] * ({ '': 1, K: 1024, M: 1048576, G: 1073741824 }[m[3]]);
      const cur = n.size;
      size = { '': v, '+': cur + v, '-': Math.max(0, cur - v), '<': Math.min(cur, v), '>': Math.max(cur, v), '/': Math.floor(cur / v) * v, '%': Math.ceil(cur / v) * v }[m[1]];
    }
    n.data = n.data.length >= size ? n.data.slice(0, size) : n.data + '\0'.repeat(size - n.data.length);
    n.mtime = ctx.fs.now();
  }
  return st;
};

C.pwd = (ctx) => {
  const physical = ctx.argv.includes('-P');
  let p = ctx.env.PWD;
  const r = p && ctx.fs.tryResolve(p, '/');
  const c = ctx.fs.tryResolve(ctx.cwd, '/');
  if (physical || !r || !c || r.node !== c.node) p = c ? c.path : ctx.cwd;
  ctx.out(p + '\n');
  return 0;
};

C.dd = (ctx) => {
  const opts = {};
  for (const x of ctx.argv.slice(1)) { const i = x.indexOf('='); if (i > 0) opts[x.slice(0, i)] = x.slice(i + 1); }
  let data;
  try { data = opts.if ? ctx.readFile(opts.if) : ctx.stdin.readAll(); } catch (e) { ctx.err(`failed to open ${qa(opts.if)}: ${e.message}`); return 1; }
  const bs = parseInt(opts.bs || opts.ibs || '512', 10) * ({ K: 1024, M: 1048576 }[(opts.bs || '').slice(-1)] || 1);
  const skip = parseInt(opts.skip || '0', 10) * bs;
  let chunk = data.slice(skip);
  if (opts.count) chunk = chunk.slice(0, parseInt(opts.count, 10) * bs);
  if (opts.conv && opts.conv.includes('ucase')) chunk = chunk.toUpperCase();
  if (opts.conv && opts.conv.includes('lcase')) chunk = chunk.toLowerCase();
  if (opts.of) ctx.openWrite(opts.of).write(chunk); else ctx.out(chunk);
  if (opts.status !== 'none') {
    const full = Math.floor(chunk.length / bs), part = chunk.length % bs ? 1 : 0;
    ctx.stderr.write(`${full}+${part} records in\n${full}+${part} records out\n${chunk.length} bytes copied, 0.000123 s, 1.0 MB/s\n`);
  }
  return 0;
};

C.install = (ctx) => {
  const a = parseArgs(ctx, { short: 'bcCdDg:m:o:pt:TvS:', long: { directory: 'd', mode: ['m', 'required'], 'target-directory': ['t', 'required'], verbose: 'v' } });
  if (!a) return 1;
  if (a.has('d')) { for (const d of a.operands) ctx.fs.mkdir(d, ctx.cwd, { parents: true }); return 0; }
  const ops = a.operands;
  const target = a.get('t') || ops.pop();
  const tn = statSafe(ctx, target);
  for (const s of ops) {
    const dest = tn && tn.type === 'd' ? joinPath(target, pbase(s)) : target;
    const n = ctx.fs.writeFile(dest, ctx.readFile(s), ctx.cwd);
    n.mode = a.has('m') ? parseModeArg(a.get('m'), 0o755, false) : 0o755;
  }
  return 0;
};

C.sync = () => 0;

export default C;
