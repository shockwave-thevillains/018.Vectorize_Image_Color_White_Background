# Komponen pihak ketiga

| Komponen | Lokasi | Lisensi | Sumber |
| --- | --- | --- | --- |
| onnxruntime-web 1.22.0 (backend WASM) | `vendor/ort/` | MIT, © Microsoft Corporation | https://www.npmjs.com/package/onnxruntime-web |
| Model ISNet varian ilustrasi/anime (dikuantisasi 8-bit) | `models/isnet-anime-int8.onnx` | Apache-2.0 | https://github.com/SkyTNT/anime-segmentation (versi ONNX dari https://github.com/danielgatis/rembg) |

Model dipakai hanya untuk menilai apakah area putih di dalam gambar termasuk objek
atau latar (mode **AI** pada "Jadikan transparan"). Semua pemrosesan berjalan di browser.
