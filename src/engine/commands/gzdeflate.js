// The deflate compressor of GNU gzip 1.10 (deflate.c, trees.c, bits.c), ported so that gzip and
// tar -z produce byte-identical output. Input and output are byte strings.
//   Copyright (C) 1999, 2006, 2009-2018 Free Software Foundation, Inc.
//   Copyright (C) 1992-1993 Jean-loup Gailly
//   GNU gzip is free software under the GNU GPL version 3 or later.

const WSIZE = 0x8000;
const WINDOW_SIZE = 2 * WSIZE;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const WMASK = WSIZE - 1;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1;
const MAX_DIST = WSIZE - MIN_LOOKAHEAD;
const H_SHIFT = Math.floor((HASH_BITS + MIN_MATCH - 1) / MIN_MATCH);
const TOO_FAR = 4096;
const NIL = 0;

const CONFIG = [
  [0, 0, 0, 0], [4, 4, 8, 4], [4, 5, 16, 8], [4, 6, 32, 32],
  [4, 4, 16, 16], [8, 16, 32, 32], [8, 16, 128, 128], [8, 32, 128, 256],
  [32, 128, 258, 1024], [32, 258, 258, 4096],
];

// ---------------------------------------------------------------- trees.c constants
const MAX_BITS = 15, MAX_BL_BITS = 7, LENGTH_CODES = 29, LITERALS = 256, END_BLOCK = 256;
const L_CODES = LITERALS + 1 + LENGTH_CODES, D_CODES = 30, BL_CODES = 19;
const EXTRA_LBITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const EXTRA_DBITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const EXTRA_BLBITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7];
const LIT_BUFSIZE = 0x8000, DIST_BUFSIZE = LIT_BUFSIZE;
const REP_3_6 = 16, REPZ_3_10 = 17, REPZ_11_138 = 18;
const HEAP_SIZE = 2 * L_CODES + 1;
const BL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function biReverse(code, len) {
  let res = 0;
  do { res |= code & 1; code >>>= 1; res <<= 1; } while (--len > 0);
  return res >>> 1;
}

// a tree: freq/code share storage in C (as do dad/len); separate arrays behave the same here
const mkTree = (n) => ({ freq: new Uint16Array(n), code: new Uint16Array(n), dad: new Uint16Array(n), len: new Uint16Array(n) });

// static tables (ct_init)
const LENGTH_CODE = new Uint8Array(MAX_MATCH - MIN_MATCH + 1);
const DIST_CODE = new Uint8Array(512);
const BASE_LENGTH = new Int32Array(LENGTH_CODES);
const BASE_DIST = new Int32Array(D_CODES);
const STATIC_LTREE = mkTree(L_CODES + 2);
const STATIC_DTREE = mkTree(D_CODES);
(function ctInit() {
  let length = 0, code;
  for (code = 0; code < LENGTH_CODES - 1; code++) {
    BASE_LENGTH[code] = length;
    for (let n = 0; n < (1 << EXTRA_LBITS[code]); n++) LENGTH_CODE[length++] = code;
  }
  LENGTH_CODE[length - 1] = code;
  let dist = 0;
  for (code = 0; code < 16; code++) {
    BASE_DIST[code] = dist;
    for (let n = 0; n < (1 << EXTRA_DBITS[code]); n++) DIST_CODE[dist++] = code;
  }
  dist >>= 7;
  for (; code < D_CODES; code++) {
    BASE_DIST[code] = dist << 7;
    for (let n = 0; n < (1 << (EXTRA_DBITS[code] - 7)); n++) DIST_CODE[256 + dist++] = code;
  }
  const blCount = new Uint16Array(MAX_BITS + 1);
  let n = 0;
  while (n <= 143) { STATIC_LTREE.len[n++] = 8; blCount[8]++; }
  while (n <= 255) { STATIC_LTREE.len[n++] = 9; blCount[9]++; }
  while (n <= 279) { STATIC_LTREE.len[n++] = 7; blCount[7]++; }
  while (n <= 287) { STATIC_LTREE.len[n++] = 8; blCount[8]++; }
  genCodes(STATIC_LTREE, L_CODES + 1, blCount);
  for (n = 0; n < D_CODES; n++) { STATIC_DTREE.len[n] = 5; STATIC_DTREE.code[n] = biReverse(n, 5); }
})();

