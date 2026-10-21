// jq 1.6 compiler, ported from compile.c, bytecode.c and locfile.c.
//
// Instructions form doubly linked lists ("blocks" = {first, last}); the parser builds them
// bottom-up, binding resolves names, and compile() lays out the 16-bit bytecode exactly like jq
// (one array element per uint16 unit), so jump offsets and the tail-call analysis carry over.
import { kind, K_STRING, K_NUMBER, K_OBJECT, isValid, INVALID, objectSet, dumpTrunc, typeName, decodeUtf8 } from './jqjv.js';

export const OP = {
  LOADK: 0, DUP: 1, DUPN: 2, DUP2: 3, PUSHK_UNDER: 4, POP: 5, LOADV: 6, LOADVN: 7, STOREV: 8,
  STORE_GLOBAL: 9, INDEX: 10, INDEX_OPT: 11, EACH: 12, EACH_OPT: 13, FORK: 14, FORK_OPT: 15,
  JUMP: 16, JUMP_F: 17, BACKTRACK: 18, APPEND: 19, INSERT: 20, RANGE: 21, SUBEXP_BEGIN: 22,
  SUBEXP_END: 23, PATH_BEGIN: 24, PATH_END: 25, CALL_BUILTIN: 26, CALL_JQ: 27, RET: 28,
  TAIL_CALL_JQ: 29, CLOSURE_PARAM: 30, CLOSURE_REF: 31, CLOSURE_CREATE: 32, CLOSURE_CREATE_C: 33,
  TOP: 34, CLOSURE_PARAM_REGULAR: 35, DEPS: 36, MODULEMETA: 37, GENLABEL: 38, DESTRUCTURE_ALT: 39,
  STOREVN: 40,
};
export const NUM_OPCODES = 41;
export const HAS_CONSTANT = 2, HAS_VARIABLE = 4, HAS_BRANCH = 8, HAS_CFUNC = 32, HAS_UFUNC = 64,
  IS_CALL_PSEUDO = 128, HAS_BINDING = 1024, BIND_WILDCARD = 2048;
export const ARG_NEWCLOSURE = 0x1000;

const IMM = {
  NONE: [0, 1], CONSTANT: [HAS_CONSTANT, 2], VARIABLE: [HAS_VARIABLE | HAS_BINDING, 3],
  GLOBAL: [HAS_CONSTANT | HAS_VARIABLE | HAS_BINDING | IS_CALL_PSEUDO, 4], BRANCH: [HAS_BRANCH, 2],
  CFUNC: [HAS_CFUNC | HAS_BINDING, 3], UFUNC: [HAS_UFUNC | HAS_BINDING | IS_CALL_PSEUDO, 4],
  DEFINITION: [IS_CALL_PSEUDO | HAS_BINDING, 0], CLOSURE_REF_IMM: [IS_CALL_PSEUDO | HAS_BINDING, 2],
};
const OPLIST = [
  ['LOADK', 'CONSTANT', 1, 1], ['DUP', 'NONE', 1, 2], ['DUPN', 'NONE', 1, 2], ['DUP2', 'NONE', 2, 3],
  ['PUSHK_UNDER', 'CONSTANT', 1, 2], ['POP', 'NONE', 1, 0], ['LOADV', 'VARIABLE', 1, 1],
  ['LOADVN', 'VARIABLE', 1, 1], ['STOREV', 'VARIABLE', 1, 0], ['STORE_GLOBAL', 'GLOBAL', 0, 0],
  ['INDEX', 'NONE', 2, 1], ['INDEX_OPT', 'NONE', 2, 1], ['EACH', 'NONE', 1, 1], ['EACH_OPT', 'NONE', 1, 1],
  ['FORK', 'BRANCH', 0, 0], ['FORK_OPT', 'BRANCH', 0, 0], ['JUMP', 'BRANCH', 0, 0], ['JUMP_F', 'BRANCH', 1, 0],
  ['BACKTRACK', 'NONE', 0, 0], ['APPEND', 'VARIABLE', 1, 0], ['INSERT', 'NONE', 4, 2], ['RANGE', 'VARIABLE', 1, 1],
  ['SUBEXP_BEGIN', 'NONE', 1, 2], ['SUBEXP_END', 'NONE', 2, 2], ['PATH_BEGIN', 'NONE', 1, 2], ['PATH_END', 'NONE', 2, 1],
  ['CALL_BUILTIN', 'CFUNC', -1, 1], ['CALL_JQ', 'UFUNC', 1, 1], ['RET', 'NONE', 1, 1], ['TAIL_CALL_JQ', 'UFUNC', 1, 1],
  ['CLOSURE_PARAM', 'DEFINITION', 0, 0], ['CLOSURE_REF', 'CLOSURE_REF_IMM', 0, 0], ['CLOSURE_CREATE', 'DEFINITION', 0, 0],
  ['CLOSURE_CREATE_C', 'DEFINITION', 0, 0], ['TOP', 'NONE', 0, 0], ['CLOSURE_PARAM_REGULAR', 'DEFINITION', 0, 0],
  ['DEPS', 'CONSTANT', 0, 0], ['MODULEMETA', 'CONSTANT', 0, 0], ['GENLABEL', 'NONE', 0, 1],
  ['DESTRUCTURE_ALT', 'BRANCH', 0, 0], ['STOREVN', 'VARIABLE', 1, 0],
];
export const DESC = OPLIST.map(([name, imm, sin, sout], op) => ({ op, name, flags: IMM[imm][0], length: IMM[imm][1], stackIn: sin, stackOut: sout }));
const flagsOf = (op) => DESC[op].flags;

