'use strict';

/**
 * Logger for AudioPro: an in-memory ring buffer that the renderer can copy to
 * the clipboard, mirrored to a rotating file on disk.
 *
 * The file matters because the buffer dies with the process. Until now, if the
 * app crashed or was force-quit mid-batch — exactly when someone wants to know
 * what happened — the only record went with it, and "Copy Log" needs a running
 * window to be clicked in. Logs land in `logs/` under userData, next to the
 * settings store.
 *
 * Writes are append-only and best-effort: logging must never be the thing that
 * breaks a render, so every filesystem error is swallowed. The in-memory
 * buffer keeps working regardless.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_ENTRIES = 2000;
// A long batch with per-step logging runs to a few hundred KB; 5 MB is room
// for many sessions without letting a runaway loop fill the disk.
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;
const LOG_DIR_NAME = 'logs';
const LOG_FILE_NAME = 'audiopro.log';

const entries = [];
let sessionStart = null;
let logFilePath = null;
let bytesWritten = 0;
// Set once a write fails, so a full or read-only disk doesn't mean one failed
// syscall per log line for the rest of the session.
let fileLoggingDisabled = false;

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function logDir() {
  return path.join(app.getPath('userData'), LOG_DIR_NAME);
}

// audiopro.log is the current one; .1 is the previous, and so on.
function rotate() {
  try {
    const dir = logDir();
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = path.join(dir, i === 1 ? LOG_FILE_NAME : `${LOG_FILE_NAME}.${i - 1}`);
      const to = path.join(dir, `${LOG_FILE_NAME}.${i}`);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    bytesWritten = 0;
  } catch {
    fileLoggingDisabled = true;
  }
}

function openLogFile() {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    logFilePath = path.join(logDir(), LOG_FILE_NAME);
    bytesWritten = fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : 0;
    if (bytesWritten >= MAX_FILE_BYTES) rotate();
  } catch {
    fileLoggingDisabled = true;
  }
}

function formatEntry(e) {
  let line = `[${e.time}] [${e.cat}] ${e.msg}`;
  if (e.data !== undefined) {
    const d = typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2);
    line += d.includes('\n')
      ? '\n' + d.split('\n').map(l => '    ' + l).join('\n')
      : ` | ${d}`;
  }
  return line;
}

function appendToFile(entry) {
  if (fileLoggingDisabled || !logFilePath) return;
  const line = formatEntry(entry) + '\n';
  try {
    fs.appendFileSync(logFilePath, line);
    bytesWritten += Buffer.byteLength(line);
    if (bytesWritten >= MAX_FILE_BYTES) rotate();
  } catch {
    fileLoggingDisabled = true;
  }
}

function init() {
  sessionStart = new Date();
  openLogFile();
  // A separator rather than a fresh file per launch: one file reads as a
  // continuous history, which is what you want when the question is "what
  // changed between yesterday and today".
  if (!fileLoggingDisabled && bytesWritten > 0) {
    try { fs.appendFileSync(logFilePath, '\n'); } catch { /* best effort */ }
  }
  push('system', `AudioPro v${app.getVersion()} started`);
  push('system', `Electron ${process.versions.electron} | Node ${process.versions.node} | Chrome ${process.versions.chrome}`);
  push('system', `Platform: ${process.platform} ${process.arch} | macOS ${os.release()}`);
  push('system', `Resources: ${process.resourcesPath}`);
  push('system', `Packaged: ${app.isPackaged}`);
  if (logFilePath) push('system', `Log file: ${logFilePath}`);
}

function push(category, message, data) {
  const entry = { time: ts(), cat: category, msg: message };
  if (data !== undefined) entry.data = data;
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  appendToFile(entry);
}

function getAll() {
  return entries.slice();
}

function formatForClipboard() {
  const header = [
    '═══════════════════════════════════════════',
    '  AudioPro — Debug Log',
    `  Session started: ${sessionStart?.toISOString() ?? 'unknown'}`,
    `  Exported: ${new Date().toISOString()}`,
    `  Entries: ${entries.length}`,
    logFilePath ? `  Log file: ${logFilePath}` : '  Log file: (unavailable)',
    '═══════════════════════════════════════════',
    '',
  ].join('\n');

  return header + entries.map(formatEntry).join('\n');
}

// Clears the in-memory buffer only. The file is deliberately left alone: it is
// the record that survives a crash, and the button that reaches this is "copy
// the log", not "destroy the evidence".
function clear() {
  entries.length = 0;
  push('system', 'Log cleared (in-memory buffer only; the file on disk is kept)');
}

function currentLogPath() {
  return logFilePath;
}

module.exports = {
  init, push, getAll, formatForClipboard, clear, currentLogPath,
  // exported for tests
  formatEntry, MAX_ENTRIES, MAX_FILE_BYTES, MAX_FILES, LOG_FILE_NAME,
};