function genCodes(tree, maxCode, blCount) {
  const nextCode = new Uint16Array(MAX_BITS + 1);
  let code = 0;
  for (let bits = 1; bits <= MAX_BITS; bits++) nextCode[bits] = code = ((code + blCount[bits - 1]) << 1) & 0xffff;
  for (let n = 0; n <= maxCode; n++) {
    const len = tree.len[n];
    if (len === 0) continue;
    tree.code[n] = biReverse(nextCode[len]++, len);
  }
}

const dCode = (dist) => (dist < 256 ? DIST_CODE[dist] : DIST_CODE[256 + (dist >> 7)]);

export function gzipDeflate(input, level = 6) {
  // ---- output (bits.c)
  const out = [];
  let biBuf = 0, biValid = 0;
  const putByte = (b) => out.push(b & 0xff);
  const putShort = (w) => { out.push(w & 0xff, (w >>> 8) & 0xff); };
  const sendBits = (value, length) => {
    if (biValid > 16 - length) {
      biBuf = (biBuf | (value << biValid)) & 0xffff;
      putShort(biBuf);
      biBuf = (value & 0xffff) >>> (16 - biValid);
      biValid += length - 16;
    } else {
      biBuf = (biBuf | (value << biValid)) & 0xffff;
      biValid += length;
    }
  };
  const biWindup = () => {
    if (biValid > 8) putShort(biBuf);
    else if (biValid > 0) putByte(biBuf);
    biBuf = 0;
    biValid = 0;
  };
  const copyBlock = (buf, len, header) => {
    biWindup();
    if (header) { putShort(len); putShort(~len & 0xffff); }
    for (let i = 0; i < len; i++) putByte(window[buf + i]);
  };

  // ---- input
  let inPos = 0;
  const readBuf = (dst, off, size) => {
    const n = Math.min(size, input.length - inPos);
    for (let i = 0; i < n; i++) dst[off + i] = input.charCodeAt(inPos + i);
    inPos += n;
    return n;
  };

  // ---- trees.c state
  const dynLtree = mkTree(HEAP_SIZE), dynDtree = mkTree(2 * D_CODES + 1), blTree = mkTree(2 * BL_CODES + 1);
  const lDesc = { tree: dynLtree, stree: STATIC_LTREE, extra: EXTRA_LBITS, base: LITERALS + 1, elems: L_CODES, maxLength: MAX_BITS, maxCode: 0 };
  const dDesc = { tree: dynDtree, stree: STATIC_DTREE, extra: EXTRA_DBITS, base: 0, elems: D_CODES, maxLength: MAX_BITS, maxCode: 0 };
  const blDesc = { tree: blTree, stree: null, extra: EXTRA_BLBITS, base: 0, elems: BL_CODES, maxLength: MAX_BL_BITS, maxCode: 0 };
  const blCount = new Uint16Array(MAX_BITS + 1);
  const heap = new Int32Array(2 * L_CODES + 1);
  let heapLen = 0, heapMax = 0;
  const depth = new Uint8Array(2 * L_CODES + 1);
  const lBuf = new Uint8Array(LIT_BUFSIZE);
  const dBuf = new Uint16Array(DIST_BUFSIZE);
  const flagBuf = new Uint8Array(LIT_BUFSIZE / 8);
  let lastLit = 0, lastDist = 0, lastFlags = 0, flags = 0, flagBit = 1;
  let optLen = 0, staticLen = 0, compressedLen = 0;

  const initBlock = () => {
    for (let n = 0; n < L_CODES; n++) dynLtree.freq[n] = 0;
    for (let n = 0; n < D_CODES; n++) dynDtree.freq[n] = 0;
    for (let n = 0; n < BL_CODES; n++) blTree.freq[n] = 0;
    dynLtree.freq[END_BLOCK] = 1;
    optLen = staticLen = 0;
    lastLit = lastDist = lastFlags = 0;
    flags = 0; flagBit = 1;
  };
  const smaller = (tree, n, m) => tree.freq[n] < tree.freq[m] || (tree.freq[n] === tree.freq[m] && depth[n] <= depth[m]);
  const pqdownheap = (tree, k) => {
    const v = heap[k];
    let j = k << 1;
    while (j <= heapLen) {
      if (j < heapLen && smaller(tree, heap[j + 1], heap[j])) j++;
      if (smaller(tree, v, heap[j])) break;
      heap[k] = heap[j]; k = j;
      j <<= 1;
    }
    heap[k] = v;
  };
  const genBitlen = (desc) => {
    const tree = desc.tree, extra = desc.extra, base = desc.base, maxCode = desc.maxCode, maxLength = desc.maxLength, stree = desc.stree;
    let overflow = 0;
    blCount.fill(0);
    tree.len[heap[heapMax]] = 0;
    let h;
    for (h = heapMax + 1; h < HEAP_SIZE; h++) {
      const n = heap[h];
      let bits = tree.len[tree.dad[n]] + 1;
      if (bits > maxLength) { bits = maxLength; overflow++; }
      tree.len[n] = bits;
      if (n > maxCode) continue;
      blCount[bits]++;
      let xbits = 0;
      if (n >= base) xbits = extra[n - base];
      const f = tree.freq[n];
      optLen += f * (bits + xbits);
      if (stree) staticLen += f * (stree.len[n] + xbits);
    }
    if (overflow === 0) return;
    do {
      let bits = maxLength - 1;
      while (blCount[bits] === 0) bits--;
      blCount[bits]--;
      blCount[bits + 1] += 2;
      blCount[maxLength]--;
      overflow -= 2;
    } while (overflow > 0);
    for (let bits = maxLength; bits !== 0; bits--) {
      let n = blCount[bits];
      while (n !== 0) {
        const m = heap[--h];
        if (m > maxCode) continue;
        if (tree.len[m] !== bits) {
          optLen += (bits - tree.len[m]) * tree.freq[m];
          tree.len[m] = bits;
        }
        n--;
      }
    }
  };
  const buildTree = (desc) => {
    const tree = desc.tree, stree = desc.stree, elems = desc.elems;
    let maxCode = -1, node = elems;
    heapLen = 0; heapMax = HEAP_SIZE;
    for (let n = 0; n < elems; n++) {
      if (tree.freq[n] !== 0) { heap[++heapLen] = maxCode = n; depth[n] = 0; }
      else tree.len[n] = 0;
    }
    while (heapLen < 2) {
      const nw = heap[++heapLen] = (maxCode < 2 ? ++maxCode : 0);
      tree.freq[nw] = 1;
      depth[nw] = 0;
      optLen--;
      if (stree) staticLen -= stree.len[nw];
    }
    desc.maxCode = maxCode;
    for (let n = heapLen >> 1; n >= 1; n--) pqdownheap(tree, n);
    do {
      const n = heap[1];
      heap[1] = heap[heapLen--];
      pqdownheap(tree, 1);
      const m = heap[1];
      heap[--heapMax] = n;
      heap[--heapMax] = m;
      tree.freq[node] = tree.freq[n] + tree.freq[m];
      depth[node] = Math.max(depth[n], depth[m]) + 1;
      tree.dad[n] = tree.dad[m] = node;
      heap[1] = node++;
      pqdownheap(tree, 1);
    } while (heapLen >= 2);
    heap[--heapMax] = heap[1];
    genBitlen(desc);
    genCodes(tree, maxCode, blCount);
  };
  const scanTree = (tree, maxCode) => {
    let prevlen = -1, nextlen = tree.len[0], count = 0, maxCount = 7, minCount = 4;
    if (nextlen === 0) { maxCount = 138; minCount = 3; }
    tree.len[maxCode + 1] = 0xffff;
    for (let n = 0; n <= maxCode; n++) {
      const curlen = nextlen;
      nextlen = tree.len[n + 1];
      if (++count < maxCount && curlen === nextlen) continue;
      else if (count < minCount) blTree.freq[curlen] += count;
      else if (curlen !== 0) {
        if (curlen !== prevlen) blTree.freq[curlen]++;
        blTree.freq[REP_3_6]++;
      } else if (count <= 10) blTree.freq[REPZ_3_10]++;
      else blTree.freq[REPZ_11_138]++;
      count = 0; prevlen = curlen;
      if (nextlen === 0) { maxCount = 138; minCount = 3; }
      else if (curlen === nextlen) { maxCount = 6; minCount = 3; }
      else { maxCount = 7; minCount = 4; }
    }
  };
  const sendCode = (c, tree) => sendBits(tree.code[c], tree.len[c]);
  const sendTree = (tree, maxCode) => {
    let prevlen = -1, nextlen = tree.len[0], count = 0, maxCount = 7, minCount = 4;
    if (nextlen === 0) { maxCount = 138; minCount = 3; }
    for (let n = 0; n <= maxCode; n++) {
      const curlen = nextlen;
      nextlen = tree.len[n + 1];
      if (++count < maxCount && curlen === nextlen) continue;
      else if (count < minCount) { do { sendCode(curlen, blTree); } while (--count !== 0); }
      else if (curlen !== 0) {
        if (curlen !== prevlen) { sendCode(curlen, blTree); count--; }
        sendCode(REP_3_6, blTree); sendBits(count - 3, 2);
      } else if (count <= 10) { sendCode(REPZ_3_10, blTree); sendBits(count - 3, 3); }
      else { sendCode(REPZ_11_138, blTree); sendBits(count - 11, 7); }
      count = 0; prevlen = curlen;
      if (nextlen === 0) { maxCount = 138; minCount = 3; }
      else if (curlen === nextlen) { maxCount = 6; minCount = 3; }
      else { maxCount = 7; minCount = 4; }
    }
  };
  const buildBlTree = () => {
    scanTree(dynLtree, lDesc.maxCode);
    scanTree(dynDtree, dDesc.maxCode);
    buildTree(blDesc);
    let maxBlindex;
    for (maxBlindex = BL_CODES - 1; maxBlindex >= 3; maxBlindex--) if (blTree.len[BL_ORDER[maxBlindex]] !== 0) break;
    optLen += 3 * (maxBlindex + 1) + 5 + 5 + 4;
    return maxBlindex;
  };
  const sendAllTrees = (lcodes, dcodes, blcodes) => {
    sendBits(lcodes - 257, 5);
    sendBits(dcodes - 1, 5);
    sendBits(blcodes - 4, 4);
    for (let rank = 0; rank < blcodes; rank++) sendBits(blTree.len[BL_ORDER[rank]], 3);
    sendTree(dynLtree, lcodes - 1);
    sendTree(dynDtree, dcodes - 1);
  };
  const compressBlock = (ltree, dtree) => {
    let lx = 0, dx = 0, fx = 0, flag = 0;
    if (lastLit !== 0) do {
      if ((lx & 7) === 0) flag = flagBuf[fx++];
      let lc = lBuf[lx++];
      if ((flag & 1) === 0) sendCode(lc, ltree);
      else {
        let code = LENGTH_CODE[lc];
        sendCode(code + LITERALS + 1, ltree);
        let extra = EXTRA_LBITS[code];
        if (extra !== 0) { lc -= BASE_LENGTH[code]; sendBits(lc, extra); }
        let dist = dBuf[dx++];
        code = dCode(dist);
        sendCode(code, dtree);
        extra = EXTRA_DBITS[code];
        if (extra !== 0) { dist -= BASE_DIST[code]; sendBits(dist, extra); }
      }
      flag >>= 1;
    } while (lx < lastLit);
    sendCode(END_BLOCK, ltree);
  };
  const flushBlock = (buf, storedLen, pad, eof) => {
    flagBuf[lastFlags] = flags;
    buildTree(lDesc);
    buildTree(dDesc);
    const maxBlindex = buildBlTree();
    let optLenb = Math.floor((optLen + 3 + 7) / 8);
    const staticLenb = Math.floor((staticLen + 3 + 7) / 8);
    if (staticLenb <= optLenb) optLenb = staticLenb;
    if (storedLen + 4 <= optLenb && buf !== null) {
      sendBits(eof, 3);
      compressedLen = Math.floor((compressedLen + 3 + 7) / 8) * 8;
      compressedLen += (storedLen + 4) * 8;
      copyBlock(buf, storedLen, 1);
    } else if (staticLenb === optLenb) {
      sendBits((1 << 1) + eof, 3);
      compressBlock(STATIC_LTREE, STATIC_DTREE);
      compressedLen += 3 + staticLen;
    } else {
      sendBits((2 << 1) + eof, 3);
      sendAllTrees(lDesc.maxCode + 1, dDesc.maxCode + 1, maxBlindex + 1);
      compressBlock(dynLtree, dynDtree);
      compressedLen += 3 + optLen;
    }
    initBlock();
    if (eof) {
      biWindup();
      compressedLen += 7;
    } else if (pad && (compressedLen % 8) !== 0) {
      sendBits(eof, 3);
      compressedLen = Math.floor((compressedLen + 3 + 7) / 8) * 8;
      copyBlock(buf, 0, 1);
    }
  };

  // ---- deflate.c state
  const window = new Uint8Array(WINDOW_SIZE);
  const prev = new Uint16Array(WSIZE);
  const head = new Uint16Array(HASH_SIZE);
  let insH = 0, prevLength = 0, strstart = 0, matchStart = 0, eofile = false, lookahead = 0, blockStart = 0;
  const [goodMatch, maxLazyMatch, niceMatch, maxChainLength] = CONFIG[level];

  const ctTally = (dist, lc) => {
    lBuf[lastLit++] = lc;
    if (dist === 0) dynLtree.freq[lc]++;
    else {
      dist--;
      dynLtree.freq[LENGTH_CODE[lc] + LITERALS + 1]++;
      dynDtree.freq[dCode(dist)]++;
      dBuf[lastDist++] = dist;
      flags |= flagBit;
    }
    flagBit = (flagBit << 1) & 0xff;
    if ((lastLit & 7) === 0) {
      flagBuf[lastFlags++] = flags;
      flags = 0; flagBit = 1;
    }
    if (level > 2 && (lastLit & 0xfff) === 0) {
      let outLength = lastLit * 8;
      const inLength = strstart - blockStart;
      for (let dcode = 0; dcode < D_CODES; dcode++) outLength += dynDtree.freq[dcode] * (5 + EXTRA_DBITS[dcode]);
      outLength = Math.floor(outLength / 8);
      if (lastDist < (lastLit >>> 1) && outLength < Math.floor(inLength / 2)) return 1;
    }
    return lastLit === LIT_BUFSIZE - 1 || lastDist === DIST_BUFSIZE ? 1 : 0;
  };

  const updateHash = (h, c) => ((h << H_SHIFT) ^ c) & HASH_MASK;
  // INSERT_STRING: returns the previous head of the chain
  const insertString = (s) => {
    insH = updateHash(insH, window[s + MIN_MATCH - 1]);
    const mh = head[insH];
    prev[s & WMASK] = mh;
    head[insH] = s;
    return mh;
  };

  const longestMatch = (curMatch) => {
    let chainLength = maxChainLength;
    let scan = strstart;
    let bestLen = prevLength;
    const limit = strstart > MAX_DIST ? strstart - MAX_DIST : NIL;
    const strend = strstart + MAX_MATCH;
    let scanEnd1 = window[scan + bestLen - 1];
    let scanEnd = window[scan + bestLen];
    if (prevLength >= goodMatch) chainLength >>= 2;
    do {
      let match = curMatch;
      if (window[match + bestLen] !== scanEnd || window[match + bestLen - 1] !== scanEnd1 ||
          window[match] !== window[scan] || window[++match] !== window[scan + 1]) continue;
      let s = scan + 2;
      match++;
      // compare up to strend (the C loop compares 8 bytes per round, checking strend every 8th)
      while (window[++s] === window[++match] && window[++s] === window[++match] &&
             window[++s] === window[++match] && window[++s] === window[++match] &&
             window[++s] === window[++match] && window[++s] === window[++match] &&
             window[++s] === window[++match] && window[++s] === window[++match] &&
             s < strend);
      const len = MAX_MATCH - (strend - s);
      if (len > bestLen) {
        matchStart = curMatch;
        bestLen = len;
        if (len >= niceMatch) break;
        scanEnd1 = window[scan + bestLen - 1];
        scanEnd = window[scan + bestLen];
      }
    } while ((curMatch = prev[curMatch & WMASK]) > limit && --chainLength !== 0);
    return bestLen;
  };

  const fillWindow = () => {
    let more = WINDOW_SIZE - lookahead - strstart;
    if (strstart >= WSIZE + MAX_DIST) {
      window.copyWithin(0, WSIZE, WSIZE + WSIZE);
      matchStart -= WSIZE;
      strstart -= WSIZE;
      blockStart -= WSIZE;
      for (let n = 0; n < HASH_SIZE; n++) { const m = head[n]; head[n] = m >= WSIZE ? m - WSIZE : NIL; }
      for (let n = 0; n < WSIZE; n++) { const m = prev[n]; prev[n] = m >= WSIZE ? m - WSIZE : NIL; }
      more += WSIZE;
    }
    if (!eofile) {
      const n = readBuf(window, strstart + lookahead, more);
      if (n === 0) {
        eofile = true;
        for (let k = 0; k < MIN_MATCH - 1; k++) window[strstart + lookahead + k] = 0;
      } else lookahead += n;
    }
  };

  const FLUSH_BLOCK = (eof, flush) => flushBlock(blockStart >= 0 ? blockStart : null, strstart - blockStart, flush - 1, eof);

  // lm_init
  initBlock();
  lookahead = readBuf(window, 0, 2 * WSIZE);
  if (lookahead === 0) { eofile = true; lookahead = 0; }
  else {
    eofile = false;
    while (lookahead < MIN_LOOKAHEAD && !eofile) fillWindow();
    insH = 0;
    for (let j = 0; j < MIN_MATCH - 1; j++) insH = updateHash(insH, window[j]);
  }

  if (level <= 3) {
    // deflate_fast
    let flush = 0, matchLength = 0;
    prevLength = MIN_MATCH - 1;
    while (lookahead !== 0) {
      const hashHead = insertString(strstart);
      if (hashHead !== NIL && strstart - hashHead <= MAX_DIST && strstart <= WINDOW_SIZE - MIN_LOOKAHEAD) {
        matchLength = longestMatch(hashHead);
        if (matchLength > lookahead) matchLength = lookahead;
      }
      if (matchLength >= MIN_MATCH) {
        flush = ctTally(strstart - matchStart, matchLength - MIN_MATCH);
        lookahead -= matchLength;
        if (matchLength <= maxLazyMatch) {
          matchLength--;
          do { strstart++; insertString(strstart); } while (--matchLength !== 0);
          strstart++;
        } else {
          strstart += matchLength;
          matchLength = 0;
          insH = window[strstart];
          insH = updateHash(insH, window[strstart + 1]);
        }
      } else {
        flush = ctTally(0, window[strstart]);
        lookahead--;
        strstart++;
      }
      if (flush) { FLUSH_BLOCK(0, flush); blockStart = strstart; }
      while (lookahead < MIN_LOOKAHEAD && !eofile) fillWindow();
    }
    FLUSH_BLOCK(1, flush);
  } else {
    let flush = 0, matchAvailable = false, matchLength = MIN_MATCH - 1, prevMatch = 0;
    while (lookahead !== 0) {
      const hashHead = insertString(strstart);
      prevLength = matchLength; prevMatch = matchStart;
      matchLength = MIN_MATCH - 1;
      if (hashHead !== NIL && prevLength < maxLazyMatch && strstart - hashHead <= MAX_DIST && strstart <= WINDOW_SIZE - MIN_LOOKAHEAD) {
        matchLength = longestMatch(hashHead);
        if (matchLength > lookahead) matchLength = lookahead;
        if (matchLength === MIN_MATCH && strstart - matchStart > TOO_FAR) matchLength--;
      }
      if (prevLength >= MIN_MATCH && matchLength <= prevLength) {
        flush = ctTally(strstart - 1 - prevMatch, prevLength - MIN_MATCH);
        lookahead -= prevLength - 1;
        prevLength -= 2;
        do { strstart++; insertString(strstart); } while (--prevLength !== 0);
        matchAvailable = false;
        matchLength = MIN_MATCH - 1;
        strstart++;
        if (flush) { FLUSH_BLOCK(0, flush); blockStart = strstart; }
      } else if (matchAvailable) {
        flush = ctTally(0, window[strstart - 1]);
        if (flush) { FLUSH_BLOCK(0, flush); blockStart = strstart; }
        strstart++;
        lookahead--;
      } else {
        matchAvailable = true;
        strstart++;
        lookahead--;
      }
      while (lookahead < MIN_LOOKAHEAD && !eofile) fillWindow();
    }
    if (matchAvailable) ctTally(0, window[strstart - 1]);
    FLUSH_BLOCK(1, flush);
  }

  let s = '';
  for (let i = 0; i < out.length; i += 8192) s += String.fromCharCode.apply(null, out.slice(i, i + 8192));
  return s;
}
