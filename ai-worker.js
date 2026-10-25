/*
 * Vektor — pemisah objek/latar berbasis AI (Web Worker, modul).
 * Model: ISNet varian ilustrasi/anime (Apache-2.0), dikuantisasi 8-bit.
 * Mesin: onnxruntime-web (MIT), backend WASM. Model diunduh sekali lalu
 * disimpan di Cache Storage browser.
 */
import * as ort from './vendor/ort/ort.wasm.min.mjs';

const MODEL_URL = new URL('./models/isnet-anime-int8.onnx', import.meta.url).href;
const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];

ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

let sessionP = null;

async function fetchModel(progress) {
  let cache = null;
  try { cache = await caches.open('vektor-ai-v1'); } catch { /* Cache Storage tidak tersedia */ }
  const hit = cache && (await cache.match(MODEL_URL));
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Model AI gagal diunduh (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 44e6;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    progress({ stage: 'download', got, total });
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  if (cache) { try { await cache.put(MODEL_URL, new Response(buf.slice())); } catch { /* kuota penuh */ } }
  return buf;
}

function session(progress) {
  if (!sessionP) {
    sessionP = (async () => {
      const buf = await fetchModel(progress);
      progress({ stage: 'init' });
      return ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    })();
    sessionP.catch(() => { sessionP = null; });
  }
  return sessionP;
}

// Peta keyakinan "objek" 1024×1024 (0 = latar, 255 = objek) untuk satu gambar.
self.onmessage = async (e) => {
  const { id, file } = e.data;
  const progress = (p) => self.postMessage({ id, type: 'progress', ...p });
  try {
    const s = await session(progress);
    progress({ stage: 'run' });
    const bmp = await createImageBitmap(file);
    const c = new OffscreenCanvas(SIZE, SIZE);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.fillRect(0, 0, SIZE, SIZE);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, SIZE, SIZE);
    bmp.close();
    const px = g.getImageData(0, 0, SIZE, SIZE).data;
    const N = SIZE * SIZE;
    let mx = 1;
    for (let i = 0; i < px.length; i++) if ((i & 3) !== 3 && px[i] > mx) mx = px[i];
    const x = new Float32Array(3 * N);
    for (let i = 0; i < N; i++) {
      for (let ch = 0; ch < 3; ch++) x[ch * N + i] = px[i * 4 + ch] / mx - MEAN[ch];
    }
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, SIZE, SIZE]) });
    const y = out[s.outputNames[0]].data;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N; i++) { const v = y[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const mask = new Uint8Array(N);
    const k = 255 / (hi - lo || 1);
    for (let i = 0; i < N; i++) mask[i] = (y[i] - lo) * k;
    self.postMessage({ id, type: 'done', mask }, [mask.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
