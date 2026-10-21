// strftime and a GNU `date -d` style parser (UTC only, like a container with no TZ).

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const p2 = (n) => String(n).padStart(2, '0');
const p3 = (n) => String(n).padStart(3, '0');

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return { week: w, year: y };
}

function dayOfYear(d) { return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1; }

// ns: the nanoseconds within the second, when known more finely than d's milliseconds (for %N)
export function strftime(fmt, d, tz, ns) {
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== '%' || i + 1 >= fmt.length) { out += c; continue; }
    let f = fmt[++i];
    let flag = '';
    if (f === '-' || f === '_' || f === '0' || f === '^' || f === '#') { flag = f; f = fmt[++i]; }
    let width = '';
    while (/[0-9]/.test(f)) { width += f; f = fmt[++i]; }
    if (f === ':' && fmt[i + 1] === 'z') { out += '+00:00'; i++; continue; }
    let v;
    const Y = d.getUTCFullYear(), m = d.getUTCMonth(), D = d.getUTCDate(), H = d.getUTCHours(), M = d.getUTCMinutes(), S = d.getUTCSeconds(), w = d.getUTCDay();
    let num = null, padw = 2, padc = '0';
    switch (f) {
      case 'Y': num = Y; padw = 4; break;
      case 'C': num = Math.floor(Y / 100); break;
      case 'y': num = Y % 100; break;
      case 'm': num = m + 1; break;
      case 'd': num = D; break;
      case 'e': num = D; padc = ' '; break;
      case 'H': num = H; break;
      case 'k': num = H; padc = ' '; break;
      case 'I': num = H % 12 || 12; break;
      case 'l': num = H % 12 || 12; padc = ' '; break;
      case 'M': num = M; break;
      case 'S': num = S; break;
      case 'j': num = dayOfYear(d); padw = 3; break;
      case 'u': num = w || 7; padw = 1; break;
      case 'w': num = w; padw = 1; break;
      case 'U': num = Math.floor((dayOfYear(d) - 1 - w + 7) / 7); break;
      case 'W': num = Math.floor((dayOfYear(d) - 1 - ((w + 6) % 7) + 7) / 7); break;
      case 'V': num = isoWeek(d).week; break;
      case 'G': num = isoWeek(d).year; padw = 4; break;
      case 'g': num = isoWeek(d).year % 100; break;
      case 's': v = String(Math.floor(d.getTime() / 1000)); break;
      case 'N': {
        // nstrftime: the leading WIDTH digits (default 9), then pad up to WIDTH ('-' doesn't)
        let n = ns ?? d.getUTCMilliseconds() * 1000000, nd = 9;
        const w = width ? parseInt(width, 10) : 9;
        while (w < nd || (nd > 1 && n % 10 === 0)) { nd--; n = Math.floor(n / 10); }
        v = String(n).padStart(nd, '0') + (flag === '-' ? '' : (flag === '_' ? ' ' : '0').repeat(Math.max(0, w - nd)));
        width = '';
        break;
      }
      case 'a': v = DAYS[w].slice(0, 3); break;
      case 'A': v = DAYS[w]; break;
      case 'b': case 'h': v = MONTHS[m].slice(0, 3); break;
      case 'B': v = MONTHS[m]; break;
      case 'p': v = H < 12 ? 'AM' : 'PM'; break;
      case 'P': v = H < 12 ? 'am' : 'pm'; break;
      case 'Z': v = 'UTC'; break;
      case 'z': v = '+0000'; break;
      case 'F': v = `${Y}-${p2(m + 1)}-${p2(D)}`; break;
      case 'T': v = `${p2(H)}:${p2(M)}:${p2(S)}`; break;
      case 'D': v = `${p2(m + 1)}/${p2(D)}/${p2(Y % 100)}`; break;
      case 'R': v = `${p2(H)}:${p2(M)}`; break;
      case 'r': v = `${p2(H % 12 || 12)}:${p2(M)}:${p2(S)} ${H < 12 ? 'AM' : 'PM'}`; break;
      case 'c': v = `${DAYS[w].slice(0, 3)} ${MONTHS[m].slice(0, 3)} ${String(D).padStart(2, ' ')} ${p2(H)}:${p2(M)}:${p2(S)} ${Y}`; break;
      case 'x': v = `${p2(m + 1)}/${p2(D)}/${p2(Y % 100)}`; break;
      case 'X': v = `${p2(H)}:${p2(M)}:${p2(S)}`; break;
      case 'n': v = '\n'; break;
      case 't': v = '\t'; break;
      case '%': v = '%'; break;
      default: v = '%' + (flag || '') + width + f;
    }
    if (num !== null) {
      if (flag === '-') v = String(num);
      else {
        const w2 = width ? parseInt(width, 10) : padw;
        const pc = flag === '_' ? ' ' : flag === '0' ? '0' : padc;
        v = String(num).padStart(w2, pc);
      }
    } else if (width) v = v.padStart(parseInt(width, 10), flag === '_' ? ' ' : (/^\d+$/.test(v) ? '0' : ' '));
    if (flag === '^') v = v.toUpperCase();
    if (flag === '#') v = v === v.toUpperCase() ? v.toLowerCase() : v.toUpperCase();
    out += v;
  }
  return out;
}

