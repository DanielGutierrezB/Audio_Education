'use strict';

// Every element the renderer holds on to, in one place. A leaf module:
// importing it can never create a cycle, which is what lets the rest of the
// renderer be split at all.

const tabs           = document.querySelectorAll('.tab');
const views          = document.querySelectorAll('.view');
const btnAddFolders  = document.getElementById('btn-add-folders');
const btnAddFiles    = document.getElementById('btn-add-files');
const btnProcessSelection = document.getElementById('btn-process-selection');
const btnSelectAll   = document.getElementById('btn-select-all');
const btnClearSelection = document.getElementById('btn-clear-selection');
const btnClearAll    = document.getElementById('btn-clear-all');
const btnRemoveDone  = document.getElementById('btn-remove-completed');
const btnRetryFailed = document.getElementById('btn-retry-failed');
const queueEmpty     = document.getElementById('queue-empty');
const queueList      = document.getElementById('queue-list');
const queueSummary   = document.getElementById('queue-summary');
const queueContainer = document.getElementById('queue-container');
const badgeDone      = document.getElementById('badge-done');

export {
  tabs,
  views,
  btnAddFolders,
  btnAddFiles,
  btnProcessSelection,
  btnSelectAll,
  btnClearSelection,
  btnClearAll,
  btnRemoveDone,
  btnRetryFailed,
  queueEmpty,
  queueList,
  queueSummary,
  queueContainer,
  badgeDone,
};
