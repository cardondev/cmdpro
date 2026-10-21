// The game screen: HUD + real-feeling terminal + side panel (mission, hints,
// files, learn, solutions) + companion + tmux-style status bar.
import { h, icon, pick, fill, fmtNum, fmtTime, rng, downloadBlob } from '../dom.js';
import { md, inline, termSegments } from '../markdown.js';
import { Terminal } from '../terminal.js';
import { store, session, history } from '../../game/state.js';
import { play, music, typing } from '../../game/audio.js';
import { setSetting } from '../../game/settings.js';
import { go } from '../router.js';
import { button, iconButton, hearts } from '../components.js';
import { toast } from '../toast.js';
import { confirmModal } from '../modal.js';
import { confetti } from '../confetti.js';
import { engine } from '../../game/engine.js';
import { DIFFICULTIES, PRACTICE, TRAINING, points } from '../../game/rules.js';
import {
  getSlot, newRun, beginChallenge, wrongAttempt, useHint, useRecon, solve, advance, gameOver,
  listFor, runLength, tierInfo, companionFor, saveSlot, savedTerminal, saveTerminal, CH_BY_ID, RUN_KINDS,
} from '../../game/run.js';
import { TIERS } from '../../data/campaign.js';
import { COMPANION_BY_ID, REGULAR_COMPANIONS } from '../../data/companions.js';
import { EDITION_BY_ID } from '../../data/editions.js';
import { decor } from '../decor.js';
import { CORRECT_LINES, WRONG_LINES, PASTE_BLOCKED, HELP_LINES, TIMEOUT_LINES } from '../../data/copy.js';
import { THEMES, findTheme } from '../../data/themes.js';
import { TRAINING_ID, TRAINING_COMPANION } from '../../data/tutorial.js';
import { avatarImg, companionImg, companionUrl, holidayIcon } from '../sprites.js';
import { continueTarget } from './map.js';

const META = new Set(['help', 'hint', 'recon', 'files', 'solutions', 'focus', 'theme', 'sound', 'save', 'menu', 'clear', 'next', 'giveup', 'exit', 'logout', 'quit', 'learn', 'mission']);

function hashStr(s) { let x = 2166136261; for (const c of s) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } return x >>> 0; }

