// In-memory POSIX-ish filesystem with inodes, symlinks, hard links and modes.
// Paths and contents are byte strings.

// what the system's binaries hold: an ELF header, then the name of the command they run
export const ELF_HEADER = '\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x03\x00>\x00\x01\x00\x00\x00';

export const ERRMSG = {
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EEXIST: 'File exists',
  ENOTEMPTY: 'Directory not empty',
  ELOOP: 'Too many levels of symbolic links',
  EINVAL: 'Invalid argument',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  EBUSY: 'Device or resource busy',
  ENAMETOOLONG: 'File name too long',
  EXDEV: 'Invalid cross-device link',
};

export class FsError extends Error {
  constructor(code, path) {
    super(ERRMSG[code] || code);
    this.code = code;
    this.path = path;
  }
}

let INO = 1000;

export class Inode {
  constructor(type, mode, now) {
    this.type = type;            // 'f' file, 'd' dir, 'l' symlink, 'c' char device, 'p' fifo
    this.mode = mode;            // permission bits (incl. setuid/sticky)
    this.ino = INO++;
    this.uid = 0; this.gid = 0;
    this.nlink = type === 'd' ? 2 : 1;
    this.mtime = this.atime = this.ctime = this.btime = now;
    if (type === 'f') this.data = '';
    else if (type === 'd') this.entries = new Map();
    else if (type === 'l') this.target = '';
  }
  get size() {
    if (this.type === 'f') return this.data.length;
    if (this.type === 'd') return 4096;
    if (this.type === 'l') return this.target.length;
    return 0;
  }
}

export function splitPath(p) {
  return p.split('/').filter(x => x !== '');
}

export function joinPath(a, b) {
  if (b.startsWith('/')) return b;
  if (a === '/') return '/' + b;
  return a + '/' + b;
}

// Lexically normalize an absolute path (no symlink resolution).
export function normPath(p) {
  const out = [];
  for (const c of splitPath(p)) {
    if (c === '.') continue;
    if (c === '..') out.pop();
    else out.push(c);
  }
  return '/' + out.join('/');
}

export function basename(p) {
  if (p === '') return '';
  let s = p.replace(/\/+$/, '');
  if (s === '') return '/';
  return s.slice(s.lastIndexOf('/') + 1);
}

export function dirname(p) {
  let s = p.replace(/\/+$/, '');
  if (s === '') return p.startsWith('/') ? '/' : '.';
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  s = s.slice(0, i).replace(/\/+$/, '');
  return s === '' ? '/' : s;
}