export function opLength(code, pc) {
  let length = DESC[code[pc]].length;
  if (code[pc] === OP.CALL_JQ || code[pc] === OP.TAIL_CALL_JQ) length += code[pc + 1] * 2;
  return length;
}

// ---------------------------------------------------------------- locfile.c

export const UNKNOWN_LOCATION = Object.freeze({ start: -1, end: -1 });

export class Locfile {
  // data: the source as a byte string
  constructor(jq, fname, data) {
    this.jq = jq;
    this.fname = fname;
    this.data = data;
    this.length = data.length;
    this.linemap = [0];
    for (let i = 0; i < data.length; i++) if (data.charCodeAt(i) === 10) this.linemap.push(i + 1);
    this.nlines = this.linemap.length;
    this.linemap.push(data.length + 1);
  }
  getLine(pos) {
    let line = 1;
    while (this.linemap[line] <= pos) line++;
    return line - 1;
  }
  lineLength(line) { return this.linemap[line + 1] - this.linemap[line] - 1; }
  // locfile_locate: msg is a JS string; the source line is quoted as raw bytes
  locate(loc, msg) {
    if (loc.start === -1) {
      this.jq.reportError(`jq: error: ${msg}\n<unknown location>`);
      return;
    }
    const startline = this.getLine(loc.start);
    const offset = this.linemap[startline];
    const text = decodeUtf8(this.data, offset, offset + this.lineLength(startline));
    this.jq.reportError(`${msg} at ${this.fname}, line ${startline + 1}:\n${text}${' '.repeat(loc.start - offset)}`);
  }
}

// ---------------------------------------------------------------- instructions and blocks

class Inst {
  constructor(op) {
    this.next = null;
    this.prev = null;
    this.op = op;
    this.intval = 0;
    this.target = null;
    this.constant = undefined;
    this.cfunc = null;
    this.locfile = null;
    this.source = UNKNOWN_LOCATION;
    this.boundBy = null;
    this.symbol = null;
    this.nformals = -1;
    this.nactuals = -1;
    this.subfn = gen_noop();
    this.arglist = gen_noop();
    this.compiled = null;
    this.bytecodePos = -1;
  }
}

const instBlock = (i) => ({ first: i, last: i });
export function gen_noop() { return { first: null, last: null }; }
export const block_is_noop = (b) => b.first === null && b.last === null;
export const block_is_single = (b) => b.first !== null && b.first === b.last;

function block_take(b) {
  if (b.first === null) return null;
  const i = b.first;
  if (i.next) {
    i.next.prev = null;
    b.first = i.next;
    i.next = null;
  } else {
    b.first = null;
    b.last = null;
  }
  return i;
}

export function gen_location(loc, l, b) {
  for (let i = b.first; i; i = i.next) {
    if (i.source.start === -1 && i.source.end === -1) {
      i.source = loc;
      i.locfile = l;
    }
  }
  return b;
}

export function gen_op_simple(op) { return instBlock(new Inst(op)); }

export function gen_const(constant) {
  const i = new Inst(OP.LOADK);
  i.constant = constant;
  return instBlock(i);
}

export function gen_const_global(constant, name) {
  const i = new Inst(OP.STORE_GLOBAL);
  i.constant = constant;
  i.symbol = name;
  return instBlock(i);
}

function gen_op_pushk_under(constant) {
  const i = new Inst(OP.PUSHK_UNDER);
  i.constant = constant;
  return instBlock(i);
}

export const block_is_const = (b) => block_is_single(b) && (b.first.op === OP.LOADK || b.first.op === OP.PUSHK_UNDER);
export const block_is_const_inf = (b) => block_is_single(b) && b.first.op === OP.LOADK &&
  typeof b.first.constant === 'number' && (b.first.constant === Infinity || b.first.constant === -Infinity);
export const block_const_kind = (b) => kind(b.first.constant);
export const block_const = (b) => b.first.constant;

export function gen_op_target(op, target) {
  const i = new Inst(op);
  i.target = target.last;
  return instBlock(i);
}
function gen_op_targetlater(op) {
  const i = new Inst(op);
  i.target = null;
  return instBlock(i);
}
function inst_set_target(b, target) { b.first.target = target.last; }

export function gen_op_unbound(op, name) {
  const i = new Inst(op);
  i.symbol = name;
  return instBlock(i);
}
export function gen_op_var_fresh(op, name) {
  return block_bind(gen_op_unbound(op, name), gen_noop(), HAS_VARIABLE);
}
export function gen_op_bound(op, binder) {
  const b = gen_op_unbound(op, binder.first.symbol);
  b.first.boundBy = binder.first;
  return b;
}

export function gen_dictpair(k, v) {
  return BLOCK(gen_subexp(k), gen_subexp(v), gen_op_simple(OP.INSERT));
}

function block_append(b, b2) {
  if (b2.first) {
    if (b.last) {
      b.last.next = b2.first;
      b2.first.prev = b.last;
    } else b.first = b2.first;
    b.last = b2.last;
  }
}
export function block_join(a, b) {
  const c = { first: a.first, last: a.last };
  block_append(c, b);
  return c;
}
export function BLOCK(...bs) {
  const c = { first: null, last: null };
  for (const b of bs) block_append(c, b);
  return c;
}

