'use strict';

const path = require('path');
const fs = require('fs');
let app;
try {
  app = require('electron').app;
} catch { /* running outside Electron (CLI/tests) */ }

/**
 * Resolve paths to bundled binaries (ffmpeg, ffprobe).
 * In development, look in the project's bin/ folder.
 * In production (packaged app), look in the app's extraResources/bin/.
 * On Windows the binaries carry a `.exe` suffix; on macOS/Linux they don't.
 */

const EXE = process.platform === 'win32' ? '.exe' : '';

function getBinDir() {
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, 'bin');
  }
  return path.join(__dirname, '..', 'bin');
}

function resolve(name) {
  const binDir = getBinDir();
  const fullPath = path.join(binDir, name + EXE);
  if (fs.existsSync(fullPath)) return fullPath;
  // Fallback to PATH (dev convenience). Spawn on Windows still needs the
  // .exe suffix otherwise CreateProcess can't find the executable.
  return name + EXE;
}

module.exports = {
  ffmpeg:  () => resolve('ffmpeg'),
  ffprobe: () => resolve('ffprobe'),
  getBinDir,
};
