// jq 1.6 interpreter, ported from execute.c (the backtracking VM), builtin.c (C-coded builtins,
// bytecoded builtins and the jq-coded library) and linker.c (modules).
import {
  kind, kindName, typeName, K_INVALID, K_NULL, K_FALSE, K_TRUE, K_NUMBER, K_STRING, K_ARRAY, K_OBJECT,
  JvInvalid, INVALID, invalidMsg, isValid, hasMsg, getMsg, jvEqual, jvCmp, jvContains, jvIdentical, jvGet,
  jvSet, jvHas, jvSetpath, jvGetpath, jvDelpaths, jvKeys, jvKeysUnsorted, jvSort, jvGroup, dump, dumpTrunc,
  dtoaFmt, parseSized, parseCString, objectMerge, objectMergeRecursive, stringSplit, stringIndexes,
  stringImplode, codepoints, explode, cpLength, byteLength, encodeUtf8, decodeUtf8, toInt, toIntmax, JqAbort,
  JvParser, PRINT_INVALID,
} from './jqjv.js';
import {
  OP, NUM_OPCODES, ARG_NEWCLOSURE, IS_CALL_PSEUDO, HAS_VARIABLE, Locfile, UNKNOWN_LOCATION, BLOCK, gen_noop,
  gen_op_simple, gen_const, gen_const_global, gen_op_var_fresh, gen_op_bound, gen_function, gen_param,
  gen_call, gen_condbranch, gen_cbinding, block_bind, block_bind_library, block_drop_unreferenced,
  block_take_imports, block_list_funcs, block_is_const, block_module_meta, block_join, blockCompile, optimize,
  cloneBlock,
} from './jqcomp.js';
import { jqParse, jqParseLibrary } from './jqparse.js';
import { fMatch } from './jqre.js';
import { fStrptime, fStrftime, fMktime, fGmtime, fLocaltime } from './jqtime.js';
import { LIBM } from './jqmath.js';
import { JQ_BUILTINS } from './jq-builtins.js';

const B = NUM_OPCODES;   // ON_BACKTRACK(op) = op + NUM_OPCODES

// ---------------------------------------------------------------- the VM

class Frame {
  constructor(bc, env, next, nargs) {
    this.bc = bc;
    this.env = env;          // frame of the closure's definition
    this.next = next;        // frame to return to (the caller)
    this.retdata = null;
    this.retaddr = null;
    this.closures = new Array(nargs);
    this.locals = new Array(bc.nlocals).fill(INVALID);
  }
}

// an object being iterated by EACH (jv_object_iter over a snapshot of its slots)
class ObjIter {
  constructor(entries) { this.entries = entries; }
}

const errFmt = (v) => dumpTrunc(v, 15);
const typeError = (bad, msg) => invalidMsg(`${typeName(bad)} (${errFmt(bad)}) ${msg}`);
const typeError2 = (a, b, msg) => invalidMsg(`${typeName(a)} (${errFmt(a)}) and ${typeName(b)} (${errFmt(b)}) ${msg}`);

export class JqState {
  constructor(host) {
    this.host = host;          // { stderr(s), env, fs helpers, now(), tick() }
    this.bc = null;
    this.nextLabel = 0;
    this.stkTop = null;
    this.forkTop = null;
    this.currFrame = null;
    this.error = null;
    this.halted = false;
    this.exitCode = INVALID;
    this.errorMessage = INVALID;
    this.attrs = new Map();
    this.path = null;
    this.valueAtPath = null;
    this.subexpNest = 0;
    this.initialExecution = false;
    this.inputCb = null;
    this.debugCb = null;
    this.errCb = (msg) => host.stderr(msg + '\n');
    this.ticks = 0;
  }

  reportError(msg) { this.errCb(msg); }

  push(v) { this.stkTop = { v, next: this.stkTop }; }
  pop() { const c = this.stkTop; this.stkTop = c.next; return c.v; }
  popn() { const c = this.stkTop; const v = c.v; c.v = null; this.stkTop = c.next; return v; }

  frameLevel(level) {
    let fr = this.currFrame;
    for (let i = 0; i < level; i++) fr = fr.env;
    return fr;
  }

  makeClosure(code, pc) {
    const level = code[pc], idx = code[pc + 1];
    const fr = this.frameLevel(level);
    if (idx & ARG_NEWCLOSURE) return { bc: fr.bc.subfunctions[idx & ~ARG_NEWCLOSURE], env: fr };
    return fr.closures[idx];
  }

  framePush(callee, code, argdef, nargs) {
    const f = new Frame(callee.bc, callee.env, this.currFrame, nargs);
    for (let i = 0; i < nargs; i++) f.closures[i] = this.makeClosure(code, argdef + i * 2);
    this.currFrame = f;
    return f;
  }

  framePop() { this.currFrame = this.currFrame.next; }

  stackSave(retaddr, spStk, spFrame) {
    this.forkTop = {
      next: this.forkTop,
      stk: this.stkTop,
      frame: this.currFrame,
      pathLen: Array.isArray(this.path) ? this.path.length : 0,
      valueAtPath: this.valueAtPath,
      subexpNest: this.subexpNest,
      retaddr,
    };
    this.stkTop = spStk;
    this.currFrame = spFrame;
  }

  stackRestore() {
    const f = this.forkTop;
    if (f === null) {
      this.stkTop = null;
      this.currFrame = null;
      return null;
    }
    this.stkTop = f.stk;
    this.currFrame = f.frame;
    if (Array.isArray(this.path)) {
      if (this.path.length !== f.pathLen) this.path = this.path.slice(0, f.pathLen);
    }
    this.valueAtPath = f.valueAtPath;
    this.subexpNest = f.subexpNest;
    this.forkTop = f.next;
    return f.retaddr;
  }

  pathIntact(curr) {
    if (this.subexpNest === 0 && Array.isArray(this.path)) return jvIdentical(curr, this.valueAtPath);
    return true;
  }
  pathAppend(component, valueAtPath) {
    if (this.subexpNest === 0 && Array.isArray(this.path)) {
      this.path = this.path.concat([component]);
      this.valueAtPath = valueAtPath;
    }
  }

  reset() {
    this.forkTop = null;
    this.stkTop = null;
    this.currFrame = null;
    this.error = null;
    this.halted = false;
    this.exitCode = INVALID;
    this.errorMessage = INVALID;
    this.path = null;
    this.valueAtPath = null;
    this.subexpNest = 0;
  }

