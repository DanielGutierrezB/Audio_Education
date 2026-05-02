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

/**
 * Path to the embedded Python runtime that ships with the packaged app.
 * Returns null when running from source / when no embedded runtime is present
 * (callers fall back to system Python in that case).
 */
function embeddedPython() {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'python-runtime')
    : path.join(__dirname, '..', 'python-runtime');
  const candidates = [
    path.join(root, 'bin', 'python3.10'),
    path.join(root, 'bin', 'python3'),
    path.join(root, 'bin', 'python'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

module.exports = {
  ffmpeg:     () => resolve('ffmpeg'),
  ffprobe:    () => resolve('ffprobe'),
  deepFilter: () => resolve('deep-filter'),
  getBinDir,
  embeddedPython,
};
