// Apply settings to the document (theme, CRT, motion, font size) and keep them in sync.
import { store } from './state.js';
import { refreshAudio } from './audio.js';
import { THEME_IDS, THEME_COLOR, DEFAULT_THEME } from '../data/themes.js';

export function applySettings() {
  const s = store.state.settings;
  const root = document.documentElement;
  const theme = THEME_IDS.includes(s.theme) ? s.theme : DEFAULT_THEME;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-crt', s.crt === false ? 'off' : 'on');
  if (s.reduceMotion) root.setAttribute('data-motion', 'reduce'); else root.removeAttribute('data-motion');
  root.style.setProperty('--term-font-size', (s.fontSize || 15) + 'px');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme] || '#1E1E2E');
  refreshAudio();
}

export function setSetting(path, value) {
  store.update(st => {
    const keys = path.split('.');
    let o = st.settings;
    for (const k of keys.slice(0, -1)) o = (o[k] ||= {});
    o[keys[keys.length - 1]] = value;
  });
  applySettings();
}
