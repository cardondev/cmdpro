// Settings: themes (live preview), CRT, motion, font size, sound, profile, data, stats.
import { h, icon, fmtNum, downloadBlob } from '../dom.js';
import { store } from '../../game/state.js';
import { play, music } from '../../game/audio.js';
import { setSetting } from '../../game/settings.js';
import { go } from '../router.js';
import { topbar, button, switchEl, card, stat } from '../components.js';
import { THEMES } from '../../data/themes.js';
import { avatarImg, avatarMeta } from '../sprites.js';
import { openModal } from '../modal.js';
import { toast } from '../toast.js';
import { DIFFICULTIES, DIFFICULTY_ORDER } from '../../game/rules.js';

function themeCard(t, selected, onPick) {
  const el = h('button', { type: 'button', class: 'theme-card', 'data-theme': t.id, 'aria-pressed': String(selected), onclick: () => onPick(t.id) },
    h('div', { class: 'theme-preview' },
      h('div', { class: 'theme-preview-bar' }, h('i'), h('i'), h('i')),
      h('div', { class: 'theme-preview-body mono' },
        h('div', null, h('span', { class: 'term-user' }, 'you@cmdpro'), ':', h('span', { class: 'term-path' }, '~'), '$ ls --color'),
        h('div', null, h('span', { class: 'ansi-fg-4 ansi-bold' }, 'logs/'), '  ', h('span', { class: 'ansi-fg-2 ansi-bold' }, 'run.sh'), '  notes.txt  ', h('span', { class: 'ansi-fg-6' }, 'link')),
        h('div', null, h('span', { class: 'ansi-fg-1' }, 'error'), ' ', h('span', { class: 'ansi-fg-3' }, 'warn'), ' ', h('span', { class: 'ansi-fg-5' }, 'magic'), ' ', h('span', { class: 'term-cursor' }, ' ')))),
    h('div', { class: 'theme-meta' },
      h('div', { class: 'theme-name' }, t.name, h('span', { class: 'theme-swatch' })),
      h('div', { class: 'theme-blurb' }, t.blurb)));
  return el;
}

