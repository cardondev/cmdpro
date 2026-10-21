// Coach marks: the tutorial's guided tour. Each step spotlights a piece of the real UI and
// explains it; "do it" steps wait until the player has actually done the thing (a
// `cmdpro:play` event from the game screen). The layer sits above the screens but below
// modals and toasts, and lives on across route changes. Leaving the tour's path (browser
// back, the Menu button) ends it, and so do Esc and the × button.
import { h, icon } from './dom.js';
import { md } from './markdown.js';
import { go, currentRoute } from './router.js';
import { play } from '../game/audio.js';

let T = null; // the running tour
const PAD = 8; // spotlight padding around the target
const GAP = 12; // bubble distance from the target / viewport edge

export const tourRunning = () => !!T;

/**
 * startTour({ steps, ctx, onChapterDone(id), onEnd(reason, step) })
 * reason: 'done' (finished), 'skipped' (Esc / ×), 'left' (the player navigated away).
 */
export function startTour({ steps, ctx = {}, onChapterDone, onEnd }) {
  stopTour(null);
  T = { steps, ctx, onChapterDone, onEnd, i: -1, token: 0, waiting: false, satisfied: false, navigating: null, last: '', raf: 0 };
  const blocks = Array.from({ length: 5 }, () => h('div', {
    class: 'coach-block', hidden: true,
    onmousedown: (e) => e.preventDefault(), // keep the focus (e.g. in the terminal)
    onclick: () => nudge(),
  }));
  const spot = h('div', { class: 'coach-spot', hidden: true });
  const dim = h('div', { class: 'coach-dim', hidden: true });
  const bubble = h('section', { class: 'coach-bubble', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'coach-title', hidden: true });
  const layer = h('div', { class: 'coach' }, dim, spot, ...blocks, bubble);
  document.body.appendChild(layer);
  Object.assign(T, { layer, spot, dim, blocks, bubble });
  document.addEventListener('cmdpro:play', onPlay);
  document.addEventListener('cmdpro:route', onRoute);
  window.addEventListener('keydown', onKey, true);
  T.raf = requestAnimationFrame(frame);
  goStep(0, 1);
}

export function stopTour(reason = 'skipped') {
  if (!T) return;
  const t = T;
  T = null;
  cancelAnimationFrame(t.raf);
  document.removeEventListener('cmdpro:play', onPlay);
  document.removeEventListener('cmdpro:route', onRoute);
  window.removeEventListener('keydown', onKey, true);
  t.layer.remove();
  if (reason) t.onEnd?.(reason, t.steps[t.i]);
}

// ---------------------------------------------------------------- steps
const routeOf = (step) => (typeof step.route === 'function' ? step.route(T.ctx) : step.route) || null;
const pathOf = (route) => route.split('?')[0];
const visibleEl = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
};
/** The box around a step's target: one selector, or several (their visible parts, joined). */
function targetRect(step) {
  let b = null;
  for (const sel of [].concat(step.target || [])) {
    const el = visibleEl(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    b = b ? { left: Math.min(b.left, r.left), top: Math.min(b.top, r.top), right: Math.max(b.right, r.right), bottom: Math.max(b.bottom, r.bottom) }
      : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  if (b) { b.width = b.right - b.left; b.height = b.bottom - b.top; }
  return b;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end || !T) return v;
    await sleep(50);
  }
}

async function goStep(i, dir) {
  if (!T) return;
  const tok = ++T.token;
  const step = T.steps[i];
  if (!step) { stopTour('done'); return; }
  const prev = T.steps[T.i];
  if (prev && dir > 0 && prev.chapter !== step.chapter) T.onChapterDone?.(prev.chapter);
  T.i = i;
  T.waiting = false;
  T.satisfied = false;
  T.bubble.inert = true; // no double clicks while the next step gets ready
  const route = routeOf(step);
  if (route && currentRoute().path !== pathOf(route)) {
    T.bubble.hidden = true;
    T.navigating = pathOf(route);
    go(route);
    await waitUntil(() => T && T.navigating === null, 8000);
  }
  if (!T || tok !== T.token) return;
  if (step.skipIf?.()) { goStep(i + dir, dir); return; }
  await step.before?.();
  if (step.target) {
    // wait for the screen to draw it; a target this layout hides (phones) gets a centered bubble
    await waitUntil(() => document.querySelector([].concat(step.target)[0]), 2500);
    await waitUntil(() => targetRect(step), 400);
  }
  if (!T || tok !== T.token) return;
  render(step);
  const tr = step.target && targetRect(step);
  if (tr) reveal(tr);
  if (step.wait) {
    T.waiting = true;
    if (step.done?.()) satisfy();
  }
  const focus = step.focus && document.querySelector(step.focus);
  setTimeout(() => {
    if (!T || tok !== T.token) return;
    if (focus) focus.focus({ preventScroll: true });
    else T.bubble.querySelector('.coach-next')?.focus({ preventScroll: true });
  }, 60);
}

