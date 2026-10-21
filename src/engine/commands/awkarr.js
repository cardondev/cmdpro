// gawk 5.1 associative arrays: the cint_array (HATs of mostly consecutive non-negative integers),
// int_array and str_array hash tables of cint_array.c, int_array.c and str_array.c, so elements are
// stored — and `for (k in a)` visits them — in the same order, plus assoc_list() sorting (array.c).
//
// Subscripts reach these routines as "sub" records built by the interpreter:
//   { s: string value, int: is_integer(), k: its integer value, kind: how str_array keeps it, v }
// kind: 'num' (an integral number), 'strnum' (user input), 'str', 'regex'.
// Elements are cells { v } whose v is a scalar value or a sub-array (AwkArray).

const NHAT = 10;
const INT32_BIT = 32;
const POW2 = [];
for (let i = 0; i <= 30; i++) POW2.push(2 ** i);
const THRESHOLD = POW2[NHAT + 1];
const STR_CHAIN_MAX = 2, INT_CHAIN_MAX = 2;
const SIZES = [13, 127, 1021, 8191, 16381, 32749, 65497, 131101, 262147, 524309, 1048583, 2097169,
  4194319, 8388617, 16777259, 33554467, 67108879, 134217757, 268435459, 536870923, 1073741827];

// assoc_kind_t
export const AK = { ANONE: 0, AINDEX: 1, AVALUE: 2, AINUM: 4, AISTR: 8, AVNUM: 16, AVSTR: 32, AASC: 64, ADESC: 128, ADELETE: 256 };

// ------------------------------------------------------------------- hashing
function awkHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i) & 255;
    if (c >= 128) c -= 256;               // plain char is signed
    h = (Math.imul(h, 65599) + c) >>> 0;
  }
  return h;
}
function intHash(k, hsize) {
  k >>>= 0;
  k = (k ^ (k << 3)) >>> 0;
  k = (k + (k >>> 5)) >>> 0;
  k = (k ^ (k << 4)) >>> 0;
  k = (k + (k >>> 17)) >>> 0;
  k = (k ^ (k << 25)) >>> 0;
  k = (k + (k >>> 6)) >>> 0;
  return k >= hsize ? k % hsize : k;
}
function cintHash(k) {
  if (k === 0) return NHAT;
  let num = k >>> 0;
  let r = (num > 0xffff ? 1 : 0) << 4; num >>>= r;
  let shift = (num > 0xff ? 1 : 0) << 3; num >>>= shift; r |= shift;
  shift = (num > 0x0f ? 1 : 0) << 2; num >>>= shift; r |= shift;
  shift = (num > 0x03 ? 1 : 0) << 1; num >>>= shift; r |= shift;
  r |= (num >>> 1);
  if (r < NHAT) return NHAT;
  return 1 + r;
}
const nextSize = (old) => { for (const s of SIZES) if (old < s) return s; return old; };

