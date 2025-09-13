// renderer/js/cam.js
// Camera + MediaPipe FaceDetection (onResults-driven).
// Draw mirrored video, solid green "detected bbox", dashed cyan "crop used".
// Always prefer locationData.relativeBoundingBox; fallback to boundingBox with heuristics.

export class FaceCam {
  constructor(canvas, video, opts = {}) {
    this.canvas = canvas;
    // 主画布不用频繁读回
    this.ctx = canvas.getContext('2d');
    this.video = video;
    this.opts = { debug: true, flipDisplay: true, ...opts };

    this.fd = null;
    this._haveOnResults = false;
    this._lastRes = null;

    this._raf = 0;
    this._running = false;

    this._onFrame = () => {};

    this._off = document.createElement('canvas');
    // 旋转对齐缓存画布会被频繁读写
    this._offCtx = this._off.getContext('2d', { willReadFrequently: true });

    this._lastDetLogAt = 0;
  }

  onFrame(cb) { this._onFrame = typeof cb === 'function' ? cb : () => {}; }

  async _ensureFD() {
    if (this.fd) return;
    this.fd = new FaceDetection({
      locateFile: (file) => `./vendor/face_detection/${file}`
    });
    this.fd.setOptions({ model: 'short', minDetectionConfidence: 0.5 });

    if (!this._haveOnResults) {
      this.fd.onResults((res) => { this._lastRes = res; });
      this._haveOnResults = true;
    }

    // warm up
    const prim = document.createElement('canvas'); prim.width = 16; prim.height = 16;
    await this.fd.send({ image: prim });
  }

