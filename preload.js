// preload.js
// Bridge safe APIs into renderer (contextIsolation: true).
const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// ---- figure out renderer base (dev/prod都可用) ----
function getRendererBase() {
  const cands = [
    path.join(process.cwd(), 'renderer'),
    path.join(__dirname, 'renderer'),
    process.cwd(),
    __dirname,
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return process.cwd();
}
const RENDERER_BASE = getRendererBase();

function relOrThrow(p) {
  if (path.isAbsolute(p)) throw new Error('Absolute path not allowed: ' + p);
  return p.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}
function candidates(rel) {
  const r = relOrThrow(rel);
  const list = [
    path.join(RENDERER_BASE, r),           // 👈 首选：renderer/
    path.join(process.cwd(), r),
    path.join(__dirname, r),
  ];
  if (process.resourcesPath) {
    list.push(
      path.join(process.resourcesPath, r),
      path.join(process.resourcesPath, 'app.asar', r),
      path.join(process.resourcesPath, 'app.asar.unpacked', r),
    );
  }
  return list;
}

// ---- fsio (只暴露一次；包含 readText/readBin/ensureDir/writeText/appendText) ----
const fsio = {
  readText: (rel) => {
    const tries = candidates(rel);
    for (const p of tries) {
      try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } catch {}
    }
    console.error('[preload/fsio] readText not found:', rel, 'tried:', tries);
    throw new Error('readText not found: ' + rel);
  },
  readBin: (rel) => {
    const tries = candidates(rel);
    for (const p of tries) {
      try {
        if (fs.existsSync(p)) {
          const b = fs.readFileSync(p);
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        }
      } catch {}
    }
    console.error('[preload/fsio] readBin not found:', rel, 'tried:', tries);
    throw new Error('readBin not found: ' + rel);
  },
  ensureDir: (relDir) => {
    const rp = relOrThrow(relDir);
    const full = path.join(RENDERER_BASE, rp);
    fs.mkdirSync(full, { recursive: true });
  },
  writeText: (rel, s) => {
    const rp = relOrThrow(rel);
    const full = path.join(RENDERER_BASE, rp);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, s, 'utf8');
  },
  appendText: (rel, s) => {
    const rp = relOrThrow(rel);
    const full = path.join(RENDERER_BASE, rp);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.appendFileSync(full, s, 'utf8');
  },
};
contextBridge.exposeInMainWorld('fsio', fsio);

// ---- BLE bridge ----
contextBridge.exposeInMainWorld('ble', {
  start: (opts) => ipcRenderer.invoke('ble:start', opts),
  stop:  () => ipcRenderer.invoke('ble:stop'),
  onStatus: (cb) => ipcRenderer.on('ble:status', (_e, s) => cb && cb(s)),
  onData:   (cb) => ipcRenderer.on('ble:data',   (_e, d) => cb && cb(d)),
});

// ---- EEG metrics bridge ----
contextBridge.exposeInMainWorld('eeg', {
  onMetrics: (cb) => ipcRenderer.on('eeg:metrics', (_e, m) => cb && cb(m)),
  onBands:   (cb) => ipcRenderer.on('eeg:bands',   (_e, b) => cb && cb(b)),
});

// ---- Debug log bridge (renderer -> main console) ----
contextBridge.exposeInMainWorld('dbg', {
  log: (...args) => ipcRenderer.send('dbg:log', ...args),
});

// ---- VA helper: read model bytes ----
async function readModel(rel) {
  const tries = candidates(rel);
  for (const p of tries) {
    try {
      if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
    } catch {}
  }
  throw new Error('Model not found: ' + rel);
}
contextBridge.exposeInMainWorld('va', { readModel });

// ---- gaze JSONL log (相对 renderer/ 写入) ----
let _gazeLog = null;
contextBridge.exposeInMainWorld('gazeLog', {
  open: (relDir, prefix='gaze') => {
    try {
      const rp = relOrThrow(relDir);
      const dir = path.join(RENDERER_BASE, rp);
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date();
      const name = `${prefix}_${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}_${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}${String(ts.getSeconds()).padStart(2,'0')}.jsonl`;
      const full = path.join(dir, name);
      fs.writeFileSync(full, '', 'utf8');
      _gazeLog = full;
      return { ok:true, file:full };
    } catch(e) { return { ok:false, err: e?.message || String(e) }; }
  },
  append: (obj) => {
    if (!_gazeLog) return { ok:false, err:'no log opened' };
    try { fs.appendFileSync(_gazeLog, JSON.stringify(obj)+'\n', 'utf8'); return { ok:true }; }
    catch(e){ return { ok:false, err: e?.message || String(e) }; }
  },
  close: () => { _gazeLog = null; return { ok:true }; }
});
