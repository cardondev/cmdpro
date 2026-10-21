// Free Play: browse every challenge, practice without pressure.
import { h, icon } from '../dom.js';
import { store } from '../../game/state.js';
import { play, music } from '../../game/audio.js';
import { go } from '../router.js';
import { topbar } from '../components.js';
import { TIERS, BONUS, SIDE_QUESTS } from '../../data/campaign.js';
import { EDITIONS } from '../../data/editions.js';
import { CH_BY_ID } from '../../game/run.js';
import { FREEPLAY_COPY } from '../../data/copy.js';
import { holidayIcon } from '../sprites.js';

const GROUPS = [
  ...TIERS.map(t => ({ key: 't' + t.id, label: `World ${t.id}`, title: `World ${t.id} · ${t.name}`, ids: t.challenges })),
  { key: 'bonus', label: 'Bonus', title: 'Bonus · Machine', ids: BONUS.challenges },
  ...EDITIONS.map(e => ({ key: e.id, label: e.short, title: `${e.short} · ${e.name}`, ids: e.challenges })),
  ...SIDE_QUESTS.map(s => ({ key: s.id, label: s.short, title: s.name, ids: s.challenges })),
];

let filterKey = 'all';
let query = '';
let unsolvedOnly = false;

export async function render() {
  const st = store.state;
  const solved = (id) => !!st.freeplay.solved[id] || Object.values(st.slots).some(k => Object.values(k || {}).some(sl => sl && (sl.log || []).some(x => x.id === id)));
  const list = h('div', { class: 'fp-list' });
  const countEl = h('span', { class: 'muted small' });
  const chips = h('div', { class: 'row-wrap fp-chips' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search titles and tags (try: awk)', value: query, 'aria-label': 'Search challenges' });
  const unsolvedBtn = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(unsolvedOnly), onclick: () => { unsolvedOnly = !unsolvedOnly; unsolvedBtn.setAttribute('aria-pressed', String(unsolvedOnly)); play('toggle'); draw(); } }, icon('eye-off'), 'Unsolved only');

  function drawChips() {
    chips.replaceChildren(...[{ key: 'all', label: 'All' }, ...GROUPS].map(g => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(filterKey === g.key),
      onclick: () => { filterKey = g.key; play('menu-move'); drawChips(); draw(); },
    }, g.label)), unsolvedBtn);
  }
  function draw() {
    const q = query.trim().toLowerCase();
    let shown = 0;
    const sections = GROUPS.filter(g => filterKey === 'all' || g.key === filterKey).map(g => {
      const rows = g.ids.map((id, i) => ({ id, i, ch: CH_BY_ID[id] })).filter(x => x.ch)
        .filter(x => !q || x.ch.title.toLowerCase().includes(q) || (x.ch.tags || []).some(t => t.includes(q)) || x.ch.slug.includes(q))
        .filter(x => !unsolvedOnly || !solved(x.id));
      if (!rows.length) return null;
      shown += rows.length;
      return h('section', { class: 'fp-group' },
        h('h2', { class: 'eyebrow' }, g.title),
        h('div', { class: 'fp-rows' }, rows.map(({ id, i, ch }) => h('button', {
          type: 'button', class: 'fp-row' + (solved(id) ? ' solved' : ''), onclick: () => { play('menu-select'); go(`practice/${id}`); },
        },
          ch.icon ? holidayIcon(ch.icon, { cls: 'fp-icon' }) : h('span', { class: 'fp-num mono' }, String(i + 1).padStart(2, '0')),
          h('span', { class: 'fp-title' }, ch.title),
          h('span', { class: 'fp-tags' }, (ch.tags || []).slice(0, 3).map(t => h('span', { class: 'chip' }, '#' + t))),
          h('span', { class: 'fp-state' }, solved(id) ? icon('check') : icon('play'))))));
    }).filter(Boolean);
    list.replaceChildren(...(sections.length ? sections : [h('div', { class: 'callout' }, icon('search'), h('div', null, `grep: no challenges match "${query}". Try fewer letters.`))]));
    countEl.textContent = `${shown} challenge${shown === 1 ? '' : 's'}`;
  }
  search.addEventListener('input', () => { query = search.value; draw(); });
  drawChips();
  draw();
  const el = h('div', { class: 'screen' },
    topbar({ title: 'Free Play', back: 'title' }),
    h('main', { class: 'page' },
      h('div', { class: 'section-title' }, h('div', { class: 'eyebrow' }, 'Practice mode'), h('h1', { class: 'h1' }, 'Free Play'), h('p', { class: 'secondary' }, FREEPLAY_COPY)),
      h('div', { class: 'fp-tools' }, h('div', { class: 'fp-search' }, search, countEl), chips),
      list));
  return { el, mounted() { music('title'); } };
}