const MON3 = MONTHS.map(m => m.slice(0, 3).toLowerCase());
const DAY3 = DAYS.map(d => d.slice(0, 3).toLowerCase());
const UNITS = { second: 1000, sec: 1000, minute: 60000, min: 60000, hour: 3600000, day: 86400000, week: 604800000, fortnight: 1209600000 };

// Parse GNU-ish date strings. Returns ms timestamp or null.
export function parseDate(input, nowMs = Date.now()) {
  const r = parseDateNs(input, nowMs);
  return r && r.ms;
}

// The same, keeping the nanoseconds of a fractional second ("12:00:01.5", "@1.25") for %N:
// { ms, ns } (ns is the whole sub-second part, 0..999999999) or null.
export function parseDateNs(input, nowMs = Date.now()) {
  let s = input.trim().toLowerCase();
  if (s === '' ) return { ms: startOfDay(nowMs), ns: 0 };
  let m;
  if ((m = /^@([+-]?)(\d+)(?:[.,](\d*))?$/.exec(s))) {
    let sec = Number(m[2]), ns = Number(((m[3] || '') + '000000000').slice(0, 9));
    if (m[1] === '-') { sec = -sec; if (ns) { sec -= 1; ns = 1e9 - ns; } }
    return { ms: sec * 1000 + Math.floor(ns / 1e6), ns };
  }
  // a fraction of a second, as nanoseconds (digits past the ninth are dropped)
  let ns = 0;
  const frac = (digits) => { ns = digits ? Number((digits + '000000000').slice(0, 9)) : 0; };
  let base = nowMs;
  let explicitDate = false, timeSeen = false, relSeen = false, daySeen = false, zone = null;
  // relative items add up and apply last: years, months and days on the calendar, then the rest
  const rel = { y: 0, mo: 0, d: 0, ms: 0 };
  const relAdd = (unit, n) => {
    unit = unit.replace(/s$/, '');
    if (unit === 'year') rel.y += n;
    else if (unit === 'month') rel.mo += n;
    else if (unit === 'fortnight' || unit === 'week' || unit === 'day') rel.d += n * (unit === 'day' ? 1 : unit === 'week' ? 7 : 14);
    else if (UNITS[unit] !== undefined) rel.ms += n * UNITS[unit];
    else return false;
    return true;
  };
  // absolute date forms
  const tryAbs = () => {
    let mm;
    if ((mm = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*([+-]\d{2}:?\d{2})?/.exec(s))) {
      if (mm[4]) { timeSeen = true; frac(mm[7]); }
      mm.splice(7, 1);
      if (!validYmd(+mm[1], +mm[2], +mm[3], +(mm[4] || 0), +(mm[5] || 0), +(mm[6] || 0))) return BAD;
      let t = Date.UTC(+mm[1], +mm[2] - 1, +mm[3], +(mm[4] || 0), +(mm[5] || 0), +(mm[6] || 0));
      if (mm[7]) { const sign = mm[7][0] === '-' ? -1 : 1; const hh = +mm[7].slice(1, 3), mi = +mm[7].replace(':', '').slice(3, 5); t -= sign * (hh * 60 + mi) * 60000; }
      s = s.slice(mm[0].length).trim();
      return t;
    }
    if ((mm = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s))) {
      let y = +mm[3]; if (y < 100) y += y < 69 ? 2000 : 1900;
      if (!validYmd(y, +mm[1], +mm[2], +(mm[4] || 0), +(mm[5] || 0), +(mm[6] || 0))) return BAD;
      const t = Date.UTC(y, +mm[1] - 1, +mm[2], +(mm[4] || 0), +(mm[5] || 0), +(mm[6] || 0));
      s = s.slice(mm[0].length).trim();
      return t;
    }
    if ((mm = /^(?:([a-z]{3})[a-z]*,?\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:(\d{1,2}):(\d{2})(?::(\d{2}))?\s+)?(?:utc\s+)?(\d{4})/.exec(s)) && MON3.includes(mm[2])) {
      if (!validYmd(+mm[7], MON3.indexOf(mm[2]) + 1, +mm[3], +(mm[4] || 0), +(mm[5] || 0), +(mm[6] || 0))) return BAD;
      const t = Date.UTC(+mm[7], MON3.indexOf(mm[2]), +mm[3], +(mm[4] || 0), +(mm[5] || 0), +(mm[6] || 0));
      s = s.slice(mm[0].length).trim();
      return t;
    }
    if ((mm = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})/.exec(s)) && MON3.includes(mm[2])) {
      if (!validYmd(+mm[3], MON3.indexOf(mm[2]) + 1, +mm[1])) return BAD;
      const t = Date.UTC(+mm[3], MON3.indexOf(mm[2]), +mm[1]);
      s = s.slice(mm[0].length).trim();
      return t;
    }
    if ((mm = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?(?![a-z0-9])/.exec(s)) && MON3.includes(mm[2])) {
      const y = new Date(nowMs).getUTCFullYear();
      if (!validYmd(y, MON3.indexOf(mm[2]) + 1, +mm[1])) return BAD;
      const t = Date.UTC(y, MON3.indexOf(mm[2]), +mm[1]);
      s = s.slice(mm[0].length).trim();
      return t;
    }
    if ((mm = /^([a-z]{3})[a-z]*\s+(\d{1,2})(?!\d)/.exec(s)) && MON3.includes(mm[1])) {
      const y = new Date(nowMs).getUTCFullYear();
      if (!validYmd(y, MON3.indexOf(mm[1]) + 1, +mm[2])) return BAD;
      const t = Date.UTC(y, MON3.indexOf(mm[1]), +mm[2]);
      s = s.slice(mm[0].length).trim();
      return t;
    }
    return null;
  };
  const abs = tryAbs();
  if (abs === BAD) return null;
  if (abs !== null) { base = abs; explicitDate = true; }
  // time of day (also after other items: "thursday 10:00", "tomorrow 9:30")
  const timeOfDay = () => {
    if (!(m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(am|pm)?(?![a-z0-9])/.exec(s))
        && !(m = /^(\d{1,2})()()()\s*(am|pm)(?![a-z0-9])/.exec(s))) return false;
    let h = +m[1];
    if ((m[5] ? h < 1 || h > 12 : h > 23) || +m[2] > 59 || +(m[3] || 0) > 59) return null;
    if (m[5] === 'pm' && h < 12) h += 12; if (m[5] === 'am' && h === 12) h = 0;
    const d = new Date(explicitDate || relSeen || daySeen ? base : nowMs);
    base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, +m[2], +(m[3] || 0));
    frac(m[4]);
    s = s.slice(m[0].length).trim();
    timeSeen = true;
    return true;
  };
  if (timeOfDay() === null) return null;
  // a day name moves to that weekday ("next" one week on), at midnight unless a time was given;
  // parse_datetime ignores it next to an explicit date
  const weekday = (di, ordinal) => {
    daySeen = true;
    if (explicitDate) return;
    const d = new Date(base), wday = d.getUTCDay();
    const diff = (di - wday + 7) % 7 + 7 * (ordinal - (ordinal > 0 && wday !== di ? 1 : 0));
    base = (timeSeen ? base : startOfDay(base)) + diff * 86400000;
  };
  // keywords and relative items
  while (s.length) {
    if (s[0] === ',') { s = s.slice(1).trim(); continue; }
    const t = timeOfDay();
    if (t === null) return null;
    if (t) continue;
    // a date after the time of day ("12:00 2024-06-01") keeps that time
    if (!explicitDate) {
      const before = timeSeen, at = base, d = tryAbs();
      if (d === BAD) return null;
      if (d !== null) {
        explicitDate = true;
        base = d;
        if (before) base = startOfDay(d) + (at - startOfDay(at));
        continue;
      }
    }
    // time zones: names, military letters (j is not one), a numeric offset right after a time
    if ((m = /^([a-z]+)(?:\s*([+-])(\d{1,4})(?::(\d{2}))?)?(?![a-z0-9])/.exec(s)) && (ZONES[m[1]] !== undefined || /^[a-ik-z]$/.test(m[1]))) {
      zone = (ZONES[m[1]] ?? militaryZone(m[1])) + (m[2] ? zoneOffset(m[2], m[3], m[4]) : 0);
      s = s.slice(m[0].length).trim();
      continue;
    }
    if (timeSeen && (m = /^([+-])(\d{1,4})(?::(\d{2}))?(?![a-z0-9])/.exec(s))) {
      zone = zoneOffset(m[1], m[2], m[3]);
      s = s.slice(m[0].length).trim();
      continue;
    }
    relSeen = true;
    if ((m = /^(now|today)\b/.exec(s))) { s = s.slice(m[0].length).trim(); continue; }
    if ((m = /^yesterday\b/.exec(s))) { rel.d--; s = s.slice(m[0].length).trim(); continue; }
    if ((m = /^tomorrow\b/.exec(s))) { rel.d++; s = s.slice(m[0].length).trim(); continue; }
    if ((m = /^(next|last|this|first|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s+([a-z]+\.?)(\s+ago)?(?![a-z0-9])/.exec(s))) {
      const dir = ORDINALS[m[1]];
      const di = dayNumber(m[2]);
      if (di >= 0) { if (m[3]) return null; weekday(di, dir); }
      else if (m[2].endsWith('.') || !relAdd(m[2], m[3] ? -dir : dir)) return null;
      s = s.slice(m[0].length).trim();
      continue;
    }
    if ((m = /^([+-]?\s*\d+)?\s*([a-z]+?)s?\b(\.)?(\s+ago)?/.exec(s)) && m[2]) {
      const n = m[1] ? parseInt(m[1].replace(/\s+/g, ''), 10) : 1;
      const di = dayNumber(m[0].replace(/^[+-]?\s*\d+\s*/, '').replace(/\s+ago$/, ''));
      if (di >= 0) {
        if (m[4]) return null;
        weekday(di, m[1] ? n : 0);
      } else if (m[3] || !relAdd(m[2], m[4] ? -n : n)) return null;
      s = s.slice(m[0].length).trim();
      continue;
    }
    return null;
  }
  if (rel.y || rel.mo || rel.d) {
    const d = new Date(base);
    base = Date.UTC(d.getUTCFullYear() + rel.y, d.getUTCMonth() + rel.mo, d.getUTCDate() + rel.d, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  }
  base += rel.ms;
  if (zone !== null) {
    // a zone on its own means midnight there; the clock fields are read in that zone
    if (!explicitDate && !timeSeen && !relSeen && !daySeen) base = startOfDay(nowMs);
    base -= zone * 60000;
  }
  return { ms: base + Math.floor(ns / 1e6), ns };
}

// parse_datetime's day names: the full name, THUR/THURS/TUES/WEDNES, or any three-letter
// abbreviation (optionally with a period); -1 if WORD is none of them
function dayNumber(word) {
  const w = word.replace(/,$/, '');
  const abbrev = w.length === 3 || (w.length === 4 && w[3] === '.');
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const extra = { tues: 2, wednes: 3, thur: 4, thurs: 4 };
  if (abbrev) return names.findIndex((n) => n.startsWith(w.slice(0, 3)));
  return names.includes(w) ? names.indexOf(w) : extra[w] ?? -1;
}

// gnulib parse-datetime's zone tables, in minutes east of UTC (the *DT/*ST summer names add an hour)
const ZONES = { gmt: 0, ut: 0, utc: 0, wet: 0, west: 60, bst: 60, art: -180, brt: -180, brst: -120, nst: -210, ndt: -150, ast: -240, adt: -180, clt: -240, clst: -180, est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420, akst: -540, akdt: -480, hst: -600, hast: -600, hadt: -540, sst: -720, wat: 60, cet: 60, cest: 120, met: 60, mez: 60, mest: 120, mesz: 120, eet: 120, eest: 180, cat: 120, sast: 120, eat: 180, msk: 180, msd: 240, ist: 330, sgt: 480, kst: 540, jst: 540, gst: 600, nzst: 720, nzdt: 780 };
// military letters: A-I = +1..+9, K-M = +10..+12, N-Y = -1..-12, Z = UTC
function militaryZone(c) {
  const k = c.charCodeAt(0) - 97;
  return c === 'z' ? 0 : k <= 8 ? (k + 1) * 60 : k <= 12 ? k * 60 : -(k - 12) * 60;
}
// +HH, +HHMM, +H:MM (two digits or fewer are hours)
function zoneOffset(sign, digits, colonMin) {
  let v = +digits;
  if (colonMin !== undefined) v = v * 100 + +colonMin;
  else if (digits.length <= 2) v *= 100;
  return (sign === '-' ? -1 : 1) * (Math.floor(v / 100) * 60 + v % 100);
}

// parse_datetime rejects dates that mktime would have to normalise (Feb 30, month 13, 25:00)
const BAD = Symbol('bad date');
function validYmd(y, mo, d, h = 0, mi = 0, sec = 0) {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function startOfDay(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }

const ORDINALS = { last: -1, this: 0, next: 1, first: 1, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };
