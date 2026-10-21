// Synchronous hash functions over byte strings: md5, sha1, sha224, sha256, sha384, sha512, crc32 (cksum).

function toWords(bin, bigEndian) {
  const n = bin.length;
  const words = [];
  for (let i = 0; i < n; i += 4) {
    const a = bin.charCodeAt(i) & 255, b = (bin.charCodeAt(i + 1) || 0) & 255, c = (bin.charCodeAt(i + 2) || 0) & 255, d = (bin.charCodeAt(i + 3) || 0) & 255;
    words.push(bigEndian ? ((a << 24) | (b << 16) | (c << 8) | d) >>> 0 : ((d << 24) | (c << 16) | (b << 8) | a) >>> 0);
  }
  return words;
}
function hex32(w, bigEndian) {
  if (bigEndian) return (w >>> 0).toString(16).padStart(8, '0');
  let s = '';
  for (let k = 0; k < 4; k++) s += ((w >>> (8 * k)) & 255).toString(16).padStart(2, '0');
  return s;
}
function pad(bin, bigEndian, blockBytes = 64, lenBytes = 8) {
  const bitLen = bin.length * 8;
  let s = bin + '\x80';
  while ((s.length % blockBytes) !== blockBytes - lenBytes) s += '\x00';
  let lenStr = '';
  const hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
  if (bigEndian) {
    lenStr = '\x00'.repeat(lenBytes - 8);
    for (const w of [hi, lo]) for (let k = 3; k >= 0; k--) lenStr += String.fromCharCode((w >>> (8 * k)) & 255);
  } else {
    for (const w of [lo, hi]) for (let k = 0; k < 4; k++) lenStr += String.fromCharCode((w >>> (8 * k)) & 255);
  }
  return s + lenStr;
}

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

export function md5(bin) {
  const K = [], S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  const w = toWords(pad(bin, false), false);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < w.length; off += 16) {
    let A = a0, B = b0, Cc = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & Cc) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & Cc); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ Cc ^ D; g = (3 * i + 5) % 16; }
      else { F = Cc ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + w[off + g]) >>> 0;
      A = D; D = Cc; Cc = B;
      B = (B + rotl(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + Cc) >>> 0; d0 = (d0 + D) >>> 0;
  }
  return [a0, b0, c0, d0].map(x => hex32(x, false)).join('');
}

export function sha1(bin) {
  const w0 = toWords(pad(bin, true), true);
  let h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const W = new Array(80);
  for (let off = 0; off < w0.length; off += 16) {
    for (let i = 0; i < 16; i++) W[i] = w0[off + i];
    for (let i = 16; i < 80; i++) W[i] = rotl(W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + W[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h = [(h[0] + a) >>> 0, (h[1] + b) >>> 0, (h[2] + c) >>> 0, (h[3] + d) >>> 0, (h[4] + e) >>> 0];
  }
  return h.map(x => hex32(x, true)).join('');
}

const K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

function sha256core(bin, init) {
  const w0 = toWords(pad(bin, true), true);
  let h = [...init];
  const W = new Array(64);
  for (let off = 0; off < w0.length; off += 16) {
    for (let i = 0; i < 16; i++) W[i] = w0[off + i];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h = h.map((x, k) => (x + [a, b, c, d, e, f, g, hh][k]) >>> 0);
  }
  return h;
}
export function sha256(bin) { return sha256core(bin, [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]).map(x => hex32(x, true)).join(''); }
export function sha224(bin) { return sha256core(bin, [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4]).slice(0, 7).map(x => hex32(x, true)).join(''); }

// SHA-512 with BigInt
const K512 = ['428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118', 'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2', '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694', 'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5', '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70', '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df', '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b', 'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8', '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3', '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec', '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b', 'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b', '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817'].map(x => BigInt('0x' + x));
const M64 = (1n << 64n) - 1n;
const rotr64 = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64;
function sha512core(bin, init) {
  const p = pad(bin, true, 128, 16);
  let h = [...init];
  const W = new Array(80);
  for (let off = 0; off < p.length; off += 128) {
    for (let i = 0; i < 16; i++) { let v = 0n; for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(p.charCodeAt(off + i * 8 + k) & 255); W[i] = v; }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr64(W[i - 15], 1) ^ rotr64(W[i - 15], 8) ^ (W[i - 15] >> 7n);
      const s1 = rotr64(W[i - 2], 19) ^ rotr64(W[i - 2], 61) ^ (W[i - 2] >> 6n);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) & M64;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr64(e, 14) ^ rotr64(e, 18) ^ rotr64(e, 41);
      const ch = (e & f) ^ (~e & M64 & g);
      const t1 = (hh + S1 + ch + K512[i] + W[i]) & M64;
      const S0 = rotr64(a, 28) ^ rotr64(a, 34) ^ rotr64(a, 39);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) & M64;
      hh = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64;
    }
    h = h.map((x, k) => (x + [a, b, c, d, e, f, g, hh][k]) & M64);
  }
  return h;
}
export function sha512(bin) { return sha512core(bin, ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'].map(x => BigInt('0x' + x))).map(x => x.toString(16).padStart(16, '0')).join(''); }
export function sha384(bin) { return sha512core(bin, ['cbbb9d5dc1059ed8', '629a292a367cd507', '9159015a3070dd17', '152fecd8f70e5939', '67332667ffc00b31', '8eb44a8768581511', 'db0c2e0d64f98fa7', '47b5481dbefa4fa4'].map(x => BigInt('0x' + x))).slice(0, 6).map(x => x.toString(16).padStart(16, '0')).join(''); }

// POSIX cksum CRC
let CRC_T = null;
export function cksum(bin) {
  if (!CRC_T) {
    CRC_T = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i << 24;
      for (let k = 0; k < 8; k++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) : (c << 1);
      CRC_T[i] = c >>> 0;
    }
  }
  let crc = 0;
  for (let i = 0; i < bin.length; i++) crc = ((crc << 8) ^ CRC_T[((crc >>> 24) ^ bin.charCodeAt(i)) & 255]) >>> 0;
  let len = bin.length;
  while (len > 0) { crc = ((crc << 8) ^ CRC_T[((crc >>> 24) ^ (len & 255)) & 255]) >>> 0; len = Math.floor(len / 256); }
  return (~crc) >>> 0;
}

export const HASHES = { md5sum: md5, sha1sum: sha1, sha224sum: sha224, sha256sum: sha256, sha384sum: sha384, sha512sum: sha512 };
