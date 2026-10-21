// Command registry.
import textutils from './textutils.js';
import fileutils from './fileutils.js';
import ls from './ls.js';
import find from './find.js';
import grep from './grep.js';
import sed from './sed.js';
import awk from './awk.js';
import misc from './misc.js';
import diff from './diff.js';
import bc from './bc.js';
import jq from './jq.js';
import man from './man.js';
import archive from './archive.js';
import fun from './fun.js';

const CORE = { ...textutils, ...fileutils, ...ls, ...find, ...grep, ...sed, ...awk, ...misc, ...diff, ...bc, ...jq, ...man, ...archive };

// Commands that live in /usr/sbin rather than /usr/bin
export const SBIN = new Set(['killall5', 'reboot', 'shutdown', 'halt', 'poweroff']);

// Not installed in the Ubuntu 22.04 reference image: only offered in the game (fidelity runs leave them out)
export const GAME_EXTRAS = ['strings', 'dc', 'killall', 'lsb_release', 'info', 'apropos', 'whatis', 'unbuffer', 'less', 'most', 'pg'];
// game-mode easter eggs that replace a real implementation
const FUN_OVERRIDES = ['perl', 'python', 'python3', 'less', 'most', 'pg'];

export function buildRegistry({ game = false } = {}) {
  const m = new Map(Object.entries(CORE));
  if (game) { for (const [k, v] of Object.entries(fun)) if (!m.has(k) || FUN_OVERRIDES.includes(k)) m.set(k, v); }
  else for (const k of GAME_EXTRAS) m.delete(k);
  return m;
}

export const CORE_NAMES = Object.keys(CORE);
export const FUN_NAMES = Object.keys(fun);
