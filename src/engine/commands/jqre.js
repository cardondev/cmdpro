// jq 1.6 regular expressions: f_match() from builtin.c over Oniguruma 6.9.7 (ONIG_SYNTAX_PERL_NG,
// UTF-8). Patterns are parsed with Oniguruma's rules (including its error messages) and
// translated to JavaScript RegExps; f_match's search loop, offsets (in code points) and result
// objects are reproduced exactly.
import { invalidMsg, typeName, dumpTrunc, codepoints } from './jqjv.js';

class OnigError extends Error {}

const ONIG_MAX_REPEAT = 100000;
const W_CLASS = '\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200c\\u200d';
const WORD = `[${W_CLASS}]`;
const SPACE = '\\p{White_Space}';
const DIGIT = '\\p{Nd}';

// ---------------------------------------------------------------- character properties

const GC = {
  l: 'L', letter: 'L', lu: 'Lu', uppercaseletter: 'Lu', ll: 'Ll', lowercaseletter: 'Ll', lt: 'Lt', titlecaseletter: 'Lt',
  lm: 'Lm', modifierletter: 'Lm', lo: 'Lo', otherletter: 'Lo', lc: 'LC', casedletter: 'LC', m: 'M', mark: 'M', combiningmark: 'M',
  mn: 'Mn', nonspacingmark: 'Mn', mc: 'Mc', spacingmark: 'Mc', me: 'Me', enclosingmark: 'Me', n: 'N', number: 'N',
  nd: 'Nd', decimalnumber: 'Nd', nl: 'Nl', letternumber: 'Nl', no: 'No', othernumber: 'No', p: 'P', punctuation: 'P',
  pc: 'Pc', connectorpunctuation: 'Pc', pd: 'Pd', dashpunctuation: 'Pd', ps: 'Ps', openpunctuation: 'Ps', pe: 'Pe',
  closepunctuation: 'Pe', pi: 'Pi', initialpunctuation: 'Pi', pf: 'Pf', finalpunctuation: 'Pf', po: 'Po',
  otherpunctuation: 'Po', s: 'S', symbol: 'S', sm: 'Sm', mathsymbol: 'Sm', sc: 'Sc', currencysymbol: 'Sc', sk: 'Sk',
  modifiersymbol: 'Sk', so: 'So', othersymbol: 'So', z: 'Z', separator: 'Z', zs: 'Zs', spaceseparator: 'Zs', zl: 'Zl',
  lineseparator: 'Zl', zp: 'Zp', paragraphseparator: 'Zp', c: 'C', other: 'C', cc: 'Cc', control: 'Cc', cf: 'Cf',
  format: 'Cf', cs: 'Cs', surrogate: 'Cs', co: 'Co', privateuse: 'Co', cn: 'Cn', unassigned: 'Cn',
};
const POSIX = {
  alnum: '\\p{Alphabetic}\\p{Nd}', alpha: '\\p{Alphabetic}', blank: '\\p{Zs}\\t', cntrl: '\\p{Cc}', digit: DIGIT,
  graph: '\\P{White_Space}', lower: '\\p{Lowercase}', print: '\\P{Cc}', upper: '\\p{Uppercase}', space: SPACE,
  xdigit: '0-9A-Fa-f', word: W_CLASS, ascii: '\\x00-\\x7f', punct: '\\p{P}$+<=>^`|~',
};
const POSIX_NEG_GRAPH = { graph: true, print: true };  // these are approximations of negated sets
const BINARY = ['Alphabetic', 'Uppercase', 'Lowercase', 'White_Space', 'Hex_Digit', 'ASCII_Hex_Digit', 'Math', 'Dash',
  'Emoji', 'Ideographic', 'Diacritic', 'Extender', 'Noncharacter_Code_Point', 'Default_Ignorable_Code_Point',
  'Join_Control', 'Quotation_Mark', 'Terminal_Punctuation', 'Unified_Ideograph', 'Variation_Selector', 'Cased',
  'Case_Ignorable', 'ID_Start', 'ID_Continue', 'XID_Start', 'XID_Continue', 'Emoji_Presentation', 'Emoji_Modifier',
  'Emoji_Modifier_Base', 'Emoji_Component', 'Extended_Pictographic', 'Grapheme_Base', 'Grapheme_Extend', 'Radical',
  'Pattern_Syntax', 'Pattern_White_Space', 'Bidi_Control', 'Bidi_Mirrored', 'Sentence_Terminal', 'Soft_Dotted',
  'Logical_Order_Exception', 'Deprecated', 'IDS_Binary_Operator', 'IDS_Trinary_Operator', 'Regional_Indicator'];
