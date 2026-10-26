import { outputSize, stemOf, outName, buildSVG, buildEPS, previewMarkup, outlineMarkup, regionPath, defaultHidden, hex, makeZip, saveBlob } from './export.js?v=202610261140';

// ---------------------------------------------------------------- pengaturan
const DEFAULTS = {
  mode: 'color',
  gradColors: 64,
  lineStrokes: true,
  silTones: 'gray',
  silThreshold: 128,
  cavity: 'white',
  upscale: 4,
  colorAuto: 1,
  maxColors: 12,
  colorMerge: 10,
  smooth: 0.8,
  minArea: 6,
  corner: 70,
  bgKey: 'white',
  keyTol: 30,
  whiteMode: 'outer',
  whiteTol: 10,
  learn: true,
  size: '15',
  customMP: 15,
  stacking: 'stacked',
  gapFill: true,
  code: '',
  start: 1,
  format: 'both',
};
const PROC = ['bgKey', 'keyTol', 'mode', 'gradColors', 'lineStrokes', 'silTones', 'silThreshold', 'cavity', 'upscale', 'colorAuto', 'maxColors', 'colorMerge', 'smooth', 'minArea', 'corner', 'whiteMode', 'whiteTol'];
const MAX_WORK = 4096 * 4096;
const GAP_WIDTH = 1.5; // px output

const S = { ...DEFAULTS, ...loadSettings() };
function loadSettings() {
  try {
    const v4 = localStorage.getItem('vektor.settings.v4');
    if (v4) return JSON.parse(v4);
    // Pindah dari v3: pertahankan pengaturan lain, tapi latar putih kembali ke bawaan baru.
    const old = JSON.parse(localStorage.getItem('vektor.settings.v3') || '{}');
    delete old.whiteMode; delete old.cavity;
    return old;
  } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem('vektor.settings.v4', JSON.stringify(S)); } catch { /* mode privat */ }
}

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmtInt = (n) => n.toLocaleString('id-ID');
const fmtMP = (w, h) => (w * h / 1e6).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------- antrean
const items = [];
let selId = null;
let seq = 0;

function procOpts() {
  return {
    bgKey: S.bgKey === 'magenta' || S.bgKey === 'none' ? S.bgKey : null, // 'none' = tidak ada yang dihapus
    keyTol: S.keyTol,
    mode: S.mode,
    gradColors: S.gradColors,
    lineStrokes: S.lineStrokes,
    silTones: S.silTones,
    silThreshold: S.silThreshold,
    cavity: S.cavity,
    upscale: S.upscale,
    maxColors: S.colorAuto ? 0 : S.maxColors,
    colorMerge: S.colorMerge,
    smooth: S.smooth,
    minArea: S.minArea,
    corner: S.corner,
    whiteMode: S.whiteMode,
    whiteTol: S.whiteTol,
    maxWorkPixels: MAX_WORK,
  };
}
const keyOf = (it) => JSON.stringify(procOpts());
const isCurrent = (it) => it.result && it.key === keyOf(it);

function statusOf(it) {
  if (it.inflight) return 'working';
  if (it.aiBusy) return 'ai';
  if (it.error && it.errKey === keyOf(it)) return 'error';
  if (isCurrent(it)) return 'done';
  if (it.want) return 'queued';
  return it.result ? 'stale' : 'idle';
}
// Gambar yang belum diproses / perlu diproses ulang dengan pengaturan sekarang.
const needsWork = (it) => !it.inflight && !isCurrent(it) && !(it.error && it.errKey === keyOf(it));

// Tombol Proses: antrekan semua gambar yang belum sesuai pengaturan sekarang.
function processAll() {
  for (const it of items) if (needsWork(it)) it.want = true;
  schedule();
  items.forEach(updateRow);
  renderBusy();
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name));
  if (!files.length) return;
  for (const file of files) {
    const it = {
      id: ++seq,
      file,
      name: file.name || `gambar-${seq}.png`,
      stem: stemOf(file.name || `gambar-${seq}`),
      url: URL.createObjectURL(file),
      srcW: 0,
      srcH: 0,
      result: null,
      key: null,
      inflight: null,
      progress: 0,
      error: null,
      errKey: null,
      want: false, // diantrekan lewat tombol Proses
      hide: new Set(), // indeks palet yang disembunyikan
      toggles: [], // titik klik [x, y] (koordinat sumber); tiap klik membalik region di titik itu
      redo: [],
      recolor: {},
      outline: null,
      paths: new Map(),
      aiMask: null, // peta objek/latar dari AI (1024², sekali per gambar)
      aiBusy: false,
    };
    items.push(it);
    createRow(it);
    probeSize(it);
  }
  if (selId == null) select(items[0].id);
  refreshAll();
}

function probeSize(it) {
  const img = new Image();
  img.onload = () => {
    it.srcW = img.naturalWidth;
    it.srcH = img.naturalHeight;
    updateRow(it);
    if (it.id === selId) { refreshSize(); if (!V.fitted) fit(); }
  };
  img.src = it.url;
}

function removeItem(id) {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return;
  const it = items[i];
  URL.revokeObjectURL(it.url);
  items.splice(i, 1);
  rowEls.get(id)?.remove();
  rowEls.delete(id);
  if (selId === id) select(items[Math.min(i, items.length - 1)]?.id ?? null);
  refreshAll();
}

// ---------------------------------------------------------------- worker pool
const POOL = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1, navigator.deviceMemory && navigator.deviceMemory < 4 ? 1 : 2));
const workers = [];
function spawn(slot) {
  const w = new Worker('worker.js?v=202610261140');
  const wk = { w, job: null };
  w.onmessage = (e) => onWorker(wk, e.data);
  w.onerror = (e) => {
    e.preventDefault?.();
    const job = wk.job;
    wk.w.terminate();
    workers[slot] = spawn(slot);
    if (job) failJob(job, 'Proses gagal (kemungkinan memori habis). Coba upscale lebih kecil.');
    schedule();
  };
  return wk;
}
for (let i = 0; i < POOL; i++) workers.push(spawn(i));

