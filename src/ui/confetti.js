// Pixel confetti burst on a full-screen canvas. Respects reduced motion.
const COLORS = ['--accent', '--green', '--yellow', '--peach', '--mauve', '--blue', '--teal', '--pink'];

export function confetti({ count = 140, duration = 1800, originY = 0.35 } = {}) {
  if (document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cs = getComputedStyle(document.documentElement);
  const palette = COLORS.map(v => cs.getPropertyValue(v).trim()).filter(Boolean);
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 1200 });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const W = canvas.width, H = canvas.height;
  const parts = Array.from({ length: count }, () => ({
    x: W * (0.3 + Math.random() * 0.4), y: H * originY,
    vx: (Math.random() - 0.5) * 18 * dpr, vy: (-6 - Math.random() * 14) * dpr,
    s: (3 + Math.floor(Math.random() * 3)) * 2 * dpr,
    c: palette[Math.floor(Math.random() * palette.length)] || '#A6E3A1',
    r: Math.random() < 0.5,
  }));
  const t0 = performance.now();
  function frame(t) {
    const k = (t - t0) / duration;
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.45 * dpr; p.vx *= 0.985; p.x += p.vx; p.y += p.vy;
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, k - 0.6) / 0.4);
      ctx.fillStyle = p.c;
      const sz = Math.round(p.s);
      ctx.fillRect(Math.round(p.x), Math.round(p.y), sz, p.r ? sz : Math.max(2, sz / 2));
    }
    if (k < 1) requestAnimationFrame(frame); else canvas.remove();
  }
  requestAnimationFrame(frame);
}
