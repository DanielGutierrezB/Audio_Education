'use strict';

// ── Self-update ────────────────────────────────────────────────────────
// Two install types, two mechanisms (same split as the Sync app):
//
//   - Packaged install (DMG / NSIS) → `electron-updater` against the
//     PUBLIC releases-only repo (audiopro-releases). The source repo
//     stays private; only built artifacts + update metadata
//     (latest-mac.yml / latest.yml, zips, blockmaps) are public, so the
//     updater needs no token and works for every install. That side
//     lives in main.js (electron-updater needs the Electron runtime);
//     this module only contributes version helpers to it.
//
//   - Dev install (a .git folder exists at the app root) → git fetch and
//     compare, apply with `git reset --hard origin/<branch>` — but only
//     when the checkout is actually on <branch>, so an update click can
//     never blow away work on a feature branch. Uses the developer's own
//     git credentials, so the private source repo is not a problem.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const GH_BRANCH = 'main';
const GIT_TIMEOUT_MS = 90_000;

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

// ── Git-install paths (dev checkout) ───────────────────────────────────

function gitRun(appRoot, args) {
  return run('git', ['-C', appRoot, ...args], { timeoutMs: GIT_TIMEOUT_MS });
}

async function gitCurrentBranch(appRoot) {
  const r = await gitRun(appRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.code === 0 ? r.out.trim() : null;
}

// Checks origin WITHOUT applying. Resolves { ok, current, remote, changed }
// (plus `error` when ok is false). Only ever flags forward updates.
async function checkGitUpdate(appRoot, current = readLocalVersion(appRoot)) {
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

// Applies the update. Resolves { ok, changed, version, previous, remote }
// (plus `error` when ok is false). Caller relaunches the app on changed.
async function applyGitUpdate(appRoot, current = readLocalVersion(appRoot)) {
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

module.exports = {
  cmpVersions,
  readLocalVersion,
  isGitInstall,
  checkGitUpdate,
  applyGitUpdate,
  GH_BRANCH,
};