export function block_has_only_binders_and_imports(binders, bindflags) {
  bindflags |= HAS_BINDING;
  for (let c = binders.first; c; c = c.next) {
    if ((flagsOf(c.op) & bindflags) !== bindflags && c.op !== OP.DEPS && c.op !== OP.MODULEMETA) return false;
  }
  return true;
}

function block_count_formals(b) {
  let args = 0;
  if (b.first.op === OP.CLOSURE_CREATE_C) return b.first.cfunc.nargs - 1;
  for (let i = b.first.arglist.first; i; i = i.next) args++;
  return args;
}

function block_count_actuals(b) {
  let args = 0;
  for (let i = b.first; i; i = i.next) {
    if (i.op === OP.CLOSURE_CREATE || i.op === OP.CLOSURE_PARAM || i.op === OP.CLOSURE_CREATE_C) args++;
  }
  return args;
}

function block_count_refs(binder, body) {
  let nrefs = 0;
  for (let i = body.first; i; i = i.next) {
    if (i !== binder.first && i.boundBy === binder.first) nrefs++;
    nrefs += block_count_refs(binder, i.subfn);
    nrefs += block_count_refs(binder, i.arglist);
  }
  return nrefs;
}

function block_bind_subblock(binder, body, bindflags, breakDistance) {
  const bf = binder.first;
  bf.boundBy = bf;
  if (bf.nformals === -1) bf.nformals = block_count_formals(binder);
  let nrefs = 0;
  const want = bindflags & ~BIND_WILDCARD;
  for (let i = body.first; i; i = i.next) {
    const flags = flagsOf(i.op);
    if ((flags & bindflags) === want && i.boundBy === null &&
        (i.symbol === bf.symbol ||
         ((bindflags & BIND_WILDCARD) && i.symbol[0] === '*' && breakDistance <= 3 &&
          i.symbol.length === 2 && i.symbol.charCodeAt(1) === 49 + breakDistance))) {
      if (i.op === OP.CALL_JQ && i.nactuals === -1) i.nactuals = block_count_actuals(i.arglist);
      if (i.nactuals === -1 || i.nactuals === bf.nformals) {
        i.boundBy = bf;
        nrefs++;
      }
    } else if ((flags & bindflags) === want && i.boundBy !== null &&
               bf.symbol.startsWith('*anonlabel') && i.symbol.startsWith('*anonlabel')) {
      breakDistance++;
    }
    nrefs += block_bind_subblock(binder, i.subfn, bindflags, breakDistance);
    nrefs += block_bind_subblock(binder, i.arglist, bindflags, breakDistance);
  }
  return nrefs;
}

function block_bind_each(binder, body, bindflags) {
  bindflags |= HAS_BINDING;
  let nrefs = 0;
  for (let c = binder.first; c; c = c.next) nrefs += block_bind_subblock(instBlock(c), body, bindflags, 0);
  return nrefs;
}

export function block_bind(binder, body, bindflags) {
  block_bind_each(binder, body, bindflags);
  return block_join(binder, body);
}

export function block_bind_library(binder, body, bindflags, libname) {
  bindflags |= HAS_BINDING;
  const matchname = libname ? libname + '::' : '';
  for (let c = binder.first; c; c = c.next) {
    let bindflags2 = bindflags;
    const cname = c.symbol;
    if (flagsOf(c.op) & (HAS_VARIABLE | HAS_CONSTANT)) bindflags2 = HAS_VARIABLE | HAS_BINDING;
    c.symbol = matchname + cname;
    block_bind_subblock(instBlock(c), body, bindflags2, 0);
    c.symbol = cname;
  }
  return body;
}

export function block_bind_referenced(binder, body, bindflags) {
  bindflags |= HAS_BINDING;
  let refd = gen_noop();
  let unrefd = gen_noop();
  binder = { first: binder.first, last: binder.last };
  for (let lastKept = 0, kept = 0; ;) {
    for (let curr; (curr = block_take(binder));) {
      const b = instBlock(curr);
      let nrefs = block_bind_each(b, body, bindflags);
      nrefs += block_count_refs(b, refd);
      nrefs += block_count_refs(b, body);
      if (nrefs) { refd = BLOCK(refd, b); kept++; }
      else unrefd = BLOCK(unrefd, b);
    }
    if (kept === lastKept) break;
    lastKept = kept;
    binder = unrefd;
    unrefd = gen_noop();
  }
  return block_join(refd, body);
}

