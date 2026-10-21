// Certificates issued by the CMDPRO Certificate Authority.
// `body` placeholders: {name}. Colours drive the certificate frame + seal fallback.

export const CERTS = [
  {
    id: 'foundations', order: 1, kind: 'tier', tier: 1,
    title: 'CMDPRO Certified Foundations', short: 'Foundations', rank: 'Newbie',
    slogan: 'Hello, World. Goodbye, GUI.',
    body: 'has bravely typed commands into the void — and the void answered. They can echo, list, copy, move, link and conjure directories out of thin air, and they now know that `ls` is not a typo.',
    earn: 'Complete Tier 1 in the campaign.',
    colors: ['#B87333', '#E8A87C'], metal: 'Bronze',
  },
  {
    id: 'engineer', order: 2, kind: 'tier', tier: 2,
    title: 'CMDPRO Certified Engineer', short: 'Engineer', rank: 'Nerd',
    slogan: 'grep is my wingman.',
    body: 'can find a string in a haystack of logs, count files nobody asked them to count, and delete things with the quiet confidence of someone who has backups. (They have backups. Right?)',
    earn: 'Complete Tier 2 in the campaign.',
    colors: ['#A0522D', '#E9B486'], metal: 'Bronze',
  },
  {
    id: 'sr-engineer', order: 3, kind: 'tier', tier: 3,
    title: 'CMDPRO Certified Sr. Engineer', short: 'Sr. Engineer', rank: 'Geek',
    slogan: 'Pipes things together. Plumbers are concerned.',
    body: 'has mastered the ancient art of the pipe. tr, seq, sed, paste and bc now flow through their veins, and they have been known to sum a column of numbers without opening a spreadsheet.',
    earn: 'Complete Tier 3 in the campaign.',
    colors: ['#8A9BA8', '#D9E2EA'], metal: 'Silver',
  },
  {
    id: 'architect', order: 4, kind: 'tier', tier: 4,
    title: 'CMDPRO Certified Architect', short: 'Architect', rank: 'Ninja',
    slogan: 'Moves silently between directories. xargs is my katana.',
    body: 'renames files in loops, finds anything by name, digit or extension, and quotes paths with spaces in them without even flinching. Their filesystem has never looked this organized.',
    earn: 'Complete Tier 4 in the campaign.',
    colors: ['#7D8C99', '#E3EAF0'], metal: 'Silver',
  },
  {
    id: 'principal', order: 5, kind: 'tier', tier: 5,
    title: 'CMDPRO Certified Principal', short: 'Principal', rank: 'Sensei',
    slogan: 'Teaches awk to awkward people.',
    body: 'wields awk and sed with calm authority, remembers previous lines, compares logs side by side and removes duplicates while preserving order. Junior engineers bow slightly when they walk past.',
    earn: 'Complete Tier 5 in the campaign.',
    colors: ['#C9A227', '#F6E27A'], metal: 'Gold',
  },
  {
    id: 'expert', order: 6, kind: 'tier', tier: 6,
    title: 'CMDPRO Certified Expert', short: 'Expert', rank: 'Wizard',
    slogan: 'Speaks fluent regex. Rarely invited to parties.',
    body: 'has factored primes, compared binaries byte by byte and sorted by keys that lesser mortals did not know existed. Their regular expressions compile on the first try. Usually.',
    earn: 'Complete Tier 6 in the campaign.',
    colors: ['#B8860B', '#FFE08A'], metal: 'Gold',
  },
  {
    id: 'guru', order: 7, kind: 'tier', tier: 7,
    title: 'CMDPRO Certified Guru', short: 'Guru', rank: 'Show-off',
    slogan: 'Writes one-liners that are technically three lines.',
    body: 'has conquered the Guru tier: transposed matrices, cracked ciphers and parsed netstat without blinking. They will absolutely tell you about it. At length. With diagrams.',
    earn: 'Complete Tier 7 in the campaign.',
    colors: ['#6B5B95', '#CBA6F7'], metal: 'Platinum',
  },
  {
    id: 'ai', order: 8, kind: 'bonus',
    title: 'CMDPRO Certified Machine', short: 'Machine', rank: 'Machine',
    slogan: 'Passed the reverse Turing test. We checked for a power cord.',
    body: 'solved the five bonus problems that make senior engineers weep. The Certificate Authority has opened a formal investigation into whether {name} is, in fact, a machine.',
    earn: 'Beat the Bonus Round (any difficulty).',
    colors: ['#3BA7C9', '#A6E3A1'], metal: 'Prismatic',
  },
  {
    id: 'warrior', order: 9, kind: 'legendary',
    title: 'The Command Line Warrior', short: 'Warrior', rank: 'Legend',
    slogan: 'Only awarded to those who are worthy. Typed every keystroke. Pasted nothing.',
    body: 'completed the entire campaign AND the bonus round on EXTREMELY HARD: one attempt per challenge, a ticking clock, no hints and no paste. GUIs everywhere fear this person. Grant them root.',
    earn: 'Finish the full campaign + bonus on Extremely Hard.',
    colors: ['#B22222', '#FFD700'], metal: 'Legendary',
  },
  {
    id: 'oops', order: 10, kind: 'side',
    title: 'Certified Disaster Recovery Specialist', short: 'Disaster Recovery', rank: 'Survivor',
    slogan: 'Lost /bin. Kept calm. echo\'d on.',
    body: 'faced down the gremlin that ate /bin and /usr/bin, armed with nothing but bash builtins, grit and `$(<file)`. The precious file was saved, the gremlin was sent to bed without supper, and disaster-recovery teams would like to know their secret.',
    earn: 'Complete the side quest "Gremlins Ate /bin".',
    colors: ['#C2410C', '#FDBA74'], metal: 'Copper',
  },
  {
    id: 'elf', order: 11, kind: 'side',
    title: 'Certified Demigod of the Dozen', short: 'Demigod', rank: 'Demigod',
    slogan: 'Twelve labors. Zero GUIs.',
    body: 'completed the Twelve Labors of Bashercules: counted the Hydra\'s heads, mucked out the stables with grep, herded every file to where it belonged and read the final scroll aloud. Mount Olympus has granted them sudo. Temporarily.',
    earn: 'Complete the side quest "The Twelve Labors".',
    colors: ['#A07C1E', '#EAD9A0'], metal: 'Laurel',
  },
  {
    id: 'necromancer', order: 12, kind: 'edition', edition: 'halloween',
    title: 'Certified Shell Necromancer', short: 'Necromancer', rank: 'Necromancer',
    slogan: 'Raised dead processes. Fed them brains.',
    body: 'survived the Night of the Living Shell at Grimwood Manor: summoned hidden ghosts, brewed sed potions, carved pumpkins with mv, decoded the bats\' backwards radio and banished every file that said BOO. Zed the zombie sysadmin vouches for their brains (delicious).',
    earn: 'Complete the Halloween edition, "Night of the Living Shell".',
    colors: ['#FF8A3D', '#8E5CD9'], metal: 'Spooky',
  },
  {
    id: 'gobbler', order: 13, kind: 'edition', edition: 'thanksgiving',
    title: 'Certified Feast Engineer', short: 'Feast Engineer', rank: 'Pilgrim',
    slogan: 'Thankful for pipes. Stuffed with grep.',
    body: 'hosted the Great Feast at Maple Hollow Farm without opening a single spreadsheet: sorted the seating chart, doubled the stuffing with awk, joined every relative to their casserole and wrote a thank-you note to each guest in one line. Sir Gobbles has officially pardoned them.',
    earn: 'Complete the Thanksgiving edition, "Thanksgrepping".',
    colors: ['#C9772B', '#F2C66D'], metal: 'Harvest Gold',
  },
  {
    id: 'chief-elf', order: 14, kind: 'edition', edition: 'christmas',
    title: 'Certified Chief Elf Officer', short: 'Chief Elf', rank: 'Head Elf',
    slogan: 'Checked the list twice. sort -u\'d it once.',
    body: 'opened all twenty-five doors of the Jingle Shells advent calendar: counted letters to Santa, ranked the reindeer, swapped coal for candy with sed, untangled wish lists with jq and plotted the midnight run with awk. Santa Cron has added them to the nice list (sorted, deduplicated).',
    earn: 'Complete the Christmas edition, "Jingle Shells".',
    colors: ['#D7263D', '#2E9E5B'], metal: 'Tinsel',
  },
];

export const CERT_BY_ID = Object.fromEntries(CERTS.map(c => [c.id, c]));

export const DIFFICULTY_STAMP = {
  easy: { label: 'EASY', color: '#1E66F5' },
  normal: { label: 'NORMAL', color: '#40A02B' },
  hard: { label: 'HARD', color: '#DF8E1D' },
  extreme: { label: 'EXTREMELY HARD', color: '#D20F39' },
};

export const ISSUER = 'CN=CMDPRO Root CA, O=CMDPRO Certificate Authority, OU=Department of Bragging Rights';
export const KEY_USAGE = 'Bragging, Showing Off, LinkedIn';
export const NOT_AFTER = 'the heat death of the universe or your next `rm -rf /`, whichever comes first';
