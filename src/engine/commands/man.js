// man / whatis / apropos / info with concise built-in manual pages.
const P = {
  ls: ['list directory contents', 'ls [OPTION]... [FILE]...', [['-a', 'do not ignore entries starting with .'], ['-A', 'like -a but without . and ..'], ['-l', 'long listing format'], ['-h', 'human-readable sizes (with -l)'], ['-1', 'one entry per line'], ['-R', 'list subdirectories recursively'], ['-r', 'reverse order'], ['-S', 'sort by size, largest first'], ['-t', 'sort by modification time, newest first'], ['-d', 'list directories themselves, not their contents'], ['-F', 'append indicator (one of */=>@|)']], [['ls -la', 'everything, long format, hidden files too'], ['ls -1 | wc -l', 'count entries']]],
  cat: ['concatenate files and print on the standard output', 'cat [OPTION]... [FILE]...', [['-n', 'number all output lines'], ['-b', 'number nonempty lines'], ['-s', 'squeeze repeated empty lines'], ['-A', 'show all: tabs as ^I, line ends as $'], ['-E', 'display $ at end of each line'], ['-T', 'display TAB characters as ^I']], [['cat a b > ab', 'join two files'], ['cat -A file', 'reveal invisible characters']]],
  head: ['output the first part of files', 'head [OPTION]... [FILE]...', [['-n N', 'print the first N lines (default 10)'], ['-n -N', 'print all but the last N lines'], ['-c N', 'print the first N bytes'], ['-q', 'never print headers']], [['head -n 3 file', 'first three lines']]],
  tail: ['output the last part of files', 'tail [OPTION]... [FILE]...', [['-n N', 'output the last N lines (default 10)'], ['-n +N', 'output starting with line N'], ['-c N', 'output the last N bytes'], ['-f', 'follow appended data (no-op here)']], [['tail -n 5 log', 'last five lines'], ['tail -n +2 data.csv', 'skip a header line']]],
  grep: ['print lines that match patterns', 'grep [OPTION...] PATTERNS [FILE...]', [['-i', 'ignore case'], ['-v', 'invert match: select non-matching lines'], ['-c', 'count matching lines'], ['-l', 'list names of files with matches'], ['-n', 'prefix line numbers'], ['-o', 'print only the matched parts'], ['-w', 'match whole words'], ['-x', 'match whole lines'], ['-r', 'search directories recursively'], ['-h / -H', 'suppress / force file names'], ['-E', 'extended regular expressions'], ['-F', 'fixed strings'], ['-P', 'Perl-compatible regular expressions'], ['-A/-B/-C N', 'context lines after/before/around']], [["grep -rn 'TODO' .", 'find TODOs with line numbers'], ["grep -oE '[0-9]+' file", 'extract numbers'], ["grep -c ERROR app.log", 'count error lines']]],
  egrep: ['print lines that match patterns (same as grep -E)', 'egrep [OPTION...] PATTERNS [FILE...]', [], []],
  sed: ['stream editor for filtering and transforming text', "sed [OPTION]... {script} [input-file]...", [['-n', 'suppress automatic printing'], ['-e script', 'add a script'], ['-i[SUFFIX]', 'edit files in place'], ['-E, -r', 'extended regular expressions'], ['s/re/rep/flags', 'substitute (flags: g p N i)'], ['Np / /re/p', 'print line N / matching lines'], ['d', 'delete pattern space'], ['a, i, c', 'append, insert, change text'], ['y/abc/xyz/', 'transliterate']], [["sed -n '10,20p' f", 'print lines 10-20'], ["sed 's/foo/bar/g' f", 'replace every foo'], ["sed -i '/^#/d' f", 'delete comment lines in place']]],
  awk: ['pattern scanning and processing language', "awk [-F fs] [-v var=value] 'program' [file...]", [['-F fs', 'set the field separator'], ['-v var=val', 'assign a variable before execution'], ['$0, $1..$NF', 'whole record, fields'], ['NR, NF, FNR', 'record number, number of fields, per-file record number'], ['BEGIN{} END{}', 'run before / after input'], ['printf, sprintf', 'formatted output'], ['split, sub, gsub, substr, length, index, match, tolower, toupper', 'built-in functions']], [["awk '{print $1}' f", 'first column'], ["awk -F, '{s+=$3} END{print s}' f.csv", 'sum a CSV column'], ["awk '!seen[$0]++' f", 'remove duplicate lines, keep order']]],
  find: ['search for files in a directory hierarchy', 'find [path...] [expression]', [['-name PAT', 'base name matches shell pattern'], ['-iname PAT', 'case-insensitive -name'], ['-path PAT', 'whole path matches pattern'], ['-type f|d|l', 'file type'], ['-size [+-]N[ckMG]', 'file size'], ['-mtime [+-]N', 'modified N days ago'], ['-perm MODE', 'permission bits'], ['-empty', 'empty file or directory'], ['-maxdepth N', 'descend at most N levels'], ['-exec CMD {} ;', 'run CMD for each file ({} + batches)'], ['-delete', 'delete matching files'], ['-printf FMT', 'formatted output (%p path, %f name, %s size)'], ['!, -o, ( )', 'not, or, grouping']], [["find . -name '*.log' -mtime +30 -delete", 'clean old logs'], ["find . -type f -printf '%f\\n'", 'just the file names'], ["find . -type d -empty", 'empty directories']]],
  sort: ['sort lines of text files', 'sort [OPTION]... [FILE]...', [['-n', 'numeric sort'], ['-r', 'reverse'], ['-u', 'unique: output only the first of equal lines'], ['-k POS1[,POS2]', 'sort by key'], ['-t SEP', 'field separator'], ['-h', 'human numeric (2K, 1G)'], ['-V', 'version sort'], ['-f', 'ignore case'], ['-s', 'stable'], ['-o FILE', 'write result to FILE']], [['sort -t, -k3,3nr data.csv', 'by 3rd CSV column, numeric, descending'], ['sort | uniq -c | sort -rn', 'frequency table']]],
  uniq: ['report or omit repeated lines', 'uniq [OPTION]... [INPUT [OUTPUT]]', [['-c', 'prefix lines by the number of occurrences'], ['-d', 'only print duplicate lines'], ['-u', 'only print unique lines'], ['-i', 'ignore case'], ['-f N', 'skip N fields'], ['-w N', 'compare no more than N characters']], [['sort f | uniq -c', 'count occurrences (input must be sorted!)']]],
  wc: ['print newline, word, and byte counts for each file', 'wc [OPTION]... [FILE]...', [['-l', 'lines'], ['-w', 'words'], ['-c', 'bytes'], ['-m', 'characters'], ['-L', 'length of the longest line']], [['wc -l < file', 'just the number']]],
  cut: ['remove sections from each line of files', 'cut OPTION... [FILE]...', [['-d DELIM', 'field delimiter (default TAB)'], ['-f LIST', 'select fields (1,3 or 2-4)'], ['-c LIST', 'select characters'], ['-s', 'only lines with delimiters'], ['--complement', 'invert the selection']], [['cut -d, -f2 data.csv', 'second CSV column'], ["cut -d: -f1 /etc/passwd", 'user names']]],
  tr: ['translate or delete characters', 'tr [OPTION]... SET1 [SET2]', [['-d', 'delete characters in SET1'], ['-s', 'squeeze repeats'], ['-c', 'complement SET1'], ['a-z, [:upper:]', 'ranges and classes']], [["tr a-z A-Z", 'uppercase'], ["tr -d '\\r'", 'strip carriage returns'], ["tr 'A-Za-z' 'N-ZA-Mn-za-m'", 'rot13']]],
  paste: ['merge lines of files', 'paste [OPTION]... [FILE]...', [['-d LIST', 'delimiters (default TAB)'], ['-s', 'one file at a time (serial)']], [['paste -sd, f', 'join all lines with commas'], ['paste a b', 'side by side']]],
  xargs: ['build and execute command lines from standard input', 'xargs [OPTION]... COMMAND [INITIAL-ARGS]...', [['-n N', 'at most N arguments per command'], ['-I {}', 'replace {} with each input line'], ['-0', 'NUL-separated input'], ['-d DELIM', 'custom delimiter'], ['-r', 'do not run if input is empty'], ['-t', 'print commands before running']], [['find . -name "*.tmp" | xargs rm', 'delete found files'], ["xargs -I{} mkdir -p {} < dirs.txt", 'one command per line']]],
  echo: ['display a line of text', 'echo [-neE] [STRING]...', [['-n', 'no trailing newline'], ['-e', 'interpret backslash escapes'], ['-E', 'do not interpret escapes (default)']], [["echo -e 'a\\tb'", 'print a tab']]],
  printf: ['format and print data', 'printf FORMAT [ARGUMENT]...', [['%s %d %f %x', 'string, integer, float, hex'], ['%5s %-5s %05d', 'width, left-align, zero pad'], ['%.2f', 'precision'], ['\\n \\t', 'escapes']], [["printf '%03d\\n' 7", '007'], ["printf '%s,%s\\n' a b c d", 'the format repeats']]],
  cp: ['copy files and directories', 'cp [OPTION]... SOURCE... DEST', [['-r', 'copy directories recursively'], ['-a', 'archive (recursive, keep attributes)'], ['-i', 'prompt before overwrite'], ['-n', 'do not overwrite'], ['-v', 'verbose'], ['-p', 'preserve mode and timestamps']], [['cp -r src/ backup/', 'copy a tree']]],
  mv: ['move (rename) files', 'mv [OPTION]... SOURCE... DEST', [['-i', 'prompt before overwrite'], ['-n', 'do not overwrite'], ['-v', 'verbose'], ['-t DIR', 'move all SOURCEs into DIR']], [['mv old.txt new.txt', 'rename'], ['mv *.jpg photos/', 'move into a directory']]],
  rm: ['remove files or directories', 'rm [OPTION]... [FILE]...', [['-r', 'remove directories and their contents'], ['-f', 'ignore nonexistent files, never prompt'], ['-i', 'prompt before every removal'], ['-d', 'remove empty directories'], ['-v', 'verbose']], [['rm -- -weird-name', 'remove a file starting with a dash'], ['rm -rf build/', 'nuke a directory (careful!)']]],
  mkdir: ['make directories', 'mkdir [OPTION]... DIRECTORY...', [['-p', 'make parents as needed, no error if existing'], ['-m MODE', 'set permissions'], ['-v', 'verbose']], [['mkdir -p a/b/c', 'nested'], ['mkdir {src,docs,tests}', 'several at once (brace expansion)']]],
  rmdir: ['remove empty directories', 'rmdir [OPTION]... DIRECTORY...', [['-p', 'remove parents too'], ['--ignore-fail-on-non-empty', 'ignore non-empty failures']], []],
  touch: ['change file timestamps (and create empty files)', 'touch [OPTION]... FILE...', [['-c', 'do not create files'], ['-d STRING', "use a date like '2 days ago'"], ['-t STAMP', 'use [[CC]YY]MMDDhhmm[.ss]'], ['-r FILE', "use FILE's time"]], [["touch -d '45 days ago' old.log", 'backdate a file']]],
  ln: ['make links between files', 'ln [OPTION]... TARGET [LINK_NAME]', [['-s', 'make symbolic links'], ['-f', 'remove existing destination'], ['-r', 'relative symlinks'], ['-v', 'verbose']], [['ln -s /etc/hosts hosts', 'symlink named hosts']]],
  chmod: ['change file mode bits', 'chmod [OPTION]... MODE[,MODE]... FILE...', [['u+x', 'add execute for owner'], ['go-w', 'remove write for group/others'], ['755 / 644', 'octal modes'], ['-R', 'recursive']], [['chmod +x script.sh', 'make executable']]],
  chown: ['change file owner and group', 'chown [OPTION]... [OWNER][:[GROUP]] FILE...', [['-R', 'recursive']], []],
  pwd: ['print name of current/working directory', 'pwd [-LP]', [['-P', 'physical path (resolve symlinks)']], []],
  cd: ['change the shell working directory (bash builtin)', 'cd [-L|-P] [dir]', [['cd -', 'previous directory'], ['cd', 'home directory']], []],
  basename: ['strip directory and suffix from filenames', 'basename NAME [SUFFIX]', [['-a', 'support multiple names'], ['-s SUFFIX', 'remove a trailing suffix']], [['basename /a/b/c.txt .txt', 'c']]],
  dirname: ['strip last component from file name', 'dirname NAME...', [], [['dirname /a/b/c.txt', '/a/b']]],
  tac: ['concatenate and print files in reverse', 'tac [OPTION]... [FILE]...', [['-s SEP', 'use SEP instead of newline']], []],
  rev: ['reverse lines characterwise', 'rev [file...]', [], [["echo hello | rev", 'olleh']]],
  seq: ['print a sequence of numbers', 'seq [OPTION]... [FIRST [INCREMENT]] LAST', [['-s SEP', 'separator (default newline)'], ['-w', 'equal width with leading zeros'], ['-f FMT', 'printf-style format']], [['seq -s " " 5', '1 2 3 4 5'], ['seq -w 1 10', '01 02 ... 10']]],
  tee: ['read from standard input and write to standard output and files', 'tee [OPTION]... [FILE]...', [['-a', 'append']], [['cmd | tee out.log', 'see it and save it']]],
  comm: ['compare two sorted files line by line', 'comm [OPTION]... FILE1 FILE2', [['-1', 'suppress lines unique to FILE1'], ['-2', 'suppress lines unique to FILE2'], ['-3', 'suppress lines in both']], [['comm -12 <(sort a) <(sort b)', 'lines common to both']]],
  join: ['join lines of two files on a common field', 'join [OPTION]... FILE1 FILE2', [['-t CHAR', 'field separator'], ['-1 F / -2 F', 'join fields'], ['-a N', 'print unpairable lines from file N'], ['-o FORMAT', 'output format']], []],
  diff: ['compare files line by line', 'diff [OPTION]... FILES', [['-u', 'unified format'], ['-q', 'report only whether files differ'], ['-r', 'recursive'], ['-i / -w / -b', 'ignore case / all space / space changes'], ['-y', 'side by side']], [['diff -u old new', 'patch-style diff']]],
  cmp: ['compare two files byte by byte', 'cmp [OPTION]... FILE1 [FILE2]', [['-s', 'silent; exit status only'], ['-l', 'list all differing bytes']], [['cmp -s a b && echo same', 'test identity']]],
  md5sum: ['compute and check MD5 message digest', 'md5sum [OPTION]... [FILE]...', [['-c', 'check sums from a file']], [['md5sum * | sort | uniq -w32 -D', 'find duplicate files']]],
  sha256sum: ['compute and check SHA256 message digest', 'sha256sum [OPTION]... [FILE]...', [['-c', 'check sums from a file']], []],
  base64: ['base64 encode/decode data', 'base64 [OPTION]... [FILE]', [['-d', 'decode'], ['-w N', 'wrap at N columns (0 = no wrap)']], [['echo aGkK | base64 -d', 'hi']]],
  xxd: ['make a hexdump or do the reverse', 'xxd [options] [infile [outfile]]', [['-p', 'plain hex'], ['-r', 'reverse (hex to binary)'], ['-l N', 'stop after N bytes'], ['-c N', 'N bytes per line']], [['head -c 8 img.png | xxd', 'inspect magic bytes']]],
  od: ['dump files in octal and other formats', 'od [OPTION]... [FILE]...', [['-c', 'characters'], ['-An', 'no addresses'], ['-t x1', 'hex bytes']], []],
  file: ['determine file type', 'file [OPTION]... FILE...', [['-b', 'brief: no file names'], ['-i', 'MIME type']], []],
  stat: ['display file or file system status', 'stat [OPTION]... FILE...', [['-c FORMAT', '%n name, %s size, %a octal perms, %A human perms, %U owner, %y mtime']], [["stat -c '%a %n' *", 'octal permissions']]],
  du: ['estimate file space usage', 'du [OPTION]... [FILE]...', [['-s', 'summarize'], ['-h', 'human-readable'], ['-a', 'all files'], ['-d N', 'max depth']], []],
  tree: ['list contents of directories in a tree-like format', 'tree [options] [directory]', [['-a', 'all files'], ['-d', 'directories only'], ['-L N', 'max depth']], []],
  date: ['print or set the system date and time', 'date [OPTION]... [+FORMAT]', [['-d STRING', "describe a date: 'yesterday', '2 days ago', '@1700000000'"], ['-u', 'UTC'], ['+%Y-%m-%d', 'custom format']], [['date +%s', 'epoch seconds']]],
  bc: ['an arbitrary precision calculator language', 'bc [-l]', [['-l', 'math library (scale=20; s c a l e j)'], ['scale=N', 'digits after the decimal point'], ['ibase/obase', 'input/output base']], [["echo '2^64' | bc", 'big numbers'], ["echo 'scale=2; 10/3' | bc", '3.33']]],
  expr: ['evaluate expressions', 'expr EXPRESSION', [['+ - * / %', 'integer arithmetic (escape *)'], ['STRING : REGEX', 'anchored match'], ['length STRING', 'string length']], []],
  factor: ['factor numbers', 'factor [NUMBER]...', [], [['factor 60', '60: 2 2 3 5']]],
  jq: ['Command-line JSON processor', 'jq [options] <jq filter> [file...]', [['-r', 'raw strings'], ['-c', 'compact'], ['-s', 'slurp into an array'], ['-n', 'null input'], ['.key, .[], .[0]', 'navigate'], ['select(), map(), sort_by(), group_by()', 'transform'], ['@csv @tsv', 'formats']], [["jq -r '.[] | select(.active) | .name' users.json", 'names of active users'], ["jq -r '.[] | [.a,.b] | @csv'", 'JSON to CSV']]],
  column: ['columnate lists', 'column [options] [file ...]', [['-t', 'table'], ['-s SEP', 'input separators'], ['-o SEP', 'output separator']], [['column -t -s, data.csv', 'pretty-print a CSV']]],
  nl: ['number lines of files', 'nl [OPTION]... [FILE]...', [['-b a', 'number all lines'], ['-w N', 'number width'], ['-s SEP', 'separator']], []],
  fold: ['wrap each input line to fit in specified width', 'fold [OPTION]... [FILE]...', [['-w N', 'width'], ['-s', 'break at spaces']], []],
  split: ['split a file into pieces', 'split [OPTION]... [FILE [PREFIX]]', [['-l N', 'N lines per file'], ['-b SIZE', 'SIZE bytes per file'], ['-d', 'numeric suffixes']], []],
  shuf: ['generate random permutations', 'shuf [OPTION]... [FILE]', [['-n N', 'output at most N lines'], ['-i LO-HI', 'treat each number as an input line']], []],
  tsort: ['perform topological sort', 'tsort [FILE]', [], [["printf 'a b\\nb c\\n' | tsort", 'a b c']]],
  rename: ['renames multiple files (perl expression)', "rename [-n] [-v] 'perlexpr' [files]", [['-n', 'dry run'], ['-v', 'verbose']], [["rename 's/\\.jpeg$/.jpg/' *.jpeg", 'change extensions']]],
  realpath: ['print the resolved path', 'realpath [OPTION]... FILE...', [['-s', 'do not expand symlinks'], ['--relative-to=DIR', 'print relative to DIR']], []],
  readlink: ['print resolved symbolic links or canonical file names', 'readlink [OPTION]... FILE...', [['-f', 'canonicalize']], []],
  kill: ['send a signal to a process', 'kill [-s signal|-p] [-q sigval] [-a] [--] pid...', [['-9', 'SIGKILL'], ['-l', 'list signal names'], ['-0', 'check whether a process exists']], []],
  ps: ['report a snapshot of the current processes', 'ps [options]', [['aux', 'all processes, user-oriented'], ['-ef', 'full format']], []],
  bash: ['GNU Bourne-Again SHell', 'bash [options] [command_string | file]', [['-c STRING', 'run commands from STRING'], ['$(cmd)', 'command substitution'], ['<(cmd)', 'process substitution'], ['${var%pat} ${var#pat} ${var/a/b}', 'parameter expansion'], ['{a,b} {1..10}', 'brace expansion'], ['**', 'recursive glob (globstar)']], [['for f in *.txt; do echo "$f"; done', 'loop over files']]],
  test: ['check file types and compare values', 'test EXPRESSION  |  [ EXPRESSION ]', [['-f FILE', 'regular file'], ['-d FILE', 'directory'], ['-e FILE', 'exists'], ['-z STR / -n STR', 'empty / non-empty'], ['A -eq B', 'integer comparison (-ne -lt -le -gt -ge)'], ['S1 = S2', 'string equality']], []],
  read: ['read a line from standard input (bash builtin)', 'read [-r] [-a array] [-d delim] [-p prompt] [name ...]', [['-r', 'do not treat backslashes as escapes'], ['-a ARR', 'read words into an array']], [['while IFS= read -r line; do ...; done < file', 'read a file line by line']]],
  yes: ['output a string repeatedly until killed', 'yes [STRING]...', [], [['yes | head -3', 'y y y']]],
  sleep: ['delay for a specified amount of time', 'sleep NUMBER[SUFFIX]...', [], []],
  env: ['run a program in a modified environment', 'env [OPTION]... [NAME=VALUE]... [COMMAND [ARG]...]', [['-i', 'start with an empty environment'], ['-u NAME', 'remove variable']], []],
  which: ['locate a command', 'which [-a] filename ...', [['-a', 'print all matches']], []],
  type: ['display information about command type (bash builtin)', 'type [-afptP] name [name ...]', [], []],
  man: ['an interface to the system reference manuals', 'man [section] page', [['-k WORD', 'search page descriptions']], []],
};

