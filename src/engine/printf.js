// bash/coreutils printf implementation.
import { formatOne } from './cfmt.js';
import { strftime } from './timefmt.js';
import { strtold, ldFromInt, ldZero } from './ldouble.js';
import { quotearg } from './commands/util.js';

export function shellQuote(s, force = false) {
  if (s === '') return "''";
  if (!force && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  if (/[\x00-\x1f\x7f-\xff]/.test(s)) {
    let out = "$'";
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      if (ch === "'") out += "\\'";
      else if (ch === '\\') out += '\\\\';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\x1b') out += '\\E';
      else if (c < 0x20 || c >= 0x7f) out += '\\' + c.toString(8).padStart(3, '0');
      else out += ch;
    }
    return out + "'";
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function printfQ(s) {
  if (s === '') return "''";
  if (/[\x00-\x1f\x7f-\xff]/.test(s)) return shellQuote(s, true);
  return s.replace(/[^A-Za-z0-9_@%+=:,./-]/g, '\\$&');
}

// Decode escapes inside a printf FORMAT string.
function fmtEscape(s, i, dash = false) {
  // s[i] === '\\' ; returns [text, nextIndex]
  const d = s[i + 1];
  if (d === undefined) return ['\\', i + 1];
  // dash knows only \\ \a \b \e \f \n \r \t \v and octal; any other backslash stays
  if (dash && !'\\abefnrtv01234567'.includes(d)) return ['\\', i + 1];
  switch (d) {
    case 'a': return ['\x07', i + 2];
    case 'b': return ['\b', i + 2];
    case 'e': case 'E': return ['\x1b', i + 2];
    case 'f': return ['\f', i + 2];
    case 'n': return ['\n', i + 2];
    case 'r': return ['\r', i + 2];
    case 't': return ['\t', i + 2];
    case 'v': return ['\v', i + 2];
    case '\\': return ['\\', i + 2];
    case '"': return ['"', i + 2];
    case "'": return ["'", i + 2];
    case '?': return ['?', i + 2];
    case 'x': {
      let j = i + 2, h = '';
      while (h.length < 2 && /[0-9a-fA-F]/.test(s[j] || '')) h += s[j++];
      if (!h) return ['\\x', i + 2];
      return [String.fromCharCode(parseInt(h, 16)), j];
    }
    case 'u': case 'U': {
      let j = i + 2, h = '';
      const max = d === 'u' ? 4 : 8;
      while (h.length < max && /[0-9a-fA-F]/.test(s[j] || '')) h += s[j++];
      if (!h) return ['\\' + d, i + 2];
      const u8 = new TextEncoder().encode(String.fromCodePoint(parseInt(h, 16)));
      return [String.fromCharCode(...u8), j];
    }
    default:
      if (d >= '0' && d <= '7') {
        let j = i + 1, o = '';
        while (o.length < 3 && /[0-7]/.test(s[j] || '')) o += s[j++];
        return [String.fromCharCode(parseInt(o, 8) & 255), j];
      }
      return ['\\' + d, i + 2];
  }
}

// %b argument escapes (echo -e style; \0nnn octal; \c stops output)
function bEscape(s, dash = false) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) { out += c; continue; }
    const d = s[i + 1];
    if (d === 'c') return { text: out, stop: true };
    if (d === '0') {
      let j = i + 2, o = '';
      while (o.length < 3 && /[0-7]/.test(s[j] || '')) o += s[j++];
      out += String.fromCharCode(parseInt(o || '0', 8) & 255);
      i = j - 1;
      continue;
    }
    if (d >= '1' && d <= '7') {
      let j = i + 1, o = '';
      while (o.length < 3 && /[0-7]/.test(s[j] || '')) o += s[j++];
      out += String.fromCharCode(parseInt(o, 8) & 255);
      i = j - 1;
      continue;
    }
    const [t, n] = fmtEscape(s, i, dash);
    out += t;
    i = n - 1;
  }
  return { text: out, stop: false };
}

