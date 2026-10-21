// The tutorial: chapters of a guided tour over the real screens (run by src/ui/coach.js),
// the training round's challenge, and the cheat sheet of game commands and keys.
//
// Step fields (see coach.js): chapter, route, target (CSS selector), title, body, task,
// wait(event) for "do it" steps (cmdpro:play events from the game screen), done() when the
// thing is already done, skipIf(), optional, interact, focus, before(), actions.

export const TRAINING_ID = 'training_run';
export const TRAINING_COMPANION = 'dog';

export const CHAPTERS = [
  { id: 'arcade', title: 'The arcade', blurb: 'Every item on the title screen and what it opens.', minutes: 1, icon: 'gamepad' },
  { id: 'runs', title: 'Pick your run', blurb: 'The four difficulties, save slots and the campaign map.', minutes: 1, icon: 'flag' },
  { id: 'training', title: 'Training run', blurb: 'Play a real challenge where nothing counts: hearts, hints, recon, files, saving.', minutes: 3, icon: 'terminal' },
  { id: 'settings', title: 'Make it yours', blurb: 'Themes, display, sound, your profile and save files.', minutes: 1, icon: 'sliders' },
  { id: 'wall', title: 'Wall of Certificates', blurb: 'What you can earn, and how to print it.', minutes: 0.5, icon: 'trophy' },
];

export const COMMANDS = [
  ['help', 'List the game commands (`help <builtin>` is bash\'s own help)'],
  ['hint', 'Reveal the next hint (F3). Easy and Normal only'],
  ['recon', 'Free sandbox to explore (F2); `exit` or Ctrl+D leaves'],
  ['files', 'Peek at the challenge directory (F4)'],
  ['mission · learn · solutions', 'Open that panel tab (solutions after you solve)'],
  ['save · save export', 'Save now (Ctrl+S) · also download a save file'],
  ['theme [name]', 'List the themes, or switch: `theme dracula`'],
  ['sound on|off', 'Sound on or off'],
  ['focus', 'Full-screen focus mode (F11)'],
  ['clear', 'Clear the screen (Ctrl+L)'],
  ['next', 'Next challenge after solving (or Enter on an empty line)'],
  ['menu', 'Back to the map; your game is saved'],
  ['giveup', 'Free Play only: show the solutions'],
  ['man ls · ls --help', 'Reading the manual never costs a heart'],
];

export const KEYS = [
  ['Tab', 'Complete a command or file name; twice lists the choices'],
  ['↑ ↓', 'Walk through your command history'],
  ['Ctrl+R', 'Search your history'],
  ['Ctrl+A · Ctrl+E', 'Jump to the start · end of the line'],
  ['Ctrl+U · Ctrl+K · Ctrl+W', 'Cut to the start · to the end · the word before the cursor'],
  ['Ctrl+Y', 'Paste what you cut'],
  ['Alt+B · Alt+F', 'Word left · word right'],
  ['Ctrl+C', 'Cancel the line'],
  ['Shift+Enter', 'New line inside one command'],
  ['F1 · F2 · F3 · F4', 'Help · recon · hint · files'],
  ['F11 · Ctrl+S', 'Focus mode · save'],
  ['Esc', 'Back, on menu screens (and ends the tour)'],
];

const TERM = ['.play-screen .term-window', '.play-screen .extra-keys']; // + the on-screen keys (phones)
const PANEL = '.play-screen .side-panel';
// Below 900px the side panel is an overlay: open it for panel steps, close it for terminal steps.
const narrow = () => matchMedia('(max-width: 900px)').matches;
const showPanel = () => { if (narrow() && !document.querySelector('.play-screen.panel-open')) document.querySelector('.play-screen .hud-panel-btn')?.click(); };
const showTerminal = () => { if (narrow() && document.querySelector('.play-screen.panel-open')) document.querySelector('.play-screen .panel-close')?.click(); };
const solved = () => !!document.querySelector('.play-screen.solved');
const inRecon = () => !!document.querySelector('.play-screen.in-recon');
const meta = (cmd) => (e) => e.type === 'meta' && e.cmd === cmd;
const item = (name) => `.title-item[data-item="${name}"]`;
const pressStart = () => { document.querySelector('.title-screen:not(.started) .press-start')?.click(); };

