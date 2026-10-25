/*
 * Vektor — mesin tracing (Web Worker).
 *
 * Alur:
 *  1. Palet dari piksel "rata" (piksel transisi/antialias diabaikan) → warna bersih.
 *  2. Upscale (default 4×) dengan interpolasi halus.
 *  3. Label: piksel yang jelas cocok dengan palet jadi benih; piksel transisi
 *     dibagi ke warna tetangga terdekat (region growing) → batas jatuh di titik
 *     50% antar warna = presisi sub-piksel.
 *  4. Bersihkan bintik kecil, buang putih luar (dan opsional putih dalam).
 *  5. Telusuri batas pada kisi sudut piksel. Batas antar dua region dipecah
 *     menjadi rantai di titik pertemuan ≥3 region; tiap rantai di-fit SEKALI dan
 *     dipakai bersama oleh kedua sisi → tanpa celah, tanpa tumpang tindih.
 *  6. Fitting: deteksi sudut, garis lurus, Bézier kubik (Schneider), elips utuh.
 */
'use strict';

const T = 255; // label transparan
const U = 254; // belum ditetapkan

// ---------------------------------------------------------------- warna
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
function rgb2lab(r, g, b, out, o = 0) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const fx = labF((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const fy = labF(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const fz = labF((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
  return out;
}
const tmpLab = new Float32Array(3);

// ---------------------------------------------------------------- pesan
self.onmessage = async (e) => {
  const { id, file, opts } = e.data;
  const progress = (p, stage) => self.postMessage({ id, type: 'progress', p, stage });
  try {
    const result = await vectorize(file, opts, progress);
    const transfer = [];
    for (const ch of result.chains) transfer.push(ch.p.buffer, ch.c.buffer);
    self.postMessage({ id, type: 'done', result }, transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};

// ---------------------------------------------------------------- utama
async function vectorize(file, o, progress) {
  const bmp = await createImageBitmap(file);
  const sw = bmp.width, sh = bmp.height;

  const c0 = new OffscreenCanvas(sw, sh);
  const g0 = c0.getContext('2d', { willReadFrequently: true });
  g0.drawImage(bmp, 0, 0);
  const src = g0.getImageData(0, 0, sw, sh).data;

  const pal = buildPalette(src, sw, sh, o);
  progress(0.08, 'palet');

  // Upscale — dibatasi total piksel kerja agar memori aman.
  let s = Math.min(o.upscale, Math.sqrt(o.maxWorkPixels / (sw * sh)));
  const W = Math.max(1, Math.round(sw * s));
  const H = Math.max(1, Math.round(sh * s));
  s = W / sw;
  let data;
  if (W === sw && H === sh) {
    data = src;
  } else {
    const c1 = new OffscreenCanvas(W, H);
    const g1 = c1.getContext('2d', { willReadFrequently: true });
    g1.imageSmoothingEnabled = true;
    g1.imageSmoothingQuality = 'high';
    g1.drawImage(bmp, 0, 0, W, H);
    data = g1.getImageData(0, 0, W, H).data;
  }
  bmp.close();
  progress(0.15, 'upscale');

  const N = W * H;
  const lab = assignLabels(data, W, H, s, pal, o);
  progress(0.35, 'label');

  // Warna yang disembunyikan pengguna → transparan.
  if (o.hide && o.hide.length) {
    const hid = new Uint8Array(256);
    for (const k of o.hide) hid[k] = 1;
    for (let i = 0; i < N; i++) if (hid[lab[i]]) lab[i] = T;
  }

  const order = new Int32Array(N);
  const comp = new Int32Array(N);
  const minA = Math.max(1, Math.round(o.minArea * s * s));
  despeckle(lab, W, H, minA, comp, order, pal);
  progress(0.45, 'bersih');

  // Putih → transparan.
  const isWhite = new Uint8Array(256);
  pal.forEach((p, k) => {
    const d = Math.hypot(p.L - 100, p.A, p.B);
    if (d <= o.whiteTol) isWhite[k] = 1;
  });
  isWhite[T] = 1;
  const mode = o.whiteMode || 'smart';
  if (mode === 'all') {
    for (let i = 0; i < N; i++) if (isWhite[lab[i]]) lab[i] = T;
  } else if (mode !== 'off') {
    floodBorder(lab, W, H, isWhite, order, Math.max(1, Math.round((o.gapClose ?? 1.5) * s)));
  }

  // Komponen; tentukan region yang dihapus (putih latar terkurung + klik manual).
  let info = label(lab, W, H, comp, order);
  const removed = new Uint8Array(info.count);
  if (mode === 'smart') smartWhite(lab, W, comp, order, info, isWhite, removed, pal);
  for (const [px, py] of o.toggles || []) {
    const x = Math.max(0, Math.min(W - 1, Math.floor(px * s)));
    const y = Math.max(0, Math.min(H - 1, Math.floor(py * s)));
    const c = comp[y * W + x];
    if (info.lbl[c] !== T) removed[c] ^= 1;
  }
  let anyRemoved = false;
  for (let c = 0; c < info.count; c++) {
    if (!removed[c]) continue;
    anyRemoved = true;
    for (let h = info.start[c], e = h + info.size[c]; h < e; h++) lab[order[h]] = T;
  }
  if (anyRemoved) info = label(lab, W, H, comp, order);
  progress(0.55, 'region');

  const out = traceAll(lab, comp, info, W, H, s, o, (p) => progress(0.55 + p * 0.43, 'kurva'));

  return {
    srcW: sw,
    srcH: sh,
    W,
    H,
    scale: s,
    palette: pal.map((p) => [p.r, p.g, p.b]),
    whiteIdx: pal.map((_, k) => !!isWhite[k]),
    chains: out.chains,
    regions: out.regions,
    nodes: out.nodes,
  };
}

// ---------------------------------------------------------------- palet
function buildPalette(px, w, h, o) {
  const cnt = new Float64Array(32768);
  const sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
  const acnt = new Float64Array(32768);
  const ar = new Float64Array(32768), ag = new Float64Array(32768), ab = new Float64Array(32768);
  const FT = 36;
  let flat = 0, all = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      const a = px[p + 3];
      if (a < 128) continue;
      let r = px[p], g = px[p + 1], b = px[p + 2];
      if (a < 255) {
        const k = a / 255;
        r = Math.round(r * k + 255 * (1 - k));
        g = Math.round(g * k + 255 * (1 - k));
        b = Math.round(b * k + 255 * (1 - k));
      }
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      acnt[key]++; ar[key] += r; ag[key] += g; ab[key] += b; all++;

      let isFlat = true;
      if (x > 0) isFlat = isFlat && diff(px, p, p - 4) <= FT;
      if (x < w - 1) isFlat = isFlat && diff(px, p, p + 4) <= FT;
      if (y > 0) isFlat = isFlat && diff(px, p, p - w * 4) <= FT;
      if (y < h - 1) isFlat = isFlat && diff(px, p, p + w * 4) <= FT;
      if (isFlat) { cnt[key]++; sr[key] += r; sg[key] += g; sb[key] += b; flat++; }
    }
  }
  // Gambar foto/gradien penuh: tidak cukup piksel rata → pakai semua.
  let C = cnt, R = sr, G = sg, B = sb, total = flat;
  if (flat < all * 0.15) { C = acnt; R = ar; G = ag; B = ab; total = all; }
  if (total === 0) return [{ r: 255, g: 255, b: 255, L: 100, A: 0, B: 0, n: 1 }];

  const bins = [];
  for (let k = 0; k < 32768; k++) if (C[k] > 0) bins.push(k);
  bins.sort((a, b) => C[b] - C[a]);
  const bl = new Float32Array(32768 * 3);
  for (const k of bins) rgb2lab(Math.round(R[k] / C[k]), Math.round(G[k] / C[k]), Math.round(B[k] / C[k]), bl, k * 3);

  const md = o.colorMerge;
  let cl = [];
  for (const k of bins) {
    const L = bl[k * 3], A = bl[k * 3 + 1], Bb = bl[k * 3 + 2];
    let best = -1, bd = Infinity;
    for (let j = 0; j < cl.length; j++) {
      const c = cl[j];
      const d = (c.L / c.n - L) ** 2 + (c.A / c.n - A) ** 2 + (c.B / c.n - Bb) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    const n = C[k];
    if (best >= 0 && Math.sqrt(bd) < md) {
      const c = cl[best];
      c.n += n; c.L += L * n; c.A += A * n; c.B += Bb * n; c.r += R[k]; c.g += G[k]; c.b += B[k];
    } else {
      cl.push({ n, L: L * n, A: A * n, B: Bb * n, r: R[k], g: G[k], b: B[k] });
    }
  }
  const minN = Math.max(6, total * 0.00004);
  cl = cl.filter((c) => c.n >= minN);
  if (!cl.length) cl = [{ n: 1, L: 100, A: 0, B: 0, r: 255, g: 255, b: 255 }];

  // Normalisasi ke pusat.
  let P = cl.map((c) => ({ n: c.n, L: c.L / c.n, A: c.A / c.n, B: c.B / c.n, r: c.r / c.n, g: c.g / c.n, b: c.b / c.n }));

  // Penyempurnaan k-means atas bin.
  for (let it = 0; it < 4; it++) {
    const acc = P.map(() => ({ n: 0, L: 0, A: 0, B: 0, r: 0, g: 0, b: 0 }));
    for (const k of bins) {
      const L = bl[k * 3], A = bl[k * 3 + 1], Bb = bl[k * 3 + 2];
      let best = 0, bd = Infinity;
      for (let j = 0; j < P.length; j++) {
        const d = (P[j].L - L) ** 2 + (P[j].A - A) ** 2 + (P[j].B - Bb) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      if (Math.sqrt(bd) > md * 2.5) continue; // bin pencilan tidak menggeser pusat
      const a = acc[best], n = C[k];
      a.n += n; a.L += L * n; a.A += A * n; a.B += Bb * n; a.r += R[k]; a.g += G[k]; a.b += B[k];
    }
    P = acc.filter((a) => a.n > 0).map((a) => ({ n: a.n, L: a.L / a.n, A: a.A / a.n, B: a.B / a.n, r: a.r / a.n, g: a.g / a.n, b: a.b / a.n }));
  }

  // Gabungkan warna yang terlalu mirip, lalu batasi jumlah warna (Ward).
  const maxC = o.maxColors > 0 ? o.maxColors : 64;
  for (;;) {
    let wi = -1, wj = -1, wc = Infinity; // pasangan Ward termurah
    let mi = -1, mj = -1, mdist = Infinity; // pasangan terdekat
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const d2 = (P[i].L - P[j].L) ** 2 + (P[i].A - P[j].A) ** 2 + (P[i].B - P[j].B) ** 2;
        const cost = (d2 * P[i].n * P[j].n) / (P[i].n + P[j].n);
        if (cost < wc) { wc = cost; wi = i; wj = j; }
        if (d2 < mdist) { mdist = d2; mi = i; mj = j; }
      }
    }
    // Varian minor: warna kecil yang cukup dekat dengan warna dominan
    // (mis. tepi garis tipis yang lebih gelap akibat kompresi) ikut dilebur.
    let vi = -1, vj = -1, vd = Infinity;
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const ratio = Math.min(P[i].n, P[j].n) / Math.max(P[i].n, P[j].n);
        if (ratio > 0.2) continue;
        const d = Math.sqrt((P[i].L - P[j].L) ** 2 + (P[i].A - P[j].A) ** 2 + (P[i].B - P[j].B) ** 2);
        if (d < md * 1.6 && d < vd) { vd = d; vi = i; vj = j; }
      }
    }
    let a, b;
    if (mi >= 0 && Math.sqrt(mdist) < md * 0.8) { a = mi; b = mj; }
    else if (vi >= 0) { a = vi; b = vj; }
    else if (P.length > maxC && wi >= 0) { a = wi; b = wj; }
    else break;
    const p = P[a], q = P[b], n = p.n + q.n;
    P[a] = {
      n,
      L: (p.L * p.n + q.L * q.n) / n, A: (p.A * p.n + q.A * q.n) / n, B: (p.B * p.n + q.B * q.n) / n,
      r: (p.r * p.n + q.r * q.n) / n, g: (p.g * p.n + q.g * q.n) / n, b: (p.b * p.n + q.b * q.n) / n,
    };
    P.splice(b, 1);
  }

  // Urutkan dari paling dominan; warna final dari rata-rata RGB, Lab dihitung ulang.
  P.sort((a, b) => b.n - a.n);
  return P.slice(0, 250).map((p) => {
    const r = clamp255(p.r), g = clamp255(p.g), b = clamp255(p.b);
    rgb2lab(r, g, b, tmpLab);
    return { r, g, b, L: tmpLab[0], A: tmpLab[1], B: tmpLab[2], n: p.n };
  });
}
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
function diff(px, a, b) {
  return Math.abs(px[a] - px[b]) + Math.abs(px[a + 1] - px[b + 1]) + Math.abs(px[a + 2] - px[b + 2]);
}

// ---------------------------------------------------------------- label
function assignLabels(data, W, H, s, pal, o) {
  const N = W * H;
  const K = pal.length;
  const pl = new Float32Array(K * 3);
  pal.forEach((p, k) => { pl[k * 3] = p.L; pl[k * 3 + 1] = p.A; pl[k * 3 + 2] = p.B; });

  // Cache warna terdekat (dan jarak ke kandidat kedua) pada kisi 6 bit per kanal.
  const cIdx = new Int16Array(262144).fill(-1);
  const cD1 = new Float32Array(262144), cD2 = new Float32Array(262144);
  let nD1 = 0, nD2 = 0;
  const nearest = (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    if (cIdx[key] < 0) {
      rgb2lab((r & 252) + 2, (g & 252) + 2, (b & 252) + 2, tmpLab);
      let best = 0, bd = Infinity, sd = Infinity;
      for (let k = 0; k < K; k++) {
        const d = (pl[k * 3] - tmpLab[0]) ** 2 + (pl[k * 3 + 1] - tmpLab[1]) ** 2 + (pl[k * 3 + 2] - tmpLab[2]) ** 2;
        if (d < bd) { sd = bd; bd = d; best = k; } else if (d < sd) sd = d;
      }
      cIdx[key] = best; cD1[key] = Math.sqrt(bd); cD2[key] = Math.sqrt(sd);
    }
    nD1 = cD1[key]; nD2 = cD2[key];
    return cIdx[key];
  };

  // Komposit atas putih → RGB kerja (ditulis di tempat).
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const a = data[p + 3];
    if (a < 255 && a >= 128) {
      const k = a / 255;
      data[p] = data[p] * k + 255 * (1 - k);
      data[p + 1] = data[p + 1] * k + 255 * (1 - k);
      data[p + 2] = data[p + 2] * k + 255 * (1 - k);
    }
  }

  // Benih = piksel yang warnanya dekat palet DAN tidak berada di lereng gradien.
  // Lereng diukur dengan selisih tengah (x-1 vs x+1, y-1 vs y+1): piksel campuran
  // di tepi dua warna punya selisih besar, sedangkan inti garis tipis (puncak)
  // dan area rata punya selisih kecil.
  // Upscale bilinear browser patah di tiap pusat piksel sumber → kontur 50%
  // ikut bergelombang. Blur binomial ringan menghaluskan lipatan itu tanpa
  // menggeser tepi lurus.
  if (s >= 1.5) {
    const passes = Math.max(1, Math.round((0.32 * s) ** 2));
    for (let k = 0; k < passes; k++) blurPass(data, W, H);
  }

  const lab = new Uint8Array(N);
  const FTW = Math.max(14, 40 / s);
  const CT = FTW * 1.5;
  const tight = 4;
  const loose = Math.max(8, o.colorMerge * 1.2);
  const W4 = W * 4;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, p = i * 4;
      if (data[p + 3] < 128) { lab[i] = T; continue; }
      const k = nearest(data[p], data[p + 1], data[p + 2]);
      const d = nD1;
      if (d <= tight && s < 1.5) { lab[i] = k; continue; }
      // Dekat palet, atau jelas lebih dekat ke satu warna daripada warna lain
      // (inti garis tipis yang warnanya sedikit bergeser).
      if (d <= loose || d < nD2 * 0.45) {
        const cx = x > 0 && x < W - 1 ? diff(data, p - 4, p + 4) : 0;
        const cy = y > 0 && y < H - 1 ? diff(data, p - W4, p + W4) : 0;
        const lim = d <= tight ? CT * 2 : CT;
        if (cx <= lim && cy <= lim) { lab[i] = k; continue; }
      }
      lab[i] = U;
    }
  }

  // Region growing: piksel transisi mengambil warna tetangga yang paling mirip.
  let cur = [];
  const queued = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (lab[i] !== U) continue;
    const x = i % W;
    if ((x > 0 && lab[i - 1] < U) || (x < W - 1 && lab[i + 1] < U) || (i >= W && lab[i - W] < U) || (i + W < N && lab[i + W] < U)) {
      cur.push(i); queued[i] = 1;
    }
  }
  while (cur.length) {
    const choice = new Int16Array(cur.length);
    for (let n = 0; n < cur.length; n++) {
      const i = cur[n], p = i * 4, x = i % W;
      rgb2lab(data[p], data[p + 1], data[p + 2], tmpLab);
      let best = -1, bd = Infinity;
      const tryL = (l) => {
        if (l >= U) return;
        const d = (pl[l * 3] - tmpLab[0]) ** 2 + (pl[l * 3 + 1] - tmpLab[1]) ** 2 + (pl[l * 3 + 2] - tmpLab[2]) ** 2;
        if (d < bd) { bd = d; best = l; }
      };
      if (x > 0) tryL(lab[i - 1]);
      if (x < W - 1) tryL(lab[i + 1]);
      if (i >= W) tryL(lab[i - W]);
      if (i + W < N) tryL(lab[i + W]);
      choice[n] = best;
    }
    const next = [];
    for (let n = 0; n < cur.length; n++) {
      const i = cur[n];
      if (choice[n] < 0) { queued[i] = 0; continue; }
      lab[i] = choice[n];
      const x = i % W;
      if (x > 0 && lab[i - 1] === U && !queued[i - 1]) { queued[i - 1] = 1; next.push(i - 1); }
      if (x < W - 1 && lab[i + 1] === U && !queued[i + 1]) { queued[i + 1] = 1; next.push(i + 1); }
      if (i >= W && lab[i - W] === U && !queued[i - W]) { queued[i - W] = 1; next.push(i - W); }
      if (i + W < N && lab[i + W] === U && !queued[i + W]) { queued[i + W] = 1; next.push(i + W); }
    }
    cur = next;
  }
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (lab[i] === U) lab[i] = nearest(data[p], data[p + 1], data[p + 2]);
  }
  return lab;
}

