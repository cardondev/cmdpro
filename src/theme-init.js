// Apply the saved theme before first paint (classic script, runs synchronously).
(function () {
  try {
    var raw = localStorage.getItem('cmdpro.v1');
    if (!raw) return;
    var s = (JSON.parse(raw) || {}).settings || {};
    var root = document.documentElement;
    if (s.theme) root.setAttribute('data-theme', s.theme);
    root.setAttribute('data-crt', s.crt === false ? 'off' : 'on');
    if (s.reduceMotion) root.setAttribute('data-motion', 'reduce');
    if (s.fontSize) root.style.setProperty('--term-font-size', s.fontSize + 'px');
  } catch (e) { /* storage blocked: defaults apply */ }
})();
