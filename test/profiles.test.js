'use strict';

// Profiles overwrite every processing setting at once, so the failure that
// matters is a profile putting something the pipeline can't read into play —
// or quietly losing a setting, which would mean applying a course's profile
// and still rendering with a leftover value from the last one.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const profiles = require('../src/profiles');
const settings = require('../src/settings');
const { FINGERPRINTED_SETTINGS } = require('../src/render-manifest');

function fakeStore(initial = {}) {
  const data = { ...settings.DEFAULTS, ...initial };
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; },
    _raw: () => data,
  };
}

test('a profile captures every setting that changes the output', () => {
  // Same list the render manifest uses, on purpose: both answer "does this
  // setting change the output?", and keeping two lists means a new control
  // gets added to one and forgotten in the other.
  assert.deepEqual([...profiles.PROFILE_SETTINGS].sort(), [...FINGERPRINTED_SETTINGS].sort());

  const store = fakeStore();
  const captured = profiles.save(store, 'Curso Cursor');
  for (const key of profiles.PROFILE_SETTINGS) {
    assert.ok(key in captured, `profile did not capture ${key}`);
  }
});

test('saving then applying restores exactly what was captured', () => {
  const store = fakeStore({ deEsserAmount: 70, toneTiltTarget: 17, platformPreset: 'youtube' });
  profiles.save(store, 'Grave');

  store.set('deEsserAmount', 0);
  store.set('toneTiltTarget', 10);
  store.set('platformPreset', 'platzi');

  profiles.apply(store, 'Grave');
  assert.equal(store.get('deEsserAmount'), 70);
  assert.equal(store.get('toneTiltTarget'), 17);
  assert.equal(store.get('platformPreset'), 'youtube');
});

test('applying never puts an unreadable value into play', () => {
  const store = fakeStore();
  // A profile hand-edited in the store, or written by a version whose ranges
  // differed. Each value still goes through the schema on the way back in.
  store.set(profiles.PROFILES_KEY, {
    Dudoso: { platformPreset: 'spotify', deEsserAmount: 999, toneTiltTarget: 15 },
  });

  const applied = profiles.apply(store, 'Dudoso');
  assert.deepEqual(applied, ['toneTiltTarget'], 'only the valid setting should land');
  assert.notEqual(store.get('platformPreset'), 'spotify');
  assert.equal(store.get('deEsserAmount'), settings.DEFAULTS.deEsserAmount);
  assert.equal(store.get('toneTiltTarget'), 15);
});

test('names are normalised, and unusable ones are refused', () => {
  const store = fakeStore();
  assert.ok(profiles.save(store, '  Curso   Cursor  '));
  assert.deepEqual(profiles.list(store), ['Curso Cursor'], 'whitespace is collapsed and trimmed');

  for (const bad of ['', '   ', null, 42, '__proto__', 'constructor', 'x'.repeat(profiles.MAX_NAME_LENGTH + 1)]) {
    assert.equal(profiles.save(store, bad), null, `accepted ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(profiles.list(store), ['Curso Cursor'], 'nothing else was stored');
});

test('saving an existing name overwrites it rather than duplicating', () => {
  const store = fakeStore({ bodyPct: 10 });
  profiles.save(store, 'Curso');
  store.set('bodyPct', 40);
  profiles.save(store, 'Curso');
  assert.deepEqual(profiles.list(store), ['Curso']);
  assert.equal(profiles.get(store, 'Curso').bodyPct, 40);
});

test('removing a profile also drops the folders pointing at it', () => {
  const store = fakeStore();
  profiles.save(store, 'Curso A');
  profiles.save(store, 'Curso B');
  profiles.rememberFolder(store, '/courses/a', 'Curso A');
  profiles.rememberFolder(store, '/courses/b', 'Curso B');

  profiles.remove(store, 'Curso A');
  // Otherwise the folder keeps pointing at a profile that no longer exists and
  // silently stops being re-applied.
  assert.equal(profiles.profileForFolder(store, '/courses/a'), null);
  assert.equal(profiles.profileForFolder(store, '/courses/b'), 'Curso B');
});

test('a folder only remembers a profile that exists', () => {
  const store = fakeStore();
  assert.equal(profiles.rememberFolder(store, '/courses/a', 'Inventado'), false);
  assert.equal(profiles.profileForFolder(store, '/courses/a'), null);

  profiles.save(store, 'Real');
  assert.equal(profiles.rememberFolder(store, '/courses/a', 'Real'), true);
  assert.equal(profiles.profileForFolder(store, '/courses/a'), 'Real');

  assert.equal(profiles.rememberFolder(store, '/courses/a', null), true, 'and can forget it');
  assert.equal(profiles.profileForFolder(store, '/courses/a'), null);
});

test('folder links are bounded so the settings file cannot grow forever', () => {
  const store = fakeStore();
  profiles.save(store, 'Curso');
  for (let i = 0; i < profiles.MAX_FOLDER_LINKS + 20; i++) {
    profiles.rememberFolder(store, `/courses/${i}`, 'Curso');
  }
  const links = store.get(profiles.FOLDER_PROFILES_KEY);
  assert.equal(Object.keys(links).length, profiles.MAX_FOLDER_LINKS);
  // The most recent course is the one you are coming back to.
  assert.ok(`/courses/${profiles.MAX_FOLDER_LINKS + 19}` in links);
});

test('a corrupt profiles container is ignored rather than trusted', () => {
  for (const bad of ['nonsense', 42, ['a'], null]) {
    const store = fakeStore();
    store.set(profiles.PROFILES_KEY, bad);
    assert.deepEqual(profiles.list(store), []);
    assert.equal(profiles.get(store, 'anything'), null);
    assert.deepEqual(profiles.apply(store, 'anything'), []);
  }
});

test('applying or removing something that does not exist is a no-op', () => {
  const store = fakeStore({ bodyPct: 25 });
  assert.deepEqual(profiles.apply(store, 'Fantasma'), []);
  assert.equal(profiles.remove(store, 'Fantasma'), false);
  assert.equal(store.get('bodyPct'), 25, 'settings must be untouched');
});
