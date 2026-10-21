// Tiny DOM helpers. All user/command text goes through text nodes (never innerHTML).

const SVGNS = 'http://www.w3.org/2000/svg';

export function h(tag, props, ...children) {
  return build(document.createElement(tag), props, children);
}

/** SVG element factory (always in the SVG namespace). */
export function s(tag, props, ...children) {
  return build(document.createElementNS(SVGNS, tag), props, children);
}

function build(el, props, children) {
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class' || k === 'className') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
      else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v; // only for trusted, static markup
      else if (k === 'text') el.textContent = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Pixelarticon rendered through a CSS mask so it follows currentColor. */
export function icon(name, cls = '') {
  const el = h('span', { class: 'icon ' + cls, 'aria-hidden': 'true' });
  // Inline style → URL resolves against the document (not the stylesheet).
  const url = `url("assets/icons/${name}.svg")`;
  el.style.webkitMaskImage = url;
  el.style.maskImage = url;
  return el;
}

/** Inline pixel heart (filled), crisp at 16px. */
export function heartSvg(cls = 'heart') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 8 7');
  svg.setAttribute('class', cls);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path fill="currentColor" d="M1 0h2v1h2V0h2v1h1v3H7v1H6v1H5v1H3V6H2V5H1V4H0V1h1z"/><path fill="#fff" fill-opacity=".45" d="M1 1h1v1H1z"/>';
  return svg;
}

export function fmtNum(n) { return Math.round(n).toLocaleString('en-US'); }
export function fmtTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", then a short date. */
export function timeAgo(ts, now = Date.now()) {
  const sec = Math.max(0, (now - ts) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  if (sec < 172800) return 'yesterday';
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function pick(arr, rnd = Math.random) { return arr[Math.floor(rnd() * arr.length)]; }

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = (seed >>> 0) || 0x9E3779B9;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
