CMPA (EEG + Gaze + VA)

Overview
- Electron-based app for EEG BLE capture and real-time metrics.
- Implements focus/relax (EEG), gaze tracking, and valence/arousal (ONNX Runtime).
- Eye‑tracking vendor dependencies are staged locally for packaging; integration work is ongoing.

Run (Dev)
- Your workflow (kept intact):
  - PowerShell
  - `$env:ELECTRON_OVERRIDE_DIST_PATH = (Resolve-Path ".\node_modules\electron\dist").Path`
  - `$env:ELECTRON_ENABLE_LOGGING = "1"`
  - `npm start`
- Convenience scripts:
  - `npm run dev:win` — sets the same env vars and launches Electron.
  - `npm run dev:trace` — same as above with extra diagnostics.
  - `npm run rebuild:addon` — rebuilds the native addon for your installed Electron version.

Build (Packaging)
- `npm run dist` — builds Windows NSIS installer and portable.
- Ensure vendor assets and models exist on disk before building (see Assets).

Assets
- External dependencies are not tracked in git. Populate locally before run/build:
  - Vendor (WebAssembly/libs) under `renderer/vendor/**`.
  - Models under `models/` (e.g., `enet_b0_8_va_mtl.onnx`, `mdsk_gaze_model.onnx`).
- Helpers:
  - `npm run fetch:vendor` — runs `scripts/fetch_vendor.ps1` to fetch/copy required vendor files and copy available gaze assets from `gaze_tracking/` to `renderer/gaze_assets/`.
  - Place model files manually into `models/` (kept out of VCS). The app and packaging will include them if present.

Repository Hygiene
- `.gitignore` excludes: `build/`, `dist/`, `.userData/`, `.usrData/`, `node_modules/`, any `vendor/`, and large/binary assets (`models/**`, `*.onnx`, `*.npy`, `*.tflite`, `*.wasm`, `*.binarypb`, `*.pdb`, `*.obj`) and gaze logs.

Status
- Focus/Relax: implemented in JS (`main/eeg_pipeline.js`, `main/eeg_worker_js.js`).
- Valence/Arousal: implemented in `renderer/js/va.js` using `onnxruntime-web`.
- Gaze tracking: implemented under `renderer/js/*`; calibration assets under `renderer/gaze_assets/`.
- Eye‑tracking integration: dependencies staged, still under active development.

