// Certificate ceremony: LEVEL UP → the CA issues a certificate → print/download/continue.
import { h } from '../dom.js';
import { store } from '../../game/state.js';
import { play, music } from '../../game/audio.js';
import { go } from '../router.js';
import { button } from '../components.js';
import { CERT_BY_ID } from '../../data/certs.js';
import { certViewer } from '../certview.js';
import { confetti } from '../confetti.js';

const BANNERS = {
  ai: ['MACHINE DETECTED', 'The Certificate Authority has questions.'],
  warrior: ['LEGENDARY', 'Only the worthy. You are the worthy.'],
  oops: ['SIDE QUEST CLEAR', 'The gremlin is asleep. /bin is still gone, but you are fine.'],
  elf: ['SIDE QUEST CLEAR', 'Twelve labors done. Olympus is impressed.'],
  necromancer: ['EDITION CLEAR', 'Grimwood Manor can rest in peace. Zed is giving you a (cold) high five.'],
  gobbler: ['EDITION CLEAR', 'The feast was a success and Sir Gobbles survived it. Pass the pie.'],
  'chief-elf': ['EDITION CLEAR', 'All twenty-five doors opened. HO HO HO, exit code 0.'],
};

export async function render(r) {
  const certId = CERT_BY_ID[r.args[0]] ? r.args[0] : 'foundations';
  // only an earned certificate gets a ceremony; anything else is the locked specimen
  if (!store.state.certs[certId]) { go(`cert/${certId}`, { replace: true }); return { el: h('div') }; }
  const cert = CERT_BY_ID[certId];
  const then = r.query.get('then') || 'wall';
  const queue = (r.query.get('queue') || '').split(',').filter(Boolean);
  const [banner, sub] = BANNERS[certId] || ['TIER COMPLETE', `Rank up: you are now a ${cert.rank}.`];
  const viewer = certViewer(certId, { primaryPrint: false });
  const next = () => {
    play('menu-select');
    if (queue.length) go(`ceremony/${queue[0]}?then=${encodeURIComponent(then)}${queue.length > 1 ? '&queue=' + queue.slice(1).join(',') : ''}`);
    else go(then);
  };
  const el = h('div', { class: `screen ceremony-screen cert-${certId}` },
    h('main', { class: 'page ceremony-page' },
      h('div', { class: 'ceremony-banner' },
        h('div', { class: 'ceremony-levelup arcade' }, banner),
        h('p', { class: 'secondary' }, sub)),
      h('p', { class: 'ceremony-issued mono' }, '$ openssl x509 -in ', h('span', { class: 'accent' }, `${certId}.crt`), ' -noout -subject', h('br'),
        h('span', { class: 'muted' }, `The CMDPRO Certificate Authority has issued you: ${cert.title}`)),
      h('div', { class: 'ceremony-cert' }, viewer.el),
      h('div', { class: 'row-wrap', style: { justifyContent: 'center' } },
        button('Wall of Certificates', { variant: 'muted', icon: 'trophy', onClick: () => go('wall') }),
        button(queue.length ? 'Next certificate' : 'Continue', { variant: 'primary', size: 'lg', icon: 'arrow-right', onClick: next, sound: null }))));
  const onKey = (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
    if (e.key === 'Enter') { e.preventDefault(); next(); }
  };
  return {
    el,
    mounted() {
      music(null);
      play('levelup');
      setTimeout(() => { play('cert'); confetti({ count: 180 }); }, 900);
      setTimeout(() => music('victory'), 1600);
      window.addEventListener('keydown', onKey);
    },
    destroy() { window.removeEventListener('keydown', onKey); },
  };
}