// ---------------------------------------------------------------- AI (opsional)
const needAI = () => S.mode === 'color' && S.whiteMode === 'ai' && S.bgKey === 'white';
let aiWorker = null, aiJob = null, aiState = '';
function aiStart() {
  if (aiWorker) return;
  aiWorker = new Worker('ai-worker.js?v=202610261140', { type: 'module' });
  aiWorker.onmessage = (e) => {
    const m = e.data, it = aiJob && items.find((x) => x.id === m.id);
    if (m.type === 'progress') {
      aiState = m.stage === 'download' ? `Mengunduh model AI (sekali saja) ${(m.got / 1e6).toFixed(0)}/${(m.total / 1e6).toFixed(0)} MB`
        : m.stage === 'init' ? 'Menyiapkan model AI…' : 'AI menganalisis objek & latar…';
      if (it) updateRow(it);
      renderBusy();
      return;
    }
    aiJob = null;
    aiState = '';
    if (it) {
      it.aiBusy = false;
      if (m.type === 'done') it.aiMask = m.mask;
      else { it.want = false; it.error = `AI gagal: ${m.message}`; it.errKey = keyOf(it); }
      updateRow(it);
    }
    renderBusy();
    schedule();
  };
  aiWorker.onerror = (e) => {
    e.preventDefault?.();
    const it = aiJob && items.find((x) => x.id === aiJob);
    aiWorker.terminate(); aiWorker = null; aiJob = null; aiState = '';
    if (it) { it.aiBusy = false; it.want = false; it.error = 'AI tidak bisa dijalankan di browser ini.'; it.errKey = keyOf(it); updateRow(it); }
    schedule();
  };
}
function aiSchedule() {
  if (!needAI() || aiJob) return;
  const sel = items.find((x) => x.id === selId);
  const cand = (it) => it.want && needsWork(it) && !it.aiMask && !it.aiBusy;
  const it = sel && cand(sel) ? sel : items.find(cand);
  if (!it) return;
  aiStart();
  aiJob = it.id;
  it.aiBusy = true;
  updateRow(it);
  aiWorker.postMessage({ id: it.id, file: it.file });
}

function nextItem() {
  const want = (it) => it.want && needsWork(it) && (!needAI() || it.aiMask);
  const sel = items.find((x) => x.id === selId);
  if (sel && want(sel)) return sel;
  return items.find(want);
}

function schedule() {
  for (const wk of workers) {
    if (wk.job) continue;
    const it = nextItem();
    if (!it) break;
    const key = keyOf(it);
    it.inflight = key;
    it.want = false;
    it.progress = 0;
    wk.job = { id: it.id, key };
    const msg = { id: it.id, file: it.file, opts: procOpts() };
    if (needAI() && it.aiMask) msg.aiMask = it.aiMask.slice();
    wk.w.postMessage(msg);
    updateRow(it);
  }
  aiSchedule();
  refreshStatus();
}

function failJob(job, msg) {
  const it = items.find((x) => x.id === job.id);
  if (!it) return;
  it.inflight = null;
  it.error = msg;
  it.errKey = job.key;
  updateRow(it);
  if (it.id === selId) renderViewer();
  notifyWaiters();
}

function onWorker(wk, msg) {
  const job = wk.job;
  const it = job && items.find((x) => x.id === msg.id);
  if (msg.type === 'progress') {
    if (it) { it.progress = msg.p; updateRow(it); if (it.id === selId) renderBusy(); }
    return;
  }
  wk.job = null;
  if (!it) { schedule(); return; }
  if (msg.type === 'error') {
    failJob(job, msg.message);
  } else {
    const prev = it.result;
    it.inflight = null;
    it.error = null;
    it.result = msg.result;
    it.key = job.key;
    it.outline = null;
    it.paths = new Map();
    predictItem(it);
    if (prev) remapOverrides(it, prev.palette, msg.result.palette);
    updateRow(it);
    if (it.id === selId) { renderViewer(); refreshSize(); }
  }
  notifyWaiters();
  schedule();
}

// Bila palet berubah setelah proses ulang, pindahkan pengubahan warna ke indeks baru.
function remapOverrides(it, oldPal, newPal) {
  const same = oldPal.length === newPal.length && oldPal.every((c, k) => c.join() === newPal[k].join());
  if (same) return;
  const find = (c) => {
    let best = -1, bd = 40;
    newPal.forEach((n, k) => {
      const d = Math.abs(n[0] - c[0]) + Math.abs(n[1] - c[1]) + Math.abs(n[2] - c[2]);
      if (d < bd) { bd = d; best = k; }
    });
    return best;
  };
  const rec = {};
  for (const [k, v] of Object.entries(it.recolor)) { const j = find(oldPal[k]); if (j >= 0) rec[j] = v; }
  it.recolor = rec;
  const hid = new Set();
  for (const k of it.hide) { const j = find(oldPal[k]); if (j >= 0) hid.add(j); }
  it.hide = hid;
}

// ---------------------------------------------------------------- belajar dari hasil akhir
// Saat pengguna mengunduh, keadaan akhir tiap area putih (dihapus / tidak) disimpan
// bersama sidiknya. Gambar berikutnya: k-tetangga terdekat menebak keputusan;
// koreksi pengguna (beda dari bawaan) berbobot lebih besar. Hanya di browser ini.
const LEARN_KEY = 'vektor.learn.v1';
const LEARN_MAX = 4000;
let memory = loadMemory();
function loadMemory() {
  try { const m = JSON.parse(localStorage.getItem(LEARN_KEY) || '[]'); return Array.isArray(m) ? m : []; } catch { return []; }
}
function saveMemory() {
  try { localStorage.setItem(LEARN_KEY, JSON.stringify(memory)); } catch { /* penyimpanan penuh / privat */ }
}
const memId = (it) => `${it.name}|${it.srcW}x${it.srcH}`;