const SCRIPTS = ['Adlam', 'Ahom', 'Anatolian_Hieroglyphs', 'Arabic', 'Armenian', 'Avestan', 'Balinese', 'Bamum',
  'Bassa_Vah', 'Batak', 'Bengali', 'Bhaiksuki', 'Bopomofo', 'Brahmi', 'Braille', 'Buginese', 'Buhid',
  'Canadian_Aboriginal', 'Carian', 'Caucasian_Albanian', 'Chakma', 'Cham', 'Cherokee', 'Chorasmian', 'Common',
  'Coptic', 'Cuneiform', 'Cypriot', 'Cyrillic', 'Deseret', 'Devanagari', 'Dives_Akuru', 'Dogra', 'Duployan',
  'Egyptian_Hieroglyphs', 'Elbasan', 'Elymaic', 'Ethiopic', 'Georgian', 'Glagolitic', 'Gothic', 'Grantha', 'Greek',
  'Gujarati', 'Gunjala_Gondi', 'Gurmukhi', 'Han', 'Hangul', 'Hanifi_Rohingya', 'Hanunoo', 'Hatran', 'Hebrew',
  'Hiragana', 'Imperial_Aramaic', 'Inherited', 'Inscriptional_Pahlavi', 'Inscriptional_Parthian', 'Javanese',
  'Kaithi', 'Kannada', 'Katakana', 'Kayah_Li', 'Kharoshthi', 'Khmer', 'Khojki', 'Khudawadi', 'Lao', 'Latin',
  'Lepcha', 'Limbu', 'Linear_A', 'Linear_B', 'Lisu', 'Lycian', 'Lydian', 'Mahajani', 'Makasar', 'Malayalam',
  'Mandaic', 'Manichaean', 'Marchen', 'Masaram_Gondi', 'Medefaidrin', 'Meetei_Mayek', 'Mende_Kikakui',
  'Meroitic_Cursive', 'Meroitic_Hieroglyphs', 'Miao', 'Modi', 'Mongolian', 'Mro', 'Multani', 'Myanmar', 'Nabataean',
  'Nandinagari', 'New_Tai_Lue', 'Newa', 'Nko', 'Nushu', 'Nyiakeng_Puachue_Hmong', 'Ogham', 'Ol_Chiki',
  'Old_Hungarian', 'Old_Italic', 'Old_North_Arabian', 'Old_Permic', 'Old_Persian', 'Old_Sogdian', 'Old_South_Arabian',
  'Old_Turkic', 'Oriya', 'Osage', 'Osmanya', 'Pahawh_Hmong', 'Palmyrene', 'Pau_Cin_Hau', 'Phags_Pa', 'Phoenician',
  'Psalter_Pahlavi', 'Rejang', 'Runic', 'Samaritan', 'Saurashtra', 'Sharada', 'Shavian', 'Siddham', 'SignWriting',
  'Sinhala', 'Sogdian', 'Sora_Sompeng', 'Soyombo', 'Sundanese', 'Syloti_Nagri', 'Syriac', 'Tagalog', 'Tagbanwa',
  'Tai_Le', 'Tai_Tham', 'Tai_Viet', 'Takri', 'Tamil', 'Tangut', 'Telugu', 'Thaana', 'Thai', 'Tibetan', 'Tifinagh',
  'Tirhuta', 'Ugaritic', 'Vai', 'Wancho', 'Warang_Citi', 'Yezidi', 'Yi', 'Zanabazar_Square'];
const BLOCKS = {
  basiclatin: '\\x00-\\x7f', latin1supplement: '\\x80-\\xff', latinextendeda: '\\u0100-\\u017f',
  latinextendedb: '\\u0180-\\u024f', greekandcoptic: '\\u0370-\\u03ff', cyrillic: '\\u0400-\\u04ff',
  generalpunctuation: '\\u2000-\\u206f', cjkunifiedideographs: '\\u4e00-\\u9fff', hiragana: '\\u3040-\\u309f',
  katakana: '\\u30a0-\\u30ff', arabic: '\\u0600-\\u06ff', hebrew: '\\u0590-\\u05ff',
};
const norm = (s) => s.toLowerCase().replace(/[\s_-]/g, '');
let PROPS = null;
function propTable() {
  if (PROPS) return PROPS;
  PROPS = new Map();
  for (const [k, v] of Object.entries(POSIX)) PROPS.set(k, v);
  PROPS.set('any', '\\s\\S');
  PROPS.set('assigned', '\\P{Cn}');
  for (const [k, v] of Object.entries(GC)) if (!PROPS.has(k)) PROPS.set(k, `\\p{${v}}`);
  for (const b of BINARY) {
    try { new RegExp(`\\p{${b}}`, 'u'); if (!PROPS.has(norm(b))) PROPS.set(norm(b), `\\p{${b}}`); } catch { /* unsupported */ }
  }
  for (const s of SCRIPTS) {
    try { new RegExp(`\\p{Script=${s}}`, 'u'); if (!PROPS.has(norm(s))) PROPS.set(norm(s), `\\p{Script=${s}}`); } catch { /* unsupported */ }
  }
  for (const [k, v] of Object.entries(BLOCKS)) PROPS.set('in' + k, v);
  return PROPS;
}

// ---------------------------------------------------------------- parser

const OPT_I = 1, OPT_X = 2, OPT_S = 4 /* dot matches newline */, OPT_SINGLELINE = 8;

function hexVal(c) {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'a' && c <= 'f') return c.charCodeAt(0) - 87;
  if (c >= 'A' && c <= 'F') return c.charCodeAt(0) - 55;
  return -1;
}
const isOct = (c) => c >= '0' && c <= '7';
const isDig = (c) => c >= '0' && c <= '9';
const isWordName = (c) => /[A-Za-z0-9_]/.test(c);

class Parser {
  constructor(pat, options) {
    this.p = codepoints(pat).map(c => String.fromCodePoint(c));
    this.i = 0;
    this.ngroups = 0;
    this.names = new Map();     // name -> [group numbers]
    this.backrefs = [];         // numbers referenced, validated at the end
    this.namedRefs = [];
    this.calls = [];
    this.options = options;
    this.ciChanges = false;
    this.groupNodes = [];
  }
  peek(k = 0) { return this.p[this.i + k]; }
  eof() { return this.i >= this.p.length; }

