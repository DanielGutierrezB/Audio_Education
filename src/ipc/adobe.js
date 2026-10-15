'use strict';

// Adobe session for the embedded Enhance stage (docs/PLAN.md §3.1 Nivel 2).
// src/adobe-auth.js owns the login window and token persistence; this is only
// the renderer-facing surface plus the broadcast that keeps the Settings
// panel's connection state in sync after a silent re-auth.

const { ipcMain, BrowserWindow } = require('electron');

const adobeAuth = require('../adobe-auth');
const logger = require('../logger');

// Every window hears about a connection change, not just the one that asked:
// a token can also be refreshed mid-batch, with no window having requested it.
function broadcastConnection() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('adobe:conn', { connected: true, email: adobeAuth.tokenEmail() });
  }
}

// Restores a stored session at startup. Only ever attempts the silent refresh
// when a token was stored at some point, so the hidden podcast.adobe.com
// window never opens for users who don't use the feature.
async function restoreSession() {
  if (!adobeAuth.loadStoredToken()) return null;
  const tok = await adobeAuth.silentReauth();
  if (!tok) return null;
  logger.push('enhance', `Adobe session restored: ${adobeAuth.tokenEmail()}`);
  broadcastConnection();
  return tok;
}

function register() {
  ipcMain.handle('adobe:status', () => ({
    connected: !!adobeAuth.getToken(),
    email: adobeAuth.tokenEmail(),
  }));

  ipcMain.handle('adobe:connect', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const tok = await adobeAuth.connectInteractive(win);
    if (tok) logger.push('enhance', `Adobe connected: ${adobeAuth.tokenEmail()}`);
    return { connected: !!tok, email: adobeAuth.tokenEmail() };
  });

  ipcMain.handle('adobe:disconnect', () => {
    adobeAuth.clearToken();
    logger.push('enhance', 'Adobe session cleared');
    return { connected: false, email: null };
  });
}

module.exports = { register, restoreSession, broadcastConnection };