function render(name) {
  const p = P[name];
  if (!p) return null;
  const [desc, syn, opts, ex] = p;
  const up = name.toUpperCase();
  const header = `${up}(1)`;
  const title = 'User Commands';
  const width = 78;
  const gap = width - header.length * 2 - title.length;
  let s = header + ' '.repeat(Math.max(1, Math.floor(gap / 2))) + title + ' '.repeat(Math.max(1, Math.ceil(gap / 2))) + header + '\n\n';
  s += `NAME\n       ${name} - ${desc}\n\nSYNOPSIS\n       ${syn}\n\n`;
  if (opts.length) {
    s += 'OPTIONS\n';
    for (const [o, d] of opts) s += `       ${o}\n              ${d}\n\n`;
  }
  if (ex.length) {
    s += 'EXAMPLES\n';
    for (const [c, d] of ex) s += `       ${c}\n              ${d}\n\n`;
  }
  s += 'SEE ALSO\n       Try the other ways to solve each challenge once you crack it.\n\n';
  s += `CMDPRO                              2026-10-01                       ${header}\n`;
  return s;
}

// `CMD --help` for commands that don't implement their own (GNU-ish layout, stdout, exit 0)
export function helpText(name) {
  const p = P[name];
  if (!p) return null;
  const [desc, syn, opts, ex] = p;
  let s = `Usage: ${syn}\n${desc[0].toUpperCase()}${desc.slice(1)}.\n`;
  if (opts.length) {
    s += '\n';
    const w = Math.min(24, Math.max(...opts.map(([o]) => o.length)) + 2);
    for (const [o, d] of opts) s += `  ${o.padEnd(w)}${d}\n`;
  }
  if (ex.length) {
    s += '\nExamples:\n';
    for (const [c, d] of ex) s += `  ${c}\n      ${d}\n`;
  }
  return s + `\nFull documentation: man ${name}\n`;
}