// Satu lintasan blur binomial [1 4 6 4 1]/16 terpisah (σ ≈ 1 px), di tempat,
// kanal RGB saja.
function blurPass(data, W, H) {
  const RW = W * 4;
  const row = new Uint8ClampedArray(RW);
  for (let y = 0; y < H; y++) {
    const off = y * RW;
    row.set(data.subarray(off, off + RW));
    for (let x = 0; x < W; x++) {
      const a = Math.max(0, x - 2) * 4, b = Math.max(0, x - 1) * 4, c = x * 4;
      const d = Math.min(W - 1, x + 1) * 4, e = Math.min(W - 1, x + 2) * 4;
      for (let ch = 0; ch < 3; ch++) {
        data[off + c + ch] = (row[a + ch] + 4 * row[b + ch] + 6 * row[c + ch] + 4 * row[d + ch] + row[e + ch] + 8) >> 4;
      }
    }
  }
  let p2 = data.slice(0, RW), p1 = data.slice(0, RW), cur = new Uint8ClampedArray(RW);
  for (let y = 0; y < H; y++) {
    const off = y * RW;
    cur.set(data.subarray(off, off + RW));
    const n1 = Math.min(H - 1, y + 1) * RW, n2 = Math.min(H - 1, y + 2) * RW;
    for (let i = 0; i < RW; i++) {
      if ((i & 3) === 3) continue;
      data[off + i] = (p2[i] + 4 * p1[i] + 6 * cur[i] + 4 * data[n1 + i] + data[n2 + i] + 8) >> 4;
    }
    const t = p2; p2 = p1; p1 = cur; cur = t;
  }
}

