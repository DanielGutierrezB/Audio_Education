'use strict';

// Per-file QC tools reached from the right-click menu and the toolbar: the
// spectrogram modal and the exported QC report.

import { completedFiles, queue } from './state.js';
import { fileUrlFor } from './format.js';

// ── Spectrogram viewer (Fase 8c) ──
const spectrogramModal   = document.getElementById('spectrogram-modal');
const spectrogramTitle   = document.getElementById('spectrogram-title');
const spectrogramLoading = document.getElementById('spectrogram-loading');
const spectrogramImage   = document.getElementById('spectrogram-image');
const spectrogramClose   = document.getElementById('spectrogram-close');

async function showSpectrogram(filePath) {
  if (!window.api?.spectrogram) return;
  const name = filePath.split('/').pop();
  spectrogramTitle.textContent = `Spectrogram \u2014 ${name}`;
  spectrogramImage.hidden = true;
  spectrogramImage.src = '';
  spectrogramLoading.hidden = false;
  spectrogramLoading.textContent = 'Rendering spectrogram\u2026';
  spectrogramModal.hidden = false;

  const res = await window.api.spectrogram.generate(filePath);
  // The modal may have been closed (or re-opened for a different file)
  // while the render was in flight — don't clobber whatever's showing now.
  if (spectrogramModal.hidden || spectrogramTitle.textContent !== `Spectrogram \u2014 ${name}`) return;
  if (res?.path) {
    spectrogramImage.src = fileUrlFor(res.path);
    spectrogramImage.hidden = false;
    spectrogramLoading.hidden = true;
  } else {
    spectrogramLoading.textContent = `Failed to render spectrogram: ${res?.error ?? 'unknown error'}`;
  }
}

function hideSpectrogram() {
  spectrogramModal.hidden = true;
  spectrogramImage.src = '';
}

spectrogramClose.addEventListener('click', hideSpectrogram);
spectrogramModal.addEventListener('click', (e) => { if (e.target === spectrogramModal) hideSpectrogram(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !spectrogramModal.hidden) hideSpectrogram(); });

// ── QC report export (Fase 8d) ──
const btnQcReport = document.getElementById('btn-qc-report');

function collectFileSummaries() {
  const out = [];
  for (const group of queue.values()) {
    for (const f of group.files) {
      out.push({
        name: f.name,
        status: f.status,
        duration: f.duration ?? null,
        resolvedMode: f.resolvedMode ?? null,
        pairPath: f.pairPath ?? null,
        qcFlags: f.qcFlags ?? [],
        tilt: f.tilt ?? null,
        verify: f.verify ?? null,
        outputPath: completedFiles.get(f.path) ?? null,
        errorMsg: f.errorMsg ?? null,
      });
    }
  }
  return out;
}

btnQcReport.addEventListener('click', async () => {
  if (!window.api?.qc) return;
  const summaries = collectFileSummaries();
  if (!summaries.length) return;
  const res = await window.api.qc.saveReport(summaries);
  if (res?.path) {
    btnQcReport.textContent = '\u2713';
    setTimeout(() => { btnQcReport.textContent = '\uD83D\uDCC4'; }, 1500);
  } else if (res?.error) {
    console.error('Failed to save QC report:', res.error);
  }
});

export {
  showSpectrogram,
};