// ------------------------------------------------------------------- str_array
class StrImpl {
  constructor() { this.name = 'str'; this.buckets = null; this.arraySize = 0; this.tableSize = 0; this.maxed = false; }
  grow() {
    const oldsize = this.arraySize, newsize = nextSize(oldsize);
    if (newsize === oldsize) { this.maxed = true; return; }
    const old = this.buckets;
    const nb = new Array(newsize).fill(null);
    this.buckets = nb;
    this.arraySize = newsize;
    if (old === null) { this.tableSize = 0; return; }
    for (let k = 0; k < oldsize; k++) {
      for (let chain = old[k], next; chain !== null; chain = next) {
        next = chain.next;
        const h = chain.code % newsize;
        chain.next = nb[h];
        nb[h] = chain;
      }
    }
  }
  find(s, code, h) {
    for (let b = this.buckets[h]; b !== null; b = b.next) if (b.code === code && b.s === s) return b.cell;
    return null;
  }
  lookup(arr, sub) {
    if (this.buckets === null) this.grow();
    const code = awkHash(sub.s);
    let h = code % this.arraySize;
    const c = this.find(sub.s, code, h);
    if (c) return c;
    this.tableSize++;
    if (!this.maxed && Math.floor(this.tableSize / this.arraySize) > STR_CHAIN_MAX) {
      this.grow();
      h = code % this.arraySize;
    }
    const cell = { v: undefined };
    this.buckets[h] = { next: this.buckets[h], s: sub.s, code, kind: sub.kind, key: sub.v, cell };
    return cell;
  }
  exists(arr, sub) {
    if (this.tableSize === 0) return null;
    const code = awkHash(sub.s);
    return this.find(sub.s, code, code % this.arraySize);
  }
  remove(arr, sub) {
    if (this.tableSize === 0) return false;
    const h = awkHash(sub.s) % this.arraySize;
    for (let b = this.buckets[h], prev = null; b !== null; prev = b, b = b.next) {
      if (b.s !== sub.s) continue;
      if (prev !== null) prev.next = b.next; else this.buckets[h] = b.next;
      if (--this.tableSize === 0) arr.t = null;
      return true;
    }
    return false;
  }
  list(arr, kind, out) {
    for (let i = 0; i < this.arraySize; i++) {
      for (let b = this.buckets[i]; b !== null; b = b.next) {
        out.push({ ks: b.s, kn: null, key: keyValue(b), cell: b.cell });
        if ((kind & (AK.AINDEX | AK.AVALUE | AK.ADELETE)) === (AK.AINDEX | AK.ADELETE)) return;
      }
    }
  }
  each(fn) { for (let i = 0; i < this.arraySize; i++) for (let b = this.buckets[i]; b !== null; b = b.next) fn(b.cell); }
}
function keyValue(b) {
  switch (b.kind) {
    case 'num': return b.key;
    case 'strnum': return KEYMAKERS.strnum(b.s);
    case 'regex': return KEYMAKERS.regex(b.s);
    default: return b.s;
  }
}
// the interpreter provides the constructors for user-input and regexp keys
export const KEYMAKERS = { strnum: (s) => s, regex: (s) => s };

