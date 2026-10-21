// Run controller: campaign / bonus / side-quest / holiday-edition progress, lives, scoring,
// companions and certificate awards. Pure state transitions + persistence.
import { store, terminals } from './state.js';
import { DIFFICULTIES, points, difficultyRank } from './rules.js';
import { CHALLENGES } from '../data/challenges.gen.js';
import { TIERS, BONUS, SIDE_QUESTS, CAMPAIGN } from '../data/campaign.js';
import { EDITIONS, EDITION_BY_ID } from '../data/editions.js';
import { REGULAR_COMPANIONS } from '../data/companions.js';
import { rng, shuffle } from '../ui/dom.js';

export const CH_BY_ID = Object.fromEntries(CHALLENGES.map(c => [c.id, c]));

export const RUN_KINDS = {
  campaign: { id: 'campaign', name: 'Campaign', list: () => CAMPAIGN },
  bonus: { id: 'bonus', name: 'Bonus Round', list: () => BONUS.challenges },
  oops: { id: 'oops', name: SIDE_QUESTS[0].name, list: () => SIDE_QUESTS[0].challenges },
  '12days': { id: '12days', name: SIDE_QUESTS[1].name, list: () => SIDE_QUESTS[1].challenges },
  ...Object.fromEntries(EDITIONS.map(e => [e.id, { id: e.id, name: e.name, edition: true, list: () => e.challenges }])),
};

export function listFor(kind) { return (RUN_KINDS[kind]?.list() || []).filter(id => CH_BY_ID[id]); }

/** Which "tier" a challenge belongs to inside a run (for scoring, HUD and briefings). */
export function tierInfo(id) {
  for (const t of TIERS) {
    const i = t.challenges.indexOf(id);
    if (i >= 0) return { tier: t.id, meta: t, pos: i, size: t.challenges.length, last: i === t.challenges.length - 1 };
  }
  const bi = BONUS.challenges.indexOf(id);
  if (bi >= 0) return { tier: 'bonus', meta: BONUS, pos: bi, size: BONUS.challenges.length, last: bi === BONUS.challenges.length - 1 };
  for (const s of SIDE_QUESTS) {
    const i = s.challenges.indexOf(id);
    if (i >= 0) return { tier: 1, side: s.id, meta: s, pos: i, size: s.challenges.length, last: i === s.challenges.length - 1 };
  }
  for (const e of EDITIONS) {
    const i = e.challenges.indexOf(id);
    // editions score each challenge by the campaign tier it would belong to
    if (i >= 0) return { tier: CH_BY_ID[id]?.difficulty || 1, edition: e.id, meta: e, pos: i, size: e.challenges.length, last: i === e.challenges.length - 1 };
  }
  return { tier: 1, meta: null, pos: 0, size: 1, last: false };
}

function newSeed() { return (Math.random() * 2 ** 31) >>> 0; }

function freshSlot(kind, difficulty) {
  return {
    kind, difficulty, seed: newSeed(), index: 0, score: 0,
    started: Date.now(), updated: Date.now(), deaths: 0,
    attemptsTotal: 0, hintsTotal: 0, solvedCount: 0, bestIndex: 0,
    current: null, briefed: {}, completed: false, log: [],
  };
}

export function getSlot(kind, difficulty) {
  const slots = store.state.slots[kind] || {};
  const slot = slots[difficulty] || null;
  if (slot) reconcile(slot);
  return slot;
}

/** If the challenge list changed (new challenges shipped), keep the player on the same challenge. */
function reconcile(slot) {
  const list = listFor(slot.kind);
  if (slot.current && list[slot.index] !== slot.current.id) {
    const i = list.indexOf(slot.current.id);
    if (i >= 0) slot.index = i;
    else slot.current = null;
  }
  if (slot.index > list.length) slot.index = list.length;
}

/** A blank run that is never saved: lets the tutorial show the map without creating a save. */
export function previewSlot(kind, difficulty) { return freshSlot(kind, difficulty); }

export function newRun(kind, difficulty) {
  const deaths = getSlot(kind, difficulty)?.deaths || 0;
  const slot = freshSlot(kind, difficulty);
  slot.deaths = deaths;
  store.update(s => { (s.slots[kind] ||= {})[difficulty] = slot; }, { immediate: true });
  return slot;
}

