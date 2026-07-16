'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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

// ── skipPathForCopy ──

test('skipPathForCopy: excludes node_modules, .git, and .DS_Store at any depth', () => {
  assert.ok(updater.skipPathForCopy('/x/node_modules'));
  assert.ok(updater.skipPathForCopy('/x/node_modules/electron-store/index.js'));
  assert.ok(updater.skipPathForCopy('/x/.git'));
  assert.ok(updater.skipPathForCopy('/x/.git/HEAD'));
  assert.ok(updater.skipPathForCopy('/x/renderer/.DS_Store'));
  assert.ok(updater.skipPathForCopy('C:\\x\\node_modules\\dep'), 'windows separators');
  assert.ok(!updater.skipPathForCopy('/x/src/pipeline.js'));
  assert.ok(!updater.skipPathForCopy('/x/renderer/index.html'));
  assert.ok(!updater.skipPathForCopy('/x/my_node_modules_notes.txt'), 'no false positive on substring');
});

// ── stageFromExtracted ──

// Builds a fake "extracted branch zip" tree: <base>/<Repo>-main/{files...}
function makeExtractedTree(base, { omit = [] } = {}) {
  const root = path.join(base, 'Audio_Education-main');
  fs.mkdirSync(root, { recursive: true });
  const files = {
    'main.js': '// main',
    'preload.js': '// preload',
    'package.json': JSON.stringify({ version: '1.2.3' }),
    'src/pipeline.js': '// pipeline',
    'src/updater.js': '// updater',
    'renderer/index.html': '<html></html>',
    'renderer/js/app.js': '// app',
    // Junk that must NOT be staged:
    'src/node_modules/evil/index.js': '// should not be copied',
    'renderer/.DS_Store': 'junk',
    // Repo files outside the app file set — also not staged:
    'test/pipeline.test.js': '// test',
    'docs/PLAN.md': '# plan',
    '.github/workflows/test.yml': 'name: t',
  };
  for (const [rel, contents] of Object.entries(files)) {
    if (omit.some(o => rel === o || rel.startsWith(o + '/'))) continue;
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }
  return root;
}

test('stageFromExtracted: stages exactly the app files, skipping junk and repo extras', () => {
  const base = tmpdir();
  try {
    makeExtractedTree(base);
    const stage = path.join(base, 'stage');
    updater.stageFromExtracted(base, stage);

    assert.ok(fs.existsSync(path.join(stage, 'main.js')));
    assert.ok(fs.existsSync(path.join(stage, 'preload.js')));
    assert.ok(fs.existsSync(path.join(stage, 'package.json')));
    assert.ok(fs.existsSync(path.join(stage, 'src', 'pipeline.js')));
    assert.ok(fs.existsSync(path.join(stage, 'renderer', 'js', 'app.js')));

    assert.ok(!fs.existsSync(path.join(stage, 'src', 'node_modules')), 'node_modules skipped');
    assert.ok(!fs.existsSync(path.join(stage, 'renderer', '.DS_Store')), '.DS_Store skipped');
    assert.ok(!fs.existsSync(path.join(stage, 'test')), 'test/ not part of the app');
    assert.ok(!fs.existsSync(path.join(stage, 'docs')), 'docs/ not part of the app');
    assert.ok(!fs.existsSync(path.join(stage, '.github')), '.github/ not part of the app');

    const staged = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
    assert.strictEqual(staged.version, '1.2.3');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('stageFromExtracted: rejects a zip that is missing expected app structure', () => {
  for (const missing of ['main.js', 'renderer']) {
    const base = tmpdir();
    try {
      makeExtractedTree(base, { omit: [missing] });
      assert.throws(
        () => updater.stageFromExtracted(base, path.join(base, 'stage')),
        /estructura esperada/,
        `should reject when ${missing} is missing`
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
});

test('stageFromExtracted: rejects an empty extract dir', () => {
  const base = tmpdir();
  try {
    assert.throws(() => updater.stageFromExtracted(base, path.join(base, 'stage')), /no trajo contenido/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── extractZip (real zip round-trip with the OS tool) ──

test('extractZip: round-trips a real zip using the OS-native tool', async (t) => {
  // The packaged updater relies on `unzip` (mac/linux) / Expand-Archive
  // (win). Skip rather than fail where the tool isn't present.
  if (process.platform !== 'win32') {
    try { execFileSync('which', ['unzip']); } catch { t.skip('unzip not available'); return; }
  }
  const base = tmpdir();
  try {
    const srcDir = path.join(base, 'src');
    fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(srcDir, 'sub', 'b.txt'), 'world');
    const zipFile = path.join(base, 'src.zip');
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${zipFile}'`]);
    } else {
      execFileSync('zip', ['-r', '-q', zipFile, '.'], { cwd: srcDir });
    }

    const out = path.join(base, 'out');
    await updater.extractZip(zipFile, out);
    assert.strictEqual(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'hello');
    assert.strictEqual(fs.readFileSync(path.join(out, 'sub', 'b.txt'), 'utf8'), 'world');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('extractZip: fails loudly on a corrupt zip', async (t) => {
  if (process.platform !== 'win32') {
    try { execFileSync('which', ['unzip']); } catch { t.skip('unzip not available'); return; }
  }
  const base = tmpdir();
  try {
    const zipFile = path.join(base, 'bad.zip');
    fs.writeFileSync(zipFile, 'this is not a zip');
    await assert.rejects(updater.extractZip(zipFile, path.join(base, 'out')), /no se pudo descomprimir/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
