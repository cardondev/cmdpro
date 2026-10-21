// Wall of Certificates: earned plaques in colour, locked ones as "CSR pending…".
import { h, icon } from '../dom.js';
import { store } from '../../game/state.js';
import { play, music } from '../../game/audio.js';
import { go } from '../router.js';
import { topbar, progress } from '../components.js';
import { CERTS, DIFFICULTY_STAMP } from '../../data/certs.js';
import { sealUrl, spriteImg } from '../sprites.js';

const GROUPS = [
  ['Campaign tiers', c => c.kind === 'tier'],
  ['Beyond expert', c => c.kind === 'bonus' || c.kind === 'legendary'],
  ['Special editions', c => c.kind === 'edition'],
  ['Side quests', c => c.kind === 'side'],
];

function fmtDate(iso) { try { return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); } catch { return ''; } }

export async function render() {
  const st = store.state;
  const earnedCount = CERTS.filter(c => st.certs[c.id]).length;
  const plaque = (c) => {
    const e = st.certs[c.id];
    const stamp = e && DIFFICULTY_STAMP[e.difficulty];
    const el = h('button', {
      type: 'button', class: `plaque ${e ? 'earned' : 'locked'} plaque-${c.kind}`, style: { '--c1': c.colors[0], '--c2': c.colors[1] },
      'aria-label': e ? `${c.title}, earned ${fmtDate(e.date)}. View certificate.` : `${c.title}, locked. ${c.earn}`,
      onclick: () => { play(e ? 'menu-select' : 'error'); go(`cert/${c.id}`); },
    },
      h('div', { class: 'plaque-inner' },
        h('div', { class: 'plaque-seal' }, spriteImg(sealUrl(c.id), { alt: '', label: '★' })),
        h('div', { class: 'plaque-title' }, c.title),
        h('div', { class: 'plaque-rank arcade' }, e ? c.rank : '???'),
        e ? h('div', { class: 'plaque-meta' },
          h('span', { class: 'plaque-stamp', style: { color: stamp?.color } }, stamp?.label || ''),
          h('span', { class: 'faint' }, fmtDate(e.date)))
          : h('div', { class: 'plaque-meta locked-meta' }, h('span', { class: 'mono' }, 'CSR pending…'), h('span', { class: 'faint' }, c.earn)),
        h('div', { class: 'plaque-slogan' }, e ? `“${c.slogan}”` : '')),
      !e && h('span', { class: 'plaque-lock' }, icon('lock')));
    return el;
  };
  const el = h('div', { class: 'screen' },
    topbar({ title: 'Wall of Certificates', back: 'title' }),
    h('main', { class: 'page wall-page' },
      h('div', { class: 'page-head-row' },
        h('div', { class: 'section-title' },
          h('div', { class: 'eyebrow' }, 'CMDPRO Certificate Authority'),
          h('h1', { class: 'h1' }, 'Wall of Certificates'),
          h('p', { class: 'secondary' }, 'Self-signed, frame-worthy and trusted by absolutely no browser.')),
        h('div', { style: { minWidth: '240px' } }, progress((earnedCount / CERTS.length) * 100, { label: `${earnedCount} of ${CERTS.length} certificates` }))),
      GROUPS.map(([title, f]) => h('section', { class: 'wall-group' },
        h('h2', { class: 'eyebrow wall-group-title' }, title),
        h('div', { class: 'wall-grid' }, CERTS.filter(f).map(plaque)))),
      h('p', { class: 'faint small center', style: { marginTop: '32px' } }, 'Certificate Revocation List: empty. Nobody can take these away from you. Not even a game over.')));
  return { el, mounted() { music('title'); } };
}