// ------------------------------------------------------------------- int_array
class IntImpl {
  constructor() { this.name = 'int'; this.buckets = null; this.arraySize = 0; this.tableSize = 0; this.maxed = false; this.xarray = null; }
  grow() {
    const oldsize = this.arraySize, newsize = nextSize(oldsize);
    if (newsize === oldsize) { this.maxed = true; return; }
    const old = this.buckets;
    this.buckets = new Array(newsize).fill(null);
    this.arraySize = newsize;
    if (old === null) return;
    for (let k = 0; k < oldsize; k++) {
      for (let chain = old[k]; chain !== null; chain = chain.next) {
        for (let i = 0; i < chain.count; i++) {
          const num = chain.nums[i];
          this.insert(num, intHash(num, newsize), chain.cells[i]);
        }
      }
    }
  }
  find(k, h) {
    for (let b = this.buckets[h]; b !== null; b = b.next) for (let i = 0; i < b.count; i++) if (b.nums[i] === k) return b.cells[i];
    return null;
  }
  insert(k, h, cell = { v: undefined }) {
    let b = this.buckets[h];
    let i;
    if (b === null || (i = b.count) === 2) {
      b = { next: this.buckets[h], nums: [0, 0], cells: [null, null], count: 0 };
      this.buckets[h] = b;
      i = 0;
    }
    b.nums[i] = k;
    b.cells[i] = cell;
    b.count++;
    return cell;
  }
  lookup(arr, sub) {
    if (!sub.int) {
      let xn = this.xarray;
      if (xn === null) xn = this.xarray = new AwkArray(arr.vname, null, true);
      else { const c = xn.exists(sub); if (c) return c; }
      this.tableSize++;
      return xn.lookup(sub);
    }
    const k = sub.k;
    if (this.buckets === null) this.grow();
    let h = intHash(k, this.arraySize);
    const c = this.find(k, h);
    if (c) return c;
    this.tableSize++;
    let size = this.tableSize;
    if (this.xarray) size -= this.xarray.size;
    if (!this.maxed && Math.floor(size / this.arraySize) > INT_CHAIN_MAX) {
      this.grow();
      h = intHash(k, this.arraySize);
    }
    return this.insert(k, h);
  }
  exists(arr, sub) {
    if (!sub.int) return this.xarray ? this.xarray.exists(sub) : null;
    if (this.buckets === null) return null;
    return this.find(sub.k, intHash(sub.k, this.arraySize));
  }
  remove(arr, sub) {
    const xn = this.xarray;
    if (this.tableSize === 0 || this.buckets === null) return false;
    if (!sub.int) {
      if (xn === null || !xn.remove(sub)) return false;
      if (xn.size === 0) this.xarray = null;
      this.tableSize--;
      return true;
    }
    const k = sub.k, h = intHash(k, this.arraySize);
    let b, prev = null, found = false;
    for (b = this.buckets[h]; b !== null; prev = b, b = b.next) {
      for (let i = 0; i < b.count; i++) {
        if (k !== b.nums[i]) continue;
        if (i === 0 && b.count === 2) { b.nums[0] = b.nums[1]; b.cells[0] = b.cells[1]; }
        found = true;
        break;
      }
      if (found) break;
    }
    if (!found) return false;
    b.count--;
    if (b.count === 0) {
      if (prev !== null) prev.next = b.next; else this.buckets[h] = b.next;
    } else if (b !== this.buckets[h]) {
      const head = this.buckets[h];
      const i = --head.count;
      b.nums[1] = head.nums[i];
      b.cells[1] = head.cells[i];
      b.count++;
      if (i === 0) this.buckets[h] = head.next;
    }
    this.tableSize--;
    if (xn === null && this.tableSize === 0) arr.t = null;
    else if (xn !== null && this.tableSize === xn.size) arr.t = xn.t;   // promote the non-integer part
    return true;
  }
  list(arr, kind, out) {
    if (this.xarray) {
      this.xarray.listRaw(kind, out);
      if ((kind & (AK.AINDEX | AK.AVALUE | AK.ADELETE)) === (AK.AINDEX | AK.ADELETE) || this.tableSize === this.xarray.size) return;
    }
    for (let i = 0; i < this.arraySize; i++) {
      for (let b = this.buckets[i]; b !== null; b = b.next) {
        for (let j = 0; j < b.count; j++) {
          const n = b.nums[j];
          out.push({ ks: String(n), kn: n, key: String(n), cell: b.cells[j] });
          if ((kind & (AK.AINDEX | AK.AVALUE | AK.ADELETE)) === (AK.AINDEX | AK.ADELETE)) return;
        }
      }
    }
  }
  each(fn) {
    if (this.xarray) this.xarray.each(fn);
    for (let i = 0; i < this.arraySize; i++) for (let b = this.buckets[i]; b !== null; b = b.next) for (let j = 0; j < b.count; j++) fn(b.cells[j]);
  }
}

// ------------------------------------------------------------------- cint_array
class Tree { constructor() { this.nodes = null; this.arrayBase = 0; this.arraySize = 0; this.tableSize = 0; this.half = false; } }
class Leaf { constructor() { this.nodes = null; this.arrayBase = 0; this.arraySize = 0; this.tableSize = 0; } }