// Catat keadaan akhir satu gambar (menggantikan catatan lama gambar yang sama).
function remember(it) {
  if (!S.learn || S.bgKey !== 'white' || !it.result) return;
  const id = memId(it), h = hiddenFor(it);
  memory = memory.filter((m) => m.id !== id);
  it.result.regions.forEach((r, i) => {
    if (!r.f) return;
    memory.push({ id, f: Array.from(r.f, (v) => Math.round(v * 1000) / 1000), y: h[i], c: h[i] !== (r.f[11] ? 1 : 0) ? 1 : 0 });
  });
  if (memory.length > LEARN_MAX) memory = memory.slice(memory.length - LEARN_MAX);
  saveMemory();
  // Gambar lain yang belum dikoreksi ikut memakai ingatan terbaru.
  for (const x of items) if (x !== it && x.result && !x.toggles.length) predictItem(x);
  if (selected()) renderViewer();
  refreshLearn();
}

// Tebakan per region: -1 = ikut aturan bawaan, 0 = tampil, 1 = dihapus.
function predictItem(it) {
  const res = it.result;
  it.learned = new Int8Array(res.regions.length).fill(-1);
  const others = memory.filter((m) => m.id !== memId(it));
  if (others.length < 5) return;
  const K = 7;
  res.regions.forEach((r, i) => {
    if (!r.f) return;
    const near = [];
    for (const m of others) {
      let d = 0;
      for (let j = 0; j < 12; j++) { const t = m.f[j] - r.f[j]; d += t * t; }
      d = Math.sqrt(d);
      if (near.length < K) near.push([d, m]);
      else if (d < near[K - 1][0]) near[K - 1] = [d, m];
      else continue;
      near.sort((p, q) => p[0] - q[0]);
    }
    if (!near.length || near[0][0] > 0.35) return; // tidak ada contoh yang mirip
    let hide = 0, tot = 0;
    for (const [d, m] of near) {
      if (d > 0.6) continue;
      const wgt = (m.c ? 3 : 1) / (d + 0.05);
      tot += wgt;
      if (m.y) hide += wgt;
    }
    if (!tot) return;
    const p = hide / tot, def = r.f[11] ? 1 : 0;
    const guess = p >= 0.7 ? 1 : p <= 0.3 ? 0 : -1;
    if (guess >= 0 && guess !== def) it.learned[i] = guess;
  });
}
const learnedCount = (it) => (it.learned ? it.learned.reduce((n, v) => n + (v >= 0 ? 1 : 0), 0) : 0);

function refreshLearn() {
  const imgs = new Set(memory.map((m) => m.id)).size;
  const corr = memory.reduce((n, m) => n + m.c, 0);
  $('#learnStat').textContent = memory.length
    ? `${imgs} gambar diingat · ${corr} koreksi Anda · ${memory.length} contoh`
    : 'Belum ada ingatan. Aplikasi mulai belajar setelah Anda mengunduh hasil.';
  $('#forgetBtn').disabled = !memory.length;
}

// ---------------------------------------------------------------- region tersembunyi
// Klik & sembunyikan warna bekerja langsung pada vektor yang sudah ada (instan).
function regionAt(res, sx, sy) {
  const q = res.rmapW / res.srcW;
  const x = Math.max(0, Math.min(res.rmapW - 1, Math.floor(sx * q)));
  const y = Math.max(0, Math.min(res.rmapH - 1, Math.floor(sy * q)));
  return res.rmap[y * res.rmapW + x];
}
function hiddenFor(it) {
  const res = it.result;
  const h = defaultHidden(res);
  if (S.learn && S.bgKey === 'white' && it.learned) it.learned.forEach((v, i) => { if (v >= 0) h[i] = v; });
  res.regions.forEach((r, i) => { if (it.hide.has(r.k)) h[i] = 1; });
  for (const [sx, sy] of it.toggles) {
    const i = regionAt(res, sx, sy);
    if (i >= 0) h[i] ^= 1;
  }
  return h;
}
const visKey = (it) => `${it.id}:${it.key}:${it.toggles.length}:${[...it.hide].join(',')}:${S.learn ? learnedCount(it) : 0}`;
function editsChanged(it) {
  it.outline = null;
  updateRow(it);
  if (it.id === selId) { renderViewer(); hoverRegion = -2; updateHover(); }
}

let waiters = [];
function pendingCount() {
  return items.filter((it) => !isCurrent(it) && !(it.error && it.errKey === keyOf(it))).length;
}
function notifyWaiters() {
  refreshStatus();
  if (pendingCount() === 0) { const w = waiters; waiters = []; w.forEach((f) => f()); }
}
function allDone() {
  return pendingCount() === 0 ? Promise.resolve() : new Promise((r) => waiters.push(r));
}

// ---------------------------------------------------------------- baris antrean
const rowsEl = $('#rows');
const rowEls = new Map();

function createRow(it) {
  const li = document.createElement('li');
  li.className = 'rowi';
  li.dataset.id = it.id;
  li.innerHTML = `
    <span class="idx"></span>
    <span class="thumb"><img alt="" loading="lazy"></span>
    <span class="meta"><span class="oname"></span><span class="sub"></span></span>
    <span class="pal"></span>
    <span class="st"><span class="stt"></span><span class="bar"><b></b></span></span>
    <span class="acts">
      <button type="button" class="icon" data-act="svg" title="Unduh SVG">SVG</button>
      <button type="button" class="icon" data-act="eps" title="Unduh EPS">EPS</button>
      <button type="button" class="icon" data-act="remove" title="Hapus dari antrean"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5"/></svg></button>
    </span>`;
  $('img', li).src = it.url;
  li.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'remove') { e.stopPropagation(); removeItem(it.id); return; }
    if (act === 'svg' || act === 'eps') { e.stopPropagation(); downloadOne(it, act); return; }
    select(it.id);
  });
  rowsEl.appendChild(li);
  rowEls.set(it.id, li);
}

