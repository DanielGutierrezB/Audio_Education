'use strict';

// ── Render history ──────────────────────────────────────────────────────
// A persistent, capped log of finished renders, backing the History tab.
// Records are built by the renderer, so every field is whitelisted and
// length-capped here before it reaches electron-store: the settings store
// has its own key validation (main.js VALID_STORE_KEYS) and history is
// app-managed data that deliberately bypasses it.
//
// No Electron dependency — the store arrives as a parameter, so this is
// testable in plain Node.

const HISTORY_KEY = 'renderHistory';
const HISTORY_CAP = 500;
const MAX_STRING = 1024;
const MAX_FLAGS = 20;
const MAX_FLAG_CODE = 40;

const str = (v) => (typeof v === 'string' ? v.slice(0, MAX_STRING) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Returns a record safe to persist, or null when the input isn't a record
// at all. Unknown keys are dropped rather than carried through.
function sanitizeRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const out = {
    ts: num(rec.ts) ?? 0,
    name: str(rec.name),
    source: str(rec.source),
    output: str(rec.output),
    preset: str(rec.preset),
    mode: num(rec.mode),
    status: rec.status === 'error' ? 'error' : 'done',
    error: str(rec.error),
    verify: null,
    flags: [],
  };
  if (rec.verify && typeof rec.verify === 'object') {
    out.verify = {
      i: num(rec.verify.i),
      tp: num(rec.verify.tp),
      badge: rec.verify.badge === 'ok' ? 'ok' : 'warn',
    };
  }
  if (Array.isArray(rec.flags)) {
    out.flags = rec.flags
      .slice(0, MAX_FLAGS)
      .filter(f => f && typeof f.code === 'string')
      .map(f => ({ code: f.code.slice(0, MAX_FLAG_CODE), detail: str(f.detail) }));
  }
  return out;
}

// Appends a record, keeping only the newest HISTORY_CAP entries.
// Returns the resulting length, or 0 when the record was rejected.
function add(store, rec) {
  const clean = sanitizeRecord(rec);
  if (!clean) return 0;
  const list = store.get(HISTORY_KEY) || [];
  const capped = [...list, clean].slice(-HISTORY_CAP);
  store.set(HISTORY_KEY, capped);
  return capped.length;
}

// Newest first — the order the History tab renders.
function list(store) {
  return [...(store.get(HISTORY_KEY) || [])].reverse();
}

function clear(store) {
  store.set(HISTORY_KEY, []);
  return true;
}

module.exports = { sanitizeRecord, add, list, clear, HISTORY_KEY, HISTORY_CAP };
