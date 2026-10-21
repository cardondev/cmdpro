// jq 1.6 date builtins (builtin.c: strptime, strftime, mktime, gmtime, localtime) over glibc's
// C-locale strptime/strftime/timegm semantics. The container runs with TZ unset, i.e. UTC.
import { invalidMsg, toInt } from './jqjv.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON_YDAY = [
  [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365],
  [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366],
];
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const fdiv = (a, b) => Math.floor(a / b);
const mod = (a, b) => ((a % b) + b) % b;

// days since 1970-01-01 of a proleptic Gregorian date (month 1..12)
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = fdiv(y, 400);
  const yoe = y - era * 400;
  const doy = fdiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1;
  const doe = yoe * 365 + fdiv(yoe, 4) - fdiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}
function civilFromDays(z) {
  z += 719468;
  const era = fdiv(z, 146097);
  const doe = z - era * 146097;
  const yoe = fdiv(doe - fdiv(doe, 1460) + fdiv(doe, 36524) - fdiv(doe, 146096), 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + fdiv(yoe, 4) - fdiv(yoe, 100));
  const mp = fdiv(5 * doy + 2, 153);
  const d = doy - fdiv(153 * mp + 2, 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
}

// time_t (double -> int64, saturating) -> broken-down UTC time, or null when the year overflows
function gmtimeR(fsecs) {
  let secs = fsecs !== fsecs ? 0 : Math.trunc(fsecs);
  if (secs > 9223372036854775807) secs = 9223372036854775807;
  if (secs < -9223372036854775808) secs = -9223372036854775808;
  const days = Math.floor(secs / 86400);
  let rem = secs - days * 86400;
  const [y, m, d] = civilFromDays(days);
  if (y - 1900 > 2147483647 || y - 1900 < -2147483648) return null;
  const hour = Math.floor(rem / 3600);
  rem -= hour * 3600;
  const min = Math.floor(rem / 60);
  const sec = rem - min * 60;
  const wday = mod(4 + days, 7);
  const yday = days - daysFromCivil(y, 1, 1);
  return { year: y - 1900, mon: m - 1, mday: d, hour, min, sec, wday, yday };
}

// timegm(): normalizes out-of-range fields; tm_wday/tm_yday are ignored
function timegm(tm) {
  let year = tm.year + 1900 + fdiv(tm.mon, 12);
  const mon = mod(tm.mon, 12);
  const days = daysFromCivil(year, mon + 1, 1) + (tm.mday - 1);
  return days * 86400 + tm.hour * 3600 + tm.min * 60 + tm.sec;
}

const tm2jv = (tm) => [tm.year + 1900, tm.mon, tm.mday, tm.hour, tm.min, tm.sec, tm.wday, tm.yday];

// jv2tm(): all eight fields must be numbers (stored into ints)
function jv2tm(a) {
  const f = [];
  for (let i = 0; i < 8; i++) {
    const n = i < a.length ? a[i] : undefined;
    if (typeof n !== 'number') return null;
    f.push(toInt(n));
  }
  return { year: toInt(f[0] - 1900), mon: f[1], mday: f[2], hour: f[3], min: f[4], sec: f[5], wday: f[6], yday: f[7] };
}

export function fGmtime(jq, a, local = false) {
  if (typeof a !== 'number') return invalidMsg(local ? 'localtime() requires numeric inputs' : 'gmtime() requires numeric inputs');
  const tm = gmtimeR(a);
  if (!tm) return invalidMsg(local ? 'error converting number of seconds since epoch to datetime' : 'errror converting number of seconds since epoch to datetime');
  const r = tm2jv(tm);
  r[5] = r[5] + (a - Math.floor(a));
  return r;
}
export const fLocaltime = (jq, a) => fGmtime(jq, a, true);

export function fMktime(jq, a) {
  if (!Array.isArray(a)) return invalidMsg('mktime requires array inputs');
  if (a.length < 6) return invalidMsg('mktime requires parsed datetime inputs');
  const tm = jv2tm(a);
  if (!tm) return invalidMsg('mktime requires parsed datetime inputs');
  const t = timegm(tm);
  if (t === -1) return invalidMsg('invalid gmtime representation');
  return t;
}

// ---------------------------------------------------------------- strftime (glibc, C locale)

function isoWeekDays(yday, wday) {
  // number of days from the first day of the first ISO week of this year to the year day yday
  const BIG = 381;
  return yday - (yday - wday + 4 + BIG * 7) % 7 + 3;
}

export function strftime(fmt, tm) {
  let out = '';
  const n = fmt.length;
  for (let i = 0; i < n; i++) {
    if (fmt[i] !== '%') { out += fmt[i]; continue; }
    const start = i;
    let pad = '';
    let upcase = false, swapcase = false;
    i++;
    for (; i < n; i++) {
      const f = fmt[i];
      if (f === '_' || f === '-' || f === '0') pad = f;
      else if (f === '^') upcase = true;
      else if (f === '#') swapcase = true;
      else break;
    }
    let width = -1;
    if (i < n && fmt[i] >= '0' && fmt[i] <= '9') {
      width = 0;
      while (i < n && fmt[i] >= '0' && fmt[i] <= '9') width = width * 10 + (fmt.charCodeAt(i++) - 48);
    }
    let modifier = '';
    if (fmt[i] === 'E' || fmt[i] === 'O') modifier = fmt[i++];
    const c = fmt[i];
    if (c === undefined) { out += fmt.slice(start); break; }

    const num = (digits, v, spacePad = false) => {
      const neg = v < 0;
      let s = String(Math.abs(v));
      const padc = pad === '_' ? ' ' : pad === '0' ? '0' : spacePad ? ' ' : '0';
      const w = width >= 0 ? width : digits;
      if (pad !== '-') {
        if (padc === '0') { s = s.padStart(w - (neg ? 1 : 0), '0'); if (neg) s = '-' + s; }
        else { if (neg) s = '-' + s; s = s.padStart(w, ' '); }
      } else if (neg) s = '-' + s;
      return s;
    };
    const str = (s, toLower = false) => {
      if (upcase) s = s.toUpperCase();
      else if (swapcase) s = toLower ? s.toLowerCase() : s.toUpperCase();
      if (width > s.length && pad !== '-') s = s.padStart(width, pad === '0' ? '0' : ' ');
      return s;
    };
    const badFormat = () => fmt.slice(start, i + 1);
    const validE = 'cCxXyY', validO = 'deHImMSuUVwWy';
    if ((modifier === 'E' && !validE.includes(c)) || (modifier === 'O' && !validO.includes(c))) { out += badFormat(); continue; }
    const year = tm.year + 1900;
    switch (c) {
      case '%': out += str('%'); break;
      case 'a': out += str(tm.wday < 0 || tm.wday > 6 ? '?' : DAYS[tm.wday].slice(0, 3)); break;
      case 'A': out += str(tm.wday < 0 || tm.wday > 6 ? '?' : DAYS[tm.wday]); break;
      case 'b': case 'h': out += str(tm.mon < 0 || tm.mon > 11 ? '?' : MONTHS[tm.mon].slice(0, 3)); break;
      case 'B': out += str(tm.mon < 0 || tm.mon > 11 ? '?' : MONTHS[tm.mon]); break;
      case 'c': out += str(strftime('%a %b %e %H:%M:%S %Y', tm)); break;
      case 'C': {
        let century = Math.trunc(tm.year / 100) + 19;
        if (tm.year % 100 < 0 && century > 0) century--;
        out += num(2, century);
        break;
      }
      case 'd': out += num(2, tm.mday); break;
      case 'D': out += str(strftime('%m/%d/%y', tm)); break;
      case 'e': out += num(2, tm.mday, true); break;
      case 'F': out += str(strftime('%Y-%m-%d', tm)); break;
      case 'H': out += num(2, tm.hour); break;
      case 'I': out += num(2, mod(tm.hour, 12) || 12); break;
      case 'j': out += num(3, tm.yday + 1); break;
      case 'k': out += num(2, tm.hour, true); break;
      case 'l': out += num(2, mod(tm.hour, 12) || 12, true); break;
      case 'm': out += num(2, tm.mon + 1); break;
      case 'M': out += num(2, tm.min); break;
      case 'n': out += str('\n'); break;
      case 't': out += str('\t'); break;
      case 'p': out += str(tm.hour > 11 ? 'PM' : 'AM', true); break;
      case 'P': out += str(tm.hour > 11 ? 'pm' : 'am'); break;
      case 'r': out += str(strftime('%I:%M:%S %p', tm)); break;
      case 'R': out += str(strftime('%H:%M', tm)); break;
      case 's': out += num(1, timegm(tm)); break;
      case 'S': out += num(2, tm.sec); break;
      case 'T': out += str(strftime('%H:%M:%S', tm)); break;
      case 'u': out += num(1, mod(tm.wday - 1, 7) + 1); break;
      case 'U': out += num(2, fdiv(tm.yday - tm.wday + 7, 7)); break;
      case 'W': out += num(2, fdiv(tm.yday - mod(tm.wday - 1, 7) + 7, 7)); break;
      case 'V': case 'g': case 'G': {
        let y = year;
        let days = isoWeekDays(tm.yday, tm.wday);
        if (days < 0) {
          y--;
          days = isoWeekDays(tm.yday + (isLeap(y) ? 366 : 365), tm.wday);
        } else {
          const d = isoWeekDays(tm.yday - (isLeap(year) ? 366 : 365), tm.wday);
          if (d >= 0) { y++; days = d; }
        }
        if (c === 'V') out += num(2, fdiv(days, 7) + 1);
        else if (c === 'g') out += num(2, mod(y, 100));
        else out += num(1, y);
        break;
      }
      case 'w': out += num(1, tm.wday); break;
      case 'x': out += str(strftime('%m/%d/%y', tm)); break;
      case 'X': out += str(strftime('%H:%M:%S', tm)); break;
      case 'y': out += num(2, mod(year, 100)); break;
      case 'Y': out += num(1, year); break;
      case 'z': out += num(4, 0).replace(/^/, '+'); break;
      case 'Z': out += str('UTC', true); break;
      default: out += badFormat();
    }
  }
  return out;
}

export function fStrftime(jq, a, b, local = false) {
  const name = local ? 'strflocaltime/1' : 'strftime/1';
  if (typeof a === 'number') a = fGmtime(jq, a, local);
  else if (!Array.isArray(a)) return invalidMsg(`${name} requires parsed datetime inputs`);
  else if (typeof b !== 'string') return invalidMsg(`${name} requires a string format`);
  const tm = Array.isArray(a) ? jv2tm(a) : null;
  if (!tm) return invalidMsg(`${name} requires parsed datetime inputs`);
  const s = strftime(b, tm);
  // strftime() returns 0 for an empty result or one longer than strlen(fmt)+100
  if (s.length === 0 || s.length >= b.length + 100) return invalidMsg(`${name}: unknown system failure`);
  return s;
}

// ---------------------------------------------------------------- strptime (glibc, C locale)

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';

function strptimeRec(s, pos, fmt, tm, st) {
  let rp = pos;
  for (let f = 0; f < fmt.length;) {
    const fc = fmt[f];
    if (isSpace(fc)) {
      while (rp < s.length && isSpace(s[rp])) rp++;
      f++;
      continue;
    }
    if (fc !== '%') {
      if (s[rp] !== fc) return -1;
      rp++; f++;
      continue;
    }
    f++;
    while (fmt[f] === '-' || fmt[f] === '_' || fmt[f] === '0' || fmt[f] === '^' || fmt[f] === '#') f++;
    while (fmt[f] >= '0' && fmt[f] <= '9') f++;
    if (fmt[f] === 'E' || fmt[f] === 'O') f++;
    const c = fmt[f++];
    const getNum = (from, to, n) => {
      while (rp < s.length && isSpace(s[rp])) rp++;
      if (!(s[rp] >= '0' && s[rp] <= '9')) return null;
      let val = 0;
      do { val = val * 10 + (s.charCodeAt(rp++) - 48); }
      while (--n > 0 && val * 10 <= to && s[rp] >= '0' && s[rp] <= '9');
      if (val < from || val > to) return null;
      return val;
    };
    const matchName = (names) => {
      for (let k = 0; k < names.length; k++) {
        for (const nm of [names[k], names[k].slice(0, 3)]) {
          if (s.substr(rp, nm.length).toLowerCase() === nm.toLowerCase()) { rp += nm.length; return k; }
        }
      }
      return -1;
    };
    let v;
    switch (c) {
      case '%': if (s[rp] !== '%') return -1; rp++; break;
      case 'n': case 't': while (rp < s.length && isSpace(s[rp])) rp++; break;
      case 'a': case 'A': {
        while (rp < s.length && isSpace(s[rp])) rp++;
        const k = matchName(DAYS);
        if (k < 0) return -1;
        tm.wday = k; st.haveWday = true;
        break;
      }
      case 'b': case 'B': case 'h': {
        while (rp < s.length && isSpace(s[rp])) rp++;
        const k = matchName(MONTHS);
        if (k < 0) return -1;
        tm.mon = k; st.haveMon = true; st.wantXday = true;
        break;
      }
      case 'c': rp = strptimeRec(s, rp, '%a %b %e %H:%M:%S %Y', tm, st); if (rp < 0) return -1; st.wantXday = true; break;
      case 'C': if ((v = getNum(0, 99, 2)) === null) return -1; st.century = v; st.wantXday = true; break;
      case 'd': case 'e': if ((v = getNum(1, 31, 2)) === null) return -1; tm.mday = v; st.haveMday = true; st.wantXday = true; break;
      case 'F': rp = strptimeRec(s, rp, '%Y-%m-%d', tm, st); if (rp < 0) return -1; st.wantXday = true; break;
      case 'x': case 'D': rp = strptimeRec(s, rp, '%m/%d/%y', tm, st); if (rp < 0) return -1; st.wantXday = true; break;
      case 'k': case 'H': if ((v = getNum(0, 23, 2)) === null) return -1; tm.hour = v; st.haveI = false; break;
      case 'l': case 'I': if ((v = getNum(1, 12, 2)) === null) return -1; tm.hour = v % 12; st.haveI = true; break;
      case 'j': if ((v = getNum(1, 366, 3)) === null) return -1; tm.yday = v - 1; st.haveYday = true; break;
      case 'm': if ((v = getNum(1, 12, 2)) === null) return -1; tm.mon = v - 1; st.haveMon = true; st.wantXday = true; break;
      case 'M': if ((v = getNum(0, 59, 2)) === null) return -1; tm.min = v; break;
      case 'p': {
        while (rp < s.length && isSpace(s[rp])) rp++;
        const t = s.substr(rp, 2).toUpperCase();
        if (t === 'AM') st.isPm = false;
        else if (t === 'PM') st.isPm = true;
        else return -1;
        rp += 2;
        break;
      }
      case 'r': rp = strptimeRec(s, rp, '%I:%M:%S %p', tm, st); if (rp < 0) return -1; break;
      case 'R': rp = strptimeRec(s, rp, '%H:%M', tm, st); if (rp < 0) return -1; break;
      case 's': {
        while (rp < s.length && isSpace(s[rp])) rp++;
        let neg = false;
        if (s[rp] === '-') { neg = true; rp++; }
        if (!(s[rp] >= '0' && s[rp] <= '9')) return -1;
        let secs = 0;
        while (s[rp] >= '0' && s[rp] <= '9') secs = secs * 10 + (s.charCodeAt(rp++) - 48);
        const t = gmtimeR(neg ? -secs : secs);
        if (!t) return -1;
        Object.assign(tm, t);
        break;
      }
      case 'S': if ((v = getNum(0, 61, 2)) === null) return -1; tm.sec = v; break;
      case 'X': case 'T': rp = strptimeRec(s, rp, '%H:%M:%S', tm, st); if (rp < 0) return -1; break;
      case 'u': if ((v = getNum(1, 7, 1)) === null) return -1; tm.wday = v % 7; st.haveWday = true; break;
      case 'g': if ((v = getNum(0, 99, 2)) === null) return -1; break;
      case 'G': {
        if (!(s[rp] >= '0' && s[rp] <= '9')) return -1;
        while (s[rp] >= '0' && s[rp] <= '9') rp++;
        break;
      }
      case 'U': if ((v = getNum(0, 53, 2)) === null) return -1; st.weekNo = v; st.haveUweek = true; break;
      case 'W': if ((v = getNum(0, 53, 2)) === null) return -1; st.weekNo = v; st.haveWweek = true; break;
      case 'V': if ((v = getNum(0, 53, 2)) === null) return -1; break;
      case 'w': if ((v = getNum(0, 6, 1)) === null) return -1; tm.wday = v; st.haveWday = true; break;
      case 'y': if ((v = getNum(0, 99, 2)) === null) return -1; tm.year = v >= 69 ? v : v + 100; st.wantCentury = true; st.wantXday = true; break;
      case 'Y': if ((v = getNum(0, 9999, 4)) === null) return -1; tm.year = v - 1900; st.wantCentury = false; st.wantXday = true; break;
      case 'Z': break;
      case 'z': {
        while (rp < s.length && s[rp] === ' ') rp++;
        if (s[rp] === 'Z') { rp++; break; }
        if (s[rp] !== '+' && s[rp] !== '-') return -1;
        rp++;
        let n = 0;
        while (n < 4 && s[rp] >= '0' && s[rp] <= '9') {
          rp++; n++;
          if (n === 2 && s[rp] === ':') rp++;
        }
        if (n === 2) { /* +hh */ }
        else if (n !== 4) return -1;
        break;
      }
      default: return -1;
    }
  }
  return rp;
}

function dayOfTheWeek(tm) {
  const corrYear = 1900 + tm.year - (tm.mon < 2 ? 1 : 0);
  const wday = (-473 + (365 * (tm.year - 70)) + fdiv(corrYear, 4) - fdiv(fdiv(corrYear, 4), 25) + (fdiv(fdiv(corrYear, 4), 25) >> 2)
    + MON_YDAY[0][tm.mon] + tm.mday - 1);
  tm.wday = mod(wday, 7);
}
function dayOfTheYear(tm) {
  tm.yday = MON_YDAY[isLeap(1900 + tm.year) ? 1 : 0][tm.mon] + (tm.mday - 1);
}

// glibc's %w/%u week computations are not needed by jq's sentinel logic beyond these
function setTmWday(tm) {
  const century = Math.trunc((1900 + tm.year) / 100);
  let year = (1900 + tm.year) % 100;
  if (tm.mon < 2) year--;
  let mon = tm.mon - 1;
  if (mon < 1) mon += 12;
  let wday = (tm.mday + Math.floor(2.6 * mon - 0.2) + year + Math.floor(year / 4.0) + Math.floor(century / 4.0) - 2 * century) % 7;
  if (wday < 0) wday += 7;
  tm.wday = wday;
}
function setTmYday(tm) {
  const d = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let mon = tm.mon;
  const year = 1900 + tm.year;
  const leap = tm.mon > 1 && isLeap(year) ? 1 : 0;
  if (mon < 0) mon = -mon;
  if (mon > 11) mon %= 12;
  tm.yday = d[mon] + leap + tm.mday - 1;
}

export function fStrptime(jq, a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return invalidMsg('strptime/1 requires string inputs and arguments');
  const tm = { year: 0, mon: 0, mday: 0, hour: 0, min: 0, sec: 0, wday: 8, yday: 367 };
  const st = { haveI: false, isPm: false, century: -1, wantCentury: false, wantXday: false, haveWday: false,
    haveYday: false, haveMon: false, haveMday: false, haveUweek: false, haveWweek: false, weekNo: 0 };
  const end = strptimeRec(a, 0, b, tm, st);
  if (end < 0 || (end < a.length && !isSpace(a[end]))) {
    return invalidMsg(`date "${a}" does not match format "${b}"`);
  }
  // the end of glibc's strptime: derived fields
  if (st.haveI && st.isPm) tm.hour += 12;
  if (st.century !== -1) {
    if (st.wantCentury) tm.year = tm.year % 100 + (st.century - 19) * 100;
    else tm.year = (st.century - 19) * 100;
  }
  if (st.wantXday && !st.haveWday) {
    if (!(st.haveMon && st.haveMday) && st.haveYday) {
      const leap = isLeap(1900 + tm.year) ? 1 : 0;
      let tMon = 0;
      while (MON_YDAY[leap][tMon] <= tm.yday) tMon++;
      if (!st.haveMon) tm.mon = tMon - 1;
      if (!st.haveMday) tm.mday = tm.yday - MON_YDAY[leap][tMon - 1] + 1;
      st.haveMon = true;
      st.haveMday = true;
    }
    if (tm.year >= -1900) dayOfTheWeek(tm);
  }
  if (st.wantXday && !st.haveYday) dayOfTheYear(tm);
  if ((st.haveUweek || st.haveWweek) && st.haveWday) {
    const saveWday = tm.wday, saveMday = tm.mday, saveMon = tm.mon;
    const wOffset = st.haveUweek ? 0 : 1;
    tm.mday = 1; tm.mon = 0;
    dayOfTheWeek(tm);
    if (st.haveMday) tm.mday = saveMday;
    if (st.haveMon) tm.mon = saveMon;
    if (!st.haveYday) tm.yday = ((7 - (tm.wday - wOffset)) % 7 + (st.weekNo - 1) * 7 + (saveWday - wOffset + 7) % 7);
    if (!st.haveMday || !st.haveMon) {
      const leap = isLeap(1900 + tm.year) ? 1 : 0;
      let tMon = 0;
      while (MON_YDAY[leap][tMon] <= tm.yday) tMon++;
      if (!st.haveMon) tm.mon = tMon - 1;
      if (!st.haveMday) tm.mday = tm.yday - MON_YDAY[leap][tMon - 1] + 1;
    }
    tm.wday = saveWday;
  }
  // jq's own fallbacks for platforms whose strptime leaves the sentinels
  if (tm.wday === 8 && tm.mday !== 0 && tm.mon >= 0 && tm.mon <= 11) setTmWday(tm);
  if (tm.yday === 367 && tm.mday !== 0 && tm.mon >= 0 && tm.mon <= 11) setTmYday(tm);
  const r = tm2jv(tm);
  if (end < a.length) r.push(a.slice(end));
  return r;
}
