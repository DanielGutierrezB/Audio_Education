'use strict';

// ── EQ Editor ─────────────────────────────────────────────────────────
// Direct-manipulation EQ on a canvas:
//   • drag a band's handle to move it (X = frequency, Y = gain)
//   • mouse wheel over a handle changes Q
//   • shift-click toggles a band on/off
// Web Audio routes the file through a BiquadFilterNode chain in real time
// so the user hears the EQ as they edit. "Apply to all" persists the
// chain as an FFmpeg filter string and the pipeline honours it.

(function () {

  // Mirrors BASE_EQ_BANDS in src/pipeline.js — replica of the Waves F6
  // reference curve. 6 bands: HPF + 3 low-mid cuts + presence peak + air shelf.
  const DEFAULT_BANDS = [
    { id: 'hpf',  enabled: true, type: 'highpass',  f: 80,    g: 0,    q: 0.707, label: 'HPF',  color: '#888'    },
    { id: 'mud',  enabled: true, type: 'peaking',   f: 150,   g: -3,   q: 2,     label: 'Mud',  color: '#ffaa55' },
    { id: 'box',  enabled: true, type: 'peaking',   f: 280,   g: -3,   q: 2.5,   label: 'Box',  color: '#ff6b6b' },
    { id: 'honk', enabled: true, type: 'peaking',   f: 500,   g: -4,   q: 2,     label: 'Honk', color: '#3aa6ff' },
    { id: 'pres', enabled: true, type: 'peaking',   f: 3589,  g: 1,    q: 1.0,   label: 'Pres', color: '#7afe9f' },
    { id: 'air',  enabled: true, type: 'highshelf', f: 10000, g: 1.5,  q: 0.707, label: 'Air',  color: '#c79bff' },
  ];

  // Bands eligible for auto-fit (the three surgical cuts). Boosts and HPF
  // stay at their defaults — moving them per-source would change the
  // character of the curve, not just target a resonance.
  const AUTO_FIT_BAND_IDS = ['mud', 'box', 'honk'];
  // Search radius around each band's default centre, in octaves. ±1/3 octave
  // (ratio 2^(1/3) ≈ 1.26) keeps the moves musically meaningful without
  // letting bands wander across each other.
  const AUTO_FIT_HALF_OCTAVE = 1 / 3;

  const LAYOUT = {
    ML: 48, MR: 18, MT: 18, MB: 28,
    fLo: 30, fHi: 22000,
    dbMax: 30, dbMin: -30,
  };

  // ── FFT (Radix-2 Cooley-Tukey, in-place) ──
  // Size must be a power of 2. Operates on two parallel Float32Arrays for
  // real/imag parts. Standard textbook implementation — adequate for the
  // one-shot offline analysis we do per file (no need for SIMD or wasm).
  function fft(re, im) {
    const N = re.length;
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1;
      const angle = -2 * Math.PI / len;
      const wnRe = Math.cos(angle);
      const wnIm = Math.sin(angle);
      for (let i = 0; i < N; i += len) {
        let wRe = 1, wIm = 0;
        for (let k = 0; k < half; k++) {
          const xr = re[i + k];
          const xi = im[i + k];
          const yr = re[i + k + half] * wRe - im[i + k + half] * wIm;
          const yi = re[i + k + half] * wIm + im[i + k + half] * wRe;
          re[i + k]        = xr + yr;
          im[i + k]        = xi + yi;
          re[i + k + half] = xr - yr;
          im[i + k + half] = xi - yi;
          const nwRe = wRe * wnRe - wIm * wnIm;
          wIm        = wRe * wnIm + wIm * wnRe;
          wRe        = nwRe;
        }
      }
    }
  }

  // ── Offline spectrum analysis ──
  // Decode the source file, slice into 50%-overlapped windows of FFT_SIZE
  // samples, apply a Hann window, FFT each, and average the magnitude-
  // squared spectra. Returns the averaged power spectrum + the source
  // sample rate so we can convert bin indices to Hz.
  const FFT_SIZE = 16384;
  async function analyzeSpectrum(filePath) {
    const url = fileUrlFor(filePath);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
    const buf = await resp.arrayBuffer();
    const tempCtx = new OfflineAudioContext(1, 1, 48000);
    const audioBuf = await tempCtx.decodeAudioData(buf);
    const data = audioBuf.getChannelData(0);
    const sr = audioBuf.sampleRate;
    if (data.length < FFT_SIZE) throw new Error('file too short for analysis');

    const N = FFT_SIZE;
    const hop = N >> 1;
    const half = N >> 1;
    const window = new Float32Array(N);
    for (let i = 0; i < N; i++) window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));

    const power = new Float32Array(half);
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    let frames = 0;
    for (let pos = 0; pos + N <= data.length; pos += hop) {
      for (let i = 0; i < N; i++) {
        re[i] = data[pos + i] * window[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let i = 0; i < half; i++) power[i] += re[i] * re[i] + im[i] * im[i];
      frames++;
    }
    if (frames === 0) throw new Error('no FFT frames produced');
    for (let i = 0; i < half; i++) power[i] /= frames;
    return { power, sr, fftSize: N, frames };
  }

  // Find the bin with the highest power inside a window of ±halfOctaves
  // octaves around fCenter. Returns the bin's centre frequency in Hz, or
  // null if the window falls outside the analyzed spectrum.
  function findPeakAround(spec, fCenter, halfOctaves) {
    const ratio = Math.pow(2, halfOctaves);
    const fMin = fCenter / ratio;
    const fMax = fCenter * ratio;
    const binWidth = spec.sr / spec.fftSize;
    const iMin = Math.max(1, Math.floor(fMin / binWidth));
    const iMax = Math.min(spec.power.length - 1, Math.ceil(fMax / binWidth));
    if (iMax <= iMin) return null;
    let maxPow = -Infinity, maxIdx = -1;
    for (let i = iMin; i <= iMax; i++) {
      if (spec.power[i] > maxPow) { maxPow = spec.power[i]; maxIdx = i; }
    }
    return maxIdx === -1 ? null : maxIdx * binWidth;
  }

  // Files we've already auto-fitted in this session. Re-selecting the same
  // file in the dropdown shouldn't re-run analysis (would clobber any
  // manual band tweaks the user made after the initial fit). Note that
  // Mode 2's three-way A/B (below) resolves to a *different* path per
  // source kind (original / enhanced / a fusion temp file whose name
  // changes when fusion settings change), so this naturally re-fits and
  // re-caches whenever the actually-audible signal changes.
  const autoFittedFiles = new Set();

  // Power spectra keyed by resolved path, reused by the A/B gain
  // compensation below (Fase 8a) so switching sources or nudging a band
  // doesn't require re-decoding the file each time.
  const spectrumCache = new Map();

  async function autoFitToFile(filePath, displayName) {
    const fileName = displayName ?? filePath.split('/').pop();
    if (!filePath || autoFittedFiles.has(filePath)) {
      if (spectrumCache.has(filePath)) updateGainCompensation();
      return;
    }
    autoFittedFiles.add(filePath);
    const prevReadout = readoutEl.textContent;
    readoutEl.textContent = `Analyzing source spectrum for ${fileName}…`;
    try {
      const spec = await analyzeSpectrum(filePath);
      spectrumCache.set(filePath, spec);
      if (filePath === currentPreviewPath) updateGainCompensation();
      const moves = [];
      for (const id of AUTO_FIT_BAND_IDS) {
        const band = bands.find(b => b.id === id);
        const def  = DEFAULT_BANDS.find(b => b.id === id);
        if (!band || !def) continue;
        const peak = findPeakAround(spec, def.f, AUTO_FIT_HALF_OCTAVE);
        if (peak === null) continue;
        const newF = Math.round(peak);
        if (newF !== band.f) {
          moves.push({ label: band.label, from: band.f, to: newF });
          band.f = newF;
        }
      }
      if (moves.length) {
        onBandsChanged();
        const summary = moves.map(m => `${m.label} ${m.from}→${m.to} Hz`).join(', ');
        readoutEl.textContent = `Auto-fit on ${fileName}: ${summary}`;
        if (window.api?.log) {
          window.api.log.push('autofit',
            `Spectrum-fit on ${fileName} (${spec.frames} FFT frames @ ${spec.sr} Hz)`,
            summary);
        }
      } else {
        readoutEl.textContent = `Auto-fit on ${fileName}: bands already centred on local peaks`;
        if (window.api?.log) {
          window.api.log.push('autofit',
            `Spectrum-fit on ${fileName} — no bands moved`,
            `${spec.frames} FFT frames @ ${spec.sr} Hz`);
        }
      }
    } catch (err) {
      readoutEl.textContent = `Auto-fit failed: ${err.message}`;
      if (window.api?.log) {
        window.api.log.push('autofit', `Spectrum-fit failed for ${fileName}`, err.message);
      }
      // Allow retry on next selection if it errored.
      autoFittedFiles.delete(filePath);
      // Restore the readout after a moment so the failure message doesn't stick.
      setTimeout(() => { if (readoutEl.textContent.startsWith('Auto-fit failed')) readoutEl.textContent = prevReadout; }, 4000);
    }
  }

  // ── Math (RBJ analog approximation; matches the standalone HTML) ──
  function gainDb(f, b) {
    if (!b.enabled) return 0;
    if (b.type === 'highpass') {
      const r4 = (f / b.f) ** 4;
      return 10 * Math.log10(r4 / (1 + r4));
    }
    if (b.type === 'peaking') {
      const r = f / b.f - b.f / f;
      return b.g / (1 + (r * b.q) ** 2);
    }
    if (b.type === 'highshelf') {
      const r = (f / b.f) ** 2;
      return b.g * (r / (1 + r));
    }
    if (b.type === 'lowshelf') {
      const r = (b.f / f) ** 2;
      return b.g * (1 / (1 + r));
    }
    return 0;
  }
  const totalDb = (bands, f) => bands.reduce((s, b) => s + gainDb(f, b), 0);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ── A/B gain compensation (Fase 8a) ──────────────────────────────────
  // Bypass used to just swap gain 0/1 between the dry and EQ'd paths, so
  // a boost-heavy curve could "win" an A/B purely by being louder — not
  // by sounding better. Instead of guessing with a generic pink-noise
  // correction, we measure how much the *current* EQ curve would shift
  // this specific file's own power spectrum (already computed for
  // auto-fit) and apply the inverse as make-up gain on the wet path, so
  // Bypass A/Bs tone only. See docs/PLAN.md §4 Fase 8 acceptance: "A/B no
  // cambia de loudness percibido".
  function computeGainCompensationDb(spec, currentBands) {
    const { power, sr, fftSize } = spec;
    const binWidth = sr / fftSize;
    let weightedLinPower = 0;
    let totalPower = 0;
    for (let i = 1; i < power.length; i++) {
      const p = power[i];
      if (p <= 0) continue;
      const f = i * binWidth;
      if (f < 20 || f > 20000) continue;
      const gDb = totalDb(currentBands, f);
      weightedLinPower += p * Math.pow(10, gDb / 10);
      totalPower += p;
    }
    if (totalPower <= 0) return 0;
    const ratioDb = 10 * Math.log10(weightedLinPower / totalPower);
    return clamp(-ratioDb, -18, 18);
  }

  function updateGainCompensation() {
    const spec = currentPreviewPath && spectrumCache.get(currentPreviewPath);
    const db = spec ? computeGainCompensationDb(spec, bands) : 0;
    if (makeupGain) makeupGain.gain.value = Math.pow(10, db / 20);
    if (!makeupInfoEl) return;
    if (!spec) {
      makeupInfoEl.textContent = 'level match: analyzing…';
      makeupInfoEl.title = 'Waiting for the source spectrum to compute A/B make-up gain.';
    } else if (Math.abs(db) < 0.05) {
      makeupInfoEl.textContent = 'level-matched';
      makeupInfoEl.title = 'No measurable average level shift from the current EQ on this file\u2019s spectrum \u2014 Bypass A/Bs tone only.';
    } else {
      const sign = db >= 0 ? '+' : '';
      makeupInfoEl.textContent = `level-matched (${sign}${db.toFixed(1)} dB)`;
      makeupInfoEl.title = 'Make-up gain applied to the EQ\u2019d signal (measured on this file\u2019s own spectrum) so Bypass A/Bs tone, not loudness.';
    }
  }

  // ── State ──
  const bands = JSON.parse(JSON.stringify(DEFAULT_BANDS));
  let manualEqApply = false;
  let hoveredId = null;
  let draggingId = null;
  let dragOffset = { x: 0, y: 0 };

  // Three-way A/B for Mode 2 pairs (Fase 8b) — which raw source is
  // currently loaded into the preview. Irrelevant (stays 'original')
  // for files with no detected pair.
  let sourceKind = 'original'; // 'original' | 'enhanced' | 'fusion'
  let currentPreviewPath = null; // resolved path actually loaded into audioEl
  let resolvingSource = false;
  let sourceChangedWhileResolving = false;
  const filesInfo = new Map(); // nominal path -> { path, name, pairPath }

  // ── DOM refs ──
  const canvas      = document.getElementById('eq-canvas');
  const ctx2d       = canvas.getContext('2d');
  const fileSelect  = document.getElementById('eq-file-select');
  const sourceToggle    = document.getElementById('eq-source-toggle');
  const playBtn     = document.getElementById('eq-play');
  const stopBtn     = document.getElementById('eq-stop');
  const timeLabel   = document.getElementById('eq-time');
  const bypassChk   = document.getElementById('eq-bypass');
  const makeupInfoEl    = document.getElementById('eq-makeup-info');
  const resetBtn    = document.getElementById('eq-reset');
  const statusVal   = document.getElementById('eq-status-value');
  const readoutEl   = document.getElementById('eq-readout');
  const tabEq       = document.querySelector('[data-tab="eq"]');

  // ── Coordinate helpers ──
  function plotArea() {
    const W = canvas.clientWidth || canvas.width;
    const H = canvas.clientHeight || canvas.height;
    return { W, H, PW: W - LAYOUT.ML - LAYOUT.MR, PH: H - LAYOUT.MT - LAYOUT.MB };
  }
  function xOf(f)  { const { PW } = plotArea(); return LAYOUT.ML + (Math.log(f) - Math.log(LAYOUT.fLo)) / (Math.log(LAYOUT.fHi) - Math.log(LAYOUT.fLo)) * PW; }
  function yOf(db) { const { PH } = plotArea(); return LAYOUT.MT + (LAYOUT.dbMax - db) / (LAYOUT.dbMax - LAYOUT.dbMin) * PH; }
  function freqOfX(x) { const { PW } = plotArea(); return Math.exp(Math.log(LAYOUT.fLo) + (x - LAYOUT.ML) / PW * (Math.log(LAYOUT.fHi) - Math.log(LAYOUT.fLo))); }
  function dbOfY(y)   { const { PH } = plotArea(); return LAYOUT.dbMax - (y - LAYOUT.MT) / PH * (LAYOUT.dbMax - LAYOUT.dbMin); }

  function handlePos(b) {
    if (b.type === 'highpass')  return { x: xOf(b.f), y: yOf(-3) };
    if (b.type === 'highshelf') return { x: xOf(b.f), y: yOf(b.g / 2) };
    if (b.type === 'lowshelf')  return { x: xOf(b.f), y: yOf(b.g / 2) };
    return { x: xOf(b.f), y: yOf(b.g) };
  }

  // ── Audio (single, fixed topology — bypass swaps gains) ──
  let audioCtx = null, audioEl = null, sourceNode = null;
  let filterNodes = [], makeupGain = null, wetGain = null, dryGain = null;

  function ensureAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioEl = new Audio();
    audioEl.preload = 'metadata';
    audioEl.addEventListener('timeupdate', updateTime);
    audioEl.addEventListener('loadedmetadata', updateTime);
    audioEl.addEventListener('ended', () => { playBtn.textContent = '▶'; });
    audioEl.addEventListener('error', () => {
      const err = audioEl.error;
      const code = err?.code;
      const codeMap = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'src not supported' };
      const msg = `Playback failed: ${codeMap[code] ?? 'unknown'} (${audioEl.src})`;
      console.warn('[EQ]', msg, err);
      readoutEl.textContent = msg;
      playBtn.textContent = '▶';
    });
    sourceNode = audioCtx.createMediaElementSource(audioEl);
    filterNodes = bands.map(b => {
      const n = audioCtx.createBiquadFilter();
      n.type = b.type;
      applyBandToNode(b, n);
      return n;
    });
    sourceNode.connect(filterNodes[0]);
    for (let i = 0; i < filterNodes.length - 1; i++) filterNodes[i].connect(filterNodes[i + 1]);
    // Make-up gain sits between the EQ chain and the wet bus so Bypass
    // A/Bs tone, not overall loudness (Fase 8a) — see
    // computeGainCompensationDb / updateGainCompensation below.
    makeupGain = audioCtx.createGain();
    wetGain = audioCtx.createGain();
    dryGain = audioCtx.createGain();
    filterNodes[filterNodes.length - 1].connect(makeupGain);
    makeupGain.connect(wetGain);
    sourceNode.connect(dryGain);
    wetGain.connect(audioCtx.destination);
    dryGain.connect(audioCtx.destination);
    applyBypass();
    updateGainCompensation();
  }
  function applyBandToNode(b, n) {
    if (n.type !== b.type) n.type = b.type;
    if (b.type === 'highpass') {
      n.frequency.value = b.enabled ? b.f : 5;
      n.Q.value         = b.q;
      n.gain.value      = 0;
    } else {
      n.frequency.value = b.f;
      n.Q.value         = b.q;
      n.gain.value      = b.enabled ? b.g : 0;
    }
  }
  function applyAllBandsToNodes() {
    for (let i = 0; i < bands.length; i++) {
      if (filterNodes[i]) applyBandToNode(bands[i], filterNodes[i]);
    }
  }
  function applyBypass() {
    if (!audioCtx) return;
    if (bypassChk.checked) { wetGain.gain.value = 0; dryGain.gain.value = 1; }
    else                   { wetGain.gain.value = 1; dryGain.gain.value = 0; }
  }

  // ── Canvas rendering ──
  function drawCurve() {
    const dpr = window.devicePixelRatio || 1;
    const { W, H, PW, PH } = plotArea();
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width  = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx2d.fillStyle = '#1a1f28';
    ctx2d.fillRect(0, 0, W, H);

    ctx2d.font = '10px -apple-system, sans-serif';
    ctx2d.textBaseline = 'middle';
    const dbTicks = [-30, -24, -18, -12, -6, 0, 6, 12, 18, 24, 30];
    for (const db of dbTicks) {
      const y = yOf(db);
      ctx2d.beginPath();
      if (db === 0) {
        ctx2d.strokeStyle = '#5a6a85';
        ctx2d.setLineDash([3, 3]);
      } else {
        ctx2d.strokeStyle = '#2a3140';
        ctx2d.setLineDash([]);
      }
      ctx2d.moveTo(LAYOUT.ML, y);
      ctx2d.lineTo(W - LAYOUT.MR, y);
      ctx2d.stroke();
      ctx2d.fillStyle = '#6e7785';
      ctx2d.textAlign = 'right';
      ctx2d.fillText((db > 0 ? '+' + db : db) + ' dB', LAYOUT.ML - 6, y);
    }
    ctx2d.setLineDash([]);

    const fTicks = [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'top';
    for (const f of fTicks) {
      const x = xOf(f);
      ctx2d.beginPath();
      ctx2d.strokeStyle = '#2a3140';
      ctx2d.moveTo(x, LAYOUT.MT);
      ctx2d.lineTo(x, H - LAYOUT.MB);
      ctx2d.stroke();
      const lbl = f >= 1000 ? (f / 1000) + 'k' : f.toString();
      ctx2d.fillStyle = '#6e7785';
      ctx2d.fillText(lbl, x, H - LAYOUT.MB + 6);
    }

    const N = 280;
    ctx2d.lineWidth = 1;
    ctx2d.setLineDash([3, 4]);
    for (let bi = 0; bi < bands.length; bi++) {
      const b = bands[bi];
      ctx2d.strokeStyle = b.color;
      ctx2d.globalAlpha = b.enabled ? 0.5 : 0.2;
      ctx2d.beginPath();
      for (let i = 0; i < N; i++) {
        const f = LAYOUT.fLo * (LAYOUT.fHi / LAYOUT.fLo) ** (i / (N - 1));
        const db = clamp(gainDb(f, b), LAYOUT.dbMin, LAYOUT.dbMax);
        const x = xOf(f), y = yOf(db);
        if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
      }
      ctx2d.stroke();
    }
    ctx2d.globalAlpha = 1;
    ctx2d.setLineDash([]);

    ctx2d.lineWidth = 2.4;
    ctx2d.strokeStyle = '#7afe9f';
    ctx2d.shadowBlur = 6;
    ctx2d.shadowColor = 'rgba(122,254,159,.5)';
    ctx2d.beginPath();
    for (let i = 0; i < N; i++) {
      const f = LAYOUT.fLo * (LAYOUT.fHi / LAYOUT.fLo) ** (i / (N - 1));
      const db = clamp(totalDb(bands, f), LAYOUT.dbMin, LAYOUT.dbMax);
      const x = xOf(f), y = yOf(db);
      if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
    ctx2d.shadowBlur = 0;

    ctx2d.font = 'bold 11px -apple-system, sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'middle';
    for (let bi = 0; bi < bands.length; bi++) {
      const b = bands[bi];
      const p = handlePos(b);
      const isHover = b.id === hoveredId || b.id === draggingId;
      const r = isHover ? 14 : 11;
      ctx2d.beginPath();
      ctx2d.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx2d.fillStyle = b.enabled ? b.color : '#33384a';
      ctx2d.globalAlpha = isHover ? 1 : 0.9;
      ctx2d.fill();
      ctx2d.lineWidth = isHover ? 2.5 : 1.5;
      ctx2d.strokeStyle = isHover ? '#fff' : 'rgba(255,255,255,.5)';
      ctx2d.stroke();
      ctx2d.globalAlpha = 1;
      ctx2d.fillStyle = '#0d0f14';
      ctx2d.fillText(String(bi + 1), p.x, p.y + 0.5);
    }
  }

  // ── Hit testing ──
  function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function findBandAt(x, y, tol = 16) {
    let best = null, bestD = tol;
    for (const b of bands) {
      const p = handlePos(b);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  function fmtFreq(f) {
    if (f >= 1000) return (Math.round(f / 10) / 100).toFixed(2).replace(/\.?0+$/, '') + ' kHz';
    return Math.round(f) + ' Hz';
  }
  function fmtDb(g) { return (g >= 0 ? '+' : '') + g.toFixed(1) + ' dB'; }
  function updateReadout() {
    const id = draggingId || hoveredId;
    if (!id) {
      readoutEl.textContent = 'Click and drag a band — scroll to change Q · shift-click to enable/disable';
      return;
    }
    const b = bands.find(x => x.id === id);
    if (!b) return;
    const idx = bands.findIndex(x => x.id === id) + 1;
    const parts = [
      `${idx}. ${b.label}`,
      `${b.type}`,
      `f: ${fmtFreq(b.f)}`,
    ];
    if (b.type !== 'highpass') parts.push(`g: ${fmtDb(b.g)}`);
    parts.push(`Q: ${b.q.toFixed(2)}`);
    parts.push(b.enabled ? 'on' : 'off');
    readoutEl.textContent = parts.join('   ·   ');
  }

  canvas.addEventListener('mousemove', (e) => {
    const { x, y } = getMousePos(e);
    if (draggingId) {
      const b = bands.find(x => x.id === draggingId);
      if (!b) return;
      const newF = clamp(freqOfX(x - dragOffset.x), 20, 20000);
      b.f = Math.round(newF);
      if (b.type === 'peaking') {
        b.g = clamp(dbOfY(y - dragOffset.y), -30, 30);
        b.g = Math.round(b.g * 10) / 10;
      } else if (b.type === 'highshelf' || b.type === 'lowshelf') {
        b.g = clamp(dbOfY(y - dragOffset.y) * 2, -30, 30);
        b.g = Math.round(b.g * 10) / 10;
      }
      onBandsChanged();
      updateReadout();
    } else {
      const hit = findBandAt(x, y);
      const newId = hit ? hit.id : null;
      if (newId !== hoveredId) {
        hoveredId = newId;
        canvas.style.cursor = hoveredId ? 'grab' : 'default';
        drawCurve();
        updateReadout();
      }
    }
  });
  canvas.addEventListener('mousedown', (e) => {
    const { x, y } = getMousePos(e);
    const hit = findBandAt(x, y);
    if (!hit) return;
    if (e.shiftKey) {
      hit.enabled = !hit.enabled;
      onBandsChanged();
      updateReadout();
      return;
    }
    draggingId = hit.id;
    const p = handlePos(hit);
    dragOffset = { x: x - p.x, y: y - p.y };
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  });
  function endDrag() {
    if (draggingId) {
      draggingId = null;
      canvas.style.cursor = hoveredId ? 'grab' : 'default';
      drawCurve();
      updateReadout();
    }
  }
  window.addEventListener('mouseup', endDrag);
  canvas.addEventListener('mouseleave', () => {
    if (!draggingId) {
      hoveredId = null;
      drawCurve();
      updateReadout();
    }
  });
  function findBandForWheel(x, y) {
    if (draggingId) return bands.find(b => b.id === draggingId);
    const exact = findBandAt(x, y, 18);
    if (exact) return exact;
    let best = null, bestDx = Infinity;
    for (const b of bands) {
      if (!b.enabled) continue;
      const dx = Math.abs(xOf(b.f) - x);
      if (dx < bestDx) { bestDx = dx; best = b; }
    }
    return best;
  }

  canvas.addEventListener('wheel', (e) => {
    const { x, y } = getMousePos(e);
    const hit = findBandForWheel(x, y);
    if (!hit) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    hit.q = clamp(hit.q * factor, 0.3, 24);
    hit.q = Math.round(hit.q * 100) / 100;
    hoveredId = hit.id;
    onBandsChanged();
    updateReadout();
  }, { passive: false });

  function onBandsChanged() {
    applyAllBandsToNodes();
    updateGainCompensation();
    drawCurve();
    scheduleAutoSave();
  }

  // ── Auto-save (debounced) ──
  // Every band tweak persists the manual chain immediately so "Process All"
  // always reflects what the user is hearing in the editor. When the bands
  // match the built-in defaults, manualEqApply is set to false so the
  // pipeline uses its base EQ path (semantically the same audio, less
  // moving parts to debug).
  let saveTimer = null;
  function scheduleAutoSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistEqState, 250);
  }
  function bandsMatchDefault() {
    if (bands.length !== DEFAULT_BANDS.length) return false;
    for (let i = 0; i < bands.length; i++) {
      const a = bands[i], b = DEFAULT_BANDS[i];
      if (a.enabled !== b.enabled || a.type !== b.type) return false;
      if (Math.abs(a.f - b.f) > 0.5) return false;
      if (Math.abs((a.g ?? 0) - (b.g ?? 0)) > 0.05) return false;
      if (Math.abs(a.q - b.q) > 0.01) return false;
    }
    return true;
  }
  async function persistEqState() {
    if (!window.api?.store) return;
    const useBase = bandsMatchDefault();
    if (useBase) {
      await window.api.store.set('manualEqApply', false);
    } else {
      await window.api.store.set('manualEqChain', buildFfmpegChain());
      await window.api.store.set('manualEqApply', true);
    }
    manualEqApply = !useBase;
    updateStatus();
  }

  // ── File selector — always preview the SOURCE (Fase 8b: or one of the
  // three raw Mode 2 sources, see below) ──
  // The preview must match what the pipeline will produce: source + current
  // editor EQ. Auditioning the already-processed output would stack two EQs.
  let lastSelectedPath = null;

  function refreshFileSelect() {
    let opts = [];
    if (window.audioProQueue?.listFiles) {
      opts = window.audioProQueue.listFiles().map(f => ({ path: f.path, name: f.name, pairPath: f.pairPath || null }));
    } else {
      document.querySelectorAll('#queue-list .file-item').forEach(it => {
        const path = it.dataset.filePath;
        const name = it.querySelector('.file-name')?.textContent ?? path;
        if (path) opts.push({ path, name, pairPath: null });
      });
    }
    filesInfo.clear();
    for (const o of opts) filesInfo.set(o.path, o);
    const prevValue = fileSelect.value;
    fileSelect.innerHTML = opts.length
      ? opts.map(o => `<option value="${escapeHtml(o.path)}">${escapeHtml(o.name)}</option>`).join('')
      : '<option value="">No files in queue — add one in Processing tab</option>';
    if (opts.find(o => o.path === prevValue)) fileSelect.value = prevValue;
    onFileSelectionChanged();
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── Three-way A/B for Mode 2 pairs (Fase 8b) ──────────────────────────
  // A detected pair's sensible default is 'fusion' — that's what Process
  // All will actually render. Re-running refreshFileSelect() (e.g. another
  // file in the queue changing status) must NOT reset the toggle while the
  // same file stays selected, or an in-progress A/B would keep jumping
  // back to fusion; it only resets on a genuine selection change.
  function currentFileInfo() { return filesInfo.get(fileSelect.value) ?? null; }

  function onFileSelectionChanged() {
    const changed = fileSelect.value !== lastSelectedPath;
    lastSelectedPath = fileSelect.value;
    if (changed) sourceKind = currentFileInfo()?.pairPath ? 'fusion' : 'original';
    syncSource();
  }

  function updateSourceToggleUI() {
    const hasPair = !!currentFileInfo()?.pairPath;
    sourceToggle.hidden = !hasPair;
    if (!hasPair) return;
    for (const btn of sourceToggle.querySelectorAll('.mode-btn')) {
      btn.classList.toggle('active', btn.dataset.source === sourceKind);
    }
  }

  // Resolves which actual file the editor should analyze/play for the
  // current (nominal file, sourceKind) pair. 'fusion' requires a render
  // round-trip through main (src/fusion.js) — cached there per settings,
  // so re-picking "Fusion" without changing fusion settings is instant.
  async function resolveEffectivePath() {
    const info = currentFileInfo();
    if (!info) return null;
    if (sourceKind === 'enhanced' && info.pairPath) {
      return { path: info.pairPath, displayName: `${info.name} \u00b7 enhanced` };
    }
    if (sourceKind === 'fusion' && info.pairPath) {
      if (!window.api?.fusion?.preview) return { path: info.path, displayName: info.name };
      readoutEl.textContent = `Rendering fusion preview for ${info.name}\u2026`;
      try {
        const res = await window.api.fusion.preview(info.path, info.pairPath);
        if (res?.path) return { path: res.path, displayName: `${info.name} \u00b7 fusion` };
        readoutEl.textContent = `Fusion preview failed: ${res?.error ?? 'unknown error'} \u2014 showing original instead`;
      } catch (err) {
        readoutEl.textContent = `Fusion preview failed: ${err.message} \u2014 showing original instead`;
      }
      return { path: info.path, displayName: `${info.name} \u00b7 original (fusion preview failed)` };
    }
    return { path: info.path, displayName: info.name };
  }

  async function syncSource() {
    updateSourceToggleUI();
    if (resolvingSource) { sourceChangedWhileResolving = true; return; }
    resolvingSource = true;
    try {
      // A toggle click (or file change) that lands while we're still
      // awaiting a slow resolution (typically the fusion IPC render) must
      // not be dropped, or the in-flight result could apply stale audio
      // over the newer selection once it lands. Loop until a resolution
      // finishes with no further changes queued up behind it.
      do {
        sourceChangedWhileResolving = false;
        const resolved = await resolveEffectivePath();
        if (!resolved) { currentPreviewPath = null; break; }
        currentPreviewPath = resolved.path;
        autoFitToFile(resolved.path, resolved.displayName);
        updateGainCompensation();
        await applyPreviewSource(resolved.path);
      } while (sourceChangedWhileResolving);
    } finally {
      resolvingSource = false;
    }
  }

  // ── Playback ──
  // The source file path may contain spaces, reserved characters, or
  // backslashes (Windows). HTMLAudioElement requires a proper URL — raw
  // spaces or backslashes in `file://` URLs fail silently in Chromium.
  function fileUrlFor(p) {
    // Normalize Windows backslashes to forward slashes. A path like
    // `C:\Users\test\a.wav` becomes `C:/Users/test/a.wav`, then the
    // URL is `file:///C:/Users/test/a.wav` (drive-letter paths get an
    // extra leading `/` so the host portion is empty).
    const fwd = p.replace(/\\/g, '/');
    const prefix = fwd.startsWith('/') ? 'file://' : 'file:///';
    return prefix + encodeURI(fwd);
  }

  function waitForLoadedMetadata(el, timeoutMs = 4000) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener('loadedmetadata', finish);
        resolve();
      };
      el.addEventListener('loadedmetadata', finish, { once: true });
      setTimeout(finish, timeoutMs);
    });
  }

  // Hot-swaps audioEl's source in place, preserving playback position and
  // play/pause state — switching original/enhanced/fusion mid-listen is
  // the entire point of the three-way A/B (a hard reset to 0:00 on every
  // click would make it useless for comparing the same passage).
  async function applyPreviewSource(path) {
    const desired = fileUrlFor(path);
    if (!audioEl || audioEl.src === desired) return;
    const wasPlaying = !audioEl.paused;
    const wasTime = audioEl.currentTime || 0;
    audioEl.src = desired;
    if (wasTime > 0) {
      await waitForLoadedMetadata(audioEl);
      if (Number.isFinite(audioEl.duration)) audioEl.currentTime = Math.min(wasTime, Math.max(0, audioEl.duration - 0.05));
    }
    if (wasPlaying) {
      try { await audioEl.play(); } catch (err) { console.warn('[EQ] resume after source swap failed', err); }
    }
  }

  async function playPause() {
    const path = currentPreviewPath || fileSelect.value;
    if (!path) return;
    ensureAudio();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const desired = fileUrlFor(path);
    if (audioEl.src !== desired) {
      audioEl.src = desired;
    }
    if (audioEl.paused) {
      try {
        await audioEl.play();
        playBtn.textContent = '⏸';
      } catch (err) {
        console.warn('[EQ] play() rejected', err);
        readoutEl.textContent = `Playback failed: ${err.message || err.name || err}`;
      }
    } else {
      audioEl.pause();
      playBtn.textContent = '▶';
    }
  }
  function stop() {
    if (!audioEl) return;
    audioEl.pause();
    audioEl.currentTime = 0;
    playBtn.textContent = '▶';
  }
  function fmtTime(s) {
    if (!Number.isFinite(s)) return '0:00';
    const m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return `${m}:${ss < 10 ? '0' : ''}${ss}`;
  }
  function updateTime() {
    if (!audioEl) return;
    timeLabel.textContent = `${fmtTime(audioEl.currentTime)} / ${fmtTime(audioEl.duration || 0)}`;
  }

  // ── FFmpeg filter string ──
  function bandToFilter(b) {
    if (!b.enabled) return null;
    if (b.type === 'highpass') return `highpass=f=${Math.round(b.f)}:poles=2`;
    if (b.type === 'peaking')  return `equalizer=f=${Math.round(b.f)}:width_type=q:width=${b.q}:g=${b.g}`;
    if (b.type === 'highshelf')return `highshelf=f=${Math.round(b.f)}:g=${b.g}`;
    if (b.type === 'lowshelf') return `lowshelf=f=${Math.round(b.f)}:g=${b.g}`;
    return null;
  }
  function buildFfmpegChain() {
    const parts = bands.map(bandToFilter).filter(Boolean);
    return parts.length ? parts.join(',') : 'acopy';
  }

  // ── Reset to defaults ──
  async function resetToAuto() {
    for (let i = 0; i < bands.length; i++) Object.assign(bands[i], DEFAULT_BANDS[i]);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (window.api?.store) await window.api.store.set('manualEqApply', false);
    manualEqApply = false;
    applyAllBandsToNodes();
    updateGainCompensation();
    drawCurve();
    updateStatus();
    updateReadout();
  }
  function updateStatus() {
    if (manualEqApply) {
      statusVal.textContent = 'custom — your EQ will be applied when you Process All';
      statusVal.className = 'eq-status-on';
    } else {
      statusVal.textContent = 'base — pipeline will use the built-in EQ when you Process All';
      statusVal.className = 'eq-status-off';
    }
  }

  // ── Init ──
  drawCurve();
  updateReadout();
  (async () => {
    if (!window.api?.store) return;
    try {
      manualEqApply = (await window.api.store.get('manualEqApply')) === true;
      updateStatus();
    } catch { /* ignore */ }
  })();

  if (tabEq) {
    tabEq.addEventListener('click', () => {
      refreshFileSelect();
      requestAnimationFrame(drawCurve);
    });
  }
  window.addEventListener('audiopro:queue-changed', refreshFileSelect);
  refreshFileSelect();
  fileSelect.addEventListener('change', onFileSelectionChanged);
  sourceToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn || btn.classList.contains('active')) return;
    sourceKind = btn.dataset.source;
    syncSource();
  });
  playBtn.addEventListener('click', playPause);
  stopBtn.addEventListener('click', stop);
  bypassChk.addEventListener('change', applyBypass);
  resetBtn.addEventListener('click', resetToAuto);

  document.addEventListener('keydown', (e) => {
    const eqActive = document.getElementById('view-eq') && !document.getElementById('view-eq').hidden;
    if (!eqActive) return;
    if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'SELECT') {
      e.preventDefault();
      playPause();
    }
  });
  window.addEventListener('resize', () => requestAnimationFrame(drawCurve));

})();