class CintImpl {
  constructor() { this.name = 'cint'; this.nodes = null; this.tableSize = 0; this.capacity = 0; this.xarray = null; }
  find(k) {
    if (this.nodes === null) return null;
    const tn = this.nodes[cintHash(k)];
    return tn === null ? null : treeExists(tn, k);
  }
  lookup(arr, sub) {
    let k = -1, h1 = -1;
    if (sub.int && sub.k >= 0) {
      k = sub.k;
      h1 = cintHash(k);
      if (this.nodes !== null && this.nodes[h1] !== null) { const c = treeExists(this.nodes[h1], k); if (c) return c; }
    }
    let xn = this.xarray;
    if (xn !== null) { const c = xn.exists(sub); if (c) return c; }
    if (k >= 0) {
      const m = h1 - 1;
      let li = m > NHAT ? m : NHAT;
      while (li >= NHAT) li = Math.floor((li + 1) / 2);
      const capacity = this.capacity + POW2[li];
      const cintSize = xn === null ? this.tableSize : this.tableSize - xn.size;
      if (!(capacity - cintSize > THRESHOLD)) {
        if (this.nodes === null) { this.capacity = 0; this.nodes = new Array(INT32_BIT).fill(null); }
        this.tableSize++;
        let tn = this.nodes[h1];
        if (tn === null) tn = this.nodes[h1] = new Tree();
        if (m < NHAT) return treeLookup(this, tn, k, NHAT, 0);
        return treeLookup(this, tn, k, m, POW2[m]);
      }
    }
    // xinstall
    this.tableSize++;
    if (xn === null) {
      xn = this.xarray = new AwkArray(arr.vname, null, true);
      xn.t = sub.int ? new IntImpl() : new StrImpl();
    }
    return xn.lookup(sub);
  }
  exists(arr, sub) {
    if (sub.int && sub.k >= 0) { const c = this.find(sub.k); if (c) return c; }
    return this.xarray ? this.xarray.exists(sub) : null;
  }
  remove(arr, sub) {
    if (this.tableSize === 0) return false;
    let xn = this.xarray;
    if (sub.int && sub.k >= 0 && this.nodes !== null) {
      const k = sub.k, h1 = cintHash(k);
      const tn = this.nodes[h1];
      if (tn !== null && treeRemove(this, tn, k)) {
        if (tn.tableSize === 0) this.nodes[h1] = null;
        this.tableSize--;
        if (xn === null && this.tableSize === 0) arr.t = null;
        else if (xn !== null && this.tableSize === xn.size) arr.t = xn.t;   // promote
        return true;
      }
    }
    xn = this.xarray;
    if (xn === null || !xn.remove(sub)) return false;
    if (xn.size === 0) this.xarray = null;
    this.tableSize--;
    return true;
  }
  list(arr, kind, out, hint) {
    const single = (kind & (AK.AINDEX | AK.AVALUE | AK.ADELETE)) === (AK.AINDEX | AK.ADELETE);
    if (this.xarray) {
      this.xarray.listRaw(kind & ~(AK.AASC | AK.ADESC), out);
      hint.kind &= ~(AK.AASC | AK.ADESC);
      if (single || this.tableSize === this.xarray.size) return;
      kind &= ~(AK.AASC | AK.ADESC);
    }
    if ((kind & AK.AINUM) === 0) { kind &= ~(AK.AASC | AK.ADESC); hint.kind &= ~(AK.AASC | AK.ADESC); }
    const desc = (kind & AK.ADESC) !== 0;
    for (let n = NHAT; n < INT32_BIT; n++) {
      const j = desc ? INT32_BIT - 1 - (n - NHAT) : n;
      const tn = this.nodes[j];
      if (tn === null) continue;
      treeList(tn, kind, out);
      if (single && out.length) return;
    }
  }
  each(fn) {
    if (this.xarray) this.xarray.each(fn);
    if (this.nodes) for (let j = NHAT; j < INT32_BIT; j++) if (this.nodes[j]) treeEach(this.nodes[j], fn);
  }
}