  start(input) {
    this.reset();
    const top = this.framePush({ bc: this.bc, env: null }, null, 0, 0);
    top.retdata = null;
    top.retaddr = null;
    this.push(input);
    this.stackSave(0, this.stkTop, this.currFrame);
    this.initialExecution = true;
  }

  setError(v) { this.error = v; }

  // jq_next: an output value, INVALID when exhausted (or halted), or an invalid with a message
  next() {
    let pc = this.stackRestore();
    if (pc === null) return INVALID;
    let backtracking = !this.initialExecution;
    this.initialExecution = false;
    let raising = false;
    let frame = this.currFrame;
    let bc = frame.bc;
    let code = bc.code;
    for (;;) {
      if (this.halted) return INVALID;
      if ((++this.ticks & 4095) === 0) this.host.tick();
      let opcode = code[pc];
      raising = false;
      if (backtracking) {
        opcode += B;
        backtracking = false;
        raising = !isValid(this.error);
      }
      pc++;
      switch (opcode) {
        case OP.TOP: break;

        case OP.LOADK: {
          const v = bc.constants[code[pc++]];
          this.pop();
          this.push(v);
          break;
        }
        case OP.GENLABEL:
          this.push(new Map([['__jq', this.nextLabel++]]));
          break;
        case OP.DUP: {
          const v = this.pop();
          this.push(v);
          this.push(v);
          break;
        }
        case OP.DUPN: {
          const v = this.popn();
          this.push(v);
          this.push(v);
          break;
        }
        case OP.DUP2: {
          const keep = this.pop();
          const v = this.pop();
          this.push(v);
          this.push(keep);
          this.push(v);
          break;
        }
        case OP.SUBEXP_BEGIN: {
          const v = this.pop();
          this.push(v);
          this.push(v);
          this.subexpNest++;
          break;
        }
        case OP.SUBEXP_END: {
          this.subexpNest--;
          const a = this.pop();
          const b = this.pop();
          this.push(a);
          this.push(b);
          break;
        }
        case OP.PUSHK_UNDER: {
          const v = bc.constants[code[pc++]];
          const v2 = this.pop();
          this.push(v);
          this.push(v2);
          break;
        }
        case OP.POP: this.pop(); break;
        case OP.APPEND: {
          const v = this.pop();
          const level = code[pc++], vidx = code[pc++];
          const locals = this.frameLevel(level).locals;
          let arr = locals[vidx];
          if (Object.isFrozen(arr)) { arr = arr.slice(); locals[vidx] = arr; }
          arr.push(v);
          break;
        }
        case OP.INSERT: {
          const stktop = this.pop();
          const v = this.pop();
          const k = this.pop();
          const objv = this.pop();
          if (typeof k === 'string') {
            const m = new Map(objv);
            m.set(k, v);
            this.push(m);
            this.push(stktop);
          } else {
            this.setError(invalidMsg(`Cannot use ${typeName(k)} (${errFmt(k)}) as object key`));
            pc = null;
          }
          break;
        }
        case B + OP.RANGE:
        case OP.RANGE: {
          const level = code[pc++], v = code[pc++];
          const locals = this.frameLevel(level).locals;
          const max = this.pop();
          if (raising) { pc = null; break; }
          const cur = locals[v];
          if (typeof cur !== 'number' || typeof max !== 'number') {
            this.setError(invalidMsg('Range bounds must be numeric'));
            pc = null;
          } else if (cur >= max) {
            pc = null;
          } else {
            locals[v] = cur + 1;
            const spStk = this.stkTop, spFrame = this.currFrame;
            this.push(max);
            this.stackSave(pc - 3, spStk, spFrame);
            this.push(cur);
          }
          break;
        }
        case OP.LOADV: {
          const level = code[pc++], v = code[pc++];
          const val = this.frameLevel(level).locals[v];
          this.pop();
          this.push(val);
          break;
        }
        case OP.LOADVN: {
          const level = code[pc++], v = code[pc++];
          const locals = this.frameLevel(level).locals;
          this.popn();
          this.push(locals[v]);
          locals[v] = null;
          break;
        }
        case OP.STOREVN:
          this.stackSave(pc - 1, this.stkTop, this.currFrame);
          // fallthrough
        case OP.STOREV: {
          const level = code[pc++], v = code[pc++];
          this.frameLevel(level).locals[v] = this.pop();
          break;
        }
        case B + OP.STOREVN: {
          const level = code[pc++], v = code[pc++];
          this.frameLevel(level).locals[v] = null;
          pc = null;
          break;
        }
        case OP.STORE_GLOBAL: {
          const val = bc.constants[code[pc++]];
          const level = code[pc++], v = code[pc++];
          this.frameLevel(level).locals[v] = val;
          break;
        }
        case OP.PATH_BEGIN: {
          const v = this.pop();
          this.push(this.path);
          this.stackSave(pc - 1, this.stkTop, this.currFrame);
          this.push(this.subexpNest);
          this.push(this.valueAtPath);
          this.push(v);
          this.path = [];
          this.valueAtPath = v;
          this.subexpNest = 0;
          break;
        }
        case OP.PATH_END: {
          const v = this.pop();
          if (!this.pathIntact(v)) {
            this.setError(invalidMsg(`Invalid path expression with result ${dumpTrunc(v, 30)}`));
            pc = null;
            break;
          }
          const oldValueAtPath = this.pop();
          const oldSubexpNest = this.pop();
          const path = this.path;
          this.path = this.pop();
          const spStk = this.stkTop, spFrame = this.currFrame;
          this.push(path);
          this.stackSave(pc - 1, spStk, spFrame);
          this.push(path);
          this.subexpNest = oldSubexpNest;
          this.valueAtPath = oldValueAtPath;
          break;
        }
        case B + OP.PATH_BEGIN:
        case B + OP.PATH_END:
          this.path = this.pop();
          pc = null;
          break;
        case OP.INDEX:
        case OP.INDEX_OPT: {
          const t = this.pop();
          const k = this.pop();
          if (!this.pathIntact(t)) {
            this.setError(invalidMsg(`Invalid path expression near attempt to access element ${dumpTrunc(k, 15)} of ${dumpTrunc(t, 30)}`));
            pc = null;
            break;
          }
          const v = jvGet(t, k);
          if (isValid(v)) {
            this.pathAppend(k, v);
            this.push(v);
          } else {
            if (opcode === OP.INDEX) this.setError(v);
            pc = null;
          }
          break;
        }
        case OP.JUMP: {
          const offset = code[pc++];
          pc += offset;
          break;
        }
        case OP.JUMP_F: {
          const offset = code[pc++];
          const t = this.pop();
          if (t === false || t === null) pc += offset;
          this.push(t);
          break;
        }
        case OP.EACH:
        case OP.EACH_OPT:
        case B + OP.EACH:
        case B + OP.EACH_OPT: {
          let idx, container;
          const first = opcode < B;
          if (first) {
            container = this.pop();
            if (!this.pathIntact(container)) {
              this.setError(invalidMsg(`Invalid path expression near attempt to iterate through ${dumpTrunc(container, 30)}`));
              pc = null;
              break;
            }
            idx = -1;
          } else {
            idx = this.pop();
            container = this.pop();
          }
          let keepGoing, isLast = false, key, value;
          if (Array.isArray(container)) {
            idx = first ? 0 : idx + 1;
            const len = container.length;
            keepGoing = idx < len;
            isLast = idx === len - 1;
            if (keepGoing) { key = idx; value = container[idx]; }
          } else if (container instanceof Map || container instanceof ObjIter) {
            if (container instanceof Map) container = new ObjIter(Array.from(container));
            idx = first ? 0 : idx + 1;
            keepGoing = idx < container.entries.length;
            if (keepGoing) { key = container.entries[idx][0]; value = container.entries[idx][1]; }
          } else {
            if (opcode === OP.EACH) this.setError(invalidMsg(`Cannot iterate over ${typeName(container)} (${errFmt(container)})`));
            keepGoing = false;
          }
          if (!keepGoing || raising) { pc = null; break; }
          if (isLast) {
            this.pathAppend(key, value);
            this.push(value);
          } else {
            const spStk = this.stkTop, spFrame = this.currFrame;
            this.push(container);
            this.push(idx);
            this.stackSave(pc - 1, spStk, spFrame);
            this.pathAppend(key, value);
            this.push(value);
          }
          break;
        }
        case OP.BACKTRACK:
          pc = null;
          break;
        case OP.FORK_OPT:
        case OP.DESTRUCTURE_ALT:
        case OP.FORK:
          this.stackSave(pc - 1, this.stkTop, this.currFrame);
          pc++;
          break;
        case B + OP.FORK_OPT:
        case B + OP.DESTRUCTURE_ALT: {
          if (isValid(this.error)) {
            this.pop();
            pc = null;
            break;
          }
          if (opcode !== B + OP.DESTRUCTURE_ALT) {
            this.pop();
            this.push(getMsg(this.error));
          }
          this.error = null;
          const offset = code[pc++];
          pc += offset;
          break;
        }
        case B + OP.FORK: {
          if (raising) { pc = null; break; }
          const offset = code[pc++];
          pc += offset;
          break;
        }
        case OP.CALL_BUILTIN: {
          const nargs = code[pc++];
          const top = this.pop();
          const f = bc.globals.cfunctions[code[pc++]];
          let r;
          switch (f.nargs) {
            case 1: r = f.fptr(this, top); break;
            case 2: { const a = this.pop(); r = f.fptr(this, top, a); break; }
            case 3: { const a = this.pop(), b = this.pop(); r = f.fptr(this, top, a, b); break; }
            case 4: { const a = this.pop(), b = this.pop(), c = this.pop(); r = f.fptr(this, top, a, b, c); break; }
            case 5: { const a = this.pop(), b = this.pop(), c = this.pop(), d = this.pop(); r = f.fptr(this, top, a, b, c, d); break; }
            default: return invalidMsg('Function takes too many arguments');
          }
          void nargs;
          if (isValid(r)) this.push(r);
          else {
            if (hasMsg(r)) this.setError(r);
            pc = null;
          }
          break;
        }
        case OP.TAIL_CALL_JQ:
        case OP.CALL_JQ: {
          const input = this.pop();
          const nclosures = code[pc++];
          let retaddr = pc + 2 + nclosures * 2;
          let retdata = this.stkTop;
          const cl = this.makeClosure(code, pc);
          if (opcode === OP.TAIL_CALL_JQ) {
            retaddr = this.currFrame.retaddr;
            retdata = this.currFrame.retdata;
            this.framePop();
          }
          const nf = this.framePush(cl, code, pc + 2, nclosures);
          nf.retdata = retdata;
          nf.retaddr = retaddr;
          bc = nf.bc;
          code = bc.code;
          pc = 0;
          this.push(input);
          break;
        }
        case OP.RET: {
          const value = this.pop();
          const retaddr = this.currFrame.retaddr;
          if (retaddr !== null) {
            pc = retaddr;
            this.framePop();
            bc = this.currFrame.bc;
            code = bc.code;
          } else {
            const spStk = this.stkTop, spFrame = this.currFrame;
            this.push(null);
            this.stackSave(pc - 1, spStk, spFrame);
            return value;
          }
          this.push(value);
          break;
        }
        case B + OP.RET:
          pc = null;
          break;
        default:
          throw new Error('jq: invalid instruction ' + opcode);
      }
      if (pc === null) {
        // do_backtrack
        pc = this.stackRestore();
        if (pc === null) {
          if (!isValid(this.error)) {
            const e = this.error;
            this.error = null;
            return e;
          }
          return INVALID;
        }
        bc = this.currFrame.bc;
        code = bc.code;
        backtracking = true;
      }
    }
  }

