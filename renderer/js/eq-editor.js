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

  const DEFAULT_BANDS = [
    { id: 'hpf', enabled: true, type: 'highpass',  f: 80,    g: 0,    q: 0.707, label: 'HPF',     color: '#888' },
    { id: 'b1',  enabled: true, type: 'peaking',   f: 150,   g: -3,   q: 8,     label: '150',     color: '#ff6b6b' },
    { id: 'b2',  enabled: true, type: 'peaking',   f: 250,   g: -3.5, q: 8,     label: '250',     color: '#ffaa55' },
    { id: 'b3',  enabled: true, type: 'peaking',   f: 400,   g: -3,   q: 8,     label: '400',     color: '#ff6b6b' },
    { id: 'b4',  enabled: true, type: 'peaking',   f: 700,   g: -3,   q: 8,     label: '700',     color: '#ff6b6b' },
    { id: 'b5',  enabled: true, type: 'peaking',   f: 2500,  g: 1,    q: 1.4,   label: 'Pres',    color: '#7afe9f' },
    { id: 'b6',  enabled: true, type: 'highshelf', f: 10000, g: 3,    q: 0.707, label: 'Air',     color: '#c79bff' },
  ];

  const LAYOUT = {
    ML: 48, MR: 18, MT: 18, MB: 28,
    fLo: 30, fHi: 22000,
    dbMax: 30, dbMin: -30,
  };

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

  // ── State ──
  const bands = JSON.parse(JSON.stringify(DEFAULT_BANDS));
  let manualEqApply = false;
  let hoveredId = null;
  let draggingId = null;
  let dragOffset = { x: 0, y: 0 };

  // ── DOM refs ──
  const canvas      = document.getElementById('eq-canvas');
  const ctx2d       = canvas.getContext('2d');
  const fileSelect  = document.getElementById('eq-file-select');
  const playBtn     = document.getElementById('eq-play');
  const stopBtn     = document.getElementById('eq-stop');
  const timeLabel   = document.getElementById('eq-time');
  const bypassChk   = document.getElementById('eq-bypass');
  const resetBtn    = document.getElementById('eq-reset');
  const applyBtn    = document.getElementById('eq-apply');
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
    // Each handle sits on the curve where its band has maximum effect.
    if (b.type === 'highpass')  return { x: xOf(b.f), y: yOf(-3) };          // anchored to the −3 dB cutoff
    if (b.type === 'highshelf') return { x: xOf(b.f), y: yOf(b.g / 2) };     // shelf "knee"
    if (b.type === 'lowshelf')  return { x: xOf(b.f), y: yOf(b.g / 2) };
    return { x: xOf(b.f), y: yOf(b.g) };                                      // peaking
  }

  // ── Audio (single, fixed topology — bypass swaps gains) ──
  let audioCtx = null, audioEl = null, sourceNode = null;
  let filterNodes = [], wetGain = null, dryGain = null;

  function ensureAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioEl = new Audio();
    audioEl.preload = 'metadata';
    audioEl.addEventListener('timeupdate', updateTime);
    audioEl.addEventListener('loadedmetadata', updateTime);
    audioEl.addEventListener('ended', () => { playBtn.textContent = '▶'; });
    sourceNode = audioCtx.createMediaElementSource(audioEl);
    filterNodes = bands.map(b => {
      const n = audioCtx.createBiquadFilter();
      n.type = b.type;
      applyBandToNode(b, n);
      return n;
    });
    sourceNode.connect(filterNodes[0]);
    for (let i = 0; i < filterNodes.length - 1; i++) filterNodes[i].connect(filterNodes[i + 1]);
    wetGain = audioCtx.createGain();
    dryGain = audioCtx.createGain();
    filterNodes[filterNodes.length - 1].connect(wetGain);
    sourceNode.connect(dryGain);
    wetGain.connect(audioCtx.destination);
    dryGain.connect(audioCtx.destination);
    applyBypass();
  }
  function applyBandToNode(b, n) {
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

    // BG
    ctx2d.fillStyle = '#1a1f28';
    ctx2d.fillRect(0, 0, W, H);

    // Grid: dB ticks
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

    // Grid: frequency ticks
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

    // Individual bands (faint dashed)
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

    // Total curve
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

    // Handles (numbered circles, drag targets)
    ctx2d.font = 'bold 11px -apple-system, sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'middle';
    for (let bi = 0; bi < bands.length; bi++) {
      const b = bands[bi];
      const p = handlePos(b);
      const isHover = b.id === hoveredId || b.id === draggingId;
      const r = isHover ? 14 : 11;
      // Filled circle
      ctx2d.beginPath();
      ctx2d.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx2d.fillStyle = b.enabled ? b.color : '#33384a';
      ctx2d.globalAlpha = isHover ? 1 : 0.9;
      ctx2d.fill();
      // White ring
      ctx2d.lineWidth = isHover ? 2.5 : 1.5;
      ctx2d.strokeStyle = isHover ? '#fff' : 'rgba(255,255,255,.5)';
      ctx2d.stroke();
      ctx2d.globalAlpha = 1;
      // Number / label
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

  // ── Readout (status line under the canvas) ──
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

  // ── Mouse interactions on the canvas ──
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
        // For shelves, dragging Y maps to the shelf's max gain.
        // The handle sits at g/2 visually, so the cursor's Y maps to g/2.
        b.g = clamp(dbOfY(y - dragOffset.y) * 2, -30, 30);
        b.g = Math.round(b.g * 10) / 10;
      }
      // HPF: only X changes (no gain control)
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
  canvas.addEventListener('wheel', (e) => {
    const { x, y } = getMousePos(e);
    const hit = findBandAt(x, y) || (draggingId && bands.find(b => b.id === draggingId));
    if (!hit) return;
    e.preventDefault();
    // Q: log step. Up scroll → tighter Q (higher value).
    const factor = Math.exp(-e.deltaY * 0.0015);
    hit.q = clamp(hit.q * factor, 0.3, 24);
    hit.q = Math.round(hit.q * 100) / 100;
    onBandsChanged();
    updateReadout();
  }, { passive: false });

  // ── Bands changed → audio + redraw ──
  function onBandsChanged() {
    applyAllBandsToNodes();
    drawCurve();
  }

  // ── File selector — pick processed file when available ──
  function refreshFileSelect() {
    let opts = [];
    if (window.audioProQueue?.listFiles) {
      opts = window.audioProQueue.listFiles().map(f => ({
        path: f.output || f.path,
        name: f.name + (f.output ? ' · processed' : ' · source'),
      }));
    } else {
      document.querySelectorAll('#queue-list .file-item').forEach(it => {
        const path = it.dataset.filePath;
        const name = it.querySelector('.file-name')?.textContent ?? path;
        if (path) opts.push({ path, name });
      });
    }
    const prevValue = fileSelect.value;
    fileSelect.innerHTML = opts.length
      ? opts.map(o => `<option value="${escapeHtml(o.path)}">${escapeHtml(o.name)}</option>`).join('')
      : '<option value="">No files in queue — add one in Processing tab</option>';
    if (opts.find(o => o.path === prevValue)) fileSelect.value = prevValue;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── Playback ──
  async function playPause() {
    const path = fileSelect.value;
    if (!path) return;
    ensureAudio();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (audioEl.src !== 'file://' + path && !audioEl.src.endsWith(encodeURI(path))) {
      audioEl.src = 'file://' + path;
    }
    if (audioEl.paused) {
      try { await audioEl.play(); playBtn.textContent = '⏸'; } catch (err) { console.warn('play failed', err); }
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

  // ── Persistence ──
  async function applyToAll() {
    if (!window.api?.store) return;
    await window.api.store.set('manualEqChain', buildFfmpegChain());
    await window.api.store.set('manualEqApply', true);
    manualEqApply = true;
    updateStatus();
  }
  async function resetToAuto() {
    for (let i = 0; i < bands.length; i++) Object.assign(bands[i], DEFAULT_BANDS[i]);
    if (window.api?.store) await window.api.store.set('manualEqApply', false);
    manualEqApply = false;
    onBandsChanged();
    updateStatus();
    updateReadout();
  }
  function updateStatus() {
    if (manualEqApply) {
      statusVal.textContent = 'on — manual EQ added on top of auto EQ for all queued files';
      statusVal.className = 'eq-status-on';
      applyBtn.textContent = 'Update';
    } else {
      statusVal.textContent = 'off — pipeline uses only the automatic EQ';
      statusVal.className = 'eq-status-off';
      applyBtn.textContent = 'Apply to all';
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
  playBtn.addEventListener('click', playPause);
  stopBtn.addEventListener('click', stop);
  bypassChk.addEventListener('change', applyBypass);
  resetBtn.addEventListener('click', resetToAuto);
  applyBtn.addEventListener('click', applyToAll);

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
