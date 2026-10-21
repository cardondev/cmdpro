// AST -> bash source (used by `type`, `declare -f`).

export function wordSrc(w) {
  if (!w) return '';
  return w.parts.map(partSrc).join('');
}

function partSrc(p) {
  switch (p.t) {
    case 'lit': return p.v;
    case 'esc': return '\\' + p.v;
    case 'sq': return "'" + p.v + "'";
    case 'ansi': return "$'" + p.v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\t/g, '\\t') + "'";
    case 'dq': return '"' + p.parts.map(x => x.t === 'text' ? x.v.replace(/(["\\$`])/g, '\\$1') : partSrc(x)).join('') + '"';
    case 'text': return p.v;
    case 'tilde': return '~' + p.user;
    case 'param': return paramSrc(p);
    case 'cmd': return p.bq ? '`' + listSrc(p.body, 0).trim() + '`' : '$(' + listSrc(p.body, 0).trim() + ')';
    case 'arith': return '$((' + (p.expr.text ?? '') + '))';
    case 'proc': return p.dir + '(' + listSrc(p.body, 0).trim() + ')';
    case 'badsubst': return p.text;
  }
  return '';
}

function paramSrc(p) {
  const idx = p.index === '@' || p.index === '*' ? `[${p.index}]` : p.index ? `[${p.index.text ?? ''}]` : '';
  if (!p.op && !p.indirect && !idx && /^[A-Za-z_]\w*$|^[0-9@*#?$!_-]$/.test(p.name) && p.name.length === 1 || (!p.op && !p.indirect && !idx && /^[A-Za-z_]\w*$/.test(p.name))) return '$' + p.name;
  let s = '${' + (p.indirect ? '!' : '') + (p.op === 'len' ? '#' : '') + p.name + idx;
  if (p.op && p.op !== 'len') {
    if (p.op === ':') s += ':' + (p.off?.text ?? '') + (p.len ? ':' + p.len.text : '');
    else if (p.op === 'keys') s = '${!' + p.name + idx;
    else if (p.op === 'names') s = '${!' + p.name + (p.star ? '*' : '@');
    else if (p.op === '@') s += '@' + p.arg;
    else s += p.op + wordSrc(p.arg) + (p.arg2 ? '/' + wordSrc(p.arg2) : '');
  }
  return s + '}';
}

function redirSrc(r) {
  const fd = r.fd === null || r.fd === undefined ? '' : typeof r.fd === 'object' ? `{${r.fd.varName}}` : String(r.fd);
  if (r.heredoc) return `${fd}${r.op} ${r.heredoc.quoted ? "'" + r.heredoc.delim + "'" : r.heredoc.delim}`;
  return `${fd}${r.op} ${wordSrc(r.target)}`;
}

const IND = '    ';

export function cmdSrc(n, d) {
  const ind = IND.repeat(d);
  const redirs = n.redirs && n.redirs.length ? ' ' + n.redirs.map(redirSrc).join(' ') : '';
  switch (n.t) {
    case 'simple': {
      const parts = [...n.assigns.map(a => a.name + (a.indexText != null ? `[${a.indexText}]` : '') + (a.append ? '+=' : '=') + (a.array ? '(' + a.array.map(e => (e.keyText !== undefined ? `[${e.keyText}]${e.appendElem ? '+=' : '='}` : '') + wordSrc(e.value)).join(' ') + ')' : wordSrc(a.value))), ...n.words.map(wordSrc), ...(n.redirs || []).map(redirSrc)];
      return parts.join(' ');
    }
    case 'pipe': return (n.negate ? '! ' : '') + n.cmds.map((c, i) => cmdSrc(c, d) + (i < n.cmds.length - 1 ? (n.stderr[i] ? ' |& ' : ' | ') : '')).join('');
    case 'andor': return n.parts.map((p, i) => cmdSrc(p, d) + (i < n.ops.length ? ` ${n.ops[i]} ` : '')).join('');
    case 'group': return '{ \n' + listSrc(n.body, d + 1) + ind + '}' + redirs;
    case 'subshell': return '( ' + listSrc(n.body, d + 1).trim() + ' )' + redirs;
    case 'if': {
      let s = '';
      n.clauses.forEach((c, i) => { s += (i === 0 ? 'if ' : ind + 'elif ') + listSrc(c.cond, 0).trim().replace(/;$/, '') + '; then\n' + listSrc(c.body, d + 1); });
      if (n.else) s += ind + 'else\n' + listSrc(n.else, d + 1);
      return s + ind + 'fi' + redirs;
    }
    case 'while': return (n.until ? 'until ' : 'while ') + listSrc(n.cond, 0).trim().replace(/;$/, '') + '; do\n' + listSrc(n.body, d + 1) + ind + 'done' + redirs;
    case 'for': case 'select': return `${n.t} ${n.var}${n.words ? ' in ' + n.words.map(wordSrc).join(' ') : ''};\n${ind}do\n` + listSrc(n.body, d + 1) + ind + 'done' + redirs;
    case 'cfor': return `for ((${n.init.text ?? ''}; ${n.cond.text ?? ''}; ${n.step.text ?? ''}))\n${ind}do\n` + listSrc(n.body, d + 1) + ind + 'done' + redirs;
    case 'case': return `case ${wordSrc(n.word)} in \n` + n.items.map(it => ind + IND + it.patterns.map(wordSrc).join(' | ') + ')\n' + listSrc(it.body, d + 2) + ind + IND + it.term + '\n').join('') + ind + 'esac' + redirs;
    case 'arith': return '((' + (n.expr.text ?? '') + '))' + redirs;
    case 'cond': return '[[ ' + condSrc(n.expr) + ' ]]' + redirs;
    case 'func': return funcSrc(n, d);
  }
  return '';
}

function condSrc(e) {
  switch (e.t) {
    case 'and': return condSrc(e.l) + ' && ' + condSrc(e.r);
    case 'or': return condSrc(e.l) + ' || ' + condSrc(e.r);
    case 'not': return '! ' + condSrc(e.e);
    case 'word': return wordSrc(e.w);
    case 'unary': return e.op + ' ' + wordSrc(e.w);
    case 'binary': return wordSrc(e.l) + ' ' + e.op + ' ' + wordSrc(e.r);
  }
  return '';
}

export function listSrc(list, d) {
  const ind = IND.repeat(d);
  return list.items.map((it, i) => ind + cmdSrc(it.cmd, d) + (it.bg ? ' &' : (i < list.items.length - 1 ? ';' : '')) + '\n').join('');
}

function funcSrc(n, d) {
  const body = n.body;
  if (body.t === 'group') return `${n.name} () \n{ \n` + listSrc(body.body, d + 1) + '}';
  return `${n.name} () \n` + cmdSrc(body, d);
}

export function deparse(node) { return node.t === 'func' ? funcSrc(node, 0) : cmdSrc(node, 0); }