  halt(exitCode, errorMessage) {
    this.halted = true;
    this.exitCode = exitCode;
    this.errorMessage = errorMessage;
  }

  getAttr(k) { return this.attrs.has(k) ? this.attrs.get(k) : INVALID; }
  setAttr(k, v) { this.attrs.set(k, v); }
  libDirs() { return this.getAttr('JQ_LIBRARY_PATH'); }

  // jq_compile_args
  compileArgs(program, args) {
    const locations = new Locfile(this, '<top-level>', program);
    this.reset();
    this.bc = null;
    let nerrors;
    const prog = { block: null };
    nerrors = loadProgram(this, locations, prog);
    if (nerrors === 0) {
      nerrors = builtinsBind(this, prog);
      if (nerrors === 0) {
        const r = blockCompile(prog.block, locations, args, () => this.host.envObject());
        nerrors = r.nerrors;
        this.bc = r.bc;
      }
    }
    if (nerrors) this.reportError(`jq: ${nerrors} compile ${nerrors > 1 ? 'errors' : 'error'}`);
    if (this.bc) this.bc = optimize(this.bc);
    return this.bc !== null;
  }
}

// ---------------------------------------------------------------- C-coded builtins (builtin.c)

function f_plus(jq, input, a, b) {
  const ka = kind(a), kb = kind(b);
  if (ka === K_NULL) return b;
  if (kb === K_NULL) return a;
  if (ka === K_NUMBER && kb === K_NUMBER) return a + b;
  if (ka === K_STRING && kb === K_STRING) return a + b;
  if (ka === K_ARRAY && kb === K_ARRAY) return a.concat(b);
  if (ka === K_OBJECT && kb === K_OBJECT) return objectMerge(a, b);
  return typeError2(a, b, 'cannot be added');
}

