// Easter eggs. Only installed in game mode (never in the fidelity test environment).
import { utf8Encode } from '../bytes.js';
const C = {};

function bubble(text, width = 40) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > width) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  const w = Math.max(...lines.map(l => l.length), 1);
  let s = ' ' + '_'.repeat(w + 2) + '\n';
  if (lines.length === 1) s += `< ${lines[0].padEnd(w)} >\n`;
  else lines.forEach((l, i) => { const [a, b] = i === 0 ? ['/', '\\'] : i === lines.length - 1 ? ['\\', '/'] : ['|', '|']; s += `${a} ${l.padEnd(w)} ${b}\n`; });
  return s + ' ' + '-'.repeat(w + 2) + '\n';
}

const FORTUNES = [
  'There are 10 types of people: those who understand binary and those who do not.',
  'It works on my machine. -- Every developer, ever',
  'To understand recursion, you must first understand recursion.',
  'The best thing about a boolean is even if you are wrong, you are only off by a bit.',
  'rm -rf / : the fastest way to free up disk space. Do not do it.',
  'A clean desk is a sign of a cluttered drawer. A clean $HOME is a sign of dotfiles.',
  'grep: because Ctrl+F is for people with mice.',
  'Real programmers count from 0.',
  'Unix is user-friendly. It is just picky about who its friends are.',
  'There is no place like 127.0.0.1',
  'Talk is cheap. Show me the one-liner.',
  'awk: making your coworkers ask "what does that do?" since 1977.',
  "You can't spell 'pipeline' without 'pipe'. Or 'line'. Or 'pi'.",
  'sudo make me a sandwich.',
  'May your pipes never break and your globs always match.',
];

C.cowsay = (ctx) => {
  let args = ctx.argv.slice(1).filter(a => !a.startsWith('-'));
  const text = args.length ? args.join(' ') : ctx.stdin.readAll().trim() || 'Moo. Try harder commands.';
  ctx.out(bubble(text) + '        \\   ^__^\n         \\  (oo)\\_______\n            (__)\\       )\\/\\\n                ||----w |\n                ||     ||\n');
  return 0;
};
C.cowthink = C.cowsay;
C.fortune = (ctx) => { ctx.out(FORTUNES[ctx.sh.random() % FORTUNES.length] + '\n'); return 0; };
C.sl = (ctx) => {
  ctx.out([
    '      ====        ________                ___________ ',
    '  _D _|  |_______/        \\__I_I_____===__|_________| ',
    '   |(_)---  |   H\\________/ |   |        =|___ ___|   ',
    '   /     |  |   H  |  |     |   |         ||_| |_||   ',
    '  |      |  |   H  |__--------------------| [___] |   ',
    '  | ________|___H__/__|_____/[][]~\\_______|       |   ',
    '  |/ |   |-----------I_____I [][] []  D   |=======|__ ',
    '__/ =| o |=-~~\\  /~~\\  /~~\\  /~~\\ ____Y___________|__ ',
    ' |/-=|___|=    ||    ||    ||    |_____/~\\___/        ',
    '  \\_/      \\O=====O=====O=====O_/      \\_/            ',
    '',
    'You meant `ls`. The train has been dispatched to remind you.',
  ].join('\n') + '\n');
  return 0;
};
C.lolcat = (ctx) => {
  const files = ctx.argv.slice(1).filter(a => !a.startsWith('-'));
  let data = '';
  if (files.length) { for (const f of files) { try { data += ctx.readFile(f); } catch (e) { ctx.err(`${f}: ${e.message}`); } } } else data = ctx.stdin.readAll();
  const colors = [31, 33, 32, 36, 34, 35];
  let out = '', k = 0;
  for (const ch of data) { if (ch === '\n') { out += '\x1b[0m\n'; k = 0; continue; } out += `\x1b[${colors[Math.floor(k / 2) % colors.length]}m${ch}`; k++; }
  ctx.out(out + '\x1b[0m');
  return 0;
};

