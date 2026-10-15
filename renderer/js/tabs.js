'use strict';

// Tab strip, and loading the preferences the Settings panel reflects.

import { tabs, views } from './dom.js';
import { prefs } from './state.js';
import { applySettingsUI } from './settings-panel.js';
import { loadHistory } from './history.js';

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
    if (target === 'history') loadHistory();
  });
});

// Replaces the contents rather than the object, so every importer of `prefs`
// keeps pointing at the same one.
export async function loadPrefs() {
  if (window.api) Object.assign(prefs, await window.api.store.getAll());
  applySettingsUI(prefs);
}