function f_negate(jq, input) {
  if (typeof input !== 'number') return typeError(input, 'cannot be negated');
  return -input;
}

function f_startswith(jq, a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return invalidMsg('startswith() requires string inputs');
  return a.startsWith(b);
}
function f_endswith(jq, a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return invalidMsg('endswith() requires string inputs');
  return a.endsWith(b);
}
function f_ltrimstr(jq, input, left) {
  if (f_startswith(jq, input, left) !== true) return input;
  return input.slice(left.length);
}
function f_rtrimstr(jq, input, right) {
  if (f_endswith(jq, input, right) === true) return input.slice(0, input.length - right.length);
  return input;
}

function f_minus(jq, input, a, b) {
  const ka = kind(a), kb = kind(b);
  if (ka === K_NUMBER && kb === K_NUMBER) return a - b;
  if (ka === K_ARRAY && kb === K_ARRAY) {
    const out = [];
    for (const x of a) {
      let include = true;
      for (const y of b) if (jvEqual(x, y)) { include = false; break; }
      if (include) out.push(x);
    }
    return out;
  }
  return typeError2(a, b, 'cannot be subtracted');
}

function f_multiply(jq, input, a, b) {
  const ka = kind(a), kb = kind(b);
  if (ka === K_NUMBER && kb === K_NUMBER) return a * b;
  if ((ka === K_STRING && kb === K_NUMBER) || (ka === K_NUMBER && kb === K_STRING)) {
    const str = ka === K_STRING ? a : b;
    const num = ka === K_STRING ? b : a;
    const n = toInt(num - 1);
    if (n < 0) return null;
    if (n > 0 && byteLength(str) * (n + 1) >= 2147483647) return invalidMsg('String too long');
    return str.repeat(n + 1);
  }
  if (ka === K_OBJECT && kb === K_OBJECT) return objectMergeRecursive(a, b);
  return typeError2(a, b, 'cannot be multiplied');
}

function f_divide(jq, input, a, b) {
  const ka = kind(a), kb = kind(b);
  if (ka === K_NUMBER && kb === K_NUMBER) {
    if (b === 0) return typeError2(a, b, 'cannot be divided because the divisor is zero');
    return a / b;
  }
  if (ka === K_STRING && kb === K_STRING) return stringSplit(a, b);
  return typeError2(a, b, 'cannot be divided');
}

function f_mod(jq, input, a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    const ib = toIntmax(b);
    if (ib === 0n) return typeError2(a, b, 'cannot be divided (remainder) because the divisor is zero');
    const ia = toIntmax(a);
    return Number(ia % ib);
  }
  return typeError2(a, b, 'cannot be divided (remainder)');
}

const f_equal = (jq, input, a, b) => jvEqual(a, b);
const f_notequal = (jq, input, a, b) => !jvEqual(a, b);
const f_less = (jq, input, a, b) => jvCmp(a, b) < 0;
const f_greater = (jq, input, a, b) => jvCmp(a, b) > 0;
const f_lesseq = (jq, input, a, b) => jvCmp(a, b) <= 0;
const f_greatereq = (jq, input, a, b) => jvCmp(a, b) >= 0;

function f_contains(jq, a, b) {
  if (kind(a) === kind(b)) return jvContains(a, b);
  return typeError2(a, b, 'cannot have their containment checked');
}

const dumpString = (v) => dump(v, 0);
const f_dump = (jq, input) => dumpString(input);

function f_json_parse(jq, input) {
  if (typeof input !== 'string') return typeError(input, 'only strings can be parsed');
  return parseSized(encodeUtf8(input));
}

function f_tonumber(jq, input) {
  if (typeof input === 'number') return input;
  if (typeof input === 'string') {
    const parsed = parseCString(encodeUtf8(input));
    if (!isValid(parsed) || typeof parsed === 'number') return parsed;
  }
  return typeError(input, 'cannot be parsed as a number');
}

function f_length(jq, input) {
  switch (kind(input)) {
    case K_ARRAY: return input.length;
    case K_OBJECT: return input.size;
    case K_STRING: return cpLength(input);
    case K_NUMBER: return Math.abs(input);
    case K_NULL: return 0;
    default: return typeError(input, 'has no length');
  }
}

const f_tostring = (jq, input) => (typeof input === 'string' ? input : dumpString(input));

function f_utf8bytelength(jq, input) {
  if (typeof input !== 'string') return typeError(input, 'only strings have UTF-8 byte length');
  return byteLength(input);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64D = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) B64D[B64.charCodeAt(i)] = i;

