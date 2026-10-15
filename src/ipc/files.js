'use strict';

// Everything that picks, scans or reveals files: the open dialogs, the folder
// scan that detects Mode 2 pairs, and the output-directory channels.

const { ipcMain, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const pairing = require('../pairing');
const binPaths = require('../bin-paths');
const logger = require('../logger');
const { MAX_PATH_LENGTH } = require('../settings');

const PROBE_TIMEOUT_MS = 15_000;

function register({ store }) {
  ipcMain.handle('folders:open', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Select folders containing WAV files',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (!result.canceled) logger.push('files', `Folders selected: ${result.filePaths.length}`, result.filePaths);
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('files:open', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Select audio files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio Files', extensions: pairing.AUDIO_EXTS.map(e => e.slice(1)) }],
    });
    if (result.canceled) return [];
    return result.filePaths.map(filePath => {
      try {
        const { size } = fs.statSync(filePath);
        return { path: filePath, name: path.basename(filePath), size };
      } catch { return null; }
    }).filter(Boolean);
  });

  // Scans a dropped/selected folder for audio files and auto-detects Mode 2
  // candidates via the `adobe-podcast-batch` `Enhanced/` convention
  // (docs/PLAN.md §2.1, §2.4, §3). Originals that pair with an enhanced
  // counterpart carry a `pairPath`; everything else queues as Mode 1.
  ipcMain.handle('folders:scan', (_, folderPath) => {
    if (typeof folderPath !== 'string' || !folderPath || folderPath.includes('..')) return [];
    try {
      const { pairs, singles } = pairing.findPairs(folderPath);
      const paired = pairs.map(({ original, enhanced }) => ({ ...original, pairPath: enhanced.path }));
      const result = [...paired, ...singles];
      if (pairs.length) {
        logger.push('files', `Mode 2 pairs detected in ${folderPath}: ${pairs.length}`,
          pairs.map(p => path.basename(p.original.path)));
      }
      return result;
    } catch {
      return [];
    }
  });

  ipcMain.handle('shell:openPath', (_, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return;
    const resolved = path.resolve(filePath);
    if (resolved !== filePath && resolved !== path.normalize(filePath)) return;
    if (filePath.includes('..')) return;
    shell.showItemInFolder(resolved);
  });

  ipcMain.handle('output:chooseDir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose output folder for processed audio',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const chosen = result.filePaths[0];
    if (!path.isAbsolute(chosen) || chosen.length > MAX_PATH_LENGTH) return null;
    store.set('customOutputDir', chosen);
    logger.push('settings', `Custom output dir set: ${chosen}`);
    return chosen;
  });

  ipcMain.handle('output:openDir', () => {
    const dir = store.get('customOutputDir');
    if (typeof dir !== 'string' || !dir) return false;
    if (!fs.existsSync(dir)) return false;
    shell.openPath(dir);
    return true;
  });

  // Duration for the queue rows. Resolves null rather than rejecting on any
  // failure: a file that won't probe still belongs in the queue, it just
  // shows no duration until the pipeline reaches it.
  ipcMain.handle('ffprobe:metadata', (_, filePath) => {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('..')) return null;
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
      const done = (val) => { clearTimeout(timer); resolve(val); };
      const proc = spawn(binPaths.ffprobe(), [
        '-v', 'quiet', '-print_format', 'json', '-show_format', filePath,
      ]);
      let out = '';
      proc.stdout.on('data', chunk => { out += chunk; });
      proc.on('close', code => {
        if (code !== 0) return done(null);
        try {
          const duration = parseFloat(JSON.parse(out).format?.duration);
          done(isNaN(duration) ? null : { duration });
        } catch {
          done(null);
        }
      });
      proc.on('error', () => done(null));
    });
  });
}

module.exports = { register };
