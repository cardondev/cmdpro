// Single certificate: view, rename, print, download.
import { h, icon } from '../dom.js';
import { store } from '../../game/state.js';
import { music } from '../../game/audio.js';
import { go } from '../router.js';
import { topbar, badge, stat } from '../components.js';
import { CERT_BY_ID, DIFFICULTY_STAMP } from '../../data/certs.js';
import { certViewer } from '../certview.js';

export async function render(r) {
  const id = CERT_BY_ID[r.args[0]] ? r.args[0] : null;
  if (!id) { go('wall', { replace: true }); return { el: h('div') }; }
  const cert = CERT_BY_ID[id];
  const e = store.state.certs[id];
  const viewer = certViewer(id);
  const el = h('div', { class: 'screen' },
    topbar({ title: cert.title, back: 'wall', backLabel: 'Wall' }),
    h('main', { class: 'page cert-page' },
      h('div', { class: 'page-head-row' },
        h('div', { class: 'section-title' },
          h('div', { class: 'eyebrow' }, e ? 'Issued certificate' : 'Locked'),
          h('h1', { class: 'h1' }, cert.title),
          h('p', { class: 'secondary' }, `Rank: ${cert.rank} · “${cert.slogan}”`)),
        e ? h('div', { class: 'row-wrap' },
          badge(DIFFICULTY_STAMP[e.difficulty]?.label || e.difficulty, e.difficulty === 'extreme' ? 'danger' : 'success'),
          stat('Earned', new Date(e.firstEarned || e.date).toLocaleDateString()),
          e.times > 1 && stat('Times', String(e.times)))
          : h('div', { class: 'callout warn', style: { maxWidth: '420px' } }, icon('lock'), h('div', null, 'Not earned yet. ', cert.earn, ' This dimmed specimen shows what you are fighting for; you can print and save it once it is yours.'))),
      viewer.el,
      e && h('p', { class: 'faint small' }, 'Tip: in the print dialog choose "Save as PDF" for a PDF, and landscape orientation. Background graphics should be on.')));
  return { el, mounted() { music('title'); } };
}
