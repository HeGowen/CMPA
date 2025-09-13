// main/eeg_worker_js.js
const FFT = require('fft.js');

class EEGWorkerJS {
  constructor() {
    this._tmp = null;
  }
  reset() { this._tmp = null; }

  computeFocusRelaxAndBands(cfg) {
    const {
      eeg, eogl, eogr, m1,
      sfreq = 250,
      lowcut = 1, highcut = 45,
      notchHz = 50,
      nperseg = 512, overlap = 0.5,
      base_focus = 10, base_relax = 10,
      K_focus = 1.0, K_relax = 1.0, K_eeg = 0.8
    } = cfg;

    if (!(eeg && eogl && eogr && m1)) return null;
    const N = Math.min(eeg.length, eogl.length, eogr.length, m1.length);
    if (N < Math.min(nperseg, 300)) return null; // 太短不算

    // 1) 参考重构
    const chEEG  = subtractRef(eeg, m1);
    const chEogl = subtractRef(eogl, m1);
    const chEogr = subtractRef(eogr, m1);

    // 2) 滤波：带通 + 陷波（零相位）
    const x1 = filtfiltSOS(chEEG,  SOS_BP_1_45);
    const y1 = filtfiltSOS(x1,     SOS_NOTCH_50);
    const x2 = filtfiltSOS(chEogl, SOS_BP_1_45);
    const y2 = filtfiltSOS(x2,     SOS_NOTCH_50);
    const x3 = filtfiltSOS(chEogr, SOS_BP_1_45);
    const y3 = filtfiltSOS(x3,     SOS_NOTCH_50);

    // 3) 计算各通道的频段比例（Welch）
    const r1 = bandRatiosWelch(y1, sfreq, nperseg, overlap);
    const r2 = bandRatiosWelch(y2, sfreq, nperseg, overlap);
    const r3 = bandRatiosWelch(y3, sfreq, nperseg, overlap);

    // 4) 融合（权重与 Python 相同）
    const fused = {};
    const bands = ['gamma','beta','alpha','theta','delta'];
    for (const b of bands) {
      fused[b] = K_eeg * r1[b] + ((1 - K_eeg) / 2) * r2[b] + ((1 - K_eeg) / 2) * r3[b];
    }
    // 归一化
    let total = 0; bands.forEach(b => total += fused[b]);
    if (Math.abs(total - 1) > 1e-6) bands.forEach(b => fused[b] /= (total || 1));

    // 5) 专注/放松
    // relax = alpha / (theta + alpha + beta)
    // focus = beta / (alpha + theta)
    let relax = fused.alpha / (fused.theta + fused.alpha + fused.beta);
    let focus = fused.beta  / (fused.alpha + fused.theta);

    relax = relax * 100 * K_relax + base_relax;
    focus = focus * 100 * K_focus + base_focus;
    if (relax > 100) relax = 100;
    if (focus > 100) focus = 100;

    return { bands: fused, focus, relax };
  }
}

/* ============ helper functions ============ */

function subtractRef(sig, ref) {
  const N = Math.min(sig.length, ref.length);
  const out = new Float64Array(N);
  for (let i=0;i<N;i++) out[i] = sig[i] - ref[i];
  return out;
}

// 4 阶带通(1–45Hz, fs=250) SOS（与 SciPy butter(N=4, [1,45], fs=250, output='sos') 一致）
const SOS_BP_1_45 = [
  [ 0.03104488104149389,  0.06208976208298778,  0.03104488104149389,  1.0, -0.4990467263306862, 0.10007711723409687 ],
  [ 1.0,                  2.0,                  1.0,                  1.0, -0.6451246216076395, 0.49949501895964214 ],
  [ 1.0,                 -2.0,                  1.0,                  1.0, -1.9526953019755659, 0.9533563176844042  ],
  [ 1.0,                 -2.0,                  1.0,                  1.0, -1.9808550759419668, 0.9814877079188342  ]
];

// 50 Hz 陷波 Q=30（与 SciPy iirnotch(50,30,fs=250) + tf2sos 一致）
const SOS_NOTCH_50 = [
  [ 0.9794827586206897, -0.6053536433986065, 0.9794827586206897, 1.0, -0.6053536433986065, 0.9589655172413794 ]
];

function filtfiltSOS(x, sos) {
  // 复制为 Float64Array
  const xi = (x instanceof Float64Array) ? x.slice() : new Float64Array(x);
  let y = xi;
  for (const sec of sos) y = lfilterSOS(y, sec);
  y = reverseInPlace(y);
  for (const sec of sos) y = lfilterSOS(y, sec);
  y = reverseInPlace(y);
  return y;
}