// ---------------------------------------------------------------- komponen
// Pelabelan komponen 4-tetangga. `order` dipakai sebagai antrean BFS sekaligus
// daftar piksel per komponen.
function label(lab, W, H, comp, order) {
  const N = W * H;
  comp.fill(-1);
  const start = [], size = [], lbl = [], border = [];
  let tail = 0;
  for (let s = 0; s < N; s++) {
    if (comp[s] >= 0) continue;
    const c = start.length, l = lab[s];
    const head0 = tail;
    comp[s] = c; order[tail++] = s;
    let touch = false;
    for (let h = head0; h < tail; h++) {
      const i = order[h], x = i % W;
      if (x === 0 || x === W - 1 || i < W || i >= N - W) touch = true;
      if (x > 0 && comp[i - 1] < 0 && lab[i - 1] === l) { comp[i - 1] = c; order[tail++] = i - 1; }
      if (x < W - 1 && comp[i + 1] < 0 && lab[i + 1] === l) { comp[i + 1] = c; order[tail++] = i + 1; }
      if (i >= W && comp[i - W] < 0 && lab[i - W] === l) { comp[i - W] = c; order[tail++] = i - W; }
      if (i < N - W && comp[i + W] < 0 && lab[i + W] === l) { comp[i + W] = c; order[tail++] = i + W; }
    }
    start.push(head0); size.push(tail - head0); lbl.push(l); border.push(touch);
  }
  return { start, size, lbl, border, count: start.length };
}

