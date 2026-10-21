// Persistent game state (localStorage `cmdpro.v1`), with an in-memory fallback
// so the game keeps working when storage is blocked (private mode, sandboxed iframes…).
import { RENAMED } from '../data/campaign.gen.js';

const KEY = 'cmdpro.v1';

export const DEFAULT_SETTINGS = {
  theme: 'catppuccin-mocha',
  crt: true,
  fontSize: 15,
  reduceMotion: false,
  sound: { master: true, sfx: true, music: true, typing: true, volume: 0.7 },
};

function defaults() {
  return {
    v: 1,
    profile: { handle: '', certName: '', avatar: 'tee-m', created: null },
    settings: structuredClone(DEFAULT_SETTINGS),
    slots: { campaign: {}, bonus: {}, oops: {}, '12days': {}, halloween: {}, thanksgiving: {}, christmas: {} },
    certs: {},
    freeplay: { solved: {}, given: {} },
    stats: { commands: 0, solved: 0, wrong: 0, gameOvers: 0, hints: 0, playMs: 0, firstPlay: null },
    highscores: { easy: [], normal: [], hard: [], extreme: [] },
    seen: {},
  };
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

let state = defaults();
let storageOk = true;
const listeners = new Set();
let saveTimer = null;

// Challenges that were rewritten under a new slug carry the player's progress over.
function migrate(st) {
  const ren = (id) => (id && RENAMED[id]) || id;
  for (const k of ['solved', 'given']) {
    const o = st.freeplay?.[k];
    if (!o) continue;
    for (const [id, v] of Object.entries(o)) {
      const n = ren(id);
      if (n !== id) { if (!(n in o)) o[n] = v; delete o[id]; }
    }
  }
  for (const kind of Object.values(st.slots || {})) {
    for (const slot of Object.values(kind || {})) {
      if (!slot || typeof slot !== 'object') continue;
      if (slot.current?.id) slot.current.id = ren(slot.current.id);
      for (const e of slot.log || []) if (e) e.id = ren(e.id);
    }
  }
  return st;
}

export function load() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) state = migrate(deepMerge(defaults(), JSON.parse(raw)));
  } catch {
    storageOk = false;
  }
  return state;
}

function persist() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
    storageOk = true;
  } catch {
    storageOk = false;
  }
}

export function saveNow() { clearTimeout(saveTimer); persist(); }

export const store = {
  get state() { return state; },
  get storageOk() { return storageOk; },
  /** Mutate state through a function, then persist (debounced) and notify. */
  update(fn, { immediate = false } = {}) {
    fn(state);
    if (immediate) saveNow();
    else { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 250); }
    for (const l of listeners) { try { l(state); } catch (e) { console.warn(e); } }
    return state;
  },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  exportJSON() {
    return JSON.stringify({ app: 'cmdpro', exported: new Date().toISOString(), state }, null, 2);
  },
  importJSON(text) {
    const parsed = JSON.parse(text);
    const incoming = parsed && parsed.state ? parsed.state : parsed;
    if (!incoming || typeof incoming !== 'object' || incoming.v !== 1) throw new Error('Not a CMDPRO save file (v1).');
    state = migrate(deepMerge(defaults(), incoming));
    terminals.clear();
    saveNow();
    for (const l of listeners) l(state);
  },
  resetProgress() {
    const keep = { profile: state.profile, settings: state.settings };
    state = { ...defaults(), ...keep };
    terminals.clear();
    saveNow();
    for (const l of listeners) l(state);
  },
};

// ---- saved terminals: scrollback + command history per run (key "kind/difficulty") ----
// Kept under their own key so a full quota here can never block saving progress, and left
// out of exported save files (they are a convenience: progress lives in the main state).
const TERM_KEY = 'cmdpro.v1.term';
let termCache = null;
function termAll() {
  if (termCache) return termCache;
  try { termCache = JSON.parse(window.localStorage.getItem(TERM_KEY) || '{}'); } catch { termCache = {}; }
  if (!termCache || typeof termCache !== 'object' || Array.isArray(termCache)) termCache = {};
  return termCache;
}
export const terminals = {
  get(key) { return termAll()[key] || null; },
  /** Store (or with null, drop) one saved terminal. Returns false when the browser refuses. */
  set(key, value) {
    const all = termAll();
    if (value) all[key] = value; else delete all[key];
    try { window.localStorage.setItem(TERM_KEY, JSON.stringify(all)); return true; } catch { return false; }
  },
  clear() {
    termCache = {};
    try { window.localStorage.removeItem(TERM_KEY); } catch { /* storage blocked */ }
  },
};

// ---- session (tab) flags: boot sequence once per session ----
export const session = {
  get(k) { try { return sessionStorage.getItem('cmdpro.' + k); } catch { return session._mem[k] ?? null; } },
  set(k, v) { try { sessionStorage.setItem('cmdpro.' + k, v); } catch { session._mem[k] = v; } },
  _mem: {},
};

// ---- per-session command history (shared across challenges, like a real shell) ----
export const history = { lines: [] };
