// grep / egrep / fgrep / rgrep (GNU grep 3.7 behaviour)
import { parseArgs, qf, getopt, inputIsOutput } from './util.js';
import { FsError, joinPath, byteCmp } from '../vfs.js';
import { posixToJs, pcreToJs, escapeRe, fnmatch, longestExtender, allMatches, posixRegexError } from '../pattern.js';

const C = {};
const COL = { match: '\x1b[01;31m\x1b[K', end: '\x1b[m\x1b[K', fn: '\x1b[35m\x1b[K', ln: '\x1b[32m\x1b[K', se: '\x1b[36m\x1b[K' };

function buildRegex(patterns, kind, { icase, word, line }) {
  const srcs = [];
  let flags = '';
  for (const p of patterns) {
    let s;
    if (kind === 'F') s = escapeRe(p);
    else if (kind === 'P') { const r = pcreToJs(p); s = r.src; if (r.flags.includes('i')) icase = true; }
    else {
      validatePosix(p, kind === 'E');
      s = posixToJs(p, { extended: kind === 'E' });
    }
    if (word) s = `(?<![A-Za-z0-9_])(?:${s})(?![A-Za-z0-9_])`;
    if (line) s = `^(?:${s})$`;
    srcs.push(s);
  }
  const src = srcs.length === 1 ? srcs[0] : srcs.map(s => `(?:${s})`).join('|');
  flags = (kind === 'P' ? '' : 's') + (icase ? 'i' : '');
  return new RegExp(src, flags + 'g');
}

class GrepErr extends Error {}
function validatePosix(p, ere) {
  const e = posixRegexError(p, { extended: ere });
  if (e) throw new GrepErr(e);
}