// Bintik kecil dilebur ke tetangga dengan warna paling mirip (bukan sekadar
// kontak terpanjang) agar potongan garis tipis tidak tertelan latar.
function despeckle(lab, W, H, minA, comp, order, pal) {
  const cd = (a, b) => Math.hypot(pal[a].L - pal[b].L, pal[a].A - pal[b].A, pal[a].B - pal[b].B);
  const N = W * H;
  for (let pass = 0; pass < 2; pass++) {
    const info = label(lab, W, H, comp, order);
    const small = [];
    for (let c = 0; c < info.count; c++) if (info.size[c] < minA && info.lbl[c] !== T) small.push(c);
    if (!small.length) return;
    small.sort((a, b) => info.size[a] - info.size[b]);
    const votes = new Int32Array(256);
    for (const c of small) {
      votes.fill(0);
      const s0 = info.start[c], s1 = s0 + info.size[c];
      const own = lab[order[s0]];
      for (let h = s0; h < s1; h++) {
        const i = order[h], x = i % W;
        if (x > 0 && lab[i - 1] !== own) votes[lab[i - 1]]++;
        if (x < W - 1 && lab[i + 1] !== own) votes[lab[i + 1]]++;
        if (i >= W && lab[i - W] !== own) votes[lab[i - W]]++;
        if (i < N - W && lab[i + W] !== own) votes[lab[i + W]]++;
      }
      let maxV = 0;
      for (let l = 0; l < 254; l++) if (votes[l] > maxV) maxV = votes[l];
      if (!maxV) continue; // hanya bersebelahan dengan transparan
      let best = -1, bs = Infinity;
      for (let l = 0; l < 254; l++) {
        if (votes[l] === 0 || votes[l] < maxV * 0.1) continue;
        const sc = cd(own, l) / Math.sqrt(votes[l] / maxV);
        if (sc < bs) { bs = sc; best = l; }
      }
      for (let h = s0; h < s1; h++) lab[order[h]] = best;
    }
  }
}

