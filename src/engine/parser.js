// Bash parser: source text (byte string) -> AST.
// Recursive descent directly over characters, modelled on bash's grammar.

export class ParseError extends Error {
  constructor(msg, opts = {}) {
    super(msg);
    this.incomplete = !!opts.incomplete;   // more input could fix it (unclosed quote, missing done, ...)
    this.token = opts.token;
    this.line = opts.line;
    if (opts.near !== undefined) this.near = opts.near;     // [[ ]] errors: "syntax error near `X'" follows
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.dash) this.dash = true;     // already in dash's words
  }
}

const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'case', 'esac', 'while', 'until', 'for', 'in', 'function', 'select', 'time', '{', '}', '!', '[[', ']]', 'coproc']);
const META = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
// dash: its reserved words (parsekwd[]), and the special builtins that can't name a function
export const DASH_KEYWORDS = new Set(['!', 'case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'if', 'in', 'then', 'until', 'while', '{', '}']);
const DASH_END = ['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}'];   // reserved words that end a dash list
const DASH_SPECIAL = new Set(['break', 'continue', '.', 'eval', 'exec', 'exit', 'export', 'readonly', 'local', 'return', 'set', 'shift', 'times', 'trap', ':', 'unset']);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isName(s) { return NAME_RE.test(s); }

// Decode a $'...' ANSI-C quoted string body.
export function decodeAnsiC(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) { out += c; continue; }
    const d = s[++i];
    switch (d) {
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'e': case 'E': out += '\x1b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case '?': out += '?'; break;
      case 'c': { const e = s[++i]; if (e !== undefined) out += String.fromCharCode(e.charCodeAt(0) & 31); break; }
      case 'x': {
        let h = '';
        while (h.length < 2 && /[0-9a-fA-F]/.test(s[i + 1] || '')) h += s[++i];
        if (h) out += String.fromCharCode(parseInt(h, 16)); else out += '\\x';
        break;
      }
      case 'u': case 'U': {
        const max = d === 'u' ? 4 : 8;
        let h = '';
        while (h.length < max && /[0-9a-fA-F]/.test(s[i + 1] || '')) h += s[++i];
        if (!h) { out += '\\' + d; break; }
        const cp = parseInt(h, 16);
        // encode code point as UTF-8 bytes
        const str = String.fromCodePoint(cp);
        const u8 = new TextEncoder().encode(str);
        for (const b of u8) out += String.fromCharCode(b);
        break;
      }
      default:
        if (d >= '0' && d <= '7') {
          let o = d;
          while (o.length < 3 && /[0-7]/.test(s[i + 1] || '')) o += s[++i];
          out += String.fromCharCode(parseInt(o, 8) & 255);
        } else out += '\\' + d;
    }
  }
  return out;
}

export class Parser {
  constructor(src, opts = {}) {
    this.s = src;
    this.i = 0;
    this.line = opts.line || 1;   // eval'd text is numbered from the line the eval is on
    this.line0 = this.line;
    this.heredocs = [];       // pending heredocs awaiting their body
    this.opens = [];          // start offsets of quotes/expansions being read (for EOF error lines)
    this.wordDepth = 0;       // readWord() nesting, and the deferred $( ) errors waiting for their word's end
    this.synerrs = [];
    this.extglob = opts.extglob !== false;
    this.posix = !!opts.posix;   // dash: [[ ]] and $'...' are not special
  }

  get eof() { return this.i >= this.s.length; }
  peek(o = 0) { return this.s[this.i + o]; }
  startsWith(t) { return this.s.startsWith(t, this.i); }

  // `at`: source offset the error belongs to (bash reports EOF-in-quote errors at the line the quote opened)
  err(msg, incomplete = false, at = null) {
    if (at === null && msg.startsWith('unexpected EOF while looking for') && this.opens.length) at = this.opens[this.opens.length - 1];
    throw new ParseError(msg, { incomplete, line: at === null ? this.line : this.lineAt(at) });
  }
  lineAt(idx) { let n = this.line0; for (let k = 0; k < idx && k < this.s.length; k++) if (this.s.charCodeAt(k) === 10) n++; return n; }
  unexpected(tok) {
    if (tok === undefined || tok === null) this.err('syntax error: unexpected end of file', true);
    throw new ParseError(`syntax error near unexpected token \`${tok}'`, { token: tok, line: this.line });
  }
  // dash: a list cut short by a token that ends lists leaves its construct complaining
  dashExpecting(terms) { return terms.includes(';;') ? ';;' : terms.filter(t => !t.startsWith(';')).pop(); }
  dashExpect(tok, terms) {
    throw new ParseError(`Syntax error: "${tok}" unexpected (expecting "${this.dashExpecting(terms)}")`, { line: this.line, dash: true });
  }
  atDashEnd() { const o = this.operator(); return o === ')' || o === ';;' || DASH_END.some(w => this.atReserved(w)); }
  // dash's synexpect(): the next token, named the way its tokname[] does (it has read a
  // newline token by then, so the line count has moved past it)
  dashUnexpected(expecting = null, kw = false) {
    this.skipBlanks();
    let line = this.line, name;
    if (this.eof) name = 'end of file';
    else if (this.s[this.i] === '\n') { name = 'newline'; line++; }
    else {
      const o = this.operator();
      if (!o) { const t = kw ? this.peekWordText() : null; name = t !== null && DASH_KEYWORDS.has(t) ? `"${t}"` : 'word'; }
      else if (/^[<>]/.test(o)) name = 'redirection';
      else name = `"${o === '|&' ? '|' : /^&>/.test(o) ? '&' : o}"`;
    }
    throw new ParseError(`Syntax error: ${name} unexpected${expecting ? ` (expecting "${expecting}")` : ''}`, { line, dash: true });
  }

