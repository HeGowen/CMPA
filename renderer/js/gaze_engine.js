// renderer/js/gaze_engine.js
// 3D Gaze engine (ESM). 仅使用本地资源（相对 renderer/），无 CDN 回退。
// 需要全局：cv(OpenCV.js), FaceMesh(本地 face_mesh.js), jsyaml
// 需要 preload 暴露：window.fsio.readText/readBin（仅此，不要重名覆盖）

import { parseNPY } from './npy.js';

class GazeEngineJS {
  constructor(opts = {}) {
    this.opts = Object.assign({
      // 若未带 renderer/ 前缀，会在读取前自动补上
      cameraYamlPath: 'renderer/gaze_assets/camera_calibration_matrix.yaml',
      calibYamlPath:  'renderer/gaze_assets/individualized_calibration.yaml',
      faceModelPath:  'renderer/gaze_assets/face_model_all.npy',
      calibMode: 'poly2',
      monitorMM: [345, 215],       // 物理尺寸，单位 mm
      monitorPixels: [1920, 1200],  // 画布像素
      screenYOffsetMM: 0,
      // 调试：true 则每帧输出详细中间量
      debug: true
    }, opts);

    // 只接受通过 index.html 传入的相对路径；这里兜底补 renderer/ 前缀
    this._norm = (rel) => {
      if (!rel) return rel;
      if (rel.startsWith('renderer/')) return rel;
      return 'renderer/' + rel.replace(/^\.?\/*/, '');
    };
    this.paths = {
      cam: this._norm(this.opts.cameraYamlPath),
      calib: this._norm(this.opts.calibYamlPath),
      face: this._norm(this.opts.faceModelPath),
    };

    // 引擎状态
    this._ready = false;
    this._status = 'idle';

    // FaceMesh offscreen
    this._cvs = document.createElement('canvas');
    this._ctx = this._cvs.getContext('2d');

    // 7点（与 Python 相同）
    this.LANDMARK_IDS = [33, 133, 362, 263, 61, 291, 1];

    // 缓冲
    this.buf = { landmarks: [], rvec: [], tvec: [], gaze: [] };
    this.bufMax = { landmarks: 3, rvec: 3, tvec: 3, gaze: 10 };

    // 相机参数
    this.K = null;      // Float64Array[9]
    this.dist = null;   // Float64Array[>=4]
    // 面部模型
    this.faceModelAll = null; // Float32Array [468*3]
    this.faceModel7   = null; // Float32Array [7*3]

    // 显示器参数
    const [mmW, mmH] = this.opts.monitorMM;
    const [pxW, pxH] = this.opts.monitorPixels;
    const off        = this.opts.screenYOffsetMM || 0;
    this.setMonitor(mmW, mmH, pxW, pxH, off);

    // 校准
    this._applyCalib = (xy) => new Float32Array(xy); // 默认 identity
  }

  // —— 小工具：日志 —— //
  log(...a){ console.log('[gaze-engine]', ...a); }
  warn(...a){ console.warn('[gaze-engine]', ...a); }
  err(...a){ console.error('[gaze-engine]', ...a); }
  dbg(...a){ if (this.opts.debug) console.log('[gaze-engine][DBG]', ...a); }

  // —— 对外可见 —— //
  getStatus(){ return this._status; }
  get ready(){ return this._ready; }

  setMonitor(mmW, mmH, pxW, pxH, yOffMM=0) {
    this.mon_mm = [Number(mmW||0), Number(mmH||0)];
    this.mon_px = [Number(pxW||0), Number(pxH||0)];
    this.y_off  = Number(yOffMM||0);
    this.dbg('Monitor set mm=', this.mon_mm, 'px=', this.mon_px, 'yOff=', this.y_off);
  }

  // —— 数组打印 —— //
  _fmtArr(arr, n=3, max=9) {
    if (!arr) return '[]';
    const a = Array.from(arr).slice(0, max).map(x => Number(x).toFixed(n));
    return '[' + a.join(', ') + (arr.length>max?' ...':'') + ']';
  }
  _fmtMat(arr, rows, cols, n=3) {
    const out = [];
    for (let r=0; r<rows; r++) {
      const row = [];
      for (let c=0; c<cols; c++) row.push(Number(arr[r*cols+c]).toFixed(n));
      out.push(row.join('\t'));
    }
    return '\n' + out.join('\n');
  }

  // ========= 资源加载 ========= //
  async _ensureFaceMesh() {
    if (typeof FaceMesh === 'undefined') {
      throw new Error('FaceMesh global missing, ensure renderer/vendor/mediapipe/face_mesh/face_mesh.js loaded');
    }
    // 兼容 FaceMesh(fn) 与 FaceMesh.FaceMesh(fn)
    let fm = null;
    try {
      fm = new FaceMesh({ locateFile: (f) => 'renderer/vendor/mediapipe/face_mesh/' + f });
      this.log('FaceMesh ready (local assets) via FaceMesh(fn)');
    } catch {
      fm = new FaceMesh.FaceMesh({ locateFile: (f) => 'renderer/vendor/mediapipe/face_mesh/' + f });
      this.log('FaceMesh ready (local assets) via FaceMesh.FaceMesh(fn)');
    }
    fm.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
      modelComplexity: 1
    });
    this.fm = fm;
  }

  _parseCameraYaml(txt) {
    const y = (typeof jsyaml !== 'undefined') ? jsyaml.load(txt) : null;
    if (!y) throw new Error('YAML parse failed');

    let K = null, dist = null;

    // OpenCV FileStorage 风格
    if (y.camera_matrix && y.camera_matrix.data && Array.isArray(y.camera_matrix.data) && y.camera_matrix.data.length === 9) {
      K = new Float64Array(y.camera_matrix.data);
    }
    if (!K && Array.isArray(y.camera_matrix) && y.camera_matrix.length === 3 && Array.isArray(y.camera_matrix[0])) {
      K = new Float64Array([
        y.camera_matrix[0][0], y.camera_matrix[0][1], y.camera_matrix[0][2],
        y.camera_matrix[1][0], y.camera_matrix[1][1], y.camera_matrix[1][2],
        y.camera_matrix[2][0], y.camera_matrix[2][1], y.camera_matrix[2][2]
      ]);
    }
    if (!K && Array.isArray(y.K) && y.K.length === 9) {
      K = new Float64Array(y.K);
    }

    // 畸变名的兼容
    const pickDist = (node) => {
      if (!node) return null;
      if (node.data && Array.isArray(node.data)) return new Float64Array(node.data);
      if (Array.isArray(node) && Array.isArray(node[0])) return new Float64Array(node[0]);
      if (Array.isArray(node)) return new Float64Array(node);
      return null;
    };
    dist = pickDist(y.dist_coeffs) || pickDist(y.dist_coeff) || pickDist(y.dist);

    if (!K) throw new Error('no camera_matrix/K found in YAML');
    if (!dist) { this.warn('no dist coeffs found in YAML, using zeros'); dist = new Float64Array([0,0,0,0,0]); }

    return { K, dist };
  }

  async _loadCameraYaml() {
    const rel = this.paths.cam;
    const txt = await window.fsio.readText(rel);
    const { K, dist } = this._parseCameraYaml(txt);
    this.K = K; this.dist = dist;
    this.log(`Camera YAML loaded: ${rel} K= ${Array.from(K).map(n=>+n.toFixed(2)).join(',')}`);
  }

  async _loadFaceModel() {
    const rel = this.paths.face;
    const buf = await window.fsio.readBin(rel);
    const npy = parseNPY(buf); // {shape:[468,3], data: Float32Array}
    if (!npy || !npy.data || npy.shape[0] !== 468 || npy.shape[1] !== 3) {
      throw new Error('Invalid face_model_all.npy (expect 468x3 float)');
    }
    const f = new Float32Array(npy.data.length);
    f.set(npy.data);
    // Python 同步：减去点1，翻转 Y/Z，放大10
    const baseX = f[1*3+0], baseY = f[1*3+1], baseZ = f[1*3+2];
    for (let i=0;i<468;i++) {
      const x = f[i*3+0] - baseX;
      const y = f[i*3+1] - baseY;
      const z = f[i*3+2] - baseZ;
      f[i*3+0] =  ( x) * 10.0;
      f[i*3+1] = (-y) * 10.0;
      f[i*3+2] = (-z) * 10.0;
    }
    this.faceModelAll = f;

    // 选 7 点
    const sel = this.LANDMARK_IDS;
    const out = new Float32Array(sel.length * 3);
    sel.forEach((idx, k) => {
      out[k*3+0] = f[idx*3+0];
      out[k*3+1] = f[idx*3+1];
      out[k*3+2] = f[idx*3+2];
    });
    this.faceModel7 = out;
    this.log('Face model loaded: 468pts, 7pt extracted');
  }

  // —— 仅实现 poly2/affine/offset/rot/homo 的选择；若 YAML 不含则回退 identity —— //
  _buildCalibFnFromYaml(txt, mode='poly2') {
    let cfg = {};
    try { cfg = (typeof jsyaml!=='undefined') ? (jsyaml.load(txt)||{}) : {}; } catch {}
    const poly2 = cfg.poly2 || {};
    const affine = cfg.affine || {};
    const offset = cfg.offset_only || cfg.offset || {};
    const rotR = cfg.rotation_R || null;
    const H = cfg.homography_H || null;

    const havePoly2 = Array.isArray(poly2.ax) && poly2.ax.length===6 && Array.isArray(poly2.ay) && poly2.ay.length===6;
    const haveAff   = affine.M && affine.b && Array.isArray(affine.M) && Array.isArray(affine.b);
    const haveOff   = ('pitch' in offset) || ('yaw' in offset) || ('pitch_offset_rad' in offset) || ('yaw_offset_rad' in offset);
    const haveRot   = rotR && Array.isArray(rotR) && rotR.length===3 && Array.isArray(rotR[0]) && rotR[0].length===3;
    const haveHomo  = H && Array.isArray(H) && H.length===3 && Array.isArray(H[0]) && H[0].length===3;

    const asXY2 = (xy)=> {
      const a = Float64Array.from(xy);
      return (a.length===2)? {arr:new Float64Array([a[0],a[1]]), single:true} : {arr:a, single:false};
    };
    const restore = (arr, single)=> single? new Float32Array([arr[0],arr[1]]) : new Float32Array(arr);

    // 常用：poly2
    const make_poly2 = (ax, ay) => {
      const AX = Float64Array.from(ax), AY = Float64Array.from(ay);
      return (xy)=> {
        const {arr,single} = asXY2(xy);
        const p = arr[0], y = arr[1];
        const phi = new Float64Array([1, p, y, p*p, p*y, y*y]);
        const out = new Float64Array([ phi[0]*AX[0]+phi[1]*AX[1]+phi[2]*AX[2]+phi[3]*AX[3]+phi[4]*AX[4]+phi[5]*AX[5],
                                       phi[0]*AY[0]+phi[1]*AY[1]+phi[2]*AY[2]+phi[3]*AY[3]+phi[4]*AY[4]+phi[5]*AY[5] ]);
        return restore(out, single);
      };
    };

    // 其他模式简化实现
    const make_affine = (M, b) => {
      const MM = new Float64Array([M[0][0],M[0][1],M[1][0],M[1][1]]);
      const BB = new Float64Array([b[0],b[1]]);
      return (xy)=> {
        const {arr,single} = asXY2(xy);
        const p = arr[0], y = arr[1];
        const out = new Float64Array([ MM[0]*p + MM[1]*y + BB[0],
                                       MM[2]*p + MM[3]*y + BB[1] ]);
        return restore(out, single);
      };
    };

    const make_offset = (off)=> {
      const po = ('pitch_offset_rad' in off)? off.pitch_offset_rad : (off.pitch||0);
      const yo = ('yaw_offset_rad'   in off)? off.yaw_offset_rad   : (off.yaw  ||0);
      return (xy)=> {
        const {arr,single} = asXY2(xy);
        const out = new Float64Array([arr[0]+po, arr[1]+yo]);
        return restore(out, single);
      };
    };

    const make_rot = (R3)=> {
      const R = new Float64Array([R3[0][0],R3[0][1],R3[0][2], R3[1][0],R3[1][1],R3[1][2], R3[2][0],R3[2][1],R3[2][2]]);
      const vnorm = (v)=> {
        const n = Math.hypot(v[0],v[1],v[2]) + 1e-12;
        return [v[0]/n, v[1]/n, v[2]/n];
      };
      const vec_to_py = (v)=> {
        const n = vnorm(v);
        const yaw   = Math.atan2(-n[1], -n[2]);
        const pitch = Math.atan2(-n[0], Math.hypot(n[1], n[2]));
        return new Float32Array([pitch, yaw]);
      };
      const py_to_vec = (p,y)=> {
        const vx = -Math.sin(p)*Math.cos(y);
        const vy = -Math.sin(y);
        const vz = -Math.cos(p)*Math.cos(y);
        const n = Math.hypot(vx,vy,vz)+1e-12;
        return [vx/n, vy/n, vz/n];
      };
      return (xy)=> {
        const {arr,single} = asXY2(xy);
        const p=arr[0], y=arr[1];
        const v = py_to_vec(p,y);
        const vc = [ R[0]*v[0]+R[1]*v[1]+R[2]*v[2],
                     R[3]*v[0]+R[4]*v[1]+R[5]*v[2],
                     R[6]*v[0]+R[7]*v[1]+R[8]*v[2] ];
        return vec_to_py(vc);
      };
    };

    // 此处不展开 homo → 简化为直返（避免需要运行时几何），如需可再开
    const make_identity = () => (xy)=> new Float32Array(xy);

    const sel = (mode||'poly2').toLowerCase();
    if (sel==='poly2' && havePoly2) { this.log('[Calib] Using poly2'); return make_poly2(poly2.ax, poly2.ay); }
    if (sel==='affine' && haveAff)  { this.log('[Calib] Using affine'); return make_affine(affine.M, affine.b); }
    if (sel==='offset' && haveOff)  { this.log('[Calib] Using offset'); return make_offset(offset); }
    if ((sel==='rot'||sel==='rotation'||sel==='so3') && haveRot) { this.log('[Calib] Using rotation'); return make_rot(rotR); }
    if ((sel==='homography'||sel==='homo') && haveHomo) { this.log('[Calib] Using homography (stub identity)'); return make_identity(); }

    this.log('[Calib] No valid section, fallback identity');
    return make_identity();
  }

  async _loadCalibYaml() {
    try {
      const txt = await window.fsio.readText(this.paths.calib);
      this._applyCalib = this._buildCalibFnFromYaml(txt, this.opts.calibMode || 'poly2');
      this.log(`Calibration ready (mode= ${this.opts.calibMode} )`);
    } catch (e) {
      this.warn('Calibration YAML missing or invalid, using identity. Err=', e?.message || e);
      this._applyCalib = (xy)=> new Float32Array(xy);
    }
  }

  // ========= 初始化 ========= //
  async ensureReady() {
    this._status = 'init';
    this.log('ensureReady: start');
    if (typeof cv === 'undefined') throw new Error('OpenCV.js not loaded');
    await this._ensureFaceMesh();
    await this._loadCameraYaml();
    await this._loadFaceModel();
    await this._loadCalibYaml();
    this._ready = true;
    this._status = 'ready';
    this.log('READY');
  }

  // ========= FaceMesh 一次性调用 ========= //
  _fmOnce(image) {
    return new Promise((resolve) => {
      let done = false;
      const cb = (res) => {
        if (done) return;
        done = true;
        // 解除回调（覆盖为空函数即可）
        try { this.fm.onResults(()=>{}); } catch {}
        resolve(res);
      };
      this.fm.onResults(cb);
      this.fm.send({ image });
    });
  }

  // ========= 数学工具 ========= //
  _pyToVec(p, y) {
    const vx = -Math.sin(p)*Math.cos(y);
    const vy = -Math.sin(y);
    const vz = -Math.cos(p)*Math.cos(y);
    const n = Math.hypot(vx,vy,vz) + 1e-12;
    return new Float64Array([vx/n, vy/n, vz/n]);
  }

  _rayPlane(center, v) {
    // 平面 z=0: n=[0,0,-1], b=0  → 求 t 使得 center.z + t*v.z = 0
    const vz = v[2];
    if (Math.abs(vz) < 1e-12) return null;
    const t = -center[2] / vz;
    return new Float64Array([ center[0] + t*v[0], center[1] + t*v[1], 0 ]);
  }

  _mm2px(xmm, ymm) {
    const [wmm, hmm] = this.mon_mm;
    const [wpx, hpx] = this.mon_px;
    const yoff = this.y_off || 0;
    // 与 Python 标定一致：x 原点屏幕中心向左为正；y 原点屏幕上边向下为正
    const u = (wmm/2 - xmm) * (wpx / wmm);
    const v = ( (ymm + yoff) ) * (hpx / hmm);
    return [u, v];
  }

  // ========= 主流程 ========= //
  async process(videoEl, pitchDeg, yawDeg) {
    if (!this._ready) return null;
    if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;

    const w = videoEl.videoWidth, h = videoEl.videoHeight;
    if (this._cvs.width !== w || this._cvs.height !== h) { this._cvs.width = w; this._cvs.height = h; }
    this._ctx.drawImage(videoEl, 0, 0, w, h);

    // 1) FaceMesh
    const res = await this._fmOnce(this._cvs);
    const faces = (res && res.multiFaceLandmarks) || res.multiFaceLandmarks || res.faceLandmarks;
    if (!faces || !faces[0] || !faces[0].length) {
      this.log('no landmarks from FaceMesh', { w, h });
      return null;
    }
    const lm = faces[0];
    this.log('xx landmarks from FaceMesh', { lm });
    const kps2d = new Float32Array(this.LANDMARK_IDS.length * 2);
    for (let i=0;i<this.LANDMARK_IDS.length;i++) {
      const id = this.LANDMARK_IDS[i];
      const x = lm[id].x * w;
      const y = lm[id].y * h;
      kps2d[i*2+0] = x;
      kps2d[i*2+1] = y;
    }
    try { window.dbg && window.dbg.log('[gaze-engine] landmarks(px) 7*2 =', Array.from(kps2d)); } catch {}
    this._pushBuf('landmarks', kps2d);
    const sm2d = new Float32Array(kps2d.length);
    const arrs = this.buf.landmarks;
    for (let i=0;i<sm2d.length;i++) {
      let s = 0; for (let r=0;r<arrs.length;r++) s += arrs[r][i];
      sm2d[i] = s / arrs.length;
    }

    // —— 调试输出：2D 关键点（像素） —— //
    this.dbg('kps2d(px) 7*2 =', this._fmtArr(sm2d, 2, sm2d.length));

    // 2) PnP
    const obj = cv.matFromArray(7, 3, cv.CV_64F, Array.from(this.faceModel7, v => +v));
    const img = cv.matFromArray(7, 2, cv.CV_64F, Array.from(sm2d,       v => +v));
    const K   = cv.matFromArray(3, 3, cv.CV_64F, Array.from(this.K,      v => +v));
    const D   = cv.matFromArray(1, this.dist.length, cv.CV_64F, Array.from(this.dist, v => +v));
    let rvec = new cv.Mat(), tvec = new cv.Mat();

    // —— 调试输出：obj/img/K/D 内容 —— //
    try {
      const obj64 = obj.data64F; const img64 = img.data64F; const K64 = K.data64F; const D64 = D.data64F;
      this.dbg('OBJ(7x3):', this._fmtMat(obj64, 7, 3, 2));
      this.dbg('IMG(7x2):', this._fmtMat(img64, 7, 2, 2));
      this.dbg('K(3x3):',    this._fmtMat(K64,   3, 3, 2));
      this.dbg('D(1xN):',    this._fmtArr(D64,   6, D64.length));
    } catch {}

    let ok = false;
    try {
      ok = cv.solvePnP(obj, img, K, D, rvec, tvec, false, cv.SOLVEPNP_EPNP);
      if (!ok) { this.warn('solvePnP EPNP failed'); obj.delete(); img.delete(); K.delete(); D.delete(); rvec.delete(); tvec.delete(); return null; }
      for (let i=0;i<10;i++) cv.solvePnP(obj, img, K, D, rvec, tvec, true, cv.SOLVEPNP_ITERATIVE);
    } catch(e){
      this.err('solvePnP error:', e);
      obj.delete(); img.delete(); K.delete(); D.delete(); rvec.delete(); tvec.delete();
      return null;
    }

    const r64 = new Float64Array(rvec.data64F), t64 = new Float64Array(tvec.data64F);
    this._pushBuf('rvec', r64); this._pushBuf('tvec', t64);
    const rSm = this._avgBuf('rvec'), tSm = this._avgBuf('tvec');

    this.dbg('rvec:', this._fmtArr(rSm, 4, 3), '  tvec(mm):', this._fmtArr(tSm, 1, 3));
    try { window.dbg && window.dbg.log('[gaze-engine] rvec=', Array.from(rSm), ' tvec(mm)=', Array.from(tSm)); } catch {}

    // 3) Rodrigues
    const rMat = cv.matFromArray(3, 1, cv.CV_64F, Array.from(rSm));
    const R = new cv.Mat(); cv.Rodrigues(rMat, R);
    const RM = new Float64Array(R.data64F); // row-major 3x3
    this.dbg('R(3x3):', this._fmtMat(RM, 3, 3, 4));

    // 4) 变换全部 468 点，求中心
    const Nall = 468;
    const face3d = new Float64Array(Nall*3);
    let cx=0, cy=0, cz=0;
    for (let i=0;i<Nall;i++){
      const X=this.faceModelAll[i*3+0], Y=this.faceModelAll[i*3+1], Z=this.faceModelAll[i*3+2];
      const tx = RM[0]*X + RM[1]*Y + RM[2]*Z + tSm[0];
      const ty = RM[3]*X + RM[4]*Y + RM[5]*Z + tSm[1];
      const tz = RM[6]*X + RM[7]*Y + RM[8]*Z + tSm[2];
      face3d[i*3+0]=tx; face3d[i*3+1]=ty; face3d[i*3+2]=tz;
      cx+=tx; cy+=ty; cz+=tz;
    }
    cx/=Nall; cy/=Nall; cz/=Nall;
    const center = new Float64Array([cx, cy, cz]);
    this.dbg(`Center(mm): (${cx.toFixed(1)}, ${cy.toFixed(1)}, ${cz.toFixed(1)})`);
    try { window.dbg && window.dbg.log('[gaze-engine] Center(mm)=', [Number(cx.toFixed(2)), Number(cy.toFixed(2)), Number(cz.toFixed(2))]); } catch {}

    // 清理临时 Mat
    obj.delete(); img.delete(); K.delete(); D.delete();
    rvec.delete(); tvec.delete(); rMat.delete(); R.delete();

    // 5) L2CS 角（deg -> rad）；校准
    let pitchRad = Number(pitchDeg) * Math.PI/180.0;
    let yawRad   = Number(yawDeg)   * Math.PI/180.0;
    if (!Number.isFinite(pitchRad) || !Number.isFinite(yawRad)) {
      this.warn('invalid yaw/pitch from VA; skip process'); 
      return null;
    }
    const raw_py  = new Float32Array([pitchRad, yawRad]);
    const corr_py = this._applyCalib(raw_py);
    this.dbg(`Angles raw(rad): p=${pitchRad.toFixed(4)} y=${yawRad.toFixed(4)}  corr(rad): p=${corr_py[0].toFixed(4)} y=${corr_py[1].toFixed(4)}`);

    // 6) gaze 向量 + 屏幕交点
    const g = this._pyToVec(corr_py[0], corr_py[1]);
    this._pushBuf('gaze', g);
    const gSm = this._avgBuf('gaze');
    this.dbg('Gaze vec:', this._fmtArr(gSm, 4, 3));
    try { window.dbg && window.dbg.log('[gaze-engine] GazeVec=', Array.from(gSm)); } catch {}

    const hit = this._rayPlane(center, gSm);
    if (!hit) { this.warn('ray-plane no hit (v.z≈0)'); return null; }
    const px = this._mm2px(hit[0], hit[1]);
    this.dbg(`Hit(mm): (${hit[0].toFixed(1)}, ${hit[1].toFixed(1)}, ${hit[2].toFixed(1)})  ->  Px=(${Math.round(px[0])}, ${Math.round(px[1])})`);
    try { window.dbg && window.dbg.log('[gaze-engine] Hit(mm)=', [Number(hit[0].toFixed(2)), Number(hit[1].toFixed(2)), Number(hit[2].toFixed(2))], 'Px=', [Math.round(px[0]), Math.round(px[1])]); } catch {}

    return {
      face_model_transformed: face3d,
      face_center: center,
      gaze_vector: gSm,
      point_on_screen_3d: hit,
      point_on_screen_px: [ Math.round(px[0]), Math.round(px[1]) ],
      raw_py: [raw_py[0], raw_py[1]],
      corr_py: [corr_py[0], corr_py[1]],
    };
  }
}

// ESM export
export { GazeEngineJS };
// 同时挂到 window（不影响 ESM 引用）
if (typeof window !== 'undefined') window.GazeEngineJS = GazeEngineJS;
