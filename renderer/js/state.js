'use strict';

// Renderer state that more than one part touches. Also a leaf.
//
// The collections are exported directly because they are only ever mutated,
// never replaced. `ui` exists for the flags that *are* reassigned: an ES
// module export is a read-only binding, so `processing = true` from another
// file is not possible — and routing it through a getter in processing.js
// would make queue.js import processing.js, which already imports queue.js.

// Map<folderPath, { files: Array<{ path, name, size, duration, status }>, collapsed: bool }>
export const queue = new Map();

// Map<originalPath, outputPath>
export const completedFiles = new Map();

// Set of selected file paths
export const selectedFiles = new Set();

// Settings as last read from the store. Filled in place by loadPrefs rather
// than reassigned, so importers keep seeing the same object.
export const prefs = {};

export const ui = {
  // True from "Process Selection" until batch:done, which is what makes the
  // same button cancel and keeps the queue controls disabled.
  processing: false,

  // Name of the course profile currently in effect, or '' for none. Dropping
  // a folder that remembers a profile sets this.
  profile: '',
};

// A file is finished when its output on disk is what this configuration would
// produce — whether it was rendered now or skipped because it already was.
// Both are excluded from "Process Selection" and swept by "Remove completed".
export function isFinished(status) {
  return status === 'done' || status === 'skipped';
}
