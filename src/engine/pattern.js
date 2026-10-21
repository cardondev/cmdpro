// Glob patterns and POSIX/PCRE regular expressions translated to JS RegExp.
// All matching operates on byte strings (C locale).

const CLASSES = {
  alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', print: ' -~', graph: '!-~',
  cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f', word: 'A-Za-z0-9_',
};

const JS_SPECIAL = /[\\^$.*+?()[\]{}|\/]/;
export function escapeRe(s) { return s.replace(/[\\^$.*+?()[\]{}|\/-]/g, '\\$&'); }
function escClassChar(c) {
  if (c === '\\' || c === ']' || c === '[' || c === '^' || c === '-') return '\\' + c;
  const code = c.charCodeAt(0);
  if (code < 0x20 || code > 0x7e) return '\\x' + code.toString(16).padStart(2, '0');
  return c;
}
function escChar(c) {
  const code = c.charCodeAt(0);
  if (code < 0x20 || code > 0x7e) return '\\x' + code.toString(16).padStart(2, '0');
  return JS_SPECIAL.test(c) || c === '-' ? '\\' + c : c;
}

// Parse a bracket expression starting at s[i] === '['. Returns { src, end } or null if unterminated.
// bsEscape: backslash escapes the next char (globs) vs literal (POSIX regex).
// negChars: which chars negate after '[' ('!^' for globs, '^' for regex).
export function parseBracket(s, i, { bsEscape = false, negChars = '^' } = {}) {
  let j = i + 1;
  let neg = false;
  if (j < s.length && negChars.includes(s[j])) { neg = true; j++; }
  let items = '';
  let first = true;
  let lastChar = null; // for ranges
  while (j < s.length) {
    let c = s[j];
    if (c === ']' && !first) {
      let src = '[' + (neg ? '^' : '') + items + ']';
      if (items === '' ) src = neg ? '[\\s\\S]' : '[]';
      return { src, end: j + 1 };
    }
    first = false;
    if (c === '[' && (s[j + 1] === ':' || s[j + 1] === '=' || s[j + 1] === '.')) {
      const type = s[j + 1];
      const close = s.indexOf(type + ']', j + 2);
      if (close > 0) {
        const name = s.slice(j + 2, close);
        if (type === ':') {
          if (CLASSES[name] === undefined) return null;
          items += CLASSES[name];
        } else items += escClassChar(name[0] || '');
        j = close + 2;
        lastChar = null;
        continue;
      }
    }
    if (c === '\\' && bsEscape && j + 1 < s.length) { c = s[j + 1]; j++; }
    // range?
    if (s[j + 1] === '-' && s[j + 2] !== undefined && s[j + 2] !== ']') {
      let hi = s[j + 2];
      let k = j + 3;
      if (hi === '\\' && bsEscape && k < s.length) { hi = s[k]; k++; }
      if (hi === '[' && s[k] === '.') { const close = s.indexOf('.]', k + 1); if (close > 0) { hi = s[k + 1]; k = close + 2; } }
      if (c.charCodeAt(0) <= hi.charCodeAt(0)) items += escClassChar(c) + '-' + escClassChar(hi);
      j = k;
      continue;
    }
    items += escClassChar(c);
    lastChar = c;
    j++;
  }
  return null;
}

// ---------------- globs ----------------

export function hasGlob(pat, extglob = true) {
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\') { i++; continue; }
    if (c === '*' || c === '?') return true;
    if (c === '[') { if (parseBracket(pat, i, { bsEscape: true, negChars: '!^' })) return true; }
    if (extglob && '+@!'.includes(c) && pat[i + 1] === '(') return true;
  }
  return false;
}