// jq repeatedly drops top-level definitions nothing else refers to. Which dead definitions get
// compiled is unobservable, so this keeps exactly the ones reachable from the main program (in
// their original order) with one linear pass instead of jq's quadratic loop.
export function block_drop_unreferenced(body) {
  const defs = [];
  let topInst = null;
  for (let i = body.first; i; i = i.next) {
    if (i.op === OP.TOP) { topInst = i; break; }
    defs.push(i);
  }
  const index = new Map(defs.map((d, k) => [d, k]));
  const refsOf = (insts, out) => {
    const stack = [...insts];
    while (stack.length) {
      const i = stack.pop();
      if (i.boundBy && index.has(i.boundBy) && i.boundBy !== i) out.add(index.get(i.boundBy));
      for (let s = i.subfn.first; s; s = s.next) stack.push(s);
      for (let s = i.arglist.first; s; s = s.next) stack.push(s);
    }
    return out;
  };
  const live = new Set();
  const work = [];
  const rootInsts = [];
  for (let i = topInst; i; i = i.next) rootInsts.push(i);
  for (const k of refsOf(rootInsts, new Set())) { live.add(k); work.push(k); }
  while (work.length) {
    const k = work.pop();
    const d = defs[k];
    for (const r of refsOf([...listOf(d.subfn), ...listOf(d.arglist)], new Set())) {
      if (!live.has(r)) { live.add(r); work.push(r); }
    }
  }
  let out = gen_noop();
  for (let k = 0; k < defs.length; k++) {
    const d = defs[k];
    d.next = d.prev = null;
    if (live.has(k)) out = BLOCK(out, instBlock(d));
  }
  if (topInst) {
    topInst.prev = null;
    let last = topInst;
    while (last.next) last = last.next;
    out = BLOCK(out, { first: topInst, last });
  }
  return out;
}
const listOf = (b) => { const a = []; for (let i = b.first; i; i = i.next) a.push(i); return a; };

// deep copy of a block (instructions, nested bodies and argument lists), with bindings and
// branch targets that point inside it remapped to the copies
export function cloneBlock(b) {
  const map = new Map();
  const copyList = (blk) => {
    let first = null, last = null;
    for (let i = blk.first; i; i = i.next) {
      const c = Object.assign(Object.create(Inst.prototype), i);
      c.next = null;
      c.prev = last;
      if (last) last.next = c; else first = c;
      last = c;
      map.set(i, c);
      c.subfn = copyList(i.subfn);
      c.arglist = copyList(i.arglist);
    }
    return { first, last };
  };
  const res = copyList(b);
  for (const c of map.values()) {
    if (c.boundBy && map.has(c.boundBy)) c.boundBy = map.get(c.boundBy);
    if (c.target && map.has(c.target)) c.target = map.get(c.target);
  }
  return res;
}

export function block_take_imports(body) {
  const imports = [];
  let top = null;
  if (body.first && body.first.op === OP.TOP) top = block_take(body);
  while (body.first && (body.first.op === OP.MODULEMETA || body.first.op === OP.DEPS)) {
    const dep = block_take(body);
    if (dep.op === OP.DEPS) imports.push(dep.constant);
  }
  if (top) {
    const j = block_join(instBlock(top), body);
    body.first = j.first;
    body.last = j.last;
  }
  return imports;
}

export function block_list_funcs(body, omitUnderscores) {
  const funcs = new Map();
  for (let pos = body.first; pos; pos = pos.next) {
    if (pos.op === OP.CLOSURE_CREATE || pos.op === OP.CLOSURE_CREATE_C) {
      if (pos.symbol !== null && (!omitUnderscores || pos.symbol[0] !== '_')) funcs.set(`${pos.symbol}/${pos.nformals}`, null);
    }
  }
  return [...funcs.keys()];
}

export function gen_module(metadata) {
  const i = new Inst(OP.MODULEMETA);
  i.constant = block_const(metadata);
  if (kind(i.constant) !== K_OBJECT) i.constant = new Map([['metadata', i.constant]]);
  return instBlock(i);
}

export function block_module_meta(b) {
  if (b.first !== null && b.first.op === OP.MODULEMETA) return b.first.constant;
  return null;
}

export function gen_import(name, as, isData) {
  const i = new Inst(OP.DEPS);
  let meta = new Map();
  if (as !== null) meta.set('as', as);
  meta.set('is_data', !!isData);
  meta.set('relpath', name);
  i.constant = meta;
  return instBlock(i);
}

export function gen_import_meta(imp, metadata) {
  const i = imp.first;
  const m = new Map(block_const(metadata));
  for (const [k, v] of i.constant) m.set(k, v);
  i.constant = m;
  return imp;
}

export function gen_function(name, formals, body) {
  const i = new Inst(OP.CLOSURE_CREATE);
  for (let f = formals.last; f; f = f.prev) {
    if (f.op === OP.CLOSURE_PARAM_REGULAR) {
      f.op = OP.CLOSURE_PARAM;
      body = gen_var_binding(gen_call(f.symbol, gen_noop()), f.symbol, body);
    }
    block_bind_subblock(instBlock(f), body, IS_CALL_PSEUDO | HAS_BINDING, 0);
  }
  i.subfn = body;
  i.symbol = name;
  i.arglist = formals;
  const b = instBlock(i);
  block_bind_subblock(b, b, IS_CALL_PSEUDO | HAS_BINDING, 0);
  return b;
}

export const gen_param_regular = (name) => gen_op_unbound(OP.CLOSURE_PARAM_REGULAR, name);
export const gen_param = (name) => gen_op_unbound(OP.CLOSURE_PARAM, name);
export const gen_lambda = (body) => gen_function('@lambda', gen_noop(), body);

export function gen_call(name, args) {
  const b = gen_op_unbound(OP.CALL_JQ, name);
  b.first.arglist = args;
  return b;
}

