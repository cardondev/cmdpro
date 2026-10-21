// Byte-string helpers. The engine represents all file contents and stream data
// as "byte strings": JS strings whose char codes are 0..255 (one char = one byte),
// which gives C-locale semantics for every tool, exactly like the real thing.

const ASCII = /^[\x00-\x7f]*$/;
let enc, dec;

export function utf8Encode(str) {
  if (ASCII.test(str)) return str;
  enc ||= new TextEncoder();
  return bytesToBin(enc.encode(str));
}

export function utf8Decode(bin) {
  if (ASCII.test(bin)) return bin;
  dec ||= new TextDecoder('utf-8', { fatal: false });
  return dec.decode(binToBytes(bin));
}

export function bytesToBin(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return s;
}

export function binToBytes(bin) {
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 255;
  return u8;
}

export function b64ToBin(b64) {
  if (typeof atob === 'function') return atob(b64);
  return Buffer.from(b64, 'base64').toString('latin1');
}

export function binToB64(bin) {
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bin, 'latin1').toString('base64');
}

// Is this byte string valid UTF-8 text (used by `file`, binary detection, etc.)
export function isValidUtf8(bin) {
  if (ASCII.test(bin)) return true;
  let i = 0;
  const n = bin.length;
  while (i < n) {
    const c = bin.charCodeAt(i);
    if (c < 0x80) { i++; continue; }
    let need;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c >= 0xe0 && c <= 0xef) need = 2;
    else if (c >= 0xf0 && c <= 0xf4) need = 3;
    else return false;
    if (i + need >= n) return false;
    for (let k = 1; k <= need; k++) {
      if ((bin.charCodeAt(i + k) & 0xc0) !== 0x80) return false;
    }
    i += need + 1;
  }
  return true;
}
