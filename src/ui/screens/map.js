// Campaign map: tiers as worlds, one node per challenge.
import { h, icon, fmtNum } from '../dom.js';
import { store } from '../../game/state.js';
import { play, music } from '../../game/audio.js';
import { go } from '../router.js';
import { topbar, button, progress, badge, stat } from '../components.js';
import { DIFFICULTIES } from '../../game/rules.js';
import { getSlot, newRun, previewSlot, listFor, CH_BY_ID } from '../../game/run.js';
import { TIERS, BONUS } from '../../data/campaign.js';
import { avatarImg, sealUrl, spriteImg } from '../sprites.js';
import { CERT_BY_ID } from '../../data/certs.js';

export function continueTarget(slot) {
  const list = listFor('campaign');
  const id = list[slot.index];
  if (!id) return null;
  const t = TIERS.find(x => x.challenges.includes(id));
  const tierKey = t ? String(t.id) : 'bonus';
  if (!slot.briefed?.[tierKey]) return `briefing/campaign/${slot.difficulty}/${tierKey}`;
  return `play/campaign/${slot.difficulty}`;
}

export async function render(r) {
  const difficulty = DIFFICULTIES[r.args[0]] ? r.args[0] : 'normal';
  const rules = DIFFICULTIES[difficulty];
  // ?tour=1 (the tutorial) shows an empty map without creating a save
  let slot = getSlot('campaign', difficulty) || (r.query.has('tour') ? previewSlot('campaign', difficulty) : newRun('campaign', difficulty));
  const st = store.state;
  const list = listFor('campaign');
  const total = list.length;
  const idx = Math.min(slot.index, total);
  const done = slot.completed;
  const curId = list[idx];

  const cont = () => {
    if (done) return;
    const t = continueTarget(slot);
    if (t) { play('menu-select'); go(t); }
  };

  const worlds = [...TIERS, { ...BONUS, id: 'bonus' }].filter(t => t.challenges.some(id => CH_BY_ID[id])).map((t) => {
    const ids = t.challenges.filter(id => CH_BY_ID[id]);
    const first = list.indexOf(ids[0]);
    const unlocked = first <= idx || done;
    const cert = CERT_BY_ID[t.cert];
    const earned = !!st.certs[t.cert];
    const nodes = ids.map((id, i) => {
      const gi = first + i;
      const state = done || gi < idx ? 'done' : gi === idx ? 'current' : 'locked';
      const ch = CH_BY_ID[id];
      const label = state === 'locked' ? `Challenge ${gi + 1}: ???` : `Challenge ${gi + 1}: ${ch.title}`;
      const node = h('button', {
        type: 'button', class: `map-node ${state}`, 'aria-label': label, 'data-tip': state === 'locked' ? '???' : ch.title,
        disabled: state === 'locked' ? true : null,
        onclick: () => { if (state === 'current') cont(); else if (state === 'done') { play('menu-select'); go(`practice/${id}`); } },
      }, state === 'done' ? icon('check') : state === 'current' ? avatarImg(st.profile.avatar, { cls: 'map-node-av' }) : h('span', null, String(gi + 1)));
      return node;
    });
    return h('section', { class: `world card ${unlocked ? '' : 'locked'} ${t.id === 'bonus' ? 'world-bonus' : ''}`, 'aria-label': `World ${t.id === 'bonus' ? 'Bonus' : t.id}: ${t.name}` },
      h('div', { class: 'world-head' },
        h('div', { class: 'world-num arcade' }, t.id === 'bonus' ? '★' : String(t.id)),
        h('div', { class: 'world-title' },
          h('div', { class: 'eyebrow' }, t.id === 'bonus' ? 'Bonus stage' : `World ${t.id}`),
          h('h2', { class: 'h2' }, t.name, ' ', h('span', { class: 'muted small' }, `· ${t.rank}`)),
          h('p', { class: 'secondary small' }, t.blurb)),
        h('div', { class: `world-seal ${earned ? 'earned' : ''}`, 'data-tip': earned ? `${cert.title} — earned` : `Earn: ${cert.title}`, onclick: () => earned && go(`cert/${t.cert}`) },
          spriteImg(sealUrl(t.cert), { alt: cert.title, label: '★' }))),
      h('div', { class: 'world-nodes' }, nodes),
      unlocked && h('div', { class: 'world-foot' },
        button('Briefing', { variant: 'muted', size: 'sm', icon: 'file-text', onClick: () => go(`briefing/campaign/${difficulty}/${t.id}?view=1`) })));
  });

  const pct = (Math.min(idx, total) / Math.max(1, total)) * 100;
  const tierNow = TIERS.find(x => x.challenges.includes(curId)) || (BONUS.challenges.includes(curId) ? BONUS : null);
  const summary = h('div', { class: 'card card-accent map-summary' },
    h('div', { class: 'map-summary-left' },
      h('div', { class: 'avatar avatar-lg' }, avatarImg(st.profile.avatar)),
      h('div', { class: 'col', style: { gap: '6px' } },
        h('div', { class: 'eyebrow' }, `${rules.name} campaign`),
        h('div', { class: 'h2' }, done ? 'Campaign complete!' : `Challenge ${idx + 1} of ${total}`),
        h('div', { class: 'secondary small' }, done ? 'You beat everything. Go frame those certificates.' : tierNow ? `${tierNow.id === 'bonus' ? 'Bonus stage' : 'World ' + tierNow.id} · ${tierNow.name} · ${CH_BY_ID[curId]?.title}` : ''),
        h('div', { class: 'row-wrap', style: { gap: '16px' } }, stat('Score', fmtNum(slot.score)), stat('Solved', String(slot.solvedCount)), stat('Game overs', String(slot.deaths || 0)), stat('Lives', rules.attempts + '/challenge')))),
    h('div', { class: 'map-summary-right' },
      progress(done ? 100 : pct, { label: 'Campaign progress' }),
      done ? button('Wall of Certificates', { variant: 'primary', size: 'lg', icon: 'trophy', onClick: () => go('wall') })
        : button(slot.index === 0 && !slot.current ? 'Start' : 'Continue', { variant: 'primary', size: 'lg', icon: 'play', onClick: cont, sound: null })));

  const onKey = (e) => {
    if (document.querySelector('.modal-backdrop')) return;
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); cont(); }
    if (e.key === 'Escape') { play('back'); go('difficulty/campaign'); }
  };

  const el = h('div', { class: 'screen' },
    topbar({ title: `Campaign · ${rules.name}`, back: 'difficulty/campaign', backLabel: 'Difficulty', right: [badge(`${fmtNum(slot.score)} pts`, 'neutral')] }),
    h('main', { class: 'page map-page' }, summary, h('div', { class: 'worlds' }, worlds)));
  return {
    el,
    mounted() {
      music('title');
      window.addEventListener('keydown', onKey);
      const cur = el.querySelector('.map-node.current');
      if (cur) setTimeout(() => cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 250);
    },
    destroy() { window.removeEventListener('keydown', onKey); },
  };
}