export async function render() {
  const st = store.state;
  const s = st.settings;

  // ---- appearance ----
  const themeGrid = h('div', { class: 'theme-grid' });
  const drawThemes = () => {
    const pickTheme = (id) => { setSetting('theme', id); play('toggle'); drawThemes(); };
    const group = (label, list) => [h('div', { class: 'eyebrow theme-group-label' }, label), ...list.map(t => themeCard(t, store.state.settings.theme === t.id, pickTheme))];
    themeGrid.replaceChildren(...group('Dark', THEMES.filter(t => t.kind !== 'light')), ...group('Light', THEMES.filter(t => t.kind === 'light')));
  };
  drawThemes();
  const fontVal = h('span', { class: 'mono small' }, `${s.fontSize}px`);
  const fontRange = h('input', { type: 'range', min: '12', max: '22', step: '1', value: String(s.fontSize), 'aria-label': 'Terminal font size' });
  fontRange.addEventListener('input', () => { fontVal.textContent = fontRange.value + 'px'; setSetting('fontSize', +fontRange.value); });
  const fontPreview = h('div', { class: 'font-preview mono' }, h('span', { class: 'term-user' }, 'you@cmdpro'), ':', h('span', { class: 'term-path' }, '~'), '$ echo "readable at any size"');

  // ---- sound ----
  const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.sound.volume), 'aria-label': 'Volume' });
  const volVal = h('span', { class: 'mono small' }, Math.round(s.sound.volume * 100) + '%');
  vol.addEventListener('input', () => { volVal.textContent = Math.round(vol.value * 100) + '%'; setSetting('sound.volume', +vol.value); });
  vol.addEventListener('change', () => play('coin'));

  // ---- data ----
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    try {
      store.importJSON(await f.text());
      toast({ title: 'Save imported', body: 'Welcome back. Your certificates missed you.', iconName: 'upload' });
      play('unlock');
      go('settings');
    } catch (e) {
      toast({ title: 'Import failed', body: String(e.message || e), iconName: 'close' });
      play('error');
    }
    fileInput.value = '';
  });
  const resetFlow = () => {
    const inp = h('input', { class: 'input mono', placeholder: 'rm -rf progress', autofocus: true, 'aria-label': 'Type rm -rf progress to confirm' });
    openModal({
      title: 'Reset all progress?',
      body: h('div', { class: 'col' },
        h('p', { class: 'secondary' }, 'This wipes every save slot, certificate, high score and stat. Your profile and settings stay. There is no undo (we checked, there is no `trash` in /bin).'),
        h('p', { class: 'small' }, 'Type ', h('code', { class: 'inline' }, 'rm -rf progress'), ' to confirm:'),
        inp),
      actions: [
        { label: 'Cancel', variant: 'muted' },
        { label: 'Reset everything', variant: 'danger', onClick: () => {
          if (inp.value.trim() !== 'rm -rf progress') { inp.classList.add('shake'); setTimeout(() => inp.classList.remove('shake'), 500); play('error'); return false; }
          store.resetProgress();
          toast({ title: 'Progress reset', body: 'Fresh start. The cursor blinks with anticipation.', iconName: 'trash' });
          play('shutdown');
          go('settings');
          return true;
        } },
      ],
    });
  };

  const stats = st.stats;
  const hs = DIFFICULTY_ORDER.map(d => {
    const list = (st.highscores[d] || []).slice(0, 5);
    return h('div', { class: 'hs-col' },
      h('div', { class: 'eyebrow', style: { color: DIFFICULTIES[d].color } }, DIFFICULTIES[d].name),
      list.length ? h('ol', { class: 'hs-list mono' }, list.map(x => h('li', null, h('span', null, x.handle), h('span', { class: 'accent' }, fmtNum(x.score))))) : h('div', { class: 'faint small' }, 'No scores yet'));
  });

  const prof = st.profile;
  const el = h('div', { class: 'screen' },
    topbar({ title: 'Settings', back: 'title' }),
    h('main', { class: 'page settings-page' },
      h('div', { class: 'section-title' }, h('div', { class: 'eyebrow' }, 'Configuration'), h('h1', { class: 'h1' }, 'Settings'), h('p', { class: 'secondary' }, 'Everything saves automatically. No `:wq` required.')),
      !store.storageOk && h('div', { class: 'callout warn', style: { marginBottom: '16px' } }, icon('info'), h('div', null, 'Your browser is blocking storage, so progress lasts only until you close this tab. Export a save file to keep it.')),

      card([h('div', { class: 'card-label' }, 'Theme'), themeGrid], { cls: 'settings-card settings-themes' }),

      h('div', { class: 'settings-two' },
        card([
          h('div', { class: 'card-label' }, 'Display'),
          h('div', { class: 'col', style: { gap: '16px' } },
            switchEl({ label: 'CRT effect (scanlines, glow, flicker)', checked: s.crt !== false, onChange: (v) => setSetting('crt', v) }),
            switchEl({ label: 'Reduce motion', checked: !!s.reduceMotion, onChange: (v) => setSetting('reduceMotion', v) }),
            h('div', { class: 'field' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', { class: 'field-label' }, 'Terminal font size'), fontVal), fontRange, fontPreview)),
        ], { cls: 'settings-card settings-display' }),
        card([
          h('div', { class: 'card-label' }, 'Sound'),
          h('div', { class: 'col', style: { gap: '16px' } },
            switchEl({ label: 'Sound (master)', checked: s.sound.master, onChange: (v) => { setSetting('sound.master', v); if (v) { play('toggle'); music('title'); } } }),
            switchEl({ label: 'Sound effects', checked: s.sound.sfx, onChange: (v) => setSetting('sound.sfx', v) }),
            switchEl({ label: 'Music', checked: s.sound.music, onChange: (v) => { setSetting('sound.music', v); if (v) music('title'); } }),
            switchEl({ label: 'Keyboard clicks', checked: s.sound.typing, onChange: (v) => setSetting('sound.typing', v) }),
            h('div', { class: 'field' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', { class: 'field-label' }, 'Volume'), volVal), vol),
            button('Test sound', { variant: 'muted', size: 'sm', icon: 'volume-2', onClick: () => play('success'), sound: null })),
        ], { cls: 'settings-card settings-sound' })),

      h('div', { class: 'settings-two' },
        card([
          h('div', { class: 'card-label' }, 'Profile'),
          h('div', { class: 'row', style: { gap: '16px' } },
            h('div', { class: 'avatar avatar-lg' }, avatarImg(prof.avatar)),
            h('div', { class: 'col', style: { gap: '4px' } },
              h('div', { class: 'subhead mono' }, prof.handle || 'no handle yet'),
              h('div', { class: 'secondary small' }, prof.certName ? `Certificates say: ${prof.certName}` : 'Certificates use your handle'),
              h('div', { class: 'faint small' }, avatarMeta(prof.avatar)?.name || ''),
              button('Edit profile', { variant: 'secondary', size: 'sm', icon: 'edit', onClick: () => go('setup') }))),
        ], { cls: 'settings-card settings-profile' }),
        card([
          h('div', { class: 'card-label' }, 'Save data'),
          h('p', { class: 'secondary small' }, 'Progress lives in this browser (localStorage). Export a save file to move it to another device — or to frame it.'),
          h('div', { class: 'row-wrap' },
            button('Export save', { variant: 'secondary', icon: 'download', onClick: () => { downloadBlob(new Blob([store.exportJSON()], { type: 'application/json' }), `cmdpro-save-${new Date().toISOString().slice(0, 10)}.json`); } }),
            button('Import save', { variant: 'secondary', icon: 'upload', onClick: () => fileInput.click() }),
            button('Reset progress', { variant: 'danger', icon: 'trash', onClick: resetFlow })),
          fileInput,
        ], { cls: 'settings-card settings-data' })),

      card([
        h('div', { class: 'card-label' }, 'Stats & high scores'),
        h('div', { class: 'row-wrap', style: { gap: '22px', marginBottom: '18px' } },
          stat('Commands', fmtNum(stats.commands)), stat('Solved', fmtNum(stats.solved)), stat('Wrong', fmtNum(stats.wrong)),
          stat('Hints', fmtNum(stats.hints)), stat('Game overs', fmtNum(stats.gameOvers)),
          stat('Certificates', String(Object.keys(st.certs).length)),
          stats.firstPlay && stat('Playing since', new Date(stats.firstPlay).toLocaleDateString())),
        h('div', { class: 'hs-grid' }, hs),
      ], { cls: 'settings-card settings-stats' })));

  return { el, mounted() { music('title'); } };
}