// Translate a shell pattern (backslash escapes literal chars) to a regex source (no anchors).
export function globToRe(pat, { extglob = true, slash = true } = {}) {
  let out = '';
  const any = slash ? '[\\s\\S]' : '[^/]';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\') {
      if (i + 1 < pat.length) { out += escChar(pat[++i]); } else out += '\\\\';
      continue;
    }
    if (extglob && '?*+@!'.includes(c) && pat[i + 1] === '(') {
      const r = extgroup(pat, i + 1);
      if (r) {
        const alts = r.alts.map(a => globToRe(a, { extglob, slash })).join('|');
        if (c === '?') out += `(?:${alts})?`;
        else if (c === '*') out += `(?:${alts})*`;
        else if (c === '+') out += `(?:${alts})+`;
        else if (c === '@') out += `(?:${alts})`;
        else out += `(?:(?!(?:${alts})$)${any}*?)`;
        i = r.end - 1;
        continue;
      }
    }
    if (c === '*') { while (pat[i + 1] === '*') i++; out += any + '*'; continue; }
    if (c === '?') { out += slash ? '[\\s\\S]' : '[^/]'; continue; }
    if (c === '[') {
      const b = parseBracket(pat, i, { bsEscape: true, negChars: '!^' });
      if (b) { out += b.src; i = b.end - 1; continue; }
      out += '\\['; continue;
    }
    out += escChar(c);
  }
  return out;
}

function extgroup(pat, i) {
  // pat[i] === '(' ; returns alternatives split on top-level '|'
  let depth = 0, cur = '', alts = [];
  for (let j = i; j < pat.length; j++) {
    const c = pat[j];
    if (c === '\\') { cur += c + (pat[j + 1] || ''); j++; continue; }
    if (c === '(') { depth++; if (depth === 1) continue; }
    if (c === ')') { depth--; if (depth === 0) { alts.push(cur); return { alts, end: j + 1 }; } }
    if (c === '|' && depth === 1) { alts.push(cur); cur = ''; continue; }
    cur += c;
  }
  return null;
}

const reCache = new Map();
export function globRegex(pat, { nocase = false, extglob = true } = {}) {
  const key = pat + '\0' + nocase + extglob;
  let re = reCache.get(key);
  if (!re) {
    re = new RegExp('^(?:' + globToRe(pat, { extglob }) + ')$', nocase ? 'is' : 's');
    if (reCache.size > 2000) reCache.clear();
    reCache.set(key, re);
  }
  return re;
}

export function fnmatch(pat, str, opts) { return globRegex(pat, opts).test(str); }

// Remove backslash escapes from a pattern string (quote removal for non-matching globs).
export function unescapeGlob(pat) {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === '\\' && i + 1 < pat.length) { out += pat[++i]; continue; }
    out += pat[i];
  }
  return out;
}

// ---------------- POSIX / GNU regular expressions ----------------

const WORDC = 'A-Za-z0-9_';
const WB_START = `(?<![${WORDC}])(?=[${WORDC}])`;
const WB_END = `(?<=[${WORDC}])(?![${WORDC}])`;

function commonEscape(d, opts) {
  switch (d) {
    case '<': return WB_START;
    case '>': return WB_END;
    case 'b': return '\\b';
    case 'B': return '\\B';
    case 'w': return `[${WORDC}]`;
    case 'W': return `[^${WORDC}]`;
    case 's': return '[ \\t\\n\\r\\f\\v]';
    case 'S': return '[^ \\t\\n\\r\\f\\v]';
    case '`': return '^';
    case "'": return '$';
    case 'n': return opts.sed || opts.awk ? '\\n' : 'n';
    case 't': return opts.sed || opts.awk ? '\\t' : 't';
    case 'r': return opts.sed || opts.awk ? '\\r' : 'r';
    case 'f': return opts.sed || opts.awk ? '\\f' : 'f';
    case 'v': return opts.sed || opts.awk ? '\\v' : 'v';
    case 'a': return opts.awk ? '\\x07' : 'a';
    case '/': return '\\/';
    default: return null;
  }
}

