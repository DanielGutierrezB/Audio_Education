'use strict';

/**
 * In-memory ring-buffer logger for AudioPro.
 * Captures timestamped log entries for troubleshooting.
 * Accessible from renderer via IPC to copy to clipboard.
 */

const os = require('os');
const { app } = require('electron');

const MAX_ENTRIES = 2000;
const entries = [];
let sessionStart = null;

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function init() {
  sessionStart = new Date();
  push('system', `AudioPro v${app.getVersion()} started`);
  push('system', `Electron ${process.versions.electron} | Node ${process.versions.node} | Chrome ${process.versions.chrome}`);
  push('system', `Platform: ${process.platform} ${process.arch} | macOS ${os.release()}`);
  push('system', `Resources: ${process.resourcesPath}`);
  push('system', `Packaged: ${app.isPackaged}`);
}

function push(category, message, data) {
  const entry = { time: ts(), cat: category, msg: message };
  if (data !== undefined) entry.data = data;
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
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
    '═══════════════════════════════════════════',
    '',
  ].join('\n');

  const body = entries.map(e => {
    let line = `[${e.time}] [${e.cat}] ${e.msg}`;
    if (e.data !== undefined) {
      const d = typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2);
      // Indent multi-line data
      if (d.includes('\n')) {
        line += '\n' + d.split('\n').map(l => '    ' + l).join('\n');
      } else {
        line += ` | ${d}`;
      }
    }
    return line;
  }).join('\n');

  return header + body;
}

function clear() {
  entries.length = 0;
  push('system', 'Log cleared');
}

module.exports = { init, push, getAll, formatForClipboard, clear };
