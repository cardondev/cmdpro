// diff (GNU diffutils style): normal, unified, context(-c), brief, side-by-side, recursive.
import { parseArgs, splitLines } from './util.js';
import { FsError, joinPath, byteCmp } from '../vfs.js';
import { strftime } from '../timefmt.js';

const C = {};

// Myers diff returning edit script as list of [op, aIndex, bIndex] ops: '=', '-', '+'
function myers(a, b, eq) {
  const n = a.length, m = b.length;
  const max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) x = v.get(k + 1) ?? 0;
      else x = (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x], b[y])) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) {
        // backtrack
        const ops = [];
        let cx = n, cy = m;
        for (let dd = d; dd > 0; dd--) {
          const vv = trace[dd];
          const kk = cx - cy;
          let pk;
          if (kk === -dd || (kk !== dd && (vv.get(kk - 1) ?? -1) < (vv.get(kk + 1) ?? -1))) pk = kk + 1; else pk = kk - 1;
          const px = vv.get(pk) ?? 0, py = px - pk;
          while (cx > px && cy > py) { ops.push(['=', cx - 1, cy - 1]); cx--; cy--; }
          if (cx === px) ops.push(['+', cx, cy - 1]); else ops.push(['-', cx - 1, cy]);
          cx = px; cy = py;
        }
        while (cx > 0 && cy > 0) { ops.push(['=', cx - 1, cy - 1]); cx--; cy--; }
        return ops.reverse();
      }
    }
  }
  return [];
}

function hunksFrom(ops) {
  // group consecutive non-'=' ops into change blocks: {a0, a1, b0, b1} (exclusive ends)
  const blocks = [];
  let i = 0;
  let ai = 0, bi = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op[0] === '=') { ai = op[1] + 1; bi = op[2] + 1; i++; continue; }
    const a0 = ai, b0 = bi;
    while (i < ops.length && ops[i][0] !== '=') { if (ops[i][0] === '-') ai++; else bi++; i++; }
    blocks.push({ a0, a1: ai, b0, b1: bi });
  }
  return blocks;
}

function rangeStr(lo, hi) {
  // 1-based inclusive lines lo..hi
  return lo === hi ? String(lo) : `${lo},${hi}`;
}

function fileTime(ctx, path) {
  try { return strftime('%Y-%m-%d %H:%M:%S.000000000 +0000', new Date(ctx.fs.stat(path, ctx.cwd).mtime)); } catch { return strftime('%Y-%m-%d %H:%M:%S.000000000 +0000', new Date(ctx.fs.now())); }
}