// Putih luar → transparan, dengan penutup celah: isian dari tepi hanya mengalir
// lewat "inti" putih (≥ r piksel dari warna lain), lalu dilebarkan kembali
// maksimal r langkah. Celah garis yang lebih sempit dari 2r tidak bisa dilewati,
// sehingga putih di dalam objek tidak ikut bocor.
function floodBorder(lab, W, H, isWhite, queue, r) {
  const N = W * H;
  const INF = 65535;
  const dist = new Uint16Array(N);
  for (let i = 0; i < N; i++) dist[i] = isWhite[lab[i]] ? INF : 0;
  // Transformasi jarak chamfer 3-4 (luar gambar dianggap latar).
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let d = dist[i];
      if (!d) continue;
      if (x > 0 && dist[i - 1] + 3 < d) d = dist[i - 1] + 3;
      if (y > 0) {
        if (dist[i - W] + 3 < d) d = dist[i - W] + 3;
        if (x > 0 && dist[i - W - 1] + 4 < d) d = dist[i - W - 1] + 4;
        if (x < W - 1 && dist[i - W + 1] + 4 < d) d = dist[i - W + 1] + 4;
      }
      dist[i] = d;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let d = dist[i];
      if (!d) continue;
      if (x < W - 1 && dist[i + 1] + 3 < d) d = dist[i + 1] + 3;
      if (y < H - 1) {
        if (dist[i + W] + 3 < d) d = dist[i + W] + 3;
        if (x < W - 1 && dist[i + W + 1] + 4 < d) d = dist[i + W + 1] + 4;
        if (x > 0 && dist[i + W - 1] + 4 < d) d = dist[i + W - 1] + 4;
      }
      dist[i] = d;
    }
  }
  const R = r * 3;
  const seen = new Uint8Array(N);
  let tail = 0;
  // 1. Isi inti dari tepi gambar.
  const pushCore = (i) => { if (!seen[i] && dist[i] > R) { seen[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < W; x++) { pushCore(x); pushCore(N - W + x); }
  for (let y = 0; y < H; y++) { pushCore(y * W); pushCore(y * W + W - 1); }
  for (let h = 0; h < tail; h++) {
    const i = queue[h], x = i % W;
    if (x > 0) pushCore(i - 1);
    if (x < W - 1) pushCore(i + 1);
    if (i >= W) pushCore(i - W);
    if (i < N - W) pushCore(i + W);
  }
  // 2. Piksel putih di tepi gambar ikut menjadi titik awal pelebaran.
  const pushW = (i) => { if (!seen[i] && dist[i]) { seen[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < W; x++) { pushW(x); pushW(N - W + x); }
  for (let y = 0; y < H; y++) { pushW(y * W); pushW(y * W + W - 1); }
  // 3. Pelebaran geodesik 8-tetangga sebanyak r + 1 langkah di dalam area putih.
  let from = 0;
  for (let step = 0; step <= r; step++) {
    const to = tail;
    for (let h = from; h < to; h++) {
      const i = queue[h], x = i % W;
      const L = x > 0, Rt = x < W - 1, Up = i >= W, Dn = i < N - W;
      if (L) pushW(i - 1);
      if (Rt) pushW(i + 1);
      if (Up) { pushW(i - W); if (L) pushW(i - W - 1); if (Rt) pushW(i - W + 1); }
      if (Dn) { pushW(i + W); if (L) pushW(i + W - 1); if (Rt) pushW(i + W + 1); }
    }
    from = to;
  }
  for (let i = 0; i < N; i++) if (seen[i]) lab[i] = T;
}

// Putih terkurung yang termasuk latar. Pada ilustrasi ber-outline, putih milik
// objek (badan, wajah) hanya bersentuhan dengan warna garis; putih latar yang
// terkurung (antara kaki, layar, rangka kursi) bersentuhan langsung dengan
// warna latar lain (blob, bayangan, garis berwarna terang) atau area transparan.
function smartWhite(lab, W, comp, order, info, isWhite, removed, pal) {
  const N = lab.length;
  // Warna garis = warna non-putih yang paling banyak berbatasan dengan putih.
  const contact = new Float64Array(256);
  const note = (a, b) => {
    const wa = isWhite[a] && a !== T, wb = isWhite[b] && b !== T;
    if (wa && !wb && b !== T) contact[b]++;
    else if (wb && !wa && a !== T) contact[a]++;
  };
  for (let i = 0; i < N; i++) {
    const x = i % W;
    if (x < W - 1) note(lab[i], lab[i + 1]);
    if (i < N - W) note(lab[i], lab[i + W]);
  }
  let outline = -1, best = 0;
  for (let l = 0; l < 254; l++) if (contact[l] > best) { best = contact[l]; outline = l; }
  if (outline < 0) return;
  // Warna "latar": terang (blob, bayangan, garis pastel) dan jauh dari warna garis.
  const ol = pal[outline];
  const bgCol = new Uint8Array(256);
  bgCol[T] = 1;
  pal.forEach((p, k) => {
    if (isWhite[k] || k === outline) return;
    if (p.L >= 70 && Math.hypot(p.L - ol.L, p.A - ol.A, p.B - ol.B) > 30) bgCol[k] = 1;
  });
  // Kotak batas tiap komponen: bentuk yang seluruhnya berada di dalam area putih
  // (detail kartu, ikon) bukan petunjuk latar.
  const n = info.count;
  const bx0 = new Int32Array(n).fill(W), by0 = new Int32Array(n).fill(1 << 30), bx1 = new Int32Array(n), by1 = new Int32Array(n);
  for (let c = 0; c < n; c++) {
    for (let h = info.start[c], e = h + info.size[c]; h < e; h++) {
      const i = order[h], x = i % W, y = (i / W) | 0;
      if (x < bx0[c]) bx0[c] = x; if (x > bx1[c]) bx1[c] = x;
      if (y < by0[c]) by0[c] = y; if (y > by1[c]) by1[c] = y;
    }
  }
  const inside = (q, c) => bx0[q] > bx0[c] && bx1[q] < bx1[c] && by0[q] > by0[c] && by1[q] < by1[c];
  for (let c = 0; c < n; c++) {
    const l = info.lbl[c];
    if (l === T || !isWhite[l] || info.border[c]) continue;
    let tot = 0, bg = 0;
    for (let h = info.start[c], e = h + info.size[c]; h < e; h++) {
      const i = order[h], x = i % W;
      const see = (q) => {
        const cq = comp[q];
        if (cq === c) return;
        tot++;
        if (bgCol[lab[q]] && !inside(cq, c)) bg++;
      };
      if (x > 0) see(i - 1);
      if (x < W - 1) see(i + 1);
      if (i >= W) see(i - W);
      if (i < N - W) see(i + W);
    }
    if (tot && bg / tot >= 0.06) removed[c] = 1;
  }
}

// ---------------------------------------------------------------- tracing
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

function traceAll(lab, comp, info, W, H, s, o, progress) {
  const W1 = W + 1, NH = W * (H + 1);
  const vis = new Uint8Array(NH + W1 * H);
  const emit = new Uint8Array(info.count);
  for (let c = 0; c < info.count; c++) emit[c] = info.lbl[c] !== T ? 1 : 0;

  const cAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : comp[y * W + x]);
  const leftC = (vx, vy, d) => (d === 0 ? cAt(vx, vy - 1) : d === 1 ? cAt(vx, vy) : d === 2 ? cAt(vx - 1, vy) : cAt(vx - 1, vy - 1));
  const rightC = (vx, vy, d) => (d === 0 ? cAt(vx, vy) : d === 1 ? cAt(vx - 1, vy) : d === 2 ? cAt(vx - 1, vy - 1) : cAt(vx, vy - 1));
  const edgeOf = (vx, vy, d) => (d === 0 ? vy * W + vx : d === 1 ? NH + vy * W1 + vx : d === 2 ? vy * W + vx - 1 : NH + (vy - 1) * W1 + vx);
  const bitOf = (d) => (d === 0 || d === 3 ? 1 : 2);

  function traceCycle(C, vx, vy, d) {
    const sx = vx, sy = vy, sd = d;
    const out = [];
    for (let guard = 0; guard < 1e8; guard++) {
      vis[edgeOf(vx, vy, d)] |= bitOf(d);
      out.push(vy * W1 + vx);
      vx += DX[d]; vy += DY[d];
      let nd = -1;
      for (let k = 0; k < 3; k++) {
        const t = (d + 3 + k) & 3;
        if (leftC(vx, vy, t) === C && rightC(vx, vy, t) !== C) { nd = t; break; }
      }
      d = nd;
      if (d < 0 || (vx === sx && vy === sy && d === sd)) break;
    }
    return Int32Array.from(out);
  }

  // 1. Semua siklus batas, dikelompokkan per komponen.
  const cyc = new Array(info.count);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, c = comp[i];
      if (!emit[c]) continue;
      const add = (v) => { (cyc[c] || (cyc[c] = [])).push(v); };
      if ((y === 0 || comp[i - W] !== c) && !(vis[y * W + x] & 2)) add(traceCycle(c, x + 1, y, 2));
      if ((x === 0 || comp[i - 1] !== c) && !(vis[NH + y * W1 + x] & 2)) add(traceCycle(c, x, y, 1));
      if ((y === H - 1 || comp[i + W] !== c) && !(vis[(y + 1) * W + x] & 1)) add(traceCycle(c, x, y + 1, 0));
      if ((x === W - 1 || comp[i + 1] !== c) && !(vis[NH + y * W1 + x + 1] & 1)) add(traceCycle(c, x + 1, y + 1, 3));
    }
  }
  progress(0.15);

  const isJ = (v) => {
    const vx = v % W1, vy = (v / W1) | 0;
    const a = cAt(vx - 1, vy - 1), b = cAt(vx, vy - 1), c = cAt(vx - 1, vy), d = cAt(vx, vy);
    let n = 1;
    if (b !== a) n++;
    if (c !== a && c !== b) n++;
    if (d !== a && d !== b && d !== c) n++;
    if (n >= 3) return true;
    return n === 2 && a === d && b === c && a !== b;
  };
  const edgeKey = (va, vb) => {
    const xa = va % W1, ya = (va / W1) | 0, xb = vb % W1, yb = (vb / W1) | 0;
    return ya === yb ? ya * W + Math.min(xa, xb) : NH + Math.min(ya, yb) * W1 + xa;
  };
  const dirOf = (va, vb) => {
    const dx = (vb % W1) - (va % W1), dy = ((vb / W1) | 0) - ((va / W1) | 0);
    return dx === 1 ? 0 : dy === 1 ? 1 : dx === -1 ? 2 : 3;
  };

  const fitter = makeFitter(W1, s, o);
  const chains = [];
  const map = new Map();
  let nodes = 0;
  // Rantai dikumpulkan dulu (raw), di-fit setelah titik pertemuan dirapikan.
  const addChain = (raw, inner) => {
    chains.push({ raw, inner });
    return chains.length - 1;
  };
  const innerOf = (va, vb) => {
    const d = dirOf(va, vb);
    const r = rightC(va % W1, (va / W1) | 0, d);
    return r >= 0 && emit[r] === 1;
  };

  // Titik sampel komponen transparan yang tidak menyentuh tepi (untuk mode tumpuk).
  const tSamples = [];
  for (let c = 0; c < info.count; c++) {
    if (emit[c] || info.border[c]) continue;
    // piksel pertama komponen = piksel dengan indeks terkecil
    tSamples.push(c);
  }
  const tPts = [];
  if (tSamples.length) {
    const want = new Set(tSamples);
    for (let i = 0; i < W * H && want.size; i++) {
      const c = comp[i];
      if (want.has(c)) { want.delete(c); tPts.push((i % W) + 0.5, ((i / W) | 0) + 0.5); }
    }
  }

  const regions = [];
  let doneComps = 0;
  const totalComps = cyc.reduce((n, v) => n + (v ? 1 : 0), 0) || 1;

  for (let c = 0; c < info.count; c++) {
    const list = cyc[c];
    if (!list) continue;
    let outerI = 0, outerA = -1;
    list.forEach((V, k) => {
      const a = Math.abs(polyArea(V, W1));
      if (a > outerA) { outerA = a; outerI = k; }
    });
    const subs = [];
    for (let k = 0; k < list.length; k++) {
      const V = list[k], n = V.length;
      const J = new Uint8Array(n);
      let jc = 0;
      for (let i = 0; i < n; i++) if (isJ(V[i])) { J[i] = 1; jc++; }
      const refs = [];
      if (jc === 0) {
        let m = 0;
        for (let i = 1; i < n; i++) if (V[i] < V[m]) m = i;
        const key = -(V[m] + 1), nxt = V[(m + 1) % n];
        const e = map.get(key);
        if (e) refs.push(e.idx * 2 + (e.next === nxt ? 0 : 1));
        else {
          const idx = addChain({ closed: V }, innerOf(V[0], V[1 % n]));
          map.set(key, { idx, next: nxt });
          refs.push(idx * 2);
        }
      } else {
        let j0 = 0;
        while (!J[j0]) j0++;
        let a = j0;
        do {
          let b = (a + 1) % n;
          while (!J[b]) b = (b + 1) % n;
          const len = (b - a + n) % n || n;
          const seq = new Int32Array(len + 1);
          for (let t = 0; t <= len; t++) seq[t] = V[(a + t) % n];
          const k0 = edgeKey(seq[0], seq[1]), k1 = edgeKey(seq[len - 1], seq[len]);
          const key = Math.min(k0, k1);
          const e = map.get(key);
          if (e) refs.push(e.idx * 2 + (e.start === seq[0] && e.first === k0 ? 0 : 1));
          else {
            const idx = addChain({ open: seq }, innerOf(seq[0], seq[1]));
            map.set(key, { idx, start: seq[0], first: k0 });
            refs.push(idx * 2);
          }
          a = b;
        } while (a !== j0);
      }
      const outer = k === outerI;
      let fill = false;
      if (!outer) fill = !containsAny(V, W1, tPts);
      subs.push({ refs: Int32Array.from(refs), outer, fill });
    }
    regions.push({ k: info.lbl[c], area: outerA, subs });
    if (++doneComps % 64 === 0) progress(0.15 + 0.25 * (doneComps / totalComps));
  }
  // Rapikan titik pertemuan (≥3 region): geser ke rata-rata titik di dekat ujung
  // semua rantai yang bertemu di sana, agar tidak terkunci di sudut piksel yang
  // bergerigi. Titik di tepi gambar tetap.
  const m = Math.max(2, Math.round(1.5 * s));
  const jsum = new Map();
  const acc = (v, x, y) => {
    let e = jsum.get(v);
    if (!e) jsum.set(v, (e = [v % W1, (v / W1) | 0, 1]));
    e[0] += x; e[1] += y; e[2]++;
  };
  const endAvg = (seq, fromEnd) => {
    const n = seq.length, k = Math.min(m, n - 1);
    let sx = 0, sy = 0;
    for (let t = 0; t < k; t++) {
      const i = fromEnd ? n - 2 - t : t, a = seq[i], b = seq[i + 1];
      sx += ((a % W1) + (b % W1)) / 2;
      sy += (((a / W1) | 0) + ((b / W1) | 0)) / 2;
    }
    return [sx / k, sy / k];
  };
  for (const ch of chains) {
    const seq = ch.raw.open;
    if (!seq) continue;
    const a = endAvg(seq, false), b = endAvg(seq, true);
    acc(seq[0], a[0], a[1]);
    acc(seq[seq.length - 1], b[0], b[1]);
  }
  const jpos = (v) => {
    const x = v % W1, y = (v / W1) | 0;
    if (x === 0 || y === 0 || x === W || y === H) return [x, y];
    const e = jsum.get(v);
    return [e[0] / e[2], e[1] / e[2]];
  };
  chains.forEach((ch, i) => {
    const seq = ch.raw.open;
    const geo = seq ? fitter.open(seq, jpos(seq[0]), jpos(seq[seq.length - 1])) : fitter.closed(ch.raw.closed);
    ch.p = geo.p; ch.c = geo.c;
    delete ch.raw;
    nodes += geo.c.length;
    if (i % 256 === 0) progress(0.4 + 0.6 * (i / chains.length));
  });
  regions.sort((a, b) => b.area - a.area);
  return { chains, regions, nodes };
}

