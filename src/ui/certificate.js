// Certificate renderer: a print-ready vector document (11in × 8.5in) parodying an
// X.509 certificate. Also handles printing (window.print) and SVG download with
// embedded images + fonts so the file stands alone.
import { s, h, downloadBlob } from './dom.js';
import { ISSUER, KEY_USAGE, NOT_AFTER, DIFFICULTY_STAMP } from '../data/certs.js';
import { avatarUrl, sealUrl } from './sprites.js';
import { sha256Hex, colonHex } from '../game/sha256.js';

const W = 1100, H = 850;
const PAPER = '#FBF9F3', INK = '#1E1E2E', INK2 = '#4C4F69', INK3 = '#7C7F93';
const SANS = "'Geist Sans', -apple-system, 'Segoe UI', sans-serif";
const MONO = "'Cardondev Mono', ui-monospace, Menlo, monospace";
const ARCADE = "'Press Start 2P', 'Cardondev Mono', monospace";

let measureCtx = null;
function measure(text, font) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}
function wrap(text, font, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (measure(t, font) > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Darken light tier colours so text stays readable on paper. */
function inkify(hex) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum > 0.42) { const k = Math.min(0.6, (lum - 0.42) * 1.6 + 0.25); r = Math.round(r * (1 - k) + 30 * k); g = Math.round(g * (1 - k) + 30 * k); b = Math.round(b * (1 - k) + 46 * k); }
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function hashNum(str) { let x = 2166136261; for (const c of String(str)) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } return x >>> 0; }

