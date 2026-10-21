// Minimal hash router: #/name/arg1/arg2?query. Screens are lazy ES modules
// exporting render(route) → { el, destroy?(), mounted?() }.
import { clear } from './dom.js';

const routes = Object.create(null);
let current = null;
let token = 0;
let fallback = 'title';

export function route(name, loader) { routes[name] = loader; }
export function setFallback(name) { fallback = name; }

export function parse(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  const parts = path.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  return { name: parts[0] || fallback, args: parts.slice(1), query, path };
}

export function go(path, { replace = false } = {}) {
  const target = '#/' + String(path).replace(/^#?\/?/, '');
  if (replace) { history.replaceState(null, '', target); render(); }
  else if (location.hash === target) render();
  else location.hash = target;
}

export function currentRoute() { return parse(); }
export function currentScreen() { return current; }

export async function render() {
  const r = parse();
  const my = ++token;
  const loader = routes[r.name] || routes[fallback];
  let mod;
  try { mod = await loader(); } catch (e) {
    console.error('route load failed', r.name, e);
    // Usually a newer build than the one this page is running (an update was deployed, or the
    // service worker swapped in a new version): the new screen needs exports the modules already
    // loaded here lack. Reload once to pick up the whole new build; a second failure falls back.
    if (reloadOnce()) return;
    mod = await routes[fallback]();
  }
  if (my !== token) return;
  let res;
  try { res = await mod.render(r); } catch (e) { console.error('screen render failed', r.name, e); return; }
  if (my !== token) { res?.destroy?.(); return; }
  try { current?.destroy?.(); } catch (e) { console.warn(e); }
  const app = document.getElementById('app');
  clear(app);
  current = res;
  app.appendChild(res.el);
  window.scrollTo(0, 0);
  try { res.mounted?.(); } catch (e) { console.error(e); }
  document.dispatchEvent(new CustomEvent('cmdpro:route', { detail: r }));
}

function reloadOnce() {
  try {
    const last = +sessionStorage.getItem('cmdpro.reloadedAt') || 0;
    if (Date.now() - last < 30000) return false;
    sessionStorage.setItem('cmdpro.reloadedAt', String(Date.now()));
  } catch { return false; } // storage blocked: a reload loop could not be ruled out
  location.reload();
  return true;
}

export function startRouter() {
  window.addEventListener('hashchange', render);
  return render();
}
