// Title screen: logo, PRESS START, arcade menu.
import { h, icon, pick } from '../dom.js';
import { md } from '../markdown.js';
import { store } from '../../game/state.js';
import { play, music } from '../../game/audio.js';
import { go } from '../router.js';
import { avatarImg } from '../sprites.js';
import { TIPS, TITLE_TAGLINES } from '../../data/copy.js';
import { confirmModal } from '../modal.js';
import { toast } from '../toast.js';
import { BONUS } from '../../data/campaign.js';

let started = false; // PRESS START only once per page load

function logo() {
  const wrap = h('div', { class: 'title-logo' });
  const img = h('img', { src: 'assets/brand/logo-stacked.svg', alt: 'CMDPRO', class: 'title-logo-img', draggable: 'false' });
  img.addEventListener('error', () => {
    img.replaceWith(h('div', { class: 'text-logo', 'aria-label': 'CMDPRO' }, h('span', { class: 'text-logo-prompt' }, '>_'), 'CMDPRO'));
  }, { once: true });
  wrap.appendChild(img);
  return wrap;
}

function starfield(canvas) {
  const ctx = canvas.getContext('2d');
  let w, hgt, stars, raf, alive = true;
  const reduce = () => document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const resize = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    w = canvas.width = canvas.clientWidth * dpr;
    hgt = canvas.height = canvas.clientHeight * dpr;
    stars = Array.from({ length: Math.round((w * hgt) / 9000) }, () => ({ x: Math.random() * w, y: Math.random() * hgt, z: 0.3 + Math.random() * 0.7, t: Math.random() * 6 }));
  };
  const color = () => getComputedStyle(document.documentElement).getPropertyValue('--sub1').trim() || '#BAC2DE';
  let col = color();
  const draw = () => {
    ctx.clearRect(0, 0, w, hgt);
    for (const s of stars) {
      if (!reduce()) { s.y += s.z * 0.35; s.t += 0.03; if (s.y > hgt) { s.y = 0; s.x = Math.random() * w; } }
      const a = 0.25 + 0.55 * s.z * (0.6 + 0.4 * Math.sin(s.t));
      ctx.globalAlpha = a;
      ctx.fillStyle = col;
      const sz = s.z > 0.85 ? 3 : 2;
      ctx.fillRect(Math.round(s.x), Math.round(s.y), sz, sz);
    }
    if (alive) raf = requestAnimationFrame(draw);
  };
  resize();
  const ro = new ResizeObserver(resize); ro.observe(canvas);
  const unsub = store.subscribe(() => { col = color(); });
  draw();
  return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); unsub(); };
}