const CHAPTER_STEPS = {
  arcade: [
    { route: 'tutorial', title: 'Welcome to the tour!', body: 'We\'ll visit every screen of CMDPRO, starting with the **main menu**, then play a training round where nothing counts. **Next** takes you there; **Esc** ends the tour any time.' },
    { route: 'title', before: pressStart, target: '.title-menu', title: 'First stop: the main menu', body: 'This is the title screen\'s menu, where every part of the game starts. Move the ▶ cursor with the arrow keys or the mouse; **Enter** or a click picks.' },
    { route: 'title', target: item('campaign'), title: 'Campaign', body: 'The main game: 100 challenges across 7 worlds, then the bonus round. Every difficulty keeps its own save, so Easy and Hard can run side by side.' },
    { route: 'title', target: item('tutorial'), title: 'Tutorial', body: 'You are here. Replay the whole tour, or just one chapter, whenever you like. It also has a cheat sheet of every command and key.' },
    { route: 'title', target: item('bonus-round'), title: 'Bonus Round', body: 'Five brutal problems for anyone who thinks they\'re beyond expert. Beat all five for the **Machine** certificate.' },
    { route: 'title', target: item('special-editions'), title: 'Special Editions', body: 'Halloween, Thanksgiving and Christmas mini-campaigns, each with its own host, cast, certificate and an avatar to unlock.' },
    { route: 'title', target: item('free-play'), title: 'Free Play', body: 'Practice any challenge: unlimited attempts, every hint, and a give-up button that shows the answers. No score, no pressure.' },
    { route: 'title', target: item('side-quests'), title: 'Side Quests', body: 'Two story runs: *Gremlins Ate /bin* (survive on bash builtins alone) and *The Twelve Labors*, each with its own certificate.' },
    { route: 'title', target: item('wall-of-certificates'), title: 'Wall of Certificates', body: 'Every certificate you\'ve earned, ready to print with your name on it. Locked ones show what it takes.' },
    { route: 'title', target: item('settings'), title: 'Settings', body: '13 themes, the CRT effect, font size, sound, your profile and save files.' },
    { route: 'title', target: item('credits'), title: 'Credits', body: 'Who made CMDPRO, and the fonts, sounds and icons it uses.' },
    { route: 'title', target: '.player-chip', title: 'Player 1', body: 'Your handle (it\'s in your prompt), your avatar and the name printed on certificates. Click here to change them any time.' },
    { route: 'title', target: '.title-hiscore', title: 'Hi-score', body: 'Your best score from any run. Something to beat.' },
  ],
  runs: [
    { route: 'difficulty/campaign', target: '.diff-grid', title: 'Choose your difficulty', body: 'This is the screen **Campaign** opens (Bonus Round and Side Quests use one like it). Each card is its own save slot.' },
    { route: 'difficulty/campaign', target: '.diff-card.diff-easy', title: 'Easy', body: '5 hearts per challenge, free hints, and the lesson open from the start. The place to begin.' },
    { route: 'difficulty/campaign', target: '.diff-card.diff-normal', title: 'Normal', body: '3 hearts. Hints cost points, and a wrong answer tells you how many lines you were off. Score ×1.5.' },
    { route: 'difficulty/campaign', target: '.diff-card.diff-hard', title: 'Hard', body: '2 hearts and no hints: just ✓ or ✗. Score ×2.' },
    { route: 'difficulty/campaign', target: '.diff-card.diff-extreme', title: 'Extremely Hard', body: '1 heart, a 2–5 minute clock, no copy-paste and only 3 recon commands per challenge. Score ×3, and a certificate for legends who finish.' },
    { route: 'difficulty/campaign', target: '.diff-card.diff-easy .diff-status', title: 'Your save', body: 'Where that run stands and when it was last saved. **Continue** picks it up; **New run** starts over (it asks first). Lose every heart on a challenge and that run goes back to #1, but certificates are forever.' },
    { route: (ctx) => ctx.mapRoute(), target: '.map-summary', title: 'The campaign map', body: 'Your run at a glance: current challenge, score, solves and game overs. **Continue** (or Enter) jumps straight back in.' },
    { route: (ctx) => ctx.mapRoute(), target: '.worlds .world', title: 'Worlds', body: 'Seven worlds, gentle to fiendish, then the bonus stage. Clear a world to earn its certificate: the seal on the right shows which. **Briefing** replays its intro.' },
    { route: (ctx) => ctx.mapRoute(), target: '.map-node.current', skipIf: () => !document.querySelector('.map-node.current'), title: 'You are here', body: 'Solved challenges get a ✓ (click one to replay it in Free Play); the rest unlock as you go.' },
  ],
  training: [
    { route: 'training', noBack: true, title: 'Training run', body: 'This is the game screen, where every challenge is played, loaded with a real challenge where nothing counts: nothing is saved, the score is pretend, and hearts refill. Bash the dog came along to help.' },
    { route: 'training', noBack: true, target: '.play-screen .hud-left', title: 'That\'s you', body: 'Your avatar, handle and what you\'re playing: the mode and difficulty.' },
    { route: 'training', target: '.play-screen .hud-mid', title: 'Where you are', body: 'World, challenge number (like **12/100** in the campaign) and the challenge title.' },
    { route: 'training', target: '.play-screen .hud-hearts', title: 'Hearts', body: 'Attempts left on this challenge. A wrong answer costs one. Lose them all and it\'s game over: that run starts again at challenge #1 (certificates stay).' },
    { route: 'training', target: '.play-screen .hud-score-box', title: 'Score', body: 'Each solve scores points: more for spare hearts, less for hints, and multiplied on harder difficulties.' },
    { route: 'training', target: PANEL, before: showPanel, title: 'The mission', body: 'The story and exactly what to produce: here, show what\'s written in `password.txt`. The tabs hold hints, files, a lesson and the solutions.' },
    { route: 'training', noBack: true, target: TERM, before: showTerminal, dock: 'top', focus: '.term-hidden-input', title: 'The judged prompt', body: 'This is real bash, and it\'s **judged**: every command you run here is checked against the mission. Game commands are the exception.', task: 'Type `help` and press Enter.', wait: meta('help') },
    { route: 'training', noBack: true, target: TERM, before: showTerminal, dock: 'top', focus: '.term-hidden-input', title: 'Game commands', body: 'That list is everything you can type without spending a heart. Now look around safely:', task: 'Type `recon` (or press F2).', wait: (e) => e.type === 'recon-start', done: inRecon },
    { route: 'training', noBack: true, target: TERM, before: showTerminal, dock: 'top', focus: '.term-hidden-input', skipIf: () => !inRecon(), title: 'Recon sandbox', body: 'A private copy of the challenge directory where nothing is judged. Poke around:', task: 'Type `ls` and press Enter.', wait: (e) => e.type === 'recon-cmd' },
    { route: 'training', noBack: true, target: TERM, before: showTerminal, dock: 'top', focus: '.term-hidden-input', title: 'Explore freely', body: 'Try `cat notes.txt` or `ls vault` if you\'re curious. When you\'re done:', task: 'Type `exit` (or press F2) to go back to the judged prompt.', wait: (e) => e.type === 'recon-stop', done: () => !inRecon() },
    { route: 'training', noBack: true, target: PANEL, before: showPanel, title: 'Files', body: 'A read-only peek at the directory, hidden files included.', task: 'Open the **Files** tab (F4, or type `files`), then click a file to preview it.', wait: (e) => e.type === 'tab' && e.id === 'files' },
    { route: 'training', noBack: true, target: PANEL, before: showPanel, focus: '.term-hidden-input', title: 'Hints', body: 'Stuck? Hints come one at a time: free on Easy, a few points each on Normal, and none at all on Hard and Extreme.', task: 'Type `hint` (F3), or press **Reveal hint** in the Hints tab.', wait: meta('hint') },
    { route: 'training', noBack: true, target: TERM, before: showTerminal, dock: 'top', focus: '.term-hidden-input', skipIf: solved, title: 'A wrong answer', body: 'Let\'s get one wrong on purpose, so you know what it looks like.', task: 'Type `ls` at the judged prompt and press Enter.', wait: (e) => e.type === 'judged' && !e.correct },
    { route: 'training', noBack: true, target: '.play-screen .hud-hearts', skipIf: solved, title: 'Ouch', body: '✗, and a heart is gone. On Easy and Normal you also learn how far off you were. Training hearts refill, so no harm done.' },
    { route: 'training', noBack: true, target: TERM, before: showTerminal, dock: 'top', focus: '.term-hidden-input', title: 'Now solve it', body: 'Show what\'s written in `password.txt`. **Tab** finishes file names, so you rarely type them in full.', task: 'Type `cat pa`, press **Tab**, then Enter.', wait: (e) => e.type === 'judged' && e.correct, done: solved },
    { route: 'training', noBack: true, target: PANEL, before: showPanel, title: 'Solved!', body: '✓ plus points. The **Solutions** tab now shows other ways to do it, each with a note on why it works. Worth a look after every challenge.' },
    { route: 'training', noBack: true, target: PANEL, before: showPanel, title: 'Learn', body: 'Every challenge comes with a short lesson. On Easy it\'s open from the start; otherwise it unlocks when you solve.', task: 'Open the **Learn** tab (or type `learn`).', wait: (e) => e.type === 'tab' && e.id === 'learn' },
    { route: 'training', target: '.play-screen .companion-card', before: showPanel, title: 'Companions', body: 'From challenge #4 a companion joins your run: they cheer, tease and pass on hints, taking turns every couple of challenges.' },
    { route: 'training', noBack: true, target: '.play-screen .hud-save', focus: '.term-hidden-input', title: 'Saving', body: 'Your progress saves itself after every command. Saving on demand also keeps this terminal, so Continue drops you right back here.', task: 'Press **Ctrl+S** (or type `save`, or click the floppy).', wait: (e) => e.type === 'save' },
    { route: 'training', noBack: true, target: TERM, before: showTerminal, dock: 'top', focus: '.term-hidden-input', optional: true, title: 'Themes', body: 'Thirteen looks, from Catppuccin to Vim Classic. The whole game re-skins instantly.', task: 'Type `theme` to list them, then `theme dracula` (or any other). Or press **Skip**.', wait: (e) => e.type === 'meta' && e.cmd === 'theme' && e.args.length > 0 },
    { route: 'training', target: '.play-screen [aria-label="Focus mode (F11)"]', title: 'Focus mode', body: '**F11** (or `focus`) goes full screen: just you and the prompt. The panel slides in when you need it.' },
    { route: 'training', target: '.play-screen [aria-label="Toggle sound"]', title: 'Sound', body: 'Mute or unmute with one click, or type `sound off`. Volume, music and keyboard clicks live in Settings.' },
    { route: 'training', target: '.play-screen .statusbar', title: 'Keys', body: 'The status bar lists the function keys. More shell keys: ↑/↓ history, **Ctrl+R** search, **Ctrl+C** cancel, **Ctrl+L** clear, **Shift+Enter** new line. The Tutorial page has the full list.' },
    { route: 'training', target: '.play-screen [aria-label="Menu"]', title: 'Menu', body: 'Back to the map any time. Your game is saved, so nothing is lost.' },
    { route: 'training', noBack: true, target: TERM, before: showTerminal, dock: 'top', focus: '.term-hidden-input', title: 'On to the next one', body: 'After a solve, press Enter on an empty line (or type `next`) for the next challenge. Finish the training run:', task: 'Press **Enter** on the empty prompt.', wait: (e) => e.type === 'next', takeNext: true },
  ],
  settings: [
    { route: 'settings', target: '.settings-themes', interact: true, title: 'Settings: themes', body: 'This is **Settings** (main menu → Settings). Click any card to re-skin the whole game, terminal included: dark and light, editor classics and retro phosphor.' },
    { route: 'settings', target: '.settings-display', title: 'Display', body: 'The CRT effect (scanlines and glow), reduced motion and the terminal font size.' },
    { route: 'settings', target: '.settings-sound', title: 'Sound', body: 'Master switch, effects, music, keyboard clicks and volume.' },
    { route: 'settings', target: '.settings-profile', title: 'Profile', body: 'Your handle, avatar and the name on your certificates.' },
    { route: 'settings', target: '.settings-data', title: 'Save data', body: 'Everything lives in this browser. **Export save** downloads a file you can **Import** on another device. **Reset** wipes progress (it makes you type a scary command first).' },
    { route: 'settings', target: '.settings-stats', title: 'Stats', body: 'Commands, solves, hints and game overs, plus your top scores on each difficulty.' },
  ],
  wall: [
    { route: 'wall', target: '.wall-group', title: 'The Wall of Certificates', body: 'This is the **Wall** (main menu → Wall of Certificates): one certificate for each world, the bonus round, every side quest and special edition, and a few for legends. Earned ones shine; locked ones say how to get them.' },
    { route: 'wall', target: '.wall-grid .plaque', title: 'Open one', body: 'Click a certificate to see it full size. Earned ones print (or save as PDF or SVG) with your name on them; locked ones stay a dimmed specimen until they\'re yours.' },
  ],
};

/** The steps for some chapters, in order (each step tagged with its chapter). */
export function tourSteps(ids, { finale = false } = {}) {
  const steps = [];
  for (const ch of CHAPTERS.filter(c => ids.includes(c.id))) {
    const list = CHAPTER_STEPS[ch.id];
    list.forEach((s, i) => steps.push({ ...s, chapter: ch.id, chapterTitle: ch.title, pos: i + 1, of: list.length }));
  }
  if (finale) {
    steps.push({ chapter: 'finale', chapterTitle: 'All done', finale: true, title: 'You\'re ready!', body: 'That\'s every menu, key and command. New to the shell? Start the Campaign on **Easy**: World 1 begins gently. The Tutorial page keeps a cheat sheet of every command and key.' });
  }
  return steps;
}

export const CHAPTER_STEP_COUNTS = Object.fromEntries(Object.entries(CHAPTER_STEPS).map(([k, v]) => [k, v.length]));