function treeLookup(sym, tree, k, m, base) {
  const n = Math.floor((m + 1) / 2);
  let size;
  if (tree.tableSize === 0) {
    size = POW2[n];
    let actual = size;
    tree.arrayBase = base;
    tree.arraySize = size;
    tree.tableSize = 0;
    tree.half = false;
    if (n > Math.floor(m / 2)) { actual /= 2; tree.half = true; }
    tree.nodes = new Array(actual).fill(null);
  } else size = tree.arraySize;
  const i = Math.floor((k - tree.arrayBase) / size);
  const tf = tree.nodes[i];
  if (tf !== null) {
    const c = tf instanceof Tree ? treeExists(tf, k) : leafExists(tf, k);
    if (c) return c;
  }
  tree.tableSize++;
  base += size * i;
  let tn = tree.nodes[i];
  if (n > NHAT) {
    if (tn === null) tn = tree.nodes[i] = new Tree();
    return treeLookup(sym, tn, k, n, base);
  }
  if (tn === null) tn = tree.nodes[i] = new Leaf();
  return leafLookup(sym, tn, k, size, base);
}
function treeExists(tree, k) {
  if (tree.nodes === null) return null;
  const i = Math.floor((k - tree.arrayBase) / tree.arraySize);
  const tn = tree.nodes[i];
  if (tn === null || tn === undefined) return null;
  return tn instanceof Tree ? treeExists(tn, k) : leafExists(tn, k);
}
function treeRemove(sym, tree, k) {
  if (tree.nodes === null) return false;
  const i = Math.floor((k - tree.arrayBase) / tree.arraySize);
  const tn = tree.nodes[i];
  if (tn === null || tn === undefined) return false;
  if (tn instanceof Tree) { if (!treeRemove(sym, tn, k)) return false; }
  else if (!leafRemove(sym, tn, k)) return false;
  if (tn.tableSize === 0) tree.nodes[i] = null;
  if (--tree.tableSize === 0) { tree.nodes = null; tree.arrayBase = 0; tree.arraySize = 0; tree.half = false; }
  return true;
}
function treeList(tree, kind, out) {
  const hsize = tree.half ? tree.arraySize / 2 : tree.arraySize;
  const desc = (kind & AK.ADESC) !== 0;
  for (let j = 0; j < hsize; j++) {
    const tn = tree.nodes[desc ? hsize - 1 - j : j];
    if (tn === null) continue;
    if (tn instanceof Tree) treeList(tn, kind, out); else leafList(tn, kind, out);
    if ((kind & AK.ADELETE) !== 0 && out.length >= 1) return;
  }
}
function treeEach(tree, fn) {
  const hsize = tree.half ? tree.arraySize / 2 : tree.arraySize;
  for (let j = 0; j < hsize; j++) {
    const tn = tree.nodes[j];
    if (tn === null) continue;
    if (tn instanceof Tree) treeEach(tn, fn); else for (const c of tn.nodes) if (c) fn(c);
  }
}
function leafLookup(sym, a, k, size, base) {
  if (a.nodes === null) {
    a.tableSize = 0;
    a.arraySize = size;
    a.arrayBase = base;
    a.nodes = new Array(size).fill(null);
    sym.capacity += size;
  }
  const i = k - base;
  if (a.nodes[i] === null) { a.tableSize++; a.nodes[i] = { v: undefined }; }
  return a.nodes[i];
}
function leafExists(a, k) {
  if (a.nodes === null) return null;
  return a.nodes[k - a.arrayBase] || null;
}
function leafRemove(sym, a, k) {
  const i = k - a.arrayBase;
  if (a.nodes === null || a.nodes[i] === null) return false;
  a.nodes[i] = null;
  if (--a.tableSize === 0) { a.nodes = null; sym.capacity -= a.arraySize; a.arraySize = 0; }
  return true;
}
function leafList(a, kind, out) {
  const size = a.arraySize;
  const desc = (kind & AK.ADESC) !== 0;
  for (let i = 0; i < size; i++) {
    const ci = desc ? size - 1 - i : i;
    const c = a.nodes[ci];
    if (c === null) continue;
    const num = a.arrayBase + ci;
    out.push({ ks: String(num), kn: num, key: String(num), cell: c });
  }
}

