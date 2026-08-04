// Light/dark/auto theme toggle. Progressive enhancement: the control ships
// `hidden` in the markup (see the navigation mixin in head.pug) and this
// script reveals it, so no-JS visitors simply follow prefers-color-scheme —
// identical to what "auto" resolves to here.
(function () {
  var STORAGE_KEY = 'aflink-theme';
  var toggle = document.getElementById('theme-toggle');
  if (!toggle) return;

  var media = window.matchMedia('(prefers-color-scheme: dark)');

  function getSaved() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function applyThemeColor() {
    var saved = getSaved();
    var dark = saved === 'dark' || (saved !== 'light' && media.matches);
    var meta = document.getElementById('theme-color');
    if (meta) meta.setAttribute('content', dark ? '#0f1419' : '#73391D');
  }

  function setActiveButton() {
    var saved = getSaved();
    var current = saved === 'light' || saved === 'dark' ? saved : 'auto';
    toggle.querySelectorAll('button').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-theme-choice') === current);
    });
  }

  function choose(value) {
    try {
      if (value === 'auto') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, value);
    } catch (e) {}

    if (value === 'light' || value === 'dark') {
      document.documentElement.setAttribute('data-theme', value);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    applyThemeColor();
    setActiveButton();
  }

  toggle.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-theme-choice]');
    if (btn) choose(btn.getAttribute('data-theme-choice'));
  });

  // Keep theme-color correct if the OS preference changes while on "auto"
  media.addEventListener('change', function () {
    if (getSaved() !== 'light' && getSaved() !== 'dark') applyThemeColor();
  });

  setActiveButton();
  toggle.hidden = false;
})();
