'use strict';

// Electron startup smoke test. Nothing in the node:test suite loads main.js or
// the renderer at all — they pull in src/ modules directly — so a broken
// preload bridge, a renderer script that throws on load, or an IPC channel
// that was renamed on one side only would all ship green. This covers the
// seam: the app boots, the window paints, and the channels the UI depends on
// answer.
//
// Deliberately read-only. It never starts a batch or touches the Adobe
// session: this runs on every PR, and the point is "does it come up", not
// "does it render audio" — the pipeline suite already covers that.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_ROOT = path.join(__dirname, '..', '..');

let app;
let userDataDir;

// The gear toggles, so clicking it blindly means whichever test runs second
// closes the panel the first one opened.
async function openSettings(win) {
  if (await win.locator('#settings-panel').isHidden()) {
    await win.locator('#btn-settings').click();
  }
  await win.locator('#settings-panel').waitFor({ state: 'visible' });
}

test.beforeAll(async () => {
  // A throwaway userData directory, so the suite never reads or writes the
  // developer's real settings, history or Adobe session.
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-smoke-'));
  app = await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      // Cursor's and VS Code's integrated terminals set this, and it makes
      // Electron start as plain Node instead of as an app (README "Heads-up").
      ELECTRON_RUN_AS_NODE: undefined,
    },
  });
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('the window opens and the renderer paints', async () => {
  const win = await app.firstWindow();
  await expect(win.locator('#queue-empty')).toBeVisible();
  // The tab strip is the cheapest proof that app.js ran to completion rather
  // than throwing partway through. Matched on data-tab rather than label text,
  // which is user-facing copy and expected to change.
  for (const tab of ['processing', 'eq', 'history', 'about']) {
    await expect(win.locator(`.tab[data-tab="${tab}"]`)).toBeVisible();
  }
});

test('switching tabs shows the matching view', async () => {
  const win = await app.firstWindow();
  // History is the newest tab and the one that loads its content on click, so
  // it is the one most likely to break on a renderer split.
  await win.locator('.tab[data-tab="history"]').click();
  await expect(win.locator('#view-history')).toBeVisible();
  await expect(win.locator('#view-processing')).toBeHidden();

  await win.locator('.tab[data-tab="processing"]').click();
  await expect(win.locator('#view-processing')).toBeVisible();
});

test('the renderer logged no errors while starting', async () => {
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (err) => errors.push(err.message));
  win.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  // Give anything deferred (preference load, version pill, Adobe status) a
  // chance to fail before asserting.
  await win.waitForTimeout(2000);
  expect(errors).toEqual([]);
});

test('the preload bridge exposes the whole api surface', async () => {
  const win = await app.firstWindow();
  // Every group preload.js advertises, with the methods the renderer calls.
  // A rename on one side of the bridge is otherwise invisible until a user
  // clicks the button that uses it.
  const shape = await win.evaluate(() => {
    const groups = {};
    for (const [key, value] of Object.entries(window.api ?? {})) {
      groups[key] = value && typeof value === 'object'
        ? Object.keys(value).sort()
        : typeof value;
    }
    return groups;
  });

  expect(shape.store).toEqual(expect.arrayContaining(['get', 'getAll', 'set']));
  expect(shape.history).toEqual(expect.arrayContaining(['add', 'clear', 'list']));
  expect(shape.pipeline).toEqual(expect.arrayContaining(['cancel', 'start']));
  expect(shape.adobe).toEqual(expect.arrayContaining(['connect', 'disconnect', 'status']));
  expect(shape.qc).toEqual(expect.arrayContaining(['saveReport']));
  expect(shape.update).toEqual(expect.arrayContaining(['apply', 'check', 'getVersion', 'relaunch']));
  expect(shape.folders).toEqual(expect.arrayContaining(['open', 'scan']));
  expect(shape.output).toEqual(expect.arrayContaining(['chooseDir', 'openDir']));
});

