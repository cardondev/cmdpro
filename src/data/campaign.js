// Campaign structure: tiers, bonus round and side quests (holiday editions: editions.js).
// Challenge ordering comes from the generated bundle (tools/build-challenges.mjs).
import { ORDER } from './campaign.gen.js';
import { EDITIONS } from './editions.js';

const TIER_META = [
  { id: 1, key: 'foundations', name: 'Foundations', rank: 'Newbie', cert: 'foundations', blurb: 'Files, folders and your first words to the machine.' },
  { id: 2, key: 'engineer', name: 'Engineer', rank: 'Nerd', cert: 'engineer', blurb: 'Search, count, sort and delete like you mean it.' },
  { id: 3, key: 'sr-engineer', name: 'Sr. Engineer', rank: 'Geek', cert: 'sr-engineer', blurb: 'Pipes, filters and text that bends to your will.' },
  { id: 4, key: 'architect', name: 'Architect', rank: 'Ninja', cert: 'architect', blurb: 'Loops, renames, find and the art of not breaking things.' },
  { id: 5, key: 'principal', name: 'Principal', rank: 'Sensei', cert: 'principal', blurb: 'awk, sed and data wrangling with style.' },
  { id: 6, key: 'expert', name: 'Expert', rank: 'Wizard', cert: 'expert', blurb: 'Regex sorcery, checksums and log forensics.' },
  { id: 7, key: 'guru', name: 'Guru', rank: 'Show-off', cert: 'guru', blurb: 'One-liners that make senior engineers nervous.' },
];

export const TIERS = TIER_META.map((t, i) => ({ ...t, challenges: ORDER.tiers[i] || [] }));

export const BONUS = {
  id: 'bonus', key: 'ai', name: 'Machine', rank: 'Machine', cert: 'ai',
  blurb: 'Five problems for people who are (or think they are) beyond expert.',
  challenges: ORDER.bonus,
};

// (ids are save-file keys: 'oops' and '12days' keep their names after the side quests were re-themed)
export const SIDE_QUESTS = [
  { id: 'oops', name: 'Gremlins Ate /bin', short: 'Gremlins', icon: 'fire', rank: 'Survivor', cert: 'oops', blurb: 'A gremlin is nibbling through /bin. Only bash builtins survive.', challenges: ORDER.oops },
  { id: '12days', name: 'The Twelve Labors', short: 'Labors', icon: 'trophy', rank: 'Demigod', cert: 'elf', blurb: 'Twelve mythic chores for a hero with a keyboard.', challenges: ORDER.twelveDays },
];

// The full campaign: every tier in order, then the bonus round.
export const CAMPAIGN = [...TIERS.flatMap(t => t.challenges), ...BONUS.challenges];

export function tierOfChallenge(id) {
  for (const t of TIERS) if (t.challenges.includes(id)) return t;
  if (BONUS.challenges.includes(id)) return BONUS;
  for (const s of SIDE_QUESTS) if (s.challenges.includes(id)) return s;
  for (const e of EDITIONS) if (e.challenges.includes(id)) return e;
  return null;
}
