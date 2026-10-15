'use strict';

// The Settings panel, the Adobe connection controls, the toolbar listeners,
// the custom output directory and the Copy Log button.

import {
  btnAddFiles, btnAddFolders, btnClearAll, btnClearSelection,
  btnProcessSelection, btnRemoveDone, btnSelectAll,
} from './dom.js';
import { prefs, ui } from './state.js';
import {
  addFilesViaDialog, addFoldersViaDialog, clearAll, clearSelection,
  removeCompleted, selectAllFiles,
} from './queue.js';
import { cancelProcessing, startProcessing } from './processing.js';

// ── Settings panel ──
const btnSettings   = document.getElementById('btn-settings');
const settingsPanel = document.getElementById('settings-panel');

const setHpf           = document.getElementById('set-hpf');
const setDeEsser       = document.getElementById('set-deesser');
const setFormat        = document.getElementById('set-format');
const setSampleRate    = document.getElementById('set-samplerate');
const hpfValue         = document.getElementById('hpf-value');

const toolbarPreset    = document.getElementById('toolbar-preset');
const setCompression   = document.getElementById('set-compression');
const setDenoise       = document.getElementById('set-denoise');
const setBody          = document.getElementById('set-body');
const bodyValue        = document.getElementById('body-value');
const setAirExtra      = document.getElementById('set-air-extra');
const airExtraValue    = document.getElementById('air-extra-value');
const deesserValue     = document.getElementById('deesser-value');
const setTrimSilence   = document.getElementById('set-trim-silence');
const setNormalize     = document.getElementById('set-normalize');
const setFusionEnabled = document.getElementById('set-fusion-enabled');
const setFusionMode    = document.getElementById('set-fusion-mode');
const setFusionCrossover     = document.getElementById('set-fusion-crossover');
const fusionCrossoverValue   = document.getElementById('fusion-crossover-value');
const setFusionOriginal      = document.getElementById('set-fusion-original');
const fusionOriginalValue    = document.getElementById('fusion-original-value');
const setEnhanceEnabled  = document.getElementById('set-enhance-enabled');
const setEnhanceMix      = document.getElementById('set-enhance-mix');
const enhanceMixValue    = document.getElementById('enhance-mix-value');
const adobeDot           = document.getElementById('adobe-dot');
const adobeConnText      = document.getElementById('adobe-conn-text');
const btnAdobeConnect    = document.getElementById('btn-adobe-connect');
const btnAdobeDisconnect = document.getElementById('btn-adobe-disconnect');

btnSettings.addEventListener('click', () => {
  const open = !settingsPanel.hidden;
  settingsPanel.hidden = open;
  btnSettings.setAttribute('aria-expanded', String(!open));
});

function applySettingsUI(p) {
  setHpf.value = p.hpfFrequency ?? 80;
  hpfValue.textContent = `${setHpf.value} Hz`;
  const deAmt = p.deEsserAmount != null ? p.deEsserAmount : (p.deEsserEnabled ? 60 : 0);
  setDeEsser.value = deAmt;
  if (deesserValue) deesserValue.textContent = `${deAmt}%`;
  setFormat.value = p.outputFormat ?? 'wav24';
  setSampleRate.value = String(p.sampleRate ?? 48000);
  applyOutputDirUI(p.customOutputDir || '');

  toolbarPreset.value = p.platformPreset ?? 'platzi';
  setCompression.value = p.compressionMode ?? 'auto';
  setDenoise.value = p.denoiseMode ?? 'auto';
  setBody.value = p.bodyPct ?? 0;
  bodyValue.textContent = `${setBody.value}%`;
  const airAmt = p.airExtraAmount != null ? p.airExtraAmount : (p.airExtraEnabled ? 60 : 0);
  setAirExtra.value = airAmt;
  if (airExtraValue) airExtraValue.textContent = `${airAmt}%`;
  setTrimSilence.checked = p.trimSilence !== false;
  setNormalize.value = p.normalizeMode ?? 'both';
  setFusionEnabled.checked = p.fusionEnabled !== false;
  setFusionMode.value = p.fusionMode ?? 'bands';
  setFusionCrossover.value = p.fusionCrossoverHz ?? 200;
  fusionCrossoverValue.textContent = `${setFusionCrossover.value} Hz`;
  setFusionOriginal.value = p.fusionOriginalPct ?? 20;
  fusionOriginalValue.textContent = `${setFusionOriginal.value}%`;
  setEnhanceEnabled.checked = p.enhanceEnabled === true;
  setEnhanceMix.value = p.enhanceMixPct ?? 100;
  enhanceMixValue.textContent = `${setEnhanceMix.value}%`;
}