const STATUS_TEXT = { ai: 'Analisis AI', idle: 'Belum diproses', queued: 'Antre', working: 'Memproses', done: 'Selesai', stale: 'Perlu diperbarui', error: 'Gagal' };

function updateRow(it) {
  const li = rowEls.get(it.id);
  if (!li) return;
  const i = items.indexOf(it);
  $('.idx', li).textContent = String(i + 1).padStart(2, '0');
  $('.oname', li).textContent = outName(it.stem, i, S.code, S.start) + extLabel();
  const dims = it.srcW ? `${it.srcW} × ${it.srcH}` : '…';
  const out = it.srcW ? outputSize(it.srcW, it.srcH, S.size, S.customMP) : null;
  $('.sub', li).textContent = `${it.name} · ${dims}${out ? ` → ${fmtInt(out.w)} × ${fmtInt(out.h)}` : ''}`;
  const pal = $('.pal', li);
  pal.innerHTML = '';
  if (it.result) {
    it.result.palette.slice(0, 10).forEach((c, k) => {
      if (it.hide.has(k)) return;
      const s = document.createElement('i');
      s.style.background = hex(it.recolor[k] || c);
      pal.appendChild(s);
    });
  }
  const st = statusOf(it);
  const stEl = $('.st', li);
  stEl.className = 'st ' + st;
  let txt = STATUS_TEXT[st];
  if (st === 'working') txt += ` ${Math.round(it.progress * 100)}%`;
  if (st === 'error') { txt = 'Gagal'; stEl.title = it.error || ''; } else stEl.title = '';
  $('.stt', stEl).textContent = txt;
  $('.bar', stEl).hidden = st !== 'working';
  $('.bar b', stEl).style.width = `${Math.round(it.progress * 100)}%`;
  const ok = !!it.result;
  $('[data-act="svg"]', li).disabled = !ok;
  $('[data-act="eps"]', li).disabled = !ok;
  li.classList.toggle('sel', it.id === selId);
}

function extLabel() {
  return S.format === 'svg' ? '.svg' : S.format === 'eps' ? '.eps' : '.svg / .eps';
}

function refreshAll() {
  items.forEach(updateRow);
  $('#qcount').textContent = String(items.length);
  $('#clearBtn').disabled = !items.length;
  $('#downloadBtn').disabled = !items.length;
  if (!items.length) rowsEl.innerHTML = '';
  refreshName();
  refreshSize();
  refreshStatus();
}

function refreshStatus() {
  const n = items.length;
  const done = items.filter((x) => statusOf(x) === 'done').length;
  const work = items.filter((x) => x.inflight).length;
  const err = items.filter((x) => statusOf(x) === 'error').length;
  const todo = items.filter(needsWork).length;
  const pb = $('#processBtn');
  pb.disabled = !todo || busyDownloading;
  $('#processBtn span').textContent = todo ? `Proses ${todo} gambar` : n ? 'Semua sudah diproses' : 'Proses';
  const parts = [];
  if (!n) parts.push('Belum ada gambar.');
  else {
    parts.push(`${done}/${n} selesai`);
    if (work) parts.push(`${work} diproses`);
    if (err) parts.push(`${err} gagal`);
  }
  if (!busyDownloading) $('#pstatus').textContent = parts.join(' · ');
  $('#qstat').textContent = n ? parts.join(' · ') : '';
}

// ---------------------------------------------------------------- penampil
const stage = $('#stage');
const vOrigWrap = $('#vOrigWrap'), vOrig = $('#vOrig');
const vVec = $('#vVec'), vOut = $('#vOut');
const vLens = $('#vLens'), vLensImg = $('#vLensImg'), vLensOut = $('#vLensOut'), vRing = $('#vRing');
const vSplit = $('#vSplit'), vBusy = $('#vBusy');
const LENS_R = 90;

const V = { z: 1, px: 0, py: 0, mode: 'vector', lens: true, split: 0.5, fitted: false, mx: -1, my: -1, hover: false };
try { const m = localStorage.getItem('vektor.mode'); if (m) V.mode = m; } catch { /* abaikan */ }
// Latar pratinjau (hanya tampilan; tidak memengaruhi hasil atau proses).
const prefersDark = () => window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
try { V.bg = localStorage.getItem('vektor.stagebg') || ''; } catch { V.bg = ''; }
function applyStageBg() {
  const bg = V.bg || (prefersDark() ? 'dark' : 'light');
  stage.classList.toggle('bg-light', bg === 'light');
  stage.classList.toggle('bg-dark', bg === 'dark');
  const b = $('[data-act="bg"]');
  if (b) b.setAttribute('aria-pressed', String(bg === 'light'));
}

const selected = () => items.find((x) => x.id === selId) || null;

function select(id) {
  selId = id;
  V.fitted = false;
  items.forEach(updateRow);
  const it = selected();
  stage.classList.toggle('has-image', !!it);
  if (!it) {
    vOrig.removeAttribute('src');
    vLensImg.removeAttribute('src');
    vVec.innerHTML = vOut.innerHTML = vLensOut.innerHTML = '';
    $('#palette').hidden = true;
    $('#vinfo').textContent = '';
    vBusy.hidden = true;
    return;
  }
  vOrig.src = vLensImg.src = it.url;
  if (it.srcW) fit();
  renderViewer();
  refreshSize();
  refreshName();
}

function fit() {
  const it = selected();
  if (!it || !it.srcW) return;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  V.z = Math.min(sw / it.srcW, sh / it.srcH) * 0.92;
  V.px = (sw - it.srcW * V.z) / 2;
  V.py = (sh - it.srcH * V.z) / 2;
  V.fitted = true;
  applyView();
}

function zoomAt(mx, my, f) {
  const z = Math.max(0.02, Math.min(64, V.z * f));
  V.px = mx - (mx - V.px) * (z / V.z);
  V.py = my - (my - V.py) * (z / V.z);
  V.z = z;
  applyView();
}

