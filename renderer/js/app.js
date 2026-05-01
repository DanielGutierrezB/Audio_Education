'use strict';

// ── Tab navigation ──
const tabs = document.querySelectorAll('.tab');
const views = document.querySelectorAll('.view');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;

    tabs.forEach(t => {
      t.classList.toggle('active', t.dataset.tab === target);
      t.setAttribute('aria-selected', t.dataset.tab === target);
    });

    views.forEach(v => {
      const isTarget = v.id === `view-${target}`;
      v.classList.toggle('active', isTarget);
      v.hidden = !isTarget;
    });
  });
});

// ── Preferences (loaded at start) ──
let prefs = {};

async function loadPrefs() {
  if (window.api) {
    prefs = await window.api.store.getAll();
  }
}

// ── App init ──
loadPrefs();