export function gen_subexp(a) {
  if (block_is_noop(a)) return gen_op_simple(OP.DUP);
  if (block_is_single(a) && a.first.op === OP.LOADK) return gen_op_pushk_under(a.first.constant);
  return BLOCK(gen_op_simple(OP.SUBEXP_BEGIN), a, gen_op_simple(OP.SUBEXP_END));
}

export function gen_both(a, b) {
  const jump = gen_op_targetlater(OP.JUMP);
  const fork = gen_op_target(OP.FORK, jump);
  const c = BLOCK(fork, a, jump, b);
  inst_set_target(jump, c);
  return c;
}

export function gen_const_object(expr) {
  let o = new Map();
  let k = null, v = null;
  for (let i = expr.first; i; i = i.next) {
    if (i.op === OP.PUSHK_UNDER) {
      k = i.constant;
      i = i.next;
    } else if (i.op !== OP.SUBEXP_BEGIN || i.next === null || i.next.op !== OP.LOADK ||
               i.next.next === null || i.next.next.op !== OP.SUBEXP_END) {
      return gen_noop();
    } else {
      k = i.next.constant;
      i = i.next.next.next;
    }
    if (i !== null && i.op === OP.PUSHK_UNDER) {
      v = i.constant;
      i = i.next;
    } else if (i === null || i.op !== OP.SUBEXP_BEGIN || i.next === null || i.next.op !== OP.LOADK ||
               i.next.next === null || i.next.next.op !== OP.SUBEXP_END) {
      return gen_noop();
    } else {
      v = i.next.constant;
      i = i.next.next.next;
    }
    if (i === null || i.op !== OP.INSERT) return gen_noop();
    if (kind(k) !== K_STRING) return gen_noop();
    o = objectSet(o, k, v);
  }
  return gen_const(o);
}

function gen_const_array(expr) {
  let allConst = true, commas = 0, normal = true;
  const a = [];
  for (let i = expr.first; i; i = i.next) {
    if (i.op === OP.FORK) {
      commas++;
      if (i.target === null || i.target.op !== OP.JUMP || a.length > 0) { normal = false; break; }
    } else if (allConst && i.op === OP.LOADK) {
      if (i.next !== null && i.next.op !== OP.JUMP) { normal = false; break; }
      a.push(i.constant);
    } else if (i.op !== OP.JUMP || i.target === null || i.target.op !== OP.LOADK) {
      allConst = false;
    }
  }
  if (allConst && normal && (expr.last === null || expr.last.op === OP.LOADK) && a.length === commas + 1) {
    return gen_const(a);
  }
  return gen_noop();
}

export function gen_collect(expr) {
  const constArray = gen_const_array(expr);
  if (constArray.first !== null) return constArray;
  const arrayVar = gen_op_var_fresh(OP.STOREV, 'collect');
  const c = BLOCK(gen_op_simple(OP.DUP), gen_const([]), arrayVar);
  const tail = BLOCK(gen_op_bound(OP.APPEND, arrayVar), gen_op_simple(OP.BACKTRACK));
  return BLOCK(c, gen_op_target(OP.FORK, tail), expr, tail, gen_op_bound(OP.LOADVN, arrayVar));
}

function bind_matcher(matcher, body) {
  for (let i = matcher.first; i; i = i.next) {
    if ((i.op === OP.STOREV || i.op === OP.STOREVN) && !i.boundBy) block_bind_subblock(instBlock(i), body, HAS_VARIABLE, 0);
  }
  return BLOCK(matcher, body);
}

function block_get_unbound_vars(b, vars) {
  for (let i = b.first; i; i = i.next) {
    if (i.subfn.first) { block_get_unbound_vars(i.subfn, vars); continue; }
    if ((i.op === OP.STOREV || i.op === OP.STOREVN) && i.boundBy === null) vars.set(i.symbol, true);
  }
}

function bind_alternation_matchers(matchers, body) {
  let preamble = gen_noop();
  let altmatchers = gen_noop();
  let mb = gen_noop();
  const finalMatcher = { first: matchers.first, last: matchers.last };
  while (finalMatcher.first && finalMatcher.first.op === OP.DESTRUCTURE_ALT) {
    block_append(altmatchers, instBlock(block_take(finalMatcher)));
  }
  if (altmatchers.first === null) return bind_matcher(finalMatcher, body);
  const allVars = new Map();
  block_get_unbound_vars(altmatchers, allVars);
  block_get_unbound_vars(finalMatcher, allVars);
  for (const key of allVars.keys()) {
    preamble = BLOCK(preamble, gen_op_simple(OP.DUP), gen_const(null), gen_op_unbound(OP.STOREV, key));
  }
  for (let i = altmatchers.first; i; i = i.next) {
    let submatcher = i.subfn;
    submatcher = BLOCK(submatcher, gen_op_target(OP.JUMP, finalMatcher));
    mb = BLOCK(mb, gen_op_target(OP.DESTRUCTURE_ALT, submatcher), submatcher);
    i.subfn = gen_noop();
  }
  return bind_matcher(preamble, BLOCK(mb, finalMatcher, body));
}

export function gen_reduce(source, matcher, init, body) {
  const resVar = gen_op_var_fresh(OP.STOREV, 'reduce');
  const loop = BLOCK(gen_op_simple(OP.DUPN), source,
    bind_alternation_matchers(matcher, BLOCK(gen_op_bound(OP.LOADVN, resVar), body, gen_op_bound(OP.STOREV, resVar))),
    gen_op_simple(OP.BACKTRACK));
  return BLOCK(gen_op_simple(OP.DUP), init, resVar, gen_op_target(OP.FORK, loop), loop, gen_op_bound(OP.LOADVN, resVar));
}