const FIG = {
  A: [' _ ', '/_\\', '| |'], B: [' _ ', '|_)', '|_)'], C: [' _ ', '/  ', '\\_ '], D: [' _ ', '| \\', '|_/'], E: [' _ ', '|_ ', '|_ '], F: [' _ ', '|_ ', '|  '], G: [' _ ', '/ _', '\\_|'], H: ['   ', '|_|', '| |'],
  I: ['_', '|', '|'], J: ['  ', ' |', '_|'], K: ['  ', '|/', '|\\'], L: ['  ', '| ', '|_'], M: ['    ', '|\\/|', '|  |'], N: ['   ', '|\\|', '| |'], O: [' _ ', '/ \\', '\\_/'], P: [' _ ', '|_)', '|  '],
  Q: [' _ ', '/ \\', '\\_X'], R: [' _ ', '|_)', '| \\'], S: [' __', '(_ ', '__)'], T: ['___', ' | ', ' | '], U: ['   ', '| |', '|_|'], V: ['   ', '\\ /', ' V '], W: ['    ', '\\  /', ' \\/\\'], X: ['  ', '\\/', '/\\'],
  Y: ['   ', '\\_/', ' | '], Z: ['__', ' /', '/_'], ' ': ['  ', '  ', '  '], '!': ['|', '|', '.'], '?': ['__', ' _)', ' . '], '>': ['   ', ' \\ ', ' / '], _: ['   ', '   ', '___'], '-': ['  ', '__', '  '],
  0: [' _ ', '| |', '|_|'], 1: [' ', '|', '|'], 2: ['_ ', ' )', '/_'], 3: ['_ ', '_)', '_)'], 4: ['   ', '|_|', '  |'], 5: [' _', '|_', ' _)'], 6: [' _ ', '|_ ', '|_)'], 7: ['__', ' /', '/ '], 8: [' _ ', '(_)', '(_)'], 9: [' _ ', '(_|', '  |'],
};
C.figlet = C.banner = C.toilet = (ctx) => {
  const text = (ctx.argv.slice(1).filter(a => !a.startsWith('-')).join(' ') || ctx.stdin.readAll().trim() || 'CMDPRO').toUpperCase();
  const rows = ['', '', ''];
  for (const ch of text) { const g = FIG[ch] || FIG['?']; for (let r = 0; r < 3; r++) rows[r] += g[r] + ' '; }
  ctx.out(rows.map(r => r.replace(/\s+$/, '')).join('\n') + '\n');
  return 0;
};

