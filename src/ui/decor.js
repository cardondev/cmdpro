// Seasonal canvas decorations for the holiday editions: snow, falling leaves, bats.
// Pixel-art particles, cheap to draw; a single still frame under reduced motion.
// decor(canvas, kind, opts) starts the animation and returns a stop() function.

const SPRITES = {
  // rows of a tiny bitmap ('#' = ink); drawn at `scale` px per pixel
  bat: [
    ['#.......#', '##.....##', '###.#.###', '.#######.', '..#.#.#..'],
    ['.........', '#...#...#', '##.###.##', '.#######.', '..#.#.#..'],
  ],
  leaf: [['..##', '.###', '####', '###.', '#...']],
  maple: [['..#..', '#.#.#', '#####', '.###.', '..#..']],
  snow: [['.#.', '###', '.#.']],
  flake: [['#.#.#', '.###.', '##.##', '.###.', '#.#.#']],
  dot: [['#']],
};

const PALETTES = {
  bats: ['#1A1225', '#2B1E3B', '#3A2A52'],
  leaves: ['#E8913A', '#C0392B', '#F2C66D', '#A0522D', '#D35400'],
  snow: ['#FFFFFF', '#E8F1FF', '#CFE3FF'],
};

function reduced() {
  return document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function drawSprite(ctx, rows, x, y, s, color) {
  ctx.fillStyle = color;
  for (let j = 0; j < rows.length; j++) {
    const r = rows[j];
    for (let i = 0; i < r.length; i++) if (r[i] === '#') ctx.fillRect(Math.round(x + i * s), Math.round(y + j * s), s, s);
  }
}

export function decor(canvas, kind, { density = 1, scale, palette, alpha } = {}) {
  if (!canvas || !kind) return () => {};
  const ctx = canvas.getContext('2d');
  let w = 0, hgt = 0, parts = [], raf = 0, alive = true, t = 0;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const px = scale || Math.max(2, Math.round(2 * dpr));
  const pal = palette || PALETTES[kind] || PALETTES.snow;
  const rnd = (a, b) => a + Math.random() * (b - a);

  function spawn(initial) {
    const p = { x: rnd(0, w), y: initial ? rnd(0, hgt) : -20, phase: rnd(0, Math.PI * 2), color: pal[(Math.random() * pal.length) | 0] };
    if (kind === 'snow') Object.assign(p, { vy: rnd(0.25, 0.8) * dpr, vx: 0, sprite: Math.random() < 0.25 ? 'flake' : Math.random() < 0.5 ? 'snow' : 'dot', s: px * (Math.random() < 0.3 ? 1 : 0.5) });
    else if (kind === 'leaves') Object.assign(p, { vy: rnd(0.35, 0.9) * dpr, vx: rnd(-0.3, 0.3) * dpr, sprite: Math.random() < 0.4 ? 'maple' : 'leaf', s: px * 0.75 });
    else Object.assign(p, { y: initial ? rnd(0, hgt * 0.7) : rnd(0, hgt * 0.6), x: initial ? rnd(0, w) : -30, vx: rnd(0.4, 1.1) * dpr, vy: 0, sprite: 'bat', s: px * 0.75, flap: rnd(0, 10) });
    return p;
  }
  function resize() {
    w = canvas.width = Math.max(1, canvas.clientWidth * dpr);
    hgt = canvas.height = Math.max(1, canvas.clientHeight * dpr);
    const n = Math.round((w * hgt) / (kind === 'bats' ? 90000 : 14000) * density / dpr) + (kind === 'bats' ? 2 : 6);
    parts = Array.from({ length: Math.min(n, 140) }, () => spawn(true));
  }
  function frame() {
    t++;
    ctx.clearRect(0, 0, w, hgt);
    for (const p of parts) {
      if (!reduced()) {
        p.phase += 0.02;
        p.y += p.vy;
        p.x += p.vx + (kind === 'bats' ? 0 : Math.sin(p.phase) * 0.35 * dpr);
        if (kind === 'bats') p.y += Math.sin(p.phase * 2) * 0.4 * dpr;
        if (p.y > hgt + 20 || p.x > w + 40 || p.x < -40) Object.assign(p, spawn(false));
      }
      const frames = SPRITES[p.sprite];
      const f = frames.length > 1 ? frames[Math.floor((t + p.flap * 10) / 12) % frames.length] : frames[0];
      ctx.globalAlpha = alpha ?? (kind === 'snow' ? 0.85 : 0.9);
      drawSprite(ctx, f, p.x, p.y, Math.max(1, Math.round(p.s)), p.color);
    }
    ctx.globalAlpha = 1;
    if (alive && !reduced()) raf = requestAnimationFrame(frame);
  }
  resize();
  const ro = new ResizeObserver(() => { resize(); if (reduced()) frame(); });
  ro.observe(canvas);
  frame();
  return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); };
}
