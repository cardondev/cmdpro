// GAME OVER: the kernel panicked so you don't have to.
import { h, icon, pick, fmtNum, fill } from '../dom.js';
import { md } from '../markdown.js';
import { store, session } from '../../game/state.js';
import { play, music } from '../../game/audio.js';
import { go } from '../router.js';
import { button, stat } from '../components.js';
import { GAMEOVER_QUIPS, GAMEOVER_SUBTITLES } from '../../data/copy.js';
import { COMPANION_BY_ID } from '../../data/companions.js';
import { DIFFICULTIES } from '../../game/rules.js';
import { RUN_KINDS } from '../../game/run.js';
import { EDITION_BY_ID } from '../../data/editions.js';
import { companionImg } from '../sprites.js';

export async function render() {
  let sum = null;
  try { sum = JSON.parse(session.get('gameover') || 'null'); } catch { sum = null; }
  if (!sum) { go('title', { replace: true }); return { el: h('div') }; }
  const comp = sum.companion ? COMPANION_BY_ID[sum.companion] : null;
  const certCount = Object.keys(store.state.certs).length;
  const kindName = RUN_KINDS[sum.kind]?.name || 'Run';
  const retryTarget = sum.kind === 'campaign' ? `map/${sum.difficulty}` : `play/${sum.kind}/${sum.difficulty}`;
  const diffTarget = EDITION_BY_ID[sum.kind] ? `editions/${sum.kind}` : sum.kind === 'oops' || sum.kind === '12days' ? 'sidequests' : `difficulty/${sum.kind}`;
  const quip = pick(GAMEOVER_QUIPS);
  const el = h('div', { class: 'screen gameover-screen scanlines' },
    h('main', { class: 'gameover-stage' },
      h('div', { class: 'gameover-title arcade', 'data-text': 'GAME OVER' }, 'GAME OVER'),
      h('div', { class: 'gameover-quip mono' }, '$ ', h('span', { class: 'term-err' }, quip)),
      h('p', { class: 'gameover-sub secondary' }, pick(GAMEOVER_SUBTITLES)),
      h('div', { class: 'card gameover-card' },
        h('div', { class: 'row-wrap gameover-stats' },
          stat('Mode', `${kindName} · ${DIFFICULTIES[sum.difficulty]?.name || sum.difficulty}`),
          stat('Reached', `${sum.reached}/${sum.total}`),
          stat('Score', fmtNum(sum.score)),
          stat('Solved', String(sum.solved)),
          stat('Game overs', String(sum.deaths))),
        h('p', { class: 'secondary small', style: { margin: '10px 0 0' } },
          sum.reason === 'timer' ? 'The clock ran out on ' : 'You ran out of attempts on ', h('strong', null, `“${sum.challengeTitle || 'a challenge'}”`), '. Progress resets to challenge #1.'),
        comp && h('div', { class: 'companion-card', style: { marginTop: '14px' } },
          h('div', { class: 'companion-sprite' }, companionImg(comp.id)),
          h('div', { class: 'companion-text' }, h('div', { class: 'companion-name' }, comp.name), h('div', { class: 'bubble' }, md(fill(pick(comp.lines.gameover), { player: store.state.profile.handle || 'player' }), 'md'))))),
      h('div', { class: 'callout', style: { maxWidth: '560px' } }, icon('trophy'), h('div', null, certCount ? `Your ${certCount} certificate${certCount > 1 ? 's are' : ' is'} safe on the Wall. Certificates are forever.` : 'Certificates you earn stay on the Wall forever — even after a game over.')),
      h('div', { class: 'row-wrap', style: { justifyContent: 'center' } },
        button('Retry from #1', { variant: 'primary', size: 'lg', icon: 'reload', onClick: () => go(retryTarget) }),
        button('Change difficulty', { variant: 'secondary', size: 'lg', onClick: () => go(diffTarget) }),
        button('Main menu', { variant: 'muted', size: 'lg', icon: 'home', onClick: () => go('title') }))));
  const onKey = (e) => { if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); go(retryTarget); } if (e.key === 'Escape') go('title'); };
  return {
    el,
    mounted() { music(null); play('gameover'); window.addEventListener('keydown', onKey); el.querySelector('.btn-primary')?.focus(); },
    destroy() { window.removeEventListener('keydown', onKey); },
  };
}