function polyArea(V, W1) {
  let a = 0;
  const n = V.length;
  for (let i = 0; i < n; i++) {
    const p = V[i], q = V[(i + 1) % n];
    a += (p % W1) * ((q / W1) | 0) - (q % W1) * ((p / W1) | 0);
  }
  return a / 2;
}

function containsAny(V, W1, pts) {
  if (!pts.length) return false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const n = V.length;
  for (let i = 0; i < n; i++) {
    const x = V[i] % W1, y = (V[i] / W1) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  for (let k = 0; k < pts.length; k += 2) {
    const px = pts[k], py = pts[k + 1];
    if (px < x0 || px > x1 || py < y0 || py > y1) continue;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = V[i] % W1, yi = (V[i] / W1) | 0, xj = V[j] % W1, yj = (V[j] / W1) | 0;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

// ---------------------------------------------------------------- fitting
function makeFitter(W1, s, o) {
  const err = Math.max(0.25, o.smooth * s); // toleransi dalam piksel kerja
  const lineTol = err * 0.6;
  const K = Math.max(2, Math.min(6, Math.round(1.5 * s)));
  const cornerThr = (o.corner || 62) * (Math.PI / 180);
  // Penghalusan kuat setelah sudut dikunci: menghapus gelombang tangga piksel
  // sumber (yang setelah upscale berperiode beberapa piksel kerja).
  const heavy = Math.min(40, Math.max(2, Math.round(((0.25 + o.smooth) * s) ** 2)));

  const vx = (v) => v % W1, vy = (v) => (v / W1) | 0;

  function open(seq, A, B) {
    const n = seq.length;
    const P = new Float64Array((n + 1) * 2);
    P[0] = A[0]; P[1] = A[1];
    for (let i = 0; i < n - 1; i++) {
      P[(i + 1) * 2] = (vx(seq[i]) + vx(seq[i + 1])) / 2;
      P[(i + 1) * 2 + 1] = (vy(seq[i]) + vy(seq[i + 1])) / 2;
    }
    P[n * 2] = B[0]; P[n * 2 + 1] = B[1];
    return processOpen(P, n + 1);
  }

  function closed(V) {
    const n = V.length;
    const P = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = V[i], b = V[(i + 1) % n];
      P[i * 2] = (vx(a) + vx(b)) / 2;
      P[i * 2 + 1] = (vy(a) + vy(b)) / 2;
    }
    return processClosed(P, n);
  }

  function processOpen(P, n) {
    const fixed = new Uint8Array(n);
    fixed[0] = fixed[n - 1] = 1;
    let Q = smooth(P, n, false, fixed, 1);
    const cor = corners(Q, n, false);
    for (const i of cor) fixed[i] = 1;
    Q = smooth(Q, n, false, fixed, heavy, true);
    const splits = [0, ...cor, n - 1];
    const out = newPath(Q[0], Q[1]);
    for (let k = 0; k < splits.length - 1; k++) fitPiece(Q, splits[k], splits[k + 1], null, null, out);
    return finish(out);
  }

  function processClosed(P, n) {
    const fixed = new Uint8Array(n);
    let Q = smooth(P, n, true, fixed, 1);
    const cor = corners(Q, n, true);
    if (!cor.length) {
      Q = smooth(Q, n, true, fixed, heavy, true);
      const ell = n >= 12 ? fitEllipse(Q, n) : null;
      if (ell) return ell;
      // Pecah di dua titik berlawanan dengan tangen kontinu.
      const R = rot(Q, n, 0);
      const h = n >> 1;
      const tA = centerTan(Q, n, 0), tB = centerTan(Q, n, h);
      const out = newPath(R[0], R[1]);
      fitPiece(R, 0, h, tA, [-tB[0], -tB[1]], out);
      fitPiece(R, h, n, tB, [-tA[0], -tA[1]], out);
      return finish(out);
    }
    for (const i of cor) fixed[i] = 1;
    Q = smooth(Q, n, true, fixed, heavy, true);
    const c0 = cor[0];
    const R = rot(Q, n, c0);
    const splits = cor.map((i) => (i - c0 + n) % n).sort((a, b) => a - b);
    splits.push(n);
    const out = newPath(R[0], R[1]);
    for (let k = 0; k < splits.length - 1; k++) fitPiece(R, splits[k], splits[k + 1], null, null, out);
    return finish(out);
  }

  // Salinan berputar dengan titik awal di akhir (n+1 titik).
  function rot(Q, n, start) {
    const R = new Float64Array((n + 1) * 2);
    for (let i = 0; i <= n; i++) {
      const j = (start + i) % n;
      R[i * 2] = Q[j * 2]; R[i * 2 + 1] = Q[j * 2 + 1];
    }
    return R;
  }

  function centerTan(Q, n, i) {
    const m = Math.min(3, Math.max(1, n >> 3));
    const a = (i - m + n) % n, b = (i + m) % n;
    return norm(Q[b * 2] - Q[a * 2], Q[b * 2 + 1] - Q[a * 2 + 1]);
  }

  // Laplacian ([1,2,1]/4); bila taubin, tiap langkah diikuti langkah "mengembang"
  // (μ < 0) agar bentuk tidak menyusut (penghalusan Taubin).
  function smooth(P, n, closedPath, fixed, passes, taubin) {
    let a = P, b = new Float64Array(P.length);
    const steps = taubin ? passes * 2 : passes;
    for (let ps = 0; ps < steps; ps++) {
      const f = taubin && ps & 1 ? -0.53 : 0.5;
      for (let i = 0; i < n; i++) {
        if (fixed[i] || (!closedPath && (i === 0 || i === n - 1))) { b[i * 2] = a[i * 2]; b[i * 2 + 1] = a[i * 2 + 1]; continue; }
        const im = closedPath ? (i - 1 + n) % n : i - 1, ip = closedPath ? (i + 1) % n : i + 1;
        b[i * 2] = a[i * 2] + f * ((a[im * 2] + a[ip * 2]) / 2 - a[i * 2]);
        b[i * 2 + 1] = a[i * 2 + 1] + f * ((a[im * 2 + 1] + a[ip * 2 + 1]) / 2 - a[i * 2 + 1]);
      }
      const t = a === P ? new Float64Array(P.length) : a;
      a = b; b = t;
    }
    return a;
  }

  function corners(Q, n, closedPath) {
    const k = closedPath ? Math.min(K, Math.max(1, (n - 1) >> 1)) : K;
    if (n < 5) return [];
    // Sudut belok di titik i dengan jendela ±w.
    const turn = (i, w) => {
      const im = closedPath ? (i - w + n * 4) % n : Math.max(0, i - w);
      const ip = closedPath ? (i + w) % n : Math.min(n - 1, i + w);
      const ax = Q[i * 2] - Q[im * 2], ay = Q[i * 2 + 1] - Q[im * 2 + 1];
      const bx = Q[ip * 2] - Q[i * 2], by = Q[ip * 2 + 1] - Q[i * 2 + 1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-9 || lb < 1e-9) return 0;
      return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
    };
    const k2 = closedPath ? Math.min(2 * k, Math.max(1, (n - 1) >> 1)) : 2 * k;
    const ang = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!closedPath && (i === 0 || i === n - 1)) continue;
      const a = turn(i, k);
      // Sudut sejati tetap tajam di jendela 2×; gelombang kecil tidak.
      if (a >= cornerThr && turn(i, k2) >= cornerThr * 0.8) ang[i] = a;
    }
    const res = [];
    for (let i = 0; i < n; i++) {
      if (ang[i] < cornerThr) continue;
      let isMax = true;
      for (let j = -k; j <= k && isMax; j++) {
        if (!j) continue;
        let q = i + j;
        if (closedPath) q = (q + n) % n;
        else if (q < 0 || q >= n) continue;
        if (ang[q] > ang[i] || (ang[q] === ang[i] && j < 0)) isMax = false;
      }
      if (isMax) res.push(i);
    }
    return res;
  }

  function fitPiece(Q, a, b, tA, tB, out) {
    const cnt = b - a + 1;
    const ax = Q[a * 2], ay = Q[a * 2 + 1], bx = Q[b * 2], by = Q[b * 2 + 1];
    if (cnt <= 3) { lineTo(out, bx, by); return; }
    // Garis lurus?
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    if (L > 1e-9) {
      let md = 0;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((Q[i * 2] - ax) * dy - (Q[i * 2 + 1] - ay) * dx) / L;
        if (d > md) { md = d; if (md > lineTol) break; }
      }
      if (md <= lineTol) { lineTo(out, bx, by); return; }
    }
    const m = Math.max(1, Math.min(4, (cnt - 1) >> 2));
    const t1 = tA || norm(Q[(a + m) * 2] - ax, Q[(a + m) * 2 + 1] - ay);
    const t2 = tB || norm(Q[(b - m) * 2] - bx, Q[(b - m) * 2 + 1] - by);
    fitCubic(Q, a, b, t1, t2, err * err, out, 0);
  }

  function fitCubic(Q, first, last, t1, t2, e2, out, depth) {
    const n = last - first + 1;
    const p0x = Q[first * 2], p0y = Q[first * 2 + 1], p3x = Q[last * 2], p3y = Q[last * 2 + 1];
    if (n === 2) {
      const d = Math.hypot(p3x - p0x, p3y - p0y) / 3;
      curveTo(out, p0x + t1[0] * d, p0y + t1[1] * d, p3x + t2[0] * d, p3y + t2[1] * d, p3x, p3y);
      return;
    }
    let u = chordParam(Q, first, last);
    let bz = genBezier(Q, first, last, u, t1, t2);
    let [maxE, split] = maxError(Q, first, last, bz, u);
    if (maxE < e2) { curveTo(out, bz[2], bz[3], bz[4], bz[5], bz[6], bz[7]); return; }
    if (maxE < e2 * 4) {
      for (let it = 0; it < 4; it++) {
        u = reparam(Q, first, last, u, bz);
        bz = genBezier(Q, first, last, u, t1, t2);
        [maxE, split] = maxError(Q, first, last, bz, u);
        if (maxE < e2) { curveTo(out, bz[2], bz[3], bz[4], bz[5], bz[6], bz[7]); return; }
      }
    }
    if (depth > 24 || n < 4) { curveTo(out, bz[2], bz[3], bz[4], bz[5], bz[6], bz[7]); return; }
    split = Math.max(first + 1, Math.min(last - 1, split));
    const tc = norm(Q[(split - 1) * 2] - Q[(split + 1) * 2], Q[(split - 1) * 2 + 1] - Q[(split + 1) * 2 + 1]);
    fitCubic(Q, first, split, t1, tc, e2, out, depth + 1);
    fitCubic(Q, split, last, [-tc[0], -tc[1]], t2, e2, out, depth + 1);
  }

  function fitEllipse(Q, n) {
    let A = 0, cx = 0, cy = 0, ixx = 0, iyy = 0, ixy = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = Q[i * 2], y0 = Q[i * 2 + 1], x1 = Q[j * 2], y1 = Q[j * 2 + 1];
      const cr = x0 * y1 - x1 * y0;
      A += cr;
      cx += (x0 + x1) * cr; cy += (y0 + y1) * cr;
      ixx += (x0 * x0 + x0 * x1 + x1 * x1) * cr;
      iyy += (y0 * y0 + y0 * y1 + y1 * y1) * cr;
      ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cr;
    }
    A /= 2;
    if (Math.abs(A) < 4) return null;
    cx /= 6 * A; cy /= 6 * A;
    const mxx = ixx / (12 * A) - cx * cx, myy = iyy / (12 * A) - cy * cy, mxy = ixy / (24 * A) - cx * cy;
    const tr = mxx + myy, det = mxx * myy - mxy * mxy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    if (l2 <= 0) return null;
    const ra = 2 * Math.sqrt(l1), rb = 2 * Math.sqrt(l2);
    if (rb < 1.5) return null;
    const th = 0.5 * Math.atan2(2 * mxy, mxx - myy);
    const ct = Math.cos(th), st = Math.sin(th);
    const tol = err * 0.9;
    for (let i = 0; i < n; i++) {
      const dx = Q[i * 2] - cx, dy = Q[i * 2 + 1] - cy;
      const u = dx * ct + dy * st, v = -dx * st + dy * ct;
      const rho = Math.hypot(u / ra, v / rb);
      if (rho < 1e-9) return null;
      const dist = Math.abs(rho - 1) * (Math.hypot(u, v) / rho);
      if (dist > tol) return null;
    }
    const dir = A > 0 ? 1 : -1;
    const E = (t) => [cx + ra * Math.cos(t) * ct - rb * Math.sin(t) * st, cy + ra * Math.cos(t) * st + rb * Math.sin(t) * ct];
    const D = (t) => [-ra * Math.sin(t) * ct - rb * Math.cos(t) * st, -ra * Math.sin(t) * st + rb * Math.cos(t) * ct];
    const kq = (4 / 3) * Math.tan((dir * Math.PI) / 8);
    const p0 = E(0);
    const out = newPath(p0[0], p0[1]);
    for (let q = 0; q < 4; q++) {
      const ta = (dir * q * Math.PI) / 2, tb = (dir * (q + 1) * Math.PI) / 2;
      const a = E(ta), b = E(tb), da = D(ta), db = D(tb);
      curveTo(out, a[0] + kq * da[0], a[1] + kq * da[1], b[0] - kq * db[0], b[1] - kq * db[1], q === 3 ? p0[0] : b[0], q === 3 ? p0[1] : b[1]);
    }
    return finish(out);
  }

  return { open, closed };
}

