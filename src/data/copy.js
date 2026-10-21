// All the jokes live here. Keep them silly, keep them kind.

export const BIOS_LINES = [
  'CMDPRO BIOS v4.20  (C) 1987-2026 CMDPRO Certificate Authority',
  '',
  'Pastel Green 8088 CPU @ 4.77 MHz ............ OK',
  'Memory test: 640K .......................... OK  (ought to be enough for anybody)',
  'Detecting keyboards ........................ 1 found (mechanical, very loud)',
  'Detecting mice ............................. 0 found (good, you will not need one)',
  'Detecting GUI .............................. not found (as intended)',
  'Boot device: /dev/fun0',
  '',
];

export const KERNEL_LINES = [
  '[    0.000000] Linux version 6.6.6-cmdpro (root@cmdpro) (gcc 13.37) #1 SMP PREEMPT_DYNAMIC',
  '[    0.000000] Command line: BOOT_IMAGE=/vmlinuz root=/dev/fun0 ro quiet splash=retro',
  '[    0.004200] Calibrating delay loop... 13.37 BogoMIPS',
  '[    0.031415] EXT4-fs (fun0): mounted /var/challenges with ordered data mode',
  '[    0.069000] Loading modules: grep sed awk find xargs jq',
  '[    0.133700] systemd[1]: Detected architecture: arcade-cabinet',
  '[  OK  ] Started Companion Daemon (sudo-the-cat.service)',
  '[  OK  ] Started CMDPRO Certificate Authority (cmdpro-ca.service)',
  '[  OK  ] Mounted Bragging Rights (/home/you/brag)',
  '[  OK  ] Reached target Multi-User Fun.',
  '[ WARN ] GUI not found. Proceeding anyway.',
  '',
  'CMDPRO Linux 1.0 (tty1)',
  '',
  'cmdpro login: player (automatic login)',
];

export const TIPS = [
  '`Ctrl+R` searches your command history. Your future self says thanks.',
  '`cd -` jumps back to the previous directory. Like an undo button for walking.',
  'Quote your variables: `"$file"`. Spaces in file names are lurking everywhere.',
  '`awk \'{print $NF}\'` prints the last field of every line.',
  '`sort | uniq -c | sort -rn` is the most popular pipeline on Earth (citation needed).',
  '`>` overwrites, `>>` appends. Ask anyone who has mixed them up at 3 a.m.',
  '`2>&1` sends errors to wherever output goes. Order matters!',
  'Brace expansion: `mkdir -p src/{lib,bin,test}` makes three directories at once.',
  '`$?` holds the exit status of the last command. 0 means success. Everything else means "it\'s complicated".',
  '`tac` is `cat` backwards. Unix humor peaked early.',
  '`seq -w 1 10` pads numbers with zeros: 01 02 … 10.',
  '`grep -o` prints only the part of the line that matched.',
  'Globs like `*.txt` are expanded by the shell. Regexes like `.*\\.txt` are interpreted by the program.',
  '`find . -name \'*.log\' -delete` beats piping into `rm`.',
  '`column -t` turns whitespace-separated chaos into a tidy table.',
  '`paste -sd,` joins all lines with commas.',
  '`tr -s \' \'` squeezes runs of spaces into one.',
  '`comm` and `join` want sorted input. So does your sock drawer.',
  '`$(<file)` reads a file without even spawning `cat`.',
  '`printf` is more predictable than `echo -e`. Pros reach for printf.',
  'Ken Thompson wrote the first Unix shell in 1971.',
  'Pipes arrived in Unix in 1973, thanks to Doug McIlroy\'s persistence.',
  '`#!` is called a shebang. Or hash-bang. Or sha-bang. Pick a side.',
  '`xargs -0` with `find -print0` survives file names with spaces AND newlines.',
  '`${f%.*}` strips an extension. `${f##*/}` strips the directory. No `basename` needed.',
  '`set -euo pipefail` makes scripts fail loudly instead of silently.',
  'Tab completion is not cheating. It is a lifestyle.',
  'In awk, `!seen[$0]++` removes duplicate lines without sorting. Witchcraft.',
  '`sed -n \'10,20p\'` prints lines 10 to 20. `p` is for print, `-n` is for "not the others".',
  'Every command here runs in a fresh copy of the challenge directory. Break things freely.',
];