function squiggle(seed, x, y, w) {
  let r = seed;
  const rnd = () => { r = (Math.imul(r ^ (r >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return r / 4294967296; };
  let d = `M ${x} ${y}`;
  const n = 7;
  for (let i = 1; i <= n; i++) {
    const px = x + (w * i) / n;
    const amp = 10 + rnd() * 16;
    d += ` C ${px - w / n * 0.7} ${y - amp}, ${px - w / n * 0.3} ${y + amp * (0.6 + rnd())}, ${px} ${y + (rnd() - 0.5) * 8}`;
  }
  d += ` M ${x + w * 0.15} ${y + 14} L ${x + w * 0.85} ${y + 10}`;
  return d;
}

function guilloche(c1) {
  const g = s('g', { opacity: '0.07', fill: 'none', stroke: c1, 'stroke-width': '0.8' });
  const cx = W / 2, cy = 400;
  for (let i = 0; i < 36; i++) {
    g.appendChild(s('ellipse', { cx, cy, rx: 300, ry: 110, transform: `rotate(${i * 5} ${cx} ${cy})` }));
  }
  for (let i = 0; i < 18; i++) {
    g.appendChild(s('circle', { cx, cy, r: 130 + i * 9 }));
  }
  return g;
}

function pixelCorner(x, y, sx, sy, color) {
  const g = s('g', { fill: color });
  const px = 6;
  const shape = [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [0, 2], [0, 3], [2, 2]];
  for (const [a, b] of shape) g.appendChild(s('rect', { x: x + sx * a * px - (sx < 0 ? px : 0), y: y + sy * b * px - (sy < 0 ? px : 0), width: px, height: px }));
  return g;
}

function barcode(serial, x, y, w, hgt, color) {
  // Deterministic pseudo-barcode: ~34 bars of width 1–3 units with 1–2 unit gaps.
  const g = s('g', { fill: color });
  let seed = hashNum(serial);
  const rnd = () => { seed = (Math.imul(seed ^ (seed >>> 13), 1274126177) + 0x6D2B79F5) >>> 0; return seed / 4294967296; };
  const bars = Array.from({ length: 34 }, () => [1 + Math.floor(rnd() * 3), 1 + Math.floor(rnd() * 2)]);
  const total = bars.reduce((a, [b, gap]) => a + b + gap, 0);
  const u = w / total;
  let cx = x;
  for (const [bw, gap] of bars) {
    g.appendChild(s('rect', { x: cx.toFixed(2), y, width: (bw * u).toFixed(2), height: hgt }));
    cx += (bw + gap) * u;
  }
  return g;
}

function fallbackSeal(cx, cy, r, c1, c2, label) {
  const g = s('g', null);
  const pts = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const rr = i % 2 ? r : r * 0.9;
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(1)},${(cy + Math.sin(a) * rr).toFixed(1)}`);
  }
  g.appendChild(s('polygon', { points: pts.join(' '), fill: c1 }));
  g.appendChild(s('circle', { cx, cy, r: r * 0.74, fill: c2, stroke: '#fff', 'stroke-width': 2 }));
  g.appendChild(s('circle', { cx, cy, r: r * 0.6, fill: 'none', stroke: c1, 'stroke-width': 1.5, 'stroke-dasharray': '2 3' }));
  g.appendChild(s('text', { x: cx, y: cy - 4, 'text-anchor': 'middle', 'font-family': ARCADE, 'font-size': 13, fill: INK }, '>_'));
  g.appendChild(s('text', { x: cx, y: cy + 18, 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 600, 'font-size': 11, 'letter-spacing': 1.5, fill: INK }, label.toUpperCase()));
  return g;
}

function fmtDate(iso) {
  const d = new Date(iso || Date.now());
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
function x509Date(iso) {
  const d = new Date(iso || Date.now());
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const p = n => String(n).padStart(2, '0');
  return `${mon} ${String(d.getUTCDate()).padStart(2, ' ')} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()} GMT`;
}

export async function fingerprintFor(cert, entry, name) {
  return colonHex(await sha256Hex([cert.id, name, entry.serial, entry.date, entry.difficulty, entry.score].join('|')));
}

/**
 * Render a certificate.
 * @param {object} p { cert, entry: {difficulty, score, date, serial}, name, handle, avatar, locked }
 * locked: not earned yet, so a dimmed specimen under a NOT EARNED watermark, made out to nobody.
 */
export async function renderCertificate({ cert, entry, name, handle, avatar, locked = false }) {
  try { await Promise.all(['300 44px "Geist Sans"', '400 16px "Geist Sans"', '600 52px "Geist Sans"', '12px "Press Start 2P"', '11px "Cardondev Mono"'].map(f => document.fonts.load(f))); } catch {}
  const [c1, c2] = cert.colors;
  const ink1 = inkify(c1);
  if (locked) { name = 'Your Name Here'; handle = 'player'; }
  const displayName = (name || handle || 'Anonymous Hacker').trim().slice(0, 48);
  const fp = await fingerprintFor(cert, entry, displayName);
  const stamp = DIFFICULTY_STAMP[entry.difficulty] || DIFFICULTY_STAMP.normal;

  const svg = s('svg', {
    xmlns: 'http://www.w3.org/2000/svg', 'xmlns:xlink': 'http://www.w3.org/1999/xlink',
    viewBox: `0 0 ${W} ${H}`, class: 'certificate', role: 'img',
    'aria-label': locked ? `${cert.title} certificate (not earned yet)` : `${cert.title} certificate issued to ${displayName}`,
    'data-locked': locked ? 'true' : null,
  });
  const defs = s('defs', null,
    s('linearGradient', { id: `cg-${cert.id}`, x1: '0', y1: '0', x2: '1', y2: '1' },
      s('stop', { offset: '0', 'stop-color': c1 }), s('stop', { offset: '0.5', 'stop-color': c2 }), s('stop', { offset: '1', 'stop-color': c1 })),
    s('pattern', { id: `hatch-${cert.id}`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
      s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: c1, 'stroke-width': 1, opacity: 0.18 })));
  svg.appendChild(defs);

  // paper + frame
  const paper = s('rect', { width: W, height: H, fill: PAPER });
  svg.appendChild(paper);
  svg.appendChild(s('rect', { x: 14, y: 14, width: W - 28, height: H - 28, fill: `url(#hatch-${cert.id})` }));
  svg.appendChild(s('rect', { x: 30, y: 30, width: W - 60, height: H - 60, fill: PAPER }));
  svg.appendChild(guilloche(c1));
  svg.appendChild(s('rect', { x: 14, y: 14, width: W - 28, height: H - 28, fill: 'none', stroke: `url(#cg-${cert.id})`, 'stroke-width': 8 }));
  svg.appendChild(s('rect', { x: 30, y: 30, width: W - 60, height: H - 60, fill: 'none', stroke: c1, 'stroke-width': 1.5 }));
  svg.appendChild(s('rect', { x: 38, y: 38, width: W - 76, height: H - 76, fill: 'none', stroke: c1, 'stroke-width': 0.6, 'stroke-dasharray': '1 4' }));
  svg.appendChild(pixelCorner(46, 46, 1, 1, c1));
  svg.appendChild(pixelCorner(W - 46, 46, -1, 1, c1));
  svg.appendChild(pixelCorner(46, H - 46, 1, -1, c1));
  svg.appendChild(pixelCorner(W - 46, H - 46, -1, -1, c1));

  // header
  const hy = 92;
  svg.appendChild(s('rect', { x: W / 2 - 208, y: hy - 26, width: 34, height: 34, rx: 7, fill: INK }));
  svg.appendChild(s('text', { x: W / 2 - 191, y: hy - 3, 'text-anchor': 'middle', 'font-family': ARCADE, 'font-size': 12, fill: '#A6E3A1' }, '>_'));
  svg.appendChild(s('text', { x: W / 2 - 160, y: hy - 3, 'font-family': ARCADE, 'font-size': 13, 'letter-spacing': 1.5, fill: INK }, 'CMDPRO CERTIFICATE AUTHORITY'));
  svg.appendChild(s('text', { x: W / 2, y: 140, 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 600, 'font-size': 13, 'letter-spacing': 5, fill: INK3 }, 'CERTIFICATE OF COMPETENCE'));

  // title
  let titleSize = 44;
  while (measure(cert.title, `300 ${titleSize}px "Geist Sans"`) > 820 && titleSize > 28) titleSize -= 2;
  svg.appendChild(s('text', { x: W / 2, y: 198, 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 300, 'font-size': titleSize, 'letter-spacing': -0.8, fill: INK }, cert.title));
  svg.appendChild(s('text', { x: W / 2, y: 244, 'text-anchor': 'middle', 'font-family': SANS, 'font-style': 'italic', 'font-size': 16, fill: INK2 }, 'This certifies that'));

  // name
  let nameSize = 52;
  while (measure(displayName, `600 ${nameSize}px "Geist Sans"`) > 760 && nameSize > 26) nameSize -= 2;
  svg.appendChild(s('text', { x: W / 2, y: 304, 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 600, 'font-size': nameSize, 'letter-spacing': -1, fill: ink1 }, displayName));
  svg.appendChild(s('line', { x1: 230, y1: 324, x2: W - 230, y2: 324, stroke: c1, 'stroke-width': 1.2 }));

  // body
  const bodyFont = '400 16.5px "Geist Sans"';
  const bodyText = cert.body.replace(/\{name\}/g, displayName).replace(/`/g, '');
  const lines = wrap(bodyText, bodyFont, 690).slice(0, 5);
  let by = 358;
  const body = s('text', { x: W / 2, y: by, 'text-anchor': 'middle', 'font-family': SANS, 'font-size': 16.5, fill: INK2 });
  lines.forEach((l, i) => body.appendChild(s('tspan', { x: W / 2, dy: i ? 25 : 0 }, l)));
  svg.appendChild(body);
  by += (lines.length - 1) * 25 + 40;
  svg.appendChild(s('text', { x: W / 2, y: by, 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 500, 'font-style': 'italic', 'font-size': 18, fill: ink1 }, `“${cert.slogan}”`));

  // avatar (left)
  const ax = 78, ay = 548, as = 150;
  svg.appendChild(s('rect', { x: ax - 6, y: ay - 6, width: as + 12, height: as + 12, rx: 14, fill: '#fff', stroke: c1, 'stroke-width': 2 }));
  svg.appendChild(s('rect', { x: ax, y: ay, width: as, height: as, rx: 9, fill: '#EFF1F5' }));
  const avImg = s('image', { href: avatarUrl(avatar), x: ax + 8, y: ay + 8, width: as - 16, height: as - 16, style: 'image-rendering: pixelated' });
  svg.appendChild(avImg);
  svg.appendChild(s('text', { x: ax + as / 2, y: ay + as + 28, 'text-anchor': 'middle', 'font-family': MONO, 'font-size': 13, fill: INK2 }, '@' + (handle || 'player')));
  const rankLabel = `RANK: ${cert.rank.toUpperCase()}`;
  const rw = measure(rankLabel, '9px "Press Start 2P"') + 22;
  svg.appendChild(s('rect', { x: ax + as / 2 - rw / 2, y: ay + as + 40, width: rw, height: 22, rx: 11, fill: INK }));
  svg.appendChild(s('text', { x: ax + as / 2, y: ay + as + 55, 'text-anchor': 'middle', 'font-family': ARCADE, 'font-size': 9, fill: '#A6E3A1' }, rankLabel));

  // X.509 block (center)
  const xx = 286, xy = 540;
  const mono = { 'font-family': MONO, 'font-size': 11, fill: INK2 };
  const fields = [
    ['Certificate:', ''],
    ['  Version:', '3 (0x2)'],
    ['  Serial Number:', entry.serial],
    ['  Signature Algorithm:', 'sha256WithBashEncryption'],
    ['  Issuer:', ISSUER.replace(', OU=', ',\n                OU=')],
    ['  Not Before:', x509Date(entry.date)],
    ['  Not After :', NOT_AFTER.replace(/`/g, '')],
    ['  Subject:', `CN=${displayName}, UID=${handle || 'player'}, OU=${cert.short}`],
    ['  Key Usage:', `critical, ${KEY_USAGE}`],
    ['  SHA-256 Fingerprint:', fp.slice(0, 47) + '\n                ' + fp.slice(48)],
  ];
  const xt = s('text', { x: xx, y: xy, ...mono, style: 'white-space: pre' });
  let li = 0;
  for (const [k, v] of fields) {
    const vl = String(v).split('\n');
    vl.forEach((part, pi) => {
      const ts = s('tspan', { x: xx, dy: li ? 15 : 0 });
      if (pi === 0) { ts.appendChild(s('tspan', { fill: INK, 'font-weight': 700 }, k)); ts.appendChild(document.createTextNode(' ' + part)); }
      else ts.appendChild(document.createTextNode(part));
      xt.appendChild(ts);
      li++;
    });
  }
  svg.appendChild(xt);

  // signatures
  const sy = 750;
  [[300, '/usr/bin/root', 'Chief Root Officer'], [590, 'Rocky the Rock', 'Head of Stability']].forEach(([sx, who, role]) => {
    svg.appendChild(s('path', { d: squiggle(hashNum(who + displayName), sx, sy - 22, 170), fill: 'none', stroke: INK, 'stroke-width': 1.6, 'stroke-linecap': 'round', opacity: 0.85 }));
    svg.appendChild(s('line', { x1: sx - 6, y1: sy, x2: sx + 196, y2: sy, stroke: INK3, 'stroke-width': 0.8 }));
    svg.appendChild(s('text', { x: sx + 95, y: sy + 16, 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 600, 'font-size': 12, fill: INK }, who));
    svg.appendChild(s('text', { x: sx + 95, y: sy + 30, 'text-anchor': 'middle', 'font-family': SANS, 'font-size': 10.5, fill: INK3 }, role));
  });

  // seal (right) + fallback
  const scx = 946, scy = 640, sr = 92;
  const sealGroup = s('g', null);
  const sealImg = s('image', { href: sealUrl(cert.id), x: scx - sr, y: scy - sr, width: sr * 2, height: sr * 2 });
  sealImg.addEventListener('error', () => { sealImg.remove(); sealGroup.appendChild(fallbackSeal(scx, scy, sr * 0.82, c1, c2, cert.short)); }, { once: true });
  sealGroup.appendChild(sealImg);
  svg.appendChild(sealGroup);

  // difficulty stamp
  const stampW = Math.max(150, measure(stamp.label, '12px "Press Start 2P"') + 36);
  const stampG = s('g', { transform: `rotate(-12 ${scx - 10} 506)`, opacity: 0.88 });
  stampG.appendChild(s('rect', { x: scx - 10 - stampW / 2, y: 478, width: stampW, height: 56, rx: 8, fill: 'none', stroke: stamp.color, 'stroke-width': 3 }));
  stampG.appendChild(s('rect', { x: scx - 10 - stampW / 2 + 5, y: 483, width: stampW - 10, height: 46, rx: 5, fill: 'none', stroke: stamp.color, 'stroke-width': 1 }));
  stampG.appendChild(s('text', { x: scx - 10, y: 500, 'text-anchor': 'middle', 'font-family': SANS, 'font-weight': 700, 'font-size': 9, 'letter-spacing': 3, fill: stamp.color }, 'DIFFICULTY'));
  stampG.appendChild(s('text', { x: scx - 10, y: 521, 'text-anchor': 'middle', 'font-family': ARCADE, 'font-size': 12, fill: stamp.color }, stamp.label));
  svg.appendChild(stampG);

  // footer
  svg.appendChild(s('text', { x: 82, y: 798, 'font-family': SANS, 'font-size': 11, fill: INK3 },
    `Issued ${fmtDate(entry.date)}  ·  Score ${Math.round(entry.score || 0).toLocaleString('en-US')}  ·  ${cert.metal} grade`));
  svg.appendChild(s('text', { x: W / 2 + 40, y: 798, 'text-anchor': 'middle', 'font-family': SANS, 'font-style': 'italic', 'font-size': 11, fill: INK3 },
    'This certificate is self-signed and trusted by absolutely no browser.'));
  svg.appendChild(barcode(entry.serial, 878, 758, 140, 22, INK));
  svg.appendChild(s('text', { x: 948, y: 792, 'text-anchor': 'middle', 'font-family': MONO, 'font-size': 8, fill: INK3 }, entry.serial.replace(/:/g, '').slice(0, 24)));

  if (locked) {
    // everything but the paper goes grey and faint, under a tiled watermark and a big stamp
    defs.appendChild(s('filter', { id: `dim-${cert.id}` }, s('feColorMatrix', { type: 'saturate', values: '0.15' })));
    defs.appendChild(s('pattern', { id: `wm-${cert.id}`, width: 300, height: 110, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-18)' },
      s('text', { x: 12, y: 62, 'font-family': ARCADE, 'font-size': 14, 'letter-spacing': 2, fill: INK, opacity: 0.16 }, 'NOT EARNED')));
    const content = s('g', { filter: `url(#dim-${cert.id})`, opacity: 0.35 });
    for (const n of [...svg.childNodes]) if (n !== defs && n !== paper) content.appendChild(n);
    svg.appendChild(content);
    svg.appendChild(s('rect', { width: W, height: H, fill: `url(#wm-${cert.id})` }));
    const stampText = { 'text-anchor': 'middle', 'font-family': ARCADE, fill: '#D20F39', stroke: PAPER, 'paint-order': 'stroke' };
    svg.appendChild(s('g', { transform: `rotate(-18 ${W / 2} ${H / 2})`, opacity: 0.72 },
      s('text', { x: W / 2, y: H / 2 + 26, 'font-size': 84, 'letter-spacing': 2, 'stroke-width': 8, ...stampText }, 'NOT EARNED'),
      s('text', { x: W / 2, y: H / 2 + 84, 'font-size': 16, 'letter-spacing': 3, 'stroke-width': 4, ...stampText }, 'SPECIMEN · CSR PENDING')));
  }
  return svg;
}