export async function render() {
  const st = store.state;
  const best = Math.max(0, ...Object.values(st.highscores).flat().map(x => x.score || 0));
  const certCount = Object.keys(st.certs).length;
  const canvas = h('canvas', { class: 'title-stars', 'aria-hidden': 'true' });
  const tagline = h('p', { class: 'title-tagline' }, pick(TITLE_TAGLINES));
  const press = h('button', { class: 'press-start arcade', type: 'button' }, 'PRESS START');
  const menuItems = [
    ['Campaign', 'play', 'Start or continue the campaign', () => (st.profile.handle ? go('difficulty/campaign') : go('setup?next=difficulty/campaign'))],
    ['Tutorial', 'help', 'Every menu, key and command, step by step', () => go('tutorial')],
    ['Bonus Round', 'zap', 'Five problems for the beyond-expert', async () => {
      if (!BONUS.challenges.length) { toast({ title: 'Bonus Round is still compiling', body: 'Five brutal problems are on their way in a future build.', iconName: 'hourglass' }); return; }
      const ok = await confirmModal({
        title: 'Are you sure?',
        message: h('div', { class: 'col' },
          h('p', { class: 'secondary' }, 'The Bonus Round is five problems that have made senior engineers weep into their mechanical keyboards. `sudo` will not help you here.'),
          h('p', { class: 'muted small' }, 'Beat all five to earn the Machine certificate.')),
        ok: 'I am beyond expert', cancel: 'Take me back',
      });
      if (ok) st.profile.handle ? go('difficulty/bonus') : go('setup?next=difficulty/bonus');
    }],
    ['Special Editions', 'sparkles', 'Halloween · Thanksgiving · Christmas', () => go('editions')],
    ['Free Play', 'gamepad', 'Practice any challenge, no pressure', () => go('freeplay')],
    ['Side Quests', 'gift', 'Gremlins Ate /bin · The Twelve Labors', () => go('sidequests')],
    ['Wall of Certificates', 'trophy', `${certCount} earned`, () => go('wall')],
    ['Settings', 'sliders', 'Themes, sound, CRT, data', () => go('settings')],
    ['Credits', 'info', 'Who made this possible', () => go('credits')],
  ];
  let sel = 0;
  const isNew = (label) => (label === 'Special Editions' && !st.seen.editions) || (label === 'Tutorial' && !st.seen.tutorial);
  const items = menuItems.map(([label, ic, sub, fn], i) => h('button', {
    type: 'button', class: 'title-item', role: 'menuitem', 'data-i': String(i), 'data-item': label.toLowerCase().replace(/[^a-z]+/g, '-'),
    onmouseenter: () => setSel(i, true), onfocus: () => setSel(i, false),
    onclick: () => { play('menu-select'); fn(); },
  }, h('span', { class: 'title-caret', 'aria-hidden': 'true' }, '▶'), icon(ic),
  h('span', { class: 'title-item-label' }, label, isNew(label) && [' ', h('span', { class: 'title-new arcade' }, 'NEW')]), h('span', { class: 'title-item-sub' }, sub)));
  const menu = h('nav', { class: 'title-menu', role: 'menu', 'aria-label': 'Main menu' }, items);
  function setSel(i, sound) {
    if (i === sel && items[i].classList.contains('active')) return;
    sel = (i + items.length) % items.length;
    items.forEach((b, j) => b.classList.toggle('active', j === sel));
    if (sound) play('menu-move');
  }
  setSel(0, false);

  const chip = h('button', { type: 'button', class: 'player-chip', onclick: () => { play('menu-select'); go('setup'); } },
    avatarImg(st.profile.avatar, { cls: 'player-chip-img' }),
    h('span', { class: 'player-chip-text' },
      h('span', { class: 'player-chip-k' }, 'PLAYER 1'),
      h('span', { class: 'player-chip-v' }, st.profile.handle || 'insert name')),
    icon('edit'));

  // brand-new players get pointed at the tutorial instead of a random tip
  const newcomer = !st.seen.tutorial && !st.stats.commands;
  const tip = h('div', { class: 'title-tip' }, h('span', { class: 'eyebrow' }, newcomer ? 'New here?' : 'Tip'),
    md(newcomer ? 'Pick **Tutorial** for a guided tour of every menu, then a training round where nothing counts.' : pick(TIPS), 'md title-tip-text'));
  const stage = h('div', { class: 'title-stage' }, logo(), tagline, press, menu, tip);
  const el = h('div', { class: 'screen title-screen scanlines' + (started ? ' started' : '') },
    canvas,
    h('div', { class: 'title-grid', 'aria-hidden': 'true' }),
    h('header', { class: 'title-top' },
      h('div', { class: 'title-hiscore arcade' }, h('span', null, 'HI-SCORE'), h('span', { class: 'accent' }, String(Math.round(best)).padStart(6, '0'))),
      chip),
    stage,
    h('footer', { class: 'title-foot arcade' }, h('span', null, '© 2026 CMDPRO'), h('span', { class: 'blink-slow' }, 'INSERT COIN'), h('span', null, `CERTS ${String(certCount).padStart(2, '0')}`)));

  function start() {
    if (started && el.classList.contains('started')) return;
    started = true;
    el.classList.add('started');
    play('menu-select');
    music('title');
    requestAnimationFrame(() => items[sel].focus({ preventScroll: true }));
  }
  press.addEventListener('click', start);

  const onKey = (e) => {
    if (document.querySelector('.modal-backdrop')) return;
    if (!el.classList.contains('started')) {
      if (['Enter', ' ', 'Spacebar'].includes(e.key) || e.key.length === 1) { e.preventDefault(); start(); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'j') { e.preventDefault(); setSel(sel + 1, true); items[sel].focus(); }
    else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'k') { e.preventDefault(); setSel(sel - 1, true); items[sel].focus(); }
    else if (e.key === 'Escape') { el.classList.remove('started'); started = false; play('back'); press.focus(); }
  };

  let stopStars = null;
  return {
    el,
    mounted() {
      stopStars = starfield(canvas);
      window.addEventListener('keydown', onKey);
      if (started) { music('title'); items[sel].focus({ preventScroll: true }); }
      else press.focus({ preventScroll: true });
    },
    destroy() { stopStars && stopStars(); window.removeEventListener('keydown', onKey); },
  };
}

