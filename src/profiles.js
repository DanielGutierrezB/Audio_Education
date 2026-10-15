'use strict';

// ── Settings profiles ───────────────────────────────────────────────────
// A course is recorded by one teacher in one room, so its settings are the
// same for every class in it — and different from the next course. Without
// profiles those settings are global: tuning a deep voice means the next
// course inherits it, and going back means re-tuning from memory.
//
// A profile captures exactly the settings that change the audio, reusing
// render-manifest's FINGERPRINTED_SETTINGS rather than keeping a second list.
// That is deliberate: those two lists answer the same question ("does this
// setting change the output?"), so a new control gets remembered by a profile
// and invalidates a stale render in one step instead of being added to one
// list and forgotten in the other.
//
// Folders are remembered too, so dropping a course back in re-applies the
// profile it was processed with instead of whatever was last used.

const { FINGERPRINTED_SETTINGS } = require('./render-manifest');
const settingsSchema = require('./settings');

const PROFILES_KEY = 'settingsProfiles';
const FOLDER_PROFILES_KEY = 'folderProfiles';
const MAX_NAME_LENGTH = 60;
const MAX_PROFILES = 50;
const MAX_FOLDER_LINKS = 200;

const PROFILE_SETTINGS = FINGERPRINTED_SETTINGS;

// Names are shown in a dropdown and used as object keys, so they are trimmed
// and bounded. Anything that isn't usable as a label is rejected rather than
// silently mangled.
function normalizeName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null;
  // Would collide with prototype keys on a plain object.
  if (trimmed === '__proto__' || trimmed === 'constructor') return null;
  return trimmed;
}

function readProfiles(store) {
  const raw = store.get(PROFILES_KEY);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function list(store) {
  return Object.keys(readProfiles(store)).sort((a, b) => a.localeCompare(b));
}

function get(store, name) {
  const key = normalizeName(name);
  if (!key) return null;
  const profile = readProfiles(store)[key];
  return profile && typeof profile === 'object' ? profile : null;
}

// Captures the current settings under `name`. Returns the stored profile, or
// null when the name is unusable or there is no room left.
function save(store, name) {
  const key = normalizeName(name);
  if (!key) return null;
  const profiles = readProfiles(store);
  if (!(key in profiles) && Object.keys(profiles).length >= MAX_PROFILES) return null;

  const captured = {};
  for (const setting of PROFILE_SETTINGS) captured[setting] = store.get(setting);
  store.set(PROFILES_KEY, { ...profiles, [key]: captured });
  return captured;
}

// Writes a profile back over the current settings. Each value still goes
// through the schema, so a profile written by an older version — or hand-edited
// in the store — can't put something the pipeline can't read into play.
// Returns the names actually applied.
function apply(store, name) {
  const profile = get(store, name);
  if (!profile) return [];
  const applied = [];
  for (const setting of PROFILE_SETTINGS) {
    if (!(setting in profile)) continue;
    const value = profile[setting];
    if (!settingsSchema.validate(setting, value)) continue;
    store.set(setting, value);
    applied.push(setting);
  }
  return applied;
}

function remove(store, name) {
  const key = normalizeName(name);
  if (!key) return false;
  const profiles = readProfiles(store);
  if (!(key in profiles)) return false;
  delete profiles[key];
  store.set(PROFILES_KEY, profiles);

  // Drop the folder links too, or a folder keeps pointing at a profile that
  // no longer exists and silently stops being re-applied.
  const links = readFolderLinks(store);
  let changed = false;
  for (const [folder, linked] of Object.entries(links)) {
    if (linked === key) { delete links[folder]; changed = true; }
  }
  if (changed) store.set(FOLDER_PROFILES_KEY, links);
  return true;
}

function readFolderLinks(store) {
  const raw = store.get(FOLDER_PROFILES_KEY);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

// Remembers which profile a folder belongs to. Passing a null name forgets it.
function rememberFolder(store, folderPath, name) {
  if (typeof folderPath !== 'string' || !folderPath) return false;
  const links = readFolderLinks(store);
  if (name == null) {
    if (!(folderPath in links)) return false;
    delete links[folderPath];
    store.set(FOLDER_PROFILES_KEY, links);
    return true;
  }
  const key = normalizeName(name);
  if (!key || !get(store, key)) return false;
  // Bounded so a machine that has seen hundreds of courses doesn't grow the
  // settings file forever. Oldest links go first.
  const entries = Object.entries({ ...links, [folderPath]: key });
  const trimmed = Object.fromEntries(entries.slice(-MAX_FOLDER_LINKS));
  store.set(FOLDER_PROFILES_KEY, trimmed);
  return true;
}

function profileForFolder(store, folderPath) {
  if (typeof folderPath !== 'string' || !folderPath) return null;
  const name = readFolderLinks(store)[folderPath];
  return name && get(store, name) ? name : null;
}

module.exports = {
  list, get, save, apply, remove,
  rememberFolder, profileForFolder,
  normalizeName,
  PROFILE_SETTINGS, PROFILES_KEY, FOLDER_PROFILES_KEY,
  MAX_NAME_LENGTH, MAX_PROFILES, MAX_FOLDER_LINKS,
};
