// Streams and control-flow signals used by the interpreter and commands.

export class PipeLimit extends Error { constructor() { super('output limit'); } }
export class ExecLimit extends Error { constructor(msg) { super(msg); } }
export class ExitSignal { constructor(code) { this.code = code; } }
export class ReturnSignal { constructor(code) { this.code = code; } }
export class BreakSignal { constructor(n) { this.n = n; } }
export class ContinueSignal { constructor(n) { this.n = n; } }
// Fatal error for the current top-level command (expansion errors etc.)
// A shell error that stops the current command. `discard` errors (bad substitutions, arithmetic
// errors, readonly assignments...) abandon only the current top-level command line, like bash's
// DISCARD; the others end a non-interactive shell.
export class ShellAbort { constructor(code, msg, discard = false) { this.code = code; this.msg = msg; this.discard = discard; } }

// Readable stream over a byte string.
export class InStream {
  constructor(data = '', name = null, seekable = false) { this.data = data; this.pos = 0; this.name = name; this.seekable = seekable; }
  readAll() { const s = this.pos ? this.data.slice(this.pos) : this.data; this.pos = this.data.length; return s; }
  eof() { return this.pos >= this.data.length; }
  // Read up to and including `delim`; returns null at EOF. `found` tells whether delim was seen.
  readUntil(delim = '\n') {
    if (this.pos >= this.data.length) return null;
    const j = this.data.indexOf(delim, this.pos);
    let s;
    if (j < 0) { s = this.data.slice(this.pos); this.pos = this.data.length; return { text: s, found: false }; }
    s = this.data.slice(this.pos, j);
    this.pos = j + delim.length;
    return { text: s, found: true };
  }
  read(n) { const s = this.data.slice(this.pos, this.pos + n); this.pos += s.length; return s; }
}

// stdin redirected from a regular file: reads see the file as it is now (a command that
// truncates its own input file, like `tee f < f`, finds it empty), at the stream's offset.
export class FileInStream extends InStream {
  constructor(node, name) { super('', name, true); this.node = node; }
  get data() { return this.node.type === 'f' ? this.node.data || '' : ''; }
  set data(_v) { /* the file's contents */ }
}

// In-memory output sink with a byte limit (exceeding it raises PipeLimit, like SIGPIPE).
export class OutBuf {
  constructor(limit = 8 * 1024 * 1024) { this.chunks = []; this.len = 0; this.limit = limit; this.overflow = false; }
  write(s) {
    if (!s) return;
    if (this.len + s.length > this.limit) {
      const room = this.limit - this.len;
      if (room > 0) { this.chunks.push(s.slice(0, room)); this.len += room; }
      this.overflow = true;
      throw new PipeLimit();
    }
    this.chunks.push(s);
    this.len += s.length;
  }
  get data() {
    if (this.chunks.length > 1) this.chunks = [this.chunks.join('')];
    return this.chunks[0] || '';
  }
}

export class NullSink { write() {} }

// Writes into a VFS file node (already opened/truncated).
export class FileSink {
  constructor(node, fs) { this.node = node; this.fs = fs; }
  write(s) {
    if (!s || this.node.type !== 'f') return;
    if (this.node.data.length + s.length > 32 * 1024 * 1024) throw new PipeLimit();
    this.node.data += s;
    this.node.mtime = this.fs.now();
  }
}