  parse() {
    const node = this.parseAlt(this.options, 0);
    if (!this.eof()) {
      if (this.peek() === ')') throw new OnigError('unmatched close parenthesis');
    }
    for (const n of this.backrefs) if (n > this.ngroups || n <= 0) throw new OnigError('invalid backref number/name');
    for (const nm of this.namedRefs) if (!this.names.has(nm)) throw new OnigError(`undefined name <${nm}> reference`);
    for (const c of this.calls) {
      if (typeof c === 'number' && (c > this.ngroups || c < 0)) throw new OnigError(`undefined group <${c}> reference`);
      if (typeof c === 'string' && !this.names.has(c)) throw new OnigError(`undefined name <${c}> reference`);
    }
    return node;
  }

  skipExtended(opts) {
    if (!(opts & OPT_X)) return;
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') { this.i++; continue; }
      if (c === '#') { while (!this.eof() && this.peek() !== '\n') this.i++; continue; }
      break;
    }
  }

  parseAlt(opts, depth) {
    const alts = [];
    const state = { opts };
    alts.push(this.parseSeq(state, depth));
    while (this.peek() === '|') {
      this.i++;
      alts.push(this.parseSeq(state, depth));
    }
    return alts.length === 1 ? alts[0] : { t: 'alt', alts };
  }

  // state.opts can change mid-sequence through (?i) etc.; it persists to the end of the group
  parseSeq(state, depth) {
    const items = [];
    for (;;) {
      this.skipExtended(state.opts);
      if (this.eof()) break;
      const c = this.peek();
      if (c === '|') break;
      if (c === ')') {
        if (depth === 0) throw new OnigError('unmatched close parenthesis');
        break;
      }
      if (c === '*' || c === '+' || c === '?' || (c === '{' && this.intervalAhead())) {
        if (items.length === 0) throw new OnigError('target of repeat operator is not specified');
        const last = items[items.length - 1];
        if (last.t === 'anchor' || last.t === 'look') throw new OnigError('target of repeat operator is invalid');
        items[items.length - 1] = this.parseQuant(last, state.opts);
        continue;
      }
      const atom = this.parseAtom(state, depth);
      if (atom) items.push(atom);
    }
    return { t: 'seq', items };
  }

  intervalAhead() {
    // {n}, {n,}, {n,m} -- anything else is a literal '{' in Perl syntax
    let j = this.i + 1;
    let digits = 0;
    while (isDig(this.p[j])) { j++; digits++; }
    if (!digits) return false;
    if (this.p[j] === '}') return true;
    if (this.p[j] !== ',') return false;
    j++;
    while (isDig(this.p[j])) j++;
    return this.p[j] === '}';
  }

  parseQuant(atom, opts) {
    const c = this.p[this.i++];
    let min, max;
    if (c === '*') { min = 0; max = Infinity; }
    else if (c === '+') { min = 1; max = Infinity; }
    else if (c === '?') { min = 0; max = 1; }
    else {
      let s = '';
      while (isDig(this.peek())) s += this.p[this.i++];
      min = parseInt(s, 10);
      if (this.peek() === ',') {
        this.i++;
        let t = '';
        while (isDig(this.peek())) t += this.p[this.i++];
        max = t === '' ? Infinity : parseInt(t, 10);
      } else max = min;
      this.i++;   // '}'
      if (min > ONIG_MAX_REPEAT || (max !== Infinity && max > ONIG_MAX_REPEAT)) throw new OnigError('too big number for repeat range');
      if (max < min) throw new OnigError('upper is smaller than lower in repeat range');
    }
    let lazy = false, possessive = false;
    if (this.peek() === '?') { lazy = true; this.i++; }
    else if (this.peek() === '+' && c !== '{') { possessive = true; this.i++; }
    void opts;
    return { t: 'quant', body: atom, min, max, lazy, possessive };
  }

  parseAtom(state, depth) {
    const opts = state.opts;
    const c = this.p[this.i++];
    switch (c) {
      case '(': return this.parseGroup(state, depth);
      case '[': return this.parseClass(opts);
      case '.': return { t: 'any', dotall: !!(opts & OPT_S) };
      case '^': return { t: 'anchor', kind: (opts & OPT_SINGLELINE) ? 'bos' : 'bol' };
      case '$': return { t: 'anchor', kind: (opts & OPT_SINGLELINE) ? 'eosnl' : 'eol' };
      case '\\': return this.parseEscape(opts);
      default: return { t: 'char', cp: c.codePointAt(0), ci: !!(opts & OPT_I) };
    }
  }

  parseName(close) {
    let name = '';
    while (!this.eof() && this.peek() !== close) name += this.p[this.i++];
    if (this.eof()) throw new OnigError(`invalid group name <${name}>`);
    this.i++;
    return name;
  }

  parseGroup(state, depth) {
    const opts = state.opts;
    if (this.peek() !== '?') {
      const n = ++this.ngroups;
      const body = this.parseAlt(opts, depth + 1);
      this.expectClose();
      return { t: 'group', n, body };
    }
    this.i++;
    const c = this.p[this.i++];
    switch (c) {
      case ':': {
        const body = this.parseAlt(opts, depth + 1);
        this.expectClose();
        return { t: 'nc', body };
      }
      case '=': case '!': {
        const body = this.parseAlt(opts, depth + 1);
        this.expectClose();
        return { t: 'look', kind: c, body };
      }
      case '>': {
        const body = this.parseAlt(opts, depth + 1);
        this.expectClose();
        return { t: 'atomic', body };
      }
      case '#': {
        while (!this.eof() && this.peek() !== ')') this.i++;
        if (this.eof()) throw new OnigError('end pattern in group');
        this.i++;
        return null;
      }
      case '~': {
        const body = this.parseAlt(opts, depth + 1);
        this.expectClose();
        return { t: 'absent', body };
      }
      case '(': throw new OnigError('invalid conditional pattern');
      case '<': case "'": {
        if (c === '<' && (this.peek() === '=' || this.peek() === '!')) {
          const k = this.p[this.i++];
          const body = this.parseAlt(opts, depth + 1);
          this.expectClose();
          checkLookbehind(body);
          return { t: 'look', kind: '<' + k, body };
        }
        const name = this.parseName(c === '<' ? '>' : "'");
        if (name === '') throw new OnigError('group name is empty');
        if (!/^[A-Za-z_]/.test(name)) throw new OnigError(`invalid group name <${name}>`);
        const n = ++this.ngroups;
        if (!this.names.has(name)) this.names.set(name, []);
        this.names.get(name).push(n);
        const body = this.parseAlt(opts, depth + 1);
        this.expectClose();
        return { t: 'group', n, name, body };
      }
      case '-':
        if (isDig(this.peek())) throw new OnigError('undefined group option');
        throw new OnigError('invalid group name <>');
      default: {
        // option settings: (?imsx-imsx) or (?imsx-imsx:subexp)
        let on = true;
        let o = opts;
        let ch = c;
        for (;;) {
          if (ch === 'i') { o = on ? o | OPT_I : o & ~OPT_I; this.ciChanges = true; }
          else if (ch === 'x') o = on ? o | OPT_X : o & ~OPT_X;
          else if (ch === 's') o = on ? o | OPT_S : o & ~OPT_S;
          else if (ch === 'm') o = on ? o & ~OPT_SINGLELINE : o | OPT_SINGLELINE;
          else if (ch === '-') on = false;
          else if (ch === ')') { state.opts = o; return null; }
          else if (ch === ':') {
            const body = this.parseAlt(o, depth + 1);
            this.expectClose();
            return { t: 'nc', body };
          } else throw new OnigError('undefined group option');
          if (this.eof()) throw new OnigError('end pattern in group');
          ch = this.p[this.i++];
        }
      }
    }
  }

  expectClose() {
    if (this.peek() !== ')') throw new OnigError('end pattern with unmatched parenthesis');
    this.i++;
  }

  // \xHH and octal escapes are raw bytes: a byte >= 0x80 must start a UTF-8 sequence that further
  // \xHH escapes complete
  rawByte(v) {
    if (v < 0x80) return v;
    const need = v >= 0xf0 ? 3 : v >= 0xe0 ? 2 : v >= 0xc0 ? 1 : -1;
    if (need < 0) throw new OnigError('invalid code point value');
    let cp = v & (0x3f >> need);
    for (let k = 0; k < need; k++) {
      const m = /^\\x([0-9a-fA-F]{2})/.exec(this.p.slice(this.i, this.i + 4).join(''));
      if (!m) throw new OnigError('too short multibyte code string');
      const b = parseInt(m[1], 16);
      if ((b & 0xc0) !== 0x80) throw new OnigError('invalid code point value');
      cp = (cp << 6) | (b & 0x3f);
      this.i += 4;
    }
    return cp;
  }

  // escapes valid both inside and outside of classes; returns a code point or null
  charEscape(c, inClass) {
    switch (c) {
      case 't': return 9;
      case 'n': return 10;
      case 'r': return 13;
      case 'f': return 12;
      case 'a': return 7;
      case 'e': return 27;
      case 'c': {
        if (this.eof()) throw new OnigError('end pattern at control');
        const d = this.p[this.i++];
        return d.codePointAt(0) & 0x1f;
      }
      case 'x': {
        if (this.peek() === '{') {
          let j = this.i + 1, v = 0, n = 0;
          while (j < this.p.length && hexVal(this.p[j]) >= 0) { v = v * 16 + hexVal(this.p[j]); j++; n++; }
          if (this.p[j] !== '}' || n === 0) throw new OnigError('invalid code point value');
          if (n > 8) throw new OnigError('too long wide-char value');
          this.i = j + 1;
          return v;
        }
        let v = 0, n = 0;
        while (n < 2 && hexVal(this.peek() || '') >= 0) { v = v * 16 + hexVal(this.p[this.i++]); n++; }
        if (n === 0) return 'x'.codePointAt(0);
        return this.rawByte(v);
      }
      case 'o': {
        if (this.peek() === '{') {
          let j = this.i + 1, v = 0, n = 0;
          while (j < this.p.length && isOct(this.p[j])) { v = v * 8 + (this.p[j].charCodeAt(0) - 48); j++; n++; }
          if (this.p[j] !== '}' || n === 0) throw new OnigError('invalid code point value');
          if (v > 0x10ffff || n > 7) throw new OnigError('too long wide-char value');
          this.i = j + 1;
          return v;
        }
        return 'o'.codePointAt(0);
      }
      case '0': {
        let v = 0, n = 0;
        while (n < 2 && isOct(this.peek() || '')) { v = v * 8 + (this.p[this.i++].charCodeAt(0) - 48); n++; }
        return this.rawByte(v);
      }
      default:
        if (inClass && c === 'b') return 8;
        return null;
    }
  }

  parseEscape(opts) {
    if (this.eof()) throw new OnigError('end pattern at escape');
    const c = this.p[this.i++];
    const ci = !!(opts & OPT_I);
    switch (c) {
      case 'w': return { t: 'set', src: W_CLASS, neg: false };
      case 'W': return { t: 'set', src: W_CLASS, neg: true };
      case 'd': return { t: 'set', src: DIGIT, neg: false };
      case 'D': return { t: 'set', src: DIGIT, neg: true };
      case 's': return { t: 'set', src: SPACE, neg: false };
      case 'S': return { t: 'set', src: SPACE, neg: true };
      case 'b': return { t: 'anchor', kind: 'wordb' };
      case 'B': return { t: 'anchor', kind: 'nwordb' };
      case 'A': return { t: 'anchor', kind: 'bos' };
      case 'z': return { t: 'anchor', kind: 'eos' };
      case 'Z': return { t: 'anchor', kind: 'eosnl' };
      case 'G': return { t: 'anchor', kind: 'G' };
      case 'K': return { t: 'keep' };
      case 'y': case 'Y': return { t: 'anchor', kind: c === 'y' ? 'seg' : 'nseg' };
      case 'R': return { t: 'raw', src: '(?:\\r\\n|[\\n\\v\\f\\r\\x85\\u2028\\u2029])' };
      case 'X': return { t: 'raw', src: '(?:\\r\\n|\\P{M}\\p{M}*)' };
      case 'N': return { t: 'raw', src: '[^\\n]' };
      case 'O': return { t: 'raw', src: '[\\s\\S]' };
      case 'p': case 'P': {
        if (this.peek() !== '{') return { t: 'char', cp: c.codePointAt(0), ci };
        this.i++;
        let neg = c === 'P';
        if (this.peek() === '^') { neg = !neg; this.i++; }
        let name = '';
        while (!this.eof() && this.peek() !== '}') name += this.p[this.i++];
        if (this.eof()) throw new OnigError(`invalid character property name {${name}}`);
        this.i++;
        const src = propTable().get(norm(name));
        if (src === undefined) throw new OnigError(`invalid character property name {${name}}`);
        return { t: 'set', src, neg };
      }
      case 'k': {
        const open = this.peek();
        if (open === '<' || open === "'") {
          this.i++;
          const name = this.parseName(open === '<' ? '>' : "'");
          if (/^-?\d+$/.test(name)) {
            let n = parseInt(name, 10);
            if (n < 0) n = this.ngroups + 1 + n;
            this.backrefs.push(n);
            return { t: 'backref', n, ci };
          }
          this.namedRefs.push(name);
          return { t: 'backref', name, ci };
        }
        return { t: 'char', cp: 107, ci };
      }
      case 'g': {
        const open = this.peek();
        if (open === '<' || open === "'") {
          this.i++;
          const name = this.parseName(open === '<' ? '>' : "'");
          if (/^-?\d+$/.test(name)) {
            let n = parseInt(name, 10);
            if (n < 0) n = this.ngroups + 1 + n;
            this.calls.push(n);
            return { t: 'call', n };
          }
          this.calls.push(name);
          return { t: 'call', name };
        }
        return { t: 'char', cp: 103, ci };
      }
      case 'Q': {
        const items = [];
        while (!this.eof()) {
          if (this.peek() === '\\' && this.peek(1) === 'E') { this.i += 2; break; }
          items.push({ t: 'char', cp: this.p[this.i++].codePointAt(0), ci });
        }
        return { t: 'seq', items };
      }
      default: break;
    }
    if (c >= '1' && c <= '9') {
      // the whole number is a backreference when it is <= 9 or <= the groups seen so far;
      // otherwise an octal escape (or a plain '8'/'9')
      let j = this.i - 1, s = '';
      while (isDig(this.p[j])) s += this.p[j++];
      const num = parseInt(s, 10);
      if (num <= 1000 && (num <= this.ngroups || num <= 9)) {
        this.i = j;
        this.backrefs.push(num);
        return { t: 'backref', n: num, ci };
      }
      if (c === '8' || c === '9') return { t: 'char', cp: c.codePointAt(0), ci };
      let v = c.charCodeAt(0) - 48, k = 1;
      while (k < 3 && isOct(this.peek() || '')) { v = v * 8 + (this.p[this.i++].charCodeAt(0) - 48); k++; }
      if (v >= 256) throw new OnigError('too big number');
      return { t: 'char', cp: this.rawByte(v), ci };
    }
    const cp = this.charEscape(c, false);
    if (cp !== null) return { t: 'char', cp, ci };
    return { t: 'char', cp: c.codePointAt(0), ci };
  }

  // [...]: items are { lo, hi } ranges or { set, neg } property sets
  parseClass(opts) {
    const ci = !!(opts & OPT_I);
    let neg = false;
    if (this.peek() === '^') { neg = true; this.i++; }
    const items = [];
    let first = true;
    let pendingRangeStart = null;   // code point waiting for '-'
    const pushRange = (lo, hi) => {
      if (lo > hi) throw new OnigError('empty range in char class');
      items.push({ lo, hi });
    };
    for (;;) {
      if (this.eof()) throw new OnigError('premature end of char-class');
      let c = this.p[this.i++];
      if (c === ']' && !first) break;
      first = false;
      let item;   // { cp } or { set }
      if (c === '[' && this.peek() === ':') {
        const m = /^:(\^?)([a-z]+):\]/.exec(this.p.slice(this.i, this.i + 12).join(''));
        if (m) {
          const src = POSIX[m[2]];
          if (src === undefined) throw new OnigError('invalid POSIX bracket type');
          this.i += m[0].length;
          item = { set: src, neg: m[1] === '^' };
        } else if (/^:\^?[a-zA-Z]*:\]/.test(this.p.slice(this.i, this.i + 20).join(''))) {
          throw new OnigError('invalid POSIX bracket type');
        } else item = { cp: 91 };
      } else if (c === '\\') {
        if (this.eof()) throw new OnigError('end pattern at escape');
        const d = this.p[this.i++];
        switch (d) {
          case 'w': item = { set: W_CLASS, neg: false }; break;
          case 'W': item = { set: W_CLASS, neg: true }; break;
          case 'd': item = { set: DIGIT, neg: false }; break;
          case 'D': item = { set: DIGIT, neg: true }; break;
          case 's': item = { set: SPACE, neg: false }; break;
          case 'S': item = { set: SPACE, neg: true }; break;
          case 'p': case 'P': {
            if (this.peek() !== '{') { item = { cp: d.codePointAt(0) }; break; }
            this.i++;
            let pneg = d === 'P';
            if (this.peek() === '^') { pneg = !pneg; this.i++; }
            let name = '';
            while (!this.eof() && this.peek() !== '}') name += this.p[this.i++];
            if (this.eof()) throw new OnigError(`invalid character property name {${name}}`);
            this.i++;
            const src = propTable().get(norm(name));
            if (src === undefined) throw new OnigError(`invalid character property name {${name}}`);
            item = { set: src, neg: pneg };
            break;
          }
          default: {
            if (d >= '1' && d <= '7') {
              let v = d.charCodeAt(0) - 48, k = 1;
              while (k < 3 && isOct(this.peek() || '')) { v = v * 8 + (this.p[this.i++].charCodeAt(0) - 48); k++; }
              item = { cp: this.rawByte(v) };
              break;
            }
            const cp = this.charEscape(d, true);
            item = { cp: cp !== null ? cp : d.codePointAt(0) };
          }
        }
      } else item = { cp: c.codePointAt(0) };

      if (pendingRangeStart !== null) {
        if (item.set !== undefined) throw new OnigError('char-class value at end of range');
        pushRange(pendingRangeStart, item.cp);
        pendingRangeStart = null;
        continue;
      }
      if (item.set !== undefined) {
        if (this.peek() === '-' && this.peek(1) !== ']') throw new OnigError('unmatched range specifier in char-class');
        items.push({ set: item.set, neg: item.neg });
        continue;
      }
      if (this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== undefined) {
        this.i++;
        pendingRangeStart = item.cp;
        continue;
      }
      items.push({ lo: item.cp, hi: item.cp });
    }
    return { t: 'class', neg, items, ci };
  }
}