C.diff = (ctx) => {
  const a = parseArgs(ctx, {
    short: 'abBcC:dEiNqrsStTuU:wWyx:',
    long: { 'to-file': ['tofile', 'required'], 'from-file': ['fromfile', 'required'], text: 'a', 'ignore-space-change': 'b', 'ignore-blank-lines': 'B', context: ['C', 'optional'], minimal: 'd', 'ignore-case': 'i', 'new-file': 'N', brief: 'q', recursive: 'r', 'report-identical-files': 's', 'expand-tabs': 't', 'initial-tab': 'T', unified: ['U', 'optional'], 'ignore-all-space': 'w', 'side-by-side': 'y', width: ['W', 'required'], exclude: ['x', 'required'], color: ['color', 'optional'], 'suppress-common-lines': 'scl', 'no-dereference': 'nd', label: ['label', 'required'], 'strip-trailing-cr': 'stc', 'ignore-trailing-space': 'Z', normal: 'normal', 'speed-large-files': 'slf', 'left-column': 'lc', 'unidirectional-new-file': 'unf', 'ignore-file-name-case': 'ifnc' },
    usageText: "diff: Try 'diff --help' for more information.\n",
  });
  if (!a) return 2;
  let fmt = 'normal', ctxN = 3;
  for (const [k, v] of a.all) {
    if (k === 'u') { fmt = 'unified'; }
    else if (k === 'U') { fmt = 'unified'; if (v) ctxN = parseInt(v, 10); }
    else if (k === 'c') fmt = 'context';
    else if (k === 'C') { fmt = 'context'; if (v) ctxN = parseInt(v, 10); }
    else if (k === 'y') fmt = 'side';
    else if (k === 'q') fmt = 'brief';
  }
  if (a.has('tofile') || a.has('fromfile')) {
    let st = 0;
    for (const f of a.operands) {
      const pair = a.has('tofile') ? [f, a.get('tofile')] : [a.get('fromfile'), f];
      const sub = { ...ctx, argv: ['diff', ...ctx.argv.slice(1).filter(x => !/^--(to|from)-file/.test(x) && !a.operands.includes(x) && x !== a.get('tofile') && x !== a.get('fromfile')), ...pair] };
      const r = C.diff(sub);
      st = Math.max(st, r);
    }
    return st;
  }
  if (a.operands.length !== 2) { ctx.stderr.write(a.operands.length < 2 ? `diff: missing operand after '${a.operands[0] || 'diff'}'\ndiff: Try 'diff --help' for more information.\n` : `diff: extra operand '${a.operands[2]}'\ndiff: Try 'diff --help' for more information.\n`); return 2; }
  const icase = a.has('i'), ws = a.has('w'), sp = a.has('b'), blank = a.has('B'), trailing = a.has('Z');
  const norm = (l) => {
    let s = l;
    if (a.has('stc')) s = s.replace(/\r$/, '');
    if (ws) s = s.replace(/[ \t]+/g, '');
    else if (sp) s = s.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, '');
    else if (trailing) s = s.replace(/[ \t]+$/, '');
    if (icase) s = s.toLowerCase();
    return s;
  };
  const labels = a.all.filter(([k]) => k === 'label').map(([, v]) => v);
  let status = 0;
  const diffFiles = (p1, p2, d1, d2, header) => {
    const bin = !a.has('a') && (d1.includes('\0') || d2.includes('\0'));
    if (bin) { if (d1 !== d2) { ctx.out(fmt === 'brief' ? `Files ${p1} and ${p2} differ\n` : `Binary files ${p1} and ${p2} differ\n`); return 1; } if (a.has('s')) ctx.out(`Files ${p1} and ${p2} are identical\n`); return 0; }
    const A = splitLines(d1), B = splitLines(d2);
    const aNoNl = d1 !== '' && !d1.endsWith('\n'), bNoNl = d2 !== '' && !d2.endsWith('\n');
    const ops = myers(A, B, (x, y) => norm(x) === norm(y));
    let blocks = hunksFrom(ops);
    if (blank) blocks = blocks.filter(b => !(A.slice(b.a0, b.a1).every(l => l.trim() === '') && B.slice(b.b0, b.b1).every(l => l.trim() === '')));
    // a trailing newline difference counts as a change on the last line
    if (!blocks.length && (aNoNl !== bNoNl) && A.length && B.length) blocks = [{ a0: A.length - 1, a1: A.length, b0: B.length - 1, b1: B.length }];
    if (!blocks.length) { if (a.has('s')) ctx.out(`Files ${p1} and ${p2} are identical\n`); return 0; }
    if (fmt === 'brief') { ctx.out(`Files ${p1} and ${p2} differ\n`); return 1; }
    if (header) ctx.out(header);
    const noNl = '\\ No newline at end of file\n';
    let out = '';
    if (fmt === 'normal') {
      for (const b of blocks) {
        const ar = b.a1 > b.a0 ? rangeStr(b.a0 + 1, b.a1) : String(b.a0);
        const br = b.b1 > b.b0 ? rangeStr(b.b0 + 1, b.b1) : String(b.b0);
        const op = b.a1 === b.a0 ? 'a' : b.b1 === b.b0 ? 'd' : 'c';
        out += `${ar}${op}${br}\n`;
        for (let k = b.a0; k < b.a1; k++) { out += `< ${A[k]}\n`; if (k === A.length - 1 && aNoNl) out += noNl; }
        if (op === 'c') out += '---\n';
        for (let k = b.b0; k < b.b1; k++) { out += `> ${B[k]}\n`; if (k === B.length - 1 && bNoNl) out += noNl; }
      }
    } else if (fmt === 'unified' || fmt === 'context') {
      const l1 = labels[0] || `${p1}\t${fileTime(ctx, p1)}`, l2 = labels[1] || `${p2}\t${fileTime(ctx, p2)}`;
      if (fmt === 'unified') out += `--- ${l1}\n+++ ${l2}\n`; else out += `*** ${l1}\n--- ${l2}\n`;
      // merge blocks into hunks with context
      const hunks = [];
      for (const b of blocks) {
        const last = hunks[hunks.length - 1];
        if (last && b.a0 - last.blocks[last.blocks.length - 1].a1 <= 2 * ctxN) last.blocks.push(b);
        else hunks.push({ blocks: [b] });
      }
      for (const h of hunks) {
        const first = h.blocks[0], lastB = h.blocks[h.blocks.length - 1];
        const as = Math.max(0, first.a0 - ctxN), ae = Math.min(A.length, lastB.a1 + ctxN);
        const bs = Math.max(0, first.b0 - ctxN), be = Math.min(B.length, lastB.b1 + ctxN);
        if (fmt === 'unified') {
          const rs = (s, e) => { const len = e - s; return len === 1 ? String(s + 1) : `${len === 0 ? s : s + 1},${len}`; };
          out += `@@ -${rs(as, ae)} +${rs(bs, be)} @@\n`;
          let ai = as, bi = bs;
          for (const b of h.blocks) {
            while (ai < b.a0) { out += ` ${A[ai]}\n`; if (ai === A.length - 1 && aNoNl) out += noNl; ai++; bi++; }
            for (let k = b.a0; k < b.a1; k++) { out += `-${A[k]}\n`; if (k === A.length - 1 && aNoNl) out += noNl; }
            for (let k = b.b0; k < b.b1; k++) { out += `+${B[k]}\n`; if (k === B.length - 1 && bNoNl) out += noNl; }
            ai = b.a1; bi = b.b1;
          }
          while (ai < ae) { out += ` ${A[ai]}\n`; if (ai === A.length - 1 && aNoNl) out += noNl; ai++; }
        } else {
          out += '***************\n';
          out += `*** ${ae - as > 1 ? `${as + 1},${ae}` : ae} ****\n`;
          if (h.blocks.some(b => b.a1 > b.a0)) {
            let ai = as;
            for (const b of h.blocks) {
              while (ai < b.a0) out += `  ${A[ai++]}\n`;
              for (let k = b.a0; k < b.a1; k++) out += `${b.b1 > b.b0 ? '!' : '-'} ${A[k]}\n`;
              ai = b.a1;
            }
            while (ai < ae) out += `  ${A[ai++]}\n`;
          }
          out += `--- ${be - bs > 1 ? `${bs + 1},${be}` : be} ----\n`;
          if (h.blocks.some(b => b.b1 > b.b0)) {
            let bi = bs;
            for (const b of h.blocks) {
              while (bi < b.b0) out += `  ${B[bi++]}\n`;
              for (let k = b.b0; k < b.b1; k++) out += `${b.a1 > b.a0 ? '!' : '+'} ${B[k]}\n`;
              bi = b.b1;
            }
            while (bi < be) out += `  ${B[bi++]}\n`;
          }
        }
      }
    } else if (fmt === 'side') {
      const W = a.has('W') ? parseInt(a.get('W'), 10) : 130;
      const colW = Math.floor((W - 3) / 2);
      const half = (s) => { const t = s.replace(/\t/g, '        '); return t.length > colW - 1 ? t.slice(0, colW - 1) : t; };
      const scl = a.has('scl');
      let ai = 0, bi = 0;
      const line = (l, mark, r) => {
        const left = half(l ?? '');
        if (r === undefined && mark === ' ') return left + '\n';
        return (left.padEnd(colW + (mark === ' ' ? 0 : 0))) + ` ${mark} `.slice(0) + (r !== undefined ? half(r) : '') + '\n';
      };
      for (const b of blocks) {
        while (ai < b.a0) { if (!scl) out += (half(A[ai]).padEnd(colW + 2) + '  ' + half(B[bi])).replace(/\s+$/, '') + '\n'; ai++; bi++; }
        const na = b.a1 - b.a0, nb = b.b1 - b.b0;
        for (let k = 0; k < Math.max(na, nb); k++) {
          const l = k < na ? A[b.a0 + k] : null, r = k < nb ? B[b.b0 + k] : null;
          if (l !== null && r !== null) out += half(l).padEnd(colW) + '  |  '.slice(1, 4) + ' ' + half(r) + '\n';
          else if (l !== null) out += half(l).padEnd(colW) + ' <\n';
          else out += ' '.repeat(colW) + ' > ' + half(r) + '\n';
        }
        ai = b.a1; bi = b.b1;
      }
      while (ai < A.length) { if (!scl) out += (half(A[ai]).padEnd(colW + 2) + '  ' + half(B[bi] ?? '')).replace(/\s+$/, '') + '\n'; ai++; bi++; }
      void line;
    }
    ctx.out(out);
    return 1;
  };
  const read = (p) => { if (p === '-') return ctx.stdin.readAll(); return ctx.readFile(p); };
  const stat = (p) => { try { return ctx.fs.stat(p, ctx.cwd); } catch { return null; } };
  const [p1, p2] = a.operands;
  const s1 = p1 === '-' ? { type: 'f' } : stat(p1), s2 = p2 === '-' ? { type: 'f' } : stat(p2);
  if ((!s1 || !s2) && !a.has('N')) {
    if (!s1) ctx.stderr.write(`diff: ${p1}: No such file or directory\n`);
    if (!s2) ctx.stderr.write(`diff: ${p2}: No such file or directory\n`);
    return 2;
  }
  const recurse = (d1, d2) => {
    const n1 = new Set(ctx.fs.readdir(d1, ctx.cwd)), n2 = new Set(ctx.fs.readdir(d2, ctx.cwd));
    const all = [...new Set([...n1, ...n2])].sort(byteCmp);
    let st = 0;
    for (const n of all) {
      const q1 = joinPath(d1, n), q2 = joinPath(d2, n);
      if (!n1.has(n)) { if (a.has('N')) { st = Math.max(st, diffFiles(q1, q2, '', read(q2), `diff -r ${q1} ${q2}\n`)); } else { ctx.out(`Only in ${d2}: ${n}\n`); st = 1; } continue; }
      if (!n2.has(n)) { if (a.has('N')) { st = Math.max(st, diffFiles(q1, q2, read(q1), '', `diff -r ${q1} ${q2}\n`)); } else { ctx.out(`Only in ${d1}: ${n}\n`); st = 1; } continue; }
      const t1 = stat(q1), t2 = stat(q2);
      if (t1.type === 'd' && t2.type === 'd') { if (a.has('r')) st = Math.max(st, recurse(q1, q2)); else ctx.out(`Common subdirectories: ${q1} and ${q2}\n`); continue; }
      if (t1.type === 'd' || t2.type === 'd') { ctx.out(`File ${t1.type === 'd' ? q1 : q2} is a directory while file ${t1.type === 'd' ? q2 : q1} is a regular file\n`); st = 1; continue; }
      st = Math.max(st, diffFiles(q1, q2, read(q1), read(q2), fmt === 'brief' ? '' : `diff ${a.has('r') ? '-r ' : ''}${fmt === 'unified' ? '-u ' : ''}${q1} ${q2}\n`));
    }
    return st;
  };
  try {
    if (s1 && s2 && s1.type === 'd' && s2.type === 'd') return recurse(p1, p2);
    let f1 = p1, f2 = p2;
    if (s1 && s1.type === 'd') f1 = joinPath(p1, p2.split('/').pop());
    if (s2 && s2.type === 'd') f2 = joinPath(p2, p1.split('/').pop());
    status = diffFiles(f1, f2, s1 || stat(f1) ? read(f1) : '', s2 || stat(f2) ? read(f2) : '', '');
  } catch (e) {
    if (e instanceof FsError) { ctx.stderr.write(`diff: ${e.path}: ${e.message}\n`); return 2; }
    throw e;
  }
  return status;
};

export default C;