C.sudo = (ctx) => {
  const args = ctx.argv.slice(1);
  if (args[0] === 'make' && args.slice(1).join(' ').includes('sandwich')) { ctx.out(utf8Encode('Okay. 🥪\n')); return 0; }
  if (!args.length) { ctx.stderr.write('usage: sudo command\n'); return 1; }
  ctx.stderr.write('\nWe trust you have received the usual lecture from the local System\nAdministrator. It usually boils down to these three things:\n\n    #1) Respect the privacy of others.\n    #2) Think before you type.\n    #3) With great power comes great responsibility.\n\n(You are already root in here. The lecture is free.)\n');
  return ctx.spawn(args);
};
C.please = (ctx) => { ctx.out('Since you asked nicely... '); return C.sudo(ctx); };
for (const ed of ['vim', 'vi', 'nvim', 'nano', 'emacs', 'ed', 'pico', 'code', 'gedit']) {
  C[ed] = (ctx) => { ctx.stderr.write(`${ctx.name}: no editors in the arcade. Real champions use \`sed -i\`. (Psst: to quit vim, type :q!)\n`); return 1; };
}
for (const pm of ['apt', 'apt-get', 'dnf', 'yum', 'brew', 'pip', 'pip3', 'npm', 'snap', 'pacman', 'zypper', 'apk']) {
  C[pm] = (ctx) => { ctx.stderr.write(`${ctx.name}: package managers are disabled. Rocky the rock says: "you already have everything you need."\n`); return 100; };
}
for (const net of ['ping', 'curl', 'wget', 'ssh', 'scp', 'telnet', 'nc', 'nmap', 'ftp', 'dig', 'nslookup', 'traceroute']) {
  C[net] = (ctx) => { ctx.stderr.write(utf8Encode(`${ctx.name}: network unreachable — this arcade cabinet is proudly air-gapped.\n`)); return 2; };
}
C.git = (ctx) => {
  const sub = ctx.argv[1];
  if (sub === 'blame') { ctx.out("It was you. It's always been you.\n"); return 0; }
  if (sub === 'push' && ctx.argv.includes('--force')) { ctx.stderr.write('git: denied. Friends do not let friends force-push on a Friday.\n'); return 1; }
  ctx.stderr.write('fatal: not a git repository (or any of the parent directories): .git\n');
  return 128;
};
C.make = (ctx) => {
  const t = ctx.argv.slice(1).join(' ');
  if (/love/.test(t)) { ctx.stderr.write("make: *** No rule to make target 'love'.  Not war?\n"); return 2; }
  if (/coffee|sandwich/.test(t)) { ctx.stderr.write(`make: *** No rule to make target '${t}'.  Try sudo.\n`); return 2; }
  ctx.stderr.write("make: *** No targets specified and no makefile found.  Stop.\n");
  return 2;
};
for (const p of ['reboot', 'shutdown', 'halt', 'poweroff', 'init']) C[p] = (ctx) => { ctx.stderr.write(`${ctx.name}: the arcade cabinet refuses to power down. Insert another coin.\n`); return 1; };
C.xyzzy = (ctx) => { ctx.out('Nothing happens.\n'); return 0; };
C.hack = (ctx) => { ctx.out('ACCESS GRANTED... just kidding. Try solving the challenge instead.\n'); return 0; };
C.hello = (ctx) => { ctx.out('Hello, World! (That one is free.)\n'); return 0; };
C.cmdpro = (ctx) => { ctx.out('CMDPRO OS 1.0 (Command Line Warrior)\nA retro arcade for terminal heroes.\n'); return 0; };
C.matrix = C.cmatrix = (ctx) => { let s = ''; for (let r = 0; r < 8; r++) { let l = ''; for (let c = 0; c < 60; c++) l += (ctx.sh.random() % 3 === 0) ? String.fromCharCode(0x30 + ctx.sh.random() % 43) : ' '; s += `\x1b[32m${l}\x1b[0m\n`; } ctx.out(s + 'Wake up, Neo... the challenge is waiting.\n'); return 0; };
C.less = C.most = C.pg = (ctx) => { ctx.stderr.write(utf8Encode(`bash: ${ctx.name}: command not found\n(no interactive pagers in the arcade — try cat, head, tail or more)\n`)); return 127; };
C.python = C.python3 = C.perl = C.ruby = C.node = C.php = C.lua = (ctx) => { ctx.stderr.write(utf8Encode(`bash: ${ctx.name}: command not found\n(only the shell and the classic UNIX toolbox are allowed in here — that's the fun part)\n`)); return 127; };
C.coffee = (ctx) => { ctx.out('       ( (\n        ) )\n     ........\n     |      |]\n     \\      /\n      `----\'\nError 418: I\'m a teapot.\n'); return 0; };

// holiday edition characters
C.boo = (ctx) => { ctx.out('   .-.\n  (o o)  BOO!\n  | O \\   (that is short for Boolean)\n   \\   \\\n    `~~~\'\n'); return 0; };
C.gobble = (ctx) => { ctx.out('GOBBLE GOBBLE! (Sir Gobbles says: I am the host, not the menu.)\n'); return 0; };
C.hohoho = C.santa = (ctx) => { ctx.out('HO HO HO! Santa Cron is scheduled for 0 0 25 12 *. Until then: keep piping.\n'); return 0; };
C.brains = (ctx) => { ctx.out('Braaains... I mean, bash. -- Zed\n'); return 0; };

export default C;