// escape_string: per-character replacement table (a NUL always becomes "\0")
function escapeString(s, table) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0) out += '\\0';
    else if (c < 128 && table[ch] !== undefined) out += table[ch];
    else out += ch;
  }
  return out;
}
const CSV_ESC = { '"': '""' };
const TSV_ESC = { '\t': '\\t', '\r': '\\r', '\n': '\\n', '\\': '\\\\' };
const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
const SH_ESC = { "'": "'\\''" };
const URI_UNRESERVED = /[A-Za-z0-9\-_.!~*'()]/;

function f_format(jq, input, fmt) {
  if (typeof fmt !== 'string') return typeError(fmt, 'is not a valid format');
  switch (fmt) {
    case 'json': return dumpString(input);
    case 'text': return f_tostring(jq, input);
    case 'csv':
    case 'tsv': {
      const csv = fmt === 'csv';
      const quotes = csv ? '"' : '';
      const sep = csv ? ',' : '\t';
      const esc = csv ? CSV_ESC : TSV_ESC;
      if (!Array.isArray(input)) return typeError(input, csv ? 'cannot be csv-formatted, only array' : 'cannot be tsv-formatted, only array');
      let line = '';
      for (let i = 0; i < input.length; i++) {
        const x = input[i];
        if (i) line += sep;
        switch (kind(x)) {
          case K_NULL: break;
          case K_TRUE: case K_FALSE: line += dumpString(x); break;
          case K_NUMBER: if (x === x) line += dumpString(x); break;
          case K_STRING: line += quotes + escapeString(x, esc) + quotes; break;
          default: return typeError(x, 'is not valid in a csv row');
        }
      }
      return line;
    }
    case 'html': return escapeString(f_tostring(jq, input), HTML_ESC);
    case 'uri': {
      const s = encodeUtf8(f_tostring(jq, input));
      let line = '';
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (s.charCodeAt(i) < 128 && URI_UNRESERVED.test(ch)) line += ch;
        else line += '%' + s.charCodeAt(i).toString(16).toUpperCase().padStart(2, '0');
      }
      return line;
    }
    case 'sh': {
      const arr = Array.isArray(input) ? input : [input];
      let line = '';
      for (let i = 0; i < arr.length; i++) {
        const x = arr[i];
        if (i) line += ' ';
        switch (kind(x)) {
          case K_NULL: case K_TRUE: case K_FALSE: case K_NUMBER: line += dumpString(x); break;
          case K_STRING: line += "'" + escapeString(x, SH_ESC) + "'"; break;
          default: return typeError(x, 'can not be escaped for shell');
        }
      }
      return line;
    }
    case 'base64': {
      const d = encodeUtf8(f_tostring(jq, input));
      let line = '';
      for (let i = 0; i < d.length; i += 3) {
        const n = d.length - i >= 3 ? 3 : d.length - i;
        let code = 0;
        for (let j = 0; j < 3; j++) code = (code << 8) | (j < n ? d.charCodeAt(i + j) : 0);
        let buf = '';
        for (let j = 0; j < 4; j++) buf += B64[(code >> (18 - j * 6)) & 0x3f];
        if (n < 3) buf = buf.slice(0, 3) + '=';
        if (n < 2) buf = buf.slice(0, 2) + '==';
        line += buf;
      }
      return line;
    }
    case 'base64d': {
      const s = f_tostring(jq, input);
      const d = encodeUtf8(s);
      let res = '';
      let code = 0, nread = 0;
      for (let i = 0; i < d.length && d[i] !== '='; i++) {
        const c = d.charCodeAt(i);
        if (c === 255 || B64D[c] < 0) return typeError(s, 'is not valid base64 data');
        code = (code << 6) | B64D[c];
        nread++;
        if (nread === 4) {
          res += String.fromCharCode((code >> 16) & 0xff, (code >> 8) & 0xff, code & 0xff);
          nread = 0;
          code = 0;
        }
      }
      if (nread === 3) res += String.fromCharCode((code >> 10) & 0xff, (code >> 2) & 0xff);
      else if (nread === 2) res += String.fromCharCode((code >> 4) & 0xff);
      else if (nread === 1) return typeError(s, 'trailing base64 byte found');
      return decodeUtf8(res);
    }
    default:
      return invalidMsg(fmt + ' is not a valid format');
  }
}

function f_keys(jq, input) {
  const k = kind(input);
  if (k === K_OBJECT || k === K_ARRAY) return jvKeys(input);
  return typeError(input, 'has no keys');
}
function f_keys_unsorted(jq, input) {
  const k = kind(input);
  if (k === K_OBJECT || k === K_ARRAY) return jvKeysUnsorted(input);
  return typeError(input, 'has no keys');
}
function f_sort(jq, input) {
  if (Array.isArray(input)) return jvSort(input, input);
  return typeError(input, 'cannot be sorted, as it is not an array');
}
function f_sort_by_impl(jq, input, keys) {
  if (Array.isArray(input) && Array.isArray(keys) && input.length === keys.length) return jvSort(input, keys);
  return typeError2(input, keys, 'cannot be sorted, as they are not both arrays');
}
function f_group_by_impl(jq, input, keys) {
  if (Array.isArray(input) && Array.isArray(keys) && input.length === keys.length) return jvGroup(input, keys);
  return typeError2(input, keys, 'cannot be sorted, as they are not both arrays');
}

function minmaxBy(values, keys, isMin) {
  if (!Array.isArray(values)) return typeError2(values, keys, 'cannot be iterated over');
  if (!Array.isArray(keys)) return typeError2(values, keys, 'cannot be iterated over');
  if (values.length !== keys.length) return typeError2(values, keys, 'have wrong length');
  if (values.length === 0) return null;
  let ret = values[0], retkey = keys[0];
  for (let i = 1; i < values.length; i++) {
    const cmp = jvCmp(keys[i], retkey);
    if ((cmp < 0) === isMin) { retkey = keys[i]; ret = values[i]; }
  }
  return ret;
}
const f_min = (jq, x) => minmaxBy(x, x, true);
const f_max = (jq, x) => minmaxBy(x, x, false);
const f_min_by_impl = (jq, x, y) => minmaxBy(x, y, true);
const f_max_by_impl = (jq, x, y) => minmaxBy(x, y, false);

const f_type = (jq, input) => typeName(input);
const f_isinfinite = (jq, input) => typeof input === 'number' && (input === Infinity || input === -Infinity);
const f_isnan = (jq, input) => typeof input === 'number' && input !== input;
function f_isnormal(jq, input) {
  if (typeof input !== 'number') return false;
  return input === input && input !== 0 && Math.abs(input) !== Infinity && Math.abs(input) >= 2.2250738585072014e-308;
}
const f_infinite = () => Infinity;
const f_nan = () => NaN;
const f_error = (jq, input, msg) => invalidMsg(msg);

const f_env = (jq) => jq.host.environ();

function f_halt(jq, input) {
  jq.halt(INVALID, INVALID);
  return true;
}
function f_halt_error(jq, input, a) {
  if (typeof a !== 'number') return typeError(input, 'halt_error/1: number required');
  jq.halt(a, input);
  return true;
}

const f_get_search_list = (jq) => jq.libDirs();
const f_get_prog_origin = (jq) => jq.getAttr('PROGRAM_ORIGIN');
const f_get_jq_origin = (jq) => jq.getAttr('JQ_ORIGIN');

