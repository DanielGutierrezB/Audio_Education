'use strict';

// Settings store, render history and the copyable log — the three channels
// that only read or write persisted state. src/settings.js owns the schema
// and validation; src/history.js owns the history whitelist and cap.

const { ipcMain } = require('electron');

const settings = require('../settings');
const history = require('../history');
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

  ipcMain.handle('log:getFormatted', () => logger.formatForClipboard());
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
