# Repository Guidelines

## Project Structure & Module Organization
- Root: `main.js`, `preload.js`, `package.json`, `.gitignore`.
- `main/`: EEG pipeline (`eeg_pipeline.js`) and DSP worker (`eeg_worker_js.js`).
- `renderer/`: UI (`index.html`), feature modules in `renderer/js/`, runtime assets in `renderer/gaze_assets/`, third‑party under `renderer/vendor/` (ignored by git).
- `scripts/`: utilities for vendors, addon rebuild, and pre‑dist checks.
- `src/`: native addon sources; outputs load from `build/Release/*.node`.
- Ignored: `build/`, `dist/`, `node_modules/`, any `vendor/`, `models/`, large binaries and logs.

## Build, Test, and Development Commands
- Convenience:
  - `npm run dev:win` (same as above), `npm run dev:trace` (extra diagnostics).
  - `npm run rebuild:addon` — rebuild native addon for installed Electron.
  - `npm run fetch:vendor` — stage vendor assets; copy available gaze assets.
  - `npm run dist` — package app (runs `predist` asset check first).

## Coding Style & Naming Conventions
- JavaScript/Node/Electron; use 2‑space indentation and semicolons.
- Files: prefer `lower_snake_case.js` (e.g., `gaze_engine.js`).
- Classes: `PascalCase`; functions/vars: `camelCase`; constants: `UPPER_SNAKE`.
- Avoid absolute paths; rely on preload bridges and `process.resourcesPath` logic already implemented.

## Testing Guidelines
- No formal test suite yet. Manual smoke tests:
  - Start BLE capture, observe `focus/relax` updates.
  - Validate VA numbers load (onnxruntime‑web) and change with input.
  - Verify gaze overlay and calibration flows.
- Prefer small, deterministic helpers in `renderer/js/` for unitizable logic.

## Commit & Pull Request Guidelines
- Messages: imperative, concise title + body if needed.
  - Example: `chore: prune large binaries; tighten .gitignore`.
- PRs: describe intent, link issues, add screenshots for UI changes.
- Never commit external deps or large assets: respect `.gitignore` (`build/`, `dist/`, `node_modules/`, any `vendor/`, `models/**`, `*.onnx`, `*.wasm`, logs).

## Security & Configuration Tips
- Keep models and vendor assets out of VCS; use `fetch:vendor` and local `models/`.
- For reproducible builds: run `npm run rebuild:addon` before `npm run dist`.

## Agent Execution Policy
- Autonomy: proceed with read/build/test/lint/format/package commands proactively; do not pause for confirmation.
- Escalation: when a command requires elevated permissions or network, request escalation with a concise justification and continue (no interactive prompt expected).
- Destructive ops: avoid unless explicitly requested; prefer backups or dry‑runs first (e.g., don’t `rm -rf` or `git reset --hard` without prior instruction).
- Search: prefer `rg` for file and text search; read files in chunks (≤250 lines).
- Preambles: keep short (1–2 sentences) and group related actions.
- Validation: in non‑interactive runs, execute targeted checks/tests as needed to verify changes.

## Preferred Codex CLI Settings
- `approval_policy`: `never` (non‑interactive; agent runs commands without asking).
- `sandbox_mode`: `workspace-write` (or `danger-full-access` if allowed).
- `network_access`: `enabled` when vendor/model fetch is required.
