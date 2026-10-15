'use strict';

// Only the Electron startup smoke test lives here; the audio pipeline is
// covered by the node:test suite (`npm test`), which needs no browser.

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/smoke',
  // Launching Electron and waiting for the renderer to settle is slower than a
  // unit test but should never take a minute.
  timeout: 60_000,
  // One Electron instance, shared via beforeAll: parallel workers would each
  // launch their own app against the same userData directory.
  workers: 1,
  fullyParallel: false,
  // A flaky startup test is worse than none — it would be the first thing
  // anyone learns to re-run without reading.
  retries: 0,
  reporter: process.env.CI ? 'list' : 'line',
  use: {
    trace: 'retain-on-failure',
  },
});
