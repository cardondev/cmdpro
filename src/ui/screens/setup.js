// Player setup: handle, name on certificates, avatar.
import { h, pick } from '../dom.js';
import { store } from '../../game/state.js';
import { play, music } from '../../game/audio.js';
import { go } from '../router.js';
import { topbar, button } from '../components.js';
import { avatars, avatarImg, avatarMeta } from '../sprites.js';
import { SETUP_COPY } from '../../data/copy.js';
import { EDITION_BY_ID } from '../../data/editions.js';
import { icon } from '../dom.js';

const HANDLES = ['grepster', 'sudo_sam', 'kernel_kat', 'bash_bandit', 'pipe_dream', 'segfault_sal', 'null_ptr', 'awk_ward', 'chmod_777',
  'root_beer', 'tac_tician', 'sed_lyfe', 'xargs_xavi', 'dev_null', 'cron_jobs', 'zombie_proc', 'ls_dash_la', 'tty_tina', 'emacs_ex', 'vim_quitter'];

export function sanitizeHandle(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 16); }

export async function render(r) {
  const next = r.query.get('next');
  const prof = store.state.profile;
  let handle = prof.handle || '';
  let certName = prof.certName || '';
  let avatar = prof.avatar || 'tee-m';

  const preview = h('div', { class: 'setup-preview card card-accent' });
  const promptPrev = h('div', { class: 'setup-prompt mono' });
  const nameEl = h('div', { class: 'setup-avatar-name' });
  const tagEl = h('div', { class: 'setup-avatar-tag secondary small' });
  const bigAv = h('div', { class: 'avatar avatar-xl setup-big' });

  function refreshPreview() {
    bigAv.replaceChildren(avatarImg(avatar));
    const m = avatarMeta(avatar);
    nameEl.textContent = m?.name || avatar;
    tagEl.textContent = m?.tagline || '';
    promptPrev.replaceChildren(
      h('span', { class: 'term-user' }, (handle || 'player') + '@cmdpro'), ':', h('span', { class: 'term-path' }, '~'), '$ ',
      h('span', { class: 'term-cursor blink' }, ' '));
  }
  preview.append(bigAv, nameEl, tagEl, promptPrev);

  const handleInput = h('input', { class: 'input input-lg mono', id: 'f-handle', value: handle, placeholder: 'e.g. grepster', maxlength: '16', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
  const handleHint = h('div', { class: 'field-hint' }, SETUP_COPY.handleHint);
  handleInput.addEventListener('input', () => {
    const v = sanitizeHandle(handleInput.value);
    if (v !== handleInput.value) handleInput.value = v;
    handle = v;
    handleHint.classList.remove('invalid');
    refreshPreview();
  });
  const dice = button('', { variant: 'muted', icon: 'reload', cls: 'btn-icon', attrs: { 'aria-label': 'Random handle', 'data-tip': 'Random handle' }, onClick: () => { handle = pick(HANDLES) + (Math.random() < 0.5 ? String(Math.floor(Math.random() * 90) + 10) : ''); handleInput.value = handle; refreshPreview(); } });
  const nameInput = h('input', { class: 'input input-lg', id: 'f-cert', value: certName, placeholder: 'Ada Lovelace', maxlength: '48', autocomplete: 'name' });
  nameInput.addEventListener('input', () => { certName = nameInput.value; });

  const tiles = new Map();
  // holiday avatars unlock with their edition's certificate
  const lockedBy = (a) => {
    const ed = a.unlock && EDITION_BY_ID[a.unlock];
    return ed && !store.state.certs[ed.cert] ? ed : null;
  };
  function tile(a) {
    const lock = lockedBy(a);
    const t = h('button', { type: 'button', class: 'avatar-tile' + (lock ? ' locked' : ''), 'aria-pressed': String(a.id === avatar), 'aria-label': lock ? `${a.name} (locked)` : a.name,
      'aria-disabled': lock ? 'true' : null,
      title: lock ? `Complete the ${lock.short} edition, “${lock.name}”, to unlock ${a.name}.` : (a.tagline || a.name),
      onclick: () => {
        if (lock) { play('error'); tagEl.textContent = `Locked: finish the ${lock.short} edition (“${lock.name}”) to unlock ${a.name}.`; return; }
        avatar = a.id; for (const [id, el] of tiles) el.setAttribute('aria-pressed', String(id === avatar)); play('menu-move'); refreshPreview();
      } },
    h('span', { class: 'avatar-tile-img' }, avatarImg(a.id)), h('span', { class: 'avatar-tile-name' }, a.name), lock && h('span', { class: 'avatar-tile-lock' }, icon('lock')));
    tiles.set(a.id, t);
    return t;
  }
  const all = avatars();
  const humans = all.filter(a => a.group === 'human');
  const others = all.filter(a => a.group === 'other');
  const specials = all.filter(a => a.group === 'special');

  const form = h('form', { class: 'setup-form col', onsubmit: (e) => { e.preventDefault(); save(); } },
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'f-handle' }, 'Handle'), h('div', { class: 'row' }, handleInput, dice), handleHint),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'f-cert' }, 'Name on certificates'), nameInput, h('div', { class: 'field-hint' }, SETUP_COPY.certNameHint)),
    h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Humans'), h('div', { class: 'avatar-grid' }, humans.map(tile))),
    h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Not humans (probably)'), h('div', { class: 'avatar-grid' }, others.map(tile))),
    specials.length && h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Special Editions'), h('div', { class: 'avatar-grid' }, specials.map(tile)), h('div', { class: 'field-hint' }, 'Unlocked by finishing the Special Editions.')),
    h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '8px' } },
      button('Cancel', { variant: 'muted', sound: 'back', onClick: () => go('title') }),
      button(next ? 'Save & continue' : 'Save', { variant: 'primary', size: 'lg', type: 'submit', sound: null, icon: 'check' })));

  function save() {
    if (!handle) { handleHint.textContent = 'Every hacker needs a handle. Pick one (or roll the dice).'; handleHint.classList.add('invalid'); handleInput.focus(); play('error'); return; }
    store.update(s => {
      s.profile.handle = handle;
      s.profile.certName = certName.trim();
      s.profile.avatar = avatar;
      s.profile.created ||= new Date().toISOString();
      s.stats.firstPlay ||= new Date().toISOString();
    }, { immediate: true });
    play('unlock');
    go(next || 'title');
  }

  refreshPreview();
  const el = h('div', { class: 'screen' },
    topbar({ title: 'Player setup', back: 'title' }),
    h('main', { class: 'page setup-page' },
      h('div', { class: 'section-title' }, h('div', { class: 'eyebrow' }, 'Player 1'), h('h1', { class: 'h1' }, 'Who is at the keyboard?'), h('p', { class: 'secondary' }, 'Pick a handle and an avatar. You can change both any time.')),
      h('div', { class: 'setup-layout' }, preview, h('div', { class: 'card' }, form))));
  return { el, mounted() { music('title'); handleInput.focus(); } };
}

