// Difficulty select with per-difficulty save slots.
import { h, icon, fmtNum, timeAgo } from '../dom.js';
import { play, music } from '../../game/audio.js';
import { go } from '../router.js';
import { topbar, button, hearts, badge } from '../components.js';
import { DIFFICULTIES, DIFFICULTY_ORDER } from '../../game/rules.js';
import { DIFFICULTY_COPY, SIDE_QUEST_COPY } from '../../data/copy.js';
import { getSlot, newRun, runLength, RUN_KINDS } from '../../game/run.js';
import { confirmModal } from '../modal.js';
import { BONUS } from '../../data/campaign.js';

const KIND_TITLE = {
  campaign: ['Campaign', 'All seven tiers, then the bonus round. Fail every attempt on a challenge and it is back to #1.'],
  bonus: ['Bonus Round', BONUS.blurb],
  oops: ['Side quest: Gremlins Ate /bin', SIDE_QUEST_COPY.oops],
  '12days': ['Side quest: The Twelve Labors', SIDE_QUEST_COPY['12days']],
};

export function startTarget(kind, difficulty, slot) {
  if (kind === 'campaign') return `map/${difficulty}`;
  if (kind === 'bonus' && !(slot?.briefed?.bonus)) return `briefing/bonus/${difficulty}/bonus`;
  return `play/${kind}/${difficulty}`;
}

export async function render(r) {
  const kind = RUN_KINDS[r.args[0]] ? r.args[0] : 'campaign';
  const [title, sub] = KIND_TITLE[kind];
  const cards = DIFFICULTY_ORDER.map((d) => {
    const rules = DIFFICULTIES[d];
    const copy = DIFFICULTY_COPY[d];
    const slot = getSlot(kind, d);
    const total = slot ? runLength(slot) : 0;
    const inProgress = slot && !slot.completed && (slot.index > 0 || slot.current);
    const ruleRow = (ok, text) => h('li', { class: ok ? 'ok' : 'no' }, icon(ok ? 'check' : 'close'), text);
    let status;
    if (slot?.completed) status = h('div', { class: 'diff-status done' }, icon('trophy'), `Completed · ${fmtNum(slot.score)} pts`);
    else if (inProgress) status = h('div', { class: 'diff-status' }, icon('flag'), `Challenge ${slot.index + 1}/${total} · ${fmtNum(slot.score)} pts${slot.deaths ? ` · ${slot.deaths} game over${slot.deaths > 1 ? 's' : ''}` : ''} · saved ${timeAgo(slot.updated)}`);
    else status = h('div', { class: 'diff-status muted' }, icon('file'), slot?.deaths ? `Back at #1 after ${slot.deaths} game over${slot.deaths > 1 ? 's' : ''}` : 'No save yet');

    const start = async () => {
      if (inProgress) {
        const ok = await confirmModal({ title: 'Start a new run?', message: `This wipes your ${rules.name} save (challenge ${slot.index + 1}, ${fmtNum(slot.score)} pts). Certificates stay on the wall.`, ok: 'rm -rf my save', cancel: 'Keep it', danger: true });
        if (!ok) return;
      }
      const s = newRun(kind, d);
      play('unlock');
      go(startTarget(kind, d, s));
    };
    const cont = () => { play('menu-select'); go(startTarget(kind, d, slot)); };
    const actions = inProgress
      ? [button('Continue', { variant: 'secondary', icon: 'play', onClick: cont, sound: null, cls: 'diff-main' }), button('New run', { variant: 'muted', onClick: start, sound: 'menu-select' })]
      : [button(slot?.completed ? 'Play again' : 'Start', { variant: 'secondary', icon: 'play', onClick: start, sound: null, cls: 'diff-main' })];

    return h('article', { class: `diff-card card diff-${d}`, tabindex: '0', 'data-d': d,
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); inProgress ? cont() : start(); } } },
      h('div', { class: 'diff-head' },
        h('div', { class: 'diff-name arcade' }, rules.name),
        badge(copy.tag, d === 'extreme' ? 'danger' : d === 'hard' ? 'warning' : d === 'normal' ? 'success' : 'info')),
      h('div', { class: 'diff-hearts' }, hearts(rules.attempts, rules.attempts), h('span', { class: 'muted small' }, `${rules.attempts} attempt${rules.attempts > 1 ? 's' : ''} per challenge`)),
      h('p', { class: 'diff-desc secondary' }, copy.desc),
      h('ul', { class: 'diff-rules' },
        ruleRow(rules.hints, rules.hints ? (rules.hintCost ? `Hints (−${rules.hintCost} pts each)` : 'Hints, free of charge') : 'No hints'),
        ruleRow(!rules.timer, rules.timer ? 'Timed: 2–5 min per challenge' : 'No timer'),
        ruleRow(rules.paste, rules.paste ? 'Copy & paste allowed' : 'No paste — type every key'),
        ruleRow(true, rules.recon === Infinity ? 'Unlimited recon shell' : `${rules.recon} recon commands per challenge`),
        ruleRow(true, `Score ×${rules.multiplier}`)),
      status,
      h('div', { class: 'diff-actions' }, actions));
  });

  const grid = h('div', { class: 'diff-grid' }, cards);
  const onKey = (e) => {
    if (document.querySelector('.modal-backdrop')) return;
    const idx = cards.indexOf(document.activeElement);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); cards[(idx + 1 + cards.length) % cards.length].focus(); play('menu-move'); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); cards[(idx - 1 + cards.length * 2) % cards.length].focus(); play('menu-move'); }
    else if (e.key === 'Escape') { play('back'); go(kind === 'campaign' || kind === 'bonus' ? 'title' : 'sidequests'); }
  };
  const el = h('div', { class: 'screen' },
    topbar({ title, back: kind === 'oops' || kind === '12days' ? 'sidequests' : 'title' }),
    h('main', { class: 'page' },
      h('div', { class: 'section-title' }, h('div', { class: 'eyebrow' }, 'Choose your difficulty'), h('h1', { class: 'h1' }, title), h('p', { class: 'secondary' }, sub)),
      grid));
  return {
    el,
    mounted() { music('title'); window.addEventListener('keydown', onKey); const cur = cards.find(c => c.querySelector('.diff-status:not(.muted)')) || cards[1]; cur?.focus({ preventScroll: true }); },
    destroy() { window.removeEventListener('keydown', onKey); },
  };
}