function savePref(key, value) {
  prefs[key] = value;
  if (window.api) window.api.store.set(key, value);
}

setHpf.addEventListener('input', () => {
  const v = parseInt(setHpf.value);
  hpfValue.textContent = `${v} Hz`;
  savePref('hpfFrequency', v);
});

setDeEsser.addEventListener('input', () => {
  const v = parseInt(setDeEsser.value) || 0;
  if (deesserValue) deesserValue.textContent = `${v}%`;
  savePref('deEsserAmount', v);
});
setFormat.addEventListener('change', () => savePref('outputFormat', setFormat.value));
setSampleRate.addEventListener('change', () => savePref('sampleRate', parseInt(setSampleRate.value)));

toolbarPreset.addEventListener('change', () => savePref('platformPreset', toolbarPreset.value));
setCompression.addEventListener('change', () => savePref('compressionMode', setCompression.value));
setDenoise.addEventListener('change', () => savePref('denoiseMode', setDenoise.value));
setBody.addEventListener('input', () => {
  const v = parseInt(setBody.value);
  bodyValue.textContent = `${v}%`;
  savePref('bodyPct', v);
});
setAirExtra.addEventListener('input', () => {
  const v = parseInt(setAirExtra.value) || 0;
  if (airExtraValue) airExtraValue.textContent = `${v}%`;
  savePref('airExtraAmount', v);
});
setTrimSilence.addEventListener('change', () => savePref('trimSilence', setTrimSilence.checked));
setNormalize.addEventListener('change', () => savePref('normalizeMode', setNormalize.value));
setFusionEnabled.addEventListener('change', () => savePref('fusionEnabled', setFusionEnabled.checked));
setFusionMode.addEventListener('change', () => savePref('fusionMode', setFusionMode.value));
setFusionCrossover.addEventListener('input', () => {
  const v = parseInt(setFusionCrossover.value);
  fusionCrossoverValue.textContent = `${v} Hz`;
  savePref('fusionCrossoverHz', v);
});
setFusionOriginal.addEventListener('input', () => {
  const v = parseInt(setFusionOriginal.value);
  fusionOriginalValue.textContent = `${v}%`;
  savePref('fusionOriginalPct', v);
});
setEnhanceEnabled.addEventListener('change', () => savePref('enhanceEnabled', setEnhanceEnabled.checked));
setEnhanceMix.addEventListener('input', () => {
  const v = parseInt(setEnhanceMix.value);
  enhanceMixValue.textContent = `${v}%`;
  savePref('enhanceMixPct', v);
});

