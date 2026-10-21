// Credits: the creator, then the third-party notices from CREDITS.md.
import { h, icon } from '../dom.js';
import { md } from '../markdown.js';
import { music } from '../../game/audio.js';
import { topbar } from '../components.js';

export async function render() {
  let creditsMd = '';
  try { const r = await fetch('CREDITS.md'); if (r.ok) creditsMd = await r.text(); } catch { /* offline & uncached */ }
  // the third-party part of CREDITS.md (the creator gets the card above it)
  const at = creditsMd.indexOf('## Third-party assets');
  const body = at >= 0 ? creditsMd.slice(at) : '';
  const el = h('div', { class: 'screen' },
    topbar({ title: 'Credits', back: 'title' }),
    h('main', { class: 'page page-narrow credits-page' },
      h('div', { class: 'section-title' }, h('div', { class: 'eyebrow' }, 'Roll credits'), h('h1', { class: 'h1' }, 'Credits')),
      h('div', { class: 'card card-accent credits-hero' },
        h('div', { class: 'credits-hero-icon' }, icon('terminal')),
        h('div', null,
          h('div', { class: 'card-label' }, 'Created by'),
          h('div', { class: 'subhead' }, h('a', { href: 'https://github.com/cardondev', target: '_blank', rel: 'noopener noreferrer' }, 'cardondev')),
          h('p', { class: 'secondary credits-role' }, 'Creator of CMDPRO and author of ', h('a', { href: 'https://github.com/cardondev/cardondev-fonts', target: '_blank', rel: 'noopener noreferrer' }, 'Cardondev Fonts'), '.'))),
      body ? h('div', { class: 'card credits-md' }, md(body, 'md')) : h('p', { class: 'muted' }, 'See CREDITS.md for the third-party licenses.')));
  return { el, mounted() { music('title'); } };
}
