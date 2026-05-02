'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Resolve paths to bundled binaries (ffmpeg, ffprobe, deep-filter).
 * In development, look in the project's bin/ folder.
 * In production (packaged app), look in the app's extraResources/bin/.
 */

function getBinDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin');
  }
  return path.join(__dirname, '..', 'bin');
}

function resolve(name) {
  const binDir = getBinDir();
  const fullPath = path.join(binDir, name);
  if (fs.existsSync(fullPath)) return fullPath;
  // Fallback to PATH (dev convenience)
  return name;
}

module.exports = {
  ffmpeg:     () => resolve('ffmpeg'),
  ffprobe:    () => resolve('ffprobe'),
  deepFilter: () => resolve('deep-filter'),
  getBinDir,
};
