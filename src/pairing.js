'use strict';

// ── Dual-source pairing ────────────────────────────────────────────────
// Detects Mode 2 candidates: an original recording plus its Adobe
// Podcast Enhance Speech counterpart, produced by the companion
// `adobe-podcast-batch` tool. That tool always writes enhanced output
// into an `Enhanced/` subfolder next to the originals (optionally nested
// one level deeper under `Clean voice/`), keeping the same base filename.
// Matching on basename (extension-insensitive) lets AudioPro auto-detect
// pairs without any manual wiring — drop a folder with both the raw
// recordings and their `Enhanced/` output, and pairs surface on their own.

const fs = require('fs');
const path = require('path');

const AUDIO_EXTS = ['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.aiff', '.aif'];
const ENHANCED_DIR_NAME = 'Enhanced';
const NESTED_CLEAN_DIR_NAME = 'Clean voice';

// macOS writes an AppleDouble sidecar (`._name.wav`) next to every file on
// filesystems that can't hold extended attributes — exFAT, which is what the
// external drives course audio travels on. They carry the real file's name
// and extension but only a few KB of metadata, so without this they queue up
// as audio and fail at the first ffmpeg pass.
function isAppleDoubleSidecar(name) {
  return name.startsWith('._');
}

function isAudioFile(name) {
  if (isAppleDoubleSidecar(name)) return false;
  return AUDIO_EXTS.includes(path.extname(name).toLowerCase());
}

function baseKey(name) {
  return path.basename(name, path.extname(name)).toLowerCase();
}

function scanAudioFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isFile() && isAudioFile(e.name))
    .map(e => {
      const filePath = path.join(dir, e.name);
      let size = 0;
      try { size = fs.statSync(filePath).size; } catch { /* ignore */ }
      return { path: filePath, name: e.name, size };
    });
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Scans `folderPath` for audio files and, when an `Enhanced/` sibling
// subfolder exists, pairs each original with its enhanced counterpart by
// basename. Returns originals without a match as `singles` so callers
// can still queue them for Mode 1.
function findPairs(folderPath) {
  const originals = scanAudioFiles(folderPath);
  const enhancedDir = path.join(folderPath, ENHANCED_DIR_NAME);
  let enhancedFiles = [];
  const hasEnhancedDir = isDir(enhancedDir);
  if (hasEnhancedDir) {
    enhancedFiles = scanAudioFiles(enhancedDir);
    const nested = path.join(enhancedDir, NESTED_CLEAN_DIR_NAME);
    if (isDir(nested)) enhancedFiles = enhancedFiles.concat(scanAudioFiles(nested));
  }

  const enhancedByKey = new Map();
  for (const f of enhancedFiles) {
    const k = baseKey(f.name);
    if (!enhancedByKey.has(k)) enhancedByKey.set(k, f);
  }

  const pairs = [];
  const singles = [];
  for (const orig of originals) {
    const match = enhancedByKey.get(baseKey(orig.name));
    if (match) pairs.push({ original: orig, enhanced: match });
    else singles.push(orig);
  }

  return { pairs, singles, hasEnhancedDir };
}

module.exports = { AUDIO_EXTS, isAudioFile, findPairs, scanAudioFiles };