export function gen_foreach(source, matcher, init, update, extract) {
  const output = gen_op_targetlater(OP.JUMP);
  const stateVar = gen_op_var_fresh(OP.STOREV, 'foreach');
  const loop = BLOCK(gen_op_simple(OP.DUPN), source,
    bind_alternation_matchers(matcher, BLOCK(gen_op_bound(OP.LOADVN, stateVar), update, gen_op_simple(OP.DUP),
      gen_op_bound(OP.STOREV, stateVar), extract, output)));
  const foreach = BLOCK(gen_op_simple(OP.DUP), init, stateVar, gen_op_target(OP.FORK, loop), loop, gen_op_simple(OP.BACKTRACK));
  inst_set_target(output, foreach);
  return foreach;
}

export function gen_definedor(a, b) {
  const foundVar = gen_op_var_fresh(OP.STOREV, 'found');
  const init = BLOCK(gen_op_simple(OP.DUP), gen_const(false), foundVar);
  const backtrack = gen_op_simple(OP.BACKTRACK);
  const tail = BLOCK(gen_op_simple(OP.DUP), gen_op_bound(OP.LOADV, foundVar), gen_op_target(OP.JUMP_F, backtrack),
    backtrack, gen_op_simple(OP.POP), b);
  const ifNotfound = gen_op_simple(OP.BACKTRACK);
  const ifFound = BLOCK(gen_op_simple(OP.DUP), gen_const(true), gen_op_bound(OP.STOREV, foundVar), gen_op_target(OP.JUMP, tail));
  return BLOCK(init, gen_op_target(OP.FORK, ifNotfound), a, gen_op_target(OP.JUMP_F, ifFound), ifFound, ifNotfound, tail);
}

export function block_has_main(top) {
  for (let c = top.first; c; c = c.next) if (c.op === OP.TOP) return true;
  return false;
}

export function gen_condbranch(iftrue, iffalse) {
  iftrue = BLOCK(iftrue, gen_op_target(OP.JUMP, iffalse));
  return BLOCK(gen_op_target(OP.JUMP_F, iftrue), iftrue, iffalse);
}

export function gen_and(a, b) {
  return BLOCK(gen_op_simple(OP.DUP), a,
    gen_condbranch(BLOCK(gen_op_simple(OP.POP), b, gen_condbranch(gen_const(true), gen_const(false))),
      BLOCK(gen_op_simple(OP.POP), gen_const(false))));
}

export function gen_or(a, b) {
  return BLOCK(gen_op_simple(OP.DUP), a,
    gen_condbranch(BLOCK(gen_op_simple(OP.POP), gen_const(true)),
      BLOCK(gen_op_simple(OP.POP), b, gen_condbranch(gen_const(true), gen_const(false)))));
}

export function gen_destructure_alt(matcher) {
  for (let i = matcher.first; i; i = i.next) if (i.op === OP.STOREV) i.op = OP.STOREVN;
  const i = new Inst(OP.DESTRUCTURE_ALT);
  i.subfn = matcher;
  return instBlock(i);
}

export function gen_var_binding(v, name, body) {
  return gen_destructure(v, gen_op_unbound(OP.STOREV, name), body);
}

export function gen_array_matcher(left, curr) {
  let index;
  if (block_is_noop(left)) index = 0;
  else {
    let i;
    if (left.first.next.op === OP.PUSHK_UNDER) i = left.first.next;
    else i = left.first.next.next;
    index = 1 + Math.trunc(i.constant);
  }
  return BLOCK(gen_op_simple(OP.DUP), gen_subexp(gen_const(index)), gen_op_simple(OP.INDEX), curr, left);
}

export function gen_object_matcher(name, curr) {
  return BLOCK(gen_op_simple(OP.DUP), gen_subexp(name), gen_op_simple(OP.INDEX), curr);
}

export function gen_destructure(v, matchers, body) {
  let top = gen_noop();
  body = { first: body.first, last: body.last };
  if (body.first && body.first.op === OP.TOP) top = instBlock(block_take(body));
  if (matchers.first && matchers.first.op === OP.DESTRUCTURE_ALT) v = BLOCK(v, gen_op_simple(OP.DUP));
  else top = BLOCK(top, gen_op_simple(OP.DUP));
  return BLOCK(top, gen_subexp(v), gen_op_simple(OP.POP), bind_alternation_matchers(matchers, body));
}

function gen_wildvar_binding(v, name, body) {
  return BLOCK(gen_op_simple(OP.DUP), v, block_bind(gen_op_unbound(OP.STOREV, name), body, HAS_VARIABLE | BIND_WILDCARD));
}

export function gen_cond(cond, iftrue, iffalse) {
  return BLOCK(gen_op_simple(OP.DUP), BLOCK(gen_subexp(cond), gen_op_simple(OP.POP)),
    gen_condbranch(BLOCK(gen_op_simple(OP.POP), iftrue), BLOCK(gen_op_simple(OP.POP), iffalse)));
}

