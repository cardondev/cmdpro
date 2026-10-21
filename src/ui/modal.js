// Accessible modal dialog with focus trap, Esc to close and DS styling.
import { h } from './dom.js';
import { play } from '../game/audio.js';

export function openModal({ title, body, actions = [], wide = false, onClose, dismissable = true, labelledBy } = {}) {
  const prevFocus = document.activeElement;
  const titleId = 'm-' + Math.random().toString(36).slice(2);
  const actionEls = actions.map(a => h('button', {
    class: 'btn ' + (a.variant ? 'btn-' + a.variant : 'btn-secondary') + (a.size ? ' btn-' + a.size : ''),
    type: 'button',
    onclick: async () => { const r = a.onClick ? await a.onClick() : undefined; if (r !== false) close(a.value); },
  }, a.label));
  const dialog = h('div', { class: 'modal' + (wide ? ' modal-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy || (title ? titleId : null) },
    title && h('h2', { class: 'modal-title', id: titleId }, title),
    body,
    actionEls.length ? h('div', { class: 'modal-actions' }, actionEls) : null);
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  let closed = false;
  let resolveFn;
  const done = new Promise(r => { resolveFn = r; });
  function close(value) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    play('close');
    try { prevFocus && prevFocus.focus && prevFocus.focus(); } catch {}
    onClose && onClose(value);
    resolveFn(value);
  }
  function onKey(e) {
    if (e.key === 'Escape' && dismissable) { e.preventDefault(); e.stopPropagation(); close(undefined); return; }
    if (e.key === 'Tab') {
      const f = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    e.stopPropagation();
  }
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop && dismissable) close(undefined); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  play('open');
  requestAnimationFrame(() => {
    const auto = dialog.querySelector('[autofocus]') || dialog.querySelector('input, textarea') || actionEls[actionEls.length - 1] || dialog;
    if (auto === dialog) dialog.setAttribute('tabindex', '-1');
    auto.focus();
  });
  return { close, done, el: dialog };
}

/** Promise<boolean> confirm dialog. */
export function confirmModal({ title, message, ok = 'OK', cancel = 'Cancel', danger = false }) {
  return openModal({
    title,
    body: typeof message === 'string' ? h('p', { class: 'secondary' }, message) : message,
    actions: [
      { label: cancel, variant: 'muted', value: false },
      { label: ok, variant: danger ? 'danger' : 'primary', value: true },
    ],
  }).done.then(v => v === true);
}