  async start() {
    if (this._running) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720 },
      audio: false
    });
    this.video.srcObject = stream;
    await this.video.play();

    await this._ensureFD();
    this._running = true;
    this._loop();
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf), this._raf = 0;
    try { this.fd && this.fd.close && this.fd.close(); } catch {}
    this.fd = null;
    if (this.video.srcObject) {
      try { this.video.srcObject.getTracks().forEach(t => t.stop()); } catch {}
      this.video.srcObject = null;
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  setDebug(v) { this.opts.debug = !!v; }

  _drawVideoMirrored() {
    const { canvas, ctx, video } = this;
    const vw = video.videoWidth || 640, vh = video.videoHeight || 360;
    canvas.width = vw; canvas.height = vh;
    ctx.save();
    if (this.opts.flipDisplay) { ctx.translate(vw, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, vw, vh);
    ctx.restore();
    return { vw, vh };
  }
  _mirrorX(x, w, vw) { return this.opts.flipDisplay ? (vw - (x + (w ?? 0))) : x; }

  _getRBB(ld) {
    const rbb = ld?.relativeBoundingBox ?? ld?.relative_bounding_box ?? null;
    if (!rbb) return null;

    const rx = (rbb.xMin ?? rbb.xmin ?? rbb.left  ?? rbb.originX ?? null);
    const ry = (rbb.yMin ?? rbb.ymin ?? rbb.top   ?? rbb.originY ?? null);
    const rw = (rbb.width ?? rbb.w ?? null);
    const rh = (rbb.height ?? rbb.h ?? null);

    if ([rx, ry, rw, rh].some(v => typeof v !== 'number' || !isFinite(v))) return null;

    return { x: rx, y: ry, w: rw, h: rh, source: 'relativeBoundingBox' };
  }

  _getAltBox(det, vw, vh) {
    const bb = det.boundingBox ?? det.bounding_box ?? null;
    if (!bb) return null;

    const w = Number(bb.width ?? 0);
    const h = Number(bb.height ?? 0);
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;

    let cx = bb.xCenter ?? bb.x_center;
    let cy = bb.yCenter ?? bb.y_center;

    let x0, y0;
    if (typeof cx === 'number' && typeof cy === 'number') {
      let norm = !!bb.normalized;
      if (!norm && w <= 1.5 && h <= 1.5) norm = true;

      if (norm) {
        x0 = cx - w / 2;
        y0 = cy - h / 2;
        return { x: x0, y: y0, w, h, source: 'boundingBox(center,norm)' };
      } else {
        x0 = cx - w / 2;
        y0 = cy - h / 2;
        return { x: x0 / vw, y: y0 / vh, w: w / vw, h: h / vh, source: 'boundingBox(center,pixel)' };
      }
    } else {
      const ox = bb.originX ?? bb.xMin ?? bb.left;
      const oy = bb.originY ?? bb.yMin ?? bb.top;
      if (typeof ox !== 'number' || typeof oy !== 'number') return null;

      let norm = !!bb.normalized;
      if (!norm && w <= 1.5 && h <= 1.5) norm = true;

      if (norm) {
        return { x: ox, y: oy, w, h, source: 'boundingBox(origin,norm)' };
      } else {
        return { x: ox / vw, y: oy / vh, w: w / vw, h: h / vh, source: 'boundingBox(origin,pixel)' };
      }
    }
  }

  _chooseRelBox(det, vw, vh) {
    const ld = det.locationData ?? det.location_data ?? {};
    const candR = this._getRBB(ld);
    const candB = this._getAltBox(det, vw, vh);

    const sane = (rb) => rb && rb.w > 0.01 && rb.h > 0.01 && rb.w < 0.95 && rb.h < 0.95;

    let chosen = null;
    if (sane(candR)) chosen = candR;
    else if (sane(candB)) chosen = candB;
    else chosen = candR ?? candB ?? null;

    if (chosen) {
      const x = Math.max(0, Math.min(1, chosen.x));
      const y = Math.max(0, Math.min(1, chosen.y));
      const w = Math.max(0, Math.min(1, chosen.w));
      const h = Math.max(0, Math.min(1, chosen.h));
      if (w * vw < 8 || h * vh < 8) return { rel: null, bbPix: null, source: chosen.source, eyes: this._getEyes(ld, vw, vh) };
      const bbPix = { x: Math.round(x * vw), y: Math.round(y * vh), w: Math.round(w * vw), h: Math.round(h * vh) };
      const eyes = this._getEyes(ld, vw, vh);
      return { rel: { x, y, w, h }, bbPix, source: chosen.source, eyes };
    }

    return { rel: null, bbPix: null, source: 'none', eyes: this._getEyes(ld, vw, vh) };
  }

  _getEyes(ld, vw, vh) {
    const kps = ld?.relativeKeypoints ?? ld?.relative_keypoints ?? null;
    if (!Array.isArray(kps) || kps.length < 2) return null;
    const le = kps[0], re = kps[1];
    if (typeof le?.x !== 'number' || typeof re?.x !== 'number') return null;
    return {
      l: { x: le.x * vw, y: le.y * vh },
      r: { x: re.x * vw, y: re.y * vh }
    };
  }

  _alignedCrop(vw, vh, bbPix, eyes, padding = 0.28, out = 224) {
    if (!bbPix || !eyes) return null;
    const off = this._off, offCtx = this._offCtx;
    off.width = vw; off.height = vh;

    const dx = (eyes.r.x - eyes.l.x), dy = (eyes.r.y - eyes.l.y);
    const angle = Math.atan2(dy, dx);
    const angleDeg = angle * 180 / Math.PI;

    const cx = bbPix.x + bbPix.w / 2;
    const cy = bbPix.y + bbPix.h / 2;

    offCtx.save();
    offCtx.translate(cx, cy);
    offCtx.rotate(-angle);
    offCtx.drawImage(this.video, -cx, -cy, vw, vh);
    offCtx.restore();

    const base = Math.max(bbPix.w, bbPix.h);
    const half = Math.round(base / 2 + base * padding);

    let x1 = Math.max(0, Math.floor(cx - half));
    let y1 = Math.max(0, Math.floor(cy - half));
    let x2 = Math.min(vw, Math.floor(cx + half));
    let y2 = Math.min(vh, Math.floor(cy + half));

    if (x2 - x1 < 8 || y2 - y1 < 8) return null;

    const face = document.createElement('canvas');
    face.width = out; face.height = out;
    face.getContext('2d', { willReadFrequently: true })
        .drawImage(off, x1, y1, x2 - x1, y2 - y1, 0, 0, out, out);

    return { canvas: face, angleDeg, cropRect: { x1, y1, x2, y2 } };
  }

  _bboxCrop(vw, vh, bbPix, padding = 0.28, out = 224) {
    if (!bbPix) return null;
    const base = Math.max(bbPix.w, bbPix.h);
    const half = Math.round(base / 2 + base * padding);
    const cx = bbPix.x + bbPix.w / 2;
    const cy = bbPix.y + bbPix.h / 2;

    let x1 = Math.max(0, Math.floor(cx - half));
    let y1 = Math.max(0, Math.floor(cy - half));
    let x2 = Math.min(vw, Math.floor(cx + half));
    let y2 = Math.min(vh, Math.floor(cy + half));

    if (x2 - x1 < 8 || y2 - y1 < 8) return null;

    const face = document.createElement('canvas');
    face.width = out; face.height = out;
    face.getContext('2d', { willReadFrequently: true })
        .drawImage(this.video, x1, y1, x2 - x1, y2 - y1, 0, 0, out, out);

    return { canvas: face, angleDeg: 0, cropRect: { x1, y1, x2, y2 } };
  }

  _drawDebugText(lines) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    const w = 420, h = 16 * (lines.length + 1);
    ctx.fillRect(6, 6, w, h);
    ctx.fillStyle = '#fff';
    ctx.font = '12px Consolas,ui-monospace,Menlo,monospace';
    let y = 22;
    for (const s of lines) { ctx.fillText(s, 12, y); y += 16; }
    ctx.restore();
  }

  async _loop() {
    if (!this._running) return;

    const { vw, vh } = this._drawVideoMirrored();

    try { await this.fd.send({ image: this.video }); } catch {}

    const res = this._lastRes || {};
    const dets = res.detections || res.multiFaceDetections || res.multi_face_detections || [];
    const det = dets[0] || null;

    const ctx = this.ctx;
    const mirror = (x, w = 0) => this._mirrorX(x, w, vw);

    let used = 'none';
    let bbPix = null, eyes = null, crop = null, srcLabel = 'none';

    if (det) {
      const pick = this._chooseRelBox(det, vw, vh);
      bbPix = pick.bbPix;
      eyes  = pick.eyes;
      srcLabel = pick.source;

      if (bbPix) {
        const drawX = mirror(bbPix.x, bbPix.w);
        ctx.save();
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 2;
        ctx.strokeRect(drawX, bbPix.y, bbPix.w, bbPix.h);
        ctx.restore();
      }

      if (eyes) {
        ctx.save();
        ctx.fillStyle = '#ffcc00';
        ctx.beginPath(); ctx.arc(mirror(eyes.l.x), eyes.l.y, 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(mirror(eyes.r.x), eyes.r.y, 3, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      if (bbPix) {
        crop = eyes ? this._alignedCrop(vw, vh, bbPix, eyes, 0.28, 224)
                    : this._bboxCrop   (vw, vh, bbPix, 0.28, 224);
      }

      if (crop) {
        used = eyes ? 'aligned' : 'bbox';
        const { x1, y1, x2, y2 } = crop.cropRect;
        const drawX = mirror(x1, (x2 - x1));
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = '#00e0ff';
        ctx.lineWidth = 2;
        ctx.strokeRect(drawX, y1, (x2 - x1), (y2 - y1));
        ctx.restore();
      }
    }

    if (this.opts.debug) {
      const lines = [];
      lines.push(`faces: ${dets.length}  used: ${used}  src:${srcLabel}`);
      if (bbPix) lines.push(`bbPix x,y,w,h: ${bbPix.x}, ${bbPix.y}, ${bbPix.w}, ${bbPix.h}`);
      if (crop)  lines.push(`crop x1,y1,x2,y2: ${crop.cropRect.x1}, ${crop.cropRect.y1}, ${crop.cropRect.x2}, ${crop.cropRect.y2}`);
      if (!eyes) lines.push('eyes: none (falling back to bbox crop)');
      this._drawDebugText(lines);

      const now = performance.now();
      if (now - this._lastDetLogAt > 800) {
        //console.log('[cam] det dbg:', JSON.stringify({ srcLabel, bbPix, hasEyes: !!eyes }));
        this._lastDetLogAt = now;
      }
    }

    this._onFrame({
      detections: det ? 1 : 0,
      used: crop ? used : 'none',
      crop,
      dbg: { bbPix, eyes }
    });

    this._raf = requestAnimationFrame(() => this._loop());
  }
}
