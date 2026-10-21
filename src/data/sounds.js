// Sound manifest for CMDPRO. Paths are relative to index.html.
// All audio is CC0 (see CREDITS.md); files are rebuilt by tools/media/build-audio.sh.
//
// `volume` is a per-clip trim (0..1) that balances perceived loudness between
// clips; multiply it by the player's master/SFX/music volume at playback time.
// Every SFX is mono 44.1 kHz MP3, peak-normalised, silence-trimmed.

/** Sound effects, keyed by game event. */
export const SFX = {
  // typing — alternate key/key-alt randomly so fast typing doesn't sound robotic
  'key':         { file: 'assets/sfx/key.mp3',         volume: 0.30 }, // keystroke click
  'key-alt':     { file: 'assets/sfx/key-alt.mp3',     volume: 0.35 }, // keystroke click variation
  'enter':       { file: 'assets/sfx/enter.mp3',       volume: 0.60 }, // command submitted
  'bell':        { file: 'assets/sfx/bell.mp3',        volume: 0.30 }, // terminal bell: no tab completion / blocked keystroke

  // judging
  'success':     { file: 'assets/sfx/success.mp3',     volume: 0.35 }, // correct answer
  'fail':        { file: 'assets/sfx/fail.mp3',        volume: 0.50 }, // wrong answer (lost an attempt)
  'error':       { file: 'assets/sfx/error.mp3',       volume: 0.33 }, // invalid action (e.g. paste blocked in Extreme)
  'gameover':    { file: 'assets/sfx/gameover.mp3',    volume: 0.85 }, // out of attempts / timer expired
  'coin':        { file: 'assets/sfx/coin.mp3',        volume: 0.60 }, // score points tallied
  'unlock':      { file: 'assets/sfx/unlock.mp3',      volume: 0.40 }, // something unlocked (tier, side quest)
  'levelup':     { file: 'assets/sfx/levelup.mp3',     volume: 0.45 }, // tier complete
  'cert':        { file: 'assets/sfx/cert.mp3',        volume: 0.55 }, // certificate issued
  'hint':        { file: 'assets/sfx/hint.mp3',        volume: 1.00 }, // hint revealed (lightbulb chime)
  'companion':   { file: 'assets/sfx/companion.mp3',   volume: 0.40 }, // companion joins / speaks up

  // timer (Extremely Hard)
  'warning':     { file: 'assets/sfx/warning.mp3',     volume: 0.70 }, // 30 seconds left
  'tick':        { file: 'assets/sfx/tick.mp3',        volume: 0.30 }, // once per second in the last 10s

  // menus & screens
  'menu-move':   { file: 'assets/sfx/menu-move.mp3',   volume: 0.40 }, // focus moves between menu items
  'menu-select': { file: 'assets/sfx/menu-select.mp3', volume: 0.50 }, // menu item chosen
  'back':        { file: 'assets/sfx/back.mp3',        volume: 1.00 }, // back / cancel / Esc
  'toggle':      { file: 'assets/sfx/toggle.mp3',      volume: 0.60 }, // settings switch flipped
  'open':        { file: 'assets/sfx/open.mp3',        volume: 0.60 }, // panel / modal opens
  'close':       { file: 'assets/sfx/close.mp3',       volume: 0.60 }, // panel / modal closes
  'whoosh':      { file: 'assets/sfx/whoosh.mp3',      volume: 0.50 }, // screen transition

  // boot sequence
  'boot':        { file: 'assets/sfx/boot.mp3',        volume: 0.32 }, // BIOS POST beep
  'poweron':     { file: 'assets/sfx/poweron.mp3',     volume: 0.65 }, // power-on hum at boot start
  'shutdown':    { file: 'assets/sfx/shutdown.mp3',    volume: 0.45 }, // power-down (kernel panic / quit)
};

/** Background music. Loops are seamless (constant-gain normalised, LAME gapless tags). */
export const MUSIC = {
  'title':      { file: 'assets/music/title.mp3',      volume: 0.50, loop: true,  duration: 11.294 }, // title screen / menus
  'gameplay':   { file: 'assets/music/gameplay.mp3',   volume: 0.35, loop: true,  duration: 21.333 }, // calm loop while solving
  'gameplay-2': { file: 'assets/music/gameplay-2.mp3', volume: 0.30, loop: true,  duration: 41.143 }, // alternate gameplay loop (e.g. odd tiers)
  'bonus':      { file: 'assets/music/bonus.mp3',      volume: 0.40, loop: true,  duration: 71.724 }, // Bonus Round "Machine" — boss fight energy
  'victory':    { file: 'assets/music/victory.mp3',    volume: 0.60, loop: false, duration: 9.0 },    // campaign / bonus complete jingle
};

/** Random variants to rotate through for a single logical event. */
export const SFX_VARIANTS = {
  key: ['key', 'key-alt'],
};
