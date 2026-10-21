// Special editions: three seasonal mini-campaigns with their own host, companions, art and
// certificate. Challenge ordering comes from the generated bundle (challenges/<edition>/).
import { ORDER } from './campaign.gen.js';

// Nerd Font icons built into Cardondev Mono (the terminal font) — see assets/fonts/fonts.css.
const GLYPH = {
  pumpkin: '\u{F0BBF}', ghost: '\u{F02A0}', turkey: '\u{F171B}', maple: '\u{F0C93}',
  tree: '\u{F1BB}', gift: '\u{F06B}', snowflake: '\u{F0717}',
};

const META = [
  {
    id: 'halloween', short: 'Halloween', name: 'Night of the Living Shell', season: 'October',
    window: [[10, 1], [11, 2]],
    tagline: 'Grimwood Manor wakes up every Halloween night. So do its servers.',
    blurb: 'Ten spooky challenges in a haunted mansion: summon hidden ghosts, brew sed potions, carve pumpkins with mv and banish every file that says BOO.',
    intro: 'The clocks of **Grimwood Manor** strike midnight and every server in the cellar groans back to life. **Zed**, the undead sysadmin, is still on call (it is in his contract, and he has no pulse to stop him). He needs a living pair of hands at the keyboard. Brains optional. Bash required.',
    host: 'zed', companions: ['zed', 'boolean', 'batch', 'jack'],
    cert: 'necromancer', rank: 'Necromancer',
    promptHost: 'grimwood', glyph: GLYPH.pumpkin, decor: 'bats',
    colors: ['#FF8A3D', '#B48EF5'], ink: '#1B1426',
    logo: 'assets/holiday/logo-halloween.svg', icon: 'pumpkin',
    unlocks: 'zed',
    music: 'bonus',
  },
  {
    id: 'thanksgiving', short: 'Thanksgiving', name: 'Thanksgrepping', season: 'November',
    window: [[11, 1], [11, 30]],
    tagline: 'The Great Feast at Maple Hollow Farm. Pass the gravy, pipe the data.',
    blurb: 'Ten cozy challenges around the harvest table: sort the seating chart, double the stuffing with awk, join relatives to their casseroles and write every thank-you note in one line.',
    intro: 'Leaves are falling, pies are cooling and the **Great Feast at Maple Hollow Farm** needs organising. **Sir Gobbles**, turkey, event coordinator and absolutely not the main course, has the guest lists, the recipes and a very long to-do list. He also has wings, which are terrible for typing.',
    host: 'gobbles', companions: ['gobbles', 'nutshell', 'pi', 'strawman'],
    cert: 'gobbler', rank: 'Pilgrim',
    promptHost: 'maplehollow', glyph: GLYPH.maple, decor: 'leaves',
    colors: ['#E8913A', '#C0392B'], ink: '#24170F',
    logo: 'assets/holiday/logo-thanksgiving.svg', icon: 'turkey',
    unlocks: 'gobbles',
    music: 'gameplay-2',
  },
  {
    id: 'christmas', short: 'Christmas', name: 'Jingle Shells', season: 'December',
    window: [[12, 1], [12, 31]],
    tagline: 'A 25-door advent calendar from the North Pole workshop.',
    blurb: 'Twenty-five festive challenges, one door per day: count letters to Santa, rank reindeer, swap coal for candy with sed, untangle wish lists with jq and plot the midnight run.',
    intro: 'It is December at the **North Pole workshop** and the advent calendar has twenty-five doors, each hiding a job only a terminal can do. **Santa Cron** runs exactly once a year (`0 0 25 12 *`), so the elves need someone who can run every day. Open a door, solve it, and move on to the next one.',
    host: 'santa', companions: ['santa', 'rudy', 'jingles', 'frosty', 'ginger'],
    cert: 'chief-elf', rank: 'Head Elf',
    promptHost: 'northpole', glyph: GLYPH.tree, decor: 'snow',
    colors: ['#E5484D', '#30A46C'], ink: '#0F1A14',
    logo: 'assets/holiday/logo-christmas.svg', icon: 'tree',
    unlocks: 'santa', dayLabel: 'Day',
    music: 'gameplay',
  },
];

export const EDITIONS = META.map(e => ({ ...e, challenges: (ORDER.editions && ORDER.editions[e.id]) || [] }));
export const EDITION_BY_ID = Object.fromEntries(EDITIONS.map(e => [e.id, e]));
export const isEdition = (kind) => !!EDITION_BY_ID[kind];

/** The edition whose season contains `date` (month/day windows), or null. */
export function inSeason(date = new Date()) {
  const md = (date.getMonth() + 1) * 100 + date.getDate();
  return EDITIONS.find(e => {
    const [[m1, d1], [m2, d2]] = e.window;
    return md >= m1 * 100 + d1 && md <= m2 * 100 + d2;
  }) || null;
}
