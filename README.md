# Vektor — batch vectorizer di browser

Ubah gambar raster (PNG/JPG/WEBP) menjadi **SVG** dan **EPS 10** sekaligus banyak file.
Semua proses berjalan di browser (Web Worker); tidak ada file yang diunggah ke server,
jadi bisa di-host gratis di GitHub Pages.

## Fitur

- **Batch**: seret banyak gambar sekaligus (atau tempel dari clipboard). Diproses paralel.
- **Mode Warna atau Siluet**
  - *Warna*: palet otomatis (atau dibatasi), cocok untuk ilustrasi flat.
  - *Siluet*: 2 warna (hitam pekat + putih) dengan ambang gelap/terang yang bisa diatur — untuk stensil, emblem, siluet. Rongga di dalam siluet bisa **Transparan**, **Isi** (siluet padat), atau **Putih**.
- **Upscale sebelum tracing** (default 4×) agar batas warna jatuh di posisi sub-piksel.
- **Latar putih → transparan**
  - *Luar*: hanya putih yang tersambung ke tepi gambar (dengan penutup celah garis, jadi tidak bocor ke dalam objek).
  - *Pintar* (default): putih luar + putih terkurung yang termasuk latar (antara kaki, rangka kursi, dsb.). Putih milik objek tetap.
  - *Semua*: semua area putih.
  - Klik bentuk mana pun di pratinjau untuk menghapus/mengembalikannya, **langsung tanpa proses ulang** (bentuk disorot saat kursor di atasnya). Urungkan/ulangi: Ctrl+Z / Ctrl+Shift+Z.
- **Ukuran output microstock**: 15 / 20 / 25 / 30 MP, kustom (≥15 MP), atau asli. Artboard dan koordinat kurva diskalakan.
- **Kode nama file**: `[kode]_[urutan]_[nama_awal]`, mis. `011_1_600_01_stencil_voids_emblem.svg`.
- **Format unduhan**: SVG + EPS (`SVG/` dan `EPS/` dalam satu ZIP), hanya SVG, atau hanya EPS.
- **Palet per gambar**: ganti warna atau jadikan transparan.
- **Penampil**: Bandingkan (geser), Vektor, Garis (outline), zoom, 1:1, lensa piksel.
- **Susunan**: Tumpuk (bentuk bersarang tanpa retak) atau Potong (tanpa tumpang tindih), plus pengisi celah opsional.

## Cara kerja tracing

1. **Penghalusan searah garis**: arah tiap tepi dihitung (tensor struktur), lalu warna dirata-ratakan sepanjang garis — getaran tepi akibat kompresi hilang tanpa menipiskan garis.
2. **Palet** dibangun dari piksel "rata". Piksel transisi/antialias diabaikan, lalu varian minor (mis. tepi garis yang lebih gelap karena kompresi) dilebur.
3. **Upscale** dengan interpolasi halus.
4. **Benih + region growing**: piksel yang jelas cocok dengan palet dan tidak berada di lereng gradien menjadi benih. Piksel transisi diberikan ke warna tetangga terdekat, sehingga batas jatuh di titik 50%.
5. **Pembersihan**: bintik kecil dilebur ke tetangga yang warnanya paling mirip.
6. **Tracing pada kisi sudut piksel**: batas antar dua region dipecah menjadi rantai di titik pertemuan ≥3 region. Tiap rantai di-fit **sekali** dan dipakai kedua sisinya, jadi tidak ada celah atau tumpang tindih.
7. **Fitting**: deteksi sudut, garis lurus, Bézier kubik (Schneider), dan elips utuh.

## Menjalankan lokal

Tidak perlu build. Cukup sajikan folder ini dengan server statis apa pun:

```sh
python3 -m http.server 8000
# buka http://localhost:8000/
```

(Membuka `index.html` langsung via `file://` tidak bisa karena Web Worker dan ES module.)

## Deploy ke GitHub Pages

1. Repo → **Settings → Pages**.
2. *Source*: **Deploy from a branch**. Pilih branch ini, folder **/ (root)**, lalu **Save**.
3. Situs akan aktif di `https://<user>.github.io/<nama-repo>/`.

## Struktur

| File | Isi |
| --- | --- |
| `index.html` | Markup antarmuka |
| `styles.css` | Gaya (terang/gelap otomatis) |
| `app.js` | Antrean, worker pool, penampil, panel pengaturan, unduhan |
| `worker.js` | Mesin tracing (palet, upscale, label, tracing, fitting) |
| `export.js` | Penyusun SVG/EPS dan penulis ZIP (tanpa dependensi) |

Browser yang didukung: Chrome/Edge 103+, Firefox 113+, Safari 16.4+.
