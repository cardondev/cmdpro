// Original inline-SVG teaching diagrams for tier briefings.
// Static markup only (no user data); themed through .dg-* classes in screens.css.

const CW = 12; // monospace cell width at 20px in diagram units

function seg(x, y, text, cls, size = 20) {
  const w = text.length * (size * 0.6);
  return `<text x="${x}" y="${y}" class="dg-mono ${cls}" font-size="${size}" textLength="${w}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${esc(text)}</text>`;
}
function esc(t) { return String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function bracket(x1, x2, y, label, ly, cls = 'dg-muted') {
  const mid = (x1 + x2) / 2;
  return `<path class="dg-line" d="M${x1} ${y} v6 H${x2} v-6 M${mid} ${y + 6} V${ly - 14}"/>` +
    `<text x="${mid}" y="${ly}" text-anchor="middle" class="dg-label ${cls}">${esc(label)}</text>`;
}
const ARROW = `<defs><marker id="dg-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="dg-arrowhead"/></marker></defs>`;
function box(x, y, w, hh, text, cls = 'dg-box', tcls = 'dg-mono', size = 14) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="10" class="${cls}"/>` +
    `<text x="${x + w / 2}" y="${y + hh / 2 + size * 0.35}" text-anchor="middle" class="${tcls}" font-size="${size}">${esc(text)}</text>`;
}
function arrow(x1, y1, x2, y2, cls = 'dg-line') { return `<path class="${cls}" d="M${x1} ${y1} L${x2} ${y2}" marker-end="url(#dg-arr)"/>`; }

const D = {
  prompt: () => {
    let x = 30; const y = 74; const parts = [];
    const p = (t, cls) => { parts.push({ x, t, cls }); x += t.length * CW; };
    p('player', 'dg-accent'); p('@', 'dg-text'); p('cmdpro', 'dg-accent'); p(':', 'dg-text'); p('mic_check', 'dg-blue'); p('$', 'dg-text'); p(' ', 'dg-text');
    p('ls', 'dg-yellow'); p(' ', 'dg-text'); p('-la', 'dg-peach'); p(' ', 'dg-text'); p('notes.txt', 'dg-mauve');
    const at = (t) => parts.find(q => q.t === t);
    const span = (t) => [at(t).x, at(t).x + t.length * CW];
    const r = (t) => span(t);
    return `<svg viewBox="0 0 640 200" class="dg" role="img" aria-label="Anatomy of a shell prompt and command">
      <rect x="10" y="40" width="620" height="52" rx="12" class="dg-well"/>
      ${parts.map(q => seg(q.x, y, q.t, q.cls)).join('')}
      ${bracket(...r('player'), 98, 'you', 128)}
      ${bracket(...r('cmdpro'), 98, 'machine', 152)}
      ${bracket(...r('mic_check'), 98, 'where you are', 128, 'dg-blue')}
      ${bracket(...r('$'), 98, 'ready', 176)}
      ${bracket(...r('ls'), 98, 'command', 128, 'dg-yellow')}
      ${bracket(...r('-la'), 98, 'options', 152, 'dg-peach')}
      ${bracket(...r('notes.txt'), 98, 'argument', 128, 'dg-mauve')}
      <text x="320" y="24" text-anchor="middle" class="dg-title">Reading a prompt</text>
    </svg>`;
  },

  'fs-tree': () => {
    const lines = ['/', '├── bin', '├── etc', '├── home', '└── var', '    └── challenges', '        └── mic_check', '            ├── notes.txt', '            └── .secret'];
    const rows = lines.map((l, i) => `<text x="34" y="${54 + i * 22}" class="dg-mono ${i === 6 ? 'dg-accent' : (i > 6 ? 'dg-text' : 'dg-muted')}" font-size="15" xml:space="preserve">${esc(l)}</text>`).join('');
    return `<svg viewBox="0 0 640 270" class="dg" role="img" aria-label="Filesystem tree with the challenge directory highlighted">
      ${ARROW}
      <text x="320" y="24" text-anchor="middle" class="dg-title">The filesystem is a tree</text>
      <rect x="20" y="36" width="270" height="214" rx="12" class="dg-well"/>
      ${rows}
      <rect x="125" y="173" width="92" height="26" rx="6" class="dg-hl"/>
      ${arrow(232, 186, 318, 186)}
      <text x="328" y="182" class="dg-text" font-size="14">you are here</text>
      <text x="328" y="200" class="dg-muted dg-mono" font-size="13">pwd → /var/challenges/mic_check</text>
      <text x="328" y="78" class="dg-label dg-accent">absolute path</text>
      <text x="328" y="98" class="dg-mono dg-text" font-size="13">/var/challenges/mic_check/notes.txt</text>
      <text x="328" y="128" class="dg-label dg-blue">relative path</text>
      <text x="328" y="148" class="dg-mono dg-text" font-size="13">notes.txt   ./notes.txt</text>
      <text x="328" y="236" class="dg-mono dg-muted" font-size="13">.  here    ..  parent    ~  home</text>
    </svg>`;
  },

  'glob-regex': () => `<svg viewBox="0 0 640 250" class="dg" role="img" aria-label="Glob patterns versus regular expressions">
      <text x="320" y="24" text-anchor="middle" class="dg-title">Globs vs regex: same vibe, different rules</text>
      <rect x="16" y="40" width="296" height="196" rx="14" class="dg-box"/>
      <rect x="328" y="40" width="296" height="196" rx="14" class="dg-box"/>
      <text x="164" y="66" text-anchor="middle" class="dg-label dg-accent">GLOB · expanded by the shell</text>
      <text x="476" y="66" text-anchor="middle" class="dg-label dg-mauve">REGEX · read by grep/sed/awk</text>
      ${[['*', 'any characters'], ['?', 'exactly one char'], ['[0-9]', 'one digit'], ['**/', 'any depth (globstar)'], ['*.log', 'access.log  error.log']].map((r, i) => `<text x="36" y="${98 + i * 28}" class="dg-mono dg-accent" font-size="15">${esc(r[0])}</text><text x="120" y="${98 + i * 28}" class="dg-text" font-size="13">${esc(r[1])}</text>`).join('')}
      ${[['.', 'any one character'], ['.*', 'any characters'], ['[0-9]+', 'one or more digits'], ['^  $', 'start / end of line'], ['\\.log$', 'ends with .log']].map((r, i) => `<text x="348" y="${98 + i * 28}" class="dg-mono dg-mauve" font-size="15" xml:space="preserve">${esc(r[0])}</text><text x="440" y="${98 + i * 28}" class="dg-text" font-size="13">${esc(r[1])}</text>`).join('')}
    </svg>`,

  'find-walk': () => {
    const nodes = [[320, 70, '.', 1], [170, 140, 'logs/', 2], [120, 210, 'a.log', 3], [220, 210, 'b.txt', 4], [470, 140, 'old/', 5], [420, 210, 'c.log', 6], [520, 210, '.d.log', 7]];
    const hit = new Set(['a.log', 'c.log', '.d.log']);
    const edges = [[0, 1], [1, 2], [1, 3], [0, 4], [4, 5], [4, 6]];
    return `<svg viewBox="0 0 640 260" class="dg" role="img" aria-label="find walks the directory tree depth-first">
      <text x="320" y="24" text-anchor="middle" class="dg-title">find walks every branch (depth-first)</text>
      <text x="320" y="46" text-anchor="middle" class="dg-mono dg-muted" font-size="13">find . -type f -name '*.log'</text>
      ${edges.map(([a, b]) => `<path class="dg-line" d="M${nodes[a][0]} ${nodes[a][1] + 14} L${nodes[b][0]} ${nodes[b][1] - 14}"/>`).join('')}
      ${nodes.map(([x, y, t, n]) => `<rect x="${x - 46}" y="${y - 16}" width="92" height="32" rx="9" class="${hit.has(t) ? 'dg-box-accent' : 'dg-box'}"/><text x="${x}" y="${y + 5}" text-anchor="middle" class="dg-mono ${hit.has(t) ? 'dg-accent' : 'dg-text'}" font-size="13">${esc(t)}</text><circle cx="${x + 46}" cy="${y - 16}" r="10" class="dg-dot"/><text x="${x + 46}" y="${y - 12}" text-anchor="middle" class="dg-dot-t" font-size="11">${n}</text>`).join('')}
      <text x="320" y="252" text-anchor="middle" class="dg-muted" font-size="12">Unlike *, find also visits hidden files like .d.log</text>
    </svg>`;
  },

  pipes: () => `<svg viewBox="0 0 640 220" class="dg" role="img" aria-label="Three commands connected by pipes">
      ${ARROW}
      <text x="320" y="24" text-anchor="middle" class="dg-title">A pipe connects stdout → stdin</text>
      ${box(20, 92, 160, 50, 'cat access.log')}
      ${box(240, 92, 160, 50, 'grep 500', 'dg-box')}
      ${box(460, 92, 160, 50, 'wc -l', 'dg-box-accent', 'dg-mono dg-accent')}
      ${arrow(180, 117, 236, 117)}${arrow(400, 117, 456, 117)}
      <text x="208" y="108" text-anchor="middle" class="dg-pipe">|</text><text x="428" y="108" text-anchor="middle" class="dg-pipe">|</text>
      <text x="100" y="76" text-anchor="middle" class="dg-muted" font-size="12">1,000 lines</text>
      <text x="320" y="76" text-anchor="middle" class="dg-muted" font-size="12">37 lines</text>
      <text x="540" y="76" text-anchor="middle" class="dg-accent" font-size="12">37</text>
      <text x="320" y="182" text-anchor="middle" class="dg-mono dg-text" font-size="15">cat access.log | grep 500 | wc -l</text>
      <text x="320" y="206" text-anchor="middle" class="dg-muted" font-size="12">Each command does one thing well. Pipes make them a team.</text>
    </svg>`,

  streams: () => `<svg viewBox="0 0 640 250" class="dg" role="img" aria-label="Standard input, output and error streams">
      ${ARROW}
      <text x="320" y="24" text-anchor="middle" class="dg-title">Every command gets three streams</text>
      ${box(250, 96, 140, 64, 'command', 'dg-box-accent', 'dg-mono dg-accent', 16)}
      ${arrow(80, 128, 246, 128)}
      <text x="30" y="110" class="dg-label dg-blue">0 · stdin</text>
      <text x="30" y="150" class="dg-mono dg-muted" font-size="12">keyboard</text>
      <text x="30" y="166" class="dg-mono dg-muted" font-size="12">&lt; file   cmd |</text>
      ${arrow(390, 112, 560, 78)}
      ${arrow(390, 146, 560, 186)}
      <text x="470" y="70" class="dg-label dg-accent">1 · stdout</text>
      <text x="566" y="82" class="dg-mono dg-muted" font-size="12">&gt; file</text>
      <text x="470" y="214" class="dg-label dg-red">2 · stderr</text>
      <text x="566" y="190" class="dg-mono dg-muted" font-size="12">2&gt; err</text>
      <text x="320" y="238" text-anchor="middle" class="dg-mono dg-text" font-size="13">cmd &gt; out.txt 2&gt;&amp;1   ← both streams into one file</text>
    </svg>`,

  'find-exec': () => `<svg viewBox="0 0 640 240" class="dg" role="img" aria-label="find -exec with semicolon versus plus">
      ${ARROW}
      <text x="320" y="24" text-anchor="middle" class="dg-title">find -exec: one at a time, or all at once</text>
      ${box(20, 96, 130, 48, 'find . -name …')}
      ${['a.log', 'b.log', 'c.log'].map((f, i) => `<text x="185" y="${92 + i * 26}" class="dg-mono dg-accent" font-size="13">${f}</text>`).join('')}
      ${arrow(150, 108, 260, 72)}${arrow(150, 132, 260, 176)}
      <text x="270" y="56" class="dg-mono dg-text" font-size="13">-exec rm {} \\;</text>
      ${[0, 1, 2].map(i => `<rect x="${270 + i * 112}" y="66" width="100" height="30" rx="8" class="dg-box"/><text x="${320 + i * 112}" y="86" text-anchor="middle" class="dg-mono dg-text" font-size="12">rm ${'abc'[i]}.log</text>`).join('')}
      <text x="610" y="86" class="dg-muted" font-size="11">3 runs</text>
      <text x="270" y="164" class="dg-mono dg-text" font-size="13">-exec rm {} +     (or | xargs rm)</text>
      <rect x="270" y="174" width="324" height="30" rx="8" class="dg-box-accent"/><text x="432" y="194" text-anchor="middle" class="dg-mono dg-accent" font-size="12">rm a.log b.log c.log</text>
      <text x="610" y="194" class="dg-muted" font-size="11">1 run</text>
    </svg>`,

  chmod: () => {
    const chars = ['-', 'r', 'w', 'x', 'r', '-', 'x', 'r', '-', '-'];
    const x0 = 150;
    return `<svg viewBox="0 0 640 230" class="dg" role="img" aria-label="Unix permission bits explained">
      <text x="320" y="24" text-anchor="middle" class="dg-title">Permissions: who can read, write, execute</text>
      ${chars.map((c, i) => `<text x="${x0 + i * 34}" y="84" text-anchor="middle" class="dg-mono ${i === 0 ? 'dg-muted' : i < 4 ? 'dg-accent' : i < 7 ? 'dg-blue' : 'dg-peach'}" font-size="30">${c}</text>`).join('')}
      ${bracket(x0 - 10, x0 + 10, 98, 'type', 132)}
      ${bracket(x0 + 24, x0 + 112, 98, 'user  rwx = 7', 132, 'dg-accent')}
      ${bracket(x0 + 126, x0 + 214, 98, 'group  r-x = 5', 158, 'dg-blue')}
      ${bracket(x0 + 228, x0 + 316, 98, 'other  r-- = 4', 132, 'dg-peach')}
      <text x="320" y="190" text-anchor="middle" class="dg-mono dg-text" font-size="14">r=4  w=2  x=1    →    chmod 754 file    chmod u+x run.sh</text>
      <text x="320" y="214" text-anchor="middle" class="dg-muted" font-size="12">A script needs x before ./script.sh will run it.</text>
    </svg>`;
  },

  awk: () => `<svg viewBox="0 0 640 240" class="dg" role="img" aria-label="awk splits records into fields">
      <text x="320" y="24" text-anchor="middle" class="dg-title">awk sees records (lines) made of fields</text>
      <text x="40" y="66" class="dg-mono dg-muted" font-size="13">NR=3 ▸</text>
      ${[['alice', '$1'], ['admin', '$2'], ['42', '$3 = $NF']].map((f, i) => `<rect x="${110 + i * 170}" y="44" width="150" height="36" rx="9" class="${i === 2 ? 'dg-box-accent' : 'dg-box'}"/><text x="${185 + i * 170}" y="68" text-anchor="middle" class="dg-mono ${i === 2 ? 'dg-accent' : 'dg-text'}" font-size="16">${f[0]}</text><text x="${185 + i * 170}" y="102" text-anchor="middle" class="dg-label dg-blue">${f[1]}</text>`).join('')}
      <text x="267" y="68" text-anchor="middle" class="dg-mono dg-peach" font-size="16">,</text><text x="437" y="68" text-anchor="middle" class="dg-mono dg-peach" font-size="16">,</text>
      <text x="320" y="132" text-anchor="middle" class="dg-muted" font-size="12">$0 = whole line · NF = 3 fields · -F, sets the separator</text>
      <rect x="40" y="150" width="560" height="44" rx="10" class="dg-well"/>
      <text x="320" y="178" text-anchor="middle" class="dg-mono dg-text" font-size="15">awk -F, '$3 &gt; 40 { print $1 }' users.csv</text>
      <text x="320" y="220" text-anchor="middle" class="dg-muted" font-size="12">pattern { action } — runs the action on every line where the pattern is true</text>
    </svg>`,

  procsub: () => `<svg viewBox="0 0 640 240" class="dg" role="img" aria-label="Process substitution feeding comm">
      ${ARROW}
      <text x="320" y="24" text-anchor="middle" class="dg-title">&lt;(cmd) turns output into a file name</text>
      ${box(20, 50, 170, 44, 'sort a.txt')}
      ${box(20, 140, 170, 44, 'sort b.txt')}
      ${arrow(190, 72, 300, 100)}${arrow(190, 162, 300, 134)}
      <text x="214" y="70" class="dg-mono dg-muted" font-size="11">/dev/fd/63</text>
      <text x="214" y="180" class="dg-mono dg-muted" font-size="11">/dev/fd/62</text>
      ${box(304, 92, 140, 50, 'comm -12', 'dg-box-accent', 'dg-mono dg-accent', 15)}
      ${arrow(444, 117, 520, 117)}
      <text x="528" y="113" class="dg-text" font-size="13">lines in</text><text x="528" y="131" class="dg-text" font-size="13">both files</text>
      <text x="320" y="222" text-anchor="middle" class="dg-mono dg-text" font-size="13">comm -12 &lt;(sort a.txt) &lt;(sort b.txt)</text>
    </svg>`,

  regex: () => {
    const parts = [['^', 'dg-red', 'start'], ['[0-9]', 'dg-accent', 'digit'], ['{1,3}', 'dg-blue', '1 to 3 times'], ['(', 'dg-mauve', ''], ['\\.', 'dg-peach', 'a literal dot'], ['[0-9]{1,3}', 'dg-accent', ''], [')', 'dg-mauve', ''], ['{3}', 'dg-blue', 'group ×3'], ['$', 'dg-red', 'end']];
    let x = 70; const pos = [];
    for (const p of parts) { pos.push(x); x += p[0].length * 13.2; }
    return `<svg viewBox="0 0 640 220" class="dg" role="img" aria-label="Anatomy of an IPv4 regular expression">
      <text x="320" y="24" text-anchor="middle" class="dg-title">Reading a regex (an IPv4-ish address)</text>
      <rect x="40" y="46" width="560" height="48" rx="12" class="dg-well"/>
      ${parts.map((p, i) => seg(pos[i], 79, p[0], 'dg-mono ' + p[1], 22)).join('')}
      ${parts.map((p, i) => p[2] ? `<text x="${pos[i] + p[0].length * 6.6}" y="${i % 2 ? 150 : 124}" text-anchor="middle" class="dg-label ${p[1]}">${esc(p[2])}</text><path class="dg-line" d="M${pos[i] + p[0].length * 6.6} 96 V${i % 2 ? 136 : 110}"/>` : '').join('')}
      <text x="320" y="196" text-anchor="middle" class="dg-mono dg-text" font-size="13">grep -E '^[0-9]{1,3}(\\.[0-9]{1,3}){3}$'</text>
    </svg>`;
  },

  symlink: () => `<svg viewBox="0 0 640 220" class="dg" role="img" aria-label="A symbolic link points at a target path">
      ${ARROW}
      <text x="320" y="24" text-anchor="middle" class="dg-title">A symlink is a signpost, not a copy</text>
      ${box(40, 70, 190, 50, 'shortcut ⤳', 'dg-box-accent', 'dg-mono dg-accent', 15)}
      ${box(410, 70, 190, 50, 'tmp/files/real.txt')}
      <path class="dg-line dg-dash" d="M232 95 L404 95" marker-end="url(#dg-arr)"/>
      <text x="318" y="86" text-anchor="middle" class="dg-muted" font-size="12">points to</text>
      <text x="320" y="160" text-anchor="middle" class="dg-mono dg-text" font-size="14">ln -s tmp/files/real.txt shortcut</text>
      <text x="320" y="186" text-anchor="middle" class="dg-mono dg-muted" font-size="13">readlink shortcut   →   tmp/files/real.txt</text>
      <text x="320" y="208" text-anchor="middle" class="dg-muted" font-size="12">Delete the target and the link dangles. Relative targets resolve from the link's folder.</text>
    </svg>`,

  toolbox: () => {
    const tools = ['find', 'grep', 'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'xargs', 'jq', 'paste', 'comm'];
    return `<svg viewBox="0 0 640 230" class="dg" role="img" aria-label="The command line toolbox">
      <text x="320" y="24" text-anchor="middle" class="dg-title">Small tools, infinite combos</text>
      ${tools.map((t, i) => { const c = i % 6, r = Math.floor(i / 6); const x = 40 + c * 96, y = 54 + r * 64; return `<rect x="${x}" y="${y}" width="80" height="40" rx="20" class="${(i * 7) % 5 === 0 ? 'dg-box-accent' : 'dg-box'}"/><text x="${x + 40}" y="${y + 25}" text-anchor="middle" class="dg-mono ${(i * 7) % 5 === 0 ? 'dg-accent' : 'dg-text'}" font-size="14">${t}</text>`; }).join('')}
      <text x="320" y="196" text-anchor="middle" class="dg-mono dg-text" font-size="13">find . -name '*.log' | xargs grep -h 500 | awk '{print $1}' | sort | uniq -c | sort -rn</text>
      <text x="320" y="218" text-anchor="middle" class="dg-muted" font-size="12">The Unix philosophy: do one thing well, then pipe it.</text>
    </svg>`;
  },

  turing: () => `<svg viewBox="0 0 640 250" class="dg" role="img" aria-label="A silly flowchart asking if you are human">
      ${ARROW}
      <text x="320" y="24" text-anchor="middle" class="dg-title">Certificate Authority decision process</text>
      ${box(20, 46, 180, 46, 'Solved all 5?', 'dg-box', 'dg-text', 14)}
      ${box(240, 46, 160, 46, 'Pasted?', 'dg-box', 'dg-text', 14)}
      ${box(440, 46, 180, 46, 'Has a pulse?', 'dg-box', 'dg-text', 14)}
      ${arrow(200, 69, 236, 69)}${arrow(400, 69, 436, 69)}
      <text x="218" y="62" text-anchor="middle" class="dg-label dg-accent">yes</text><text x="418" y="62" text-anchor="middle" class="dg-label dg-accent">no</text>
      ${arrow(530, 92, 530, 140)}
      <text x="544" y="122" class="dg-label dg-muted">unclear</text>
      ${box(410, 144, 220, 56, 'Certificate: Machine', 'dg-box-accent', 'dg-mono dg-accent', 16)}
      ${arrow(320, 92, 320, 150)}
      <text x="334" y="122" class="dg-label dg-red">yes</text>
      ${box(220, 154, 170, 46, 'Nice try.', 'dg-box', 'dg-red', 14)}
      <text x="320" y="234" text-anchor="middle" class="dg-muted" font-size="12">The investigation is ongoing. Please do not unplug the candidate.</text>
    </svg>`,
};

export function diagram(id) {
  const fn = D[id];
  if (!fn) return null;
  const wrap = document.createElement('div');
  wrap.className = 'diagram';
  wrap.innerHTML = fn();
  return wrap;
}

export const DIAGRAM_IDS = Object.keys(D);
