'use strict';

// Renderer entry point, loaded as the only module <script> in index.html —
// everything else arrives through its import graph. Runs last and only kicks
// things off.

import { loadPrefs } from './tabs.js';
import { renderQueue } from './queue.js';
import './qc-tools.js';
import './processing.js';
import './history.js';
import './settings-panel.js';
import './update.js';

loadPrefs();
renderQueue();
