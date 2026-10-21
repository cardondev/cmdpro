// DS toast: mono tile (icon / sprite) + title + body + time.
import { h, icon } from './dom.js';

let stack = null;
function ensure() {
  if (!stack || !stack.isConnected) {
    stack = h('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(stack);
  }
  return stack;
}

/** toast({ title, body, icon: 'trophy' | img: url | tile: 'CMD', time, duration }) */
export function toast({ title, body, iconName, img, tile, time, duration = 4200, onClick } = {}) {
  const tileEl = h('div', { class: 'toast-tile' },
    img ? h('img', { src: img, alt: '' }) : iconName ? icon(iconName) : (tile || '>_'));
  const el = h('div', { class: 'toast', onclick: onClick || null, style: onClick ? { cursor: 'pointer' } : null },
    tileEl,
    h('div', { style: { flex: 1, minWidth: 0 } },
      title && h('div', { class: 'toast-title' }, title),
      body && h('div', { class: 'toast-body' }, body),
      time && h('div', { class: 'toast-time' }, time)));
  ensure().appendChild(el);
  const close = () => {
    if (!el.isConnected) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  };
  setTimeout(close, duration);
  el.addEventListener('pointerdown', close);
  return close;
}
