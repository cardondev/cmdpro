// Difficulty rules + scoring (SPEC §2).

export const DIFFICULTIES = {
  easy: {
    id: 'easy', name: 'Easy', attempts: 5, hints: true, hintCost: 0, timer: false, paste: true,
    recon: Infinity, feedback: 'detailed', learnBefore: true, multiplier: 1, color: 'var(--blue)',
  },
  normal: {
    id: 'normal', name: 'Normal', attempts: 3, hints: true, hintCost: 20, timer: false, paste: true,
    recon: Infinity, feedback: 'counts', learnBefore: false, multiplier: 1.5, color: 'var(--green)',
  },
  hard: {
    id: 'hard', name: 'Hard', attempts: 2, hints: false, hintCost: 0, timer: false, paste: true,
    recon: Infinity, feedback: 'none', learnBefore: false, multiplier: 2, color: 'var(--peach)',
  },
  extreme: {
    id: 'extreme', name: 'Extremely Hard', attempts: 1, hints: false, hintCost: 0, timer: true, paste: false,
    recon: 3, feedback: 'none', learnBefore: false, multiplier: 3, color: 'var(--red)',
  },
};

/** Free Play: practice rules, nothing at stake. */
export const PRACTICE = {
  id: 'practice', name: 'Practice', attempts: Infinity, hints: true, hintCost: 0, timer: false, paste: true,
  recon: Infinity, feedback: 'detailed', learnBefore: true, multiplier: 0, color: 'var(--mauve)', practice: true,
};

/** The tutorial's training round: real hearts and score on screen, nothing saved, hearts refill. */
export const TRAINING = {
  id: 'training', name: 'Training', attempts: 3, hints: true, hintCost: 0, timer: false, paste: true,
  recon: Infinity, feedback: 'detailed', learnBefore: true, multiplier: 1, color: 'var(--teal)', training: true,
};

export const DIFFICULTY_ORDER = ['easy', 'normal', 'hard', 'extreme'];
export const difficultyRank = (d) => DIFFICULTY_ORDER.indexOf(d);

/** Score for one solved challenge. */
export function points({ tier, attemptsLeft, hintsUsed, secondsLeft = 0, difficulty }) {
  const rules = DIFFICULTIES[difficulty];
  if (!rules) return 0;
  const t = tier === 'bonus' ? 10 : (typeof tier === 'number' ? tier : 1);
  let p = 100 * t + 25 * Math.max(0, attemptsLeft | 0) - 20 * Math.max(0, hintsUsed | 0);
  if (rules.timer) p += Math.max(0, Math.floor(secondsLeft));
  return Math.max(0, Math.round(p * rules.multiplier));
}
