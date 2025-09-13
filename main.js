// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let win;
let addon;
let instance;

// === [新增] 引入 EEG 计算管线（保持你提供的 JS 版本，文件不改） ===
const { EEGPipeline } = require(path.join(__dirname, 'main', 'eeg_pipeline'));
let eegPipeline = null;

function createWindow() {
  // IMPORTANT: sandbox must be false so preload can use Node.js (fs, path, etc.)
  win = new BrowserWindow({
    width: 800,
    height: 640,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // keep renderer isolated
      nodeIntegration: false,   // no Node in renderer
      sandbox: false            // allow Node in PRELOAD (fixes "module not found: fs")
    }
  });

  // Helpful diagnostics for preload failures
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[main] preload-error:', preloadPath, error);
  });

  win.once('ready-to-show', () => win.show());

  const htmlPath = path.join(__dirname, 'renderer', 'index.html');
  console.log('[main] loadFile:', htmlPath);
  win.loadFile(htmlPath)
    .then(() => console.log('[main] loadFile done'))
    .catch(err => console.error('[main] loadFile error:', err));

  win.webContents.on('did-finish-load', () => {
    console.log('[main] did-finish-load');
  });
}

// 统一发消息到 renderer
function trySend(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function attachNativeCallbacks() {
  if (!instance || instance._callbacksAttached) return;

  // 状态回调：转发给 UI，同时驱动 EEG 管线启停
  instance.onStatus((s) => {
    trySend('ble:status', s);
    if (s === 'collecting') {
      eegPipeline && eegPipeline.start();
    }
    if (s === 'stopped' || s === 'start command failed' || s === 'device not found') {
      eegPipeline && eegPipeline.stop();
    }
  });

  // 数据回调：转发统计到 UI；如果有原始字节，则喂给 EEG 管线
  instance.onData((d) => {
    trySend('ble:data', d);

    // === [关键] 把原始 EEG 包送入管线 ===
    // 你的 native 回调如果带有 d.raw（Buffer/ArrayBuffer/Uint8Array），这里就能用。
    // 不改动 C++：若 d.raw 不存在则跳过（UI 仍正常显示字节/样本统计）。
    try {
      if (eegPipeline && d && d.lastPacketBytes > 0) {
        const raw = d.raw || d._raw;
        if (raw) {
          // 统一成 Node Buffer / Uint8Array
          if (raw instanceof Uint8Array) {
            eegPipeline.pushBlePacket(raw);
          } else if (Buffer.isBuffer(raw)) {
            eegPipeline.pushBlePacket(raw);
          } else if (raw.buffer && raw.byteLength !== undefined) {
            eegPipeline.pushBlePacket(new Uint8Array(raw));
          }
        }
      }
    } catch (e) {
      // 静默，不影响 BLE/UI
      // console.error('[main] EEG push error:', e);
    }
  });

  instance._callbacksAttached = true;
}

app.whenReady().then(() => {
  console.log('[main] whenReady');

  // 加载 native addon（非致命）
  try {
    const modPath = path.join(__dirname, 'build', 'Release', 'ble_capture.node');
    console.log('[main] loading addon...');
    addon = require(modPath);
    console.log('[main] addon loaded OK from:', modPath);
    instance = new addon.Addon();
  } catch (e) {
    console.error('[main] addon load failed:', e);
  }

  // === [新增] 启动 EEG 管线（主进程），把结果透传到渲染端 ===
  eegPipeline = new EEGPipeline({
    onMetrics: (m) => trySend('eeg:metrics', m), // { focus, relax, ts }
    onBands:   (b) => trySend('eeg:bands', b)    // { gamma,beta,alpha,theta,delta, ts }
  });

  createWindow();
});

// IPC bridge to native addon（保持原逻辑，附加重置 EEG）
ipcMain.handle('ble:start', (_evt, opts) => {
  console.log('[main] ble:start', opts);
  if (!instance) return { ok: false, err: 'native addon not loaded' };
  try {
    eegPipeline && eegPipeline.reset();
    instance.startCapture(opts);
    return { ok: true };
  } catch (e) {
    console.error('[main] startCapture error:', e);
    return { ok: false, err: e?.message || String(e) };
  }
});

ipcMain.handle('ble:stop', () => {
  console.log('[main] ble:stop');
  if (!instance) return { ok: true };
  try {
    instance.stopCapture();
    eegPipeline && eegPipeline.stop();
    return { ok: true };
  } catch (e) {
    console.error('[main] stopCapture error:', e);
    return { ok: false, err: e?.message || String(e) };
  }
});

app.on('browser-window-created', () => {
  attachNativeCallbacks();
});

// Debug log relay from renderer to main console
ipcMain.on('dbg:log', (_evt, ...args) => {
  try { console.log('[renderer]', ...args); } catch {}
});

app.on('window-all-closed', () => {
  app.quit();
});

process.on('uncaughtException', (err) => console.error('[main] uncaughtException:', err));
process.on('unhandledRejection', (r) => console.error('[main] unhandledRejection:', r));