function f_string_split(jq, a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return invalidMsg('split input and separator must be strings');
  return stringSplit(a, b);
}
function f_string_explode(jq, a) {
  if (typeof a !== 'string') return invalidMsg('explode input must be a string');
  return explode(a);
}
function f_string_indexes(jq, a, b) {
  if (typeof a !== 'string') return typeError(a, 'cannot be searched, as it is not a string');
  if (typeof b !== 'string') return typeError(b, 'is not a string');
  const r = stringIndexes(a, b);
  if (r === null) {
    // memmem() with an empty needle never advances: jq loops until it is killed
    for (;;) jq.host.tick();
  }
  return r;
}
function f_string_implode(jq, a) {
  if (!Array.isArray(a)) return invalidMsg('implode input must be an array');
  for (const n of a) if (typeof n !== 'number') throw new JqAbort('src/jv.c:778: jv_string_implode: Assertion `jv_get_kind(n) == JV_KIND_NUMBER\' failed.');
  return stringImplode(a);
}

const f_setpath = (jq, a, b, c) => jvSetpath(a, b, c);
function f_getpath(jq, a, b) {
  return pathAppendGetpath(jq, a, b, jvGetpath(a, b));
}
// _jq_path_append
function pathAppendGetpath(jq, v, p, valueAtPath) {
  if (jq.subexpNest !== 0 || !Array.isArray(jq.path) || !isValid(valueAtPath)) return valueAtPath;
  if (!jvIdentical(v, jq.valueAtPath)) return valueAtPath;
  if (Array.isArray(p)) jq.path = jq.path.concat(p);
  else jq.path = jq.path.concat([p]);
  jq.valueAtPath = valueAtPath;
  return valueAtPath;
}
const f_delpaths = (jq, a, b) => jvDelpaths(a, b);
const f_has = (jq, a, b) => jvHas(a, b);

function f_modulemeta(jq, a) {
  if (typeof a !== 'string') return invalidMsg('modulemeta input module name must be a string');
  return loadModuleMeta(jq, a);
}

function f_input(jq, input) {
  if (jq.inputCb === null) return invalidMsg('break');
  const v = jq.inputCb();
  if (isValid(v) || hasMsg(v)) return v;
  return invalidMsg('break');
}

function f_debug(jq, input) {
  if (jq.debugCb) jq.debugCb(input);
  return input;
}
function f_stderr(jq, input) {
  jq.host.stderr(dump(input, 0));
  return input;
}

function f_now(jq) { return jq.host.now(); }

function f_current_filename(jq) {
  const r = jq.host.currentFilename();
  return isValid(r) ? r : null;
}
const f_current_line = (jq) => jq.host.currentLine();

const libmFn = (name, n) => {
  const fn = LIBM[name];
  if (n === 1) return (jq, input) => (typeof input !== 'number' ? typeError(input, 'number required') : fn(input));
  if (n === 3) return (jq, input, a, b) => {
    if (typeof a !== 'number') return typeError(a, 'number required');
    if (typeof b !== 'number') return typeError(b, 'number required');
    return fn(a, b);
  };
  return (jq, input, a, b, c) => {
    if (typeof a !== 'number') return typeError(a, 'number required');
    if (typeof b !== 'number') return typeError(b, 'number required');
    if (typeof c !== 'number') return typeError(c, 'number required');
    return fn(a, b, c);
  };
};

// libm.h order (pow10 is not in glibc 2.35: it becomes a jq-coded error stub)
const LIBM_LIST = [
  ['acos', 1], ['acosh', 1], ['asin', 1], ['asinh', 1], ['atan', 1], ['atan2', 3], ['atanh', 1], ['cbrt', 1],
  ['cos', 1], ['cosh', 1], ['exp', 1], ['exp2', 1], ['floor', 1], ['hypot', 3], ['j0', 1], ['j1', 1], ['log', 1],
  ['log10', 1], ['log2', 1], ['pow', 3], ['remainder', 3], ['sin', 1], ['sinh', 1], ['sqrt', 1], ['tan', 1],
  ['tanh', 1], ['tgamma', 1], ['y0', 1], ['y1', 1], ['jn', 3], ['yn', 3], ['ceil', 1], ['copysign', 3],
  ['drem', 3], ['erf', 1], ['erfc', 1], ['exp10', 1], ['expm1', 1], ['fabs', 1], ['fdim', 3], ['fma', 4],
  ['fmax', 3], ['fmin', 3], ['fmod', 3], ['gamma', 1], ['lgamma', 1], ['log1p', 1], ['logb', 1],
  ['nearbyint', 1], ['nextafter', 3], ['nexttoward', 3], ['rint', 1], ['round', 1], ['scalb', 3],
  ['scalbln', 3], ['significand', 1], ['trunc', 1], ['ldexp', 3],
];

function f_frexp(jq, input) {
  if (typeof input !== 'number') return typeError(input, 'number required');
  return LIBM.frexp(input);
}
function f_modf(jq, input) {
  if (typeof input !== 'number') return typeError(input, 'number required');
  return LIBM.modf(input);
}
function f_lgamma_r(jq, input) {
  if (typeof input !== 'number') return typeError(input, 'number required');
  return LIBM.lgamma_r(input);
}