// Translate POSIX BRE/ERE (GNU flavour) to JS regex source.
const badRepeat = () => Object.assign(new Error('nothing to repeat'), { gnu: 'Invalid preceding regular expression' });
// GNU regcomp() wording for a JS RegExp construction failure.
export function gnuRegexMessage(e) {
  if (e && e.gnu) return e.gnu;
  const m = String(e && e.message || '');
  if (/Unterminated group/i.test(m)) return 'Unmatched ( or \\(';
  if (/Unmatched '\)'/i.test(m)) return 'Unmatched ) or \\)';
  if (/Unterminated character class|missing \/|Missing \]/i.test(m)) return 'Unmatched [, [^, [:, [., or [=';
  if (/\\ at end of pattern/i.test(m)) return 'Trailing backslash';
  if (/Range out of order/i.test(m)) return 'Invalid range end';
  return 'Invalid preceding regular expression';
}
export function posixToJs(re, { extended = false, sed = false, awk = false } = {}) {
  const opts = { sed, awk };
  let out = '';
  let i = 0;
  const n = re.length;
  // atStart: at the start of an expression (for ^, * and intervals); atom: where the last atom
  // starts in `out` (-1 for none); quantified: it already carries a quantifier — POSIX lets
  // quantifiers stack (a{1}{2} is (a{1}){2}), JS doesn't, so stacked ones get wrapped
  let atStart = true, atom = -1, quantified = false;
  const groups = [];
  const emit = (s) => { atom = out.length; quantified = false; out += s; atStart = false; };
  const anchor = (s, start = false) => { out += s; atom = -1; atStart = start; };
  const quant = (q) => {
    if (quantified) out = out.slice(0, atom) + '(?:' + out.slice(atom) + ')';
    out += q;
    quantified = true;
    atStart = false;
  };
  const open = () => { groups.push(out.length); out += '('; atom = -1; atStart = true; };
  const close = () => { const g = groups.length ? groups.pop() : out.length; out += ')'; atom = g; quantified = false; atStart = false; };
  while (i < n) {
    const c = re[i];
    if (c === '\\') {
      const d = re[i + 1];
      i += 2;
      if (d === undefined) { emit('\\\\'); break; }
      if (!extended && (d === '(' || d === ')' || d === '|' || d === '{' || d === '}' || d === '+' || d === '?')) {
        if (d === '(') { open(); continue; }
        if (d === ')') { close(); continue; }
        if (d === '|') { anchor('|', true); continue; }
        if (d === '{') {
          const end = re.indexOf('\\}', i);
          if (end < 0 || atom < 0) { emit('\\{'); continue; }   // nothing to repeat: a literal brace
          let body = re.slice(i, end);
          if (/^\d*(,\d*)?$/.test(body) && body !== '' && body !== ',') { if (body.startsWith(',')) body = '0' + body; quant('{' + body + '}'); i = end + 2; continue; }
          emit('\\{'); continue;
        }
        if (d === '}') { emit('\\}'); continue; }
        if (d === '+' || d === '?') { if (atom < 0) { emit('\\' + d); continue; } quant(d); continue; }
      }
      if (d >= '1' && d <= '9') { emit('\\' + d); continue; }
      const ce = commonEscape(d, opts);
      if (ce !== null) {
        if (ce === '^' || ce === '$' || ce === '\\b' || ce === '\\B' || ce === WB_START || ce === WB_END) anchor(ce, ce === '^');
        else emit(ce);
        continue;
      }
      if (awk && d === '"') { emit('"'); continue; }
      if (awk && /[0-7]/.test(d)) {
        let o = d;
        while (o.length < 3 && /[0-7]/.test(re[i] || '')) o += re[i++];
        emit(escChar(String.fromCharCode(parseInt(o, 8) & 255)));
        continue;
      }
      emit(escChar(d));
      continue;
    }
    if (c === '[') {
      const b = parseBracket(re, i, { bsEscape: awk, negChars: '^' });
      if (b) { emit(b.src); i = b.end; continue; }
      emit('\\['); i++; continue;
    }
    if (c === '^') {
      if (extended || atStart) { anchor('^', true); i++; continue; }
      emit('\\^'); i++; continue;
    }
    if (c === '$') {
      if (extended) { anchor('$'); i++; continue; }
      // BRE: anchor only at end or before \) or \|
      const rest = re.slice(i + 1);
      if (rest === '' || rest.startsWith('\\)') || rest.startsWith('\\|')) { anchor('$'); i++; continue; }
      emit('\\$'); i++; continue;
    }
    if (c === '*') {
      if (atom < 0) {
        // GNU regex: leading repetition is literal in BRE and gawk, ignored by grep -E, an error for sed -E
        if (extended && !awk) { if (sed) throw badRepeat(); i++; continue; }
        emit('\\*'); i++; continue;
      }
      quant('*'); i++; continue;
    }
    if (extended) {
      if (c === '(') {
        if (re[i + 1] === ')') { emit('(?:)'); i += 2; continue; }
        open(); i++; continue;
      }
      if (c === ')') { if (groups.length) close(); else emit('\\)'); i++; continue; }
      if (c === '|') { anchor('|', true); i++; continue; }
      if (c === '+' || c === '?') {
        if (atom < 0) { if (awk) { emit('\\' + c); i++; continue; } if (sed) throw badRepeat(); i++; continue; }
        quant(c); i++; continue;
      }
      if (c === '{') {
        const end = re.indexOf('}', i);
        const body = end > 0 ? re.slice(i + 1, end) : '';
        if (end > 0 && /^\d*(,\d*)?$/.test(body) && body !== '' && body !== ',') {
          // an interval with nothing to repeat applies to the empty string
          if (atom >= 0) quant('{' + (body.startsWith(',') ? '0' + body : body) + '}');
          i = end + 1; continue;
        }
        emit('\\{'); i++; continue;
      }
      if (c === '}') { emit('\\}'); i++; continue; }
    } else {
      if ('+?(){}|'.includes(c)) { emit('\\' + c); i++; continue; }
    }
    if (c === '.') { emit('[\\s\\S]'); i++; continue; }
    if (c === '\n') { emit('\\n'); i++; atStart = !sed; continue; }
    emit(escChar(c));
    i++;
  }
  return out;
}