function newPath(x, y) { return { p: [x, y], c: [] }; }
function lineTo(o, x, y) { o.c.push(0); o.p.push(x, y); }
function curveTo(o, a, b, c, d, e, f) { o.c.push(1); o.p.push(a, b, c, d, e, f); }
function finish(o) { return { p: Float32Array.from(o.p), c: Uint8Array.from(o.c) }; }
function norm(x, y) {
  const l = Math.hypot(x, y);
  return l < 1e-12 ? [1, 0] : [x / l, y / l];
}

// --- Schneider (Graphics Gems I, "An Algorithm for Automatically Fitting Digitized Curves")
function chordParam(Q, first, last) {
  const n = last - first + 1;
  const u = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = first + i - 1, b = first + i;
    u[i] = u[i - 1] + Math.hypot(Q[b * 2] - Q[a * 2], Q[b * 2 + 1] - Q[a * 2 + 1]);
  }
  const L = u[n - 1] || 1;
  for (let i = 1; i < n; i++) u[i] /= L;
  return u;
}

function genBezier(Q, first, last, u, t1, t2) {
  const p0x = Q[first * 2], p0y = Q[first * 2 + 1], p3x = Q[last * 2], p3y = Q[last * 2 + 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i], mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * t * mt * mt, b2 = 3 * t * t * mt, b3 = t * t * t;
    const a1x = t1[0] * b1, a1y = t1[1] * b1, a2x = t2[0] * b2, a2y = t2[1] * b2;
    c00 += a1x * a1x + a1y * a1y;
    c01 += a1x * a2x + a1y * a2y;
    c11 += a2x * a2x + a2y * a2y;
    const k = first + i;
    const tx = Q[k * 2] - (p0x * (b0 + b1) + p3x * (b2 + b3));
    const ty = Q[k * 2 + 1] - (p0y * (b0 + b1) + p3y * (b2 + b3));
    x0 += a1x * tx + a1y * ty;
    x1 += a2x * tx + a2y * ty;
  }
  const det = c00 * c11 - c01 * c01;
  let al = 0, ar = 0;
  if (Math.abs(det) > 1e-12) {
    al = (x0 * c11 - x1 * c01) / det;
    ar = (c00 * x1 - c01 * x0) / det;
  }
  const seg = Math.hypot(p3x - p0x, p3y - p0y);
  const eps = 1e-6 * seg;
  if (al < eps || ar < eps || al > seg * 2 || ar > seg * 2) { al = ar = seg / 3; }
  return [p0x, p0y, p0x + t1[0] * al, p0y + t1[1] * al, p3x + t2[0] * ar, p3y + t2[1] * ar, p3x, p3y];
}