// ---------- print & download ----------
export function printCertificate(svg) {
  if (svg.getAttribute('data-locked')) return;   // a certificate that isn't earned never prints
  const root = h('div', { class: 'print-root' });
  const clone = svg.cloneNode(true);
  clone.removeAttribute('style');
  root.appendChild(clone);
  document.body.appendChild(root);
  document.documentElement.classList.add('printing');
  const done = () => {
    document.documentElement.classList.remove('printing');
    root.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(() => {
    try { window.print(); } finally { setTimeout(() => { if (root.isConnected && !matchMedia('print').matches) done(); }, 1500); }
  }, 60);
}

async function toDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('fetch failed');
  const blob = await res.blob();
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
}

async function embeddedFonts() {
  try {
    const css = await (await fetch('assets/fonts/fonts.css')).text();
    const want = [['Geist Sans', ['300', '400', '500', '600']], ['Cardondev Mono', ['400']], ['Press Start 2P', ['400']]];
    const blocks = css.match(/@font-face\s*{[^}]*}/g) || [];
    let out = '';
    for (const b of blocks) {
      const fam = (b.match(/font-family:\s*'([^']+)'/) || [])[1];
      const weight = (b.match(/font-weight:\s*(\d+)/) || [])[1] || '400';
      const url = (b.match(/url\('([^']+)'\)/) || [])[1];
      const range = b.match(/unicode-range:[^;]+;/);
      if (!fam || !url || /font-style:\s*italic/.test(b)) continue;
      const spec = want.find(w => w[0] === fam);
      if (!spec || !spec[1].includes(weight)) continue;
      if (range && /0100-02BA/.test(range[0])) continue; // skip latin-ext subset
      const data = await toDataUrl(new URL(url, new URL('assets/fonts/', location.href)).href);
      out += `@font-face{font-family:'${fam}';font-weight:${weight};src:url(${data}) format('woff2');}\n`;
    }
    return out;
  } catch { return ''; }
}

export async function downloadCertificate(svg, filename) {
  if (svg.getAttribute('data-locked')) throw new Error('earn this certificate to save it');
  const clone = svg.cloneNode(true);
  clone.setAttribute('width', '11in');
  clone.setAttribute('height', '8.5in');
  for (const img of clone.querySelectorAll('image')) {
    const href = img.getAttribute('href');
    if (href && !href.startsWith('data:')) {
      try { img.setAttribute('href', await toDataUrl(href)); } catch { img.remove(); }
    }
  }
  const fonts = await embeddedFonts();
  if (fonts) {
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = fonts;
    clone.insertBefore(style, clone.firstChild);
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  downloadBlob(new Blob([xml], { type: 'image/svg+xml' }), filename);
}