export function gen_try_handler(handler) {
  return gen_cond(
    gen_and(gen_call('_equal', BLOCK(gen_lambda(gen_const('object')), gen_lambda(gen_noop()))),
      BLOCK(gen_subexp(gen_const('__jq')), gen_noop(), gen_op_simple(OP.INDEX))),
    gen_call('error', gen_noop()),
    handler);
}

export function gen_try(exp, handler) {
  if (!handler.first && !handler.last) handler = BLOCK(gen_op_simple(OP.DUP), gen_op_simple(OP.POP), handler);
  exp = BLOCK(exp, gen_op_target(OP.JUMP, handler));
  return BLOCK(gen_op_target(OP.FORK_OPT, exp), exp, handler);
}

export function gen_label(label, exp) {
  const cond = gen_call('_equal', BLOCK(gen_lambda(gen_noop()), gen_lambda(gen_op_unbound(OP.LOADV, label))));
  return gen_wildvar_binding(gen_op_simple(OP.GENLABEL), label,
    BLOCK(gen_op_simple(OP.POP),
      gen_try(exp, gen_cond(cond, gen_op_simple(OP.BACKTRACK), gen_call('error', gen_noop())))));
}

export function gen_cbinding(cfunctions, code) {
  for (const cf of cfunctions) {
    const i = new Inst(OP.CLOSURE_CREATE_C);
    i.cfunc = cf;
    i.symbol = cf.name;
    code = block_bind(instBlock(i), code, IS_CALL_PSEUDO);
  }
  return code;
}

// ---------------------------------------------------------------- bytecode generation

function nestingLevel(bc, target) {
  let level = 0;
  while (bc && target.compiled !== bc) { level++; bc = bc.parent; }
  return level;
}

function expandCallArglist(b, args, env) {
  let errors = 0;
  let ret = gen_noop();
  for (let curr; (curr = block_take(b));) {
    if (flagsOf(curr.op) & HAS_BINDING) {
      if (!curr.boundBy && curr.op === OP.LOADV && curr.symbol === 'ENV') {
        curr.op = OP.LOADK;
        if (env.value === undefined) env.value = env.make();
        curr.constant = env.value;
      } else if (!curr.boundBy && curr.op === OP.LOADV && args.has(curr.symbol)) {
        curr.op = OP.LOADK;
        curr.constant = args.get(curr.symbol);
      } else if (!curr.boundBy) {
        if (curr.symbol[0] === '*' && curr.symbol.length === 2 && curr.symbol[1] >= '1' && curr.symbol[1] <= '3') {
          curr.locfile.locate(curr.source, 'jq: error: break used outside labeled control structure');
        } else if (curr.op === OP.LOADV) {
          curr.locfile.locate(curr.source, `jq: error: $${curr.symbol} is not defined`);
        } else {
          curr.locfile.locate(curr.source, `jq: error: ${curr.symbol}/${block_count_actuals(curr.arglist)} is not defined`);
        }
        errors++;
        ret = BLOCK(ret, instBlock(curr));
        continue;
      }
    }
    let prelude = gen_noop();
    if (curr.op === OP.CALL_JQ) {
      let actualArgs = 0;
      switch (curr.boundBy.op) {
        case OP.CLOSURE_CREATE:
        case OP.CLOSURE_PARAM: {
          let callargs = gen_noop();
          for (let i; (i = block_take(curr.arglist));) {
            const ib = instBlock(i);
            if (i.op === OP.CLOSURE_REF) block_append(callargs, ib);
            else if (i.op === OP.CLOSURE_CREATE) {
              block_append(prelude, ib);
              block_append(callargs, gen_op_bound(OP.CLOSURE_REF, ib));
            }
            actualArgs++;
          }
          curr.intval = actualArgs;
          curr.arglist = callargs;
          break;
        }
        case OP.CLOSURE_CREATE_C: {
          for (let i; (i = block_take(curr.arglist));) {
            const body = { first: i.subfn.first, last: i.subfn.last };
            i.subfn = gen_noop();
            errors += expandCallArglist(body, args, env);
            prelude = BLOCK(gen_subexp(body), prelude);
            actualArgs++;
          }
          curr.op = OP.CALL_BUILTIN;
          curr.intval = actualArgs + 1;
          break;
        }
      }
    }
    ret = BLOCK(ret, prelude, instBlock(curr));
  }
  b.first = ret.first;
  b.last = ret.last;
  return errors;
}

class Bytecode {
  constructor(parent, globals) {
    this.code = null;
    this.codelen = 0;
    this.nlocals = 0;
    this.nclosures = 0;
    this.constants = [];
    this.globals = globals;
    this.subfunctions = [];
    this.parent = parent;
    this.name = null;
    this.params = [];
    this.locals = [];
  }
}

