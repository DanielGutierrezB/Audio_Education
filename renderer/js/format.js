'use strict';

// Mirrors AUDIO_EXTS in src/pairing.js — kept in sync manually since the
// renderer has no direct access to Node modules across the context bridge.
// Used only to accept/reject dropped files client-side; the main process
// re-validates everything regardless.
const AUDIO_EXTS = ['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.aiff', '.aif'];

function isAudioFileName(name) {
  const lower = name.toLowerCase();
  return AUDIO_EXTS.some(ext => lower.endsWith(ext));
}

function formatDuration(sec) {
  if (sec == null) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// Mirrors fileUrlFor in eq-editor.js — kept in sync manually since these
// are separate plain <script> files with no shared module system. Used
// here only for the spectrogram <img> preview.
function fileUrlFor(p) {
  const fwd = p.replace(/\\/g, '/');
  const prefix = fwd.startsWith('/') ? 'file://' : 'file:///';
  return prefix + encodeURI(fwd);
}

function formatEta(seconds) {
  if (seconds == null || isNaN(seconds) || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function statusIcon(status) {
  const map = { queued: '⏳', processing: '🔄', done: '✅', error: '❌' };
  return map[status] ?? '⏳';
}

export {
  isAudioFileName,
  formatDuration,
  formatSize,
  fileUrlFor,
  formatEta,
  statusIcon,
};
