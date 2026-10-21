// Audio manager: SFX via WebAudio buffers (low latency), music via <audio>
// routed through a WebAudio gain node (so volume works on iOS too).
// Everything is a silent no-op until the first user gesture, and when the
// sound manifest or files are missing.
import { store } from './state.js';

let SFX = {}, MUSIC = {}, VARIANTS = {};
let ctx = null, master = null, unlocked = false;
const buffers = new Map();
let musicEl = null, musicGain = null, musicId = null, wantMusic = null;
let lastTyping = 0;

const snd = () => store.state.settings.sound;
const canSfx = () => snd().master && snd().sfx;
const canMusic = () => snd().master && snd().music;

export async function initAudio() {
  try {
    const m = await import('../data/sounds.js');
    SFX = m.SFX || {}; MUSIC = m.MUSIC || {}; VARIANTS = m.SFX_VARIANTS || {};
  } catch { /* no sound manifest yet: stay silent */ }
  const unlock = () => {
    if (unlocked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.connect(ctx.destination);
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      unlocked = true;
      for (const id of ['key', 'key-alt', 'enter', 'menu-move', 'menu-select', 'success', 'fail']) getBuffer(id);
      if (wantMusic) music(wantMusic);
    } catch { /* audio unavailable */ }
    if (unlocked) for (const ev of ['pointerdown', 'keydown', 'touchend']) window.removeEventListener(ev, unlock, true);
  };
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, true);
  document.addEventListener('visibilitychange', () => {
    if (!musicEl) return;
    if (document.hidden) musicEl.pause();
    else if (canMusic()) musicEl.play().catch(() => {});
  });
}

function getBuffer(id) {
  const def = SFX[id];
  if (!def || !ctx) return Promise.resolve(null);
  if (!buffers.has(id)) {
    buffers.set(id, fetch(def.file)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
      .then(ab => new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej)))
      .catch(() => null));
  }
  return buffers.get(id);
}

/** Play a sound effect by id. opts: { rate, gain } */
export function play(id, { rate = 1, gain = 1 } = {}) {
  if (!unlocked || !ctx || !canSfx()) return;
  const variants = VARIANTS[id];
  const real = variants ? variants[Math.floor(Math.random() * variants.length)] : id;
  const def = SFX[real];
  if (!def) return;
  getBuffer(real).then(buf => {
    if (!buf) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = (def.volume ?? 1) * gain * snd().volume;
      src.connect(g).connect(master);
      src.start();
    } catch { /* ignore */ }
  });
}

/** Mechanical keyboard click with a little pitch wobble; throttled. */
export function typing() {
  if (!snd().typing) return;
  const now = performance.now();
  if (now - lastTyping < 26) return;
  lastTyping = now;
  play('key', { rate: 0.9 + Math.random() * 0.2, gain: 0.85 });
}

function rampMusic(target, ms) {
  if (!musicGain || !ctx) return;
  const t = ctx.currentTime;
  musicGain.gain.cancelScheduledValues(t);
  musicGain.gain.setValueAtTime(musicGain.gain.value, t);
  musicGain.gain.linearRampToValueAtTime(target, t + ms / 1000);
}

function stopMusic(fadeMs = 500) {
  const el = musicEl, g = musicGain;
  musicEl = null; musicGain = null; musicId = null;
  if (!el) return;
  if (g && ctx) {
    const t = ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0, t + fadeMs / 1000);
  }
  setTimeout(() => { try { el.pause(); el.src = ''; } catch {} }, fadeMs + 50);
}

const blobUrls = new Map();
function musicUrl(file) {
  if (!blobUrls.has(file)) {
    blobUrls.set(file, fetch(file)
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
      .then(b => URL.createObjectURL(b))
      .catch(() => file));
  }
  return blobUrls.get(file);
}

/** Switch background music (null = silence). Remembers the request until audio unlocks. */
export function music(id) {
  wantMusic = id;
  if (!unlocked || !ctx) return;
  if (!id || !canMusic() || !MUSIC[id]) { stopMusic(); return; }
  if (musicId === id && musicEl) return;
  stopMusic();
  const def = MUSIC[id];
  const el = new Audio();
  el.loop = def.loop !== false;
  el.preload = 'auto';
  let gain;
  try {
    const srcNode = ctx.createMediaElementSource(el);
    gain = ctx.createGain();
    gain.gain.value = 0;
    srcNode.connect(gain).connect(master);
  } catch { gain = null; el.volume = (def.volume ?? 0.5) * snd().volume; }
  musicEl = el; musicGain = gain; musicId = id;
  // Fetch the whole file (cacheable by the service worker → music works offline).
  musicUrl(def.file).then(url => {
    if (musicEl !== el) return;
    el.src = url;
    el.play().then(() => rampMusic((def.volume ?? 0.5) * snd().volume, 700)).catch(() => {});
  });
  if (!el.loop) el.addEventListener('ended', () => { if (musicEl === el) { musicEl = null; musicId = null; musicGain = null; wantMusic = null; } });
}

/** Re-apply settings (volume / toggles) to whatever is playing. */
export function refreshAudio() {
  if (!unlocked) return;
  if (!canMusic()) { if (musicEl) stopMusic(200); return; }
  if (wantMusic && !musicEl) { music(wantMusic); return; }
  if (musicEl && MUSIC[musicId]) rampMusic((MUSIC[musicId].volume ?? 0.5) * snd().volume, 150);
}

export function currentMusic() { return musicId; }
export function hasSound() { return Object.keys(SFX).length > 0; }