function applyView() {
  const it = selected();
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (it && it.srcW) {
    for (const img of [vOrig, vLensImg]) {
      img.width = it.srcW;
      img.height = it.srcH;
      img.style.transform = `translate(${V.px}px, ${V.py}px) scale(${V.z})`;
    }
  }
  const vb = `${-V.px / V.z} ${-V.py / V.z} ${sw / V.z} ${sh / V.z}`;
  for (const s of [vVec, vOut, vLensOut, vHi]) s.setAttribute('viewBox', vb);
  $('#zoomLabel').textContent = `${Math.round(V.z * 100)}%`;
  applyMode();
}

function applyMode() {
  const it = selected();
  const has = !!(it && it.result);
  const sw = stage.clientWidth;
  $$('.vbar .seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === V.mode)));
  $('[data-act="lens"]').setAttribute('aria-pressed', String(V.lens));
  stage.classList.toggle('mode-outline', V.mode === 'outline');

  const x = Math.round(V.split * sw);
  if (!has) {
    vOrigWrap.hidden = false;
    vOrigWrap.style.clipPath = '';
    vVec.style.display = vOut.style.display = 'none';
    vSplit.hidden = true;
  } else if (V.mode === 'compare') {
    vOrigWrap.hidden = false;
    vOrigWrap.style.clipPath = `inset(0 ${sw - x}px 0 0)`;
    vVec.style.display = '';
    vVec.style.clipPath = `inset(0 0 0 ${x}px)`;
    vOut.style.display = 'none';
    vSplit.hidden = false;
    vSplit.style.left = `${x}px`;
  } else {
    vOrigWrap.hidden = true;
    vVec.style.display = '';
    vVec.style.clipPath = '';
    vOut.style.display = V.mode === 'outline' ? '' : 'none';
    vSplit.hidden = true;
    if (V.mode === 'outline') ensureOutline(it, vOut);
  }
  // Lensa piksel: gambar asli + garis vektor di dalam lingkaran.
  const lensOn = has && V.lens && V.mode === 'vector' && V.hover && V.mx >= 0;
  vLens.hidden = vRing.hidden = !lensOn;
  if (lensOn) {
    ensureOutline(it, vLensOut);
    vLens.style.clipPath = `circle(${LENS_R}px at ${V.mx}px ${V.my}px)`;
    vRing.style.left = `${V.mx - LENS_R}px`;
    vRing.style.top = `${V.my - LENS_R}px`;
    vRing.style.width = vRing.style.height = `${LENS_R * 2}px`;
  }
}

function groupTransform(res) {
  return `scale(${res.srcW / res.W} ${res.srcH / res.H})`;
}

function ensureOutline(it, svg) {
  if (!it || !it.result) return;
  if (!it.outline) it.outline = outlineMarkup(it.result, hiddenFor(it));
  if (svg.dataset.for !== visKey(it)) {
    svg.innerHTML = `<g transform="${groupTransform(it.result)}">${it.outline}</g>`;
    svg.dataset.for = visKey(it);
  }
}

function renderViewer() {
  const it = selected();
  if (!it) return;
  if (it.result) {
    const res = it.result;
    const hidden = hiddenFor(it);
    // Kandidat: area putih di dalam gambar (tidak menyentuh tepi) yang masih tampil.
    let cand = '';
    if (S.bgKey === 'white') res.regions.forEach((r, i) => { if (r.f && !r.f[1] && !hidden[i]) cand += regionPathCached(it, i); });
    vVec.innerHTML = `<g transform="${groupTransform(res)}">${previewMarkup(res, { stacking: S.stacking, recolor: it.recolor, hidden, gapFill: S.gapFill })}`
      + (cand ? `<path class="cand" d="${cand}"/>` : '') + '</g>';
    vOut.dataset.for = vLensOut.dataset.for = '';
    const shapes = hidden.reduce((n, h) => n + (h ? 0 : 1), 0);
    const lc = S.learn ? learnedCount(it) : 0;
    $('#vinfo').textContent = `${res.srcW}×${res.srcH} → proses ${res.W}×${res.H} · ${res.palette.length} warna · ${fmtInt(shapes)} bentuk · ${fmtInt(res.nodes)} segmen${res.lines && res.lines.length ? ` · ${fmtInt(res.lines.length)} garis` : ''}${lc ? ` · ${lc} dikoreksi dari ingatan` : ''}`;
    renderPalette(it);
  } else {
    vVec.innerHTML = '';
    $('#vinfo').textContent = it.srcW ? `${it.srcW}×${it.srcH}` : '';
    $('#palette').hidden = true;
  }
  renderBusy();
  applyView();
}

function renderBusy() {
  const it = selected();
  if (!it) { vBusy.hidden = true; return; }
  const st = statusOf(it);
  if (st === 'ai') { vBusy.hidden = false; vBusy.textContent = aiState || 'Menunggu AI…'; }
  else if (st === 'working') { vBusy.hidden = false; vBusy.textContent = `Memproses… ${Math.round(it.progress * 100)}%`; }
  else if (st === 'queued') { vBusy.hidden = false; vBusy.textContent = 'Dalam antrean…'; }
  else if (st === 'idle') { vBusy.hidden = false; vBusy.textContent = 'Atur pengaturan bila perlu, lalu klik Proses.'; }
  else if (st === 'stale') { vBusy.hidden = false; vBusy.textContent = 'Pengaturan berubah — klik Proses untuk memperbarui. (Pratinjau: hasil sebelumnya)'; }
  else if (st === 'error') { vBusy.hidden = false; vBusy.textContent = `Gagal: ${it.error}`; }
  else vBusy.hidden = true;
}

// Palet per gambar: ganti warna atau jadikan transparan.
const picker = $('#colorPick');
let pickTarget = null;
function renderPalette(it) {
  const box = $('#swatches');
  box.innerHTML = '';
  it.result.palette.forEach((c, k) => {
    const cur = it.recolor[k] || c;
    const off = it.hide.has(k);
    const el = document.createElement('span');
    el.className = 'sw' + (off ? ' off' : '') + (it.recolor[k] ? ' changed' : '');
    el.innerHTML = `<button type="button" class="chip" title="Ganti warna"></button><span>${hex(cur).toUpperCase()}</span>`
      + (it.recolor[k] ? '<button type="button" class="x" data-a="reset" title="Kembalikan warna asli">↺</button>' : '')
      + `<button type="button" class="x" data-a="hide" title="${off ? 'Tampilkan lagi' : 'Jadikan transparan'}">${off ? '+' : '×'}</button>`;
    $('.chip', el).style.background = hex(cur);
    if (it.result.whiteIdx[k]) el.title = 'Termasuk putih (latar)';
    el.addEventListener('click', (e) => {
      const a = e.target.closest('button');
      if (!a) return;
      if (a.dataset.a === 'hide') {
        if (it.hide.has(k)) it.hide.delete(k); else it.hide.add(k);
        editsChanged(it);
      } else if (a.dataset.a === 'reset') {
        delete it.recolor[k];
        renderViewer();
        updateRow(it);
      } else {
        pickTarget = { it, k };
        picker.value = hex(cur);
        picker.click();
      }
    });
    box.appendChild(el);
  });
  $('#palette').hidden = false;
  $('#undoClick').disabled = !it.toggles.length;
  $('#redoClick').disabled = !it.redo.length;
  $('#resetClicks').disabled = !it.toggles.length;
}
function undoClick() {
  const it = selected();
  if (!it || !it.toggles.length) return;
  it.redo.push(it.toggles[it.toggles.length - 1]);
  it.toggles = it.toggles.slice(0, -1);
  editsChanged(it);
}
function redoClick() {
  const it = selected();
  if (!it || !it.redo.length) return;
  it.toggles = [...it.toggles, it.redo.pop()];
  editsChanged(it);
}
$('#undoClick').addEventListener('click', undoClick);
$('#redoClick').addEventListener('click', redoClick);
$('#resetClicks').addEventListener('click', () => {
  const it = selected();
  if (!it) return;
  it.toggles = [];
  it.redo = [];
  editsChanged(it);
});
let pickRaf = 0;
picker.addEventListener('input', () => {
  if (!pickTarget) return;
  const v = picker.value;
  pickTarget.it.recolor[pickTarget.k] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  cancelAnimationFrame(pickRaf);
  pickRaf = requestAnimationFrame(() => { if (pickTarget.it.id === selId) renderViewer(); updateRow(pickTarget.it); });
});

// Interaksi penampil.
let drag = null;
stage.addEventListener('pointerdown', (e) => {
  if (!selected()) return;
  stage.focus({ preventScroll: true });
  const onSplit = !vSplit.hidden && e.target.closest('#vSplit');
  drag = { x: e.clientX, y: e.clientY, px: V.px, py: V.py, split: onSplit };
  stage.setPointerCapture(e.pointerId);
  if (!onSplit) stage.classList.add('dragging');
});
stage.addEventListener('pointermove', (e) => {
  const r = stage.getBoundingClientRect();
  V.mx = e.clientX - r.left;
  V.my = e.clientY - r.top;
  V.hover = true;
  if (drag) {
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
    if (drag.split) V.split = Math.max(0, Math.min(1, V.mx / r.width));
    else { V.px = drag.px + (e.clientX - drag.x); V.py = drag.py + (e.clientY - drag.y); }
    applyView();
  } else {
    if (V.mode === 'vector' && V.lens) applyMode();
    updateHover();
  }
});

// Sorot bentuk di bawah kursor (seperti vectorizer.ai); klik = hapus/kembalikan.
const vHi = $('#vHi');
function regionPathCached(it, i) {
  let d = it.paths.get(i);
  if (!d) { d = regionPath(it.result, i); it.paths.set(i, d); }
  return d;
}
let hoverRegion = -2;
function pointRegion() {
  const it = selected();
  if (!it || !it.result || !V.hover || V.mx < 0) return -1;
  if (V.mode === 'compare' && V.mx < V.split * stage.clientWidth) return -1;
  const sx = (V.mx - V.px) / V.z, sy = (V.my - V.py) / V.z;
  if (sx < 0 || sy < 0 || sx >= it.result.srcW || sy >= it.result.srcH) return -1;
  return regionAt(it.result, sx, sy);
}
function updateHover() {
  const it = selected();
  const i = drag ? -1 : pointRegion();
  if (i === hoverRegion) return;
  hoverRegion = i;
  stage.classList.toggle('pick', i >= 0);
  if (i < 0) { vHi.innerHTML = ''; return; }
  const d = regionPathCached(it, i);
  vHi.innerHTML = `<g transform="${groupTransform(it.result)}"><path d="${d}"/></g>`;
}
const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
// Klik tanpa geser = hapus/kembalikan region di titik itu (seperti koreksi latar vectorizer.ai).
stage.addEventListener('pointerup', (e) => {
  const d = drag;
  endDrag();
  const it = selected();
  if (!d || d.moved || d.split || e.button !== 0 || !it || !it.result || !it.srcW) return;
  const r = stage.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  if (V.mode === 'compare' && mx < V.split * r.width) return; // sisi "Asli"
  const sx = (mx - V.px) / V.z, sy = (my - V.py) / V.z;
  if (sx < 0 || sy < 0 || sx >= it.srcW || sy >= it.srcH) return;
  if (regionAt(it.result, sx, sy) < 0) return;
  it.toggles = [...it.toggles, [sx, sy]];
  it.redo = [];
  editsChanged(it);
});
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('pointerleave', () => { V.hover = false; if (!drag) { applyMode(); updateHover(); } });
stage.addEventListener('wheel', (e) => {
  if (!selected()) return;
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
}, { passive: false });
new ResizeObserver(() => { if (V.fitted) fit(); else applyView(); }).observe(stage);

$$('.vbar .seg button').forEach((b) => b.addEventListener('click', () => {
  V.mode = b.dataset.mode;
  try { localStorage.setItem('vektor.mode', V.mode); } catch { /* abaikan */ }
  applyMode();
}));
function toolAct(act) {
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (act === 'zoomin') zoomAt(sw / 2, sh / 2, 1.5);
  else if (act === 'zoomout') zoomAt(sw / 2, sh / 2, 1 / 1.5);
  else if (act === 'fit') fit();
  else if (act === 'one') { V.fitted = false; zoomAt(sw / 2, sh / 2, 1 / V.z); }
  else if (act === 'lens') { V.lens = !V.lens; applyMode(); }
  else if (act === 'bg') {
    V.bg = (V.bg || (prefersDark() ? 'dark' : 'light')) === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('vektor.stagebg', V.bg); } catch { /* abaikan */ }
    applyStageBg();
    return;
  }
  if (act !== 'fit' && act !== 'lens') V.fitted = false;
}
$$('.tools [data-act]').forEach((b) => b.addEventListener('click', () => toolAct(b.dataset.act)));
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redoClick(); else undoClick();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redoClick(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const map = { '+': 'zoomin', '=': 'zoomin', '-': 'zoomout', '0': 'fit', '1': 'one', l: 'lens', L: 'lens', b: 'bg', B: 'bg' };
  if (map[e.key] && selected()) { toolAct(map[e.key]); e.preventDefault(); }
  const modes = { c: 'compare', v: 'vector', o: 'outline' };
  if (modes[e.key] && selected()) { V.mode = modes[e.key]; applyMode(); }
});