export function saveSlot(slot) {
  slot.updated = Date.now();
  store.update(s => { (s.slots[slot.kind] ||= {})[slot.difficulty] = slot; }, { immediate: true });
}

/** The terminal saved with this run, while the player is still on the challenge it was saved on. */
export function savedTerminal(slot) {
  const t = terminals.get(`${slot.kind}/${slot.difficulty}`);
  return t && t.run === slot.started && slot.current && t.id === slot.current.id ? t : null;
}

/** Keep the terminal ({ blocks, history }) with the run; it is dropped once the run moves on. */
export function saveTerminal(slot, data) {
  if (!slot.current) return false;
  return terminals.set(`${slot.kind}/${slot.difficulty}`, { ...data, id: slot.current.id, run: slot.started, at: Date.now() });
}

export function currentId(slot) { return listFor(slot.kind)[slot.index] || null; }
export function runLength(slot) { return listFor(slot.kind).length; }

/** Initialise per-challenge state (lives, timer) the first time a challenge is shown. */
export function beginChallenge(slot) {
  const id = currentId(slot);
  if (!id) return null;
  if (!slot.current || slot.current.id !== id) {
    const rules = DIFFICULTIES[slot.difficulty];
    const ch = CH_BY_ID[id];
    slot.current = {
      id, attemptsLeft: rules.attempts, hintsUsed: 0, reconUsed: 0, solved: false,
      startedAt: Date.now(),
      deadline: rules.timer ? Date.now() + (ch?.timeLimit || 180) * 1000 : null,
    };
    saveSlot(slot);
  }
  return slot.current;
}

/** Record a wrong judged attempt. Returns { attemptsLeft, gameOver }. */
export function wrongAttempt(slot) {
  const cur = slot.current;
  cur.attemptsLeft = Math.max(0, cur.attemptsLeft - 1);
  slot.attemptsTotal++;
  store.update(s => { s.stats.wrong++; s.stats.commands++; });
  saveSlot(slot);
  return { attemptsLeft: cur.attemptsLeft, gameOver: cur.attemptsLeft <= 0 };
}

export function useHint(slot) {
  slot.current.hintsUsed++;
  slot.hintsTotal++;
  store.update(s => { s.stats.hints++; });
  saveSlot(slot);
}

export function useRecon(slot) {
  slot.current.reconUsed = (slot.current.reconUsed || 0) + 1;
  saveSlot(slot);
  return slot.current.reconUsed;
}

/**
 * Mark the current challenge solved. Returns { points, certs: [certIds], tierComplete, runComplete }.
 * Does NOT advance the index — call advance() when the player moves on.
 */
export function solve(slot, cmd) {
  const cur = slot.current;
  const id = cur.id;
  const info = tierInfo(id);
  const secondsLeft = cur.deadline ? Math.max(0, (cur.deadline - Date.now()) / 1000) : 0;
  const pts = points({ tier: info.tier, attemptsLeft: cur.attemptsLeft - 1, hintsUsed: cur.hintsUsed, secondsLeft, difficulty: slot.difficulty });
  cur.solved = true;
  cur.solvedCmd = cmd;
  cur.points = pts;
  cur.solvedAt = Date.now();
  slot.score += pts;
  slot.solvedCount++;
  slot.log.push({ id, attempts: DIFFICULTIES[slot.difficulty].attempts - cur.attemptsLeft + 1, ms: cur.solvedAt - cur.startedAt, pts });
  if (slot.log.length > 200) slot.log.shift();
  const list = listFor(slot.kind);
  const isLast = slot.index >= list.length - 1;
  slot.bestIndex = Math.max(slot.bestIndex, slot.index + 1);
  store.update(s => { s.stats.solved++; s.stats.commands++; });

  const certs = [];
  if (slot.kind === 'campaign') {
    if (info.last && info.tier !== 'bonus') certs.push(TIERS[info.tier - 1].cert);
    if (info.last && info.tier === 'bonus') certs.push('ai');
    if (isLast && slot.difficulty === 'extreme') certs.push('warrior');
  } else if (slot.kind === 'bonus' && isLast) certs.push('ai');
  else if (slot.kind === 'oops' && isLast) certs.push('oops');
  else if (slot.kind === '12days' && isLast) certs.push('elf');
  else if (EDITION_BY_ID[slot.kind] && isLast) certs.push(EDITION_BY_ID[slot.kind].cert);

  for (const c of certs) awardCert(c, slot);
  if (isLast) { slot.completed = true; recordHighscore(slot, true); }
  saveSlot(slot);
  return { points: pts, certs, tierComplete: info.last, runComplete: isLast, tier: info.tier };
}

