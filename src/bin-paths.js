'use strict';

const path = require('path');
const fs = require('fs');
let app;
try {
  app = require('electron').app;
} catch { /* running outside Electron (CLI/tests) */ }

/**
 * Resolve paths to bundled binaries (ffmpeg, ffprobe, deep-filter).
 * In development, look in the project's bin/ folder.
 * In production (packaged app), look in the app's extraResources/bin/.
 */

function getBinDir() {
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, 'bin');
  }
  return path.join(__dirname, '..', 'bin');
}

const EXE = process.platform === 'win32' ? '.exe' : '';

function resolve(name) {
  const binDir = getBinDir();
  const fullPath = path.join(binDir, name + EXE);
  if (fs.existsSync(fullPath)) return fullPath;
  // Fallback to PATH (dev convenience)
  return name + EXE;
}

module.exports = {
  ffmpeg:     () => resolve('ffmpeg'),
  ffprobe:    () => resolve('ffprobe'),
  deepFilter: () => resolve('deep-filter'),
  getBinDir,
};
