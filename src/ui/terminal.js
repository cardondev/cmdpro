// A convincing terminal: readline-style editing, history, Ctrl+R search,
// Tab completion, PS2 continuation, ANSI output, paste guarding.
import { h, clear } from './dom.js';
import { ansiToFragment } from './ansi.js';

const MAX_BLOCKS = 1500;
const MAX_OUTPUT_CHARS = 250000;
const WORD_CHARS = /[A-Za-z0-9_]/;

export class Terminal {
  /**
   * opts: {
   *   prompt(): segments[], ps2(): segments[],
   *   onSubmit(text): Promise|void, onComplete(line, cursor): Promise<{start,end,matches}>,
   *   isIncomplete(text): Promise<boolean>, onType(): void, onBell(): void,
   *   pasteGuard(kind): string|null  (return a message to block),
   *   onKey(e): boolean (return true if handled: F-keys etc.), onEOF(): void,
   *   history: string[] (shared array)
   * }
   */
  constructor(opts = {}) {
    this.o = opts;
    this.history = opts.history || [];
    this.hIndex = null;
    this.draft = '';
    this.buffer = '';
    this.cursor = 0;
    this.pending = [];
    this.kill = '';
    this.busy = false;
    this.enabled = true;
    this.search = null;
    this.lastTab = 0;
    this.burst = [];
    this.composing = false;

    this.out = h('div', { class: 'term-out', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
    this.pendingEl = h('div', { class: 'term-pending' });
    this.promptEl = h('span', { class: 'term-prompt' });
    this.beforeEl = h('span', { class: 'term-text' });
    this.cursorEl = h('span', { class: 'term-cursor blink' }, ' ');
    this.afterEl = h('span', { class: 'term-text' });
    this.lineEl = h('div', { class: 'term-input-line' }, this.promptEl, this.beforeEl, this.cursorEl, this.afterEl);
    this.input = h('textarea', {
      class: 'term-hidden-input', 'aria-label': 'Command input', rows: 1,
      autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', 'data-gramm': 'false', enterkeyhint: 'send',
    });
    this.scroller = h('div', { class: 'term-scroll' }, this.out, this.pendingEl, this.lineEl);
    this.el = h('div', { class: 'term' }, this.scroller, this.input);

    this._bind();
    this.render();
  }

  // ---------- public API ----------
  focus() { if (!this.input.isConnected) return; this.input.focus({ preventScroll: true }); this.el.classList.add('focused'); }
  setPrompt(fn) { this.o.prompt = fn; this.render(); }
  setEnabled(on) { this.enabled = on; this.lineEl.classList.toggle('hidden', !on || this.busy); }
  setBusy(on) { this.busy = on; this.lineEl.classList.toggle('hidden', on || !this.enabled); this.el.classList.toggle('busy', on); }

  clear() { clear(this.out); }

  /** Print text that may contain ANSI escapes. */
  print(text, cls = '') {
    if (text === undefined || text === null) return;
    let t = String(text);
    let truncated = 0;
    if (t.length > MAX_OUTPUT_CHARS) { truncated = t.length - MAX_OUTPUT_CHARS; t = t.slice(0, MAX_OUTPUT_CHARS); }
    if (t.endsWith('\n')) t = t.slice(0, -1);
    const block = h('div', { class: 'term-block ' + cls });
    block.appendChild(ansiToFragment(t));
    this._append(block);
    if (truncated) this._append(h('div', { class: 'term-block term-note' }, `… output truncated (${truncated.toLocaleString()} more characters)`));
    return block;
  }

  /** Print [{t, c}] segments (pre-styled). */
  printSegments(segs, cls = '') {
    const block = h('div', { class: 'term-block ' + cls });
    for (const s of segs) block.appendChild(s.c ? h('span', { class: s.c }, s.t) : document.createTextNode(s.t));
    this._append(block);
    return block;
  }

  printNode(node) { const b = h('div', { class: 'term-block' }, node); this._append(b); return b; }

  /**
   * Plain-data copy of the newest scrollback, for saving:
   * [[blockClass, [[text, spanClass?, color?, background?], …]], …], oldest first.
   * Blocks marked `term-transient` (status notes about the session itself) are left out.
   */
  snapshot({ maxBlocks = 250, maxChars = 24000 } = {}) {
    const blocks = [];
    let chars = 0;
    for (let b = this.out.lastElementChild; b && blocks.length < maxBlocks; b = b.previousElementSibling) {
      if (b.classList.contains('term-transient')) continue;
      const segs = [];
      const walk = (node, cls, color, bg) => {
        for (const n of node.childNodes) {
          if (n.nodeType === 3) { if (n.data) segs.push([n.data, cls, color, bg]); }
          else if (n.nodeType === 1) walk(n, [cls, n.getAttribute('class')].filter(Boolean).join(' '), n.style.color || color, n.style.backgroundColor || bg);
        }
      };
      walk(b, '', '', '');
      const n = segs.reduce((a, sg) => a + sg[0].length, 0);
      if (chars + n > maxChars) break;
      chars += n;
      for (const sg of segs) while (sg.length > 1 && !sg[sg.length - 1]) sg.pop();
      blocks.push([b.className, segs]);
    }
    return blocks.reverse();
  }

  /** Re-create scrollback from snapshot() data. Plain data only: no markup is parsed. */
  restore(blocks) {
    const cls = (c) => String(c || '').replace(/[^\w -]/g, '').trim();
    const col = (c) => (/^(#[0-9a-f]{3,8}|rgba?\([\d., ]+\))$/i.test(c || '') ? c : '');
    for (const blk of Array.isArray(blocks) ? blocks : []) {
      if (!Array.isArray(blk) || !Array.isArray(blk[1])) continue;
      const block = h('div', { class: cls(blk[0]) || 'term-block' });
      for (const sg of blk[1]) {
        if (!Array.isArray(sg)) continue;
        const [t, c, fg, bg] = sg;
        const style = {};
        if (col(fg)) style.color = fg;
        if (col(bg)) style.backgroundColor = bg;
        const styled = cls(c) || style.color || style.backgroundColor;
        block.appendChild(styled ? h('span', { class: cls(c) || null, style }, String(t ?? '')) : document.createTextNode(String(t ?? '')));
      }
      this.out.appendChild(block);
    }
    while (this.out.childElementCount > MAX_BLOCKS) this.out.removeChild(this.out.firstChild);
    this.scrollToBottom();
  }

  /** Echo a command with its prompt into the scrollback (as if typed). */
  echoCommand(text, promptSegs) {
    const lines = String(text).split('\n');
    lines.forEach((l, i) => {
      const segs = i === 0 ? (promptSegs || this._promptSegs()) : this._ps2Segs();
      const row = h('div', { class: 'term-block term-echo' });
      for (const s of segs) row.appendChild(s.c ? h('span', { class: s.c }, s.t) : document.createTextNode(s.t));
      row.appendChild(document.createTextNode(l));
      this._append(row);
    });
  }

  /** Insert text at the cursor (used by the mobile extra-keys row). */
  insertText(text) {
    if (!this.enabled || this.busy) return;
    if (this.search) this._searchAccept();
    this._insert(text);
    this.focus();
  }

  /** Synthesize a special key from the extra-keys row: 'Tab', 'ArrowUp', … */
  sendKey(key, mods = {}) {
    this._handleKey({ key, code: '', ctrlKey: !!mods.ctrl, altKey: !!mods.alt, metaKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} });
    this.focus();
  }

  setLine(text) { this.buffer = text; this.cursor = text.length; this.render(); }
  get line() { return this.buffer; }

  destroy() { this._unbind && this._unbind(); }

  scrollToBottom() { this.scroller.scrollTop = this.scroller.scrollHeight; }

  // ---------- rendering ----------
  _promptSegs() { const p = this.o.prompt ? this.o.prompt() : [{ t: '$ ' }]; return typeof p === 'string' ? [{ t: p }] : p; }
  _ps2Segs() { const p = this.o.ps2 ? this.o.ps2() : [{ t: '> ', c: 'term-ps2' }]; return typeof p === 'string' ? [{ t: p }] : p; }

  render() {
    // pending (PS2) lines
    clear(this.pendingEl);
    this.pending.forEach((l, i) => {
      const segs = i === 0 ? this._promptSegs() : this._ps2Segs();
      const row = h('div', { class: 'term-block term-echo' });
      for (const s of segs) row.appendChild(s.c ? h('span', { class: s.c }, s.t) : document.createTextNode(s.t));
      row.appendChild(document.createTextNode(l));
      this.pendingEl.appendChild(row);
    });
    clear(this.promptEl);
    let segs;
    if (this.search) {
      const fail = this.search.failed ? 'failed ' : '';
      segs = [{ t: `(${fail}reverse-i-search)\`${this.search.query}': `, c: 'term-search' }];
    } else segs = this.pending.length ? this._ps2Segs() : this._promptSegs();
    for (const s of segs) this.promptEl.appendChild(s.c ? h('span', { class: s.c }, s.t) : document.createTextNode(s.t));
    const text = this.search ? (this.search.match ?? '') : this.buffer;
    const cur = this.search ? text.length : this.cursor;
    this.beforeEl.textContent = text.slice(0, cur);
    const ch = text.slice(cur, cur + 1);
    this.cursorEl.textContent = ch && ch !== '\n' ? ch : ' ';
    this.afterEl.textContent = text.slice(cur + 1);
    // restart blink on activity
    this.cursorEl.classList.remove('blink');
    void this.cursorEl.offsetWidth;
    this.cursorEl.classList.add('blink');
    this._positionInput();
  }

  _positionInput() {
    // Keep the hidden textarea next to the caret so IME popups and mobile scrolling behave.
    const top = this.lineEl.offsetTop - this.scroller.scrollTop;
    this.input.style.top = Math.max(0, top) + 'px';
  }

  _append(node) {
    const nearBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 80;
    this.out.appendChild(node);
    while (this.out.childElementCount > MAX_BLOCKS) this.out.removeChild(this.out.firstChild);
    if (nearBottom || this._forceScroll) this.scrollToBottom();
  }

  // ---------- editing ----------
  _insert(text) {
    if (!text) return;
    text = text.replace(/\r\n?/g, '\n');
    if (text.includes('\n')) {
      // Multi-line insert (paste): earlier lines become continuation lines; nothing is submitted.
      const parts = (this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor)).split('\n');
      const tail = parts.pop();
      this.pending.push(...parts);
      this.buffer = tail;
      this.cursor = tail.length;
    } else {
      this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
      this.cursor += text.length;
    }
    this.hIndex = null;
    this.render();
    this.scrollToBottom();
  }

  _wordLeft(pos) {
    let i = pos;
    while (i > 0 && !WORD_CHARS.test(this.buffer[i - 1])) i--;
    while (i > 0 && WORD_CHARS.test(this.buffer[i - 1])) i--;
    return i;
  }
  _wordRight(pos) {
    let i = pos;
    const n = this.buffer.length;
    while (i < n && !WORD_CHARS.test(this.buffer[i])) i++;
    while (i < n && WORD_CHARS.test(this.buffer[i])) i++;
    return i;
  }
  _killRange(a, b, append = false) {
    if (a === b) return;
    const cut = this.buffer.slice(a, b);
    this.kill = append ? cut : cut;
    this.buffer = this.buffer.slice(0, a) + this.buffer.slice(b);
    this.cursor = a;
  }

  _historyMove(dir) {
    if (!this.history.length) return this.o.onBell && this.o.onBell();
    if (this.hIndex === null) { if (dir > 0) return; this.draft = this.buffer; this.hIndex = this.history.length; }
    let i = this.hIndex + dir;
    if (i < 0) { i = 0; this.o.onBell && this.o.onBell(); }
    if (i >= this.history.length) { this.hIndex = null; this.buffer = this.draft; this.cursor = this.buffer.length; this.render(); return; }
    this.hIndex = i;
    this.buffer = this.history[i];
    this.cursor = this.buffer.length;
    this.render();
  }

  // ---------- reverse search ----------
  _searchStart() {
    if (!this.search) this.search = { query: '', match: '', at: this.history.length, saved: this.buffer, failed: false };
    else this._searchFind(true);
    this.render();
  }
  _searchFind(older = false) {
    const s = this.search;
    if (!s.query) { s.match = ''; s.failed = false; return; }
    let start = older ? s.at - 1 : Math.min(s.at, this.history.length - 1);
    for (let i = start; i >= 0; i--) {
      if (this.history[i].includes(s.query)) { s.at = i; s.match = this.history[i]; s.failed = false; return; }
    }
    s.failed = true;
  }
  _searchAccept() {
    const s = this.search;
    this.search = null;
    this.buffer = s.match || s.saved;
    this.cursor = this.buffer.length;
    this.render();
  }
  _searchCancel() {
    const s = this.search;
    this.search = null;
    this.buffer = s.saved;
    this.cursor = this.buffer.length;
    this.render();
  }

  // ---------- completion ----------
  async _complete() {
    if (!this.o.onComplete) return;
    const line = this.buffer, cur = this.cursor;
    let r;
    try { r = await this.o.onComplete(line, cur); } catch { r = null; }
    if (!r || this.buffer !== line || this.cursor !== cur) return;
    const matches = [...new Set(r.matches || [])];
    if (!matches.length) { this.o.onBell && this.o.onBell(); return; }
    const word = line.slice(r.start, r.end);
    if (matches.length === 1) {
      const m = matches[0];
      const add = /[/=]$/.test(m) ? '' : ' ';
      this.buffer = line.slice(0, r.start) + m + add + line.slice(r.end);
      this.cursor = r.start + m.length + add.length;
      this.render();
      return;
    }
    let lcp = matches[0];
    for (const m of matches) { let i = 0; while (i < lcp.length && i < m.length && lcp[i] === m[i]) i++; lcp = lcp.slice(0, i); }
    if (lcp.length > word.length) {
      this.buffer = line.slice(0, r.start) + lcp + line.slice(r.end);
      this.cursor = r.start + lcp.length;
      this.render();
      this.lastTab = 0;
      return;
    }
    const now = Date.now();
    if (now - this.lastTab < 900) {
      // second Tab: list candidates in columns, like bash
      this.echoCommand(this.buffer);
      this._printColumns(matches.map(m => m.replace(/.*\/(?=.)/, '')));
      this.render();
      this.lastTab = 0;
    } else {
      this.lastTab = now;
      this.o.onBell && this.o.onBell();
    }
  }

  _printColumns(items) {
    const width = Math.max(20, this._cols());
    const w = Math.max(...items.map(s => s.length)) + 2;
    const per = Math.max(1, Math.floor(width / w));
    const rows = Math.ceil(items.length / per);
    const lines = [];
    for (let r = 0; r < rows; r++) {
      let l = '';
      for (let c = 0; c < per; c++) { const it = items[c * rows + r]; if (it !== undefined) l += it.padEnd(w); }
      lines.push(l.trimEnd());
    }
    this.print(lines.join('\n'));
  }

  _cols() {
    const probe = this.cursorEl.getBoundingClientRect().width || 9;
    return Math.floor((this.scroller.clientWidth - 24) / probe);
  }

  // ---------- submit ----------
  async _submit() {
    if (this.search) { this._searchAccept(); }
    const full = [...this.pending, this.buffer].join('\n');
    if (full.trim() && this.o.isIncomplete) {
      let inc = false;
      try { inc = await this.o.isIncomplete(full); } catch { inc = false; }
      if (inc) {
        this.pending.push(this.buffer);
        this.buffer = ''; this.cursor = 0;
        this.render();
        this.scrollToBottom();
        return;
      }
    }
    const promptSegs = this._promptSegs();
    this.pending = [];
    this.buffer = ''; this.cursor = 0; this.hIndex = null; this.draft = '';
    this._forceScroll = true;
    this.echoCommand(full, promptSegs);
    if (full.trim() && this.history[this.history.length - 1] !== full) {
      this.history.push(full);
      if (this.history.length > 500) this.history.shift();
    }
    this.render();
    this.setBusy(true);
    try { await (this.o.onSubmit && this.o.onSubmit(full)); }
    catch (e) { this.print(String(e && e.message || e), 'term-err'); }
    finally {
      this._forceScroll = false;
      this.setBusy(false);
      this.render();
      this.scrollToBottom();
      if (document.activeElement === document.body || this.el.contains(document.activeElement)) this.focus();
    }
  }

  _interrupt() {
    if (this.search) { this._searchCancel(); }
    const text = [...this.pending, this.buffer].join('\n');
    this.echoCommand(text + '^C');
    this.pending = []; this.buffer = ''; this.cursor = 0; this.hIndex = null;
    this.render();
    this.scrollToBottom();
  }

  // ---------- key handling ----------
  _handleKey(e) {
    if (this.o.onKey && this.o.onKey(e)) { e.preventDefault(); return; }
    if (!this.enabled || this.busy) {
      if (e.key.length === 1 || ['Enter', 'Backspace', 'Tab'].includes(e.key)) e.preventDefault();
      return;
    }
    const k = e.key;
    const ctrl = e.ctrlKey && !e.metaKey;
    const meta = e.altKey || (e.metaKey && false);
    const code = e.code || '';

    // ----- reverse search mode -----
    if (this.search) {
      if (k === 'Enter') { e.preventDefault(); this._searchAccept(); this._submit(); return; }
      if ((ctrl && (k === 'r' || k === 'R'))) { e.preventDefault(); this._searchFind(true); this.render(); return; }
      if ((ctrl && (k === 'g' || k === 'c')) || k === 'Escape') { e.preventDefault(); this._searchCancel(); return; }
      if (k === 'Backspace') { e.preventDefault(); this.search.query = this.search.query.slice(0, -1); this.search.at = this.history.length; this._searchFind(); this.render(); return; }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'Tab'].includes(k) || (ctrl && 'aefb'.includes(k))) { e.preventDefault(); this._searchAccept(); return; }
      if (k.length === 1 && !ctrl && !e.metaKey) { e.preventDefault(); this.search.query += k; this._searchFind(); this.render(); this.o.onType && this.o.onType(); return; }
      return;
    }

    // ----- control keys -----
    if (ctrl) {
      const key = k.toLowerCase();
      const handled = {
        a: () => { this.cursor = 0; },
        e: () => { this.cursor = this.buffer.length; },
        b: () => { this.cursor = Math.max(0, this.cursor - 1); },
        f: () => { this.cursor = Math.min(this.buffer.length, this.cursor + 1); },
        u: () => { this._killRange(0, this.cursor); },
        k: () => { this._killRange(this.cursor, this.buffer.length); },
        w: () => { let i = this.cursor; while (i > 0 && this.buffer[i - 1] === ' ') i--; while (i > 0 && this.buffer[i - 1] !== ' ') i--; this._killRange(i, this.cursor); },
        y: () => { if (this.kill) this._insert(this.kill); },
        h: () => { if (this.cursor > 0) { this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor); this.cursor--; } },
        d: () => {
          if (!this.buffer && !this.pending.length) { this.o.onEOF && this.o.onEOF(); return; }
          this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
        },
        t: () => {
          const b = this.buffer; let c = this.cursor;
          if (b.length < 2 || c === 0) return;
          if (c === b.length) c--;
          this.buffer = b.slice(0, c - 1) + b[c] + b[c - 1] + b.slice(c + 1);
          this.cursor = Math.min(b.length, c + 1);
        },
        l: () => { this.clear(); },
        c: () => {
          const sel = window.getSelection && String(window.getSelection());
          if (sel) return 'pass'; // let the browser copy the selection
          this._interrupt();
        },
        r: () => { this._searchStart(); },
        p: () => { this._historyMove(-1); },
        n: () => { this._historyMove(1); },
        arrowleft: () => { this.cursor = this._wordLeft(this.cursor); },
        arrowright: () => { this.cursor = this._wordRight(this.cursor); },
        backspace: () => { this._killRange(this._wordLeft(this.cursor), this.cursor); },
      }[key];
      if (handled) {
        if (handled() === 'pass') return;
        e.preventDefault();
        this.render();
        return;
      }
      if (key === 'v') return; // paste event handles it
      if (key.length === 1) { e.preventDefault(); return; }
    }