  // ---------- low level ----------
  skipBlanks() {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t') { this.i++; continue; }
      if (c === '\\' && this.s[this.i + 1] === '\n') { this.i += 2; this.line++; continue; }
      if (c === '#') {
        // comment: only at token start (caller guarantees we are between tokens)
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
        continue;
      }
      break;
    }
  }

  // Consume one newline and read any pending heredoc bodies.
  consumeNewline() {
    if (this.s[this.i] !== '\n') return false;
    this.i++;
    this.line++;
    if (this.heredocs.length) this.readHeredocBodies();
    return true;
  }

  skipNewlines() {
    for (;;) {
      this.skipBlanks();
      if (!this.consumeNewline()) break;
    }
  }

  readHeredocBodies() {
    const docs = this.heredocs;
    this.heredocs = [];
    for (const h of docs) {
      let body = '';
      let found = false;
      while (this.i < this.s.length) {
        let j = this.s.indexOf('\n', this.i);
        const lineEnd = j < 0 ? this.s.length : j;
        let line = this.s.slice(this.i, lineEnd);
        this.i = j < 0 ? this.s.length : j + 1;
        this.line++;
        let cmp = line;
        if (h.strip) cmp = cmp.replace(/^\t+/, '');
        if (cmp === h.delim) { found = true; break; }
        body += (h.strip ? line.replace(/^\t+/, '') : line) + '\n';
      }
      h.body = body;
      h.terminated = found;
      if (!found) { h.eofWarning = true; this.unterminatedHeredoc = true; (this.warnings ||= []).push(`here-document at line ${h.line} delimited by end-of-file (wanted \`${h.delim}')`); }
    }
  }

  // Operator at the current position (no blank skipping).
  operator() {
    const s = this.s, i = this.i;
    const c = s[i];
    if (c === undefined) return null;
    const three = s.slice(i, i + 3), two = s.slice(i, i + 2);
    if (this.posix) {
      if (three === '<<-') return three;
      if (['&&', '||', ';;', '<<', '>>', '<&', '>&', '<>', '>|'].includes(two)) return two;
    } else {
      if (three === ';;&' || three === '<<<' || three === '<<-' || three === '&>>') return three;
      if (['&&', '||', ';;', ';&', '|&', '<<', '>>', '<&', '>&', '<>', '>|', '&>'].includes(two)) return two;
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '<' || c === '>' || c === '\n') return c;
    return null;
  }

  // ---------- program structure ----------
  // Parse the next complete top-level command (up to and including a newline).
  // Returns null at end of input.
  parseNext() {
    for (;;) {
      this.skipBlanks();
      if (this.eof) return null;
      if (this.consumeNewline()) continue;
      break;
    }
    const items = [];
    for (;;) {
      this.skipBlanks();
      if (this.eof) break;
      const op = this.operator();
      if (op === '\n') { this.consumeNewline(); break; }
      if (op && op !== '(' && op !== '<' && op !== '>' && op !== '<<' && op !== '<<<' && op !== '<<-' && op !== '>>' && op !== '<&' && op !== '>&' && op !== '<>' && op !== '>|' && op !== '&>' && op !== '&>>') this.unexpected(op);
      const cmd = this.parseAndOr();
      this.skipBlanks();
      const sep = this.operator();
      let bg = false;
      if (sep === ';') this.i++;
      else if (sep === '&') { this.i++; bg = true; }
      items.push({ cmd, bg });
      this.skipBlanks();
      if (this.eof) break;
      if (this.operator() === '\n') { this.consumeNewline(); break; }
      if (sep !== ';' && sep !== '&') this.unexpected(this.operator() || this.peekWordText());
    }
    if (this.heredocs.length) this.readHeredocBodies();
    return { t: 'list', items };
  }

  // dash reads `...` with list(2): it stops at the first token that ends lists (even before
  // any command) or after a command not followed by a separator, and drops what's left
  parseDashBackquote() {
    const items = [];
    for (;;) {
      this.skipNewlines();
      if (this.eof || this.atDashEnd()) break;
      const op = this.operator();
      if (op && [';', '&', '|', '&&', '||'].includes(op)) this.unexpected(op);
      const cmd = this.parseAndOr();
      this.skipBlanks();
      const sep = this.operator();
      let bg = false;
      if (sep === ';') this.i++;
      else if (sep === '&') { this.i++; bg = true; }
      else if (sep === '\n') this.consumeNewline();
      items.push({ cmd, bg });
      if (sep !== ';' && sep !== '&' && sep !== '\n') break;
    }
    if (this.heredocs.length) this.readHeredocBodies();
    return { t: 'list', items };
  }

  parseAll() {
    const items = [];
    for (;;) {
      const l = this.parseNext();
      if (!l) break;
      items.push(...l.items);
    }
    return { t: 'list', items };
  }

  peekWordText() {
    const save = this.i;
    try {
      const w = this.readWord('normal');
      return w ? wordText(w) : null;
    } catch { return null; } finally { this.i = save; }
  }

  // Is the next token the reserved word `w` (at command position)?
  atReserved(w) {
    const save = this.i, saveLine = this.line;
    this.skipBlanks();
    const s = this.s;
    let ok = s.startsWith(w, this.i);
    if (ok) {
      const n = s[this.i + w.length];
      ok = n === undefined || META.has(n);
    }
    this.i = save; this.line = saveLine;
    return ok;
  }

  expectReserved(w) {
    this.skipNewlines();
    if (!this.atReserved(w)) {
      if (this.posix) this.dashUnexpected(w, true);
      if (this.eof) { try { this.err('syntax error: unexpected end of file', true); } catch (e) { e.expecting = w; throw e; } }
      const t = this.peekWordText() || this.operator();
      this.unexpected(t);
    }
    this.skipBlanks();
    this.i += w.length;
  }

  // EOF inside a compound command; dash names the keyword it was waiting for
  eofExpecting(terms) {
    try { this.err('syntax error: unexpected end of file', true); }
    catch (e) { e.expecting = this.dashExpecting(terms); throw e; }
  }

  // A compound list terminated by one of the reserved words in `terms` (not consumed).
  // list2: dash's list(2) (a $( ) or case item), which a token ending lists stops at once
  parseCompoundList(terms, list2 = false) {
    const items = [];
    // bash needs at least one command in a list (case items excepted)
    const end = (tok) => { if (!items.length && !terms.includes(';;')) { this.skipBlanks(); this.unexpected(tok); } };
    for (;;) {
      this.skipNewlines();
      if (this.eof) this.eofExpecting(terms);
      const term = terms.find(t => (t.length > 1 && t.startsWith(';')) ? this.startsWith(t) : this.atReserved(t));
      if (term) { end(term); break; }
      const op = this.operator();
      if (op === ')' && terms.includes(')')) { end(')'); break; }
      // dash: after a command (in a case item, at once) a token that ends lists ends this one
      if (this.posix && (items.length || list2 || terms.includes(';;')) && op !== ';;' && this.atDashEnd()) { this.skipBlanks(); this.dashExpect(op || this.peekWordText(), terms); }
      if (op === ';;' || op === ';&' || op === ';;&') { if (terms.includes(';;')) break; if (this.posix && items.length) this.dashExpect(op, terms); this.unexpected(op); }
      if (op && [';', '&', '|', '&&', '||', ')', ';;', '|&'].includes(op)) this.unexpected(op);
      const cmd = this.parseAndOr();
      this.skipBlanks();
      const sep = this.operator();
      let bg = false;
      if (sep === ';') this.i++;
      else if (sep === '&') { this.i++; bg = true; }
      else if (sep === '\n') this.consumeNewline();
      items.push({ cmd, bg });
      if (!sep || (sep !== ';' && sep !== '&' && sep !== '\n')) {
        // must be at a terminator now
        this.skipBlanks();
        if (this.eof) this.eofExpecting(terms);
        const o = this.operator();
        if (o === ')' && terms.includes(')')) break;
        if ((o === ';;' || o === ';&' || o === ';;&') && terms.includes(';;')) break;
        if (terms.some(t => t.length && !t.startsWith(';') && this.atReserved(t))) break;
        if (this.posix && this.atDashEnd()) { this.skipBlanks(); this.dashExpect(o || this.peekWordText(), terms); }
        this.unexpected(o || this.peekWordText());
      }
    }
    return { t: 'list', items };
  }

  parseAndOr() {
    const parts = [this.parsePipeline()];
    const ops = [];
    for (;;) {
      this.skipBlanks();
      const op = this.operator();
      if (op !== '&&' && op !== '||') break;
      this.i += 2;
      this.skipNewlines();
      ops.push(op);
      parts.push(this.parsePipeline());
    }
    return parts.length === 1 ? parts[0] : { t: 'andor', parts, ops };
  }

  parsePipeline() {
    this.skipBlanks();
    let negate = false, timed = false, timeP = false;
    for (;;) {
      if (!this.posix && this.atReserved('time') && !timed) {
        this.skipBlanks(); this.i += 4; timed = true; this.skipBlanks();
        if (this.startsWith('-p') && (META.has(this.s[this.i + 2]) || this.s[this.i + 2] === undefined)) { this.i += 2; timeP = true; }
        continue;
      }
      if (this.atReserved('!') && !(this.posix && negate)) { this.skipBlanks(); this.i += 1; negate = !negate; continue; }
      break;
    }
    const cmds = [this.parseCommand()];
    const stderr = [];
    for (;;) {
      this.skipBlanks();
      const op = this.operator();
      if (op !== '|' && op !== '|&') break;
      this.i += op.length;
      this.skipNewlines();
      stderr.push(op === '|&');
      cmds.push(this.parseCommand());
    }
    if (cmds.length === 1 && !negate && !timed) return cmds[0];
    return { t: 'pipe', cmds, negate, timed, timeP, stderr };
  }

  parseCommand() {
    this.skipBlanks();
    if (this.eof) this.err('syntax error: unexpected end of file', true);
    const op = this.operator();
    let cmd;
    if (op === '(') {
      if (this.s[this.i + 1] === '(' && !this.posix) {
        const save = this.i;
        const a = this.tryArithCommand();
        if (a) cmd = a; else { this.i = save; }
        // bash's parse_arith_cmd() first matches the parens, whatever (( turns out to be
        if (!a && this.scanMatched(this.i + 2, '(', ')') < 0) this.err("unexpected EOF while looking for matching `)'", true, this.i);
      }
      if (!cmd) {
        this.i++;
        const body = this.parseCompoundList([')']);
        this.skipNewlines();
        if (this.operator() !== ')') this.err('syntax error: unexpected end of file', true);
        this.i++;
        cmd = { t: 'subshell', body };
      }
    } else if (op && op !== '<' && op !== '>' && op !== '<<' && op !== '>>' && op !== '<&' && op !== '>&' && op !== '<>' && op !== '>|' && op !== '&>' && op !== '&>>' && op !== '<<<' && op !== '<<-') {
      if (op === '\n') this.err('syntax error: unexpected end of file', true);
      this.unexpected(op);
    } else if (this.atReserved('{')) {
      this.skipBlanks(); this.i++;
      const body = this.parseCompoundList(['}']);
      this.expectReserved('}');
      cmd = { t: 'group', body };
    } else if (this.atReserved('if')) cmd = this.parseIf();
    else if (this.atReserved('while')) cmd = this.parseWhile(false);
    else if (this.atReserved('until')) cmd = this.parseWhile(true);
    else if (this.atReserved('for')) cmd = this.parseFor();
    else if (!this.posix && this.atReserved('select')) cmd = this.parseFor(true);
    else if (this.atReserved('case')) cmd = this.parseCase();
    else if (!this.posix && this.atReserved('[[')) cmd = this.parseCond();
    else if (!this.posix && this.atReserved('function')) cmd = this.parseFunction(true);
    else {
      for (const w of ['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}', 'in']) {
        if (this.atReserved(w)) { this.skipBlanks(); this.unexpected(w); }
      }
      if (this.posix && this.atReserved('!')) { this.skipBlanks(); this.unexpected('!'); }   // dash: only at a pipeline's start
      // function definition `name () compound`?
      const save = this.i;
      const w = this.readWord('normal');
      const lit = w && w.parts.length === 1 && w.parts[0].t === 'lit';
      if (w && !w.assign && !(lit && /^[A-Za-z_][A-Za-z0-9_]*(\[.*\])?\+?=/.test(w.parts[0].v))) {
        const raw = this.s.slice(save, this.i).replace(/^[ \t]+/, '');
        this.skipBlanks();
        if (this.posix && this.startsWith('(')) return this.dashFunction(w, raw);
        if (!this.posix && this.startsWith('(') && (lit || this.s[this.i + 1] === ')' || /^\(\s*\)/.test(this.s.slice(this.i)))) {
          const save2 = this.i;
          this.i++;
          this.skipBlanks();
          if (this.startsWith(')')) {
            this.i++;
            return this.functionBody(wordText(w), w, raw);
          }
          // bash has committed to a function definition: complain about whatever follows `(`
          if (this.eof || this.s[this.i] === '\n') this.unexpected('newline');
          const op = this.operator();
          if (op) this.unexpected(op);
          const nw = this.readWord('normal');
          this.unexpected(nw ? wordText(nw) : this.s[this.i]);
          this.i = save2;
        }
      }
      this.i = save;
      return this.parseSimple();
    }
    // trailing redirections on compound commands
    const redirs = [];
    for (;;) {
      this.skipBlanks();
      const r = this.tryRedirect();
      if (!r) break;
      redirs.push(r);
    }
    if (redirs.length) cmd.redirs = redirs;
    return cmd;
  }

  tryArithCommand() {
    // at '((' ; find matching '))'
    const start = this.i + 2;
    let depth = 0, j = start;
    const s = this.s;
    while (j < s.length) {
      const c = s[j];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) { if (s[j + 1] === ')') break; return null; }
        depth--;
      } else if (c === '\n' && depth === 0) { /* allowed */ }
      else if (c === '"' || c === "'") { const k = s.indexOf(c, j + 1); if (k < 0) return null; j = k; }
      j++;
    }
    if (j >= s.length) return null;
    const text = s.slice(start, j);
    const line = this.line;
    this.line += (text.match(/\n/g) || []).length;
    this.i = j + 2;
    return { t: 'arith', expr: parseArithWord(text), line, text };
  }

  parseIf() {
    this.skipBlanks(); this.i += 2;
    const clauses = [];
    let elseBody = null;
    const cond = this.parseCompoundList(['then']);
    this.expectReserved('then');
    const body = this.parseCompoundList(['elif', 'else', 'fi']);
    clauses.push({ cond, body });
    for (;;) {
      this.skipNewlines();
      if (this.atReserved('elif')) {
        this.skipBlanks(); this.i += 4;
        const c = this.parseCompoundList(['then']);
        this.expectReserved('then');
        const b = this.parseCompoundList(['elif', 'else', 'fi']);
        clauses.push({ cond: c, body: b });
        continue;
      }
      if (this.atReserved('else')) {
        this.skipBlanks(); this.i += 4;
        elseBody = this.parseCompoundList(['fi']);
      }
      break;
    }
    this.expectReserved('fi');
    return { t: 'if', clauses, else: elseBody };
  }

  parseWhile(until) {
    this.skipBlanks(); this.i += until ? 5 : 5;
    const cond = this.parseCompoundList(['do']);
    this.expectReserved('do');
    const body = this.parseCompoundList(['done']);
    this.expectReserved('done');
    return { t: 'while', cond, body, until };
  }

  parseDoGroup() {
    this.skipNewlines();
    if (!this.posix && this.atReserved('{')) {
      this.skipBlanks(); this.i++;
      const body = this.parseCompoundList(['}']);
      this.expectReserved('}');
      return body;
    }
    this.expectReserved('do');
    const body = this.parseCompoundList(['done']);
    this.expectReserved('done');
    return body;
  }

  parseFor(isSelect = false) {
    this.skipBlanks(); this.i += isSelect ? 6 : 3;
    this.skipBlanks();
    if (!isSelect && !this.posix && this.startsWith('((')) {
      const start = this.i + 2;
      let depth = 0, j = start;
      while (j < this.s.length) {
        const c = this.s[j];
        if (c === '(') depth++;
        else if (c === ')') { if (depth === 0 && this.s[j + 1] === ')') break; depth--; }
        j++;
      }
      if (j >= this.s.length) this.err('syntax error: unexpected end of file', true);
      const text = this.s.slice(start, j);
      this.i = j + 2;
      const parts = splitTopLevel(text, ';');
      if (parts.length !== 3) this.err("syntax error: `;' unexpected");
      this.skipBlanks();
      if (this.operator() === ';') this.i++;
      const body = this.parseDoGroup();
      return { t: 'cfor', init: parseArithWord(parts[0]), cond: parseArithWord(parts[1]), step: parseArithWord(parts[2]), body };
    }
    const nameW = this.readWord('normal');
    if (this.posix && !(nameW && nameW.parts.length === 1 && nameW.parts[0].t === 'lit' && isName(nameW.parts[0].v))) {
      throw new ParseError('Syntax error: Bad for loop variable', { line: this.line, dash: true });
    }
    if (!nameW) this.unexpected(this.operator());
    const name = wordText(nameW);
    this.skipNewlines();
    let words = null;
    if (this.atReserved('in')) {
      this.skipBlanks(); this.i += 2;
      words = [];
      for (;;) {
        this.skipBlanks();
        const op = this.operator();
        if (op === ';' || op === '\n') { if (op === ';') this.i++; else this.consumeNewline(); break; }
        if (op) this.unexpected(op);
        if (this.eof) this.err('syntax error: unexpected end of file', true);
        const w = this.readWord('normal');
        if (!w) break;
        words.push(w);
      }
    } else {
      this.skipBlanks();
      if (this.operator() === ';') this.i++;
    }
    const body = this.parseDoGroup();
    return { t: isSelect ? 'select' : 'for', var: name, words, body };
  }

  parseCase() {
    this.skipBlanks(); this.i += 4;
    this.skipBlanks();
    const word = this.readWord('normal');
    if (!word) this.unexpected(this.operator());
    this.skipNewlines();
    if (!this.atReserved('in')) { if (this.posix) this.dashUnexpected('in', true); this.unexpected(this.peekWordText() || this.operator()); }
    this.skipBlanks(); this.i += 2;
    const items = [];
    for (;;) {
      this.skipNewlines();
      if (this.eof) this.eofExpecting([')']);
      if (this.atReserved('esac')) { this.skipBlanks(); this.i += 4; break; }
      if (this.operator() === '(') this.i++;
      const patterns = [];
      for (;;) {
        this.skipBlanks();
        const w = this.readWord('pattern');
        if (!w) this.unexpected(this.operator() || 'newline');
        patterns.push(w);
        this.skipBlanks();
        const op = this.operator();
        if (op === '|') { this.i++; continue; }
        if (op === ')') { this.i++; break; }
        if (this.posix) this.dashUnexpected(')');
        if (this.eof) this.err('syntax error: unexpected end of file', true);
        this.unexpected(op || this.peekWordText());
      }
      let body = { t: 'list', items: [] };
      this.skipNewlines();
      if (!this.startsWith(';;') && !this.startsWith(';&') && !this.atReserved('esac')) body = this.parseCompoundList([';;', ';&', ';;&', 'esac']);
      this.skipNewlines();
      let term = ';;';
      if (this.startsWith(';;&')) { term = ';;&'; this.i += 3; }
      else if (this.startsWith(';;')) { this.i += 2; }
      else if (this.startsWith(';&')) { term = ';&'; this.i += 2; }
      else if (!this.atReserved('esac')) { if (this.posix) this.dashUnexpected(';;', true); this.err('syntax error: unexpected end of file', true); }
      items.push({ patterns, body, term });
    }
    return { t: 'case', word, items };
  }

  parseFunction() {
    this.skipBlanks(); this.i += 8;
    this.skipBlanks();
    const start = this.i;
    const w = this.readWord('normal');
    if (!w) { const o = this.operator(); this.unexpected(o && o !== '\n' ? o : 'newline'); }
    const name = wordText(w);
    const raw = this.s.slice(start, this.i);
    this.skipBlanks();
    if (this.startsWith('(')) {
      this.i++;
      this.skipBlanks();
      if (!this.startsWith(')')) this.unexpected(this.peek());
      this.i++;
    }
    return this.functionBody(name, w, raw);
  }
  // dash: a lone first word followed by `(` starts a function definition, and its body is any
  // command (`f() echo hi`), not just a compound one
  dashFunction(w, raw) {
    this.i++;
    this.skipBlanks();
    if (!this.startsWith(')')) this.dashUnexpected(')');
    this.i++;
    const name = wordText(w);
    if (!(w.parts.length === 1 && w.parts[0].t === 'lit' && NAME_RE.test(raw)) || DASH_SPECIAL.has(name)) {
      throw new ParseError('Syntax error: Bad function name', { line: this.line, dash: true });
    }
    this.skipNewlines();
    return { t: 'func', name, body: this.parseCommand() };
  }
  // after `name ()`: newlines, then a compound command
  functionBody(name, w, raw) {
    this.skipNewlines();
    if (this.eof) this.err('syntax error: unexpected end of file', true);
    const compound = this.startsWith('(') || ['{', 'if', 'while', 'until', 'for', 'select', 'case', '[['].some(k => this.atReserved(k));
    if (!compound) {
      const o = this.operator();
      if (o) this.unexpected(o === '\n' ? 'newline' : o);
      this.unexpected(this.peekWordText());
    }
    const body = this.parseCommand();
    const node = { t: 'func', name, body };
    // quoted names (or ones with $) are accepted by the parser but refused when defined
    if (w.parts.some(p => p.t !== 'lit')) node.badName = raw;
    return node;
  }

  // [[ ... ]] — bash's mini recursive-descent parser. Errors carry the token bash's yacc parser
  // then reports with "syntax error near `X'".
  parseCond() {
    this.skipBlanks(); this.condOpen = this.i; this.i += 2;
    const line = this.line;
    const expr = this.condOr();
    this.skipCondBlanks();
    if (!this.atCondEnd()) {
      if (this.eof) this.err("unexpected EOF while looking for `]]'", true, this.condOpen);
      const o = this.operator();
      this.condError(o && o !== '\n' ? `syntax error in conditional expression: unexpected token \`${o}'` : 'syntax error in conditional expression', this.condTokenEnd());
    }
    this.i += 2;
    return { t: 'cond', expr, line };
  }
  atCondEnd() { const n = this.s[this.i + 2]; return this.startsWith(']]') && (n === undefined || META.has(n)); }
  // where the token at the current position ends (bash has read it when it reports)
  condTokenEnd() {
    const s = this.s;
    let j = this.i;
    while (s[j] === ' ' || s[j] === '\t') j++;
    if (s[j] === '\n' || s[j] === undefined) return j + 1;
    const o = this.operator();
    if (o && j === this.i) return j + o.length;
    while (j < s.length && !META.has(s[j])) j++;
    return j;
  }
  // bash: the message, then "syntax error near `X'" naming the word before the reading position
  // `at`: where bash's lexer stands (shell_input_line_index); error_token_from_text() looks at
  // the line around it, the newline bash adds to the last line included
  condError(msg, at) {
    const s = this.s;
    const ls = s.lastIndexOf('\n', Math.min(at, s.length) - 2) + 1;
    const le = s.indexOf('\n', ls);
    const lineText = le < 0 ? s.slice(ls) + '\n' : s.slice(ls, le + 1);
    let i = Math.min(at - ls, lineText.length);
    if (i && i === lineText.length) i--;
    while (i && (lineText[i] === ' ' || lineText[i] === '\t' || lineText[i] === '\n')) i--;
    const tokenEnd = i ? i + 1 : 0;
    while (i && !' \n\t;|&'.includes(lineText[i])) i--;
    while (i !== tokenEnd && (lineText[i] === ' ' || lineText[i] === '\t' || lineText[i] === '\n')) i++;
    const near = tokenEnd ? lineText.slice(i, tokenEnd) : lineText[i] || '';
    throw new ParseError(msg ?? '', { line: this.line, near, token: near });
  }
  skipCondBlanks() { for (;;) { this.skipBlanks(); if (this.s[this.i] === '\n') { this.consumeNewline(); continue; } break; } }
  condOr() {
    let l = this.condAnd();
    for (;;) {
      this.skipCondBlanks();
      if (this.startsWith('||')) { this.i += 2; const r = this.condAnd(); l = { t: 'or', l, r }; continue; }
      return l;
    }
  }
  condAnd() {
    let l = this.condTerm();
    for (;;) {
      this.skipCondBlanks();
      if (this.startsWith('&&')) { this.i += 2; const r = this.condTerm(); l = { t: 'and', l, r }; continue; }
      return l;
    }
  }
  // the token after a word inside [[ ]], named the way bash names it (null for a word: bash
  // has no text for those here)
  condTokenName() {
    if (this.eof || this.s[this.i] === '\n') return 'newline';
    if (this.atCondEnd()) return ']]';
    return this.operator();
  }
  condTerm() {
    this.skipCondBlanks();
    if (this.eof) this.err("unexpected EOF while looking for `]]'", true, this.condOpen);
    if (this.atCondEnd()) this.condError(null, this.i + 2);
    if (this.startsWith('(')) {
      this.i++;
      const e = this.condOr();
      this.skipCondBlanks();
      if (!this.startsWith(')')) {
        if (this.eof) this.err("unexpected EOF while looking for `]]'", true, this.condOpen);
        const t = this.condTokenName();
        this.condError(t ? `unexpected token \`${t}', expected \`)'` : "expected `)'", this.condTokenEnd());
      }
      this.i++;
      return e;
    }
    if (this.startsWith('!') && (META.has(this.s[this.i + 1]) || this.s[this.i + 1] === undefined)) { this.i++; return { t: 'not', e: this.condTerm() }; }
    const w1 = this.readWord('cond');
    if (!w1) {
      const o = this.operator();
      this.condError(`unexpected token \`${o}' in conditional command`, this.condTokenEnd());
    }
    const t1 = w1.parts.length === 1 && w1.parts[0].t === 'lit' ? w1.parts[0].v : null;
    this.skipBlanks();
    if (t1 && /^-[abcdefghknoprstuvwxzGLNOSR]$/.test(t1)) {
      const w2 = this.atCondEnd() ? null : this.readWord('cond');
      if (!w2) { const t = this.condTokenName(); this.condError(t ? `unexpected argument \`${t}' to conditional unary operator` : 'unexpected argument to conditional unary operator', this.condTokenEnd()); }
      return { t: 'unary', op: t1, w: w2 };
    }
    const op = this.peekCondBinary();
    if (op) {
      this.i += op.length;
      this.skipBlanks();
      const w2 = this.atCondEnd() ? null : op === '=~' ? this.readRegexWord() : this.readWord('cond');
      if (!w2) { const t = this.condTokenName(); this.condError(t ? `unexpected argument \`${t}' to conditional binary operator` : 'unexpected argument to conditional binary operator', this.condTokenEnd()); }
      return { t: 'binary', op, l: w1, r: w2 };
    }
    // [[ word ]] is [[ -n word ]]
    if (this.atCondEnd() || this.startsWith('&&') || this.startsWith('||') || this.startsWith(')')) return { t: 'word', w: w1 };
    const t = this.condTokenName();
    this.condError(t ? `unexpected token \`${t}', conditional binary operator expected` : 'conditional binary operator expected', this.condTokenEnd());
  }
  peekCondBinary() {
    const s = this.s, i = this.i;
    for (const op of ['==', '!=', '=~', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef', '=', '<', '>']) {
      if (s.startsWith(op, i)) {
        const n = s[i + op.length];
        if (n === undefined || n === ' ' || n === '\t' || n === '\n' || ((op === '<' || op === '>') )) return op;
      }
    }
    return null;
  }
  readRegexWord() {
    // RHS of =~ : parentheses and | are part of the regex
    const parts = [];
    let buf = '';
    let depth = 0;
    const flush = () => { if (buf) { parts.push({ t: 'lit', v: buf }); buf = ''; } };
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) break;
      if (depth === 0 && (c === ' ' || c === '\t' || c === '\n')) break;
      if (depth === 0 && (this.startsWith(']]') || this.startsWith('&&') || this.startsWith('||'))) break;
      if (c === '(') { depth++; buf += c; this.i++; continue; }
      if (c === ')') { if (depth === 0) break; depth--; buf += c; this.i++; continue; }
      if (c === '\\') { flush(); parts.push({ t: 'esc', v: this.s[this.i + 1] || '' }); this.i += 2; continue; }
      if (c === "'") { flush(); const j = this.s.indexOf("'", this.i + 1); if (j < 0) this.err("unexpected EOF while looking for matching `''", true, this.i); parts.push({ t: 'sq', v: this.s.slice(this.i + 1, j) }); this.i = j + 1; continue; }
      if (c === '"') { flush(); parts.push(this.readDouble()); continue; }
      if (c === '$') { flush(); parts.push(this.readDollar()); continue; }
      buf += c; this.i++;
    }
    flush();
    return parts.length ? { parts } : null;
  }

  parseSimple() {
    const assigns = [], words = [], redirs = [];
    for (;;) {
      this.skipBlanks();
      if (this.eof) break;
      const r = this.tryRedirect();
      if (r) { redirs.push(r); continue; }
      const op = this.operator();
      const procSub = (op === '<' || op === '>') && this.s[this.i + 1] === '(';
      if (op && !procSub) break;
      const w = this.readWord(words.length === 0 ? 'assign' : (words.length && isDeclCmd(words[0]) ? 'assign' : 'normal'), words.length === 0);
      if (!w) break;
      if (words.length === 0 && w.assign) assigns.push(w.assign);
      else if (words.length && w.assign && isDeclCmd(words[0])) words.push(w);
      else words.push(w.assign ? assignToWord(w) : w);
    }
    if (!assigns.length && !words.length && !redirs.length) {
      const op = this.operator();
      if (this.eof) this.err('syntax error: unexpected end of file', true);
      this.unexpected(op || 'newline');
    }
    return { t: 'simple', assigns, words, redirs, line: this.line };
  }

  tryRedirect() {
    const s = this.s;
    let j = this.i;
    let fd = null;
    let m = /^[0-9]+/.exec(s.slice(j, j + 10));
    if (m && (s[j + m[0].length] === '<' || s[j + m[0].length] === '>')) { fd = parseInt(m[0], 10); j += m[0].length; }
    else if (s[j] === '{') {
      const mm = /^\{([A-Za-z_][A-Za-z0-9_]*)\}(?=[<>])/.exec(s.slice(j, j + 80));
      if (mm) { fd = { varName: mm[1] }; j += mm[0].length; }
    }
    const save = this.i;
    this.i = j;
    const op = this.operator();
    if (!op || !['<', '>', '>>', '<<', '<<-', '<<<', '<&', '>&', '<>', '>|', '&>', '&>>'].includes(op)) { this.i = save; return null; }
    if ((op === '<' || op === '>') && s[this.i + 1] === '(') { this.i = save; return null; } // process substitution
    this.i += op.length;
    this.skipBlanks();
    if (op === '<<' || op === '<<-') {
      const w = this.readWord('normal');
      if (!w) {
        if (this.posix) this.dashUnexpected();
        const o = this.operator();
        this.unexpected(o && o !== '\n' ? o : 'newline');
      }
      const quoted = w.parts.some(p => p.t !== 'lit');
      const delim = wordLiteral(w);
      const h = { delim, strip: op === '<<-', quoted, body: null, line: this.line };
      this.heredocs.push(h);
      return { fd, op, heredoc: h };
    }
    const w = this.readWord('normal');
    if (!w) {
      if (this.posix) this.dashUnexpected();
      const o = this.operator();
      this.unexpected(o && o !== '\n' ? o : 'newline');
    }
    return { fd, op, target: w };
  }

  // ---------- words ----------
  // ctx: 'normal' | 'assign' | 'pattern' (case) | 'cond' ([[ ]]); cmdPos: where bash would take
  // `name[` for the start of an array element assignment
  readWord(ctx, cmdPos = false) {
    this.wordDepth++;
    try { return this._readWord(ctx, cmdPos); }
    finally {
      // a deferred $( ) error shows its line up to the end of the word that holds it
      if (--this.wordDepth === 0 && this.synerrs.length) {
        for (const e of this.synerrs) { const nl = this.s.indexOf('\n', e.lineStart); e.text = this.s.slice(e.lineStart, Math.min(nl < 0 ? this.s.length : nl, Math.max(this.i, e.end))); }
        this.synerrs = [];
      }
    }
  }
  _readWord(ctx, cmdPos) {
    const s = this.s;
    const parts = [];
    let buf = '';
    const start = this.i;
    const flush = () => { if (buf) { parts.push({ t: 'lit', v: buf }); buf = ''; } };
    let assign = null;
    for (;;) {
      const c = s[this.i];
      if (c === undefined) break;
      if (ctx === 'cond') {
        if (c === ' ' || c === '\t' || c === '\n') break;
        if (this.startsWith('&&') || this.startsWith('||')) break;
        if (c === '(' && /[?*+@!]$/.test(buf)) { buf += this.readBalancedParens(); continue; }
        if (c === '(' || c === ')' || c === '<' || c === '>' || c === ';' || c === '&' || c === '|') break;
        if (buf === '' && parts.length === 0 && this.startsWith(']]')) break;
      } else if (META.has(c)) {
        if (c === '(' && this.extglob && /[?*+@!]$/.test(buf)) {
          buf += this.readBalancedParens();
          continue;
        }
        if (ctx === 'assign' && !this.posix && c === '(' && parts.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(buf)) {
          // array assignment name=( ... )
          const mm = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=$/.exec(buf);
          this.i++;
          const a0 = this.i;
          const elems = this.readArrayElems();
          return { parts: [{ t: 'lit', v: buf }], assign: { name: mm[1], index: null, append: mm[3] === '+', array: elems, arrayText: s.slice(a0, this.i - 1) } };
        }
        if ((c === '<' || c === '>') && s[this.i + 1] === '(' && buf === '' && parts.length === 0) {
          this.i += 2;
          const body = this.parseCompoundList([')']);
          this.skipNewlines();
          if (s[this.i] !== ')') this.err('syntax error: unexpected end of file', true);
          this.i++;
          parts.push({ t: 'proc', dir: c, body });
          continue;
        }
        break;
      }
      if (c === '\\') {
        const d = s[this.i + 1];
        if (d === '\n') { this.i += 2; this.line++; continue; }
        if (d === undefined) { buf += '\\'; this.i++; continue; }
        flush();
        parts.push({ t: 'esc', v: d });
        this.i += 2;
        continue;
      }
      if (c === "'") {
        flush();
        const j = s.indexOf("'", this.i + 1);
        if (j < 0) this.err("unexpected EOF while looking for matching `''", true, this.i);
        const v = s.slice(this.i + 1, j);
        this.line += countNl(v);
        parts.push({ t: 'sq', v });
        this.i = j + 1;
        continue;
      }
      if (c === '"') { flush(); parts.push(this.readDouble()); continue; }
      // bash reads `name[...]` at a command's start as an array subscript, up to its `]`
      if (c === '[' && cmdPos && !this.posix && !parts.length && isName(buf) && this.scanMatched(this.i + 1, '[', ']') < 0) {
        this.err("unexpected EOF while looking for matching `]'", true, this.i);
      }
      if (c === '$') {
        const n = s[this.i + 1];
        if (n === "'" && !this.posix) {
          flush();
          let j = this.i + 2, body = '';
          while (j < s.length && s[j] !== "'") { if (s[j] === '\\' && j + 1 < s.length) { body += s[j] + s[j + 1]; j += 2; } else body += s[j++]; }
          if (j >= s.length) this.err("unexpected EOF while looking for matching `''", true, this.i);
          parts.push({ t: 'ansi', v: decodeAnsiC(body) });
          this.i = j + 1;
          continue;
        }
        if (n === '"') { if (this.posix) { buf += '$'; this.i++; continue; } flush(); this.i++; parts.push(this.readDouble()); continue; }
        const p = this.readDollar();
        if (p.t === 'lit') { buf += p.v; continue; }
        flush(); parts.push(p); continue;
      }
      if (c === '`') { flush(); parts.push(this.readBackquote()); continue; }
      if (c === '~' && this.i === start && ctx !== 'cond_') {
        // tilde prefix
        let j = this.i + 1;
        while (j < s.length && /[A-Za-z0-9_.+-]/.test(s[j])) j++;
        const nxt = s[j];
        if (nxt === undefined || nxt === '/' || META.has(nxt) || (ctx === 'pattern' && (nxt === '|' || nxt === ')'))) {
          parts.push({ t: 'tilde', user: s.slice(this.i + 1, j) });
          this.i = j;
          continue;
        }
      }
      if (ctx === 'pattern' && (c === '|' || c === ')')) break;
      if (c === '=' && ctx === 'assign' && !this.posix && !assign && parts.length === 0 && s[this.i + 1] === '(' && /^[A-Za-z_][A-Za-z0-9_]*\+?$/.test(buf)) {
        const mm = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)$/.exec(buf);
        this.i += 2;
        const a0 = this.i;
        const elems = this.readArrayElems();
        return { parts: [{ t: 'lit', v: buf + '=' }], assign: { name: mm[1], index: null, append: mm[2] === '+', array: elems, arrayText: s.slice(a0, this.i - 1) } };
      }
      if (c === '=' && ctx === 'assign' && !assign && parts.length === 0) {
        const mm = /^([A-Za-z_][A-Za-z0-9_]*)(\[.*\])?(\+?)$/s.exec(buf);
        if (mm) {
          // assignment word: name[index]=value
          const name = mm[1];
          const indexText = mm[2] ? mm[2].slice(1, -1) : null;
          this.i++;
          const vstart = this.i;
          const val = this.readWord('assignval');
          const valueWord = val || { parts: [] };
          return { parts: [{ t: 'lit', v: buf + '=' }, ...valueWord.parts], assign: { name, index: indexText !== null ? parseArithWord(indexText) : null, indexText, append: mm[3] === '+', value: valueWord }, _vstart: vstart };
        }
      }
      if (c === '[' && ctx === 'assign' && parts.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(buf)) {
        // array subscript in assignment: read up to matching ]
        let depth = 0, j = this.i;
        for (; j < s.length; j++) {
          if (s[j] === '[') depth++;
          else if (s[j] === ']') { depth--; if (depth === 0) break; }
          else if (s[j] === '\n') break;
        }
        if (s[j] === ']' && (s[j + 1] === '=' || (s[j + 1] === '+' && s[j + 2] === '='))) {
          buf += s.slice(this.i, j + 1);
          this.i = j + 1;
          continue;
        }
      }
      buf += c;
      this.i++;
    }
    flush();
    if (this.i === start) return null;
    return { parts };
  }

  readBalancedParens() {
    // at '(' ; returns the text including parens (for extglob patterns)
    const s = this.s;
    let depth = 0, j = this.i, out = '';
    for (; j < s.length; j++) {
      const c = s[j];
      out += c;
      if (c === '\\') { out += s[++j] || ''; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { j++; break; } }
    }
    this.i = j;
    return out;
  }

  readArrayElems() {
    // after '(' of name=( ... )
    const elems = [];
    // bash reads the list as one word: errors inside it make the shell return 1, and running out
    // of input is reported on its own
    try {
    for (;;) {
      this.skipBlanks();
      if (this.s[this.i] === '\n') { this.consumeNewline(); continue; }
      if (this.eof) throw new ParseError("unexpected EOF while looking for matching `)'", { incomplete: true, line: this.line, status: 1 });
      if (this.s[this.i] === ')') { this.i++; break; }
      // [key]=value or [key]+=value ?
      const close = this.s[this.i] === '[' ? this.subscriptEnd(this.i) : -1;
      const op = close < 0 ? null : this.s[close + 1] === '=' ? '=' : this.s.startsWith('+=', close + 1) ? '+=' : null;
      if (op) {
        const keyText = this.s.slice(this.i + 1, close);
        this.i = close + 1 + op.length;
        const v = this.readWord('assignval') || { parts: [] };
        elems.push({ key: parseSubscript(keyText), keyText, value: v, ...(op === '+=' && { appendElem: true }) });
        continue;
      }
      const w = this.readWord('normal');
      if (!w) this.unexpected(this.operator());
      elems.push({ value: w });
    }
    } catch (e) { if (e instanceof ParseError && e.status === undefined) e.status = 1; throw e; }
    return elems;
  }

  // bash's skipsubscript: index of the ']' closing the '[' at i (quotes, escapes, nested brackets
  // and $( ) / ${ } skipped), or -1 when an unquoted blank or metacharacter ends the word first
  subscriptEnd(i, blanksOk = false) {
    const s = this.s;
    let depth = 0;
    const skipQ = (j, q) => { for (j++; j < s.length && s[j] !== q; j++) if (s[j] === '\\' && q !== "'") j++; return j < s.length ? j : -1; };
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      if (c === "'" || c === '"' || c === '`') { j = skipQ(j, c); if (j < 0) return -1; continue; }
      if (c === '$' && s[j + 1] === "'") { j = skipQ(j + 1, "'"); if (j < 0) return -1; continue; }
      if (c === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) {
        const open = s[j + 1], shut = open === '(' ? ')' : '}';
        let d = 0, k = j + 1;
        for (; k < s.length; k++) { if (s[k] === open) d++; else if (s[k] === shut && --d === 0) break; }
        if (k >= s.length) return -1;
        j = k;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') { if (--depth === 0) return j; }
      else if (!blanksOk && META.has(c)) return -1;
    }
    return -1;
  }

  readDouble() { this.opens.push(this.i); try { return this._readDouble(); } finally { this.opens.pop(); } }
  _readDouble() {
    // at '"'
    const s = this.s;
    this.i++;
    const parts = [];
    let buf = '';
    const flush = () => { if (buf) { parts.push({ t: 'text', v: buf }); buf = ''; } };
    for (;;) {
      const c = s[this.i];
      if (c === undefined) this.err('unexpected EOF while looking for matching `"\'', true);
      if (c === '"') { this.i++; break; }
      if (c === '\\') {
        const d = s[this.i + 1];
        if (d === '\n') { this.i += 2; this.line++; continue; }
        if (d === '$' || d === '`' || d === '"' || d === '\\') { buf += d; this.i += 2; continue; }
        buf += '\\'; this.i++; continue;
      }
      if (c === '$') {
        const p = this.readDollar(true);
        if (p.t === 'lit') { buf += p.v; continue; }
        flush(); parts.push(p); continue;
      }
      if (c === '`') { flush(); parts.push(this.readBackquote()); continue; }
      if (c === '\n') this.line++;
      buf += c; this.i++;
    }
    flush();
    return { t: 'dq', parts };
  }

  readBackquote() { this.opens.push(this.i); try { return this._readBackquote(); } finally { this.opens.pop(); } }
  _readBackquote() {
    const s = this.s;
    let j = this.i + 1, body = '';
    while (j < s.length && s[j] !== '`') {
      if (s[j] === '\\' && (s[j + 1] === '$' || s[j + 1] === '`' || s[j + 1] === '\\')) { body += s[j + 1]; j += 2; continue; }
      body += s[j++];
    }
    if (j >= s.length) this.err('unexpected EOF while looking for matching ``\'', true);
    this.line += countNl(s.slice(this.i, j));
    this.i = j + 1;
    const sub = new Parser(body, { extglob: this.extglob, posix: this.posix });
    let list;
    try { list = this.posix ? sub.parseDashBackquote() : sub.parseAll(); }
    catch (e) {
      // bash parses `...` only when it runs it, in the subshell: a syntax error there just
      // fails that command substitution
      if (!(e instanceof ParseError) || this.posix) throw e;
      return { t: 'cmd', body: { t: 'list', items: [] }, bq: true, bqerr: { src: body, base: this.line } };
    }
    return { t: 'cmd', body: list, bq: true };
  }

  // At '$'. Returns a part ({t:'lit', v:'$'} when not an expansion).
  readDollar(inDq = false) { this.opens.push(this.i); try { return this._readDollar(inDq); } finally { this.opens.pop(); } }
  _readDollar(inDq = false) {
    const s = this.s;
    const n = s[this.i + 1];
    if (n === '(') {
      if (s[this.i + 2] === '(') {
        // arithmetic $(( ... )) unless it is really $( (...) )
        const r = this.tryArithExpansion();
        if (r) return r;
        if (!this.posix && this.scanMatched(this.i + 2, '(', ')') < 0) this.err('unexpected EOF while looking for matching `)\'', true);
      }
      this.i += 2;
      // nothing but blanks, newlines and comments: an empty command
      if (s[this.scanBlankLines(this.i)] === ')') {
        this.skipNewlines();
        this.i++;
        return { t: 'cmd', body: { t: 'list', items: [] }, bq: false };
      }
      const contentStart = this.i, startLine = this.line, saveHd = this.heredocs.length;
      let body;
      try { body = this.parseCompoundList([')'], true); }
      catch (e) {
        if (e instanceof ParseError && e.message === 'syntax error: unexpected end of file') this.err('unexpected EOF while looking for matching `)\'', true);
        if (!(e instanceof ParseError) || this.posix || e.incomplete) throw e;
        this.heredocs.length = saveHd;
        return this.deferredComsubError(e, contentStart, startLine);
      }
      this.skipNewlines();
      if (s[this.i] !== ')') this.err('unexpected EOF while looking for matching `)\'', true);
      this.i++;
      return { t: 'cmd', body, bq: false };
    }
    if (n === '[') {
      // deprecated $[ expr ]
      let depth = 0, j = this.i + 1;
      for (; j < s.length; j++) { if (s[j] === '[') depth++; else if (s[j] === ']') { depth--; if (!depth) break; } }
      const text = s.slice(this.i + 2, j);
      this.i = j + 1;
      return { t: 'arith', expr: parseArithWord(text) };
    }
    if (n === '{') return this.readBraceParam();
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      let j = this.i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      const name = s.slice(this.i + 1, j);
      this.i = j;
      return { t: 'param', name };
    }
    if (n !== undefined && /[0-9]/.test(n)) { this.i += 2; return { t: 'param', name: n }; }
    if (n !== undefined && '@*#?-$!_'.includes(n)) { this.i += 2; return { t: 'param', name: n }; }
    this.i++;
    return { t: 'lit', v: '$' };
  }

  // where blanks, comments and newlines starting at j run out
  scanBlankLines(j) {
    const s = this.s;
    for (;;) {
      if (s[j] === ' ' || s[j] === '\t' || s[j] === '\n') j++;
      else if (s[j] === '\\' && s[j + 1] === '\n') j += 2;
      else if (s[j] === '#') { while (j < s.length && s[j] !== '\n') j++; }
      else return j;
    }
  }
  // bash's parse_matched_pair(): from just inside an `open`, the index past its `close`
  // (skipping quotes and nested expansions), or -1 at EOF
  scanMatched(j, open, close) {
    const s = this.s;
    let count = 1;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') { j += 2; continue; }
      if (c === close) { if (--count === 0) return j + 1; j++; continue; }
      if (c === open) { count++; j++; continue; }
      if (c === "'" || c === '"' || c === '`') { j = this.scanQuote(j); if (j < 0) return -1; continue; }
      if (c === '$' && s[j + 1] === "'") { j = this.scanQuote(j + 1, true); if (j < 0) return -1; continue; }
      if (c === '$' && s[j + 1] === '(') { j = this.scanComsub(j + 2); if (j < 0) return -1; continue; }
      if (c === '$' && s[j + 1] === '{') { j = this.scanMatched(j + 2, '{', '}'); if (j < 0) return -1; continue; }
      j++;
    }
    return -1;
  }
  // at a quote: the index past its closing one, or -1
  scanQuote(j, ansi = false) {
    const s = this.s, q = s[j];
    for (j++; j < s.length; j++) {
      const c = s[j];
      if (c === q) return j + 1;
      if (c === '\\' && (q !== "'" || ansi)) { j++; continue; }
      if (q === '"' && c === '$' && s[j + 1] === '(') { j = this.scanComsub(j + 2); if (j < 0) return -1; j--; continue; }
      if (q === '"' && c === '$' && s[j + 1] === '{') { j = this.scanMatched(j + 2, '{', '}'); if (j < 0) return -1; j--; continue; }
      if (q === '"' && c === '`') { j = this.scanQuote(j); if (j < 0) return -1; j--; continue; }
    }
    return -1;
  }
  // bash 5.1's parse_comsub(), which only scans a $( ) for its end: quotes, comments and
  // nested parens count, and so does case ... esac (whose patterns' `)` don't). From just
  // inside the `$(`, the index past its `)`, or -1 at EOF.
  scanComsub(j) {
    const s = this.s;
    if (s[j] === '(') return this.scanMatched(j, '(', ')');
    let count = 1, inCase = false, cmdPos = true;
    while (j < s.length) {
      const c = s[j];
      if (c === ' ' || c === '\t') { j++; continue; }
      if (c === '\n' || c === ';' || c === '&' || c === '|') { cmdPos = true; j++; continue; }
      if (c === '#') { while (j < s.length && s[j] !== '\n') j++; continue; }
      if (c === ')' && !inCase) { if (--count === 0) return j + 1; cmdPos = true; j++; continue; }
      if (c === '(' && !inCase) { count++; cmdPos = true; j++; continue; }
      if (c === '(' || c === ')' || c === '<' || c === '>') { j++; continue; }
      // a word
      const w0 = j;
      while (j < s.length && !' \t\n;&|()<>'.includes(s[j])) {
        const d = s[j];
        if (d === '\\') j += 2;
        else if (d === "'" || d === '"' || d === '`') { j = this.scanQuote(j); if (j < 0) return -1; }
        else if (d === '$' && s[j + 1] === "'") { j = this.scanQuote(j + 1, true); if (j < 0) return -1; }
        else if (d === '$' && s[j + 1] === '(') { j = this.scanComsub(j + 2); if (j < 0) return -1; }
        else if (d === '$' && s[j + 1] === '{') { j = this.scanMatched(j + 2, '{', '}'); if (j < 0) return -1; }
        else j++;
      }
      const w = s.slice(w0, j);
      if (cmdPos && w === 'case') inCase = true;
      else if (cmdPos && w === 'esac') inCase = false;
      cmdPos = ['then', 'do', 'else', 'elif', 'time', '!', '{', 'if', 'while', 'until'].includes(w) && cmdPos;
    }
    return -1;
  }
  // bash 5.1 finds a $( )'s end by scanning, and parses its contents only when expanding it: a
  // syntax error there is reported then ("command substitution: line N"), and abandons the
  // command being run
  deferredComsubError(e, contentStart, startLine) {
    const end = this.scanComsub(contentStart);
    if (end < 0) this.err('unexpected EOF while looking for matching `)\'', true);
    const errLine = e.line ?? startLine;
    // bash numbers it from the line the $( ) ends on
    const line = this.lineAt(end - 1) + (errLine - startLine) + 1;
    let lineStart = contentStart;
    for (let k = startLine; k < errLine; k++) lineStart = this.s.indexOf('\n', lineStart) + 1;
    const msgs = e.near !== undefined ? [...(e.message ? [e.message] : []), `syntax error near \`${e.near}'`] : [e.message];
    const nl = this.s.indexOf('\n', lineStart);
    const synerr = { msgs, line, lineStart, end, text: e.token !== undefined ? this.s.slice(lineStart, Math.min(nl < 0 ? this.s.length : nl, end)) : null };
    if (synerr.text !== null) this.synerrs.push(synerr);
    this.line = this.lineAt(end);
    this.i = end;
    return { t: 'cmd', body: { t: 'list', items: [] }, bq: false, synerr };
  }

  tryArithExpansion() {
    const s = this.s;
    const start = this.i + 3;
    let depth = 0, j = start;
    while (j < s.length) {
      const c = s[j];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) { if (s[j + 1] === ')') break; return null; }
        depth--;
      } else if (c === "'" ) { const k = s.indexOf("'", j + 1); if (k < 0) return null; j = k; }
      else if (c === '"') { const k = s.indexOf('"', j + 1); if (k < 0) return null; j = k; }
      j++;
    }
    if (j >= s.length) this.err('unexpected EOF while looking for matching `)\'', true);
    const text = s.slice(start, j);
    this.i = j + 2;
    return { t: 'arith', expr: parseArithWord(text) };
  }

  readBraceParam() { this.opens.push(this.i); try { return this._readBraceParam(); } finally { this.opens.pop(); } }
  _readBraceParam() {
    // at '${'
    const s = this.s;
    this.i += 2;
    const p = { t: 'param', name: '', op: null };
    let c = s[this.i];
    if (c === '#' && s[this.i + 1] !== '}') {
      // ${#name} length
      const save = this.i;
      this.i++;
      const nm = this.readParamName();
      if (nm && s[this.i] === '}') { this.i++; p.name = nm.name; p.index = nm.index; p.op = 'len'; return p; }
      if (nm && s[this.i] === '[') { /* handled by readParamName */ }
      this.i = save;
    }
    if (c === '!' && s[this.i + 1] !== '}') {
      const save = this.i;
      this.i++;
      const nm = this.readParamName();
      if (nm) {
        if (s[this.i] === '}' ) { this.i++; if (nm.index === '@' || nm.index === '*') { p.name = nm.name; p.op = 'keys'; p.index = nm.index; return p; } p.name = nm.name; p.index = nm.index; p.indirect = true; return p; }
        if ((s[this.i] === '*' || s[this.i] === '@') && s[this.i + 1] === '}') { p.name = nm.name; p.op = 'names'; p.star = s[this.i] === '*'; this.i += 2; return p; }
        p.name = nm.name; p.index = nm.index; p.indirect = true;
      } else this.i = save;
    }
    if (!p.name) {
      const nm = this.readParamName();
      if (!nm) {
        // bad substitution: consume to }
        const j = s.indexOf('}', this.i);
        if (j < 0) this.err('unexpected EOF while looking for matching `}\'', true);
        const text = s.slice(this.i - 2, j < 0 ? s.length : j + 1);
        this.i = j < 0 ? s.length : j + 1;
        return { t: 'badsubst', text };
      }
      p.name = nm.name; p.index = nm.index;
    }
    c = s[this.i];
    if (c === '}') { this.i++; return p; }
    // operators
    const two = s.slice(this.i, this.i + 2);
    let op = null;
    if ([':-', ':=', ':?', ':+'].includes(two)) op = two;
    else if (two === '##' || two === '%%' || two === '//' || two === '^^' || two === ',,') op = two;
    else if (two === '/#' || two === '/%') op = two;
    else if ('-=?+#%/^,:@'.includes(c)) op = c;
    if (!op) {
      const j = s.indexOf('}', this.i);
      if (j < 0) this.err('unexpected EOF while looking for matching `}\'', true);
      const text = s.slice(this.i, j < 0 ? s.length : j);
      this.i = j < 0 ? s.length : j + 1;
      return { t: 'badsubst', text: '${' + p.name + text + '}' };
    }
    this.i += op.length;
    p.op = op;
    if (op === ':') {
      // substring ${v:off[:len]}
      const offText = this.readUntilParamDelim([':', '}']);
      if (offText === '' && s[this.i] === '}') { this.i++; return { t: 'badsubst', text: '${' + p.name + ':}' }; }
      p.off = parseArithWord(offText);
      if (s[this.i] === ':') { this.i++; const lenText = this.readUntilParamDelim(['}']); p.len = parseArithWord(lenText); }
      if (s[this.i] !== '}') this.err('unexpected EOF while looking for matching `}\'', true);
      this.i++;
      return p;
    }
    if (op === '@') {
      p.arg = s[this.i];
      this.i++;
      if (s[this.i] !== '}') { const j = s.indexOf('}', this.i); this.i = j < 0 ? s.length : j + 1; return { t: 'badsubst', text: '${' + p.name + '@...}' }; }
      this.i++;
      return p;
    }
    if (op === '/' || op === '//' || op === '/#' || op === '/%') {
      p.arg = this.readParamWord(['/', '}']);
      if (s[this.i] === '/') { this.i++; p.arg2 = this.readParamWord(['}']); }
      else p.arg2 = null;
    } else {
      p.arg = this.readParamWord(['}']);
    }
    if (s[this.i] !== '}') this.err('unexpected EOF while looking for matching `}\'', true);
    this.i++;
    return p;
  }

  readParamName() {
    const s = this.s;
    let m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?\-$!_])/.exec(s.slice(this.i, this.i + 256));
    if (!m) return null;
    let name = m[1];
    this.i += name.length;
    let index = null;
    if (s[this.i] === '[' && /^[A-Za-z_]/.test(name)) {
      let j = this.subscriptEnd(this.i, true);
      if (j < 0) { let depth = 0; for (j = this.i; j < s.length; j++) { if (s[j] === '[') depth++; else if (s[j] === ']') { depth--; if (!depth) break; } } }
      const it = s.slice(this.i + 1, j);
      this.i = j + 1;
      index = it === '@' || it === '*' ? it : parseArithWordRaw(it);
    }
    return { name, index };
  }

  readUntilParamDelim(delims) {
    const s = this.s;
    let depth = 0, out = '';
    while (this.i < s.length) {
      const c = s[this.i];
      if (depth === 0 && delims.includes(c)) break;
      if (c === '(' || c === '{' || c === '[') depth++;
      if (c === ')' || c === '}' || c === ']') { if (depth === 0) break; depth--; }
      out += c; this.i++;
    }
    return out;
  }

  // Word inside ${...} operator argument: quotes and expansions allowed, ends at a delimiter.
  readParamWord(delims, untilEnd = false) {
    const s = this.s;
    const parts = [];
    let buf = '';
    const flush = () => { if (buf) { parts.push({ t: 'lit', v: buf }); buf = ''; } };
    let depth = 0;
    for (;;) {
      const c = s[this.i];
      if (c === undefined) { if (untilEnd) break; this.err('unexpected EOF while looking for matching `}\'', true); }
      if (depth === 0 && delims.includes(c)) break;
      if (c === '}' && depth > 0) { depth--; buf += c; this.i++; continue; }
      if (c === '{') { depth++; buf += c; this.i++; continue; }
      if (c === '\\') { flush(); parts.push({ t: 'esc', v: s[this.i + 1] }); this.i += 2; continue; }
      if (c === "'") {
        flush();
        const j = s.indexOf("'", this.i + 1);
        if (j < 0) this.err("unexpected EOF while looking for matching `''", true, this.i);
        parts.push({ t: 'sq', v: s.slice(this.i + 1, j) });
        this.i = j + 1; continue;
      }
      if (c === '"') { flush(); parts.push(this.readDouble()); continue; }
      if (c === '$') {
        if (s[this.i + 1] === "'") {
          flush();
          let j = this.i + 2, body = '';
          while (j < s.length && s[j] !== "'") { if (s[j] === '\\') { body += s[j] + s[j + 1]; j += 2; } else body += s[j++]; }
          parts.push({ t: 'ansi', v: decodeAnsiC(body) });
          this.i = j + 1; continue;
        }
        const p = this.readDollar();
        if (p.t === 'lit') { buf += p.v; continue; }
        flush(); parts.push(p); continue;
      }
      if (c === '`') { flush(); parts.push(this.readBackquote()); continue; }
      buf += c; this.i++;
    }
    flush();
    return { parts };
  }
}

