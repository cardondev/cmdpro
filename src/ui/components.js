// Reusable UI pieces built on the DS classes.
import { h, icon, heartSvg } from './dom.js';
import { play } from '../game/audio.js';
import { go } from './router.js';

export function button(label, { variant = 'secondary', size, icon: ic, onClick, pill, title, cls = '', type = 'button', disabled, sound = 'menu-select', attrs = {} } = {}) {
  const b = h('button', {
    type, class: ['btn', 'btn-' + variant, size && 'btn-' + size, pill && 'btn-pill', cls].filter(Boolean).join(' '),
    title, disabled: disabled || null, ...attrs,
    onclick: (e) => { if (sound) play(sound); onClick && onClick(e); },
  }, ic && icon(ic), label);
  return b;
}

export function iconButton(ic, { label, onClick, variant = 'muted', size = 'sm', cls = '', sound = 'menu-select', pressed } = {}) {
  return h('button', {
    type: 'button', class: `btn btn-${variant} btn-${size} btn-icon ${cls}`, 'aria-label': label, 'data-tip': label,
    'aria-pressed': pressed === undefined ? null : String(!!pressed),
    onclick: (e) => { if (sound) play(sound); onClick && onClick(e); },
  }, icon(ic));
}

export function badge(text, tone = 'accent', { dot = false } = {}) {
  return h('span', { class: `badge ${tone === 'accent' ? '' : 'badge-' + tone}` }, dot && h('span', { class: 'dot' }), text);
}

export function card(children, { accent = false, interactive = false, cls = '', onClick, attrs = {} } = {}) {
  return h('div', { class: ['card', accent && 'card-accent', interactive && 'card-interactive', cls].filter(Boolean).join(' '), onclick: onClick || null, ...attrs }, children);
}

export function switchEl({ label, checked, onChange, id }) {
  const track = h('button', { type: 'button', class: 'switch-track', role: 'switch', 'aria-checked': String(!!checked), id, 'aria-label': label });
  const el = h('label', { class: 'switch' }, track, label && h('span', { class: 'switch-label' }, label));
  track.addEventListener('click', (e) => {
    e.preventDefault();
    const on = track.getAttribute('aria-checked') !== 'true';
    track.setAttribute('aria-checked', String(on));
    play('toggle');
    onChange && onChange(on);
  });
  el.addEventListener('click', (e) => { if (e.target !== track) { e.preventDefault(); track.click(); } });
  return el;
}

export function progress(value, { label, showValue = true } = {}) {
  const pct = Math.max(0, Math.min(100, value));
  const fill = h('div', { class: 'progress-fill' });
  const el = h('div', { class: 'progress' },
    (label || showValue) && h('div', { class: 'progress-head' }, h('span', null, label || ''), showValue && h('span', { class: 'value' }, Math.round(pct) + '%')),
    h('div', { class: 'progress-track', role: 'progressbar', 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill));
  requestAnimationFrame(() => { fill.style.width = pct + '%'; });
  return el;
}

export function segmented(options, value, onChange, { label } = {}) {
  const el = h('div', { class: 'segmented', role: 'group', 'aria-label': label || null });
  const btns = options.map(o => h('button', {
    type: 'button', 'aria-pressed': String(o.value === value),
    onclick: () => {
      btns.forEach(b => b.setAttribute('aria-pressed', String(b === btn(o))));
      play('toggle');
      onChange(o.value);
    },
  }, o.label));
  const btn = (o) => btns[options.indexOf(o)];
  btns.forEach(b => el.appendChild(b));
  return el;
}

export function hearts(left, max, { breaking = -1 } = {}) {
  const el = h('span', { class: 'hearts', 'aria-label': max === Infinity ? 'Unlimited attempts' : `${left} of ${max} attempts left` });
  if (max === Infinity) { el.appendChild(heartSvg('heart')); el.appendChild(h('span', { class: 'infinite' }, '∞')); return el; }
  for (let i = 0; i < max; i++) {
    const cls = ['heart', i >= left && 'lost', i === breaking && 'breaking'].filter(Boolean).join(' ');
    el.appendChild(heartSvg(cls));
  }
  return el;
}

export function topbar({ title, back = 'title', backLabel = 'Back', right = [] } = {}) {
  return h('header', { class: 'topbar' },
    back !== null && h('button', {
      type: 'button', class: 'btn btn-muted btn-sm', onclick: () => { play('back'); typeof back === 'function' ? back() : go(back); },
    }, icon('chevron-left'), backLabel),
    h('div', { class: 'topbar-title' }, title),
    h('div', { class: 'spacer' }),
    right);
}

export function kbd(text) { return h('span', { class: 'kbd' }, text); }

export function stat(k, v) { return h('span', { class: 'stat' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)); }

export function sectionTitle(eyebrow, title, sub) {
  return h('div', { class: 'section-title' },
    eyebrow && h('div', { class: 'eyebrow' }, eyebrow),
    title && h('h1', { class: 'h1' }, title),
    sub && h('p', { class: 'secondary' }, sub));
}
