'use strict';

// ── Self-update (⟳ pill in the titlebar) ──
//
//   - Packaged install → `electron-updater` against this repo's own Releases
//     (set in package.json's build.publish). The repo is public, so the
//     update metadata (latest-mac.yml / latest.yml) and the artifacts are
//     readable anonymously: no token or login is ever needed.
//   - Dev checkout → git fetch/reset via src/updater.js, using the
//     developer's own credentials.
//
// The renderer contract: check() → { ok, current, remote, changed };
// apply() downloads and returns { ok, changed, ... }; relaunch() restarts,
// which for a packaged install means quitAndInstall() on what was downloaded.

const { ipcMain, BrowserWindow, app } = require('electron');
const { autoUpdater } = require('electron-updater');

const updater = require('../updater');
const logger = require('../logger');
const pipelineIpc = require('./pipeline');

const MAX_ERROR_LENGTH = 200;

let inFlight = false;
let downloaded = false;

function configureAutoUpdater() {
  autoUpdater.autoDownload = false;         // the ⟳ pill decides when to download
  autoUpdater.autoInstallOnAppQuit = true;  // a downloaded update installs even if the user just quits
  autoUpdater.logger = {
    info: (m) => logger.push('update', String(m)),
    warn: (m) => logger.push('update', `warn: ${m}`),
    error: (m) => logger.push('update', `error: ${m}`),
    debug: () => {},
  };
  autoUpdater.on('download-progress', (p) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:progress', { percent: Math.round(p.percent), bps: p.bytesPerSecond });
    }
  });
}

// Checks for a newer version WITHOUT downloading it.
async function checkPackagedUpdate() {
  const current = app.getVersion();
  try {
    const r = await autoUpdater.checkForUpdates();
    const remote = r?.updateInfo?.version ?? null;
    const changed = !!remote && updater.cmpVersions(remote, current) > 0;
    return { ok: true, current, remote: remote ?? current, changed };
  } catch (err) {
    return {
      ok: false,
      current,
      error: 'No se pudo consultar las releases: ' + String(err.message || err).slice(0, MAX_ERROR_LENGTH),
    };
  }
}

function register({ appRoot }) {
  if (app.isPackaged) configureAutoUpdater();

  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('update:check', async () => {
    const res = app.isPackaged
      ? await checkPackagedUpdate()
      : await updater.checkGitUpdate(appRoot);
    if (res.ok && res.changed) {
      logger.push('update', `Nueva versión disponible: v${res.current} → v${res.remote}`);
    } else if (!res.ok) {
      logger.push('update', `Chequeo de actualización falló: ${res.error}`);
    }
    return res;
  });

  ipcMain.handle('update:apply', async () => {
    if (inFlight) return { ok: false, error: 'Ya hay una actualización en curso' };
    // Replacing the app out from under a running batch would leave half a
    // course rendered with no way to tell which half.
    if (pipelineIpc.isRunning()) {
      return { ok: false, error: 'Hay un lote procesándose — esperá a que termine antes de actualizar' };
    }
    inFlight = true;
    try {
      if (!app.isPackaged) {
        return logResult(await updater.applyGitUpdate(appRoot));
      }
      const chk = await checkPackagedUpdate();
      if (!chk.ok) return logResult({ ok: false, error: chk.error });
      if (!chk.changed) {
        return logResult({ ok: true, changed: false, version: chk.current, remote: chk.remote });
      }
      logger.push('update', `Descargando v${chk.remote} desde las releases…`);
      try {
        await autoUpdater.downloadUpdate();
        downloaded = true;
        return logResult({ ok: true, changed: true, version: chk.remote, previous: chk.current, remote: chk.remote });
      } catch (err) {
        return logResult({
          ok: false,
          error: 'No se pudo descargar la actualización: ' + String(err.message || err).slice(0, MAX_ERROR_LENGTH),
        });
      }
    } finally {
      inFlight = false;
    }
  });

  ipcMain.handle('update:relaunch', () => {
    if (app.isPackaged && downloaded) {
      autoUpdater.quitAndInstall(false, true);
      return;
    }
    app.relaunch();
    app.exit(0);
  });
}

function logResult(res) {
  if (res.ok && res.changed) {
    logger.push('update', `Actualización lista: v${res.previous} → v${res.version}. Reiniciando…`);
  } else if (res.ok) {
    logger.push('update', `Ya en la última versión (v${res.version}).`);
  } else {
    logger.push('update', `Actualización falló: ${res.error}`);
  }
  return res;
}

module.exports = { register };