function grepImpl(ctx, defaults = {}) {
  // -u is accepted (with a warning) before any option error is reported
  const GSPEC_SHORT = 'A:aB:bC:cD:d:EFGe:f:HhiIyLlm:noPqRrsTUuVvwxZz0123456789';
  {
    const pre = getopt(ctx.argv.slice(1), { short: GSPEC_SHORT, long: { 'unix-byte-offsets': 'u' }, name: 'grep' });
    for (const [k] of pre.opts) if (k === 'u') ctx.stderr.write('grep: warning: --unix-byte-offsets (-u) is obsolete\n');
  }
  const a = parseArgs(ctx, {
    short: GSPEC_SHORT,
    long: {
      'after-context': ['A', 'required'], text: 'a', 'before-context': ['B', 'required'], 'byte-offset': 'b', context: ['C', 'required'], count: 'c', devices: ['D', 'required'], directories: ['d', 'required'],
      'extended-regexp': 'E', 'fixed-strings': 'F', 'basic-regexp': 'G', regexp: ['e', 'required'], file: ['f', 'required'], 'with-filename': 'H', 'no-filename': 'h', 'ignore-case': 'i', 'no-ignore-case': 'noi',
      'files-without-match': 'L', 'files-with-matches': 'l', 'max-count': ['m', 'required'], 'line-number': 'n', 'only-matching': 'o', 'perl-regexp': 'P', quiet: 'q', silent: 'q',
      'dereference-recursive': 'R', recursive: 'r', 'no-messages': 's', 'initial-tab': 'T', binary: 'U', version: 'V', 'invert-match': 'v', 'word-regexp': 'w', 'line-regexp': 'x', null: 'Z', 'null-data': 'z',
      color: ['color', 'optional'], colour: ['color', 'optional'], include: ['include', 'required'], exclude: ['exclude', 'required'], 'exclude-dir': ['excludedir', 'required'], 'exclude-from': ['exclfrom', 'required'],
      'unix-byte-offsets': 'u', 'binary-files': ['binfiles', 'required'], label: ['label', 'required'], 'line-buffered': 'lb', 'group-separator': ['gsep', 'required'], 'no-group-separator': 'nogsep', help: 'help',
    },
    usageText: "Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n",
  });
  if (!a) return 2;
  let kind = defaults.kind || 'G';
  let icase = false, invert = false, word = false, line = false, count = false, listMatch = false, listNon = false, onlyMatching = false, quiet = false;
  let lineNum = false, byteOff = false, withName = null, recursive = defaults.recursive || false, deref = false, noMsg = false, maxCount = Infinity;
  let after = -1, before = -1, color = false, nullName = false, nullData = false, binMode = 'binary', initialTab = false, dirMode = 'read';
  let gsep = '--';
  const patterns = [];
  let patSet = false;
  const includes = [], excludes = [], exdirs = [];
  let ctxNum = '';
  let matcher = defaults.kind || null;
  const setMatcher = (m) => { if (matcher !== null && matcher !== m) { ctx.err('conflicting matchers specified'); return false; } matcher = m; kind = m; return true; };
  for (const [k, v] of a.all) {
    if (/^[0-9]$/.test(k)) { ctxNum += k; after = before = parseInt(ctxNum, 10); continue; }
    ctxNum = '';
    switch (k) {
      case 'E': case 'F': case 'G': case 'P': if (!setMatcher(k)) return 2; break;
      case 'e': patterns.push(...v.split('\n')); patSet = true; break;
      case 'f': {
        try { const d = ctx.readFile(v); const ls = d.split('\n'); if (ls[ls.length - 1] === '') ls.pop(); patterns.push(...ls); patSet = true; }
        catch (e) { ctx.err(`${v}: ${e.message}`); return 2; }
        break;
      }
      case 'i': case 'y': icase = true; break;
      case 'noi': icase = false; break;
      case 'v': invert = true; break;
      case 'w': word = true; break;
      case 'x': line = true; break;
      case 'c': count = true; break;
      case 'l': listMatch = true; listNon = false; break;
      case 'L': listNon = true; listMatch = false; break;
      case 'o': onlyMatching = true; break;
      case 'q': quiet = true; break;
      case 'n': lineNum = true; break;
      case 'b': byteOff = true; break;
      case 'H': withName = true; break;
      case 'h': withName = false; break;
      case 'r': recursive = true; break;
      case 'R': recursive = true; deref = true; break;
      case 's': noMsg = true; break;
      case 'm': maxCount = parseInt(v, 10); if (isNaN(maxCount)) { ctx.err('invalid max count'); return 2; } break;
      case 'A': after = parseInt(v, 10); if (isNaN(after)) { ctx.err(`${v}: invalid context length argument`); return 2; } break;
      case 'B': before = parseInt(v, 10); if (isNaN(before)) { ctx.err(`${v}: invalid context length argument`); return 2; } break;
      case 'C': after = before = parseInt(v, 10); if (isNaN(after)) { ctx.err(`${v}: invalid context length argument`); return 2; } break;
      case 'color': color = v === 'always' || v === 'yes' || v === 'force'; break;
      case 'Z': nullName = true; break;
      case 'z': nullData = true; break;
      case 'a': binMode = 'text'; break;
      case 'I': binMode = 'without-match'; break;
      case 'binfiles': binMode = v; break;
      case 'T': initialTab = true; break;
      case 'd': dirMode = v; if (v === 'recurse') recursive = true; break;
      case 'D': break;
      case 'include': includes.push(v); break;
      case 'exclude': excludes.push(v); break;
      case 'excludedir': exdirs.push(v); break;
      case 'gsep': gsep = v; break;
      case 'nogsep': gsep = null; break;
      case 'V': ctx.out('grep (GNU grep) 3.7\n'); return 0;
      case 'help': ctx.out("Usage: grep [OPTION]... PATTERNS [FILE]...\nSearch for PATTERNS in each FILE.\nExample: grep -i 'hello world' menu.h main.c\n"); return 0;
    }
  }
  let operands = a.operands;
  if (!patSet) {
    if (!operands.length) { ctx.stderr.write("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n"); return 2; }
    patterns.push(...operands[0].split('\n'));
    operands = operands.slice(1);
  }
  let re;
  try {
    if (patterns.length === 0) re = /(?!)/g;
    else re = buildRegex(patterns, kind, { icase, word, line });
  } catch (e) {
    if (e instanceof GrepErr) { ctx.err(e.message); return 2; }
    if (kind === 'P') {
      // PCRE's wording
      const m = String(e.message);
      ctx.err(/Unterminated group/.test(m) ? 'missing )' : /Unterminated character class/.test(m) ? 'missing terminating ] for character class' : /Nothing to repeat/.test(m) ? 'nothing to repeat' : /\\ at end of pattern/.test(m) ? '\\ at end of pattern' : 'unmatched parentheses');
      return 2;
    }
    ctx.err('Invalid regular expression');
    return 2;
  }
  const emptyPat = patterns.includes('') && !line && !word;
  const ext = kind === 'P' ? null : longestExtender(re.source, re.flags);
  let implicitDot = false;
  if (!operands.length) { if (recursive) { operands = ['.']; implicitDot = true; } else operands = ['-']; }
  // operands are searched in order, so a missing file's error lands between earlier output and later
  let errors = false;
  const fs = ctx.fs;
  const ctxOn = after >= 0 || before >= 0;
  if (after < 0) after = 0;
  if (before < 0) before = 0;
  const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
  const included = (name, cmdline) => {
    const b = baseOf(name);
    if (includes.length && !includes.some(g => fnmatch(g, b, { extglob: false }) || fnmatch(g, name, { extglob: false }))) return false;
    if (excludes.some(g => fnmatch(g, b, { extglob: false }) || (cmdline && fnmatch(g, name, { extglob: false })))) return false;
    return true;
  };
  let showName = withName;
  if (showName === null) {
    showName = operands.length > 1;
    if (!showName && recursive && operands[0] !== '-') { try { showName = fs.stat(operands[0], ctx.cwd).type === 'd'; } catch { /* reported below */ } }
  }
  const sep = nullData ? '\0' : '\n';
  let anyMatch = false;
  let printedAny = false;
  let searched = 0;
  let out = '';
  const flush = () => { if (out.length) { ctx.out(out); out = ''; } };
  const nameStr = (n) => color ? COL.fn + n + COL.end : n;
  const sepStr = (s) => (color ? COL.se + s + COL.end : s);
  const prefix = (f, lnum, boff, s) => {
    let p = '';
    if (showName) p += nameStr(f.name) + (nullName ? '\0' : sepStr(s));
    // -T pads the numbers to a fixed width (offset_width, 20 columns)
    const num = (v) => (initialTab ? String(v).padStart(f.width || 20) : String(v));
    if (lineNum) p += (color ? COL.ln + num(lnum) + COL.end : num(lnum)) + sepStr(s);
    if (byteOff) p += (color ? COL.ln + num(boff) + COL.end : num(boff)) + sepStr(s);
    if (initialTab && p) p += '\t';
    return p;
  };
  class Done {}
  const search = (f) => {
    searched++;
    let data;
    if (!quiet && !listMatch && !listNon && !count && maxCount > 1 && inputIsOutput(ctx, f.path, { anySize: true })) { flush(); if (!noMsg) ctx.err(`${f.name}: input file is also the output`); errors = true; return; }
    try { data = f.path === '-' ? ctx.stdin.readAll() : ctx.readFile(f.path); }
    catch (e) { if (e instanceof FsError) { flush(); if (!noMsg) ctx.err(`${f.name}: ${e.message}`); errors = true; return; } throw e; }
    // -T pads numbers to the digits of the input's size (20 when it is a pipe)
    f.width = f.path === '-' && !(ctx.stdin && ctx.stdin.name) ? 20 : String(data !== undefined ? data.length : 0).length;
    const binary = binMode !== 'text' && !nullData && data.includes('\0');
    if (binary && binMode === 'without-match') return;
    const lines = data.split(sep);
    if (lines[lines.length - 1] === '' && data.length) lines.pop();
    if (data === '') lines.length = 0;
    let nMatch = 0;
    let lastPrinted = -1;
    let pendingAfter = 0;
    let offsets = null;
    if (byteOff) { offsets = []; let o = 0; for (const l of lines) { offsets.push(o); o += l.length + 1; } }
    let binaryMatched = false;
    const testLine = (l) => { re.lastIndex = 0; const m = emptyPat || re.test(l); return invert ? !m : m; };
    for (let idx = 0; idx < lines.length; idx++) {
      if ((idx & 1023) === 0) ctx.tick();
      const l = lines[idx];
      const matched = testLine(l);
      if (matched) {
        if (nMatch >= maxCount) break;
        nMatch++;
        anyMatch = true;
        if (quiet) throw new Done();
        if (listMatch || listNon) break;
        if (count) continue;
        if (binary) { binaryMatched = true; break; }
        // before context; group separators whenever -A/-B/-C was given
        if (ctxOn) {
          const startCtx = Math.max(lastPrinted + 1, idx - before);
          if (printedAny && gsep !== null && (lastPrinted < 0 || startCtx > lastPrinted + 1)) out += (color ? COL.se + gsep + COL.end : gsep) + '\n';
          for (let k = startCtx; k < idx; k++) out += prefix(f, k + 1, offsets ? offsets[k] : 0, '-') + lines[k] + sep;
        }
        printedAny = true;
        if (onlyMatching) {
          if (!invert) {
            for (const mm of allMatches(re, l, ext)) {
              if (mm.text === '') continue;
              out += prefix(f, idx + 1, offsets ? offsets[idx] + mm.start : 0, ':') + (color ? COL.match + mm.text + COL.end : mm.text) + sep;
            }
          }
        } else {
          let text = l;
          if (color && !invert) {
            let res = '', last = 0;
            for (const mm of allMatches(re, l, ext)) { if (mm.text === '') continue; res += l.slice(last, mm.start) + COL.match + mm.text + COL.end; last = mm.end; }
            text = res + l.slice(last);
          }
          out += prefix(f, idx + 1, offsets ? offsets[idx] : 0, ':') + text + sep;
        }
        lastPrinted = idx;
        pendingAfter = after;
        if (out.length > 65536) flush();
        continue;
      }
      if (pendingAfter > 0 && !count && !listMatch && !listNon && !binary) {
        out += prefix(f, idx + 1, offsets ? offsets[idx] : 0, '-') + l + sep;
        lastPrinted = idx;
        pendingAfter--;
      }
      if (nMatch >= maxCount && pendingAfter === 0) break;
    }
    if (count && !listMatch && !listNon) out += (showName ? nameStr(f.name) + (nullName ? '\0' : sepStr(':')) : '') + nMatch + '\n';
    if (listMatch && nMatch > 0) out += nameStr(f.name) + (nullName ? '\0' : '\n');
    if (listNon && nMatch === 0) out += nameStr(f.name) + (nullName ? '\0' : '\n');
    if (binaryMatched) { flush(); ctx.stderr.write(`${ctx.name}: ${f.name}: binary file matches\n`); }
  };
  const walk = (p, disp) => {
    let names;
    try { names = fs.readdir(p, ctx.cwd); } catch (e) { flush(); if (!noMsg) ctx.err(`${disp}: ${e.message}`); errors = true; return; }
    for (const n of names) {
      const cp = p === '/' ? '/' + n : p + '/' + n;
      const cd = disp === null ? n : (disp.endsWith('/') ? disp + n : disp + '/' + n);
      let node;
      try { node = fs.lstat(cp, ctx.cwd); } catch { continue; }
      if (node.type === 'l') { if (!deref) continue; try { node = fs.stat(cp, ctx.cwd); } catch { continue; } }
      if (node.type === 'd') { if (exdirs.some(g => fnmatch(g, n, { extglob: false }))) continue; walk(cp, cd); continue; }
      if (node.type !== 'f') continue;
      if (!included(cd, false)) continue;
      search({ path: cp, name: cd });
    }
  };
  try {
    for (const op of operands) {
      if (op === '-') { search({ path: '-', name: a.get('label') || '(standard input)' }); continue; }
      let node;
      try { node = fs.stat(op, ctx.cwd); } catch (e) { flush(); if (!noMsg) ctx.err(`${op}: ${e.message || 'No such file or directory'}`); errors = true; continue; }
      if (node.type === 'd') {
        if (recursive) {
          if (exdirs.length && op !== '.' && exdirs.some(g => fnmatch(g, baseOf(op.replace(/\/+$/, '')), { extglob: false }))) continue;
          walk(op, implicitDot ? null : op);
          continue;
        }
        if (dirMode === 'skip') continue;
        flush();
        if (!noMsg) ctx.err(`${op}: Is a directory`);
        errors = true;
        continue;
      }
      if (!included(op, true)) continue;
      search({ path: op, name: op });
    }
  } catch (e) {
    if (e instanceof Done) { flush(); return 0; }
    throw e;
  }
  const files = { length: searched };
  flush();
  if (errors && !(quiet && anyMatch)) return 2;
  if (listNon) return anyMatch || files.length === 0 ? (files.length > 0 && anyMatch ? 0 : 1) : 1;
  return anyMatch ? 0 : 1;
}

C.grep = (ctx) => grepImpl(ctx);
// Ubuntu's egrep/fgrep are wrappers around `grep -E`/`grep -F`, so messages say "grep:"
const asGrep = (ctx) => ({ ...ctx, name: 'grep', err: (m) => ctx.stderr.write(`grep: ${m}\n`) });
C.egrep = (ctx) => grepImpl(asGrep(ctx), { kind: 'E' });
C.fgrep = (ctx) => grepImpl(asGrep(ctx), { kind: 'F' });
C.rgrep = (ctx) => grepImpl(asGrep(ctx), { recursive: true });

export default C;