/** Scroll a target box into view below the sticky top bar (phones: to the top, above the sheet). */
function reveal(r) {
  const top = (document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0) + GAP;
  if (r.top >= top && r.bottom <= innerHeight - GAP) return;
  const room = innerHeight - top - GAP;
  const narrow = document.documentElement.clientWidth < 640;
  const delta = narrow || r.height >= room ? r.top - top : r.top - top - (room - r.height) / 2;
  const reduce = document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollBy({ top: delta, behavior: reduce ? 'auto' : 'smooth' });
}

/** Index of the step before i that Back may return to (-1 if none). */
function backIndex(i) {
  const step = T.steps[i];
  const prev = T.steps[i - 1];
  if (!prev || step.noBack || prev.wait || prev.chapter !== step.chapter) return -1;
  return i - 1;
}

function satisfy() {
  if (!T || T.satisfied) return;
  T.satisfied = true;
  T.waiting = false;
  T.bubble.classList.add('satisfied');
  play('toggle');
  const tok = T.token;
  setTimeout(() => { if (T && T.token === tok) goStep(T.i + 1, 1); }, 900);
}

function nudge() {
  if (!T) return;
  const b = T.bubble;
  b.classList.remove('nudge');
  void b.offsetWidth;
  b.classList.add('nudge');
}

// ---------------------------------------------------------------- bubble
function render(step) {
  const { bubble } = T;
  const last = T.i === T.steps.length - 1;
  const back = backIndex(T.i);
  const next = h('button', { type: 'button', class: 'btn btn-primary btn-sm coach-next', onclick: () => { if (bubble.inert) return; play('menu-move'); goStep(T.i + 1, 1); } },
    step.wait ? 'Skip' : last ? 'Finish' : 'Next', !step.wait && !last && icon('chevron-right'));
  let foot;
  if (step.actions) {
    foot = h('div', { class: 'coach-foot coach-actions' }, step.actions.map((a, k) => h('button', {
      type: 'button', class: `btn btn-${a.variant || (k ? 'muted' : 'primary')} btn-sm${k ? '' : ' coach-next'}`,
      onclick: () => { stopTour('done'); a.run(); },
    }, a.icon && icon(a.icon), a.label)));
  } else {
    foot = h('div', { class: 'coach-foot' },
      back >= 0 ? h('button', { type: 'button', class: 'btn btn-muted btn-sm', onclick: () => { if (bubble.inert) return; play('menu-move'); goStep(back, -1); } }, icon('chevron-left'), 'Back')
        : step.wait ? h('span', { class: 'coach-turn' }, h('span', { class: 'coach-pulse' }), 'Your turn') : h('span'),
      (!step.wait || step.optional) && next);
  }
  bubble.replaceChildren(
    h('div', { class: 'coach-head' },
      h('span', { class: 'eyebrow' }, step.chapterTitle || 'Tutorial'),
      step.of && h('span', { class: 'coach-count mono' }, `${step.pos}/${step.of}`),
      h('button', { type: 'button', class: 'coach-x', 'aria-label': 'End the tour', 'data-tip': 'End the tour (Esc)', onclick: () => stopTour('skipped') }, icon('close'))),
    h('h3', { class: 'coach-title', id: 'coach-title' }, step.title),
    md(step.body, 'md coach-body'),
    step.task ? h('div', { class: 'coach-task' }, h('span', { class: 'coach-check' }, icon('check')), md(step.task, 'md')) : '',
    foot);
  bubble.classList.toggle('waiting', !!step.wait);
  bubble.classList.remove('satisfied', 'nudge');
  bubble.hidden = false;
  bubble.inert = false;
  T.last = '';
}

