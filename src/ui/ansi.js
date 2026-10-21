// ANSI SGR → DOM spans. Unknown escape sequences are stripped.
import { h } from './dom.js';

const CUBE = [0, 95, 135, 175, 215, 255];
function color256(n) {
  if (n < 16) return { cls: n };
  if (n >= 232) { const v = 8 + (n - 232) * 10; return { rgb: `rgb(${v},${v},${v})` }; }
  const i = n - 16;
  return { rgb: `rgb(${CUBE[Math.floor(i / 36)]},${CUBE[Math.floor(i / 6) % 6]},${CUBE[i % 6]})` };
}

// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b\[([0-9;:?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]/g;

/**
 * Parse text with ANSI escapes into [{ text, fg, bg, bold, dim, italic, underline, inverse }] runs.
 * Also reports `clear: true` when a clear-screen sequence (ESC[2J / ESC c) is seen.
 */
export function parseAnsi(input) {
  const runs = [];
  let st = {};
  let last = 0, clearSeen = false;
  const text = String(input ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '');
  ESC_RE.lastIndex = 0;
  let m;
  const push = (t) => { if (t) runs.push({ text: t, ...st }); };
  while ((m = ESC_RE.exec(text))) {
    push(text.slice(last, m.index));
    last = ESC_RE.lastIndex;
    if (m[0] === '\x1bc') { clearSeen = true; continue; }
    if (m[2] === 'J' && (m[1] === '2' || m[1] === '3')) { clearSeen = true; continue; }
    if (m[2] !== 'm') continue;
    const codes = (m[1] || '0').split(/[;:]/).map(x => (x === '' ? 0 : parseInt(x, 10)));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) st = {};
      else if (c === 1) st = { ...st, bold: true };
      else if (c === 2) st = { ...st, dim: true };
      else if (c === 3) st = { ...st, italic: true };
      else if (c === 4) st = { ...st, underline: true };
      else if (c === 7) st = { ...st, inverse: true };
      else if (c === 22) st = { ...st, bold: false, dim: false };
      else if (c === 23) st = { ...st, italic: false };
      else if (c === 24) st = { ...st, underline: false };
      else if (c === 27) st = { ...st, inverse: false };
      else if (c >= 30 && c <= 37) st = { ...st, fg: { cls: c - 30 } };
      else if (c >= 90 && c <= 97) st = { ...st, fg: { cls: c - 90 + 8 } };
      else if (c === 39) st = { ...st, fg: null };
      else if (c >= 40 && c <= 47) st = { ...st, bg: { cls: c - 40 } };
      else if (c >= 100 && c <= 107) st = { ...st, bg: { cls: c - 100 + 8 } };
      else if (c === 49) st = { ...st, bg: null };
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) { const col = color256(codes[i + 2] | 0); st = { ...st, [c === 38 ? 'fg' : 'bg']: col }; i += 2; }
      else if ((c === 38 || c === 48) && codes[i + 1] === 2) { const col = { rgb: `rgb(${codes[i + 2] | 0},${codes[i + 3] | 0},${codes[i + 4] | 0})` }; st = { ...st, [c === 38 ? 'fg' : 'bg']: col }; i += 4; }
    }
  }
  push(text.slice(last));
  return { runs, clear: clearSeen };
}

/** Render ANSI text into a DocumentFragment of spans. */
export function ansiToFragment(input, baseClass = '') {
  const frag = document.createDocumentFragment();
  const { runs } = parseAnsi(input);
  for (const r of runs) {
    const plainRun = !r.fg && !r.bg && !r.bold && !r.dim && !r.italic && !r.underline && !r.inverse;
    if (plainRun && !baseClass) { frag.appendChild(document.createTextNode(r.text)); continue; }
    const cls = [baseClass];
    const style = {};
    let fg = r.fg, bg = r.bg;
    if (r.inverse) { cls.push('ansi-inverse'); [fg, bg] = [bg, fg]; }
    if (fg) { if (fg.rgb) style.color = fg.rgb; else cls.push('ansi-fg-' + fg.cls); }
    if (bg) { if (bg.rgb) style.backgroundColor = bg.rgb; else cls.push('ansi-bg-' + bg.cls); }
    if (r.bold) cls.push('ansi-bold');
    if (r.dim) cls.push('ansi-dim');
    if (r.italic) cls.push('ansi-italic');
    if (r.underline) cls.push('ansi-underline');
    frag.appendChild(h('span', { class: cls.filter(Boolean).join(' '), style: Object.keys(style).length ? style : null }, r.text));
  }
  return frag;
}

export function stripAnsi(s) { return String(s ?? '').replace(ESC_RE, ''); }