// Translate PCRE to JS regex source. Returns { src, flags }.
export function pcreToJs(re) {
  let flags = '';
  let src = re;
  // leading inline flags
  const m = /^\(\?([imsx]+)\)/.exec(src);
  if (m) { if (m[1].includes('i')) flags += 'i'; src = src.slice(m[0].length); }
  let out = '';
  let depth = 0;
  let kpos = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const d = src[i + 1];
      i++;
      if (d === undefined) throw new Error('\\ at end of pattern');
      if (d === 'K' && depth === 0) { kpos = out.length; continue; }
      if (d === 'h') { out += '[ \\t]'; continue; }
      if (d === 'H') { out += '[^ \\t]'; continue; }
      if (d === 'R') { out += '(?:\\r\\n|\\n|\\r)'; continue; }
      if (d === 'A') { out += '^'; continue; }
      if (d === 'Z') { out += '(?=\\n?$)'; continue; }
      if (d === 'z') { out += '$'; continue; }
      if (d === 'e') { out += '\\x1b'; continue; }
      if (d === 'Q') {
        const e = src.indexOf('\\E', i + 1);
        const lit = src.slice(i + 1, e < 0 ? src.length : e);
        out += escapeRe(lit);
        i = e < 0 ? src.length : e + 1;
        continue;
      }
      if (d === 'x' && src[i + 1] === '{') {
        const e = src.indexOf('}', i);
        out += '\\x' + src.slice(i + 2, e).padStart(2, '0').slice(-2);
        i = e;
        continue;
      }
      if (d === 'd') { out += '[0-9]'; continue; }
      if (d === 'D') { out += '[^0-9]'; continue; }
      if (d === 'w') { out += '[A-Za-z0-9_]'; continue; }
      if (d === 'W') { out += '[^A-Za-z0-9_]'; continue; }
      if (d === 's') { out += '[ \\t\\n\\r\\f\\v]'; continue; }
      if (d === 'S') { out += '[^ \\t\\n\\r\\f\\v]'; continue; }
      out += '\\' + d;
      continue;
    }
    if (c === '[') {
      // copy class, expanding POSIX classes
      let j = i + 1, cls = '[';
      if (src[j] === '^') { cls += '^'; j++; }
      if (src[j] === ']') { cls += '\\]'; j++; }
      while (j < src.length && src[j] !== ']') {
        if (src[j] === '[' && src[j + 1] === ':') {
          const e = src.indexOf(':]', j);
          if (e > 0 && CLASSES[src.slice(j + 2, e)] !== undefined) { cls += CLASSES[src.slice(j + 2, e)]; j = e + 2; continue; }
        }
        if (src[j] === '\\') {
          const d = src[j + 1];
          if (d === 'd') cls += '0-9'; else if (d === 'w') cls += 'A-Za-z0-9_'; else if (d === 's') cls += ' \\t\\n\\r\\f\\v'; else if (d === 'h') cls += ' \\t';
          else cls += '\\' + d;
          j += 2; continue;
        }
        if (src[j] === '[') { cls += '\\['; j++; continue; }
        cls += src[j]; j++;
      }
      if (j >= src.length) throw new SyntaxError('Unterminated character class');
      out += cls + ']';
      i = j;
      continue;
    }
    if (c === '(') {
      depth++;
      if (src.startsWith('(?P<', i)) { out += '(?<'; i += 3; continue; }
      if (src.startsWith('(?P=', i)) { const e = src.indexOf(')', i); out += '\\k<' + src.slice(i + 4, e) + '>'; i = e; depth--; continue; }
      if (src.startsWith('(?>', i)) { out += '(?:'; i += 2; continue; }
      if (src.startsWith('(?#', i)) { const e = src.indexOf(')', i); i = e; depth--; continue; }
      out += c;
      continue;
    }
    if (c === ')') { depth--; out += c; continue; }
    if ((c === '+') && /[*+?}]$/.test(out) && !/\\[*+?}]$/.test(out)) continue; // possessive -> greedy
    if (c === '.') { out += '[^\\n]'; continue; }
    out += c;
  }
  if (kpos >= 0) out = out.slice(0, kpos) + '(?<__K>' + out.slice(kpos) + ')';
  return { src: out, flags };
}

