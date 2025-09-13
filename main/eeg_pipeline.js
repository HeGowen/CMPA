// main/eeg_pipeline.js
const path = require('path');
const { EEGWorkerJS } = require(path.join(__dirname, 'eeg_worker_js'));

class EEGPipeline {
  constructor(cb = {}) {
    // 回调
    this.onMetrics = cb.onMetrics || (()=>{});
    this.onBands   = cb.onBands   || (()=>{});

    // 参数
    this.sfreq = 250;         // 采样率（设备为 250Hz）
    this.windowSec = 5;       // 分析窗口 5 秒（稳 + 低延迟）
    this.hopSec = 1;          // 每 1 秒更新一次
    this.windowSamples = this.windowSec * this.sfreq;

    // 环形缓冲（4 通道：EEG, EOG-L, EOG-R, M1）
    this.buffers = [[], [], [], []];

    // 定时器
    this._timer = null;

    // 计算器
    this.worker = new EEGWorkerJS();
  }

  reset() {
    this.buffers = [[], [], [], []];
    this.worker.reset();
  }
  start() {
    if (this._timer) return;
    const tick = async () => {
      try {
        // 检查数据长度
        const N = Math.min(this.buffers[0].length, this.buffers[1].length, this.buffers[2].length, this.buffers[3].length);
        if (N >= this.windowSamples) {
          // 取最近 5s 窗口
          const s = N - this.windowSamples;
          const eeg  = this.buffers[0].slice(s);
          const eogl = this.buffers[1].slice(s);
          const eogr = this.buffers[2].slice(s);
          const m1   = this.buffers[3].slice(s);

          const out = this.worker.computeFocusRelaxAndBands({
            eeg, eogl, eogr, m1,
            sfreq: this.sfreq,
            lowcut: 1, highcut: 45,
            notchHz: 50,
            nperseg: 512, overlap: 0.5,
            base_focus: 10, base_relax: 10,
            K_focus: 1.0, K_relax: 1.0, K_eeg: 0.8
          });

          if (out) {
            const { bands, focus, relax } = out;
            this.onMetrics({ focus, relax, ts: Date.now() });
            this.onBands({ ...bands, ts: Date.now() });
          }

          // 丢弃 1s 的旧数据（步长 = 1s）
          const drop = this.hopSec * this.sfreq;
          for (let c=0;c<4;c++) this.buffers[c].splice(0, drop);
        }
      } catch (e) {
        // 静默：不中断采集
        // console.error('[eeg] tick error', e);
      }
    };
    this._timer = setInterval(tick, this.hopSec * 1000);
  }
  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // 解析 BLE 原始包：EEG 帧格式 [0xFC, 0xFA, ... 12B × samples]，4ch × 3B/样本
  pushBlePacket(buffer) {
    if (!buffer || buffer.byteLength < 8) return; // 保守
    const u8 = new Uint8Array(buffer);
    if (!(u8[0] === 0xFC && u8[1] === 0xFA)) return; // 仅处理 EEG
    const bodyOff = 6; // 前导头(经验)
    if (u8.length <= bodyOff) return;

    const body = u8.subarray(bodyOff);
    const sampleStride = 12; // 4ch × 3B
    const samples = Math.floor(body.length / sampleStride);
    if (samples <= 0) return;

    // 解析 24-bit little-endian -> signed int
    let idx = 0;
    for (let i=0;i<samples;i++) {
      for (let ch=0; ch<4; ch++) {
        const b0 = body[idx++], b1 = body[idx++], b2 = body[idx++];
        let v = (b0 | (b1 << 8) | (b2 << 16));
        if (v & 0x800000) v |= 0xff000000; // 符号扩展到 32-bit
        // 简单缩放（单位比例对谱比值不影响）
        const f = v; 
        this.buffers[ch].push(f);
      }
    }

    // 控制缓冲上限（最多保留 20s，足够 2 次窗口）
    const maxKeep = (this.windowSec + 15) * this.sfreq;
    for (let c=0;c<4;c++) {
      if (this.buffers[c].length > maxKeep) {
        this.buffers[c].splice(0, this.buffers[c].length - maxKeep);
      }
    }
  }
}

module.exports = { EEGPipeline };