// ------------------------------------------------------------------- the array node
export class AwkArray {
  constructor(vname = '', parent = null, xarray = false) {
    this.vname = vname;
    this.parent = parent;
    this.xarr = xarray;
    this.t = null;     // null_array until the first subscript chooses the kind
  }
  get size() { return this.t ? this.t.tableSize : 0; }
  get kindName() { return this.t ? this.t.name : 'null'; }
  lookup(sub) {
    if (this.t === null) this.t = sub.int ? (sub.k >= 0 ? new CintImpl() : new IntImpl()) : new StrImpl();
    return this.t.lookup(this, sub);
  }
  exists(sub) { return this.t ? this.t.exists(this, sub) : null; }
  remove(sub) { return this.t ? this.t.remove(this, sub) : false; }
  clear() { this.t = null; }
  each(fn) { if (this.t) this.t.each(fn); }
  listRaw(kind, out, hint = { kind }) { if (this.t) this.t.list(this, kind, out, hint); return out; }
}

// ------------------------------------------------------------------- sorting (assoc_list)
// rt: { cmpNumbers(a, b), num(v), str(v), isNumeric(v), callCompare(fname, entryA, entryB), ignoreCase() }
const SORT_FUNCS = {
  '@ind_str_asc': ['upIndexString', AK.AINDEX | AK.AISTR | AK.AASC],
  '@ind_num_asc': ['upIndexNumber', AK.AINDEX | AK.AINUM | AK.AASC],
  '@val_str_asc': ['upValueString', AK.AVALUE | AK.AVSTR | AK.AASC],
  '@val_num_asc': ['upValueNumber', AK.AVALUE | AK.AVNUM | AK.AASC],
  '@ind_str_desc': ['downIndexString', AK.AINDEX | AK.AISTR | AK.ADESC],
  '@ind_num_desc': ['downIndexNumber', AK.AINDEX | AK.AINUM | AK.ADESC],
  '@val_str_desc': ['downValueString', AK.AVALUE | AK.AVSTR | AK.ADESC],
  '@val_num_desc': ['downValueNumber', AK.AVALUE | AK.AVNUM | AK.ADESC],
  '@val_type_asc': ['upValueType', AK.AVALUE | AK.AASC],
  '@val_type_desc': ['downValueType', AK.AVALUE | AK.ADESC],
  '@unsorted': [null, AK.AINDEX],
};

// glibc msort (stable top-down merge sort)
export function msort(list, cmp) {
  const tmp = new Array(list.length);
  const rec = (lo, n) => {
    if (n <= 1) return;
    const n1 = Math.floor(n / 2), n2 = n - n1;
    rec(lo, n1);
    rec(lo + n1, n2);
    let a = lo, b = lo + n1, ea = lo + n1, eb = lo + n, k = 0;
    while (a < ea && b < eb) {
      if (cmp(list[a], list[b]) <= 0) tmp[k++] = list[a++];
      else tmp[k++] = list[b++];
    }
    while (a < ea) tmp[k++] = list[a++];
    for (let i = 0; i < k; i++) list[lo + i] = tmp[i];
  };
  rec(0, list.length);
  return list;
}

export function cmpStrings(s1, s2, ignoreCase) {
  const len1 = s1.length, len2 = s2.length;
  if (len1 === 0) return len2 === 0 ? 0 : -1;
  if (len2 === 0) return 1;
  const lmin = len1 < len2 ? len1 : len2;
  if (ignoreCase) {
    for (let i = 0; i < lmin; i++) {
      const d = lowerC(s1.charCodeAt(i)) - lowerC(s2.charCodeAt(i));
      if (d !== 0) return d;
    }
  }
  for (let i = 0; i < lmin; i++) {
    const d = s1.charCodeAt(i) - s2.charCodeAt(i);
    if (d !== 0) return d;
  }
  if (len1 === len2) return 0;
  return len1 < len2 ? -1 : 1;
}
const lowerC = (c) => (c >= 65 && c <= 90 ? c + 32 : c);

