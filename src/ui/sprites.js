// Sprite catalogue (avatars, companions, certificate seals) with graceful fallbacks
// while the art is still being produced.
import { h } from './dom.js';

let mod = {};
let loaded = false;

const FALLBACK_AVATARS = [
  ['ninja-m', 'Ninja Dave', 'm'], ['ninja-f', 'Ninja Nina', 'f'],
  ['cool-m', 'Chill Steve', 'm'], ['cool-f', 'Chill Chloe', 'f'],
  ['hoodie-m', 'Cozy Don', 'm'], ['hoodie-f', 'Cozy James', 'f'],
  ['hacker-m', 'Midnight Juan', 'm'], ['hacker-f', 'Midnight Mia', 'f'],
  ['suit-m', 'Boardroom Ben', 'm'], ['suit-f', 'Boardroom Bree', 'f'],
  ['tie-m', 'Dapper Dev', 'm'], ['tie-f', 'Dapper Dee', 'f'],
  ['tee-m', 'Weekend Hunter', 'm'], ['tee-f', 'Weekend Ally', 'f'],
  ['robot', 'Robo', null], ['cat', 'Cool Cat', null], ['dog', 'Mad Dog', null], ['trex', 'T-Rex', null],
].map(([id, name, variant]) => ({ id, name, group: variant ? 'human' : 'other', variant, file: `assets/avatars/${id}.svg` }));

export async function loadSprites() {
  if (loaded) return mod;
  try { mod = await import('../data/sprites.js'); } catch { mod = {}; }
  loaded = true;
  return mod;
}

export function avatars() { return mod.AVATARS && mod.AVATARS.length ? mod.AVATARS : FALLBACK_AVATARS; }
export function avatarMeta(id) { return avatars().find(a => a.id === id) || avatars().find(a => a.id === 'tee-m') || avatars()[0]; }
export function avatarUrl(id) { return avatarMeta(id)?.file || `assets/avatars/${id}.svg`; }

export function companionUrl(id) {
  const c = (mod.COMPANION_SPRITES || []).find(x => x.id === id);
  return c?.file || `assets/companions/${id}.svg`;
}

export function holidayIconUrl(id) {
  return (mod.HOLIDAY_ICONS && mod.HOLIDAY_ICONS[id]) || `assets/holiday/icons/${id}.svg`;
}
export function holidayIcon(id, { cls = '' } = {}) {
  return id ? spriteImg(holidayIconUrl(id), { alt: '', cls: 'holiday-icon ' + cls, label: '*' }) : null;
}

export function sealUrl(certId) {
  return (mod.SEALS && mod.SEALS[certId]) || `assets/certs/seal-${certId}.svg`;
}

/** Tiny pixel placeholder (data URI) — used when an image fails to load. */
export function placeholder(label = '>_', bg = '#45475A', fg = '#A6E3A1') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges"><rect width="32" height="32" rx="4" fill="${bg}"/><text x="16" y="21" font-family="monospace" font-size="12" font-weight="700" text-anchor="middle" fill="${fg}">${label.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

export function spriteImg(url, { alt = '', cls = '', label = '>_', size } = {}) {
  const img = h('img', { src: url, alt, class: 'pixel ' + cls, width: size || null, height: size || null, decoding: 'async', draggable: 'false' });
  img.addEventListener('error', () => { if (!img.dataset.fallback) { img.dataset.fallback = '1'; img.src = placeholder(label); } }, { once: true });
  return img;
}

export function avatarImg(id, opts = {}) { return spriteImg(avatarUrl(id), { alt: avatarMeta(id)?.name || id, label: '@', ...opts }); }
export function companionImg(id, opts = {}) { return spriteImg(companionUrl(id), { alt: id, label: id[0].toUpperCase(), ...opts }); }