// dash's printf (sh): its own number parsing, in C doubles
function parseIntArg(a, err) {
  const s = a.trim();
  if (s === '') return 0n;
  if ((s[0] === "'" || s[0] === '"') && s.length >= 2) return BigInt(s.charCodeAt(1));
  if ((s[0] === "'" || s[0] === '"')) return 0n;
  const m = /^([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(s);
  if (!m) { err(`${a}: invalid number`); return 0n; }
  let v;
  const body = m[2];
  if (/^0[xX]/.test(body)) v = BigInt(body);
  else if (body.length > 1 && body[0] === '0') v = BigInt('0o' + body.slice(1));
  else v = BigInt(body);
  if (m[1] === '-') v = -v;
  if (m[0].length !== s.length) err(`${a}: invalid number`);
  // clamp to 64-bit like strtoimax
  const MAX = (1n << 63n) - 1n, MIN = -(1n << 63n);
  if (v > MAX) { err(`${a}: Numerical result out of range`); v = MAX; }
  if (v < MIN) { err(`${a}: Numerical result out of range`); v = MIN; }
  return v;
}

function parseFloatArg(a, err) {
  const s = a.trim();
  if (s === '') return 0;
  if ((s[0] === "'" || s[0] === '"') && s.length >= 2) return s.charCodeAt(1);
  const m = /^[+-]?((\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|inf(inity)?|nan|0[xX][0-9a-fA-F]+(\.[0-9a-fA-F]*)?([pP][+-]?\d+)?)/i.exec(s);
  if (!m) { err(`${a}: invalid number`); return 0; }
  let v;
  const t = m[0].toLowerCase();
  if (t.includes('inf')) v = t.startsWith('-') ? -Infinity : Infinity;
  else if (t.includes('nan')) v = NaN;
  else if (/0x/.test(t)) v = parseFloat(String(Number(t.replace(/p.*$/, '').replace(/\..*$/, ''))));
  else v = parseFloat(t);
  if (m[0].length !== s.length) err(`${a}: invalid number`);
  return v;
}

const SPACE = ' \t\n\v\f\r';
const INTMAX = (1n << 63n) - 1n, INTMIN = -(1n << 63n), UINTMAX = (1n << 64n) - 1n;
// glibc strtoimax/strtoumax with base 0 -> { v, end, range }; end 0 when nothing converts
function strtoint(s, unsigned) {
  let i = 0;
  while (i < s.length && SPACE.includes(s[i])) i++;
  let neg = false;
  if (s[i] === '+' || s[i] === '-') { neg = s[i] === '-'; i++; }
  let base = 10;
  if (s[i] === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X') && /[0-9a-fA-F]/.test(s[i + 2] || '')) { base = 16; i += 2; }
  else if (s[i] === '0') base = 8;
  const m = (base === 16 ? /^[0-9a-fA-F]+/ : base === 8 ? /^[0-7]+/ : /^[0-9]+/).exec(s.slice(i));
  if (!m) return { v: 0n, end: 0, range: false };
  let v = BigInt((base === 16 ? '0x' : base === 8 ? '0o' : '') + m[0]), range = false;
  if (unsigned) {
    if (v > UINTMAX) { v = UINTMAX; range = true; } else if (neg && v) v = UINTMAX + 1n - v;
  } else {
    if (neg) v = -v;
    if (v > INTMAX) { v = INTMAX; range = true; } else if (v < INTMIN) { v = INTMIN; range = true; }
  }
  return { v, end: i + m[0].length, range };
}

// Returns { out, status, stop }. opts: err(msg) reports a diagnostic; coreutils selects GNU printf's
// argument checks (else bash's builtin, or dash's with dash); write(text) + flush ('lines' for bash's
// line-buffered stdout, 'all' for coreutils, whose error() flushes stdout) send the output made so
// far ahead of each diagnostic, and the rest comes back in out.
export function doPrintf(fmt, args, opts = {}) {
  let out = '';
  let status = 0;
  const flush = () => {
    if (!opts.write) return;
    const k = opts.flush === 'lines' ? out.lastIndexOf('\n') + 1 : out.length;
    if (k > 0) { opts.write(out.slice(0, k)); out = out.slice(k); }
  };
  const warn = (m) => { flush(); if (opts.err) opts.err(m); };
  const err = (m) => { status = 1; warn(m); };
  const quote = (s) => quotearg(s, 'locale');
  // bash's sh_invalidnum()
  const invalid = (a) => err(`${a}: ${a[0] === '0' && /[0-9]/.test(a[1] || '') ? 'invalid octal number' : a[0] === '0' && a[1] === 'x' ? 'invalid hex number' : 'invalid number'}`);
  // coreutils' STRTOX(): a character constant, or a number checked by verify_numeric()
  const charConst = (a) => {
    if ((a[0] !== '"' && a[0] !== "'") || a.length < 2) return null;
    if (a.length > 2) warn(`warning: ${a.slice(2)}: character(s) following character constant have been ignored`);
    return a.charCodeAt(1);
  };
  const verify = (a, end, range) => {
    if (range) err(`${quote(a)}: Numerical result out of range`);
    else if (end < a.length) err(`${quote(a)}: ${end === 0 ? 'expected a numeric value' : 'value not completely converted'}`);
  };
  // getintmax()/getuintmax() (bash) or vstrtoimax()/vstrtoumax() (coreutils)
  const intArg = (a, unsigned = false) => {
    if (a === null) return 0n;
    if (opts.dash) return parseIntArg(a, err);
    if (opts.coreutils) {
      const c = charConst(a);
      if (c !== null) return BigInt(c);
      const r = strtoint(a, unsigned);
      verify(a, r.end, r.range);
      return r.v;
    }
    if (a[0] === "'" || a[0] === '"') return BigInt(a.length > 1 ? a.charCodeAt(1) : 0);
    const r = strtoint(a, unsigned);
    if (r.end < a.length) { invalid(a); return unsigned ? 0n : r.v; }
    if (r.range) warn(`warning: ${a}: Numerical result out of range`);
    return r.v;
  };
  // getfloatmax() (bash) or vstrtold() (coreutils): a long double
  const floatArg = (a) => {
    if (a === null) return opts.dash ? 0 : ldZero();
    if (opts.dash) return parseFloatArg(a, err);
    if (opts.coreutils) {
      const c = charConst(a);
      if (c !== null) return ldFromInt(BigInt(c));
      const r = strtold(a);
      verify(a, r.end, r.v.range);
      return r.v;
    }
    if (a[0] === "'" || a[0] === '"') return ldFromInt(BigInt(a.length > 1 ? a.charCodeAt(1) : 0));
    const r = strtold(a);
    if (r.end < a.length) invalid(a);
    else if (r.v.range) warn(`warning: ${a}: Numerical result out of range`);
    return r.v;
  };
  let ai = 0;
  let stop = false;
  const nextArg = () => (ai < args.length ? args[ai++] : null);
  for (;;) {
    const startAi = ai;
    let i = 0;
    while (i < fmt.length && !stop) {
      const c = fmt[i];
      if (c === '\\') { const [t, n] = fmtEscape(fmt, i, opts.dash); if (fmt[i + 1] === 'c' && !opts.dash) { stop = true; break; } out += t; i = n; continue; }
      if (c !== '%') { out += c; i++; continue; }
      if (fmt[i + 1] === '%') { out += '%'; i += 2; continue; }
      // parse spec
      let j = i + 1;
      let flags = '';
      while (j < fmt.length && "-+ #0'".includes(fmt[j])) flags += fmt[j++];
      let width, prec;
      if (fmt[j] === '*') { width = Number(intArg(nextArg())); j++; }
      else { let w = ''; while (/[0-9]/.test(fmt[j] || '')) w += fmt[j++]; if (w) width = parseInt(w, 10); }
      if (fmt[j] === '.') {
        j++;
        if (fmt[j] === '*') { prec = Number(intArg(nextArg())); j++; if (prec < 0) prec = undefined; }
        else { let p = ''; while (/[0-9]/.test(fmt[j] || '')) p += fmt[j++]; prec = p ? parseInt(p, 10) : 0; }
      }
      // length modifiers (ignored)
      while (/[hlLjzt]/.test(fmt[j] || '')) j++;
      let conv = fmt[j];
      if (conv === undefined) { out += fmt.slice(i); err(`\`${fmt.slice(i)}': missing format character`); i = fmt.length; break; }
      if (conv === '(') {
        const close = fmt.indexOf(')T', j);
        if (close < 0) { err(`\`(': invalid format character`); i = j + 1; continue; }
        const tfmt = fmt.slice(j + 1, close);
        const a = nextArg();
        let t = a === null || a === '' ? Math.floor(Date.now() / 1000) : Number(intArg(a));
        if (t === -1) t = Math.floor(Date.now() / 1000);
        if (t === -2) t = Math.floor((opts.startTime || Date.now()) / 1000);
        out += formatOne({ flags, width, prec, conv: 's' }, strftime(tfmt, new Date(t * 1000), opts.tz));
        i = close + 2;
        continue;
      }
      j++;
      const a = nextArg();
      switch (conv) {
        // (the argument first: a diagnostic flushes `out`)
        case 'd': case 'i': case 'o': case 'u': case 'x': case 'X': {
          const v = intArg(a, conv !== 'd' && conv !== 'i');
          out += formatOne({ flags, width, prec, conv }, v);
          break;
        }
        case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': case 'a': case 'A': {
          const v = floatArg(a);
          out += formatOne({ flags, width, prec, conv }, v);
          break;
        }
        case 'c':
          out += formatOne({ flags, width, prec, conv: 's' }, (a ?? '').slice(0, 1));
          break;
        case 's':
          out += formatOne({ flags, width, prec, conv: 's' }, a ?? '');
          break;
        case 'b': {
          const r = bEscape(a ?? '', opts.dash);
          out += formatOne({ flags, width, prec, conv: 's' }, r.text);
          if (r.stop) stop = true;
          break;
        }
        case 'q':
          if (opts.dash) { if (opts.err) opts.err(`%q: invalid directive`); return { out, status: 2, stop: true }; }
          out += formatOne({ flags, width, prec, conv: 's' }, printfQ(a ?? ''));
          break;
        default:
          err(`\`${conv}': invalid format character`);
          return { out, status: 1, stop: true };
      }
      i = j;
    }
    if (stop || ai >= args.length || ai === startAi) break;
  }
  return { out, status, stop };
}
