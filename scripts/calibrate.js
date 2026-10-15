'use strict';

// ── Corpus calibration ──────────────────────────────────────────────────
// Runs the QC analysis over a folder of real recordings and prints what the
// detectors and the tone stage see, so thresholds can be set from measured
// voice instead of from the synthetic fixtures in test/.
//
// That distinction is not academic: every threshold originally calibrated on
// the broadband fixtures misfired on speech. SIBILANT fired on 22 of 28 real
// files, NO_AIR on 28 of 28 — so the air shelf never reached a real voice —
// and both fed a de-esser that was attenuating the whole top end.
//
//   npm run calibrate -- <folder> [more folders...]
//
// Groups each original with its Enhanced/ counterpart (same convention
// src/pairing.js uses) and with the Audio_Pro/ master when one exists, so a
// single run shows the whole chain per class. Read-only: nothing is written
// and no Adobe credits are spent.
//
// Keep the corpus itself out of the repo — the folder a course lives in is
// gitignored (corpus/), because this is unpublished teaching material.

const fs = require('fs');
const path = require('path');

const metrics = require('../src/metrics');
const pairing = require('../src/pairing');

const ENHANCED_DIR = 'Enhanced';
const MASTER_DIR = 'Audio_Pro';

function fmt(v, width = 7, digits = 1) {
  return (v == null ? '-' : v.toFixed(digits)).padStart(width);
}

// original -> { original, enhanced, master } for everything under one folder.
function collectGroups(folder) {
  const { pairs, singles } = pairing.findPairs(folder);
  const groups = [];
  const add = (originalPath, enhancedPath) => {
    const stem = path.basename(originalPath, path.extname(originalPath));
    const master = path.join(path.dirname(folder), MASTER_DIR, `${stem}.wav`);
    groups.push({
      name: stem,
      stages: [
        ['original', originalPath],
        ['enhanced', enhancedPath],
        ['master', fs.existsSync(master) ? master : null],
      ].filter(([, f]) => f),
    });
  };
  for (const { original, enhanced } of pairs) add(original.path, enhanced.path);
  for (const single of singles) add(single.path, null);
  return groups;
}

async function measure(file) {
  const qc = await metrics.analyzeFile(file);
  return {
    tilt: qc.tilt,
    sib: qc.bands.sibilance != null && qc.bands.presence != null
      ? qc.bands.sibilance - qc.bands.presence : null,
    air: qc.bands.air != null && qc.bands.presence != null
      ? qc.bands.air - qc.bands.presence : null,
    i: qc.loudness.i,
    lra: qc.loudness.lra,
    noise: qc.noiseFloor,
    flags: qc.flags.map(f => f.code),
  };
}

// Min/max/mean per stage: thresholds have to clear the whole observed range
// of normal material, not just its average.
function summarise(rows) {
  const byStage = new Map();
  for (const r of rows) {
    if (!byStage.has(r.stage)) byStage.set(r.stage, []);
    byStage.get(r.stage).push(r);
  }
  console.log('\n── Rango por etapa (un umbral tiene que despejar el rango entero) ──');
  console.log('etapa      n   tilt min/med/max      sib min/med/max      air min/med/max');
  for (const [stage, list] of byStage) {
    const span = (key) => {
      const vals = list.map(r => r[key]).filter(v => v != null);
      if (!vals.length) return '       -/-/-      ';
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return `${fmt(Math.min(...vals), 6)}/${fmt(mean, 5)}/${fmt(Math.max(...vals), 5)}`;
    };
    console.log(`${stage.padEnd(9)} ${String(list.length).padStart(2)}  ${span('tilt')}  ${span('sib')}  ${span('air')}`);
  }

  console.log('\n── Cuántas veces dispara cada flag ──');
  const counts = new Map();
  for (const r of rows) for (const f of r.flags) counts.set(f, (counts.get(f) ?? 0) + 1);
  if (!counts.size) {
    console.log('ninguno');
  } else {
    for (const [flag, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      const pct = Math.round((n / rows.length) * 100);
      const note = pct > 60 ? '  <- dispara en casi todo: revisar el umbral' : '';
      console.log(`${flag.padEnd(16)} ${String(n).padStart(3)}/${rows.length}  (${String(pct).padStart(3)}%)${note}`);
    }
  }

  const masterTilts = rows.filter(r => r.stage === 'master').map(r => r.tilt).filter(v => v != null);
  if (masterTilts.length > 1) {
    console.log(`\nDispersión del tilt entre masters: ${(Math.max(...masterTilts) - Math.min(...masterTilts)).toFixed(1)} dB` +
      `  (cuánto varía el tono de clase a clase dentro del curso)`);
  }
  console.log(
    '\nPara fijar TONE_TILT_REFERENCE_DB (src/pipeline.js): en Modo 2 el pipeline\n' +
    'analiza la señal YA FUSIONADA, no la enhanced de esta tabla. La fusión por\n' +
    'defecto baja el tilt unos 3 dB respecto de la enhanced, así que la referencia\n' +
    'sale de la mediana de la etapa enhanced menos ~3 dB. En Modo 1 la fuente es\n' +
    'el original tal cual y su mediana se usa directo.');
}

async function main() {
  const folders = process.argv.slice(2).filter(a => !a.startsWith('-'));
  if (!folders.length) {
    console.error('uso: npm run calibrate -- <carpeta-con-wavs> [más carpetas...]');
    console.error(`cada carpeta puede tener un subdirectorio ${ENHANCED_DIR}/ y un ${MASTER_DIR}/ hermano`);
    process.exit(1);
  }

  const rows = [];
  for (const folder of folders) {
    if (!fs.existsSync(folder)) {
      console.error(`no existe: ${folder}`);
      process.exit(1);
    }
    const groups = collectGroups(folder);
    if (!groups.length) {
      console.error(`sin audio en: ${folder}`);
      continue;
    }
    console.log(`\n=== ${folder} (${groups.length} archivo${groups.length === 1 ? '' : 's'}) ===`);
    console.log('archivo                     etapa        tilt     sib     air       I     LRA   ruido  flags');
    for (const group of groups) {
      for (const [stage, file] of group.stages) {
        let m;
        try {
          m = await measure(file);
        } catch (err) {
          console.log(`${group.name.slice(0, 26).padEnd(27)} ${stage.padEnd(9)} error: ${err.message.slice(0, 60)}`);
          continue;
        }
        rows.push({ ...m, name: group.name, stage });
        console.log(
          `${group.name.slice(0, 26).padEnd(27)} ${stage.padEnd(9)}` +
          ` ${fmt(m.tilt)} ${fmt(m.sib)} ${fmt(m.air)} ${fmt(m.i)} ${fmt(m.lra)} ${fmt(m.noise)}` +
          `  ${m.flags.join('|')}`);
      }
    }
  }

  if (rows.length) summarise(rows);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