export const GAMEOVER_QUIPS = [
  'Segmentation fault (core dumped)',
  'Kernel panic - not syncing: Attempted to kill init!',
  'Process exited with status 137 (out of lives)',
  'Bus error. The bus has left. You were not on it.',
  'Killed by the OOM killer (Out Of Moves)',
  'rm: cannot remove \'your dignity\': Device or resource busy',
  'Illegal instruction (core dumped)',
  'Connection to cmdpro closed by remote host.',
  'Abort trap: 6',
  'Fatal error: stack smashing detected',
];

export const GAMEOVER_SUBTITLES = [
  'The kernel panicked so you don\'t have to.',
  'Progress resets to challenge #1. Certificates are forever.',
  'Every legend has a stack trace.',
  'Even Linus had to reboot sometimes.',
  'Insert coin to continue. (Coins are free. We checked.)',
];

export const CORRECT_LINES = [
  'Correct! Exit code 0. Chef\'s kiss.',
  'Nailed it. The penguins applaud.',
  'Correct! Cleaner than a fresh install.',
  'Correct! Somewhere a sysadmin sheds a single proud tear.',
  'Correct! grep would be proud.',
  'Correct! You and the shell are vibing.',
  'Correct! Even the man page is impressed.',
  'Correct! No GUIs were harmed.',
  'Correct! 10/10, would pipe again.',
  'Correct! Your keyboard just leveled up.',
];

export const WRONG_LINES = [
  'Incorrect. The output did not match.',
  'Not quite. Close only counts in horseshoes and floating point.',
  'Nope. The judge is unimpressed.',
  'Incorrect. The shell did exactly what you said — not what you meant.',
  'Wrong answer. Have you tried turning it off and on again?',
  'Incorrect. That is what we call a learning opportunity.',
  'Incorrect. Even `rm -rf` has better aim.',
];

export const PASTE_BLOCKED = [
  'Paste blocked. Extremely Hard means every keystroke is yours.',
  'Nice try. The clipboard has been confiscated by the CMDPRO Certificate Authority.',
  'Ctrl+V? In THIS economy? Type it out, legend.',
  'Clipboard access denied: you agreed to type like it is 1978.',
  'That was suspiciously fast typing. The judges have questions.',
];

export const TIMEOUT_LINES = [
  'Time\'s up! The clock was not impressed by your thinking face.',
  'SIGALRM received. The timer has spoken.',
  'Out of time. Even `sleep` finishes eventually.',
];

export const DIFFICULTY_COPY = {
  easy: { tag: 'Training wheels', desc: 'Five attempts per challenge, all the hints, a Learn panel before you start and a companion who believes in you.' },
  normal: { tag: 'The classic', desc: 'Three strikes per challenge. Hints are available but cost points. The way terminal heroes were meant to play.' },
  hard: { tag: 'No safety net', desc: 'Two attempts. No hints. Your companion is strictly here for moral support.' },
  extreme: { tag: 'For those who know everything', desc: 'One attempt. A ticking clock. No paste. No hints. Fail once and it\'s back to challenge #1.' },
};

