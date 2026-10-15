'use strict';

// Tests for the self-updater helpers. The packaged-install path is
// electron-updater (exercised only inside Electron, against the public
// repo's own Releases); what lives in src/updater.js — and what this
// suite covers — are the pure version helpers plus the dev-checkout git
// path's install-type detection.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const updater = require('../src/updater');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-updater-test-'));
}

// ── cmpVersions ──

test('cmpVersions: ordering, equality, and length mismatches', () => {
  assert.ok(updater.cmpVersions('0.4.0', '0.3.4') > 0);
  assert.ok(updater.cmpVersions('0.3.4', '0.4.0') < 0);
  assert.strictEqual(updater.cmpVersions('1.2.3', '1.2.3'), 0);
  assert.ok(updater.cmpVersions('1.0.10', '1.0.9') > 0, 'numeric, not lexicographic');
  assert.ok(updater.cmpVersions('1.1', '1.0.9') > 0, 'shorter version padded with zeros');
  assert.strictEqual(updater.cmpVersions('1.0', '1.0.0'), 0);
  assert.ok(updater.cmpVersions('2.0.0', '1.99.99') > 0);
});

test('cmpVersions: garbage input degrades to 0 components instead of throwing', () => {
  assert.strictEqual(updater.cmpVersions('', ''), 0);
  assert.strictEqual(updater.cmpVersions(null, undefined), 0);
  assert.ok(updater.cmpVersions('1.0.0', 'not-a-version') > 0);
});

// ── readLocalVersion / isGitInstall ──

test('readLocalVersion: reads package.json version, falls back to 0.0.0', () => {
  const dir = tmpdir();
  try {
    assert.strictEqual(updater.readLocalVersion(dir), '0.0.0', 'missing package.json');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.8.7' }));
    assert.strictEqual(updater.readLocalVersion(dir), '9.8.7');
    fs.writeFileSync(path.join(dir, 'package.json'), 'not json at all');
    assert.strictEqual(updater.readLocalVersion(dir), '0.0.0', 'corrupt package.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isGitInstall: true only when a .git folder exists at the root', () => {
  const dir = tmpdir();
  try {
    assert.strictEqual(updater.isGitInstall(dir), false);
    fs.mkdirSync(path.join(dir, '.git'));
    assert.strictEqual(updater.isGitInstall(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── applyGitUpdate: feature-branch guard ──

test('applyGitUpdate: refuses to touch a checkout that is not on main', async () => {
  // A directory that is not a git repo at all makes rev-parse fail, which
  // must surface as the branch guard (never a destructive reset).
  const dir = tmpdir();
  try {
    const res = await updater.applyGitUpdate(dir);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /rama|branch/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