// Build a JS RegExp for grep/sed/awk-style usage.
// kind: 'bre' | 'ere' | 'pcre' | 'fixed'
export function compileRegex(re, kind, { icase = false, global = false, sed = false, awk = false, word = false, line = false } = {}) {
  let src, flags = 's';
  if (kind === 'fixed') src = escapeRe(re);
  else if (kind === 'pcre') { const p = pcreToJs(re); src = p.src; if (p.flags.includes('i')) icase = true; flags = ''; }
  else src = posixToJs(re, { extended: kind === 'ere', sed, awk });
  if (word) src = `(?<![A-Za-z0-9_])(?:${src})(?![A-Za-z0-9_])`;
  if (line) src = `^(?:${src})$`;
  if (icase) flags += 'i';
  if (global) flags += 'g';
  if (kind !== 'pcre' && !flags.includes('s')) flags += 's';
  return new RegExp(src, flags);
}

// POSIX leftmost-longest: given a regex source that contains alternation, return a function that
// extends a JS (leftmost-first) match starting at `start` to the longest possible end.
export function longestExtender(src, flags = '') {
  if (!src.includes('|')) return null;
  const cache = new Map();
  const f = flags.replace(/[gy]/g, '');
  return (s, start, minEnd) => {
    for (let end = s.length; end > minEnd; end--) {
      const k = s.length - end;
      let r = cache.get(k);
      if (!r) {
        try { r = new RegExp('(?:' + src + ')(?=[\\s\\S]{' + k + '}$)', f + 'y'); } catch { return minEnd; }
        if (cache.size > 4096) cache.clear();
        cache.set(k, r);
      }
      r.lastIndex = start;
      if (r.test(s)) return end;
    }
    return minEnd;
  };
}

// Find all matches of a global regex with POSIX longest semantics (when ext provided) and \K support.
export function* allMatches(re, s, ext) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    let start = m.index, end = m.index + m[0].length;
    if (m.groups && m.groups.__K !== undefined) { start = end - m.groups.__K.length; }
    else if (ext) { const e2 = ext(s, m.index, end); if (e2 > end) { end = e2; re.lastIndex = e2; } }
    yield { start, end, text: s.slice(start, end), m };
    if (m[0] === '') { if (re.lastIndex >= s.length) break; re.lastIndex++; }
  }
}