    // ----- meta (Alt / Option) word commands -----
    if (meta && !e.ctrlKey) {
      const m = { KeyB: () => { this.cursor = this._wordLeft(this.cursor); }, KeyF: () => { this.cursor = this._wordRight(this.cursor); }, KeyD: () => { this._killRange(this.cursor, this._wordRight(this.cursor)); } }[code];
      if (m) { e.preventDefault(); m(); this.render(); return; }
      if (k === 'ArrowLeft') { e.preventDefault(); this.cursor = this._wordLeft(this.cursor); this.render(); return; }
      if (k === 'ArrowRight') { e.preventDefault(); this.cursor = this._wordRight(this.cursor); this.render(); return; }
      if (k === 'Backspace') { e.preventDefault(); this._killRange(this._wordLeft(this.cursor), this.cursor); this.render(); return; }
    }

    switch (k) {
      case 'Enter':
        e.preventDefault();
        if (e.shiftKey) { this._insert('\n'); return; }
        this._submit();
        return;
      case 'Backspace':
        e.preventDefault();
        if (e.metaKey) { this._killRange(0, this.cursor); this.render(); return; }
        if (this.cursor > 0) { this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor); this.cursor--; this.render(); }
        else if (!this.buffer && this.pending.length) { this.buffer = this.pending.pop(); this.cursor = this.buffer.length; this.render(); }
        this.o.onType && this.o.onType();
        return;
      case 'Delete':
        e.preventDefault();
        this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
        this.render();
        return;
      case 'ArrowLeft': e.preventDefault(); if (e.metaKey) this.cursor = 0; else this.cursor = Math.max(0, this.cursor - 1); this.render(); return;
      case 'ArrowRight': e.preventDefault(); if (e.metaKey) this.cursor = this.buffer.length; else this.cursor = Math.min(this.buffer.length, this.cursor + 1); this.render(); return;
      case 'Home': e.preventDefault(); this.cursor = 0; this.render(); return;
      case 'End': e.preventDefault(); this.cursor = this.buffer.length; this.render(); return;
      case 'ArrowUp': e.preventDefault(); this._historyMove(-1); return;
      case 'ArrowDown': e.preventDefault(); this._historyMove(1); return;
      case 'Tab': e.preventDefault(); this._complete(); return;
      case 'Escape': return;
      default: break;
    }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey) {
      // Printable character (desktop path). Alt+char inserts the composed char.
      e.preventDefault();
      if (!this._burstOk(1)) return;
      this._insert(k);
      this.o.onType && this.o.onType();
    }
  }

  /** Detect superhuman bursts (auto-typers) when paste is forbidden. */
  _burstOk(n) {
    if (!this.o.pasteGuard) return true;
    const now = performance.now();
    this.burst.push([now, n]);
    while (this.burst.length && now - this.burst[0][0] > 80) this.burst.shift();
    const chars = this.burst.reduce((a, b) => a + b[1], 0);
    if (chars >= 10) {
      const msg = this.o.pasteGuard('burst');
      if (msg) { this.burst = []; this._blocked(msg); return false; }
    }
    return true;
  }

  _blocked(msg) {
    this.o.onBell && this.o.onBell('error');
    this.el.classList.remove('shake'); void this.el.offsetWidth; this.el.classList.add('shake');
    this.print(msg, 'term-warn');
  }

  _bind() {
    const inp = this.input;
    const onKeyDown = (e) => {
      if (e.isComposing || e.keyCode === 229) return; // IME / soft keyboards: handled in input events
      this._handleKey(e);
    };
    const onBeforeInput = (e) => {
      if (/^insertFrom(Paste|Drop|Yank)/.test(e.inputType) && this.o.pasteGuard) {
        const msg = this.o.pasteGuard('paste');
        if (msg) { e.preventDefault(); this._blocked(msg); }
      }
    };
    const onInput = (e) => {
      if (this.composing) return;
      const v = inp.value;
      inp.value = '';
      if (!v) return;
      if (!this.enabled || this.busy) return;
      if (v.length > 1 && this.o.pasteGuard && e.inputType !== 'insertCompositionText') {
        const msg = this.o.pasteGuard('burst');
        if (msg) { this._blocked(msg); return; }
      }
      if (v === '\n') { this._submit(); return; }
      if (this.search) { this.search.query += v; this._searchFind(); this.render(); return; }
      if (!this._burstOk(v.length)) return;
      this._insert(v.replace(/\n$/, ''));
      if (/\n$/.test(v) && v.length > 1) { /* pasted text ending in newline: keep as continuation */ }
      this.o.onType && this.o.onType();
    };
    const onCompStart = () => { this.composing = true; };
    const onCompEnd = (e) => {
      this.composing = false;
      const v = e.data || inp.value;
      inp.value = '';
      if (v && this.enabled && !this.busy) { this._insert(v); this.o.onType && this.o.onType(); }
    };
    const onPaste = (e) => {
      e.preventDefault();
      if (this.o.pasteGuard) {
        const msg = this.o.pasteGuard('paste');
        if (msg) { this._blocked(msg); return; }
      }
      if (!this.enabled || this.busy) return;
      const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
      if (this.search) this._searchAccept();
      this._insert(text.replace(/\t/g, '\t'));
    };
    const onDrop = (e) => {
      e.preventDefault();
      if (this.o.pasteGuard) { const msg = this.o.pasteGuard('drop'); if (msg) { this._blocked(msg); return; } }
      const text = e.dataTransfer?.getData('text') || '';
      if (text) this._insert(text);
    };
    const onDragOver = (e) => { e.preventDefault(); };
    const onFocus = () => this.el.classList.add('focused');
    const onBlur = () => this.el.classList.remove('focused');
    const onMouseUp = (e) => {
      if (e.button !== 0) return;
      const sel = window.getSelection && String(window.getSelection());
      if (!sel) this.focus();
    };
    const onScroll = () => this._positionInput();
    inp.addEventListener('keydown', onKeyDown);
    inp.addEventListener('beforeinput', onBeforeInput);
    inp.addEventListener('input', onInput);
    inp.addEventListener('compositionstart', onCompStart);
    inp.addEventListener('compositionend', onCompEnd);
    inp.addEventListener('paste', onPaste);
    inp.addEventListener('focus', onFocus);
    inp.addEventListener('blur', onBlur);
    this.el.addEventListener('drop', onDrop);
    this.el.addEventListener('dragover', onDragOver);
    this.el.addEventListener('mouseup', onMouseUp);
    this.scroller.addEventListener('scroll', onScroll, { passive: true });
    this._unbind = () => {
      inp.removeEventListener('keydown', onKeyDown);
      inp.removeEventListener('beforeinput', onBeforeInput);
      inp.removeEventListener('input', onInput);
      inp.removeEventListener('compositionstart', onCompStart);
      inp.removeEventListener('compositionend', onCompEnd);
      inp.removeEventListener('paste', onPaste);
      this.el.removeEventListener('drop', onDrop);
      this.el.removeEventListener('dragover', onDragOver);
      this.el.removeEventListener('mouseup', onMouseUp);
    };
  }
}