export function advance(slot) {
  slot.index++;
  slot.current = null;
  saveSlot(slot);
}

/** Out of lives (or time). Resets the slot to challenge #1 per the rules. */
export function gameOver(slot, reason = 'lives') {
  const summary = {
    reason, reached: slot.index + 1, total: runLength(slot), score: slot.score,
    solved: slot.solvedCount, difficulty: slot.difficulty, kind: slot.kind,
    challengeId: slot.current?.id, deaths: slot.deaths + 1,
  };
  recordHighscore(slot, false);
  store.update(s => { s.stats.gameOvers++; });
  const fresh = freshSlot(slot.kind, slot.difficulty);
  fresh.deaths = slot.deaths + 1;
  fresh.bestIndex = Math.max(slot.bestIndex, slot.index);
  store.update(s => { (s.slots[slot.kind] ||= {})[slot.difficulty] = fresh; }, { immediate: true });
  return summary;
}

function recordHighscore(slot, finished) {
  if (slot.score <= 0) return;
  store.update(s => {
    const arr = (s.highscores[slot.difficulty] ||= []);
    arr.push({ score: slot.score, handle: s.profile.handle || 'player', date: new Date().toISOString(), reached: slot.index + 1, total: runLength(slot), kind: slot.kind, finished });
    arr.sort((a, b) => b.score - a.score);
    arr.length = Math.min(arr.length, 10);
  });
}

function randomSerial() {
  const b = new Uint8Array(16);
  (globalThis.crypto || {}).getRandomValues ? crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.random() * 256; });
  b[0] &= 0x7f;
  return [...b].map(x => x.toString(16).padStart(2, '0')).join(':').toUpperCase();
}

/** Issue (or upgrade) a certificate. */
export function awardCert(certId, slot) {
  store.update(s => {
    const prev = s.certs[certId];
    const entry = {
      difficulty: slot.difficulty, score: slot.score, date: new Date().toISOString(),
      serial: prev?.serial || randomSerial(), firstEarned: prev?.firstEarned || new Date().toISOString(),
      kind: slot.kind, times: (prev?.times || 0) + 1,
    };
    if (!prev || difficultyRank(slot.difficulty) > difficultyRank(prev.difficulty) ||
        (slot.difficulty === prev.difficulty && slot.score > (prev.score || 0))) {
      s.certs[certId] = entry;
    } else {
      s.certs[certId] = { ...prev, times: entry.times };
    }
  }, { immediate: true });
}

/**
 * Companion for a run position: none for the first 3 challenges, then rotate every 2.
 * Special editions: their host keeps you company from the start, then the edition's own
 * characters take turns.
 */
export function companionFor(slotOrSeed, index, kind = typeof slotOrSeed === 'object' ? slotOrSeed?.kind : null) {
  const seed = typeof slotOrSeed === 'number' ? slotOrSeed : slotOrSeed.seed;
  const ed = EDITION_BY_ID[kind];
  if (ed) {
    if (index < 0) return null;
    if (index < 3) return ed.host;
    const order = shuffle(ed.companions.filter(id => id !== ed.host), rng(seed));
    return order[Math.floor((index - 3) / 2) % order.length];
  }
  if (index < 3) return null;
  const order = shuffle(REGULAR_COMPANIONS.map(c => c.id), rng(seed));
  return order[Math.floor((index - 3) / 2) % order.length];
}

export function secondsLeft(slot) {
  const d = slot?.current?.deadline;
  return d ? (d - Date.now()) / 1000 : Infinity;
}