function compile(bc, b, lf, args, env) {
  let errors = 0;
  let pos = 0;
  let varFrameIdx = 0;
  b = { first: b.first, last: b.last };
  errors += expandCallArglist(b, args, env);
  b = BLOCK(b, gen_op_simple(OP.RET));
  const localnames = [];
  let nsub = 0;
  for (let curr = b.first; curr; curr = curr.next) {
    let length = DESC[curr.op].length;
    if (curr.op === OP.CALL_JQ) for (let a = curr.arglist.first; a; a = a.next) length += 2;
    pos += length;
    curr.bytecodePos = pos;
    curr.compiled = bc;
    if ((flagsOf(curr.op) & HAS_VARIABLE) && curr.boundBy === curr) {
      curr.intval = varFrameIdx++;
      localnames.push(curr.symbol);
    }
    if (curr.op === OP.CLOSURE_CREATE) curr.intval = nsub++;
    if (curr.op === OP.CLOSURE_CREATE_C) {
      const idx = bc.globals.cfunctions.length;
      bc.globals.cfunctions.push(curr.cfunc);
      bc.globals.cfuncNames.push(curr.symbol);
      curr.intval = idx;
    }
  }
  if (pos > 0xffff) {
    lf.locate(UNKNOWN_LOCATION, `function compiled to ${pos} bytes which is too long`);
    errors++;
  }
  bc.codelen = pos;
  bc.locals = localnames;
  bc.subfunctions = new Array(nsub);
  for (let curr = b.first; curr; curr = curr.next) {
    if (curr.op === OP.CLOSURE_CREATE) {
      const subfn = new Bytecode(bc, bc.globals);
      bc.subfunctions[curr.intval] = subfn;
      subfn.name = curr.symbol;
      for (let param = curr.arglist.first; param; param = param.next) {
        param.intval = subfn.nclosures++;
        param.compiled = subfn;
        subfn.params.push(param.symbol);
      }
      errors += compile(subfn, curr.subfn, lf, args, env);
      curr.subfn = gen_noop();
    }
  }
  const code = new Array(bc.codelen).fill(0);
  bc.code = code;
  pos = 0;
  const constants = [];
  let maxvar = -1;
  if (!errors) {
    for (let curr = b.first; curr; curr = curr.next) {
      const op = DESC[curr.op];
      if (op.length === 0) continue;
      code[pos++] = curr.op;
      if (curr.op === OP.CALL_BUILTIN) {
        code[pos++] = curr.intval;
        code[pos++] = curr.boundBy.intval;
      } else if (curr.op === OP.CALL_JQ) {
        code[pos++] = curr.intval;
        code[pos++] = nestingLevel(bc, curr.boundBy);
        code[pos++] = curr.boundBy.intval | (curr.boundBy.op === OP.CLOSURE_CREATE ? ARG_NEWCLOSURE : 0);
        for (let arg = curr.arglist.first; arg; arg = arg.next) {
          code[pos++] = nestingLevel(bc, arg.boundBy);
          code[pos++] = arg.boundBy.intval | ARG_NEWCLOSURE;
        }
      } else if ((op.flags & HAS_CONSTANT) && (op.flags & HAS_VARIABLE)) {
        code[pos++] = constants.length;
        constants.push(curr.constant);
        code[pos++] = nestingLevel(bc, curr.boundBy);
        code[pos++] = curr.boundBy.intval;
      } else if (op.flags & HAS_CONSTANT) {
        code[pos++] = constants.length;
        // constants are shared by every execution; APPEND copies a frozen array before growing it
        constants.push(Array.isArray(curr.constant) ? Object.freeze(curr.constant) : curr.constant);
      } else if (op.flags & HAS_VARIABLE) {
        code[pos++] = nestingLevel(bc, curr.boundBy);
        const v = curr.boundBy.intval;
        code[pos++] = v;
        if (v > maxvar) maxvar = v;
      } else if (op.flags & HAS_BRANCH) {
        code[pos] = curr.target.bytecodePos - (pos + 1);
        pos++;
      }
    }
  }
  bc.constants = constants;
  bc.nlocals = maxvar + 2;
  return errors;
}

export function blockCompile(b, lf, args, makeEnv) {
  const bc = new Bytecode(null, { cfunctions: [], cfuncNames: [] });
  const env = { value: undefined, make: makeEnv };
  const nerrors = compile(bc, b, lf, args, env);
  return { nerrors, bc: nerrors > 0 ? null : bc };
}

// optimize(): turn calls whose frame is dead afterwards into TAIL_CALL_JQ
function retFollows(code, pc) {
  for (;;) {
    if (code[pc] === OP.RET) return true;
    if (code[pc++] !== OP.JUMP) return false;
    pc = pc + code[pc] + 1;
  }
}
function tailCallAnalyze(code, pc) {
  pc++;
  for (let n = code[pc++] + 1; n > 0; pc++, n--) {
    if (code[pc++] === 0) return OP.CALL_JQ;
  }
  if (retFollows(code, pc)) return OP.TAIL_CALL_JQ;
  return OP.CALL_JQ;
}
export function optimize(bc) {
  for (let i = 0; i < bc.subfunctions.length; i++) bc.subfunctions[i] = optimize(bc.subfunctions[i]);
  const code = bc.code;
  let pc = 0;
  while (pc < bc.codelen) {
    if (code[pc] === OP.CALL_JQ) code[pc] = tailCallAnalyze(code, pc);
    pc += opLength(code, pc);
  }
  return bc;
}

export function countCfunctions(b) {
  let n = 0;
  for (let i = b.first; i; i = i.next) {
    if (i.op === OP.CLOSURE_CREATE_C) n++;
    n += countCfunctions(i.subfn);
  }
  return n;
}

// check_object_key() from parser.y
export function checkObjectKey(k) {
  if (block_is_const(k) && block_const_kind(k) !== K_STRING) {
    return `Cannot use ${typeName(block_const(k))} (${dumpTrunc(block_const(k), 15)}) as object key`;
  }
  return null;
}

export { isValid, INVALID, K_NUMBER };