function countNl(s) { let n = 0; for (const c of s) if (c === '\n') n++; return n; }

function isDeclCmd(w) {
  const t = w.parts.length === 1 && w.parts[0].t === 'lit' ? w.parts[0].v : null;
  return t === 'declare' || t === 'typeset' || t === 'local' || t === 'export' || t === 'readonly';
}

function assignToWord(w) { return { parts: w.parts }; }

export function wordText(w) {
  return w.parts.map(p => p.t === 'lit' ? p.v : p.t === 'sq' ? p.v : p.t === 'esc' ? p.v : p.t === 'dq' ? p.parts.map(x => x.v || '').join('') : '').join('');
}

// Literal value of a word after quote removal (no expansions), e.g. heredoc delimiters.
export function wordLiteral(w) {
  let out = '';
  for (const p of w.parts) {
    if (p.t === 'lit' || p.t === 'sq' || p.t === 'esc' || p.t === 'ansi') out += p.v;
    else if (p.t === 'dq') out += p.parts.map(x => x.t === 'text' ? x.v : '$' + (x.name || '')).join('');
    else if (p.t === 'param') out += '$' + p.name;
    else if (p.t === 'tilde') out += '~' + p.user;
  }
  return out;
}

export function splitTopLevel(text, sep) {
  const out = [];
  let depth = 0, cur = '';
  for (const c of text) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Arithmetic text is parsed as a double-quote-like word (expansions allowed, no splitting).
export function parseArithWord(text) {
  const p = new Parser(text);
  const parts = [];
  let buf = '';
  const flush = () => { if (buf) { parts.push({ t: 'text', v: buf }); buf = ''; } };
  while (p.i < text.length) {
    const c = text[p.i];
    if (c === '$') {
      const r = p.readDollar(true);
      if (r.t === 'lit') { buf += r.v; continue; }
      flush(); parts.push(r); continue;
    }
    if (c === '`') { flush(); parts.push(p.readBackquote()); continue; }
    if (c === '"') { p.i++; continue; }      // quotes are removed in arithmetic context
    if (c === "'") { buf += c; p.i++; continue; }
    if (c === '\\' && text[p.i + 1] === '\n') { p.i += 2; continue; }
    buf += c; p.i++;
  }
  flush();
  return { parts: [{ t: 'dq', parts }], text };
}
function parseArithWordRaw(text) { return parseArithWord(text); }

// Parse an associative-array subscript (or any text) as a word with quotes and expansions.
export function parseSubscript(text) {
  const p = new Parser(text);
  try { return p.readParamWord([], true); } catch { return { parts: [{ t: 'lit', v: text }] }; }
}