export async function render(r) {
  // ---------------- resolve mode / run / challenge ----------------
  const practice = r.name === 'practice';
  const training = r.name === 'training'; // the tutorial's training round: nothing is saved
  const noRun = practice || training;
  const kind = practice ? 'practice' : training ? 'training' : (RUN_KINDS[r.args[0]] ? r.args[0] : 'campaign');
  const difficulty = practice ? 'practice' : training ? 'training' : (DIFFICULTIES[r.args[1]] ? r.args[1] : 'normal');
  const rules = practice ? PRACTICE : training ? TRAINING : DIFFICULTIES[difficulty];
  const st = store.state;
  const handle = st.profile.handle || 'player';
  let slot = null, ch, cur;

  if (noRun) {
    ch = CH_BY_ID[training ? TRAINING_ID : r.args[0]];
    if (!ch) { go(training ? 'tutorial' : 'freeplay', { replace: true }); return { el: h('div') }; }
    cur = { id: ch.id, attemptsLeft: rules.attempts, hintsUsed: 0, reconUsed: 0, solved: false, startedAt: Date.now() };
  } else {
    slot = getSlot(kind, difficulty) || newRun(kind, difficulty);
    if (!runLength(slot)) {
      toast({ title: 'Nothing here yet', body: 'This run has no challenges in this build. Try the campaign!', iconName: 'info' });
      go('title', { replace: true });
      return { el: h('div') };
    }
    if (slot.completed || slot.index >= runLength(slot)) { go(kind === 'campaign' ? `map/${difficulty}` : 'wall', { replace: true }); return { el: h('div') }; }
    const id0 = listFor(kind)[slot.index];
    if (kind === 'campaign') {
      const t = TIERS.find(x => x.challenges.includes(id0));
      const tierKey = t ? String(t.id) : 'bonus';
      if (!slot.briefed?.[tierKey]) { go(`briefing/campaign/${difficulty}/${tierKey}`, { replace: true }); return { el: h('div') }; }
    } else if (kind === 'bonus' && !slot.briefed?.bonus) { go(`briefing/bonus/${difficulty}/bonus`, { replace: true }); return { el: h('div') }; }
    else if (EDITION_BY_ID[kind] && !slot.briefed?.intro) { go(`briefing/${kind}/${difficulty}/intro`, { replace: true }); return { el: h('div') }; }
    cur = beginChallenge(slot);
    ch = CH_BY_ID[cur.id];
  }
  const info = tierInfo(ch.id);
  const ed = info.edition ? EDITION_BY_ID[info.edition] : null;
  const index = noRun ? 0 : slot.index;
  const tierLabel = training ? 'Tutorial · Training run' : ed ? `${ed.name}${ed.dayLabel ? ` · ${ed.dayLabel} ${info.pos + 1}` : ''}`
    : info.tier === 'bonus' ? 'Bonus · Machine' : info.side ? info.meta.name : info.meta ? `World ${info.tier} · ${info.meta.name}` : 'Free Play';
  const total = practice ? 0 : training ? 1 : runLength(slot);
  // `dir` (when the metadata provides it) wins: some challenges share a directory.
  const dirName = ch.dir || '/var/challenges/' + ch.slug;
  const promptDir = dirName.split('/').filter(Boolean).pop() || ch.slug;

  // Companion: from challenge #4 on, rotating every 2 (practice: a fixed buddy per challenge;
  // training: one from the start, so the tutorial can show what companions do).
  const compId = training ? TRAINING_COMPANION : practice ? pick(ed ? ed.companions : REGULAR_COMPANIONS.map(c => c.id), rng(hashStr(ch.id))) : companionFor(slot, index);
  const prevCompId = noRun ? null : companionFor(slot, index - 1);
  const hostName = ed ? ed.promptHost : 'cmdpro';
  const comp = compId ? COMPANION_BY_ID[compId] : null;
  let lastCmd = '';
  // Game events for listeners such as the tutorial coach. Cancelable: a listener that calls
  // preventDefault() takes over what happens next (emit returns false then).
  const emit = (type, detail = {}) => document.dispatchEvent(new CustomEvent('cmdpro:play', { detail: { type, mode: kind, challenge: ch.id, ...detail }, cancelable: true }));
  const say = (cat, vars = {}) => {
    if (!comp) return null;
    const line = fill(pick(comp.lines[cat] || comp.lines.idle), { player: handle, cmd: lastCmd, ...vars });
    bubble.replaceChildren(md(line, 'md'));
    bubbleWrap.classList.remove('pop'); void bubbleWrap.offsetWidth; bubbleWrap.classList.add('pop');
    return line;
  };

  // ---------------- state ----------------
  let recon = false;
  let reconCwd = '';
  let revealed = 0;
  let timerInt = null, idleInt = null, clockInt = null;
  let lastActivity = Date.now();
  let warned30 = false, lastTick = -1;
  let ended = false;
  let solvedResult = null;
  let gaveUp = false;
  const hintsList = ch.hints || [];
  const hintsAllowed = rules.hints;
  if (!practice) revealed = Math.min(cur.hintsUsed || 0, hintsList.length);

  // ---------------- HUD ----------------
  const heartsWrap = h('span', { class: 'hud-hearts' }, hearts(cur.attemptsLeft, rules.attempts));
  const scoreEl = h('span', { class: 'hud-score mono' }, practice ? '—' : fmtNum(slot ? slot.score : 0));
  const timerEl = h('span', { class: 'hud-timer mono', 'aria-live': 'off' });
  const compHud = comp ? h('button', { type: 'button', class: 'hud-companion', 'data-tip': `${comp.name} the ${comp.species}`, onclick: () => { say('idle'); openPanel('mission'); } }, companionImg(comp.id)) : null;
  const soundBtn = iconButton(st.settings.sound.master ? 'volume-2' : 'volume-x', { label: 'Toggle sound', onClick: () => toggleSound() });
  const panelBtn = iconButton('file-text', { label: 'Mission panel', cls: 'hud-panel-btn', onClick: () => togglePanel() });
  const saveBtn = practice ? null : iconButton('save', { label: 'Save game (Ctrl+S)', cls: 'hud-save', sound: null, onClick: () => { saveGame(); term.focus(); } });
  const hud = h('header', { class: 'hud' },
    h('div', { class: 'hud-left' },
      h('div', { class: 'avatar avatar-sm' }, avatarImg(st.profile.avatar)),
      h('div', { class: 'hud-who' }, h('span', { class: 'hud-handle mono' }, handle), h('span', { class: 'hud-mode' }, practice ? 'Free Play' : training ? 'Tutorial · Training' : `${RUN_KINDS[kind].name} · ${rules.name}`))),
    h('div', { class: 'hud-mid' },
      h('span', { class: 'chip hud-tier' }, tierLabel),
      !practice && h('span', { class: 'hud-count mono' }, `${index + 1}`, h('span', { class: 'faint' }, `/${total}`)),
      h('span', { class: 'hud-title' }, ch.title)),
    h('div', { class: 'hud-right' },
      heartsWrap,
      !practice && h('span', { class: 'hud-stat hud-score-box' }, h('span', { class: 'k' }, 'Score'), scoreEl),
      rules.timer && h('span', { class: 'hud-stat timer' }, icon('hourglass'), timerEl),
      compHud,
      panelBtn,
      iconButton('fullscreen', { label: 'Focus mode (F11)', onClick: () => toggleFocus() }),
      soundBtn,
      saveBtn,
      iconButton('home', { label: 'Menu', onClick: () => leave() })));

  // ---------------- terminal ----------------
  const promptSegs = () => [
    ...(recon ? [{ t: '[recon] ', c: 'term-recon' }] : []),
    ...(ed ? [{ t: ed.glyph + ' ', c: 'term-glyph' }] : []),
    { t: `${handle}@${hostName}`, c: 'term-user' }, { t: ':' }, { t: recon ? (reconCwd.split('/').pop() || '/') : promptDir, c: 'term-path' }, { t: '$ ' },
  ];
  const term = new Terminal({
    history: history.lines,
    prompt: promptSegs,
    onSubmit: (text) => submit(text),
    onComplete: (line, cursor) => engine().complete(ch.id, line, cursor, { recon }),
    isIncomplete: (text) => engine().isIncomplete(text),
    onType: () => { lastActivity = Date.now(); typing(); },
    onBell: (k) => play(k === 'error' ? 'error' : 'bell'),
    pasteGuard: rules.paste ? null : () => { play('error'); return '[blocked] ' + pick(PASTE_BLOCKED); },
    onKey: (e) => {
      if (e.key === 'F1') { meta('help'); return true; }
      if (e.key === 'F2') { meta(recon ? 'exit' : 'recon'); return true; }
      if (e.key === 'F3') { meta('hint'); return true; }
      if (e.key === 'F4') { meta('files'); return true; }
      if (e.key === 'F11') { toggleFocus(); return true; }
      return false;
    },
    onEOF: () => { if (recon) { term.echoCommand('exit'); stopRecon(); } },
  });
  const termTitle = h('div', { class: 'term-title' }, `${handle}@${hostName}: ${dirName} — bash`);
  const termWindow = h('section', { class: 'term-window', 'aria-label': 'Terminal' },
    h('div', { class: 'term-titlebar' }, h('div', { class: 'term-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), termTitle, h('span', { class: 'term-size' }, '80×24')),
    term.el);

  // ---------------- side panel ----------------
  const tabsDef = [
    ['mission', 'Mission', 'flag'],
    ['hints', 'Hints', 'lightbulb'],
    ['files', 'Files', 'folder'],
    ['learn', 'Learn', 'file-text'],
    ['solutions', 'Solutions', 'check-double'],
  ];
  let activeTab = 'mission';
  const tabBtns = {};
  const tabBody = h('div', { class: 'panel-body', role: 'tabpanel', 'aria-live': 'polite' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, tabsDef.map(([id, label, ic]) => (tabBtns[id] = h('button', {
    type: 'button', class: 'tab', role: 'tab', 'aria-selected': 'false', 'aria-label': label, title: label, onclick: () => { play('menu-move'); showTab(id); },
  }, icon(ic), h('span', { class: 'tab-label' }, label)))));
  const bubble = h('div', { class: 'bubble' });
  const bubbleWrap = h('div', { class: 'companion-card' + (comp ? '' : ' narrator') },
    comp ? h('div', { class: 'companion-sprite' }, companionImg(comp.id)) : h('div', { class: 'companion-sprite narrator-sprite' }, icon('terminal')),
    h('div', { class: 'companion-text' },
      h('div', { class: 'companion-name' }, comp ? `${comp.name}` : 'Narrator', h('span', { class: 'faint' }, comp ? ` · ${comp.species}` : ' · the voice in the terminal')),
      bubble));
  const panel = h('aside', { class: 'side-panel', 'aria-label': 'Challenge panel' },
    h('button', { type: 'button', class: 'panel-close btn btn-muted btn-sm', onclick: () => togglePanel(false) }, icon('close'), 'Close'),
    tabs, tabBody, bubbleWrap);

  function showTab(id) {
    activeTab = id;
    emit('tab', { id });
    for (const [k, b] of Object.entries(tabBtns)) b.setAttribute('aria-selected', String(k === id));
    tabBody.replaceChildren(renderTab(id));
    tabBody.scrollTop = 0;
  }
  function openPanel(id) { showTab(id); togglePanel(true); }
  function togglePanel(force) {
    const open = force === undefined ? !screen.classList.contains('panel-open') : force;
    screen.classList.toggle('panel-open', open);
    if (!open) term.focus();
  }
  function refreshTabPips() {
    tabBtns.solutions.classList.toggle('has-pip', !!cur.solved);
    tabBtns.hints.classList.toggle('has-pip', hintsAllowed && revealed < hintsList.length);
  }

  function renderTab(id) {
    if (id === 'mission') {
      return h('div', { class: 'col' },
        h('div', { class: ch.icon ? 'mission-head' : null }, ch.icon && holidayIcon(ch.icon, { cls: 'mission-icon' }), h('div', null, h('div', { class: 'eyebrow' }, tierLabel), h('h2', { class: 'h2', style: { marginTop: '4px' } }, ch.title))),
        ch.story && h('p', { class: 'mission-story' }, ...inline(ch.story)),
        md(ch.description, 'md mission-desc'),
        h('div', { class: 'row-wrap' }, (ch.tags || []).map(t => h('span', { class: 'chip' }, '#' + t))),
        rules.timer && h('div', { class: 'callout warn' }, icon('hourglass'), h('div', null, `Time limit: ${fmtTime(ch.timeLimit)}. The clock keeps running even if you leave.`)),
        !rules.paste && h('div', { class: 'callout danger' }, icon('keyboard'), h('div', null, 'Extremely Hard: paste is disabled. Every keystroke must be yours.')),
        practice && !cur.solved && button('Give up & show solutions', { variant: 'muted', icon: 'flag', onClick: () => meta('giveup') }));
    }
    if (id === 'hints') {
      if (!hintsAllowed) return h('div', { class: 'col' }, h('div', { class: 'callout warn' }, icon('lock'), h('div', null, `No hints on ${rules.name}. You chose this. Your companion offers moral support instead.`)));
      const items = hintsList.slice(0, revealed).map((t, i) => h('li', null, h('span', { class: 'hint-n mono' }, `#${i + 1}`), md(t, 'md')));
      return h('div', { class: 'col' },
        h('p', { class: 'secondary small' }, hintsList.length ? `${revealed} of ${hintsList.length} hints revealed.${rules.hintCost && !practice ? ` Each costs ${rules.hintCost} pts.` : ''}` : 'This one has no hints. Trust your instincts (and `recon`).'),
        items.length ? h('ol', { class: 'hint-list' }, items) : null,
        revealed < hintsList.length && button(`Reveal hint ${revealed + 1}${rules.hintCost && !practice ? ` (−${rules.hintCost} pts)` : ''}`, { variant: 'secondary', icon: 'lightbulb', onClick: () => meta('hint') }));
    }
    if (id === 'files') {
      const box = h('div', { class: 'col files-tab' }, h('p', { class: 'secondary small' }, h('span', { class: 'mono' }, dirName), ' — read-only peek. Use ', h('code', { class: 'inline' }, 'recon'), ' to experiment.'));
      const treeEl = h('ul', { class: 'file-tree' }, h('li', { class: 'muted small' }, 'Loading…'));
      const prev = h('pre', { class: 'file-preview hidden' });
      box.append(treeEl, prev);
      engine().tree(ch.id).then((entries) => {
        if (!Array.isArray(entries)) { treeEl.replaceChildren(h('li', { class: 'muted small' }, 'Could not list files.')); return; }
        treeEl.replaceChildren();
        if (!entries.length) treeEl.appendChild(h('li', { class: 'muted small' }, '(empty directory)'));
        const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
        for (const e of sorted.slice(0, 400)) {
          const depth = e.path.split('/').length - 1;
          const name = e.path.split('/').pop();
          const hidden = name.startsWith('.');
          const li = h('li', { class: `ft-${e.type}${hidden ? ' ft-hidden' : ''}`, style: { paddingLeft: (depth * 14) + 'px' } },
            icon(e.type === 'dir' ? 'folder' : e.type === 'symlink' ? 'external-link' : 'file'),
            e.type === 'file'
              ? h('button', { type: 'button', class: 'ft-name', onclick: async () => {
                const txt = await engine().readFile(ch.id, e.path);
                prev.classList.remove('hidden');
                prev.textContent = (typeof txt === 'string' ? txt : '').slice(0, 20000) || '(empty file)';
                prev.scrollTop = 0;
              } }, name)
              : h('span', { class: 'ft-name' }, name + (e.type === 'dir' ? '/' : '')),
            e.type === 'symlink' && h('span', { class: 'faint' }, ' → ' + e.target),
            e.type === 'file' && h('span', { class: 'ft-size faint mono' }, e.size + 'B'));
          treeEl.appendChild(li);
        }
      }).catch(() => treeEl.replaceChildren(h('li', { class: 'muted small' }, 'Could not list files.')));
      return box;
    }
    if (id === 'learn') {
      const allowed = cur.solved || rules.learnBefore || gaveUp;
      if (!allowed) return h('div', { class: 'callout' }, icon('lock'), h('div', null, 'The lesson unlocks after you solve this one. (On Easy it is available right away.)'));
      return h('div', { class: 'col' }, ch.learn ? md(ch.learn, 'md') : h('p', { class: 'secondary' }, 'No lesson for this one — the Solutions tab is your teacher.'));
    }
    if (id === 'solutions') {
      if (!cur.solved && !gaveUp) return h('div', { class: 'callout' }, icon('eye-off'), h('div', null, 'Solve it first — no peeking!', practice ? ' (In Free Play you can type `giveup`.)' : ''));
      const mine = (cur.solvedCmd || '').trim();
      const sols = (ch.solutions || []).filter(s => s.cmd.trim() !== mine);
      return h('div', { class: 'col' },
        cur.solved && cur.solvedCmd && h('div', { class: 'solution yours' }, h('div', { class: 'solution-note' }, icon('star'), 'Your answer'), h('pre', { class: 'solution-cmd' }, cur.solvedCmd)),
        h('div', { class: 'eyebrow' }, `${sols.length} other way${sols.length === 1 ? '' : 's'} to solve this`),
        sols.map(s => h('div', { class: 'solution' },
          h('pre', { class: 'solution-cmd' }, s.cmd),
          h('div', { class: 'solution-foot' },
            h('span', { class: 'solution-note' }, s.note || ''),
            h('button', { type: 'button', class: 'btn btn-muted btn-sm', onclick: async (e) => { try { await navigator.clipboard.writeText(s.cmd); e.currentTarget.textContent = 'Copied'; play('toggle'); } catch { play('error'); } } }, icon('copy'), 'Copy')))));
    }
    return h('div');
  }

  // ---------------- status bar + extra keys ----------------
  const clockEl = h('span', { class: 'sb-clock' });
  const savedEl = h('span', { class: 'sb-saved' });
  const chipKey = (k, label, fn) => h('button', { type: 'button', class: 'sb-key', onclick: () => { fn(); term.focus(); } }, h('b', null, k), ' ', label);
  const statusbar = h('footer', { class: 'statusbar mono' },
    h('span', { class: 'sb-session' }, '[cmdpro] 0:bash*'),
    chipKey('F1', 'help', () => meta('help')),
    chipKey('F2', 'recon', () => meta(recon ? 'exit' : 'recon')),
    hintsAllowed && chipKey('F3', 'hint', () => meta('hint')),
    chipKey('F4', 'files', () => meta('files')),
    chipKey('F11', 'focus', () => toggleFocus()),
    !practice && chipKey('^S', 'save', () => saveGame()),
    h('span', { class: 'sb-spacer' }),
    h('span', { class: 'sb-right' }, savedEl, `"${ch.slug}" `, clockEl));
  const ek = (label, fn, aria) => h('button', { type: 'button', 'aria-label': aria || label, onpointerdown: (e) => { e.preventDefault(); fn(); } }, label);
  const extraKeys = h('div', { class: 'extra-keys', role: 'toolbar', 'aria-label': 'Extra keys' },
    ek('Tab', () => term.sendKey('Tab')), ek('↑', () => term.sendKey('ArrowUp'), 'Up'), ek('↓', () => term.sendKey('ArrowDown'), 'Down'),
    ek('←', () => term.sendKey('ArrowLeft'), 'Left'), ek('→', () => term.sendKey('ArrowRight'), 'Right'),
    ek('^C', () => term.sendKey('c', { ctrl: true }), 'Control C'), ek('^R', () => term.sendKey('r', { ctrl: true }), 'Control R'),
    ...['|', '~', '-', '/', '*', '$', '>', '<', '&', ';', "'", '"', '{', '}', '(', ')', '[', ']', '\\', '!', '#', '='].map(c => ek(c, () => term.insertText(c))));

  const decorCanvas = ed ? h('canvas', { class: 'play-decor', 'aria-hidden': 'true' }) : null;
  const screen = h('div', { class: `screen play-screen diff-${difficulty}` + (comp ? ' has-companion' : '') + (ed ? ` edition-play edition-${ed.id}` : ''), style: ed ? { '--ea': ed.colors[0], '--eb': ed.colors[1] } : null },
    decorCanvas,
    hud,
    h('div', { class: 'play-main' }, termWindow, panel),
    extraKeys,
    statusbar);

  // ---------------- printing helpers ----------------
  const cols = () => Math.max(24, Math.min(64, term._cols ? term._cols() - 2 : 60));
  function motd() {
    term.echoCommand('cat ~/mission.txt');
    const bar = '━'.repeat(cols());
    term.printSegments([{ t: bar, c: 'term-banner' }]);
    const head = practice ? `FREE PLAY · ${tierLabel.toUpperCase()}` : training ? 'TRAINING RUN · NOTHING HERE COUNTS' : `CHALLENGE ${index + 1}/${total} · ${tierLabel.toUpperCase()}`;
    if (ed) term.printSegments([{ t: ' ' + `${ed.glyph} `.repeat(3), c: 'term-glyph' }, { t: head, c: 'term-dim' }]);
    else term.printSegments([{ t: ' ' + head, c: 'term-dim' }]);
    term.printSegments([{ t: ' ' + ch.title, c: 'term-title-line' }]);
    term.printSegments([{ t: bar, c: 'term-banner' }]);
    // stories may use inline markdown (`code`, **bold**) like the description
    if (ch.story) term.printSegments(termSegments(ch.story).map((sg, i) => ({ t: (i ? '' : ' ') + sg.t.replace(/\n/g, '\n '), c: sg.c ? `term-note ${sg.c}` : 'term-note' })));
    term.printSegments([{ t: '' }]);
    term.printSegments(termSegments(ch.description).map(s => ({ ...s, t: s.t.replace(/\n/g, '\n ') })).map((s, i) => (i === 0 ? { ...s, t: ' ' + s.t } : s)));
    term.printSegments([{ t: '' }]);
    const att = rules.attempts === Infinity ? '∞ attempts' : `${'♥'.repeat(cur.attemptsLeft)}${'♡'.repeat(Math.max(0, rules.attempts - cur.attemptsLeft))} ${cur.attemptsLeft} attempt${cur.attemptsLeft === 1 ? '' : 's'} left`;
    term.printSegments([{ t: ' ' + att, c: 'term-err' }, { t: `  ·  ${rules.name}${rules.timer ? ' · timer ' + fmtTime(ch.timeLimit) : ''}  ·  type `, c: 'term-dim' }, { t: 'help', c: 'term-code' }, { t: ' for game commands', c: 'term-dim' }]);
    if (index === 0 && !practice && kind === 'campaign') term.printSegments([{ t: ' Tip: every judged command runs in a fresh copy of this directory. Use ', c: 'term-dim' }, { t: 'recon', c: 'term-code' }, { t: ' to look around for free.', c: 'term-dim' }]);
    term.printSegments([{ t: '' }]);
  }

  function printResult(ok, text) {
    term.printSegments([{ t: (ok ? '✓ ' : '✗ ') + text, c: ok ? 'term-result-ok' : 'term-result-bad' }]);
  }

  // ---------------- HUD updates ----------------
  function updateHearts(breaking = -1) { heartsWrap.replaceChildren(hearts(cur.attemptsLeft, rules.attempts, { breaking })); }
  function tallyScore(from, to) {
    const t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 700); scoreEl.textContent = fmtNum(from + (to - from) * k); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
    scoreEl.classList.remove('bump'); void scoreEl.offsetWidth; scoreEl.classList.add('bump');
  }
  function tickTimer() {
    if (!rules.timer || !cur.deadline || ended) return;
    if (cur.solved) {
      timerEl.textContent = fmtTime(Math.max(0, (cur.deadline - (cur.solvedAt || Date.now())) / 1000));
      timerEl.parentElement.classList.remove('warn', 'crit');
      return;
    }
    const left = (cur.deadline - Date.now()) / 1000;
    timerEl.textContent = fmtTime(left);
    const box = timerEl.parentElement;
    box.classList.toggle('warn', left <= 30);
    box.classList.toggle('crit', left <= 10);
    if (left <= 30 && !warned30) { warned30 = true; play('warning'); toast({ title: '30 seconds left', body: 'Type fast. Type right.', iconName: 'hourglass', duration: 2500 }); }
    const s = Math.ceil(left);
    if (left <= 10 && s !== lastTick && s >= 0) { lastTick = s; play('tick'); }
    if (left <= 0) timeUp();
  }
  function tickClock() { const d = new Date(); clockEl.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  // ---------------- meta commands ----------------
  async function meta(line) {
    const handled = await runMeta(line);
    if (handled) { const [cmd, ...args] = line.trim().split(/\s+/); emit('meta', { cmd, args }); }
    return handled;
  }
  async function runMeta(line) {
    const [cmd, ...args] = line.trim().split(/\s+/);
    lastActivity = Date.now();
    switch (cmd) {
      case 'help':
        if (args.length) return false; // `help <builtin>` goes to bash
        term.print(HELP_LINES.join('\n'), 'term-dim');
        play('open');
        return true;
      case 'hint': {
        if (!hintsAllowed) { term.print(`No hints on ${rules.name}. ${comp ? say('cheer') : 'The narrator offers a supportive nod.'}`, 'term-warn'); play('error'); return true; }
        if (revealed >= hintsList.length) { term.print(hintsList.length ? 'No more hints. Time for `recon` and courage.' : 'This challenge has no hints. Trust your instincts.', 'term-warn'); play('bell'); return true; }
        const hint = hintsList[revealed];
        revealed++;
        if (!noRun) useHint(slot);
        else if (training) cur.hintsUsed++;
        if (practice) store.update(s => { s.stats.hints++; });
        if (comp) say('hint', { hint: hint });
        else bubble.replaceChildren(md(`Hint ${revealed}: ${hint}`, 'md'));
        term.printSegments([{ t: `» Hint ${revealed}/${hintsList.length}: `, c: 'term-warn' }, ...termSegments(hint)]);
        if (rules.hintCost && !practice) term.print(`(−${rules.hintCost} pts at the end of this challenge)`, 'term-dim');
        play('hint');
        refreshTabPips();
        if (activeTab === 'hints') showTab('hints');
        return true;
      }
      case 'recon': return startRecon();
      case 'files': openPanel('files'); play('open'); return true;
      case 'mission': openPanel('mission'); play('open'); return true;
      case 'learn': openPanel('learn'); play('open'); return true;
      case 'solutions':
        if (!cur.solved && !gaveUp) { term.print('Solve it first — no peeking!' + (practice ? ' (Free Play: `giveup` reveals them.)' : ''), 'term-warn'); play('error'); return true; }
        openPanel('solutions'); play('open'); return true;
      case 'focus': toggleFocus(); return true;
      case 'theme': {
        if (!args.length) {
          const now = store.state.settings.theme, w = Math.max(...THEMES.map(t => t.id.length));
          term.print(['Themes (* = current):', ...THEMES.map(t => `  ${t.id === now ? '*' : ' '} ${t.id.padEnd(w)}  ${t.name}`), 'Usage: theme <name>   (part of a name works too: theme drac)'].join('\n'), 'term-dim');
          return true;
        }
        const t = findTheme(args.join(' '));
        if (!t) { term.print(`theme: '${args.join(' ')}' not found. Type \`theme\` for the list.`, 'term-err'); play('error'); return true; }
        setSetting('theme', t.id);
        term.print(`Theme set to ${t.name}.`, 'term-ok');
        play('toggle');
        return true;
      }
      case 'save':
        if (!args.length) { saveGame(); return true; }
        if (/^(export|--export|-e|download|file)$/i.test(args[0]) && args.length === 1) { if (!practice) saveGame(); exportSave(); return true; }
        term.print('Usage: save          save your game now (also Ctrl+S)\n       save export   …and download a save file for another device', 'term-dim');
        return true;
      case 'sound': {
        const on = args[0] ? !/^(off|0|no|false|mute)$/i.test(args[0]) : !store.state.settings.sound.master;
        setSetting('sound.master', on);
        soundBtn.replaceChildren(icon(on ? 'volume-2' : 'volume-x'));
        term.print(`Sound ${on ? 'on' : 'off'}.`, 'term-dim');
        if (on) { play('toggle'); music(musicFor()); }
        return true;
      }
      case 'menu': leave(); return true;
      case 'clear': term.clear(); return true;
      case 'next':
        if (cur.solved || gaveUp) { nextChallenge(); return true; }
        term.print('Solve this one first. (Or type `menu` to leave.)', 'term-warn'); play('error');
        return true;
      case 'giveup':
        if (!noRun) { term.print('No giving up in a run! Free Play has a give-up button.', 'term-warn'); play('error'); return true; }
        gaveUp = true;
        if (practice) store.update(s => { (s.freeplay.given ||= {})[ch.id] = true; });
        term.print('Fair enough. Here is how others solved it → Solutions panel. Press Enter (empty) for the next challenge.', 'term-warn');
        openPanel('solutions');
        return true;
      case 'exit': case 'logout': case 'quit':
        if (recon) { stopRecon(); return true; }
        term.print('There is no exit. Only `menu`. (This is fine.)', 'term-warn');
        return true;
      default: return false;
    }
  }

  // ---------------- recon ----------------
  async function startRecon() {
    if (recon) { term.print('Already in recon. `exit` to leave.', 'term-dim'); return true; }
    if (rules.recon !== Infinity && (cur.reconUsed || 0) >= rules.recon) { term.print(`Recon budget spent (${rules.recon}/${rules.recon}). Extremely Hard means flying blind now.`, 'term-warn'); play('error'); return true; }
    let res;
    try { res = await engine().reconStart(ch.id); } catch (e) { term.print('cmdpro: recon failed to start: ' + e.message, 'term-err'); return true; }
    recon = true;
    reconCwd = (res && res.cwd) || dirName;
    screen.classList.add('in-recon');
    emit('recon-start');
    term.printSegments([{ t: '» recon sandbox: a fresh, private copy of the challenge directory. Nothing here is judged.', c: 'term-warn' }]);
    term.printSegments([{ t: '  Type ', c: 'term-dim' }, { t: 'exit', c: 'term-code' }, { t: ' (or Ctrl+D / F2) to go back to the judged prompt.' + (rules.recon !== Infinity ? `  Budget: ${rules.recon - (cur.reconUsed || 0)} command(s).` : ''), c: 'term-dim' }]);
    play('open');
    term.render();
    return true;
  }
  async function stopRecon(silent) {
    if (!recon) return;
    recon = false;
    screen.classList.remove('in-recon');
    emit('recon-stop');
    try { await engine().reconStop(); } catch {}
    if (!silent) { term.print('logout — back to the judged prompt. Every command here counts.', 'term-dim'); play('close'); }
    term.render();
  }

  // ---------------- submit ----------------
  async function submit(text) {
    lastActivity = Date.now();
    const trimmed = text.trim();
    if (ended) return;
    if (!trimmed) {
      if ((cur.solved || gaveUp) && !recon) nextChallenge();
      return;
    }
    const first = trimmed.split(/\s+/)[0];
    if (!/[|;&<>$`(){}\n]/.test(trimmed) && META.has(first)) {
      const handled = await meta(trimmed);
      if (handled) return;
    }
    if (recon) return reconCommand(text);
    if (!cur.solved && !gaveUp && /^(man|help)\s+[\w.-]+$|^[\w.-]+\s+--help$/.test(trimmed)) {
      // Reading the manual is never punished.
      let res;
      try { res = await engine().judge(ch.id, text); } catch (e) { term.print('cmdpro: engine error: ' + (e && e.message || e), 'term-err'); return; }
      if (res.output) term.print(res.output);
      term.print('(reference lookups are free — no attempt used)', 'term-dim');
      return;
    }
    lastCmd = trimmed;
    play('enter');
    if (rules.timer && cur.deadline && Date.now() > cur.deadline && !cur.solved) { timeUp(); return; }
    let res;
    try { res = await engine().judge(ch.id, text); }
    catch (e) { term.print('cmdpro: engine error (not counted): ' + (e && e.message || e), 'term-err'); return; }
    if (ended) return;
    if (res.output) term.print(res.output);
    if (res.timedOut) term.print('(the command was killed — that counts as an answer, sorry)', 'term-dim');
    if (cur.solved || gaveUp) {
      if (res.correct) printResult(true, 'That works too! (Already solved — no extra points, infinite respect.)');
      else printResult(false, 'That one does not pass — but you already solved it, so no harm done.');
      term.printSegments([{ t: 'Press Enter on an empty line (or type ', c: 'term-dim' }, { t: 'next', c: 'term-code' }, { t: ') to continue.', c: 'term-dim' }]);
      emit('judged', { cmd: trimmed, correct: !!res.correct, already: true });
      return;
    }
    if (res.correct) onCorrect(text);
    else onWrong(res);
    emit('judged', { cmd: trimmed, correct: !!res.correct });
  }

  async function reconCommand(text) {
    if (rules.recon !== Infinity) {
      const used = useRecon(slot);
      if (used > rules.recon) { term.print('Recon budget spent. Leaving the sandbox.', 'term-warn'); await stopRecon(true); return; }
    }
    let res;
    try { res = await engine().reconExec(text); } catch (e) { term.print('cmdpro: recon error: ' + e.message, 'term-err'); return; }
    if (res.output) term.print(res.output);
    if (res.cwd) reconCwd = res.cwd;
    emit('recon-cmd', { cmd: text.trim() });
    if (res.reconLost) { recon = false; screen.classList.remove('in-recon'); }
    if (rules.recon !== Infinity && recon) {
      const left = rules.recon - (cur.reconUsed || 0);
      if (left <= 0) { term.print('That was your last recon command. Back to the judged prompt.', 'term-warn'); await stopRecon(true); }
      else term.print(`(${left} recon command${left === 1 ? '' : 's'} left)`, 'term-dim');
    }
  }

  function onCorrect(cmd) {
    play('success');
    confetti();
    printResult(true, pick(CORRECT_LINES));
    if (practice) {
      cur.solved = true; cur.solvedCmd = cmd;
      store.update(s => { s.freeplay.solved[ch.id] = { date: new Date().toISOString(), cmd }; s.stats.solved++; s.stats.commands++; });
    } else if (training) {
      cur.solved = true; cur.solvedCmd = cmd; cur.solvedAt = Date.now();
      const pts = points({ tier: 1, attemptsLeft: cur.attemptsLeft - 1, hintsUsed: cur.hintsUsed, difficulty: 'easy' });
      term.printSegments([{ t: `+${fmtNum(pts)} pts`, c: 'term-ok' }, { t: '  (training points: they show how scoring works, then vanish)', c: 'term-dim' }]);
      tallyScore(0, pts);
      setTimeout(() => play('coin'), 350);
    } else {
      const before = slot.score;
      solvedResult = solve(slot, cmd);
      cur = slot.current;
      term.printSegments([{ t: `+${fmtNum(solvedResult.points)} pts`, c: 'term-ok' }, { t: `  (${cur.hintsUsed ? `${cur.hintsUsed} hint${cur.hintsUsed > 1 ? 's' : ''}, ` : ''}${Math.max(0, cur.attemptsLeft - 1)} spare heart${cur.attemptsLeft - 1 === 1 ? '' : 's'}${rules.timer ? ', ' + Math.max(0, Math.floor((cur.deadline - cur.solvedAt) / 1000)) + 's left on the clock' : ''})`, c: 'term-dim' }]);
      tallyScore(before, slot.score);
      setTimeout(() => play('coin'), 350);
      if (solvedResult.certs.length) term.printSegments([{ t: `★ Certificate unlocked: ${solvedResult.certs.join(', ')}! `, c: 'term-warn' }]);
    }
    say('correct');
    term.printSegments([{ t: 'Press Enter on an empty line (or type ', c: 'term-dim' }, { t: 'next', c: 'term-code' }, { t: ') to continue. Peek at other solutions → ', c: 'term-dim' }, { t: 'solutions', c: 'term-code' }]);
    refreshTabPips();
    showTab('solutions');
    screen.classList.add('solved');
  }

  function feedbackText(res) {
    const fb = res.feedback;
    if (rules.feedback === 'none') return null;
    // line counts only describe a plain output mismatch; randomized-data and file checks explain themselves
    if (res.reason !== 'Output does not match expected lines' || !fb || typeof fb.expectedLines !== 'number') return res.reason || null;
    const parts = [];
    const n = fb.expectedLines, plural = (k) => `${k} line${k === 1 ? '' : 's'}`;
    if (n !== fb.gotLines) parts.push(`Expected ${plural(n)}, got ${fb.gotLines}.`);
    else parts.push(`Right number of lines (${n}), wrong content.`);
    if (rules.feedback === 'detailed' && fb.firstMismatch) parts.push(`First difference at line ${fb.firstMismatch.line}: expected “${fb.firstMismatch.expected ?? '(nothing)'}”, got “${fb.firstMismatch.got ?? '(nothing)'}”.`);
    return parts.join(' ');
  }

  function onWrong(res) {
    play('fail');
    term.el.classList.remove('shake'); void term.el.offsetWidth; term.el.classList.add('shake');
    if (practice) {
      printResult(false, pick(WRONG_LINES));
      const fb = feedbackText(res);
      if (fb) term.print(fb, 'term-dim');
      store.update(s => { s.stats.wrong++; s.stats.commands++; });
      say('wrong');
      return;
    }
    if (training) {
      cur.attemptsLeft = Math.max(0, cur.attemptsLeft - 1);
      updateHearts(cur.attemptsLeft);
      const fb = feedbackText(res);
      printResult(false, `${pick(WRONG_LINES)} ${cur.attemptsLeft} attempt${cur.attemptsLeft === 1 ? '' : 's'} left.`);
      if (fb) term.print(fb, 'term-dim');
      if (!cur.attemptsLeft) {
        term.print('(Out of hearts. In a real run that is GAME OVER: back to challenge #1, certificates kept. Training hearts refill.)', 'term-warn');
        cur.attemptsLeft = rules.attempts;
        setTimeout(() => updateHearts(), 900);
      }
      say('wrong');
      return;
    }
    const { attemptsLeft, gameOver: dead } = wrongAttempt(slot);
    cur = slot.current;
    updateHearts(attemptsLeft);
    const fb = feedbackText(res);
    printResult(false, `${pick(WRONG_LINES)} ${dead ? '' : `${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.`}`);
    if (fb && !dead) term.print(fb, 'term-dim');
    if (dead) { say('gameover'); die('lives'); }
    else say('wrong');
  }

  function timeUp() {
    if (ended || cur.solved) return;
    term.print('[time] ' + pick(TIMEOUT_LINES), 'term-err');
    play('fail');
    die('timer');
  }

  function die(reason) {
    if (ended) return;
    ended = true;
    keepOnExit = false;
    term.setEnabled(false);
    clearInterval(timerInt);
    stopRecon(true);
    const summary = gameOver(slot, reason);
    summary.companion = compId;
    summary.challengeTitle = ch.title;
    session.set('gameover', JSON.stringify(summary));
    setTimeout(() => go('gameover'), 1500);
  }

  // ---------------- saving ----------------
  // Progress (position, hearts, hints, score) is written on every judged command. Saving also
  // keeps this terminal (scrollback + history), so Continue picks up exactly here. That happens
  // on its own when the player leaves, reloads or closes the tab; save / Ctrl+S does it on demand.
  let keepOnExit = !noRun; // false once the run moves on (next challenge, game over)
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const savedWhen = (t) => (new Date(t).toDateString() === new Date().toDateString() ? hhmm(t) : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }));
  function showSaved() { if (!noRun && slot.updated) savedEl.textContent = `✓ saved ${savedWhen(slot.updated)}  `; }
  function keepTerminal() {
    if (!keepOnExit) return true;
    return saveTerminal(slot, { blocks: term.snapshot(), history: history.lines.slice(-200) });
  }
  function saveGame() {
    if (practice) { term.print('Free Play has no run to save: solved challenges are recorded as you go. (`save export` downloads your save file.)', 'term-dim'); return; }
    if (training) {
      term.printSegments([{ t: '» Game saved', c: 'term-ok' }, { t: ' · training runs are never stored, but in a real run this keeps your place, hearts, hints and this terminal', c: 'term-dim' }]);
      play('unlock');
      toast({ title: 'Game saved', body: 'In a real run, Continue picks up right here.', iconName: 'save', duration: 2600 });
      emit('save');
      return;
    }
    if (!keepOnExit) return;
    saveSlot(slot);
    const where = `${index + 1}/${total} · ${fmtNum(slot.score)} pts`;
    term.printSegments([{ t: '» Game saved', c: 'term-ok' }, { t: ` · ${tierLabel} · challenge ${where} · ${hhmm(slot.updated)}`, c: 'term-dim' }]);
    const kept = keepTerminal();
    if (!kept) term.print('(This browser would not store the terminal itself, but your progress is saved.)', 'term-dim');
    showSaved();
    play('unlock');
    toast({ title: 'Game saved', body: `Challenge ${where}. Continue picks up right here${rules.timer ? ' (the clock keeps running)' : ''}.`, iconName: 'save', duration: 2600 });
    emit('save');
  }
  function exportSave() {
    downloadBlob(new Blob([store.exportJSON()], { type: 'application/json' }), `cmdpro-save-${new Date().toISOString().slice(0, 10)}.json`);
    term.print('Save file downloaded. Settings → Import save loads it on any device.', 'term-dim');
  }
  const onSaveKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (!e.repeat) saveGame(); }
  };
  const onHide = () => { if (document.visibilityState === 'hidden') keepTerminal(); };

  // ---------------- navigation ----------------
  function nextChallenge() {
    if (ended) return;
    ended = true;
    keepOnExit = false;
    play('whoosh');
    if (training) { if (emit('next')) go('tutorial'); return; }
    if (practice) {
      const order = ch.pack === 'oops' || ch.pack === '12days' || EDITION_BY_ID[ch.pack] ? listFor(ch.pack) : listFor('campaign');
      const nx = order[order.indexOf(ch.id) + 1];
      go(nx ? `practice/${nx}` : 'freeplay');
      return;
    }
    const certs = solvedResult?.certs || [];
    advance(slot);
    let then;
    if (kind === 'campaign') then = solvedResult?.runComplete ? `map/${difficulty}` : continueTarget(slot) || `map/${difficulty}`;
    else if (kind === 'bonus') then = solvedResult?.runComplete ? 'wall' : `play/bonus/${difficulty}`;
    else if (ed) then = solvedResult?.runComplete ? `editions/${kind}` : `play/${kind}/${difficulty}`;
    else then = solvedResult?.runComplete ? 'sidequests' : `play/${kind}/${difficulty}`;
    if (certs.length) go(`ceremony/${certs[0]}?then=${encodeURIComponent(then)}${certs.length > 1 ? '&queue=' + certs.slice(1).join(',') : ''}`);
    else go(then);
  }

  async function leave() {
    if (!noRun && !cur.solved && !ended) {
      const ok = await confirmModal({ title: 'Back to the menu?', message: rules.timer ? 'Your game is saved (hearts, hints and this terminal), but the clock keeps ticking while you are away.' : 'Your game is saved: hearts, hints and this terminal. Continue picks up right here.', ok: 'Save & leave', cancel: 'Stay' });
      if (!ok) { term.focus(); return; }
    }
    play('back');
    ended = true;
    go(practice ? 'freeplay' : training ? 'tutorial' : kind === 'campaign' ? `map/${difficulty}` : kind === 'bonus' ? 'difficulty/bonus' : ed ? `editions/${kind}` : 'sidequests');
  }

  function toggleSound() {
    const on = !store.state.settings.sound.master;
    setSetting('sound.master', on);
    soundBtn.replaceChildren(icon(on ? 'volume-2' : 'volume-x'));
    if (on) { play('toggle'); music(musicFor()); }
    term.focus();
  }

  function toggleFocus() {
    const fsEl = document.fullscreenElement;
    if (!fsEl && !screen.classList.contains('focus-mode')) {
      screen.classList.add('focus-mode');
      document.documentElement.requestFullscreen?.().catch(() => {});
      play('open');
    } else {
      screen.classList.remove('focus-mode');
      if (fsEl) document.exitFullscreen?.().catch(() => {});
      play('close');
    }
    setTimeout(() => { term.scrollToBottom(); term.focus(); }, 60);
  }
  const onFsChange = () => { if (!document.fullscreenElement) screen.classList.remove('focus-mode'); };

  function musicFor() {
    if (ed) return ed.music || 'gameplay';
    return kind === 'bonus' || info.tier === 'bonus' ? 'bonus' : (typeof info.tier === 'number' && info.tier % 2 === 0 ? 'gameplay-2' : 'gameplay');
  }
  let stopDecor = null;
  let unsubSaved = null;

  // Everything is kept on the way out, so only warn when the browser will not store anything.
  const onBeforeUnload = (e) => { if (!noRun && !store.storageOk && !cur.solved && !ended) { e.preventDefault(); e.returnValue = ''; } };

  // ---------------- mount ----------------
  return {
    el: screen,
    mounted() {
      music(musicFor());
      if (decorCanvas) stopDecor = decor(decorCanvas, ed.decor, { density: 0.35, alpha: 0.35, palette: ed.decor === 'bats' ? ['#B48EF5', '#8E5CD9'] : null });
      showTab('mission');
      refreshTabPips();
      const saved = noRun ? null : savedTerminal(slot);
      if (saved && Array.isArray(saved.blocks) && saved.blocks.length) {
        term.restore(saved.blocks);
        if (!history.lines.length && Array.isArray(saved.history)) history.lines.push(...saved.history.filter(x => typeof x === 'string'));
        term.printSegments([{ t: `── restored from your save · ${new Date(saved.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} ──`, c: 'term-dim' }], 'term-transient');
      } else motd();
      showSaved();
      if (comp) {
        if (comp.id !== prevCompId && !practice) {
          play('companion');
          toast({ title: `A wild ${comp.name} appeared!`, body: `${comp.name} the ${comp.species} joins your party. ${comp.tagline}`, img: companionUrl(comp.id), duration: 4500 });
          say('join');
        } else say(practice ? 'join' : 'idle');
      } else {
        bubble.replaceChildren(md(index < 3 && !practice ? `Companions join from challenge #4. Until then it is just you, me and a blinking cursor. Type \`help\` if you get stuck.` : 'Type `help` for game commands.', 'md'));
      }
      // Resume protection: Extreme timer may have expired while away.
      if (rules.timer && cur.deadline && Date.now() > cur.deadline && !cur.solved) { setTimeout(timeUp, 400); }
      if (rules.timer) { tickTimer(); timerInt = setInterval(tickTimer, 250); }
      tickClock();
      clockInt = setInterval(tickClock, 15000);
      idleInt = setInterval(() => {
        if (comp && !ended && Date.now() - lastActivity > 30000) { say('idle'); lastActivity = Date.now(); }
      }, 5000);
      document.addEventListener('fullscreenchange', onFsChange);
      window.addEventListener('beforeunload', onBeforeUnload);
      window.addEventListener('keydown', onSaveKey);
      window.addEventListener('pagehide', keepTerminal);
      document.addEventListener('visibilitychange', onHide);
      unsubSaved = noRun ? null : store.subscribe(showSaved);
      setTimeout(() => { term.scrollToBottom(); term.focus(); }, 30);
      if (cur.solved) { screen.classList.add('solved'); term.print('Already solved — press Enter on an empty line for the next challenge.', 'term-dim term-transient'); }
    },
    destroy() {
      if (!noRun) keepTerminal();
      ended = true;
      unsubSaved && unsubSaved();
      window.removeEventListener('keydown', onSaveKey);
      window.removeEventListener('pagehide', keepTerminal);
      document.removeEventListener('visibilitychange', onHide);
      stopDecor && stopDecor();
      clearInterval(timerInt); clearInterval(idleInt); clearInterval(clockInt);
      document.removeEventListener('fullscreenchange', onFsChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      if (recon) engine().reconStop().catch(() => {});
      term.destroy();
    },
  };
}
