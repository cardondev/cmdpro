// Certificate viewer block: live SVG + editable name + print / download actions. A certificate
// that isn't earned yet shows as a locked specimen: no name, no printing, no saving.
import { h, icon } from './dom.js';
import { store } from '../game/state.js';
import { play } from '../game/audio.js';
import { CERT_BY_ID } from '../data/certs.js';
import { renderCertificate, printCertificate, downloadCertificate } from './certificate.js';
import { button } from './components.js';
import { toast } from './toast.js';

export function sampleEntry(certId) {
  return { difficulty: certId === 'warrior' ? 'extreme' : 'normal', score: 12345, date: new Date().toISOString(), serial: '4C:4D:44:50:52:4F:00:00:00:00:00:00:00:00:00:01', sample: true };
}

export function certViewer(certId, { compact = false, primaryPrint = true } = {}) {
  const cert = CERT_BY_ID[certId];
  const st = store.state;
  const real = st.certs[certId];
  const entry = real || sampleEntry(certId);
  const frame = h('div', { class: 'cert-frame' + (compact ? ' compact' : '') + (real ? '' : ' locked') }, h('div', { class: 'cert-loading muted small' }, 'Minting certificate…'));
  let svg = null;
  let name = st.profile.certName || st.profile.handle || '';
  async function draw() {
    const next = await renderCertificate({ cert, entry, name, handle: st.profile.handle, avatar: st.profile.avatar, locked: !real });
    svg = next;
    frame.replaceChildren(next);
  }
  if (!real) {
    const locked = { variant: 'secondary', disabled: true, sound: null, title: 'Earn this certificate first' };
    const actions = h('div', { class: 'cert-actions' },
      h('p', { class: 'cert-locked-note muted small' }, icon('lock'), 'Locked: printing and saving unlock when you earn this certificate.'),
      button('Print / Save PDF', { ...locked, icon: 'printer' }),
      button('Download SVG', { ...locked, icon: 'download' }));
    draw();
    return { el: h('div', { class: 'cert-view locked' }, frame, actions), redraw: draw, cert, entry, real: false };
  }
  let t = null;
  const input = h('input', { class: 'input', value: name, maxlength: '48', placeholder: 'Your name', 'aria-label': 'Name on certificate' });
  input.addEventListener('input', () => {
    name = input.value;
    clearTimeout(t);
    t = setTimeout(draw, 220);
  });
  input.addEventListener('change', () => {
    store.update(s => { s.profile.certName = input.value.trim(); });
  });
  const actions = h('div', { class: 'cert-actions' },
    h('label', { class: 'field cert-name-field' }, h('span', { class: 'field-label' }, 'Name on certificate'), input),
    button('Print / Save PDF', { variant: primaryPrint ? 'primary' : 'secondary', icon: 'printer', onClick: () => { if (svg) { printCertificate(svg); } } }),
    button('Download SVG', { variant: 'secondary', icon: 'download', onClick: async () => {
      if (!svg) return;
      toast({ title: 'Preparing your SVG…', body: 'Embedding fonts and pixels so it looks right anywhere.', iconName: 'download', duration: 2200 });
      try { await downloadCertificate(svg, `cmdpro-${certId}-certificate.svg`); play('unlock'); } catch (e) { toast({ title: 'Download failed', body: String(e.message || e), iconName: 'close' }); }
    } }));
  draw();
  return { el: h('div', { class: 'cert-view' }, frame, actions), redraw: draw, cert, entry, real: !!real };
}


