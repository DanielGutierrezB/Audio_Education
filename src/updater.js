'use strict';

// ── Self-update ────────────────────────────────────────────────────────
// Same pattern as HyperPremiere's ⟳ button (bridge/engine.js there): the
// app itself checks the GitHub repo's state and updates in place, without
// a separate installer download.
//
//   - Dev install (a .git folder exists at the app root) → git fetch and
//     compare, apply with `git reset --hard origin/<branch>` — but only
//     when the checkout is actually on <branch>, so an update click can
//     never blow away work on a feature branch.
//   - Packaged install (DMG / NSIS, no .git) → read the remote version
//     from the raw package.json on GitHub, and on update download the
//     branch zip from codeload, stage the app files (main.js, preload.js,
//     src/, renderer/, package.json), back up the live install, and write
//     over Resources/app in place. node_modules and the bundled ffmpeg
//     binaries are never touched (deps install once at build time; bin/
//     lives outside app/ as extraResources).
//
// Requires the packaged app to run from plain files (asar disabled in
// electron-builder config) so files can be replaced individually. The
// repo must be readable: anonymously when public, or — since the repo is
// currently private — through a GitHub token (Settings → Updates) that
// switches every request to the authenticated REST API. Without either,
// the check fails gracefully with a clear error instead of pretending
// to work.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const GH_OWNER = 'DanielGutierrezB';
const GH_REPO = 'Audio_Education';
const GH_BRANCH = 'main';
const RAW_PACKAGE_URL = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/package.json`;
const ZIP_URL = `https://codeload.github.com/${GH_OWNER}/${GH_REPO}/zip/refs/heads/${GH_BRANCH}`;
const API_PACKAGE_URL = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/package.json?ref=${GH_BRANCH}`;
const API_ZIP_URL = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/zipball/${GH_BRANCH}`;

const CHECK_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 90_000;

// What a packaged install is made of (mirrors the `files` list in
// package.json's build config, minus node_modules which is preserved).
const APP_FILES = ['main.js', 'preload.js', 'package.json'];
const APP_DIRS = ['src', 'renderer'];

// ── Small helpers ──────────────────────────────────────────────────────

// Runs a command, never throws. Resolves { code, out, err }.
function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    let proc;
    try {
      proc = spawn(cmd, args, { cwd: opts.cwd });
    } catch (err) {
      resolve({ code: -1, out: '', err: err.message });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    }, opts.timeoutMs ?? GIT_TIMEOUT_MS);
    proc.stdout?.on('data', c => { out += c; });
    proc.stderr?.on('data', c => { err += c; });
    proc.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, out, err }); });
    proc.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
  });
}