// ---------------------------------------------------------------- panel
function bindSettings() {
  $$('.panel .seg[data-opt], .chips[data-opt]').forEach((seg) => {
    const opt = seg.dataset.opt;
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const raw = b.dataset.v;
      S[opt] = typeof DEFAULTS[opt] === 'number' ? Number(raw) : raw;
      changed(opt);
    });
  });
  $$('.panel input[type="range"][data-opt]').forEach((el) => {
    el.addEventListener('input', () => { S[el.dataset.opt] = Number(el.value); changed(el.dataset.opt); });
  });
  $$('.panel input[type="checkbox"][data-opt]').forEach((el) => {
    el.addEventListener('change', () => { S[el.dataset.opt] = el.checked; changed(el.dataset.opt); });
  });
  $('#maxColors').addEventListener('change', (e) => {
    S.maxColors = Math.max(2, Math.min(64, Math.round(Number(e.target.value) || 12)));
    changed('maxColors');
  });
  $('#customMP').addEventListener('input', (e) => {
    S.customMP = Math.max(15, Number(e.target.value) || 15);
    changed('customMP');
  });
  $('#code').addEventListener('input', (e) => { S.code = e.target.value; changed('code'); });
  $('#start').addEventListener('input', (e) => { S.start = Math.max(0, Math.round(Number(e.target.value) || 0)); changed('start'); });
  $$('input[name="format"]').forEach((el) => el.addEventListener('change', () => { S.format = el.value; changed('format'); }));
}