export class VFS {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.root = new Inode('d', 0o755, clock());
    this.umask = 0o022;
  }

  now() { return this.clock(); }

  // Resolve a path. Returns { node, parent, name, path } where path is canonical.
  // opts.follow: follow a symlink in the final component (default true)
  // opts.create: allow the final component to be missing (node = null)
  resolve(path, cwd = '/', opts = {}) {
    const follow = opts.follow !== false;
    if (path === '') throw new FsError('ENOENT', path);
    let comps = splitPath(path.startsWith('/') ? path : joinPath(cwd, path));
    const trailingSlash = path.length > 1 && path.endsWith('/');
    let stack = [];       // [{name, node}]
    let cur = this.root;
    let links = 0;
    let i = 0;
    while (i < comps.length) {
      const c = comps[i];
      const last = i === comps.length - 1;
      if (c === '.') { i++; if (last) break; continue; }
      if (c === '..') {
        if (stack.length) { stack.pop(); cur = stack.length ? stack[stack.length - 1].node : this.root; }
        i++; continue;
      }
      if (cur.type !== 'd') throw new FsError('ENOTDIR', path);
      const child = cur.entries.get(c);
      if (!child) {
        if (last && opts.create) {
          const parentPath = '/' + stack.map(s => s.name).join('/');
          return { node: null, parent: cur, name: c, path: joinPath(parentPath === '/' ? '/' : parentPath, c), trailingSlash };
        }
        throw new FsError('ENOENT', path);
      }
      if (child.type === 'l' && (!last || follow || trailingSlash)) {
        if (++links > 40) throw new FsError('ELOOP', path);
        const t = child.target;
        const rest = comps.slice(i + 1);
        if (t.startsWith('/')) { stack = []; cur = this.root; }
        comps = [...splitPath(t), ...rest];
        i = 0;
        if (comps.length === 0) break;
        continue;
      }
      stack.push({ name: c, node: child });
      cur = child;
      i++;
    }
    if (trailingSlash && cur.type !== 'd') throw new FsError('ENOTDIR', path);
    const parent = stack.length > 1 ? stack[stack.length - 2].node : this.root;
    const name = stack.length ? stack[stack.length - 1].name : '';
    return { node: cur, parent, name, path: '/' + stack.map(s => s.name).join('/') };
  }

  tryResolve(path, cwd, opts) {
    try { return this.resolve(path, cwd, opts); } catch { return null; }
  }

  lookup(path, cwd, follow = true) { return this.resolve(path, cwd, { follow }).node; }
  exists(path, cwd, follow = true) { return !!this.tryResolve(path, cwd, { follow }); }
  stat(path, cwd) { return this.resolve(path, cwd).node; }
  lstat(path, cwd) { return this.resolve(path, cwd, { follow: false }).node; }

  // Resolve the parent directory of `path` and return { dir, name } for create/remove ops.
  parentOf(path, cwd) {
    const abs = path.startsWith('/') ? path : joinPath(cwd, path);
    const comps = splitPath(abs);
    if (comps.length === 0) return { dir: null, name: '', abs: '/' };
    const name = comps[comps.length - 1];
    const parentPath = '/' + comps.slice(0, -1).join('/');
    const r = this.resolve(parentPath, '/', { follow: true });
    if (r.node.type !== 'd') throw new FsError('ENOTDIR', path);
    return { dir: r.node, name, abs, parentPath: r.path };
  }

  readFile(path, cwd) {
    const n = this.resolve(path, cwd).node;
    if (n.type === 'd') throw new FsError('EISDIR', path);
    n.atime = this.now();
    return n.type === 'f' ? n.data : '';
  }

  writeFile(path, data, cwd, opts = {}) {
    let r = this.resolve(path, cwd, { create: true });
    let n = r.node;
    if (n && n.type === 'd') throw new FsError('EISDIR', path);
    if (!n) {
      if (r.trailingSlash) throw new FsError('EISDIR', path);
      n = new Inode('f', (opts.mode ?? 0o666) & ~this.umask, this.now());
      r.parent.entries.set(r.name, n);
      r.parent.mtime = this.now();
    }
    if (n.type !== 'f') return n; // devices: ignore
    n.data = opts.append ? n.data + data : data;
    n.mtime = n.ctime = this.now();
    return n;
  }

  // Create-or-open for writing; returns the inode (truncated unless append).
  openWrite(path, cwd, append = false) {
    const n = this.writeFile(path, '', cwd, { append: true });
    if (n.type === 'f' && !append) { n.data = ''; n.mtime = this.now(); }
    return n;
  }

  mkdir(path, cwd, opts = {}) {
    const abs = path.startsWith('/') ? path : joinPath(cwd, path);
    if (opts.parents) {
      const comps = splitPath(abs);
      let cur = '/';
      let created = [];
      for (const c of comps) {
        const next = joinPath(cur, c);
        const r = this.tryResolve(next, '/', {});
        if (r) {
          if (r.node.type !== 'd') throw new FsError(c === comps[comps.length - 1] ? 'EEXIST' : 'ENOTDIR', next);
          cur = r.path;
          continue;
        }
        const { dir, name } = this.parentOf(next, '/');
        const lr = dir.entries.get(name);
        if (lr) throw new FsError('EEXIST', next); // dangling symlink etc.
        const d = new Inode('d', (opts.mode ?? 0o777) & ~this.umask, this.now());
        dir.entries.set(name, d);
        dir.nlink++;
        dir.mtime = this.now();
        created.push(next);
        cur = next;
      }
      return created;
    }
    const { dir, name } = this.parentOf(abs, '/');
    if (!dir || name === '' ) throw new FsError('EEXIST', path);
    if (name === '.' || name === '..') throw new FsError('EEXIST', path);
    if (dir.entries.has(name)) throw new FsError('EEXIST', path);
    const d = new Inode('d', (opts.mode ?? 0o777) & ~this.umask, this.now());
    dir.entries.set(name, d);
    dir.nlink++;
    dir.mtime = this.now();
    return [abs];
  }

  readdir(path, cwd) {
    const n = this.resolve(path, cwd).node;
    if (n.type !== 'd') throw new FsError('ENOTDIR', path);
    // directory order: entries in creation order (the reference container's overlayfs keeps
    // that order; fixtures are created sorted)
    return [...n.entries.keys()];
  }

  // Remove a non-directory entry (file, symlink, device).
  unlink(path, cwd) {
    const { dir, name } = this.parentOf(path, cwd);
    if (!dir) throw new FsError('EISDIR', path);
    const n = dir.entries.get(name);
    if (!n) throw new FsError('ENOENT', path);
    if (n.type === 'd') throw new FsError('EISDIR', path);
    dir.entries.delete(name);
    n.nlink--;
    dir.mtime = this.now();
  }

  rmdir(path, cwd) {
    const { dir, name } = this.parentOf(path, cwd);
    if (!dir || name === '') throw new FsError('EBUSY', path);
    if (name === '.') throw new FsError('EINVAL', path);
    if (name === '..') throw new FsError('ENOTEMPTY', path);
    const n = dir.entries.get(name);
    if (!n) throw new FsError('ENOENT', path);
    if (n.type !== 'd') throw new FsError('ENOTDIR', path);
    if (n.entries.size) throw new FsError('ENOTEMPTY', path);
    dir.entries.delete(name);
    dir.nlink--;
    dir.mtime = this.now();
  }

  // rename(2) semantics.
  rename(src, dst, cwd) {
    if (dst === '' || src === '') throw new FsError('ENOENT', dst);
    const s = this.parentOf(src, cwd);
    const node = s.dir && s.dir.entries.get(s.name);
    if (!node) throw new FsError('ENOENT', src);
    // a trailing slash asks for a directory
    if ((src.endsWith('/') || dst.endsWith('/')) && node.type !== 'd') throw new FsError('ENOTDIR', src.endsWith('/') ? src : dst);
    const d = this.parentOf(dst, cwd);
    if (!d.dir) throw new FsError('EBUSY', dst);
    const existing = d.dir.entries.get(d.name);
    if (existing === node) return;
    if (node.type === 'd') {
      // cannot move a directory into itself
      const srcAbs = this.resolve(src, cwd, { follow: false }).path;
      const dstParent = d.parentPath;
      if (dstParent === srcAbs || dstParent.startsWith(srcAbs + '/')) throw new FsError('EINVAL', dst);
      if (existing) {
        if (existing.type !== 'd') throw new FsError('ENOTDIR', dst);
        if (existing.entries.size) {
          // the kernel: a target that is an ancestor of the source is ENOTEMPTY; the file
          // system (as on the reference system) reports other non-empty targets as EEXIST
          const srcAbs = this.resolve(src, cwd, { follow: false }).path;
          const dstAbs = this.resolve(dst, cwd, { follow: false }).path;
          throw new FsError(srcAbs.startsWith(dstAbs === '/' ? '/' : dstAbs + '/') ? 'ENOTEMPTY' : 'EEXIST', dst);
        }
      }
    } else if (existing && existing.type === 'd') throw new FsError('EISDIR', dst);
    s.dir.entries.delete(s.name);
    if (existing && existing.type !== 'd') existing.nlink--;
    d.dir.entries.set(d.name, node);
    if (node.type === 'd') { s.dir.nlink--; if (!existing) d.dir.nlink++; }
    s.dir.mtime = d.dir.mtime = this.now();
    node.ctime = this.now();
  }

  symlink(target, path, cwd) {
    const { dir, name } = this.parentOf(path, cwd);
    if (!dir || dir.entries.has(name)) throw new FsError('EEXIST', path);
    const n = new Inode('l', 0o777, this.now());
    n.target = target;
    dir.entries.set(name, n);
    dir.mtime = this.now();
    return n;
  }

  link(existing, path, cwd) {
    const src = this.resolve(existing, cwd, { follow: false }).node;
    if (src.type === 'd') throw new FsError('EPERM', existing);
    const { dir, name } = this.parentOf(path, cwd);
    if (!dir || dir.entries.has(name)) throw new FsError('EEXIST', path);
    dir.entries.set(name, src);
    src.nlink++;
    src.ctime = this.now();
  }

  readlink(path, cwd) {
    const n = this.resolve(path, cwd, { follow: false }).node;
    if (n.type !== 'l') throw new FsError('EINVAL', path);
    return n.target;
  }

  realpath(path, cwd) { return this.resolve(path, cwd).path; }

  // Insert a node at path (used by cp/mkfifo/fixtures).
  putNode(path, node, cwd = '/') {
    const { dir, name } = this.parentOf(path, cwd);
    dir.entries.set(name, node);
    if (node.type === 'd') dir.nlink++;
    return node;
  }

  newNode(type, mode) { return new Inode(type, mode, this.now()); }

  // Deep-copy a subtree (for cp -r). Symlinks copied as symlinks.
  cloneNode(n, keep = false) {
    const c = new Inode(n.type, n.mode, keep ? n.mtime : this.now());
    if (keep) { c.atime = n.atime; c.uid = n.uid; c.gid = n.gid; }
    if (n.type === 'f') c.data = n.data;
    else if (n.type === 'l') c.target = n.target;
    else if (n.type === 'd') for (const [k, v] of n.entries) { const cc = this.cloneNode(v, keep); c.entries.set(k, cc); if (cc.type === 'd') c.nlink++; }
    else if (n.type === 'c') c.dev = n.dev;
    return c;
  }

  // Walk entries under a directory node: yields [relPath, node] depth-first, pre-order, sorted.
  *walk(node, prefix = '') {
    if (node.type !== 'd') return;
    for (const name of [...node.entries.keys()].sort(byteCmp)) {
      const child = node.entries.get(name);
      const p = prefix ? prefix + '/' + name : name;
      yield [p, child];
      if (child.type === 'd') yield* this.walk(child, p);
    }
  }
}

export function byteCmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export function modeString(n) {
  const t = { f: '-', d: 'd', l: 'l', c: 'c', p: 'p', s: 's' }[n.type] || '?';
  const m = n.mode;
  const rwx = (r, w, x, s, sc) => (m & r ? 'r' : '-') + (m & w ? 'w' : '-') + (m & s ? (m & x ? sc : sc.toUpperCase()) : (m & x ? 'x' : '-'));
  return t + rwx(0o400, 0o200, 0o100, 0o4000, 's') + rwx(0o40, 0o20, 0o10, 0o2000, 's') + rwx(0o4, 0o2, 0o1, 0o1000, 't');
}
