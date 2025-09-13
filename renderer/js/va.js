// renderer/js/va.js
// VA 使用 onnxruntime-web，默认走 WASM(proxy) 与 Gaze 分流；可切开关 USE_GPU_FOR_VA
function vaEPs() {
  if (window.USE_GPU_FOR_VA) {
    const eps = [];
    if ('gpu' in navigator) eps.push('webgpu');
    try {
      const c = document.createElement('canvas');
      if (c.getContext('webgl2') || c.getContext('webgl')) eps.push('webgl');
    } catch {}
    eps.push('wasm');
    return eps;
  } else {
    const eps = ['wasm'];
    try {
      const c = document.createElement('canvas');
      if (c.getContext('webgl2') || c.getContext('webgl')) eps.push('webgl');
    } catch {}
    return eps;
  }
}
function epNameFromList(eps){
  if (eps.includes('webgpu')) return 'WebGPU';
  if (eps.includes('webgl'))  return 'WebGL';
  return 'WASM';
}

export class VAPredictor {
  constructor(ui = {}) {
    this.session = null;
    this.inputName = '';
    this.useNCHW = true;

    this.setState = ui.setState || (()=>{});
    this.setV = ui.setV || (()=>{});
    this.setA = ui.setA || (()=>{});
    this.setD = ui.setD || (()=>{});
    this.setNote = ui.setNote || (()=>{});
    this.onProvider = ui.onProvider || (()=>{});

    this.IMG = 224;
    this.MEAN = [0.485, 0.456, 0.406];
    this.STD  = [0.229, 0.224, 0.225];

    this._pending = false;
    this._lock = window.__ortRunLock;
    this._provider = '—';
  }

  reset() {
    this.setState('stopped');
    this.setV('--'); this.setA('--');
    this.setNote('—');
  }

  async ensureSession() {
    if (this.session) return;
    if (!window.ort) throw new Error('onnxruntime-web not loaded');

    this.setState('loading model...');
    const buf = await window.va.readModel('models/enet_b0_8_va_mtl.onnx');
    const eps = vaEPs();
    this.session = await window.ort.InferenceSession.create(buf, { executionProviders: eps });

    this._provider = epNameFromList(eps);
    this.onProvider(this._provider);

    const name = this.session.inputNames[0];
    this.inputName = name;
    const meta = this.session.inputMetadata[name];
    const dims = meta && meta.dimensions ? meta.dimensions.slice() : [1, 3, 224, 224];
    this.useNCHW = (dims.length === 4 && dims[1] === 3);

    this.setState(`model ready (${this._provider})`);
  }

  // 接受 224x224 的 ImageData 或 null
  async feed(imgData) {
    if (!this.session) return;
    if (this._pending) return;
    if (!imgData) { this.setV('--'); this.setA('--'); return; }

    try {
      this._pending = true;
      const tensor = this._toTensor(imgData);

      const out = await this._lock.run(() => this.session.run({ [this.inputName]: tensor }));

      let [v, a] = this._parseVA(out);
      v = Math.max(-1, Math.min(1, v));
      a = Math.max(-1, Math.min(1, a));
      this.setV((v >= 0 ? '+' : '') + v.toFixed(2));
      this.setA((a >= 0 ? '+' : '') + a.toFixed(2));
      this.setNote('');
    } catch (e) {
      this.setNote(String(e).slice(0, 160));
    } finally {
      this._pending = false;
    }
  }

  _toTensor(imgData) {
    const { data, width, height } = imgData;
    const N = width * height;

    if (this.useNCHW) {
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

  _parseVA(resultMap) {
    const outs = Object.values(resultMap);
    for (const t of outs) {
      const d = t.data, dims = t.dims || t.dims_;
      if (dims && dims.length === 2 && dims[0] === 1 && dims[1] === 2) return [Number(d[0]), Number(d[1])];
      if (dims && dims.length === 1 && dims[0] === 2) return [Number(d[0]), Number(d[1])];
    }
    for (const t of outs) {
      const d = t.data, dims = t.dims || t.dims_;
      if (dims && dims.length === 2 && dims[0] === 1 && dims[1] >= 2) {
        const n = dims[1]; return [Number(d[n-2]), Number(d[n-1])];
      }
    }
    throw new Error('Cannot locate VA from outputs');
  }
}
