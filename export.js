/* Vektor — penyusun SVG/EPS dan penulis ZIP. */

// ---------------------------------------------------------------- ukuran
export function outputSize(w, h, mode, customMP) {
  if (mode === 'orig') return { w, h };
  const mp = mode === 'custom' ? Math.max(15, Number(customMP) || 15) : Number(mode);
  const target = mp * 1e6;
  const k = Math.sqrt(target / (w * h));
  let W = Math.ceil(w * k), H = Math.ceil(h * k);
  while (W * H < target) { if (W / w < H / h) W++; else H++; }
  return { w: W, h: H };
}

// ---------------------------------------------------------------- nama
export function stemOf(name) {
  const i = name.lastIndexOf('.');
  return (i > 0 ? name.slice(0, i) : name).replace(/[\\/:*?"<>|]+/g, '_');
}
export function outName(stem, index, code, start) {
  const c = (code || '').trim();
  if (!c) return stem;
  return `${c}_${(Number(start) || 0) + index}_${stem}`;
}

// ---------------------------------------------------------------- geometri
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const num = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

// Menelusuri satu sub-path (daftar referensi rantai) dan memanggil sink.M/L/C.
function walk(refs, chains, sink, closeIt) {
  let first = true;
  for (let r = 0; r < refs.length; r++) {
    const ref = refs[r];
    const ch = chains[ref >> 1];
    const p = ch.p, c = ch.c;
    if (!(ref & 1)) {
      if (first) sink.M(p[0], p[1]);
      let j = 2;
      for (let s = 0; s < c.length; s++) {
        if (c[s] === 0) { sink.L(p[j], p[j + 1]); j += 2; }
        else { sink.C(p[j], p[j + 1], p[j + 2], p[j + 3], p[j + 4], p[j + 5]); j += 6; }
      }
    } else {
      // Arah balik: simpan offset awal tiap segmen.
      const off = new Int32Array(c.length + 1);
      let j = 2;
      for (let s = 0; s < c.length; s++) { off[s] = j; j += c[s] === 0 ? 2 : 6; }
      off[c.length] = j;
      if (first) sink.M(p[j - 2], p[j - 1]);
      for (let s = c.length - 1; s >= 0; s--) {
        const prev = s === 0 ? 0 : off[s] - 2; // titik awal segmen s
        if (c[s] === 0) sink.L(p[prev], p[prev + 1]);
        else {
          const o = off[s];
          sink.C(p[o + 2], p[o + 3], p[o], p[o + 1], p[prev], p[prev + 1]);
        }
      }
    }
    first = false;
  }
  if (closeIt) sink.Z();
}

function svgSink(kx, ky) {
  const out = [];
  return {
    out,
    M: (x, y) => out.push('M', num(x * kx), num(y * ky)),
    L: (x, y) => out.push('L', num(x * kx), num(y * ky)),
    C: (a, b, c, d, e, f) => out.push('C', num(a * kx), num(b * ky), num(c * kx), num(d * ky), num(e * kx), num(f * ky)),
    Z: () => out.push('Z'),
    text: () => out.join(' ').replace(/ ([MLCZ])/g, '$1').replace(/([MLCZ]) /g, '$1'),
  };
}

function epsSink(kx, ky, H) {
  const out = [];
  let line = [];
  const flush = () => { if (line.length) { out.push(line.join(' ')); line = []; } };
  return {
    out,
    M: (x, y) => { flush(); line.push(num(x * kx), num(H - y * ky), 'm'); },
    L: (x, y) => { line.push(num(x * kx), num(H - y * ky), 'l'); if (line.length > 24) flush(); },
    C: (a, b, c, d, e, f) => { line.push(num(a * kx), num(H - b * ky), num(c * kx), num(H - d * ky), num(e * kx), num(H - f * ky), 'c'); if (line.length > 20) flush(); },
    Z: () => { line.push('h'); flush(); },
    end: () => flush(),
  };
}

// Region yang tersembunyi: putih latar (default) XOR diklik, atau warnanya disembunyikan.
// opt.hidden: Uint8Array per region (1 = tersembunyi). Tanpa opt.hidden → default.
export function defaultHidden(res) {
  return Uint8Array.from(res.regions, (r) => (r.hid ? 1 : 0));
}
const hiddenOf = (res, opt) => opt.hidden || defaultHidden(res);

// Daftar bentuk siap gambar, sesuai mode lapisan, region tersembunyi, dan warna.
function shapes(res, opt) {
  const pal = res.palette.map((c, k) => (opt.recolor && opt.recolor[k]) || c);
  const hidden = hiddenOf(res, opt);
  const list = [];
  if (opt.stacking === 'cutout') {
    // Satu compound path per warna (region tidak saling tumpang tindih).
    const byColor = new Map();
    res.regions.forEach((r, i) => {
      if (hidden[i]) return;
      if (!byColor.has(r.k)) byColor.set(r.k, { subs: [], regions: [] });
      const g = byColor.get(r.k);
      g.subs.push(...r.subs);
      g.regions.push(i);
    });
    for (const [k, g] of byColor) list.push({ color: pal[k], subs: g.subs, regions: g.regions });
  } else {
    // Tumpuk: lubang diisi kecuali berbatasan dengan region tersembunyi/transparan.
    res.regions.forEach((r, i) => {
      if (hidden[i]) return;
      const subs = r.subs.filter((s) => s.outer || !s.fill || touchesHidden(res, s, i, hidden));
      list.push({ color: pal[r.k], subs, regions: [i] });
    });
  }
  return list;
}

function touchesHidden(res, sub, i, hidden) {
  for (let n = 0; n < sub.refs.length; n++) {
    const ch = res.chains[sub.refs[n] >> 1];
    const other = ch.a === i ? ch.b : ch.a;
    if (other < 0 || hidden[other]) return true;
  }
  return false;
}

// Garis pengisi celah: hanya batas antar dua bentuk yang sama-sama tampil.
function gapStrokes(res, i, hidden, sinkFactory) {
  const segs = [];
  for (const s of res.regions[i].subs) {
    for (let n = 0; n < s.refs.length; n++) {
      const ref = s.refs[n];
      const ch = res.chains[ref >> 1];
      if (ch.a < 0 || ch.b < 0 || hidden[ch.a] || hidden[ch.b]) continue;
      const sink = sinkFactory();
      walk([ref], res.chains, sink, false);
      segs.push(sink);
    }
  }
  return segs;
}

export function buildSVG(res, opt) {
  const { w: OW, h: OH } = opt.size;
  const kx = OW / res.W, ky = OH / res.H;
  const items = shapes(res, opt);
  const hidden = hiddenOf(res, opt);
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${OW}" height="${OH}" viewBox="0 0 ${OW} ${OH}">`);
  if (opt.gapFill) {
    const gw = num(opt.gapWidth || 1);
    parts.push(`<g fill="none" stroke-width="${gw}" stroke-linejoin="round" stroke-linecap="round">`);
    for (const it of items) {
      const d = [];
      for (const i of it.regions) for (const sk of gapStrokes(res, i, hidden, () => svgSink(kx, ky))) d.push(sk.text());
      if (d.length) parts.push(`<path stroke="${hex(it.color)}" d="${d.join('')}"/>`);
    }
    parts.push('</g>');
  }
  for (const it of items) {
    const sk = svgSink(kx, ky);
    for (const s of it.subs) walk(s.refs, res.chains, sk, true);
    parts.push(`<path fill="${hex(it.color)}" fill-rule="evenodd" d="${sk.text()}"/>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

// EPS 10 (PostScript Level 2, hanya path) — terbaca Illustrator, CorelDRAW, Affinity.
export function buildEPS(res, opt, title) {
  const { w: OW, h: OH } = opt.size;
  const kx = OW / res.W, ky = OH / res.H;
  const items = shapes(res, opt);
  const hidden = hiddenOf(res, opt);
  const L = [];
  L.push('%!PS-Adobe-3.0 EPSF-3.0');
  L.push('%%Creator: Vektor');
  L.push(`%%Title: ${String(title).replace(/[\r\n()]/g, '_')}`);
  L.push(`%%CreationDate: ${new Date().toISOString()}`);
  L.push(`%%BoundingBox: 0 0 ${OW} ${OH}`);
  L.push(`%%HiResBoundingBox: 0 0 ${OW} ${OH}`);
  L.push('%%DocumentData: Clean7Bit');
  L.push('%%LanguageLevel: 2');
  L.push('%%Pages: 1');
  L.push('%%EndComments');
  L.push('%%BeginProlog');
  L.push('/m {moveto} bind def /l {lineto} bind def /c {curveto} bind def /h {closepath} bind def');
  L.push('/rg {setrgbcolor} bind def /f {eofill} bind def /s {stroke} bind def');
  L.push('%%EndProlog');
  L.push('%%Page: 1 1');
  L.push('gsave');
  const col = (c) => c.map((v) => num(v / 255)).join(' ') + ' rg';
  if (opt.gapFill) {
    L.push(`${num(opt.gapWidth || 1)} setlinewidth 1 setlinejoin 1 setlinecap`);
    for (const it of items) {
      const sinks = [];
      for (const i of it.regions) sinks.push(...gapStrokes(res, i, hidden, () => epsSink(kx, ky, OH)));
      if (!sinks.length) continue;
      L.push(col(it.color));
      L.push('newpath');
      for (const sk of sinks) { sk.end(); L.push(...sk.out); }
      L.push('s');
    }
  }
  for (const it of items) {
    L.push(col(it.color));
    L.push('newpath');
    const sk = epsSink(kx, ky, OH);
    for (const s of it.subs) walk(s.refs, res.chains, sk, true);
    sk.end();
    L.push(...sk.out);
    L.push('f');
  }
  L.push('grestore');
  L.push('showpage');
  L.push('%%Trailer');
  L.push('%%EOF');
  return L.join('\n') + '\n';
}

// Isi <svg> untuk penampil (koordinat kerja, tanpa header).
export function previewMarkup(res, opt) {
  const items = shapes(res, opt);
  const parts = [];
  for (const it of items) {
    const sk = svgSink(1, 1);
    for (const s of it.subs) walk(s.refs, res.chains, sk, true);
    parts.push(`<path fill="${hex(it.color)}" fill-rule="evenodd" d="${sk.text()}"/>`);
  }
  return parts.join('');
}

export function outlineMarkup(res, hidden) {
  const h = hidden || defaultHidden(res);
  const sk = svgSink(1, 1);
  res.regions.forEach((r, i) => { if (!h[i]) for (const s of r.subs) walk(s.refs, res.chains, sk, true); });
  return `<path d="${sk.text()}"/>`;
}

// Path satu region (untuk sorotan saat kursor di atasnya).
export function regionPath(res, i) {
  const sk = svgSink(1, 1);
  for (const s of res.regions[i].subs) walk(s.refs, res.chains, sk, true);
  return sk.text();
}

export { hex };

// ---------------------------------------------------------------- ZIP
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function deflate(data) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const buf = await new Response(new Blob([data]).stream().pipeThrough(cs)).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

export async function makeZip(files, onProgress) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = enc.encode(f.name);
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(raw);
    const comp = await deflate(raw);
    const method = comp && comp.length < raw.length ? 8 : 0;
    const body = method === 8 ? comp : raw;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, method, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(lh.buffer, name, body);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, method, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + body.length;
    if (onProgress) onProgress((i + 1) / files.length);
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.byteLength;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end.buffer], { type: 'application/zip' });
}

export function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
