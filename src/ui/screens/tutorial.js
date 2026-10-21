// Tutorial: start the guided tour (all chapters or one), plus a cheat sheet of every game
// command and key. The tour itself runs over the real screens (src/ui/coach.js).
import { h, icon } from '../dom.js';
import { md } from '../markdown.js';
import { store } from '../../game/state.js';
import { play, music } from '../../game/audio.js';
import { go } from '../router.js';
import { topbar, button } from '../components.js';
import { toast } from '../toast.js';
import { startTour } from '../coach.js';
import { getSlot } from '../../game/run.js';
import { DIFFICULTY_ORDER } from '../../game/rules.js';
import { CHAPTERS, COMMANDS, KEYS, tourSteps } from '../../data/tutorial.js';

const doneMap = () => store.state.seen.tutorial || {};
const markDone = (id) => { if (CHAPTERS.some(c => c.id === id)) store.update(s => { (s.seen.tutorial ||= {})[id] = Date.now(); }); };

/** The campaign map the tour shows: the player's most recent campaign run, or an Easy preview. */
function mapRoute() {
  const slots = DIFFICULTY_ORDER.map(d => getSlot('campaign', d)).filter(s => s && (s.index > 0 || s.current));
  slots.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return `map/${slots[0]?.difficulty || 'easy'}?tour=1`;
}

function startCampaign() {
  play('menu-select');
  go(store.state.profile.handle ? 'difficulty/campaign' : 'setup?next=difficulty/campaign');
}

/** Run the tour over some chapters (in order). */
export function runTour(ids) {
  // a run that reaches the last chapter ends on the finale (with somewhere to go next)
  const full = ids.length > 1 && ids[ids.length - 1] === CHAPTERS[CHAPTERS.length - 1].id;
  const steps = tourSteps(ids, { finale: full });
  if (full) {
    steps[steps.length - 1].actions = [
      { label: 'Start the Campaign', icon: 'play', run: startCampaign },
      { label: 'Back to the title', run: () => go('title') },
    ];
  }
  play('menu-select');
  startTour({
    steps,
    ctx: { mapRoute },
    onChapterDone: markDone,
    onEnd: (reason, step) => {
      if (reason === 'done') {
        if (step) markDone(step.chapter);
        if (!full) {
          toast({ title: 'Chapter complete', body: `${step?.chapterTitle || 'Tutorial'} ✓`, iconName: 'check', duration: 2600 });
          go('tutorial');
        }
      } else if (reason === 'left') {
        toast({ title: 'Tutorial paused', body: 'Pick it up again any time from Tutorial on the title menu.', iconName: 'info' });
      }
    },
  });
}

export async function render() {
  const done = doneMap();
  const finished = CHAPTERS.filter(c => done[c.id]).length;
  const firstOpen = CHAPTERS.find(c => !done[c.id]);
  const mins = Math.round(CHAPTERS.reduce((a, c) => a + c.minutes, 0));

  const chapters = CHAPTERS.map((c, i) => h('article', { class: 'card tut-chapter' + (done[c.id] ? ' done' : '') },
    h('div', { class: 'tut-chapter-num arcade' }, done[c.id] ? icon('check') : String(i + 1)),
    h('div', { class: 'tut-chapter-text' },
      h('h2', { class: 'tut-chapter-title' }, icon(c.icon), c.title),
      h('p', { class: 'secondary small' }, c.blurb),
      h('span', { class: 'faint small' }, c.minutes < 1 ? 'under a minute' : `about ${c.minutes} min`)),
    button(done[c.id] ? 'Replay' : 'Play', { variant: done[c.id] ? 'muted' : 'secondary', size: 'sm', icon: 'play', sound: null, onClick: () => runTour([c.id]) })));

  const sheet = (rows) => h('dl', { class: 'tut-sheet' }, rows.flatMap(([k, v]) => [h('dt', { class: 'mono' }, k), h('dd', null, md(v, 'md'))]));

  const lead = finished === CHAPTERS.length
    ? button('Take the whole tour again', { variant: 'secondary', size: 'lg', icon: 'reload', sound: null, onClick: () => runTour(CHAPTERS.map(c => c.id)) })
    : finished && firstOpen
      ? button(`Continue: ${firstOpen.title}`, { variant: 'primary', size: 'lg', icon: 'play', sound: null, onClick: () => runTour(CHAPTERS.filter(c => !done[c.id]).map(c => c.id)) })
      : button('Start the tour', { variant: 'primary', size: 'lg', icon: 'play', sound: null, onClick: () => runTour(CHAPTERS.map(c => c.id)) });

  const el = h('div', { class: 'screen' },
    topbar({ title: 'Tutorial', back: 'title' }),
    h('main', { class: 'page tutorial-page' },
      h('div', { class: 'section-title' },
        h('div', { class: 'eyebrow' }, 'Learn the ropes'),
        h('h1', { class: 'h1' }, 'Tutorial'),
        h('p', { class: 'secondary' }, `A guided tour of every menu, key and command, with a training round where nothing counts. About ${mins} minutes; Esc ends it any time.`)),
      h('div', { class: 'tut-lead' }, lead, h('span', { class: 'muted small' }, `${finished} of ${CHAPTERS.length} chapters done`)),
      h('div', { class: 'tut-chapters' }, chapters),
      h('div', { class: 'tut-sheets' },
        h('section', { class: 'card' }, h('div', { class: 'card-label' }, 'Game commands'), h('p', { class: 'muted small' }, 'Type these at the prompt. None of them costs a heart.'), sheet(COMMANDS)),
        h('section', { class: 'card' }, h('div', { class: 'card-label' }, 'Keys'), h('p', { class: 'muted small' }, 'The terminal edits like bash (readline).'), sheet(KEYS)))));

  return {
    el,
    mounted() {
      music('title');
      if (!store.state.seen.tutorial) store.update(s => { s.seen.tutorial = {}; });
    },
  };
}