const cf = (fptr, name, nargs) => ({ fptr, name, nargs });
const FUNCTION_LIST = [
  ...LIBM_LIST.map(([n, k]) => cf(libmFn(n, k), n, k)),
  cf(f_frexp, 'frexp', 1),
  cf(f_modf, 'modf', 1),
  cf(f_lgamma_r, 'lgamma_r', 1),
  cf(f_plus, '_plus', 3),
  cf(f_negate, '_negate', 1),
  cf(f_minus, '_minus', 3),
  cf(f_multiply, '_multiply', 3),
  cf(f_divide, '_divide', 3),
  cf(f_mod, '_mod', 3),
  cf(f_dump, 'tojson', 1),
  cf(f_json_parse, 'fromjson', 1),
  cf(f_tonumber, 'tonumber', 1),
  cf(f_tostring, 'tostring', 1),
  cf(f_keys, 'keys', 1),
  cf(f_keys_unsorted, 'keys_unsorted', 1),
  cf(f_startswith, 'startswith', 2),
  cf(f_endswith, 'endswith', 2),
  cf(f_ltrimstr, 'ltrimstr', 2),
  cf(f_rtrimstr, 'rtrimstr', 2),
  cf(f_string_split, 'split', 2),
  cf(f_string_explode, 'explode', 1),
  cf(f_string_implode, 'implode', 1),
  cf(f_string_indexes, '_strindices', 2),
  cf(f_setpath, 'setpath', 3),
  cf(f_getpath, 'getpath', 2),
  cf(f_delpaths, 'delpaths', 2),
  cf(f_has, 'has', 2),
  cf(f_equal, '_equal', 3),
  cf(f_notequal, '_notequal', 3),
  cf(f_less, '_less', 3),
  cf(f_greater, '_greater', 3),
  cf(f_lesseq, '_lesseq', 3),
  cf(f_greatereq, '_greatereq', 3),
  cf(f_contains, 'contains', 2),
  cf(f_length, 'length', 1),
  cf(f_utf8bytelength, 'utf8bytelength', 1),
  cf(f_type, 'type', 1),
  cf(f_isinfinite, 'isinfinite', 1),
  cf(f_isnan, 'isnan', 1),
  cf(f_isnormal, 'isnormal', 1),
  cf(f_infinite, 'infinite', 1),
  cf(f_nan, 'nan', 1),
  cf(f_sort, 'sort', 1),
  cf(f_sort_by_impl, '_sort_by_impl', 2),
  cf(f_group_by_impl, '_group_by_impl', 2),
  cf(f_min, 'min', 1),
  cf(f_max, 'max', 1),
  cf(f_min_by_impl, '_min_by_impl', 2),
  cf(f_max_by_impl, '_max_by_impl', 2),
  cf(f_error, 'error', 2),
  cf(f_format, 'format', 2),
  cf(f_env, 'env', 1),
  cf(f_halt, 'halt', 1),
  cf(f_halt_error, 'halt_error', 2),
  cf(f_get_search_list, 'get_search_list', 1),
  cf(f_get_prog_origin, 'get_prog_origin', 1),
  cf(f_get_jq_origin, 'get_jq_origin', 1),
  cf(fMatch, '_match_impl', 4),
  cf(f_modulemeta, 'modulemeta', 1),
  cf(f_input, '_input', 1),
  cf(f_debug, 'debug', 1),
  cf(f_stderr, 'stderr', 1),
  cf(fStrptime, 'strptime', 2),
  cf(fStrftime, 'strftime', 2),
  cf((jq, a, b) => fStrftime(jq, a, b, true), 'strflocaltime', 2),
  cf(fMktime, 'mktime', 1),
  cf(fGmtime, 'gmtime', 1),
  cf(fLocaltime, 'localtime', 1),
  cf(f_now, 'now', 1),
  cf(f_current_filename, 'input_filename', 1),
  cf(f_current_line, 'input_line_number', 1),
];


// ---------------------------------------------------------------- builtins_bind

function bindBytecodedBuiltins(b) {
  let builtins = gen_noop();
  builtins = BLOCK(builtins, gen_function('empty', gen_noop(), gen_op_simple(OP.BACKTRACK)));
  builtins = BLOCK(builtins, gen_function('not', gen_noop(), gen_condbranch(gen_const(false), gen_const(true))));
  builtins = BLOCK(builtins, gen_function('path', gen_param('arg'),
    BLOCK(gen_op_simple(OP.PATH_BEGIN), gen_call('arg', gen_noop()), gen_op_simple(OP.PATH_END))));
  {
    const rangevar = gen_op_var_fresh(OP.STOREV, 'rangevar');
    const rangestart = gen_op_var_fresh(OP.STOREV, 'rangestart');
    const range = BLOCK(gen_op_simple(OP.DUP), gen_call('start', gen_noop()), rangestart, gen_call('end', gen_noop()),
      gen_op_simple(OP.DUP), gen_op_bound(OP.LOADV, rangestart), rangevar, gen_op_bound(OP.RANGE, rangevar));
    builtins = BLOCK(builtins, gen_function('range', BLOCK(gen_param('start'), gen_param('end')), range));
  }
  return block_bind(builtins, b, IS_CALL_PSEUDO);
}

function genBuiltinList(builtins) {
  const list = block_list_funcs(builtins, true).concat(['builtins/0']);
  return BLOCK(builtins, gen_function('builtins', gen_noop(), gen_const(list)));
}

function builtinsBindOne(jq, bb, code, fname) {
  const src = new Locfile(jq, fname, code);
  const r = jqParseLibrary(src);
  if (r.errors === 0) bb.block = block_bind(r.answer, bb.block, IS_CALL_PSEUDO);
  return r.errors;
}

// the bound builtin library does not depend on the program: build it once, copy it per run
let BUILTINS_TEMPLATE = null;
function builtinsBlock() {
  if (BUILTINS_TEMPLATE === null) {
    const quiet = { reportError() {} };
    const lib = { block: gen_noop() };
    builtinsBindOne(quiet, lib, JQ_BUILTINS, '<builtin>');
    let builtins = bindBytecodedBuiltins(lib.block);
    builtins = gen_cbinding(FUNCTION_LIST, builtins);
    BUILTINS_TEMPLATE = genBuiltinList(builtins);
  }
  return cloneBlock(BUILTINS_TEMPLATE);
}

function builtinsBind(jq, bb) {
  let nerrors = 0;
  // slurp_lib: $HOME/.jq is bound like a library when it is a readable file
  const home = jq.host.getenv('HOME');
  if (home !== undefined) {
    const data = jq.host.loadFile(home + '/.jq', true);
    if (isValid(data)) {
      nerrors = builtinsBindOne(jq, bb, encodeUtf8(data), '<builtin>');
      if (nerrors) return nerrors;
    }
  }
  bb.block = block_bind(builtinsBlock(), bb.block, IS_CALL_PSEUDO);
  bb.block = block_drop_unreferenced(bb.block);
  return nerrors;
}

// ---------------------------------------------------------------- linker.c (modules)

function expandPath(jq, path) {
  if (path.length > 1 && path[0] === '~' && path[1] === '/') {
    const home = jq.host.getenv('HOME');
    if (home === undefined) return invalidMsg(`Could not expand ${path}. (Could not find home directory.)`);
    return `${home}/${path.slice(2)}`;
  }
  return path;
}

function buildLibSearchChain(jq, searchPath, jqOrigin, libOrigin) {
  const expanded = [];
  let err = null;
  for (let path of searchPath) {
    if (typeof path !== 'string') continue;
    path = expandPath(jq, path);
    if (!isValid(path)) { err = path; continue; }
    let elt;
    if (path === '.') elt = path;
    else if (path.startsWith('$ORIGIN/')) elt = `${jqOrigin}/${path.slice(8)}`;
    else if (typeof libOrigin === 'string' && path[0] !== '/') elt = `${libOrigin}/${path}`;
    else elt = path;
    expanded.push(elt);
  }
  return [expanded, err];
}

