// Special Editions: Halloween, Thanksgiving and Christmas mini-campaigns, each with its own
// host, cast, art, certificate and unlockable avatar.
import { h, icon, fmtNum, timeAgo } from '../dom.js';
import { confirmModal } from '../modal.js';
import { md } from '../markdown.js';
import { store } from '../../game/state.js';
import { play, music } from '../../game/audio.js';
import { go } from '../router.js';
import { topbar, button, segmented, badge } from '../components.js';
import { EDITIONS, inSeason } from '../../data/editions.js';
import { CERT_BY_ID } from '../../data/certs.js';
import { COMPANION_BY_ID } from '../../data/companions.js';
import { DIFFICULTIES, DIFFICULTY_ORDER } from '../../game/rules.js';
import { getSlot, newRun, runLength } from '../../game/run.js';
import { sealUrl, spriteImg, companionImg, avatarMeta } from '../sprites.js';
import { decor } from '../decor.js';

let lastDiff = 'normal';

export async function render(r) {
  const st = store.state;
  const season = inSeason();
  const focus = r.args[0];
  const stops = [];

  const cards = EDITIONS.map(e => {
    let diff = lastDiff;
    const cert = CERT_BY_ID[e.cert];
    const host = COMPANION_BY_ID[e.host];
    const statusEl = h('div', { class: 'small secondary edition-status' });
    const actions = h('div', { class: 'row-wrap edition-actions' });
    const empty = !e.challenges.length;
    const start = async (fresh) => {
      if (!st.profile.handle) { go(`setup?next=editions/${e.id}`); return; }
      const slot = getSlot(e.id, diff);
      if (fresh && slot && !slot.completed && (slot.index > 0 || slot.current)) {
        const ok = await confirmModal({ title: 'Restart this edition?', message: `This wipes your ${DIFFICULTIES[diff].name} save (${e.dayLabel ? `${e.dayLabel} ` : 'challenge '}${slot.index + 1}, ${fmtNum(slot.score)} pts). Certificates stay on the wall.`, ok: 'rm -rf my save', cancel: 'Keep it', danger: true });
        if (!ok) return;
      }
      if (fresh) newRun(e.id, diff);
      play('unlock');
      go(`play/${e.id}/${diff}`);
    };
    const refresh = () => {
      const slot = getSlot(e.id, diff);
      const inProgress = slot && !slot.completed && (slot.index > 0 || slot.current);
      statusEl.textContent = empty ? 'The elves are still wrapping these challenges. Check back soon!'
        : slot?.completed ? `Completed on ${DIFFICULTIES[diff].name} · ${fmtNum(slot.score)} pts`
          : inProgress ? `In progress: ${e.dayLabel ? `${e.dayLabel} ` : ''}${slot.index + 1}/${runLength(slot)} · ${fmtNum(slot.score)} pts · saved ${timeAgo(slot.updated)}`
            : `Not started on ${DIFFICULTIES[diff].name}`;
      actions.replaceChildren(...[
        inProgress && button('Continue', { variant: 'primary', icon: 'play', onClick: () => start(false) }),
        button(inProgress ? 'Restart' : slot?.completed ? 'Play again' : 'Start', { variant: inProgress ? 'muted' : 'primary', icon: inProgress ? 'reload' : 'play', disabled: empty, onClick: () => start(true) }),
        button('Meet the cast', { variant: 'ghost', icon: 'users', disabled: empty, onClick: () => go(`briefing/${e.id}/${diff}/intro?view=1`) }),
      ].filter(Boolean));
    };
    refresh();
    const earned = !!st.certs[e.cert];
    const unlockAv = avatarMeta(e.unlocks);
    const art = h('div', { class: 'edition-art', 'aria-hidden': 'true' });
    const canvas = h('canvas', { class: 'edition-decor' });
    art.append(canvas, spriteImg(e.logo, { alt: '', cls: 'edition-logo', label: e.short }));
    stops.push(() => decor(canvas, e.decor, { density: 0.5 }));
    const card = h('article', { class: `card edition-card edition-${e.id}${season?.id === e.id ? ' in-season' : ''}${empty ? ' is-empty' : ''}`, id: `edition-${e.id}`, style: { '--ea': e.colors[0], '--eb': e.colors[1] } },
      art,
      h('div', { class: 'edition-body' },
        h('div', { class: 'row-wrap edition-eyebrow' },
          h('span', { class: 'eyebrow' }, `${e.short} edition · ${e.challenges.length || '—'} challenges`),
          season?.id === e.id && badge('In season!', 'success')),
        h('h2', { class: 'h2 edition-name' }, e.name),
        h('p', { class: 'secondary' }, e.blurb),
        host && h('div', { class: 'edition-host-line' },
          h('strong', null, host.name), h('span', { class: 'faint' }, ` · ${host.species} · host`),
          h('div', { class: 'small secondary' }, host.tagline)),
        h('div', { class: 'edition-cast', 'aria-label': 'Cast' }, e.companions.map(id => {
          const c = COMPANION_BY_ID[id];
          return c && h('span', { class: 'edition-cast-member', 'data-tip': `${c.name} the ${c.species}: ${c.tagline}` }, companionImg(id), h('span', { class: 'tiny' }, c.name));
        })),
        h('div', { class: 'row-wrap' },
          badge(`Rank: ${e.rank}`, 'draft'),
          badge(cert.title, earned ? 'success' : 'neutral'),
          unlockAv && badge(earned ? `Avatar unlocked: ${unlockAv.name}` : `Unlocks avatar: ${unlockAv.name}`, earned ? 'success' : 'info')),
        h('div', { class: 'quest-diff' }, h('span', { class: 'field-label' }, 'Difficulty'),
          segmented(DIFFICULTY_ORDER.map(d => ({ value: d, label: DIFFICULTIES[d].name })), diff, (v) => { diff = v; lastDiff = v; refresh(); }, { label: 'Difficulty' })),
        statusEl,
        actions),
      h('div', { class: `edition-seal ${earned ? 'earned' : ''}`, 'data-tip': earned ? 'Certificate earned' : `Earn: ${cert.title}` }, spriteImg(sealUrl(e.cert), { alt: cert.title, label: '★' })));
    return card;
  });

  const el = h('div', { class: 'screen editions-screen' },
    topbar({ title: 'Special Editions', back: 'title' }),
    h('main', { class: 'page' },
      h('div', { class: 'section-title' },
        h('div', { class: 'eyebrow' }, 'Seasonal mini-campaigns'),
        h('h1', { class: 'h1' }, 'Special Editions'),
        md('Three standalone mini-campaigns with their own hosts, characters, art and certificates. Same rules as the campaign — pick a difficulty, keep your hearts, finish them all. Each one unlocks a **special avatar**.', 'md secondary')),
      h('div', { class: 'edition-grid' }, cards)));

  let stopFns = [];
  return {
    el,
    mounted() {
      music('title');
      if (!st.seen.editions) store.update(s => { s.seen.editions = Date.now(); });
      stopFns = stops.map(f => f());
      if (focus) document.getElementById(`edition-${focus}`)?.scrollIntoView({ block: 'center' });
    },
    destroy() { stopFns.forEach(f => f && f()); },
  };
}
