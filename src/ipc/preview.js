'use strict';

// Disposable artefacts the EQ tab asks for: the QC spectrogram, the Mode 2
// fusion preview behind the three-way A/B, and the exported QC report
// (docs/PLAN.md §4 Fase 8).
//
// Spectrograms and fusion previews write real files, but unlike the pipeline's
// output none of them is meant to survive the session, so they go to a
// dedicated temp folder that `shutdown` sweeps on quit.

const { ipcMain, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const spectrogram = require('../spectrogram');
const fusion = require('../fusion');
const qcReport = require('../qc-report');
const logger = require('../logger');

const MAX_REPORT_FILES = 10000;

const tempFiles = new Set();

function tempDir() {
  const dir = path.join(os.tmpdir(), 'audiopro-previews');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function forgetAndUnlink(filePath) {
  tempFiles.delete(filePath);
  try { fs.unlinkSync(filePath); } catch { /* already gone or never existed */ }
}

function shutdown() {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { /* best effort */ }
  }
  tempFiles.clear();
}

// Last fusion preview per original file, so re-selecting "Fusion" in the
// three-way A/B doesn't re-render on every click. A change to the fusion
// settings invalidates it on its own, since the key is those settings.
const fusionCache = new Map(); // originalPath -> { key, path }

function register({ store }) {
  ipcMain.handle('spectrogram:generate', async (_, filePath) => {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('..')) {
      return { error: 'Invalid file path' };
    }
    const outPath = path.join(tempDir(), `spec-${crypto.randomBytes(6).toString('hex')}.png`);
    tempFiles.add(outPath);
    try {
      await spectrogram.generateSpectrogram(filePath, outPath);
      logger.push('spectrogram', `Generated spectrogram for ${path.basename(filePath)}`);
      return { path: outPath };
    } catch (err) {
      forgetAndUnlink(outPath);
      logger.push('spectrogram', `Failed for ${path.basename(filePath)}`, err.message);
      return { error: err.message };
    }
  });

  ipcMain.handle('fusion:preview', async (_, originalPath, pairPath) => {
    if (typeof originalPath !== 'string' || !originalPath || originalPath.includes('..')) {
      return { error: 'Invalid file path' };
    }
    if (typeof pairPath !== 'string' || !pairPath || pairPath.includes('..')) {
      return { error: 'Invalid pair path' };
    }

    const fusionSettings = {
      fusionMode: store.get('fusionMode'),
      fusionCrossoverHz: store.get('fusionCrossoverHz'),
      fusionOriginalPct: store.get('fusionOriginalPct'),
    };
    const key = JSON.stringify(fusionSettings);
    const cached = fusionCache.get(originalPath);
    if (cached && cached.key === key && fs.existsSync(cached.path)) {
      return { path: cached.path };
    }

    const outPath = path.join(tempDir(), `fusion-${crypto.randomBytes(6).toString('hex')}.wav`);
    try {
      await fusion.runFusion(originalPath, pairPath, outPath, fusionSettings);
      tempFiles.add(outPath);
      if (cached) forgetAndUnlink(cached.path);
      fusionCache.set(originalPath, { key, path: outPath });
      logger.push('fusion', `Preview rendered for ${path.basename(originalPath)}`, fusionSettings);
      return { path: outPath };
    } catch (err) {
      forgetAndUnlink(outPath);
      logger.push('fusion', `Preview failed for ${path.basename(originalPath)}`, err.message);
      return { error: err.message };
    }
  });

  ipcMain.handle('qc:saveReport', async (event, fileSummaries) => {
    if (!Array.isArray(fileSummaries) || fileSummaries.length > MAX_REPORT_FILES) {
      return { error: 'Invalid file list' };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const markdown = qcReport.buildQcReportMarkdown(fileSummaries);
    const result = await dialog.showSaveDialog(win, {
      title: 'Export QC report',
      defaultPath: qcReport.defaultReportFilename(),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    try {
      fs.writeFileSync(result.filePath, markdown, 'utf8');
      logger.push('qc', `Report exported: ${result.filePath}`, `${fileSummaries.length} files`);
      return { path: result.filePath };
    } catch (err) {
      return { error: err.message };
    }
  });
}

module.exports = { register, shutdown };