// Frosty the snowman keeps telling players to try this. In the game only.
const FROSTY = `FROSTY(6)                     Holiday Games Manual                     FROSTY(6)

NAME
       frosty - a jolly, happy snowman (cool under pressure)

SYNOPSIS
       frosty [--hat] [--carrot] [--two-eyes-made-out-of-coal]

DESCRIPTION
       frosty keeps the North Pole workshop's terminals chilled to a
       comfortable -12 degrees. He runs best in December and is known to
       hibernate (sleep 2592000) every July.

OPTIONS
       --hat  Brings frosty to life. Do not remove while he is running.

BUGS
       Melts above 0 degrees Celsius. Workaround: export WEATHER=snowy.

SEE ALSO
       santa(1), cron(8), reindeer(7)

Jingle Shells                        2026-12-01                        FROSTY(6)
`;

const C = {};
C.man = C.info = (ctx) => {
  const args = ctx.argv.slice(1).filter(a => !/^\d$/.test(a));
  if (args[0] === '-k' || ctx.name === 'apropos') return C.apropos({ ...ctx, argv: ['apropos', ...args.slice(1)] });
  if (args[0] === '-f') return C.whatis({ ...ctx, argv: ['whatis', ...args.slice(1)] });
  if (!args.length) { ctx.stderr.write('What manual page do you want?\nFor example, try \'man man\'.\n'); return 1; }
  let st = 0;
  for (const a of args) {
    if (a === 'frosty' && ctx.sh && ctx.sh.game) { ctx.out(FROSTY); continue; }
    const page = render(a);
    if (!page) { ctx.stderr.write(`No manual entry for ${a}\n`); st = 16; continue; }
    ctx.out(page);
  }
  return st;
};
C.whatis = (ctx) => {
  let st = 0;
  for (const a of ctx.argv.slice(1)) { if (P[a]) ctx.out(`${a.padEnd(15)} (1)  - ${P[a][0]}\n`); else { ctx.out(`${a}: nothing appropriate.\n`); st = 16; } }
  return st;
};
C.apropos = (ctx) => {
  const w = (ctx.argv[1] || '').toLowerCase();
  const hits = Object.keys(P).filter(k => k.includes(w) || P[k][0].toLowerCase().includes(w)).sort();
  if (!hits.length) { ctx.out(`${w}: nothing appropriate.\n`); return 16; }
  ctx.out(hits.map(k => `${k.padEnd(15)} (1)  - ${P[k][0]}\n`).join(''));
  return 0;
};
export const MAN_PAGES = P;
export default C;
