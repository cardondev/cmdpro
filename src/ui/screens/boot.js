// Fake BIOS POST + kernel boot log. Skippable, shown once per session.
import { h, sleep } from '../dom.js';
import { BIOS_LINES, KERNEL_LINES } from '../../data/copy.js';
import { session } from '../../game/state.js';
import { play } from '../../game/audio.js';
import { go } from '../router.js';

export async function render() {
  const out = h('div', { class: 'boot-log', 'aria-live': 'polite' });
  const skip = h('div', { class: 'boot-skip' }, 'Press any key to skip · Press DEL to enter SETUP (just kidding)');
  const el = h('div', { class: 'screen boot scanlines', role: 'presentation' },
    h('div', { class: 'boot-badge', 'aria-hidden': 'true' },
      h('div', { class: 'boot-badge-logo' }, '>_'),
      h('div', { class: 'boot-badge-text' }, 'Energy', h('br'), 'Star-ish')),
    out, skip);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    session.set('booted', '1');
    play('whoosh');
    go('title', { replace: true });
  };
  const onKey = (e) => { if (e.key === 'Tab') return; e.preventDefault(); finish(); };
  return {
    el,
    async mounted() {
      window.addEventListener('keydown', onKey);
      el.addEventListener('pointerdown', finish);
      play('poweron');
      const add = (t, cls = '') => { out.appendChild(h('div', { class: 'boot-line ' + cls }, t || ' ')); };
      for (const l of BIOS_LINES) { if (done) return; add(l, /OK|found/.test(l) ? 'ok' : ''); if (/OK/.test(l)) play('boot', { gain: 0.5 }); await sleep(85); }
      await sleep(250);
      for (const l of KERNEL_LINES) {
        if (done) return;
        const cls = /\[  OK  \]/.test(l) ? 'kok' : /WARN/.test(l) ? 'kwarn' : /login/.test(l) ? 'klogin' : '';
        add(l, cls);
        await sleep(l.startsWith('[') ? 70 : 140);
      }
      await sleep(650);
      finish();
    },
    destroy() { done = true; window.removeEventListener('keydown', onKey); },
  };
}
