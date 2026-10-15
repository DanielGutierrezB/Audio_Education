'use strict';

// adobe-auth.js — Adobe IMS login + token persistence for the embedded
// Enhance stage (docs/PLAN.md §3.1 Nivel 2). Same proven pattern as
// `adobe-podcast-batch`: a `podcast.adobe.com` window on a persistent
// session partition, polling `window.adobeIMS.getAccessToken()` in-page,
// and the token kept in its own owner-only file under userData.
//
// Not in the macOS Keychain (`safeStorage`), deliberately. The app is
// ad-hoc signed, and the Keychain ties "Always Allow" to the binary's
// signature, so every update and every rebuild re-prompted the user for
// access — at launch, on connect and on each silent re-auth. And it bought
// almost nothing: Electron ships with the EnableCookieEncryption fuse off,
// so the `persist:adobe` session cookies — the long-lived credential, the
// one that can mint fresh tokens — already sit on disk unencrypted next to
// it. The Keychain was guarding the ~24 h token while the key to it was in
// the clear. Revisit both together once the app is Developer ID signed.

const { BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { tokenInfo } = require('./enhance/phonos');

const ADOBE_PARTITION = 'persist:adobe';
const LOGIN_URL = 'https://podcast.adobe.com/en/enhance';
const TOKEN_POLL_MS = 1200;
const SILENT_REAUTH_TIMEOUT_MS = 15000;

let currentToken = null;

const tokenPath = () => path.join(app.getPath('userData'), 'adobe-token.dat');

// Adobe IMS access tokens are JWTs; anything else in the file is not one.
function looksLikeToken(s) {
  return typeof s === 'string' && s.startsWith('eyJ') && !/\s/.test(s);
}

// Returns true when a session was ever stored, which is what decides whether
// startup attempts the silent re-auth — the hidden podcast.adobe.com window
// must never open for users who don't use the feature.
//
// Files written before v0.7.1 hold a Keychain-encrypted blob. Reading them
// without the Keychain is the whole point, so the blob is simply not used as
// a token: the session still counts as stored, and the silent re-auth mints
// a fresh token from the partition cookies, overwriting the old file.
function loadStoredToken() {
  let raw;
  try {
    raw = fs.readFileSync(tokenPath(), 'utf8').trim();
  } catch {
    currentToken = null;
    return false;
  }
  currentToken = looksLikeToken(raw) ? raw : null;
  return true;
}

function persistToken(tok) {
  currentToken = tok;
  try {
    fs.writeFileSync(tokenPath(), tok, { encoding: 'utf8', mode: 0o600 });
    // writeFileSync only applies `mode` when it creates the file, so a file
    // left over from an earlier version keeps whatever it had.
    fs.chmodSync(tokenPath(), 0o600);
  } catch { /* token still usable in memory for this session */ }
}

function getToken() { return currentToken; }

function tokenEmail() {
  return currentToken ? (tokenInfo(currentToken).email || 'conectado') : null;
}

function clearToken() {
  currentToken = null;
  try { fs.unlinkSync(tokenPath()); } catch { /* already gone */ }
}

// Extracts the token from an Adobe window (getAccessToken in memory).
// timeoutMs 0/null = no timeout (waits until it appears or the window closes).
function grabTokenFrom(win, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let to = null;
    const finish = (t) => { if (done) return; done = true; clearInterval(poll); if (to) clearTimeout(to); resolve(t); };
    const poll = setInterval(async () => {
      if (win.isDestroyed()) return finish(null);
      try {
        const tok = await win.webContents.executeJavaScript(
          `(function(){try{var t=window.adobeIMS&&window.adobeIMS.getAccessToken&&window.adobeIMS.getAccessToken();return t&&(t.token||t.tokenValue)||null;}catch(e){return null;}})()`
        );
        if (tok && typeof tok === 'string' && tok.startsWith('eyJ')) finish(tok);
      } catch { /* page still loading — keep polling */ }
    }, TOKEN_POLL_MS);
    if (timeoutMs) to = setTimeout(() => finish(null), timeoutMs);
  });
}

// Interactive login (visible window). Resolves with the token (or the
// previous one if the user closed the window without finishing).
function connectInteractive(parentWin) {
  return new Promise((resolve) => {
    const authWin = new BrowserWindow({
      width: 520, height: 720, parent: parentWin ?? undefined, modal: !!parentWin, show: true,
      title: 'Conectar con Adobe',
      webPreferences: { partition: ADOBE_PARTITION, contextIsolation: true },
    });
    authWin.loadURL(LOGIN_URL);
    let settled = false;
    grabTokenFrom(authWin, 0).then((tok) => {   // 0 = no timeout, until it appears
      if (settled) return; settled = true;
      if (tok) persistToken(tok);
      if (!authWin.isDestroyed()) authWin.close();
      resolve(tok);
    });
    authWin.on('closed', () => { if (!settled) { settled = true; resolve(currentToken); } });
  });
}

// Silent re-login: uses the persisted session (cookies) with no visible window.
function silentReauth() {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      show: false, webPreferences: { partition: ADOBE_PARTITION, contextIsolation: true },
    });
    w.loadURL(LOGIN_URL);
    grabTokenFrom(w, SILENT_REAUTH_TIMEOUT_MS).then((tok) => {
      if (!w.isDestroyed()) w.destroy();
      if (tok) persistToken(tok);
      resolve(tok);
    });
  });
}

module.exports = {
  loadStoredToken, getToken, tokenEmail, clearToken,
  connectInteractive, silentReauth,
};
