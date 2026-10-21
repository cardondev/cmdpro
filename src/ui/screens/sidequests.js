// Side quests: Gremlins Ate /bin and The Twelve Labors (ids 'oops' and '12days' in saves).
import { h, icon, fmtNum, timeAgo } from '../dom.js';
import { confirmModal } from '../modal.js';
import { store } from '../../game/state.js';
import { play, music } from '../../game/audio.js';
import { go } from '../router.js';
import { topbar, button, segmented, badge } from '../components.js';
import { SIDE_QUESTS } from '../../data/campaign.js';
import { SIDE_QUEST_COPY } from '../../data/copy.js';
import { CERT_BY_ID } from '../../data/certs.js';
import { DIFFICULTIES, DIFFICULTY_ORDER } from '../../game/rules.js';
import { getSlot, newRun, runLength } from '../../game/run.js';
import { sealUrl, spriteImg } from '../sprites.js';

export async function render() {
  const st = store.state;
  const cards = SIDE_QUESTS.map(q => {
    let diff = 'normal';
    const cert = CERT_BY_ID[q.cert];
    const statusEl = h('div', { class: 'small secondary' });
    const actions = h('div', { class: 'row-wrap' });
    const refresh = () => {
      const slot = getSlot(q.id, diff);
      const inProgress = slot && !slot.completed && (slot.index > 0 || slot.current);
      statusEl.textContent = slot?.completed ? `Completed on ${DIFFICULTIES[diff].name} · ${fmtNum(slot.score)} pts`
        : inProgress ? `In progress: ${slot.index + 1}/${runLength(slot)} · ${fmtNum(slot.score)} pts · saved ${timeAgo(slot.updated)}` : `Not started on ${DIFFICULTIES[diff].name}`;
      // (native replaceChildren would turn a null into the text "null")
      actions.replaceChildren(...[
        inProgress && button('Continue', { variant: 'primary', icon: 'play', onClick: () => go(`play/${q.id}/${diff}`) }),
        button(inProgress ? 'Restart' : slot?.completed ? 'Play again' : 'Start', { variant: inProgress ? 'muted' : 'primary', icon: inProgress ? 'reload' : 'play', onClick: async () => {
          if (inProgress && !(await confirmModal({ title: 'Restart this side quest?', message: `This wipes your ${DIFFICULTIES[diff].name} save (challenge ${slot.index + 1}, ${fmtNum(slot.score)} pts). Certificates stay on the wall.`, ok: 'rm -rf my save', cancel: 'Keep it', danger: true }))) return;
          newRun(q.id, diff); play('unlock'); go(`play/${q.id}/${diff}`);
        } }),
      ].filter(Boolean));
    };
    refresh();
    const earned = !!st.certs[q.cert];
    return h('article', { class: `card quest-card quest-${q.id}` },
      h('div', { class: 'quest-head' },
        h('div', { class: 'quest-icon' }, icon(q.icon || 'gift')),
        h('div', { class: 'grow' },
          h('div', { class: 'eyebrow' }, `${q.challenges.length} challenges · side quest`),
          h('h2', { class: 'h2' }, q.name)),
        h('div', { class: `quest-seal ${earned ? 'earned' : ''}`, 'data-tip': earned ? 'Certificate earned' : `Earn: ${cert.title}` }, spriteImg(sealUrl(q.cert), { alt: cert.title, label: '★' }))),
      h('p', { class: 'secondary' }, SIDE_QUEST_COPY[q.id]),
      h('div', { class: 'row-wrap' }, badge(`Rank: ${q.rank}`, 'draft'), badge(cert.title, earned ? 'success' : 'neutral')),
      h('div', { class: 'quest-diff' }, h('span', { class: 'field-label' }, 'Difficulty'), segmented(DIFFICULTY_ORDER.map(d => ({ value: d, label: DIFFICULTIES[d].name })), diff, (v) => { diff = v; refresh(); }, { label: 'Difficulty' })),
      statusEl,
      actions);
  });
  const el = h('div', { class: 'screen' },
    topbar({ title: 'Side Quests', back: 'title' }),
    h('main', { class: 'page' },
      h('div', { class: 'section-title' }, h('div', { class: 'eyebrow' }, 'Short adventures'), h('h1', { class: 'h1' }, 'Side Quests'), h('p', { class: 'secondary' }, 'Two bite-sized adventures, each with its own (very official) certificate. Looking for seasonal fun? Try the ', h('a', { href: '#/editions' }, 'Special Editions'), '.')),
      h('div', { class: 'quest-grid' }, cards)));
  return { el, mounted() { music('title'); } };
}