test('settings round-trip over IPC, and an invalid value is refused', async () => {
  const win = await app.firstWindow();

  const all = await win.evaluate(() => window.api.store.getAll());
  expect(typeof all.platformPreset).toBe('string');
  expect(typeof all.hpfFrequency).toBe('number');

  // A valid write lands...
  await win.evaluate(() => window.api.store.set('hpfFrequency', 120));
  expect(await win.evaluate(() => window.api.store.get('hpfFrequency'))).toBe(120);

  // ...and src/settings.js rejects the rest. This is the trust boundary the
  // unit tests cover in isolation; here it is checked end to end, through the
  // real bridge, which is the only way to catch the two sides disagreeing.
  await win.evaluate(() => window.api.store.set('hpfFrequency', 'not a number'));
  expect(await win.evaluate(() => window.api.store.get('hpfFrequency'))).toBe(120);

  await win.evaluate(() => window.api.store.set('platformPreset', 'spotify'));
  expect(await win.evaluate(() => window.api.store.get('platformPreset'))).not.toBe('spotify');
});

// The renderer is split across modules that share state through state.js, so
// these cover the wiring most likely to break on a reorganisation: a control
// that reads a preference, a control that writes one, and the parts that
// reach each other across files.
test('the settings panel opens and reflects the stored preset', async () => {
  const win = await app.firstWindow();
  const stored = await win.evaluate(() => window.api.store.get('platformPreset'));

  await expect(win.locator('#toolbar-preset')).toHaveValue(stored);
  await expect(win.locator('#settings-panel')).toBeHidden();
  await win.locator('#btn-settings').click();
  await expect(win.locator('#settings-panel')).toBeVisible();

  // Left closed again so the next test starts from a known state.
  await win.locator('#btn-settings').click();
  await expect(win.locator('#settings-panel')).toBeHidden();
});

test('changing the delivery preset persists it', async () => {
  const win = await app.firstWindow();
  const before = await win.evaluate(() => window.api.store.get('platformPreset'));
  const next = before === 'youtube' ? 'podcast' : 'youtube';

  await win.locator('#toolbar-preset').selectOption(next);
  await expect
    .poll(() => win.evaluate(() => window.api.store.get('platformPreset')))
    .toBe(next);

  await win.locator('#toolbar-preset').selectOption(before);
});

test('a course profile saves, applies and deletes through the real bridge', async () => {
  const win = await app.firstWindow();
  await openSettings(win);

  // Capture a distinctive setting under a profile, change it, then bring it
  // back. This is the whole promise of profiles in one pass.
  await win.evaluate(() => window.api.store.set('toneTiltTarget', 18));
  await win.locator('#set-profile-name').fill('Curso de prueba');
  await win.locator('#btn-profile-save').click();
  await expect(win.locator('#set-profile')).toHaveValue('Curso de prueba');

  await win.evaluate(() => window.api.store.set('toneTiltTarget', 10));
  await win.locator('#set-profile').selectOption('Curso de prueba');
  await expect
    .poll(() => win.evaluate(() => window.api.store.get('toneTiltTarget')))
    .toBe(18);

  await win.locator('#btn-profile-delete').click();
  await expect
    .poll(() => win.evaluate(() => window.api.profiles.list()))
    .not.toContain('Curso de prueba');
});

test('Process Selection stays disabled while the queue is empty', async () => {
  const win = await app.firstWindow();
  await expect(win.locator('#btn-process-selection')).toBeDisabled();
});

test('the EQ tab renders — eq-editor still loads alongside the modules', async () => {
  const win = await app.firstWindow();
  await win.locator('.tab[data-tab="eq"]').click();
  await expect(win.locator('#eq-canvas')).toBeVisible();
  // eq-editor.js is a plain script that reads the queue through the
  // window.audioProQueue bridge, so a module-only renderer would leave it
  // undefined and the editor silently empty.
  expect(await win.evaluate(() => typeof window.audioProQueue)).not.toBe('undefined');
  await win.locator('.tab[data-tab="processing"]').click();
});

test('starting a batch with nothing queued is refused, not crashed on', async () => {
  const win = await app.firstWindow();
  const res = await win.evaluate(() => window.api.pipeline.start([]));
  expect(res.error).toBeTruthy();
  expect(res.ok).toBeFalsy();
});

test('the version pill reports the running version', async () => {
  const win = await app.firstWindow();
  const version = await win.evaluate(() => window.api.update.getVersion());
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  // The pill is static markup until the renderer fills it in, so this also
  // proves that wiring ran. Matched on "contains" rather than equality: the
  // pill has two legitimate forms, and on a dev checkout it often shows the
  // second one. checkGitUpdate reports `changed` from the commit count, not
  // the version, so any commit on main makes it read "v0.7.0 → v0.7.0".
  await expect(win.locator('#version-label')).toContainText(`v${version}`);
});