// ── Adobe connection (embedded Enhance) ──
// The token's identity field is sometimes a real email and sometimes an
// opaque AdobeID GUID (e.g. "4E67…@AdobeID") — only a real email is worth
// showing; the GUID goes in the tooltip instead of cluttering the row.
function adobeDisplayName(email) {
  if (typeof email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return email;
  return 'Connected';
}

function refreshAdobeConn(status) {
  const connected = status?.connected === true;
  adobeDot.classList.toggle('on', connected);
  adobeConnText.textContent = connected ? adobeDisplayName(status.email) : 'Not connected';
  adobeConnText.title = connected && status.email ? status.email : '';
  btnAdobeConnect.textContent = connected ? 'Reconnect' : 'Connect';
  btnAdobeDisconnect.hidden = !connected;
}

if (window.api?.adobe) {
  window.api.adobe.status().then(refreshAdobeConn).catch(() => {});
  window.api.adobe.onConn(refreshAdobeConn);
  btnAdobeConnect.addEventListener('click', async () => {
    btnAdobeConnect.disabled = true;
    btnAdobeConnect.textContent = 'Opening\u2026';
    try {
      refreshAdobeConn(await window.api.adobe.connect());
    } finally {
      btnAdobeConnect.disabled = false;
    }
  });
  btnAdobeDisconnect.addEventListener('click', async () => {
    refreshAdobeConn(await window.api.adobe.disconnect());
  });
}

// ── Event listeners — toolbar / empty state ──
btnAddFolders.addEventListener('click', addFoldersViaDialog);
btnAddFiles.addEventListener('click', addFilesViaDialog);
btnClearAll.addEventListener('click', clearAll);
btnRemoveDone.addEventListener('click', removeCompleted);
btnSelectAll.addEventListener('click', selectAllFiles);
btnClearSelection.addEventListener('click', clearSelection);

// ── Custom output directory ──
const btnOutputDir    = document.getElementById('btn-output-dir');
const btnOutputLabel  = document.getElementById('btn-output-label');
const btnOutputReset  = document.getElementById('btn-output-reset');
const btnOpenOutput   = document.getElementById('btn-open-output');

function applyOutputDirUI(dir) {
  prefs.customOutputDir = dir || '';
  if (dir) {
    const parts = dir.split('/').filter(Boolean);
    const tail = parts.slice(-2).join('/');
    btnOutputLabel.textContent = `Output: ${tail || dir}`;
    btnOutputDir.title = `Output folder: ${dir}\nClick to change`;
    btnOutputReset.hidden = false;
    btnOpenOutput.hidden = false;
  } else {
    btnOutputLabel.textContent = 'Output: Default';
    btnOutputDir.title = 'Choose where processed files are saved. Default writes to Audio_Pro/ next to each source folder.';
    btnOutputReset.hidden = true;
    btnOpenOutput.hidden = true;
  }
}

btnOutputDir.addEventListener('click', async () => {
  const chosen = await window.api.output.chooseDir();
  if (chosen) applyOutputDirUI(chosen);
});

btnOutputReset.addEventListener('click', async () => {
  await window.api.store.set('customOutputDir', '');
  applyOutputDirUI('');
});

btnOpenOutput.addEventListener('click', () => window.api.output.openDir());

// ── Copy Log button ──
const btnCopyLog = document.getElementById('btn-copy-log');
btnCopyLog.addEventListener('click', async () => {
  try {
    const log = await window.api.log.getFormatted();
    await navigator.clipboard.writeText(log);
    // Flash the button to confirm
    btnCopyLog.textContent = '\u2713';
    btnCopyLog.style.color = 'var(--accent)';
    setTimeout(() => {
      btnCopyLog.textContent = '\uD83D\uDCCB';
      btnCopyLog.style.color = '';
    }, 1500);
  } catch (err) {
    console.error('Failed to copy log:', err);
  }
});

// Right-click reveals the log file itself. Kept off the toolbar on purpose:
// it is for the rare "it closed on me, what happened" case, and the toolbar
// already wraps on narrow windows.
btnCopyLog.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api?.log.reveal();
});

document.getElementById('btn-empty-folders').addEventListener('click', addFoldersViaDialog);
document.getElementById('btn-empty-files').addEventListener('click', addFilesViaDialog);

btnProcessSelection.addEventListener('click', () => {
  if (ui.processing) cancelProcessing();
  else startProcessing();
});

export {
  applySettingsUI,
};