// returns the list of entries { key, ks, kn, cell } in iteration order
export function assocList(arr, sortStr, ctxt, rt) {
  let cmp = null, kind = AK.ANONE;
  let userFn = null;
  const sf = Object.prototype.hasOwnProperty.call(SORT_FUNCS, sortStr) ? SORT_FUNCS[sortStr] : null;
  if (sf) {
    cmp = sf[0];
    kind = sf[1];
    if (arr.kindName !== 'cint') kind &= ~(AK.AASC | AK.ADESC);
    if (ctxt !== 'SORTED_IN' || (kind & AK.AVALUE) !== 0) kind |= AK.AINDEX | AK.AVALUE;
  } else {
    if (sortStr === '' || /\s/.test(sortStr)) throw rt.fatal(`\`${sortStr}' is invalid as a function name`);
    if (!rt.isFunction(sortStr)) throw rt.fatal(`sort comparison function \`${sortStr}' is not defined`);
    userFn = sortStr;
    kind |= AK.AVALUE | AK.AINDEX;
  }
  const hint = { kind };
  const list = arr.listRaw(kind, [], hint);
  kind = hint.kind;
  if (list.length && (cmp || userFn) && (kind & (AK.AASC | AK.ADESC)) === 0) {
    const ic = rt.ignoreCase();
    const kn = (e) => (e.kn !== null ? e.kn : (e.kn = rt.num(e.key)));
    const upIndexString = (a, b) => cmpStrings(a.ks, b.ks, ic);
    const upIndexNumber = (a, b) => rt.cmpNumbers(kn(a), kn(b)) || cmpStrings(a.ks, b.ks, ic);
    const isArr = (v) => v !== null && typeof v === 'object' && v instanceof AwkArray;
    const upValueType = (a, b) => {
      const n1 = a.cell.v, n2 = b.cell.v;
      let rc;
      if (isArr(n1)) rc = isArr(n2) ? 0 : 1;
      else if (isArr(n2)) rc = -1;
      else {
        const num1 = rt.isNumeric(n1), num2 = rt.isNumeric(n2);
        if (num1 && num2) rc = rt.cmpNumbers(rt.num(n1), rt.num(n2));
        else if (num1 && rt.isString(n2)) rc = -1;
        else if (rt.isString(n1) && num2) rc = 1;
        else rc = cmpStrings(rt.str(n1), rt.str(n2), ic);
      }
      return rc || upIndexString(a, b);
    };
    const upValueString = (a, b) => {
      const n1 = a.cell.v, n2 = b.cell.v;
      if (isArr(n1) || isArr(n2)) return upValueType(a, b);
      return cmpStrings(rt.str(n1), rt.str(n2), ic) || upIndexString(a, b);
    };
    const upValueNumber = (a, b) => {
      const n1 = a.cell.v, n2 = b.cell.v;
      if (isArr(n1) || isArr(n2)) return upValueType(a, b);
      return rt.cmpNumbers(rt.num(n1), rt.num(n2)) || cmpStrings(rt.str(n1), rt.str(n2), ic) || upIndexString(a, b);
    };
    const fns = {
      upIndexString, upIndexNumber, upValueString, upValueNumber, upValueType,
      downIndexString: (a, b) => -upIndexString(a, b),
      downIndexNumber: (a, b) => -upIndexNumber(a, b),
      downValueString: (a, b) => -upValueString(a, b),
      downValueNumber: (a, b) => -upValueNumber(a, b),
      downValueType: (a, b) => -upValueType(a, b),
    };
    if (userFn) msort(list, (a, b) => rt.callCompare(userFn, a, b));
    else msort(list, fns[cmp]);
  }
  return list;
}
