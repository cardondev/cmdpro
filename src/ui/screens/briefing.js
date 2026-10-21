// Tier briefing: story, skills, diagrams, a bit of terminal history, and the cert at stake.
import { h, icon } from '../dom.js';
import { md } from '../markdown.js';
import { play, music } from '../../game/audio.js';
import { go } from '../router.js';
import { topbar, button, badge, kbd } from '../components.js';
import { DIFFICULTIES } from '../../game/rules.js';
import { getSlot, newRun, saveSlot } from '../../game/run.js';
import { TIERS, BONUS } from '../../data/campaign.js';
import { TIER_BRIEFINGS } from '../../data/copy.js';
import { CERT_BY_ID } from '../../data/certs.js';
import { diagram } from '../diagrams.js';
import { sealUrl, spriteImg, companionImg, avatarImg, avatarMeta } from '../sprites.js';
import { EDITION_BY_ID } from '../../data/editions.js';
import { COMPANION_BY_ID } from '../../data/companions.js';
import { store } from '../../game/state.js';
import { decor } from '../decor.js';

let IMAGES = [];
async function loadImages() { try { IMAGES = (await import('../../data/images.js')).IMAGES || []; } catch { IMAGES = []; } }

export async function render(r) {
  if (EDITION_BY_ID[r.args[0]]) return renderEdition(r);
  await loadImages();
  const [kindArg, diffArg, tierArg] = r.args;
  const kind = kindArg === 'bonus' ? 'bonus' : 'campaign';
  const difficulty = DIFFICULTIES[diffArg] ? diffArg : 'normal';
  const viewOnly = r.query.has('view');
  const tierKey = tierArg === 'bonus' ? 'bonus' : String(Math.max(1, Math.min(7, parseInt(tierArg, 10) || 1)));
  const t = tierKey === 'bonus' ? BONUS : TIERS[+tierKey - 1];
  const brief = TIER_BRIEFINGS[tierKey === 'bonus' ? 'bonus' : +tierKey];
  const cert = CERT_BY_ID[t.cert];
  const back = kind === 'bonus' ? 'difficulty/bonus' : `map/${difficulty}`;

  const startPlay = () => {
    if (viewOnly) { play('back'); go(back); return; }
    const slot = getSlot(kind, difficulty) || newRun(kind, difficulty);
    slot.briefed = { ...(slot.briefed || {}), [tierKey]: true };
    saveSlot(slot);
    play('menu-select');
    go(`play/${kind}/${difficulty}`);
  };

  const img = IMAGES.length ? IMAGES[(tierKey === 'bonus' ? 7 : +tierKey - 1) % IMAGES.length] : null;
  const howTo = tierKey === '1' && h('div', { class: 'card card-sunken briefing-howto' },
    h('div', { class: 'card-label' }, 'How to play'),
    h('ul', { class: 'howto-list' },
      h('li', null, icon('terminal'), h('span', null, 'Type a command and press ', kbd('Enter'), '. Its output is compared with the expected answer.')),
      h('li', null, icon('reload'), h('span', null, 'Every judged command runs in a ', h('strong', null, 'fresh copy'), ' of the challenge directory. Break things freely.')),
      h('li', null, icon('heart'), h('span', null, 'Each wrong answer costs a heart. Out of hearts = GAME OVER, back to challenge #1.')),
      h('li', null, icon('search'), h('span', null, 'Want to look around first? Type ', h('code', { class: 'inline' }, 'recon'), ' (or press ', kbd('F2'), ') for a free sandbox shell. ', h('code', { class: 'inline' }, 'exit'), ' to leave.')),
      h('li', null, icon('lightbulb'), h('span', null, h('code', { class: 'inline' }, 'help'), ', ', h('code', { class: 'inline' }, 'hint'), ', ', h('code', { class: 'inline' }, 'files'), ' and ', h('code', { class: 'inline' }, 'solutions'), ' are game commands — they never cost a heart.'))));

  const diagrams = (brief.diagrams || []).map(id => diagram(id)).filter(Boolean);
  const el = h('div', { class: 'screen briefing-screen' },
    topbar({ title: kind === 'bonus' ? 'Bonus Round' : `Campaign · ${DIFFICULTIES[difficulty].name}`, back }),
    h('main', { class: 'page briefing-page' },
      h('header', { class: 'briefing-hero' },
        h('div', { class: 'briefing-world arcade' }, tierKey === 'bonus' ? 'BONUS STAGE' : `WORLD ${tierKey}`),
        h('h1', { class: 'display' }, t.name),
        h('div', { class: 'row-wrap', style: { justifyContent: 'center' } }, badge(`Rank: ${t.rank}`, 'draft'), badge(DIFFICULTIES[difficulty].name, 'neutral'), badge(`${t.challenges.length} challenges`, 'info')),
        md(brief.intro, 'md briefing-intro')),
      howTo,
      h('div', { class: 'briefing-grid' },
        h('div', { class: 'col' },
          h('div', { class: 'card' },
            h('div', { class: 'card-label' }, 'Skills unlocked in this world'),
            h('ul', { class: 'skills' }, brief.skills.map(s => h('li', null, icon('check'), md(s, 'md inline-md'))))),
          h('div', { class: 'card briefing-cert' },
            h('div', { class: 'briefing-cert-seal' }, spriteImg(sealUrl(t.cert), { alt: '', label: '★' })),
            h('div', null,
              h('div', { class: 'card-label', style: { marginBottom: '6px' } }, 'At stake'),
              h('div', { class: 'subhead' }, cert.title),
              h('p', { class: 'secondary small', style: { margin: '4px 0 0' } }, `“${cert.slogan}”`)))),
        h('div', { class: 'col' }, diagrams.map(d => h('div', { class: 'card diagram-card' }, d)))),
      img && h('figure', { class: 'card history-card' },
        h('img', { src: img.file, alt: img.alt, loading: 'lazy', width: img.width, height: img.height }),
        h('figcaption', null,
          h('div', { class: 'card-label', style: { marginBottom: '6px' } }, 'Terminal history'),
          md(img.caption, 'md small'),
          h('div', { class: 'faint tiny' }, 'Photo: ', img.credit, ' · ', h('a', { href: img.licenseUrl || img.source, target: '_blank', rel: 'noopener noreferrer' }, img.license), ' · ', h('a', { href: img.source, target: '_blank', rel: 'noopener noreferrer' }, 'source')))),
      h('div', { class: 'briefing-actions' },
        viewOnly ? button('Back to map', { variant: 'secondary', icon: 'chevron-left', onClick: () => go(back), sound: 'back' })
          : button(tierKey === 'bonus' ? 'Enter the bonus stage' : `Enter World ${tierKey}`, { variant: 'primary', size: 'xl', icon: 'play', onClick: startPlay, sound: null }),
        !viewOnly && h('span', { class: 'muted small' }, 'or press ', kbd('Enter')))));

  const onKey = (e) => {
    if (document.querySelector('.modal-backdrop')) return;
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) { e.preventDefault(); startPlay(); }
    if (e.key === 'Escape') { play('back'); go(back); }
  };
  return {
    el,
    mounted() { music(kind === 'bonus' ? 'bonus' : 'title'); window.addEventListener('keydown', onKey); },
    destroy() { window.removeEventListener('keydown', onKey); },
  };
}

