// Markdown-lite renderer → DOM (safe: builds nodes, never injects HTML).
// Supports paragraphs, ``` fences, - / 1. lists, `code`, **bold**, *em*/_em_, [links](url).
import { h } from './dom.js';

const INLINE = /(`+)([\s\S]*?)\1|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>|(^|[\s(\[])_([^_\n]+?)_(?=$|[\s)\].,!?:;])|(^|[\s(\[])\*([^*\n]+?)\*(?=$|[\s)\].,!?:;])/g;

export function inline(text) {
  const out = [];
  let last = 0;
  text = String(text ?? '');
  const re = new RegExp(INLINE.source, 'g'); // local: inline() recurses for **bold**
  let m;
  while ((m = re.exec(text))) {
    let start = m.index;
    const lead = m[7] ?? m[9] ?? '';
    if (start > last || lead) out.push(text.slice(last, start) + lead);
    if (m[1] !== undefined) out.push(h('code', null, m[2].replace(/^ (.*) $/, '$1')));
    else if (m[3] !== undefined) out.push(h('strong', null, ...inline(m[3])));
    else if (m[4] !== undefined) {
      const url = m[5];
      const safe = /^(https?:|mailto:|#|\.\/|[a-z0-9_-]+\.)/i.test(url) ? url : '#';
      out.push(h('a', { href: safe, target: /^https?:/.test(safe) ? '_blank' : null, rel: 'noopener noreferrer' }, m[4]));
    } else if (m[6] !== undefined) out.push(h('a', { href: m[6], target: '_blank', rel: 'noopener noreferrer' }, m[6]));
    else if (m[8] !== undefined) out.push(h('em', null, m[8]));
    else if (m[10] !== undefined) out.push(h('em', null, m[10]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function joinParagraph(lines) {
  // Short "verse" lines keep their breaks; soft-wrapped prose is joined.
  const verse = lines.length > 1 && lines.every(l => l.length < 64);
  if (!verse) return inline(lines.join(' '));
  const out = [];
  lines.forEach((l, i) => { if (i) out.push(h('br')); out.push(...inline(l)); });
  return out;
}

export function md(text, cls = 'md') {
  const root = h('div', { class: cls });
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  let i = 0, para = [];
  const flush = () => { if (para.length) { root.appendChild(h('p', null, ...joinParagraph(para))); para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      root.appendChild(h('pre', null, h('code', null, body.join('\n'))));
      continue;
    }
    const hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) { flush(); root.appendChild(h('h' + Math.min(6, hm[1].length + 1), { class: 'md-h' }, ...inline(hm[2]))); i++; continue; }
    if (/^\s*\|/.test(line)) {
      flush();
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const body = rows.filter((r, k) => !(k === 1 && /^\s*\|[\s:|-]+\|?\s*$/.test(r)));
      const [head, ...rest] = body;
      root.appendChild(h('div', { class: 'md-table-wrap' }, h('table', { class: 'md-table' },
        h('thead', null, h('tr', null, cells(head).map(c => h('th', null, ...inline(c))))),
        h('tbody', null, rest.map(r => h('tr', null, cells(r).map(c => h('td', null, ...inline(c)))))))));
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const list = h(ordered ? 'ol' : 'ul');
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) item += ' ' + lines[i++].trim();
        list.appendChild(h('li', null, ...inline(item)));
      }
      root.appendChild(list);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return root;
}

/** Plain text (strip markdown) — for terminal MOTDs and aria labels. */
export function plain(text) {
  return String(text ?? '').replace(/```[\s\S]*?```/g, m => m.replace(/```/g, '')).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

/**
 * Markdown → terminal segments: [{ t: text, c: className }], lines separated by '\n' text.
 * Inline code is accented, bold is bright, fences are indented + dim.
 */
export function termSegments(text, width = 0) {
  const segs = [];
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  let inFence = false;
  const paras = [];
  let cur = [];
  for (const l of lines) {
    if (/^\s*```/.test(l)) { if (cur.length) { paras.push({ kind: 'p', lines: cur }); cur = []; } inFence = !inFence; if (inFence) paras.push({ kind: 'code', lines: [] }); continue; }
    if (inFence) { paras[paras.length - 1].lines.push(l); continue; }
    if (!l.trim()) { if (cur.length) { paras.push({ kind: 'p', lines: cur }); cur = []; } continue; }
    cur.push(l.trim());
  }
  if (cur.length) paras.push({ kind: 'p', lines: cur });
  paras.forEach((p, pi) => {
    if (pi) segs.push({ t: '\n\n' });
    if (p.kind === 'code') { segs.push({ t: p.lines.map(x => '    ' + x).join('\n'), c: 'ansi-fg-8' }); return; }
    const verse = p.lines.length > 1 && p.lines.every(x => x.length < 64);
    const txt = verse ? p.lines.join('\n') : p.lines.join(' ');
    const re = /(`+)([\s\S]*?)\1|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|\*([^*\s][^*\n]*?)\*|(^|[\s(])_([^_\n]+?)_(?=$|[\s).,!?:;])/g;
    let last = 0, m;
    while ((m = re.exec(txt))) {
      const lead = m[7] || '';
      if (m.index > last || lead) segs.push({ t: txt.slice(last, m.index) + lead });
      if (m[1] !== undefined) segs.push({ t: m[2], c: 'term-code' });
      else if (m[3] !== undefined) segs.push({ t: m[3], c: 'ansi-bold' });
      else if (m[4] !== undefined) segs.push({ t: m[4], c: 'ansi-underline' });
      else if (m[6] !== undefined) segs.push({ t: m[6], c: 'ansi-italic' });
      else segs.push({ t: m[8], c: 'ansi-italic' });
      last = re.lastIndex;
    }
    if (last < txt.length) segs.push({ t: txt.slice(last) });
  });
  return segs;
}