function lfilterSOS(x, sec) {
  const [b0,b1,b2,a0,a1,a2] = sec;
  const N = x.length;
  const y = new Float64Array(N);
  let z1 = 0, z2 = 0;
  // 采用 DF2T：w = x - a1*z1 - a2*z2; y = b0*w + b1*z1 + b2*z2
  for (let n=0;n<N;n++) {
    const w = x[n] - a1*z1 - a2*z2;
    const out = b0*w + b1*z1 + b2*z2;
    y[n] = out;
    z2 = z1;
    z1 = w;
  }
  return y;
}

function reverseInPlace(arr) {
  const N = arr.length;
  for (let i=0, j=N-1; i<j; i++, j--) {
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// Welch PSD + 频段比例
function bandRatiosWelch(x, fs, nperseg = 512, overlap = 0.5) {
  const bands = {
    gamma: [30, 45],
    beta:  [14, 30],
    alpha: [8,  14],
    theta: [4,  8],
    delta: [0.5,4]
  };

  const N = x.length;
  let seg = Math.min(nperseg, N);
  if (seg < 32) seg = N; // 极短

  const step = Math.max(1, Math.floor(seg * (1 - overlap)));
  const hann = hannWindow(seg);
  const U = hann.reduce((s,v)=> s + v*v, 0) / seg; // 窗函数功率归一化
  const fft = new FFT(seg);
  const out = fft.createComplexArray();
  const buf = fft.createComplexArray();

  const half = Math.floor(seg/2) + 1;
  const psd = new Float64Array(half).fill(0);
  let count = 0;

  for (let start = 0; start + seg <= N; start += step) {
    // 取段 & 去均值
    let mean = 0;
    for (let i=0;i<seg;i++) mean += x[start+i];
    mean /= seg;

    for (let i=0;i<seg;i++) {
      const v = (x[start+i] - mean) * hann[i];
      buf[2*i] = v;    // real
      buf[2*i+1] = 0;  // imag
    }

    fft.realTransform(out, buf);
    fft.completeSpectrum(out);

    // 功率谱（只取 0..half-1）
    for (let k=0;k<half;k++) {
      const re = out[2*k], im = out[2*k+1];
      const mag2 = re*re + im*im;
      psd[k] += mag2;
    }
    count++;
  }

  if (count === 0) {
    // 无法切段时退化为整段一次
    const seg0 = N;
    const fft0 = new FFT(seg0);
    const out0 = fft0.createComplexArray();
    const buf0 = fft0.createComplexArray();
    const hann0 = hannWindow(seg0);
    const U0 = hann0.reduce((s,v)=> s + v*v, 0) / seg0;
    let mean0 = 0; for (let i=0;i<seg0;i++) mean0 += x[i]; mean0 /= seg0;
    for (let i=0;i<seg0;i++) {
      const v = (x[i]-mean0) * hann0[i];
      buf0[2*i] = v; buf0[2*i+1]=0;
    }
    fft0.realTransform(out0, buf0); fft0.completeSpectrum(out0);
    const half0 = Math.floor(seg0/2)+1;
    const psd0 = new Float64Array(half0);
    for (let k=0;k<half0;k++) {
      const re = out0[2*k], im = out0[2*k+1];
      psd0[k] = re*re + im*im;
    }
    // 频率分辨率
    const df0 = fs / seg0;
    // 归一化到 PSD（比例足够，绝对值不重要）
    // Pxx = (1/(fs*U)) * |X|^2
    for (let k=0;k<half0;k++) psd0[k] = psd0[k] / (fs * (U0 || 1));
    return integrateBands(psd0, df0, bands);
  }

  // 平均 + 归一化
  for (let k=0;k<psd.length;k++) psd[k] = psd[k] / count / (fs * (U || 1));
  const df = fs / seg;

  return integrateBands(psd, df, bands);
}

function hannWindow(n) {
  const w = new Float64Array(n);
  for (let i=0;i<n;i++) w[i] = 0.5 * (1 - Math.cos(2*Math.PI*i/(n-1)));
  return w;
}

function integrateBands(Pxx, df, bands) {
  const frq = (k) => k * df;
  let total = 0;
  const bp = {};
  for (const [name, [lo, hi]] of Object.entries(bands)) {
    let s = 0;
    for (let k=0;k<Pxx.length;k++) {
      const f = frq(k);
      if (f >= lo && f <= hi) s += Pxx[k];
    }
    bp[name] = s * df;
    total += bp[name];
  }
  // 转比例
  for (const k of Object.keys(bp)) bp[k] = total > 0 ? (bp[k] / total) : 0;
  return bp;
}

module.exports = { EEGWorkerJS };