// ---------------------------------------------------------------- holiday editions
function renderEdition(r) {
  const e = EDITION_BY_ID[r.args[0]];
  const difficulty = DIFFICULTIES[r.args[1]] ? r.args[1] : 'normal';
  const viewOnly = r.query.has('view');
  const cert = CERT_BY_ID[e.cert];
  const host = COMPANION_BY_ID[e.host];
  const back = `editions/${e.id}`;
  const earned = !!store.state.certs[e.cert];
  const av = avatarMeta(e.unlocks);
  const startPlay = () => {
    if (viewOnly) { play('back'); go(back); return; }
    const slot = getSlot(e.id, difficulty) || newRun(e.id, difficulty);
    slot.briefed = { ...(slot.briefed || {}), intro: true };
    saveSlot(slot);
    play('menu-select');
    go(`play/${e.id}/${difficulty}`);
  };
  const canvas = h('canvas', { class: 'edition-decor' });
  const cast = e.companions.map(id => COMPANION_BY_ID[id]).filter(Boolean);
  const el = h('div', { class: `screen briefing-screen edition-briefing edition-${e.id}`, style: { '--ea': e.colors[0], '--eb': e.colors[1] } },
    topbar({ title: `${e.short} edition · ${DIFFICULTIES[difficulty].name}`, back }),
    h('main', { class: 'page briefing-page' },
      h('header', { class: 'briefing-hero edition-hero' },
        canvas,
        spriteImg(e.logo, { alt: e.name, cls: 'edition-hero-logo', label: e.short }),
        h('div', { class: 'briefing-world arcade' }, `HOLIDAY EDITION · ${e.season.toUpperCase()}`),
        h('div', { class: 'row-wrap', style: { justifyContent: 'center' } }, badge(`Rank: ${e.rank}`, 'draft'), badge(DIFFICULTIES[difficulty].name, 'neutral'), badge(`${e.challenges.length} challenges`, 'info'))),
      h('div', { class: 'card edition-host-card' },
        h('div', { class: 'edition-host-big' }, companionImg(e.host)),
        h('div', { class: 'col' },
          h('div', { class: 'card-label' }, `Your host: ${host.name} the ${host.species}`),
          md(e.intro, 'md briefing-intro'),
          h('p', { class: 'secondary small', style: { margin: 0 } }, `“${host.lines.join[0].replace(/^[^"“]*["“]?|["”]$/g, '') || host.tagline}”`))),
      h('div', { class: 'briefing-grid' },
        h('div', { class: 'col' },
          h('div', { class: 'card' },
            h('div', { class: 'card-label' }, 'How the edition works'),
            h('ul', { class: 'howto-list' },
              h('li', null, icon('terminal'), h('span', null, `${e.challenges.length} challenges${e.dayLabel ? ' — one advent-calendar door per day' : ''}, gentle at first, devious at the end.`)),
              h('li', null, icon('heart'), h('span', null, `Campaign rules at ${DIFFICULTIES[difficulty].name}: run out of hearts and the edition restarts from #1.`)),
              h('li', null, icon('users'), h('span', null, `${host.name} hosts from the first door; the rest of the cast takes turns from challenge #4.`)),
              h('li', null, icon('search'), h('span', null, 'Every judged command runs in a fresh copy of the directory. ', h('code', { class: 'inline' }, 'recon'), ' is free.')))),
          h('div', { class: 'card briefing-cert' },
            h('div', { class: 'briefing-cert-seal' }, spriteImg(sealUrl(e.cert), { alt: '', label: '★' })),
            h('div', null,
              h('div', { class: 'card-label', style: { marginBottom: '6px' } }, earned ? 'Earned' : 'At stake'),
              h('div', { class: 'subhead' }, cert.title),
              h('p', { class: 'secondary small', style: { margin: '4px 0 0' } }, `“${cert.slogan}”`),
              av && h('div', { class: 'row', style: { marginTop: '10px', gap: '10px', alignItems: 'center' } },
                h('div', { class: 'avatar avatar-sm' + (earned ? '' : ' locked-avatar') }, avatarImg(av.id)),
                h('span', { class: 'small secondary' }, earned ? `Avatar unlocked: ${av.name}` : `Finish to unlock the ${av.name} avatar`))))),
        h('div', { class: 'card' },
          h('div', { class: 'card-label' }, 'The cast'),
          h('ul', { class: 'edition-cast-list' }, cast.map(c => h('li', null,
            h('span', { class: 'edition-cast-sprite' }, companionImg(c.id)),
            h('span', null, h('strong', null, c.name), h('span', { class: 'faint' }, ` · ${c.species}`), h('br'), h('span', { class: 'small secondary' }, c.tagline))))))),
      h('div', { class: 'briefing-actions' },
        viewOnly ? button('Back', { variant: 'secondary', icon: 'chevron-left', onClick: () => go(back), sound: 'back' })
          : button(e.dayLabel ? 'Open the first door' : 'Enter the edition', { variant: 'primary', size: 'xl', icon: 'play', onClick: startPlay, sound: null }),
        !viewOnly && h('span', { class: 'muted small' }, 'or press ', kbd('Enter')))));
  const onKey = (ev) => {
    if (document.querySelector('.modal-backdrop')) return;
    if (ev.key === 'Enter' && !(ev.target instanceof HTMLButtonElement) && !(ev.target instanceof HTMLAnchorElement)) { ev.preventDefault(); startPlay(); }
    if (ev.key === 'Escape') { play('back'); go(back); }
  };
  let stop = null;
  return {
    el,
    mounted() { music('title'); stop = decor(canvas, e.decor, { density: 0.6 }); window.addEventListener('keydown', onKey); },
    destroy() { stop && stop(); window.removeEventListener('keydown', onKey); },
  };
}