// "0.4.0" vs "0.3.4" → >0 if a newer, <0 if older, 0 if equal.
function cmpVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function readLocalVersion(appRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function isGitInstall(appRoot) {
  try { return fs.existsSync(path.join(appRoot, '.git')); } catch { return false; }
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

// Request spec for the remote version check: anonymous raw fetch when
// there's no token; the authenticated contents API (raw media type) when
// there is one — that's what makes a private repo readable. Exported for
// tests.
function versionRequest(token) {
  if (token) {
    return {
      url: API_PACKAGE_URL,
      headers: {
        'authorization': `Bearer ${token}`,
        'accept': 'application/vnd.github.raw+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'AudioPro-updater',
      },
    };
  }
  return { url: RAW_PACKAGE_URL + '?t=' + Date.now(), headers: {} };
}

// Same split for the source zip. The API zipball redirects to codeload
// with a short-lived token in the query string, so the download works
// even though undici drops the Authorization header across origins.
function zipRequest(token) {
  if (token) {
    return {
      url: API_ZIP_URL,
      headers: {
        'authorization': `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'AudioPro-updater',
      },
    };
  }
  return { url: ZIP_URL, headers: {} };
}

async function fetchRemoteVersion(token) {
  const req = versionRequest(token);
  const res = await fetchWithTimeout(req.url, CHECK_TIMEOUT_MS, req.headers);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(token
        ? 'HTTP 404 — el token no tiene acceso al repositorio'
        : 'HTTP 404 — el repositorio no es accesible anónimamente (¿es privado?). Guardá un token de GitHub en Ajustes → Updates.');
    }
    if (res.status === 401) throw new Error('HTTP 401 — el token de GitHub es inválido o expiró');
    throw new Error('HTTP ' + res.status);
  }
  const data = JSON.parse(await res.text());
  return String(data.version || '').trim();
}

async function downloadZip(destFile, token) {
  const req = zipRequest(token);
  const res = await fetchWithTimeout(req.url, DOWNLOAD_TIMEOUT_MS, req.headers);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' al descargar el zip');
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('el zip vino vacío');
  fs.writeFileSync(destFile, buf);
}

// Extracts with the OS-native tool (no npm deps): unzip on macOS/Linux,
// PowerShell Expand-Archive on Windows.
async function extractZip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = process.platform === 'win32'
    ? await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force`],
        { timeoutMs: DOWNLOAD_TIMEOUT_MS })
    : await run('unzip', ['-o', '-q', zipFile, '-d', destDir], { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  if (r.code !== 0) {
    throw new Error('no se pudo descomprimir: ' + (r.err.trim() || 'código ' + r.code).slice(0, 200));
  }
}

// Never copy node_modules, .git, or OS junk into stage/backup trees.
function skipPathForCopy(p) {
  const n = String(p).replace(/\\/g, '/');
  return /\/node_modules(\/|$)/.test(n) || /\/\.git(\/|$)/.test(n) || /\/\.DS_Store$/.test(n);
}

// Builds the installable tree from an extracted repo zip. Exported for
// tests. Throws if the zip doesn't look like this app.
function stageFromExtracted(extractDir, stageDir) {
  const rootName = fs.readdirSync(extractDir).find(n => {
    try { return fs.statSync(path.join(extractDir, n)).isDirectory(); } catch { return false; }
  });
  if (!rootName) throw new Error('el zip no trajo contenido');
  const srcRoot = path.join(extractDir, rootName);

  for (const f of APP_FILES) {
    if (!fs.existsSync(path.join(srcRoot, f))) {
      throw new Error(`el zip no tiene la estructura esperada (falta ${f})`);
    }
  }
  for (const d of APP_DIRS) {
    if (!fs.existsSync(path.join(srcRoot, d))) {
      throw new Error(`el zip no tiene la estructura esperada (falta ${d}/)`);
    }
  }

  fs.mkdirSync(stageDir, { recursive: true });
  for (const f of APP_FILES) {
    fs.copyFileSync(path.join(srcRoot, f), path.join(stageDir, f));
  }
  for (const d of APP_DIRS) {
    fs.cpSync(path.join(srcRoot, d), path.join(stageDir, d), {
      recursive: true,
      filter: s => !skipPathForCopy(s),
    });
  }
  return stageDir;
}

// Downloads the branch zip and writes it over the live install, with a
// backup to restore if the write fails midway. node_modules stays put.
async function applyPackagedUpdate(appRoot, token) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-update-'));
  const zipFile = path.join(tmpBase, 'src.zip');
  const exDir = path.join(tmpBase, 'extract');
  const stage = path.join(tmpBase, 'stage');
  const backup = path.join(tmpBase, 'backup');
  try {
    await downloadZip(zipFile, token);
    await extractZip(zipFile, exDir);
    stageFromExtracted(exDir, stage);

    fs.cpSync(appRoot, backup, { recursive: true, filter: s => !skipPathForCopy(s) });

    try {
      fs.cpSync(stage, appRoot, { recursive: true, force: true });
    } catch (err) {
      try { fs.cpSync(backup, appRoot, { recursive: true, force: true }); } catch { /* keep original error */ }
      throw new Error('falló la escritura; restauré el respaldo: ' + err.message);
    }
  } finally {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* temp cleanup is best-effort */ }
  }
}

// ── Git-install paths (dev checkout) ───────────────────────────────────

function gitRun(appRoot, args) {
  return run('git', ['-C', appRoot, ...args], { timeoutMs: GIT_TIMEOUT_MS });
}

async function gitCurrentBranch(appRoot) {
  const r = await gitRun(appRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.code === 0 ? r.out.trim() : null;
}

async function checkGitUpdate(appRoot, current) {
  const f = await gitRun(appRoot, ['fetch', 'origin', GH_BRANCH]);
  if (f.code !== 0) {
    return { ok: false, current, error: 'No se pudo consultar GitHub: ' + (f.err.trim() || 'fetch falló').slice(0, 200) };
  }
  const rv = await gitRun(appRoot, ['show', `origin/${GH_BRANCH}:package.json`]);
  let remote = current;
  try { remote = JSON.parse(rv.out).version || remote; } catch { /* keep current */ }
  const cnt = await gitRun(appRoot, ['rev-list', '--count', `HEAD..origin/${GH_BRANCH}`]);
  const behind = parseInt((cnt.out || '0').trim(), 10) || 0;
  return { ok: true, current, remote, behind, changed: behind > 0 };
}

async function applyGitUpdate(appRoot, current) {
  const branch = await gitCurrentBranch(appRoot);
  if (branch !== GH_BRANCH) {
    return {
      ok: false,
      error: `Checkout de desarrollo en la rama "${branch ?? '?'}" — actualizá manualmente (git pull) para no pisar trabajo local.`,
    };
  }
  const chk = await checkGitUpdate(appRoot, current);
  if (!chk.ok) return { ok: false, error: chk.error };
  if (!chk.changed) return { ok: true, changed: false, version: current, remote: chk.remote };
  const r = await gitRun(appRoot, ['reset', '--hard', `origin/${GH_BRANCH}`]);
  if (r.code !== 0) {
    return { ok: false, error: 'No se pudo aplicar la actualización: ' + (r.err.trim() || 'reset falló').slice(0, 200) };
  }
  return { ok: true, changed: true, version: readLocalVersion(appRoot), previous: current, remote: chk.remote };
}

// ── Public API ─────────────────────────────────────────────────────────

// Checks GitHub WITHOUT applying. Resolves { ok, current, remote, changed }
// (plus `error` when ok is false). Only ever flags forward updates — a
// local install ahead of the branch never counts as "changed".
// opts.token: GitHub token for private-repo access (packaged installs
// only — dev checkouts go through git and the user's own credentials).
async function checkUpdate(appRoot, opts = {}) {
  const current = readLocalVersion(appRoot);
  if (isGitInstall(appRoot)) return checkGitUpdate(appRoot, current);
  try {
    const remote = await fetchRemoteVersion(opts.token);
    return { ok: true, current, remote, changed: !!remote && cmpVersions(remote, current) > 0 };
  } catch (err) {
    return { ok: false, current, error: 'No se pudo consultar GitHub: ' + err.message };
  }
}

// Applies the update. Resolves { ok, changed, version, previous, remote }
// (plus `error` when ok is false). Caller relaunches the app on changed.
async function applyUpdate(appRoot, opts = {}) {
  const before = readLocalVersion(appRoot);
  if (isGitInstall(appRoot)) return applyGitUpdate(appRoot, before);

  let remote;
  try {
    remote = await fetchRemoteVersion(opts.token);
  } catch (err) {
    return { ok: false, error: 'No se pudo consultar GitHub: ' + err.message };
  }
  if (!remote) return { ok: false, error: 'No se pudo leer la versión remota de GitHub.' };
  if (cmpVersions(remote, before) <= 0) return { ok: true, changed: false, version: before, remote };

  try {
    await applyPackagedUpdate(appRoot, opts.token);
    return { ok: true, changed: true, version: readLocalVersion(appRoot), previous: before, remote };
  } catch (err) {
    return { ok: false, error: 'No se pudo actualizar: ' + err.message };
  }
}

module.exports = {
  checkUpdate,
  applyUpdate,
  // Internals exported for tests.
  cmpVersions,
  readLocalVersion,
  isGitInstall,
  stageFromExtracted,
  skipPathForCopy,
  applyPackagedUpdate,
  extractZip,
  versionRequest,
  zipRequest,
  GH_OWNER, GH_REPO, GH_BRANCH,
};
