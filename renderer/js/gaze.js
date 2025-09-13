// renderer/js/gaze.js
// L2CS gaze ONNX (onnxruntime-web).
// - GPU 优先（WebGPU > WebGL > WASM）
// - 输入自动适配 (默认 1x3x448x448 NCHW)
// - softmax + 期望 -> pitch/yaw（度）
// - 提供 provider 名称回调 onProvider

function gazeEPs() {
  const eps = [];
  if ('gpu' in navigator) eps.push('webgpu');
  try {
    const c = document.createElement('canvas');
    if (c.getContext('webgl2') || c.getContext('webgl')) eps.push('webgl');
  } catch {}
  eps.push('wasm');
  return eps;
}
function epNameFromList(eps){
  if (eps.includes('webgpu')) return 'WebGPU';
  if (eps.includes('webgl'))  return 'WebGL';
  return 'WASM';
}

export class GazePredictor {
  constructor(ui = {}) {
    this.session = null;
    this.inputName = '';
    this.useNCHW = true;

    this.setState = ui.setState || (()=>{});
    this.setYaw   = ui.setYaw   || (()=>{});
    this.setPitch = ui.setPitch || (()=>{});
    this.onProvider = ui.onProvider || (()=>{});

    this.MEAN = [0.485, 0.456, 0.406];
    this.STD  = [0.229, 0.224, 0.225];

    this.expW = 448;
    this.expH = 448;

    this._pending = false;
    this._last = { yaw: null, pitch: null };

    this._off = document.createElement('canvas');
    this._offCtx = this._off.getContext('2d', { willReadFrequently: true });

    this._lock = window.__ortRunLock;
    this._provider = '—';
  }

  reset() {
    this.setState('stopped');
    this.setYaw('--');
    this.setPitch('--');
    this._last = { yaw: null, pitch: null };
  }

  getLastAngles() { return this._last; }

  async ensureSession() {
    if (this.session) return;
    if (!window.ort) throw new Error('onnxruntime-web not loaded');
    this.setState('loading gaze model...');
    const buf = await window.va.readModel('models/mdsk_gaze_model.onnx');
    const eps = gazeEPs();
    this.session = await window.ort.InferenceSession.create(buf, { executionProviders: eps });

    this._provider = epNameFromList(eps);
    this.onProvider(this._provider);

    const name = this.session.inputNames[0];
    this.inputName = name;
    const meta = this.session.inputMetadata[name];
    const dims = meta?.dimensions?.slice() || [1, 3, 448, 448];

    if (dims.length === 4) {
      if (dims[1] === 3 || dims[1] === -1) {
        this.useNCHW = true;
        this.expH = isNum(dims[2]) ? dims[2] : 448;
        this.expW = isNum(dims[3]) ? dims[3] : 448;
      } else {
        this.useNCHW = false;
        this.expH = isNum(dims[1]) ? dims[1] : 448;
        this.expW = isNum(dims[2]) ? dims[2] : 448;
      }
    } else {
      this.useNCHW = true;
      this.expW = this.expH = 448;
    }

    this.setState(`gaze ready (${this._provider} ${this.expW}x${this.expH} ${this.useNCHW?'NCHW':'NHWC'})`);
  }

  async feed(faceCrop /* canvas */, bbPix /* 可选：bbox 仅用于调试 */) {
    if (!this.session) return;
    if (!faceCrop) { this._last = { yaw: null, pitch: null }; return; }
    if (this._pending) return;

    try {
      this._pending = true;

      const imgData = this._toExpectedImageData(faceCrop, this.expW, this.expH);
      const tensor  = this._toTensor(imgData, this.useNCHW);

      const out = await this._lock.run(() => this.session.run({ [this.inputName]: tensor }));

      const { pitchDeg, yawDeg } = this._parseAnglesDeg(out);
      // 不做镜像翻转：由 index.html 在绘制时整体镜像端点
      this._last = { yaw: yawDeg, pitch: pitchDeg };

      if (Number.isFinite(yawDeg))   this.setYaw((yawDeg >= 0 ? '+' : '') + yawDeg.toFixed(1));
      if (Number.isFinite(pitchDeg)) this.setPitch((pitchDeg >= 0 ? '+' : '') + pitchDeg.toFixed(1));
      this.setState('gaze running');
    } catch (e) {
      this.setState('Error: ' + String(e).slice(0, 160));
    } finally {
      this._pending = false;
    }
  }