function validateRelpath(name) {
  if (name.includes('\\')) return invalidMsg(`Modules must be named by relative paths using '/', not '\\' (${name})`);
  const components = stringSplit(name, '/');
  let rp = components[0];
  const rest = components.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (x === '..') return invalidMsg(`Relative paths to modules may not traverse to parent directories (${name})`);
    if (i > 0 && x === rest[i - 1]) return invalidMsg(`module names must not have equal consecutive components: ${name}`);
    rp = rp + '/' + x;
  }
  return rp;
}

function findLib(jq, relPath, search, suffix, jqOrigin, libOrigin) {
  if (!Array.isArray(search)) return invalidMsg('Module search path must be an array');
  if (typeof relPath !== 'string') return invalidMsg('Module path must be a string');
  const [chain, err] = buildLibSearchChain(jq, search, jqOrigin, libOrigin);
  const slash = relPath.lastIndexOf('/');
  const bname = slash < 0 ? relPath : relPath.slice(slash);
  for (const spath of chain) {
    if (spath === null) break;
    if (typeof spath !== 'string' || spath === '') continue;
    const tries = [`${spath}/${relPath}${suffix}`, `${spath}/${relPath}/jq/main${suffix}`, `${spath}/${relPath}/${bname}${suffix}`];
    for (const t of tries) {
      const p = jq.host.realpath(t);
      const st = jq.host.stat(p);
      if (st === 'ENOENT') continue;
      if (st === 'ok') return p;
      break;
    }
  }
  if (err !== null) return invalidMsg(`module not found: ${relPath} (${getMsg(err)})`);
  return invalidMsg(`module not found: ${relPath}`);
}

function defaultSearch(jq, value) {
  if (value === undefined) {
    const dirs = jq.libDirs();
    return ['.'].concat(Array.isArray(dirs) ? dirs : []);
  }
  if (!Array.isArray(value)) return [value];
  return value;
}

function processDependencies(jq, jqOrigin, libOrigin, srcBlock, libState) {
  const deps = block_take_imports(srcBlock);
  let bk = srcBlock;
  let nerrors = 0;
  let asStr = null;
  for (const dep of deps) {
    const isData = dep.get('is_data') === true;
    const raw = dep.get('raw') === true;
    const relpath = validateRelpath(dep.get('relpath'));
    const as = dep.get('as');
    if (typeof as === 'string') asStr = as;
    const search = defaultSearch(jq, dep.get('search'));
    const resolved = isValid(relpath) ? findLib(jq, relpath, search, isData ? '.json' : '.jq', jqOrigin, libOrigin) : relpath;
    if (!isValid(resolved)) {
      jq.reportError(`jq: error: ${getMsg(resolved)}\n`);
      return 1;
    }
    let idx = libState.names.indexOf(resolved);
    if (idx >= 0) {
      bk = block_bind_library(libState.defs[idx], bk, IS_CALL_PSEUDO, asStr);
    } else {
      const out = { block: gen_noop() };
      nerrors += loadLibrary(jq, resolved, isData, raw, asStr, out, libState);
      if (nerrors === 0) {
        bk = block_bind_library(out.block, bk, IS_CALL_PSEUDO, asStr);
        if (isData) bk = block_bind_library(out.block, bk, IS_CALL_PSEUDO, null);
      }
    }
  }
  srcBlock.first = bk.first;
  srcBlock.last = bk.last;
  return nerrors;
}

function loadLibrary(jq, libPath, isData, raw, as, out, libState) {
  let nerrors = 0;
  let program;
  const data = isData && !raw ? jq.host.loadFile(libPath, false) : jq.host.loadFile(libPath, true);
  if (!isValid(data)) {
    const m = hasMsg(data) ? getMsg(data) : 'unknown error';
    jq.reportError(`jq: error loading data file ${libPath}: ${m}\n`);
    return 1;
  }
  if (isData) {
    program = gen_const_global(data, as);
  } else {
    const src = new Locfile(jq, libPath, encodeUtf8(data));
    const r = jqParseLibrary(src);
    nerrors += r.errors;
    program = { first: r.answer.first, last: r.answer.last };
    if (nerrors === 0) {
      const dir = libPath.includes('/') ? libPath.slice(0, libPath.lastIndexOf('/')) || '/' : '.';
      nerrors += processDependencies(jq, jq.getAttr('JQ_ORIGIN'), dir, program, libState);
    }
  }
  libState.names.push(libPath);
  libState.defs.push(program);
  out.block = program;
  return nerrors;
}

function loadModuleMeta(jq, modRelpath) {
  const rel = validateRelpath(modRelpath);
  if (!isValid(rel)) return rel;
  const libPath = findLib(jq, rel, jq.libDirs(), '.jq', jq.getAttr('JQ_ORIGIN'), null);
  if (!isValid(libPath)) return libPath;
  let meta = null;
  const data = jq.host.loadFile(libPath, true);
  if (isValid(data)) {
    const src = new Locfile(jq, libPath, encodeUtf8(data));
    const r = jqParseLibrary(src);
    if (r.errors === 0) {
      const program = { first: r.answer.first, last: r.answer.last };
      meta = block_module_meta(program);
      if (meta === null) meta = new Map();
      meta = new Map(meta);
      meta.set('deps', block_take_imports(program));
    }
  }
  return meta;
}

function loadProgram(jq, src, out) {
  const libState = { names: [], defs: [] };
  const r = jqParse(src);
  if (r.errors) return r.errors;
  const program = { first: r.answer.first, last: r.answer.last };
  const nerrors = processDependencies(jq, jq.getAttr('JQ_ORIGIN'), jq.getAttr('PROGRAM_ORIGIN'), program, libState);
  let libs = gen_noop();
  for (let i = 0; i < libState.defs.length; i++) {
    if (nerrors === 0 && !block_is_const(libState.defs[i])) libs = block_join(libs, libState.defs[i]);
  }
  if (nerrors === 0) out.block = block_drop_unreferenced(block_join(libs, program));
  return nerrors;
}

export { dumpString, JqAbort, PRINT_INVALID, HAS_VARIABLE, UNKNOWN_LOCATION, K_INVALID, K_FALSE, K_TRUE, kindName, dtoaFmt, JvParser, JvInvalid, typeError, typeError2 };