const LABELS = {
  colorMerge: (v) => `ΔE ${v}`,
  smooth: (v) => `${Number(v).toFixed(2)} px`,
  minArea: (v) => `${v} px²`,
  corner: (v) => `${v}°`,
  whiteTol: (v) => `ΔE ${v}`,
  silThreshold: (v) => `${v}`,
  keyTol: (v) => `${v}%`,
  gradColors: (v) => `${v} warna`,
};

function syncControls() {
  $$('.panel .seg[data-opt], .chips[data-opt]').forEach((seg) => {
    const v = String(S[seg.dataset.opt]);
    $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  });
  $$('.panel input[type="range"][data-opt]').forEach((el) => {
    el.value = S[el.dataset.opt];
    const out = $(`output[for="${el.id}"]`);
    if (out) out.textContent = LABELS[el.dataset.opt](S[el.dataset.opt]);
  });
  $$('.panel input[type="checkbox"][data-opt]').forEach((el) => { el.checked = !!S[el.dataset.opt]; });
  $('#maxColors').value = S.maxColors;
  $('#maxColors').disabled = !!S.colorAuto;
  $('#customMP').value = S.customMP;
  $('#customField').hidden = S.size !== 'custom';
  $('#code').value = S.code;
  $('#start').value = S.start;
  $$('input[name="format"]').forEach((el) => { el.checked = el.value === S.format; });
  $('#stackNote').textContent = S.stacking === 'stacked'
    ? 'Bentuk ditumpuk dari belakang ke depan — tanpa retak di bentuk bersarang, mudah diedit.'
    : 'Bentuk saling memotong tanpa tumpang tindih — cocok untuk cutting plotter dan sablon.';
  const keys = [S.mode, `${S.mode}:${S.silTones}`];
  $$('[data-show], [data-bg]').forEach((el) => {
    const okMode = !el.dataset.show || el.dataset.show.split(' ').some((t) => keys.includes(t));
    const okBg = !el.dataset.bg || el.dataset.bg === S.bgKey;
    el.hidden = !(okMode && okBg);
  });
  $('#cavityNote').textContent = {
    smart: 'Eksperimental: juga menebak putih terkurung yang termasuk latar. Bisa keliru — periksa hasilnya.',
    transparent: 'Semua putih menjadi transparan, termasuk di dalam objek (bisa dikembalikan dengan klik).',
    fill: 'Siluet padat: rongga di dalam objek diisi warna siluet.',
    white: 'Hanya putih luar yang dihapus; putih di dalam (garis putus-putus) klik untuk menghapus.',
  }[S.cavity] || '';
  $('#whiteNote').textContent = {
    off: 'Latar putih dipertahankan.',
    outer: 'Hanya putih yang tersambung ke tepi gambar. Putih di dalam (garis putus-putus) klik untuk menghapus.',
    ai: 'Putih luar + putih di dalam yang dinilai latar oleh AI (model 44 MB, diunduh sekali; ±10 dtk per gambar). Khusus ilustrasi berwarna.',
    smart: 'Eksperimental: juga menebak putih terkurung yang termasuk latar. Bisa keliru — periksa hasilnya.',
    all: 'Semua area putih, termasuk di dalam objek.',
  }[S.whiteMode] || '';
}