export const TIER_BRIEFINGS = {
  1: {
    intro: 'Welcome to the data center. The GUIs are down, the mouse has retired, and only the command line remains. Let\'s learn to talk to it.',
    skills: ['Print text and find out where you are', 'List, read and peek at files', 'Create, copy, move and link files and folders'],
    diagrams: ['prompt', 'fs-tree'],
  },
  2: {
    intro: 'You can walk around. Now learn to find things — and make them disappear. Responsibly. Mostly.',
    skills: ['Delete with `rm`, globs and `find -delete`', 'Search inside files with `grep` (`-l`, `-r`, `-h`, `-c`)', 'Count and sort like an accountant'],
    diagrams: ['glob-regex', 'find-walk'],
  },
  3: {
    intro: 'Pipes are the plumbing of the universe: the output of one command flows straight into the next. Plumbers are concerned.',
    skills: ['Chain tools with `|`', 'Transform text with `tr`, `cut`, `sed` and `paste`', 'Do math without a spreadsheet'],
    diagrams: ['pipes', 'streams'],
  },
  4: {
    intro: 'Loops, renames and — brace yourself — paths with spaces in them. Architects plan before they `rm`.',
    skills: ['Loop over files and rename with `${f%.*}`', 'Quote paths that bite back', '`find -exec`, `xargs`, permissions and links'],
    diagrams: ['find-exec', 'chmod'],
  },
  5: {
    intro: 'awk and sed: the senior partners of the text-processing law firm. They bill by the line.',
    skills: ['awk patterns, fields and arrays', 'sed ranges and capture groups', 'Compare and merge data with `comm` and `<(…)`'],
    diagrams: ['awk', 'procsub'],
  },
  6: {
    intro: 'Regex sorcery, checksums and log forensics. Wizards only. Pointy hats optional.',
    skills: ['Primes, checksums and byte-level comparisons', 'Advanced `sort -k` and `find -regex`', 'Decode, dedupe and detect impostors'],
    diagrams: ['regex', 'symlink'],
  },
  7: {
    intro: 'The Guru tier. One-liners that make senior engineers nervous and junior engineers take notes.',
    skills: ['Transpose, aggregate and histogram data', 'Parse real-world tool output', 'Compose everything you have learned'],
    diagrams: ['toolbox', 'pipes'],
  },
  bonus: {
    intro: 'Five problems that have made grown engineers weep into their mechanical keyboards. Solve them all and the Certificate Authority will start asking whether you are, in fact, a machine.',
    skills: ['Everything', 'All at once', 'Possibly while being timed'],
    diagrams: ['turing'],
  },
};

export const SIDE_QUEST_COPY = {
  oops: 'A mischievous gremlin is nibbling its way through /bin and /usr/bin. No `ls`, no `cat`, no mercy — only bash builtins survive. Find your bearings, rescue the precious file, unmask the gremlin and send it to bed.',
  '12days': 'Bashercules, hero of the terminal, must complete twelve legendary labors: count the Hydra\'s heads, muck out the stables, fetch the golden apples… one command each. Twelve labors, zero GUIs.',
};

export const HELP_LINES = [
  'CMDPRO game commands (never cost an attempt):',
  '  help              this screen   (bash builtins: help <name>)',
  '  hint              reveal the next hint (Easy/Normal)',
  '  recon             open a free sandbox shell to explore; exit to leave',
  '  files             open the files panel',
  '  solutions         other ways to solve it (after you solve it)',
  '  focus             toggle focus mode (fullscreen)',
  '  theme <name>      switch theme (try: theme dracula; `theme` lists them all)',
  '  sound on|off      toggle all sound',
  '  save [export]     save your game now (Ctrl+S); export also downloads a save file',
  '  next              go to the next challenge (after solving)',
  '  menu              back to the campaign map',
  '  clear             clear the screen (Ctrl+L)',
  '',
  'Keys: F1 help · F2 recon · F3 hint · F4 files · Ctrl+S save · Tab complete · Ctrl+R history search · Ctrl+C cancel',
  'Every judged command runs in a FRESH copy of the challenge directory.',
];

export const TITLE_TAGLINES = [
  'The command line arcade. Now with more beeps.',
  'No mouse required. No GUI tolerated.',
  'Certified bragging rights since 1969 (Unix epoch adjacent).',
  'Where `rm -rf` goes to get certified.',
];

export const SETUP_COPY = {
  handleHint: 'Shown in your prompt. Lowercase letters, digits, - and _ (max 16).',
  certNameHint: 'Printed on your certificates. Your real name, a stage name, or "Root, Destroyer of GUIs".',
};

export const FREEPLAY_COPY = 'Practice mode: unlimited attempts, every hint, and a "give up" button. No certificates, no score, no judgement. Well, a little judgement.';