  _toExpectedImageData(src, w, h) {
    if (isImageData(src)) {
      if (src.width === w && src.height === h) return src;
      this._off.width = w; this._off.height = h;
      this._offCtx.putImageData(src, 0, 0);
      return this._offCtx.getImageData(0, 0, w, h);
    } else if (isCanvas(src)) {
      this._off.width = w; this._off.height = h;
      this._offCtx.drawImage(src, 0, 0, w, h);
      return this._offCtx.getImageData(0, 0, w, h);
    } else {
      throw new Error('feed expects ImageData or Canvas');
    }
  }

  _toTensor(imgData, useNCHW) {
    const { data, width, height } = imgData;
    const N = width * height;

    if (useNCHW) {
      const arr = new Float32Array(1 * 3 * N);
      let p = 0;
      for (let i = 0; i < height; i++) {
        for (let j = 0; j < width; j++) {
          const idx = (i * width + j) * 4;
          const r = data[idx] / 255, g = data[idx+1] / 255, b = data[idx+2] / 255;
          arr[0 * N + p] = (r - this.MEAN[0]) / this.STD[0];
          arr[1 * N + p] = (g - this.MEAN[1]) / this.STD[1];
          arr[2 * N + p] = (b - this.MEAN[2]) / this.STD[2];
          p++;
        }
      }
      return new window.ort.Tensor('float32', arr, [1, 3, height, width]);
    } else {
      const arr = new Float32Array(1 * height * width * 3);
      let p = 0;
      for (let i = 0; i < height; i++) {
        for (let j = 0; j < width; j++) {
          const idx = (i * width + j) * 4;
          const r = data[idx] / 255, g = data[idx+1] / 255, b = data[idx+2] / 255;
          arr[p++] = (r - this.MEAN[0]) / this.STD[0];
          arr[p++] = (g - this.MEAN[1]) / this.STD[1];
          arr[p++] = (b - this.MEAN[2]) / this.STD[2];
        }
      }
      return new window.ort.Tensor('float32', arr, [1, height, width, 3]);
    }
  }

  _parseAnglesDeg(resultMap) {
    const outs = Object.values(resultMap);
    const cand = outs.filter(t => {
      const dims = t.dims || t.dims_;
      if (!dims) return false;
      const n = dims[dims.length - 1];
      return (dims.length >= 2 && n >= 30);
    });

    let pitchLogits = null, yawLogits = null, bins = 66;

    if (cand.length >= 2) {
      const t0 = cand[0], t1 = cand[1];
      const dims0 = t0.dims || t0.dims_;
      const dims1 = t1.dims || t1.dims_;
      const n0 = dims0[dims0.length - 1];
      const n1 = dims1[dims1.length - 1];
      bins = Math.min(n0, n1);
      pitchLogits = Array.from(t0.data).slice(0, bins);
      yawLogits   = Array.from(t1.data).slice(0, bins);
    } else if (cand.length === 1) {
      const t = cand[0];
      const dims = t.dims || t.dims_;
      const n = dims[dims.length - 1];
      bins = Math.floor(n / 2);
      const d = Array.from(t.data);
      pitchLogits = d.slice(0, bins);
      yawLogits   = d.slice(bins, bins * 2);
    } else {
      throw new Error('Cannot locate logits for pitch/yaw');
    }

    const angs = linspace(-99, 99, bins);
    const pitchSm = softmax(pitchLogits);
    const yawSm   = softmax(yawLogits);

    const pitchDeg = expectation(angs, pitchSm);
    const yawDeg   = expectation(angs, yawSm);
    return { pitchDeg, yawDeg };
  }
}

function isNum(v){ return typeof v === 'number' && isFinite(v) && v > 0; }
function isCanvas(x){ return x && typeof x.getContext === 'function'; }
function isImageData(x){ return x && typeof x.width === 'number' && typeof x.data === 'object'; }

function softmax(x) {
  const m = Math.max(...x);
  const ex = x.map(v => Math.exp(v - m));
  const s = ex.reduce((a,b)=>a+b,0) || 1;
  return ex.map(v => v / s);
}
function linspace(a, b, n) {
  if (n <= 1) return [a];
  const step = (b - a) / (n - 1);
  const out = new Array(n);
  for (let i=0;i<n;i++) out[i] = a + i*step;
  return out;
}
function expectation(values, probs) {
  let s = 0;
  for (let i=0;i<values.length && i<probs.length;i++) s += values[i]*probs[i];
  return s;
}
