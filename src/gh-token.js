'use strict';

// gh-token.js — GitHub token persistence for the self-updater. Lets a
// packaged install read this (private) repo through the authenticated
// API. Same storage pattern as the Adobe session (src/adobe-auth.js):
// its own file under userData, encrypted with the OS keychain via
// `safeStorage` whenever available. The token never travels to the
// renderer — IPC only exposes whether one is stored.

const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const tokenPath = () => path.join(app.getPath('userData'), 'github-token.dat');

function loadToken() {
  try {
    const raw = fs.readFileSync(tokenPath());
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
  } catch { return null; }
}

function saveToken(tok) {
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(tok)
    : Buffer.from(tok, 'utf8');
  fs.writeFileSync(tokenPath(), data);
}

function clearToken() {
  try { fs.unlinkSync(tokenPath()); } catch { /* already gone */ }
}

function hasToken() {
  return loadToken() != null;
}

// GitHub tokens (classic ghp_/gho_ and fine-grained github_pat_) are
// single-line ASCII; anything else is a paste accident, not a token.
function looksLikeToken(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{20,255}$/.test(value);
}

module.exports = { loadToken, saveToken, clearToken, hasToken, looksLikeToken };