function changed(opt) {
  saveSettings();
  syncControls();
  if (PROC.includes(opt)) {
    items.forEach(updateRow);
    renderBusy();
    refreshStatus();
    return;
  }
  if (opt === 'stacking' || opt === 'learn' || opt === 'gapFill') { items.forEach((it) => { it.outline = null; }); renderViewer(); }
  items.forEach(updateRow);
  refreshName();
  refreshSize();
}

function refreshSize() {
  const el = $('#sizeReadout');
  const it = selected() || items[0];
  if (!it || !it.srcW) {
    const ex = outputSize(4, 3, S.size === 'orig' ? '15' : S.size, S.customMP);
    el.innerHTML = S.size === 'orig' ? 'Mengikuti ukuran asli tiap gambar.' : `<b>${fmtMP(ex.w, ex.h)} MP</b> · contoh 4:3 → ${fmtInt(ex.w)} × ${fmtInt(ex.h)} px`;
    return;
  }
  const o = outputSize(it.srcW, it.srcH, S.size, S.customMP);
  const low = o.w * o.h < 15e6;
  el.innerHTML = `<b>${fmtMP(o.w, o.h)} MP</b> (${fmtInt(o.w)} × ${fmtInt(o.h)} px)`
    + (low ? ' <span class="warn">· di bawah 15 MP</span>' : '');
}

function refreshName() {
  const el = $('#nameExample');
  const it = items[0];
  const stem = it ? it.stem : 'nama_file';
  const ext = S.format === 'eps' ? '.eps' : '.svg';
  if (!S.code.trim()) el.innerHTML = `Belum ada kode — file memakai nama asli: <b>${esc(stem + ext)}</b>`;
  else el.innerHTML = `Contoh hasil: <b>${esc(outName(stem, 0, S.code, S.start) + ext)}</b>`;
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------------------------------------------------------------- unduh
function exportOpts(it) {
  return {
    size: outputSize(it.srcW || it.result.srcW, it.srcH || it.result.srcH, S.size, S.customMP),
    stacking: S.stacking,
    gapFill: S.gapFill,
    gapWidth: GAP_WIDTH,
    recolor: it.recolor,
    hidden: hiddenFor(it),
  };
}

function downloadOne(it, kind) {
  if (!it.result) return;
  const i = items.indexOf(it);
  const base = outName(it.stem, i, S.code, S.start);
  const o = exportOpts(it);
  const data = kind === 'svg' ? buildSVG(it.result, o) : buildEPS(it.result, o, base);
  remember(it);
  saveBlob(new Blob([data], { type: kind === 'svg' ? 'image/svg+xml' : 'application/postscript' }), `${base}.${kind}`);
}

let busyDownloading = false;
async function downloadAll() {
  if (!items.length || busyDownloading) return;
  busyDownloading = true;
  const btn = $('#downloadBtn');
  const st = $('#pstatus');
  btn.disabled = true;
  try {
    if (items.some(needsWork)) processAll();
    if (pendingCount()) {
      st.textContent = 'Menunggu semua gambar selesai diproses…';
      await allDone();
    }
    const files = [];
    const used = new Set();
    const both = S.format === 'both';
    let skipped = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!isCurrent(it)) { skipped++; continue; }
      let base = outName(it.stem, i, S.code, S.start);
      let n = 2;
      while (used.has(base)) base = `${outName(it.stem, i, S.code, S.start)}-${n++}`;
      used.add(base);
      const o = exportOpts(it);
      if (S.format !== 'eps') files.push({ name: (both ? 'SVG/' : '') + base + '.svg', data: buildSVG(it.result, o) });
      if (S.format !== 'svg') files.push({ name: (both ? 'EPS/' : '') + base + '.eps', data: buildEPS(it.result, o, base) });
      remember(it);
      st.textContent = `Menyusun file ${i + 1}/${items.length}…`;
      await new Promise((r) => setTimeout(r, 0));
    }
    if (!files.length) { st.textContent = 'Tidak ada gambar yang berhasil diproses.'; return; }
    const zip = await makeZip(files, (p) => { st.textContent = `Mengompres ZIP ${Math.round(p * 100)}%`; });
    const tag = S.format === 'both' ? 'svg-eps' : S.format;
    const stamp = new Date().toISOString().slice(0, 10);
    saveBlob(zip, `${S.code.trim() ? S.code.trim() + '_' : ''}vektor_${tag}_${stamp}.zip`);
    st.textContent = `Selesai · ${files.length} file${skipped ? ` · ${skipped} gambar gagal dilewati` : ''}`;
  } finally {
    busyDownloading = false;
    btn.disabled = !items.length;
  }
}

// ---------------------------------------------------------------- input file
$('#addBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('#clearBtn').addEventListener('click', () => {
  for (const it of [...items]) removeItem(it.id);
});
$('#downloadBtn').addEventListener('click', downloadAll);
$('#processBtn').addEventListener('click', processAll);
$('#forgetBtn').addEventListener('click', () => {
  if (!confirm('Hapus semua yang sudah dipelajari dari unduhan Anda?')) return;
  memory = [];
  saveMemory();
  for (const it of items) if (it.result) predictItem(it);
  items.forEach((it) => { it.outline = null; });
  renderViewer();
  refreshLearn();
});

const veil = $('#dropveil');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; veil.hidden = false; });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; veil.hidden = true; } });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  veil.hidden = true;
  addFiles(e.dataTransfer.files);
});
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files);
});

// ---------------------------------------------------------------- mulai
bindSettings();
applyStageBg();
syncControls();
refreshLearn();
refreshAll();
applyView();