function checkLookbehind(body) {
  // Oniguruma 6.9 rejects top-level alternatives of different lengths inside look-behind
  if (body.t === 'alt') {
    const lens = body.alts.map(fixedLength);
    if (lens.some(l => l < 0) || lens.some(l => l !== lens[0])) throw new OnigError('invalid pattern in look-behind');
  }
}
function fixedLength(n) {
  switch (n.t) {
    case 'char': case 'any': case 'set': case 'class': return 1;
    case 'seq': { let s = 0; for (const x of n.items) { const l = fixedLength(x); if (l < 0) return -1; s += l; } return s; }
    case 'anchor': case 'look': case 'keep': return 0;
    case 'group': case 'nc': case 'atomic': return fixedLength(n.body);
    case 'quant': { if (n.min !== n.max) return -1; const l = fixedLength(n.body); return l < 0 ? -1 : l * n.min; }
    case 'alt': { const ls = n.alts.map(fixedLength); return ls.every(l => l === ls[0]) ? ls[0] : -1; }
    default: return -1;
  }
}

// ---------------------------------------------------------------- JS emission

const SYNTAX = new Set(['^', '$', '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/']);
function litChar(cp) {
  if (cp > 0x10ffff) return '(?!)';
  const ch = String.fromCodePoint(cp);
  if (/^[A-Za-z0-9 _,:;'"!@#%&=<>~`]$/.test(ch)) return ch;
  if (SYNTAX.has(ch)) return '\\' + ch;
  return `\\u{${cp.toString(16)}}`;
}
function classChar(cp) {
  if (cp > 0x10ffff) cp = 0x10ffff;
  const ch = String.fromCodePoint(cp);
  if (/^[A-Za-z0-9 _,:;'"!@#%&=<>~`.*+?(){}|$/]$/.test(ch)) return ch;
  return `\\u{${cp.toString(16)}}`;
}

function caseVariants(cp) {
  const s = String.fromCodePoint(cp);
  const out = new Set([cp]);
  for (const v of [s.toLowerCase(), s.toUpperCase()]) {
    const cps = codepoints(v);
    if (cps.length === 1) out.add(cps[0]);
  }
  // titlecase / special folds that only show up through a lower/upper round trip
  for (const v of [...out]) {
    const t = String.fromCodePoint(v);
    for (const w of [t.toLowerCase(), t.toUpperCase()]) {
      const cps = codepoints(w);
      if (cps.length === 1) out.add(cps[0]);
    }
  }
  return [...out];
}

class Emitter {
  constructor(parser, ciFlag) {
    this.parser = parser;
    this.ciFlag = ciFlag;       // the whole regex uses the JS 'i' flag
    this.jsGroups = 0;
    this.groupMap = [];         // onig group number -> js group number
    this.keepGroup = null;
    this.gAnchor = false;
    this.groupNodes = new Map();
    this.callDepth = 0;
  }
  newGroup() { return ++this.jsGroups; }

  emit(n) {
    switch (n.t) {
      case 'seq': return n.items.map(x => this.emit(x)).join('');
      case 'alt': return n.alts.map(x => this.emit(x)).join('|');
      case 'char': {
        if (n.ci && !this.ciFlag) {
          const vs = caseVariants(n.cp);
          if (vs.length > 1) return '[' + vs.map(classChar).join('') + ']';
        }
        return litChar(n.cp);
      }
      case 'any': return n.dotall ? '[\\s\\S]' : '[^\\n]';
      case 'set': return n.neg ? `[^${n.src}]` : `[${n.src}]`;
      case 'raw': return n.src;
      case 'class': return this.emitClass(n);
      case 'anchor':
        switch (n.kind) {
          case 'bos': return '(?<![\\s\\S])';
          case 'bol': return '(?<![^\\n])';
          case 'eos': return '(?![\\s\\S])';
          case 'eosnl': return '(?=\\n?(?![\\s\\S]))';
          case 'eol': return '(?![^\\n])';
          case 'wordb': return `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
          case 'nwordb': return `(?:(?<=${WORD})(?=${WORD})|(?<!${WORD})(?!${WORD}))`;
          case 'G': this.gAnchor = true; return '';
          default: return '';
        }
      case 'keep': {
        const g = this.newGroup();
        this.keepGroup = g;
        return '()';
      }
      case 'group': {
        const g = this.newGroup();
        this.groupMap[n.n] = g;
        this.groupNodes.set(n.n, n);
        return '(' + this.emit(n.body) + ')';
      }
      case 'nc': return '(?:' + this.emit(n.body) + ')';
      case 'look': return `(?${n.kind}${this.emit(n.body)})`;
      case 'atomic': {
        const g = this.newGroup();
        return `(?=(${this.emit(n.body)}))\\${g}`;
      }
      case 'absent': return `(?:(?!${this.emit(n.body)})[\\s\\S])*`;
      case 'backref': {
        if (n.name !== undefined) {
          const nums = this.parser.names.get(n.name);
          const g = this.groupMap[nums[nums.length - 1]];
          return g ? `\\${g}` : '(?:)';
        }
        const g = this.groupMap[n.n];
        return g ? `(?:\\${g})` : '(?!)';
      }
      case 'call': {
        // subexpression calls are inlined (no recursion)
        const num = n.name !== undefined ? this.parser.names.get(n.name)[0] : n.n;
        const node = num === 0 ? null : findGroup(this.parser.root, num);
        if (!node || this.callDepth > 3) return '(?!)';
        this.callDepth++;
        const save = this.groupMap.slice();
        const r = '(?:' + this.emitNoCapture(node.body) + ')';
        this.groupMap = save;
        this.callDepth--;
        return r;
      }
      case 'quant': {
        let body = this.emit(n.body);
        if (!isAtomic(n.body)) body = '(?:' + body + ')';
        let q;
        if (n.min === 0 && n.max === Infinity) q = '*';
        else if (n.min === 1 && n.max === Infinity) q = '+';
        else if (n.min === 0 && n.max === 1) q = '?';
        else if (n.max === Infinity) q = `{${n.min},}`;
        else if (n.min === n.max) q = `{${n.min}}`;
        else q = `{${n.min},${n.max}}`;
        if (n.lazy) q += '?';
        if (n.possessive) {
          const g = this.newGroup();
          return `(?=(${body}${q}))\\${g}`;
        }
        return body + q;
      }
      default: return '';
    }
  }

  emitNoCapture(n) {
    // re-emit a group body for a subexpression call: its own groups become non-capturing
    const copy = JSON.parse(JSON.stringify(n), (k, v) => (v && v.t === 'group' ? { t: 'nc', body: v.body } : v));
    return this.emit(copy);
  }

  emitClass(n) {
    const pos = [], negSets = [];
    for (const it of n.items) {
      if (it.set !== undefined) {
        if (it.neg) negSets.push(it.set);
        else pos.push(it.set);
      } else if (it.lo === it.hi) {
        if (n.ci && !this.ciFlag) for (const v of caseVariants(it.lo)) pos.push(classChar(v));
        else pos.push(classChar(it.lo));
      } else {
        pos.push(classChar(it.lo) + '-' + classChar(it.hi));
        if (n.ci && !this.ciFlag) pos.push(...ciRange(it.lo, it.hi));
      }
    }
    const P = pos.join('');
    if (!n.neg) {
      const parts = [];
      if (P) parts.push(`[${P}]`);
      for (const s of negSets) parts.push(`[^${s}]`);
      if (parts.length === 0) return '(?!)';
      return parts.length === 1 ? parts[0] : `(?:${parts.join('|')})`;
    }
    // negated: not(P or any negSet) = not P and (each negSet's complement holds)
    if (negSets.length === 0) return P ? `[^${P}]` : '[\\s\\S]';
    let s = '';
    if (P) s += `(?![${P}])`;
    for (let i = 1; i < negSets.length; i++) s += `(?=[${negSets[i]}])`;
    return s + `[${negSets[0]}]`;
  }
}

function ciRange(lo, hi) {
  const out = [];
  if (hi - lo > 2000) return out;
  for (let c = lo; c <= hi; c++) {
    for (const v of caseVariants(c)) if (v < lo || v > hi) out.push(classChar(v));
  }
  return out;
}

function isAtomic(n) {
  if (n.t === 'char' || n.t === 'any' || n.t === 'set' || n.t === 'class' || n.t === 'group' || n.t === 'nc') return true;
  if (n.t === 'backref') return true;
  return false;
}

function findGroup(n, num) {
  if (!n || typeof n !== 'object') return null;
  if (n.t === 'group' && n.n === num) return n;
  for (const k of ['body', 'items', 'alts']) {
    const v = n[k];
    if (Array.isArray(v)) { for (const x of v) { const r = findGroup(x, num); if (r) return r; } }
    else if (v) { const r = findGroup(v, num); if (r) return r; }
  }
  return null;
}

const CACHE = new Map();
function compile(pattern, options) {
  const key = options + '\0' + pattern;
  let c = CACHE.get(key);
  if (c) return c;
  const parser = new Parser(pattern, options | OPT_SINGLELINE);
  const root = parser.parse();
  parser.root = root;
  const ciFlag = !!(options & OPT_I) && !parser.ciChanges;
  const em = new Emitter(parser, ciFlag);
  const src = em.emit(root);
  let re;
  try {
    re = new RegExp(src, 'gdu' + (ciFlag ? 'i' : ''));
  } catch {
    throw new OnigError('invalid pattern');
  }
  c = { re, parser, groupMap: em.groupMap, keepGroup: em.keepGroup, gAnchor: em.gAnchor, ngroups: parser.ngroups };
  if (CACHE.size > 200) CACHE.clear();
  CACHE.set(key, c);
  return c;
}

// ---------------------------------------------------------------- f_match

// code point index of a UTF-16 index
function cpIndex(s, idx, cache) {
  let i = cache.i, n = cache.n;
  if (idx < i) { i = 0; n = 0; }
  for (; i < idx; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { i++; }
    n++;
  }
  cache.i = i; cache.n = n;
  return n;
}
const cpLen = (s, a, b) => {
  let n = 0;
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < b && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i++;
    n++;
  }
  return n;
};

const ERRFMT = (v) => dumpTrunc(v, 15);

export function fMatch(jq, input, regex, modifiers, testmode) {
  const test = testmode === true;
  if (typeof input !== 'string') return invalidMsg(`${typeName(input)} (${ERRFMT(input)}) cannot be matched, as it is not a string`);
  if (typeof regex !== 'string') return invalidMsg(`${typeName(regex)} (${ERRFMT(regex)}) is not a string`);
  let global = false, options = 0, findLongest = false, findNotEmpty = false;
  if (typeof modifiers === 'string') {
    for (const m of codepoints(modifiers)) {
      switch (m) {
        case 103: global = true; break;                       // g
        case 105: options |= OPT_I; break;                    // i
        case 120: options |= OPT_X; break;                    // x
        case 109: options |= OPT_S; break;                    // m: ONIG_OPTION_MULTILINE (dot matches newline)
        case 115: break;                                      // s: ONIG_OPTION_SINGLELINE (already the default)
        case 112: options |= OPT_S; break;                    // p: both
        case 108: findLongest = true; break;                  // l
        case 110: findNotEmpty = true; break;                 // n
        default: return invalidMsg(modifiers + ' is not a valid modifier string');
      }
    }
  } else if (modifiers !== null) {
    return invalidMsg(`${typeName(modifiers)} (${ERRFMT(modifiers)}) is not a string`);
  }
  let c;
  try { c = compile(regex, options); }
  catch (e) {
    if (e instanceof OnigError) return invalidMsg('Regex failure: ' + e.message);
    throw e;
  }
  const re = c.re;
  const str = input;
  const end = str.length;
  let result = test ? false : [];
  let start = 0;
  const cache = { i: 0, n: 0 };
  const search = (from) => {
    if (findLongest) return searchLongest(c, str, from);
    for (let pos = from; pos <= end;) {
      re.lastIndex = pos;
      const m = re.exec(str);
      if (!m) return null;
      if (c.gAnchor && m.index !== from) return null;
      let mstart = m.index;
      if (c.keepGroup !== null && m.indices[c.keepGroup]) mstart = m.indices[c.keepGroup][0];
      const mend = m.index + m[0].length;
      if (findNotEmpty && mend === mstart) {
        pos = m.index + 1;
        continue;
      }
      return { m, start: mstart, end: mend };
    }
    return null;
  };
  do {
    const r = search(start);
    if (!r) break;
    if (test) { result = true; break; }
    if (r.end === r.start) {
      result.push(new Map([['offset', cpIndex(str, r.start, cache)], ['length', 0], ['string', ''], ['captures', []]]));
      // jq steps one byte past the previous search start
      start += (start < end && (str.charCodeAt(start) & 0xfc00) === 0xd800) ? 2 : 1;
      continue;
    }
    const match = new Map([['offset', cpIndex(str, r.start, cache)], ['length', cpLen(str, r.start, r.end)], ['string', str.slice(r.start, r.end)]]);
    const captures = [];
    for (let g = 1; g <= c.ngroups; g++) {
      const jg = c.groupMap[g];
      const ix = jg !== undefined ? r.m.indices[jg] : undefined;
      let cap;
      if (!ix) {
        cap = new Map([['offset', -1], ['string', null], ['length', 0], ['name', null]]);
      } else if (ix[0] === ix[1]) {
        cap = new Map([['offset', cpIndex(str, ix[0], cache)], ['string', ''], ['length', 0], ['name', null]]);
      } else {
        cap = new Map([['offset', cpIndex(str, ix[0], cache)], ['length', cpLen(str, ix[0], ix[1])], ['string', str.slice(ix[0], ix[1])], ['name', null]]);
      }
      captures.push(cap);
    }
    for (const [name, nums] of c.parser.names) for (const g of nums) captures[g - 1].set('name', name);
    match.set('captures', captures);
    result.push(match);
    start = r.end;
  } while (global && start !== end && start < end + 1);
  return result;
}

function searchLongest(c, str, from) {
  let best = null;
  const re = c.re;
  for (let pos = from; pos <= str.length; pos++) {
    const sticky = new RegExp(re.source, re.flags.replace('g', '') + 'y');
    sticky.lastIndex = pos;
    const m = sticky.exec(str);
    if (m && (!best || m[0].length > best.end - best.start)) best = { m, start: m.index, end: m.index + m[0].length };
    if (c.gAnchor) break;
  }
  return best;
}