function bez(b, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, c = 3 * mt * mt * t, d = 3 * mt * t * t, e = t * t * t;
  return [a * b[0] + c * b[2] + d * b[4] + e * b[6], a * b[1] + c * b[3] + d * b[5] + e * b[7]];
}

function maxError(Q, first, last, b, u) {
  let maxD = 0, split = (first + last) >> 1;
  for (let i = 1; i < u.length - 1; i++) {
    const p = bez(b, u[i]), k = first + i;
    const d = (p[0] - Q[k * 2]) ** 2 + (p[1] - Q[k * 2 + 1]) ** 2;
    if (d >= maxD) { maxD = d; split = k; }
  }
  return [maxD, split];
}

function reparam(Q, first, last, u, b) {
  const out = new Float64Array(u.length);
  const q1 = [3 * (b[2] - b[0]), 3 * (b[3] - b[1]), 3 * (b[4] - b[2]), 3 * (b[5] - b[3]), 3 * (b[6] - b[4]), 3 * (b[7] - b[5])];
  const q2 = [2 * (q1[2] - q1[0]), 2 * (q1[3] - q1[1]), 2 * (q1[4] - q1[2]), 2 * (q1[5] - q1[3])];
  for (let i = 0; i < u.length; i++) {
    const t = u[i], mt = 1 - t, k = first + i;
    const p = bez(b, t);
    const d1x = mt * mt * q1[0] + 2 * mt * t * q1[2] + t * t * q1[4];
    const d1y = mt * mt * q1[1] + 2 * mt * t * q1[3] + t * t * q1[5];
    const d2x = mt * q2[0] + t * q2[2], d2y = mt * q2[1] + t * q2[3];
    const dx = p[0] - Q[k * 2], dy = p[1] - Q[k * 2 + 1];
    const num = dx * d1x + dy * d1y;
    const den = d1x * d1x + d1y * d1y + dx * d2x + dy * d2y;
    out[i] = Math.abs(den) < 1e-12 ? t : Math.max(0, Math.min(1, t - num / den));
  }
  return out;
}
