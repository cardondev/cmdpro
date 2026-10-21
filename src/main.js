// CMDPRO bootstrap: state → settings → audio/sprites → router.
import { load, store, session } from './game/state.js';
import { applySettings } from './game/settings.js';
import { initAudio } from './game/audio.js';
import { loadSprites } from './ui/sprites.js';
import { route, startRouter, setFallback, go } from './ui/router.js';
import { engine } from './game/engine.js';

// Local development (the #/dev QA hub, no service worker unless ?sw=1).
const LOCAL = /^(localhost|127\.|\[::1\]$)|\.localhost$/.test(location.hostname);

load();
applySettings();
initAudio();

const screens = {
  boot: () => import('./ui/screens/boot.js'),
  title: () => import('./ui/screens/title.js'),
  setup: () => import('./ui/screens/setup.js'),
  difficulty: () => import('./ui/screens/difficulty.js'),
  map: () => import('./ui/screens/map.js'),
  briefing: () => import('./ui/screens/briefing.js'),
  play: () => import('./ui/screens/play.js'),
  practice: () => import('./ui/screens/play.js'),
  gameover: () => import('./ui/screens/gameover.js'),
  ceremony: () => import('./ui/screens/ceremony.js'),
  wall: () => import('./ui/screens/wall.js'),
  cert: () => import('./ui/screens/cert.js'),
  settings: () => import('./ui/screens/settings.js'),
  freeplay: () => import('./ui/screens/freeplay.js'),
  sidequests: () => import('./ui/screens/sidequests.js'),
  editions: () => import('./ui/screens/editions.js'),
  credits: () => import('./ui/screens/credits.js'),
  tutorial: () => import('./ui/screens/tutorial.js'),
  training: () => import('./ui/screens/play.js'),
};
// The QA hub (#/dev) is for local development only: published builds leave it out.
if (LOCAL) screens.dev = () => import('./ui/screens/dev.js');
for (const [name, loader] of Object.entries(screens)) route(name, loader);
setFallback('title');

// Keep the whole UI in sync with settings changes made anywhere.
store.subscribe(() => applySettings());

// Esc = back, on the simple screens (game/arcade screens handle their own keys).
const ESC_BACK = { settings: 'title', wall: 'title', cert: 'wall', freeplay: 'title', sidequests: 'title', editions: 'title', credits: 'title', setup: 'title', dev: 'title', tutorial: 'title' };
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.modal-backdrop')) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const name = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]) || 'title';
  if (ESC_BACK[name]) { e.preventDefault(); go(ESC_BACK[name]); }
});

(async () => {
  await loadSprites();
  const q = new URLSearchParams(location.search);
  const skipBoot = q.has('skipboot') || q.has('dev') || session.get('booted');
  if (!location.hash || location.hash === '#' || location.hash === '#/') {
    history.replaceState(null, '', skipBoot ? '#/title' : '#/boot');
  }
  await startRouter();
  // Warm up the engine worker in the background so the first command is instant.
  setTimeout(() => { try { engine(); } catch (e) { console.warn('engine init failed', e); } }, 300);
})();

// Service worker: offline play on GitHub Pages / any https host. Skipped on
// localhost during development (avoids stale caches) unless ?sw=1.
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  if (!LOCAL || new URLSearchParams(location.search).has('sw')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
    });
  }
}
