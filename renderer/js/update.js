'use strict';

// The version pill in the titlebar: update check, download and relaunch.

// ── Self-update (⟳ pill in the titlebar) ──
// Mirrors HyperPremiere's ⟳: shows the current version, checks GitHub on
// launch and every 30 minutes, and highlights when a newer version is on
// the repo. Click = update + relaunch when one is available, otherwise
// re-check + reload the window.
const btnUpdate = document.getElementById('btn-update');
const updateIcon = document.getElementById('update-icon');
const versionLabel = document.getElementById('version-label');
let updateAvailable = false;

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

if (window.api?.update) {
  window.api.update.getVersion().then(v => {
    if (!v) return;
    if (versionLabel) versionLabel.textContent = 'v' + v;
    const aboutVersion = document.getElementById('about-version');
    if (aboutVersion) aboutVersion.textContent = 'v' + v;
  }).catch(() => {});

  const checkForUpdate = async () => {
    try {
      const res = await window.api.update.check();
      if (!res) return;
      if (res.ok && res.changed) {
        updateAvailable = true;
        btnUpdate.classList.add('has-update');
        versionLabel.textContent = `v${res.current} \u2192 v${res.remote}`;
        btnUpdate.title = `New version v${res.remote} available on GitHub \u2014 click to update and relaunch.`;
      } else {
        updateAvailable = false;
        btnUpdate.classList.remove('has-update');
        if (res.ok && res.current) versionLabel.textContent = 'v' + res.current;
        btnUpdate.title = res.ok
          ? 'Up to date \u2014 click to re-check GitHub and reload'
          : `Update check failed: ${res.error ?? 'unknown'} \u2014 click to retry`;
      }
    } catch { /* offline or IPC unavailable — keep the pill quiet */ }
  };
  checkForUpdate();
  setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);

  btnUpdate.addEventListener('click', async () => {
    if (btnUpdate.disabled) return;
    btnUpdate.disabled = true;
    updateIcon.classList.add('spinning');
    try {
      if (updateAvailable) {
        btnUpdate.title = 'Downloading and applying the update\u2026';
        const unsubProgress = window.api.update.onProgress?.(({ percent }) => {
          versionLabel.textContent = `downloading ${percent}%`;
        });
        const res = await window.api.update.apply();
        unsubProgress?.();
        if (res?.ok && res.changed) {
          versionLabel.textContent = 'v' + res.version;
          btnUpdate.title = 'Updated \u2014 relaunching\u2026';
          await window.api.update.relaunch();
          return; // app is about to exit
        }
        if (res?.ok) {
          // Someone else already updated us, or remote rolled back — re-check.
          updateAvailable = false;
          btnUpdate.classList.remove('has-update');
          btnUpdate.title = `Already on the latest (v${res.version}).`;
        } else {
          btnUpdate.title = `Update failed: ${res?.error ?? 'unknown'} \u2014 click to retry`;
          window.api.log?.push('update', 'Update failed', res?.error);
        }
      } else {
        await checkForUpdate();
        if (!updateAvailable) {
          // Nothing new — plain reload, useful to recover a wedged renderer.
          window.location.reload();
          return;
        }
        btnUpdate.title = `New version found \u2014 click again to update.`;
      }
    } finally {
      btnUpdate.disabled = false;
      updateIcon.classList.remove('spinning');
    }
  });
}