// The errors GNU grep reports for a BRE/ERE (glibc regcomp's, plus dfa's [:space:] check), or
// null. Mirrors what glibc accepts: a leading repetition is literal (BRE) or applies to nothing
// (ERE), an ERE `{` that doesn't open a valid interval is literal, so is an unmatched ERE `)`.
const CLASS_NAMES = new Set(['alpha', 'upper', 'lower', 'digit', 'xdigit', 'space', 'print', 'punct', 'graph', 'cntrl', 'blank', 'alnum']);
const RE_DUP_MAX = 32767;
export function posixRegexError(p, { extended = false } = {}) {
  let i = 0, open = [], completed = 0;
  const n = p.length;
  const interval = (body) => {
    // body is what sits between the braces
    if (!/^\d*(,\d*)?$/.test(body) || body === '' || body === ',') return 'Invalid content of \\{\\}';
    const [a, b] = body.split(',');
    const lo = a === '' ? 0 : parseInt(a, 10), hi = b === undefined ? lo : b === '' ? Infinity : parseInt(b, 10);
    if (lo > RE_DUP_MAX || (hi !== Infinity && hi > RE_DUP_MAX)) return 'Regular expression too big';
    if (hi < lo) return 'Invalid content of \\{\\}';
    return null;
  };
  while (i < n) {
    const c = p[i];
    if (c === '\\') {
      const d = p[i + 1];
      if (d === undefined) return 'Trailing backslash';
      i += 2;
      if (d >= '1' && d <= '9') { if (+d > completed) return 'Invalid back reference'; continue; }
      if (!extended) {
        if (d === '(') { open.push(i); continue; }
        if (d === ')') { if (!open.length) return 'Unmatched ) or \\)'; open.pop(); completed++; continue; }
        if (d === '{') {
          const close = p.indexOf('\\}', i);
          if (close < 0) {
            // nothing to repeat: a literal brace
            if (i === 2 || /\\\($|\\\|$/.test(p.slice(0, i - 2))) continue;
            return 'Unmatched \\{';
          }
          if (i === 2 || /\\\($|\\\|$/.test(p.slice(0, i - 2))) { i = close + 2; continue; }
          const e = interval(p.slice(i, close));
          if (e) return e;
          i = close + 2;
          continue;
        }
      }
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      if (p[j] === '^') j++;
      if (j >= n) return 'Invalid regular expression';
      const start = j;
      if (p[j] === ']') j++;
      let prevEnd = null, afterRange = false, prevClass = false;
      for (;;) {
        if (j >= n) return 'Unmatched [, [^, [:, [., or [=';
        const ch = p[j];
        if (ch === ']' && j > start) break;
        if (ch === '[' && (p[j + 1] === ':' || p[j + 1] === '.' || p[j + 1] === '=')) {
          const kind = p[j + 1];
          const e = p.indexOf(kind + ']', j + 2);
          if (e < 0) return 'Unmatched [, [^, [:, [., or [=';
          const name = p.slice(j + 2, e);
          if (kind === ':' && !CLASS_NAMES.has(name)) return 'Invalid character class name';
          if (kind === '.' && name.length !== 1) return 'Invalid collation character';
          j = e + 2;
          if (kind === ':') { prevClass = true; prevEnd = null; }
          else { prevClass = false; prevEnd = name; }
          afterRange = false;
          continue;
        }
        if (ch === '-' && p[j + 1] !== ']' && j > start && (prevEnd !== null || prevClass || afterRange)) {
          if (prevClass || afterRange) return 'Invalid range end';
          let hi = p[j + 1], k = j + 2;
          if (hi === '[' && (p[j + 2] === '.' || p[j + 2] === '=')) { const e = p.indexOf(p[j + 2] + ']', j + 3); if (e < 0) return 'Unmatched [, [^, [:, [., or [='; hi = p.slice(j + 3, e); k = e + 2; }
          else if (hi === '[' && p[j + 2] === ':') return 'Invalid range end';
          if (hi.charCodeAt(0) < prevEnd.charCodeAt(0)) return 'Invalid range end';
          j = k; prevEnd = null; afterRange = true; prevClass = false;
          continue;
        }
        prevEnd = ch; prevClass = false; afterRange = false;
        j++;
      }
      // dfa: [:alpha:] where [[:alpha:]] was meant
      const body = p.slice(start, j);
      if (body.length > 1 && body[0] === ':' && body[body.length - 1] === ':') return 'character class syntax is [[:space:]], not [:space:]';
      i = j + 1;
      continue;
    }
    if (extended) {
      if (c === '(') { open.push(i); i++; continue; }
      if (c === ')') { if (open.length) { open.pop(); completed++; } i++; continue; }
      if (c === '{') {
        const close = p.indexOf('}', i);
        const body = close > 0 ? p.slice(i + 1, close) : null;
        if (body !== null && /^\d*(,\d*)?$/.test(body) && body !== '' && body !== ',') {
          const e = interval(body);
          if (e) return e;
          i = close + 1;
          continue;
        }
        i++;
        continue;
      }
    }
    i++;
  }
  if (open.length) return 'Unmatched ( or \\(';
  return null;
}
