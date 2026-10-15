'use strict';

// Settings store, render history and the copyable log — the three channels
// that only read or write persisted state. src/settings.js owns the schema
// and validation; src/history.js owns the history whitelist and cap.

const { ipcMain, shell } = require('electron');

const settings = require('../settings');
const history = require('../history');
const profiles = require('../profiles');
const logger = require('../logger');

const MAX_LOG_CATEGORY = 32;
const MAX_LOG_MESSAGE = 500;
const MAX_LOG_DATA = 2000;

function register({ store }) {
  ipcMain.handle('store:get', (_, key) => store.get(key));
  ipcMain.handle('store:getAll', () => store.store);
  ipcMain.handle('store:set', (_, key, value) => {
    if (!settings.validate(key, value)) return;
    store.set(key, value);
  });

  ipcMain.handle('history:add', (_, rec) => history.add(store, rec));
  ipcMain.handle('history:list', () => history.list(store));
  ipcMain.handle('history:clear', () => history.clear(store));

  // Settings profiles: one course is one teacher in one room, so its settings
  // belong to it rather than to the app (src/profiles.js).
  ipcMain.handle('profiles:list', () => profiles.list(store));
  ipcMain.handle('profiles:save', (_, name) => !!profiles.save(store, name));
  ipcMain.handle('profiles:apply', (_, name) => profiles.apply(store, name));
  ipcMain.handle('profiles:remove', (_, name) => profiles.remove(store, name));
  ipcMain.handle('profiles:rememberFolder', (_, folderPath, name) =>
    profiles.rememberFolder(store, folderPath, name));
  ipcMain.handle('profiles:forFolder', (_, folderPath) => profiles.profileForFolder(store, folderPath));

  ipcMain.handle('log:getFormatted', () => logger.formatForClipboard());
  // Reveals the rotating log file. The in-memory buffer only covers the
  // current session, so when the question is "what happened before it
  // crashed", the file on disk is the only answer.
  ipcMain.handle('log:reveal', () => {
    const file = logger.currentLogPath();
    if (!file) return false;
    shell.showItemInFolder(file);
    return true;
  });
  ipcMain.handle('log:push', (_, category, message, data) => {
    const cat = String(category ?? 'renderer').slice(0, MAX_LOG_CATEGORY);
    const msg = String(message ?? '').slice(0, MAX_LOG_MESSAGE);
    const d = data !== undefined
      ? String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, MAX_LOG_DATA)
      : undefined;
    logger.push(cat, msg, d);
  });
}

module.exports = { register };
