// Theme catalogue for the settings screen. Colours live in styles/themes.css.
export const THEMES = [
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', kind: 'dark', blurb: 'Soothing pastel dark. The house default.' },
  { id: 'catppuccin-frappe', name: 'Catppuccin Frappé', kind: 'dark', blurb: 'Mocha, but with more milk and a nicer cardigan.' },
  { id: 'tokyo-night', name: 'Tokyo Night', kind: 'dark', blurb: 'Neon signs, rain on the glass, last train at 1 a.m.' },
  { id: 'dracula', name: 'Dracula', kind: 'dark', blurb: 'Bites only after sunset. Allergic to garlic and GUIs.' },
  { id: 'monokai', name: 'Monokai', kind: 'dark', blurb: 'Hot pink, lime and orange on charcoal. An editor classic.' },
  { id: 'vim-desert', name: 'Vim Desert', kind: 'dark', blurb: 'Khaki, sky blue and sand. Vim’s desert, no sunscreen needed.' },
  { id: 'vim-classic', name: 'Vim Classic', kind: 'dark', blurb: 'Vim’s own colours on a black terminal. :syntax on, nothing else.' },
  { id: 'rose-pine-moon', name: 'Rosé Pine Moon', kind: 'dark', blurb: 'All natural pine, faux fur and a bit of soho vibes.' },
  { id: 'nord-polar-night', name: 'Nord Polar Night', kind: 'dark', blurb: 'Arctic, north-bluish calm. Bring a sweater.' },
  { id: 'nord-snow-storm', name: 'Nord Snow Storm', kind: 'light', blurb: 'The light side of the Force. Squint-friendly.' },
  { id: 'solarized', name: 'Solarized', kind: 'dark', blurb: 'Precision colours for machines and people. Since 2011.' },
  { id: 'terminal-green', name: 'Terminal Green', kind: 'dark', blurb: 'P1 phosphor. You can almost smell the ozone.' },
  { id: 'ember', name: 'Ember', kind: 'dark', blurb: 'P3 amber phosphor. Cozy like a 1983 mainframe room.' },
];

export const THEME_IDS = THEMES.map(t => t.id);
export const DEFAULT_THEME = 'catppuccin-mocha';

/** theme-color meta values (address bar tint) per theme. */
export const THEME_COLOR = {
  'catppuccin-mocha': '#1E1E2E', 'catppuccin-frappe': '#303446', 'tokyo-night': '#1A1B26', 'dracula': '#282A36',
  'monokai': '#272822', 'vim-desert': '#333333', 'vim-classic': '#000000', 'rose-pine-moon': '#232136',
  'nord-polar-night': '#2E3440', 'nord-snow-storm': '#ECEFF4', 'solarized': '#002B36',
  'terminal-green': '#050A06', 'ember': '#110A02',
};

/** Find a theme by id, display name or any unambiguous-enough fragment ("drac", "tokyo", "frappe"). */
export function findTheme(query) {
  const fold = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const q = fold(query);
  if (!q) return null;
  return THEMES.find(t => t.id === q || fold(t.name) === q) || THEMES.find(t => t.id.includes(q) || fold(t.name).includes(q)) || null;
}