// ---------------------------------------------------------------- layout (every frame)
function frame() {
  if (!T) return;
  T.raf = requestAnimationFrame(frame);
  const step = T.steps[T.i];
  if (!step || T.bubble.hidden) {
    if (T.last !== 'hidden') { T.last = 'hidden'; T.spot.hidden = true; T.dim.hidden = true; T.blocks.forEach(b => { b.hidden = true; }); }
    return;
  }
  const r = step.target ? targetRect(step) : null;
  const vw = document.documentElement.clientWidth, vh = innerHeight;
  const bw = T.bubble.offsetWidth, bh = T.bubble.offsetHeight;
  const key = (r ? [r.left, r.top, r.width, r.height].map(Math.round).join(',') : 'center') + `|${vw},${vh},${bw},${bh}`;
  if (key === T.last) return;
  T.last = key;
  layout(step, r, vw, vh, bw, bh);
}

function box(el, x, y, w, hgt) {
  el.hidden = false;
  el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.width = Math.max(0, w) + 'px'; el.style.height = Math.max(0, hgt) + 'px';
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

function layout(step, r, vw, vh, bw, bh) {
  const { spot, dim, blocks, bubble } = T;
  const narrow = vw < 640;
  bubble.classList.toggle('docked', narrow);
  if (!r) {
    spot.hidden = true;
    dim.hidden = false;
    box(blocks[0], 0, 0, vw, vh);
    blocks.slice(1).forEach(b => { b.hidden = true; });
    bubble.style.left = (narrow ? GAP : Math.round((vw - bw) / 2)) + 'px';
    bubble.style.top = Math.round(Math.max(GAP, (vh - bh) / 2)) + 'px';
    return;
  }
  dim.hidden = true;
  const x = Math.max(0, r.left - PAD), y = Math.max(0, r.top - PAD);
  const x2 = Math.min(vw, r.right + PAD), y2 = Math.min(vh, r.bottom + PAD);
  box(spot, x, y, x2 - x, y2 - y);
  box(blocks[0], 0, 0, vw, y);
  box(blocks[1], 0, y2, vw, vh - y2);
  box(blocks[2], 0, y, x, y2 - y);
  box(blocks[3], x2, y, vw - x2, y2 - y);
  const interact = step.interact ?? !!step.wait;
  if (interact) blocks[4].hidden = true; else box(blocks[4], x, y, x2 - x, y2 - y);

  let bx, by;
  if (narrow) {
    // phones: a sheet at the bottom, or at the top when the target sits low on the screen
    // (or asks for it: the terminal's prompt line is at its bottom)
    bx = GAP;
    by = step.dock === 'top' || (step.dock !== 'bottom' && (r.top + r.bottom) / 2 > vh * 0.55) ? GAP : vh - bh - GAP;
  } else if (vh - y2 >= bh + 2 * GAP) { by = y2 + GAP; bx = clamp(r.left + r.width / 2 - bw / 2, GAP, vw - bw - GAP); }
  else if (y >= bh + 2 * GAP) { by = y - GAP - bh; bx = clamp(r.left + r.width / 2 - bw / 2, GAP, vw - bw - GAP); }
  else if (vw - x2 >= bw + 2 * GAP) { bx = x2 + GAP; by = clamp(r.top + r.height / 2 - bh / 2, GAP, vh - bh - GAP); }
  else if (x >= bw + 2 * GAP) { bx = x - GAP - bw; by = clamp(r.top + r.height / 2 - bh / 2, GAP, vh - bh - GAP); }
  else { bx = vw - bw - GAP; by = vh - bh - GAP; }
  bubble.style.left = Math.round(bx) + 'px';
  bubble.style.top = Math.round(by) + 'px';
}

// ---------------------------------------------------------------- events
function onPlay(e) {
  if (!T) return;
  const d = e.detail || {};
  const step = T.steps[T.i];
  // During the training round the tour decides when to move on, not the game.
  if (d.type === 'next' && step && routeOf(step) === 'training') {
    e.preventDefault();
    if (!step.takeNext) nudge();
  }
  if (T.waiting && step?.wait?.(d)) satisfy();
}

function onRoute(e) {
  if (!T) return;
  const path = e.detail?.path ?? currentRoute().path;
  if (T.navigating !== null) {
    if (path === T.navigating) T.navigating = null;
    return;
  }
  const step = T.steps[T.i];
  const want = step && routeOf(step);
  if (want && path === pathOf(want)) return;
  stopTour('left');
}

function onKey(e) {
  if (!T || e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.modal-backdrop')) return;
  if (e.target instanceof Element && e.target.closest('.term')) return; // Esc belongs to the terminal (Ctrl+R search)
  e.preventDefault();
  e.stopImmediatePropagation();
  stopTour('skipped');
}
