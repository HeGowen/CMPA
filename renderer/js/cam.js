// renderer/js/cam.js
// Camera + MediaPipe FaceDetection (onResults-driven).
// Draw mirrored video, solid green "detected bbox", dashed cyan "crop used".
// Always prefer locationData.relativeBoundingBox; fallback to boundingBox with heuristics.

//  概览                                                                                                                                                                              
                                                                                                                                                                                    
//   - 提供两层相机封装：                                                                                                                                                              
//       - FaceCam：获取摄像头画面，调用 MediaPipe FaceDetection 做人脸检测，绘制镜像视频、检测框和裁剪框，并产出对齐的人脸裁剪图（224×224）。                                         
//       - WebcamSource：在 FaceCam 之上做“分发器”，把每帧信息分发给可选的消费者（服务端推流、VA、凝视/注视模块），并保留对外的 onFrame 回调。                                         
                                                                                                                                                                                    
//   主要职责                                                                                                                                                                          
                                                                                                                                                                                    
//   - 打开摄像头、播放视频、在主画布上镜像显示。                                                                                                                                      
//   - 使用 MediaPipe FaceDetection 检测人脸，优先使用 locationData.relativeBoundingBox，否则回退到 boundingBox 并做归一化/像素推断。                                                  
//   - 提取双眼关键点（如有），据此对画面旋转对齐并裁剪人脸（正方形，带 padding，缩放到 224）。                                                                                        
//   - 叠加调试可视化：绿色实线为“检测框”，青色虚线为“实际裁剪范围”，黄色圆点为双眼。                                                                                                  
//   - 每帧产出结构化结果交给 onFrame，并由 WebcamSource 可选地分发给三个消费者。                                                                                                      
                                                                                                                                                                                    
//   关键流程                                                                                                                                                                          
                                                                                                                                                                                    
//   - start()：                                                                                                                                                                       
//       - 调 getUserMedia({video:1280×720}) 启动摄像头，播放到 video。                                                                                                                
//       - _ensureFD() 初始化 FaceDetection（模型 short、min conf=0.5，资源路径 ./vendor/face_detection/…），注册 onResults 将结果存到 _lastRes，并用 16×16 画布做一次 warm-up。       
//       - 标记 _running=true，进入 _loop()。                                                                                                                                          
//   - _loop() 每帧：                                                                                                                                                                  
//       - _drawVideoMirrored() 将视频帧（可水平翻转）画到主画布，得到 vw/vh。                                                                                                         
//       - fd.send({ image: this.video }) 触发检测，并读取 _lastRes 的第一张人脸。                                                                                                     
//       - _chooseRelBox() 选择相对框：优先 relativeBoundingBox，回退 boundingBox（中心或原点、归一化或像素），并做 sanity（宽高范围 0.01–0.95）和 [0,1] 裁剪，生成像素框 bbPix；同时  
//   _getEyes() 解析左右眼。                                                                                                                                                           
//       - 画出绿色检测框和黄色眼点。                                                                                                                                                  
//       - 生成裁剪：                                                                                                                                                                  
//           - 有眼点：_alignedCrop() 先将视频在离屏画布旋转到“眼睛水平”，再以人脸中心裁出带 padding 的正方形，缩放到 224。                                                            
//           - 无眼点：_bboxCrop() 仅按检测框中心裁剪，缩放到 224。                                                                                                                    
//       - 画出青色虚线的“实际裁剪范围”。                                                                                                                                              
//       - 调用 this._onFrame({ detections, used:'aligned'|'bbox'|'none', crop, dbg:{bbPix,eyes} })。                                                                                  
//       - requestAnimationFrame 继续循环。                                                                                                                                            
//   - stop()：停止 RAF，关闭检测器，停止媒体轨、清空画布。                                                                                                                            
//   - setDebug()：开关调试信息（画面左上角黑底白字的状态文本）。                                                                                                                      
                                                                                                                                                                                    
//   重要实现细节                                                                                                                                                                      
                                                                                                                                                                                    
//   - 坐标镜像：实际绘制时如果翻转显示，X 坐标通过 _mirrorX() 修正，保证框线位置与镜像画面一致；裁剪仍基于原始视频坐标。                                                              
//   - 框选择与归一化：                                                                                                                                                                
//       - relativeBoundingBox 直接使用。                                                                                                                                              
//       - boundingBox 同时兼容 center/origin、normalized/pixel 两种格式，必要时按视频宽高转为相对坐标。                                                                               
//   - 眼点与对齐：从 locationData.relativeKeypoints 取左右眼（像素化后），用两眼连线角度旋转；无眼点则降级为不旋转的 bbox 裁剪。                                                      
//   - 性能：频繁读写的离屏画布上下文用 { willReadFrequently: true }；主画布正常绘制。                                                                                                 
//   - 默认参数：padding≈0.28，输出裁剪尺寸 224，debug: true，flipDisplay: true。                                                                                                      
                                                                                                                                                                                    
//   对外 API                                                                                                                                                                          
                                                                                                                                                                                    
//   - FaceCam：                                                                                                                                                                       
//       - start() / stop() / setDebug(v) / onFrame(cb)                                                                                                                                
//   - WebcamSource（包装 FaceCam 并做分发）：                                                                                                                                         
//       - 同步暴露 start/stop/setDebug/onFrame                                                                                                                                        
//       - 消费者注册：setServerStreamer(fn), setVAConsumer(fn), setGazeConsumer(fn)                                                                                                   
//       - 分发策略：                                                                                                                                                                  
//           - Server：目前仅传元数据 { ts, width, height }（避免拷贝像素，属设计占位）。                                                                                              
//           - VA：传 ImageData 或 null，以及 { detections }。                                                                                                                         
//           - Gaze：传裁剪画布的克隆（避免副作用）和 bbPix，以及 { used }。                                                                                                           
                                                                                                                                                                                    
//   输出数据结构示例                                                                                                                                                                  
                                                                                                                                                                                    
//   - onFrame(info) 中的 info：                                                                                                                                                       
//       - detections: 0|1（是否检测到人脸，当前仅取第一张）                                                                                                                           
//       - used: 'aligned' | 'bbox' | 'none'                                                                                                                                           
//       - crop: { canvas, angleDeg, cropRect:{x1,y1,x2,y2} } | null                                                                                                                   
//       - dbg: { bbPix:{x,y,w,h}|null, eyes:{l:{x,y}, r:{x,y}}|null }                                                                                                                 
                                                                                                                                                                                    
//   依赖与资源                                                                                                                                                                        
                                                                                                                                                                                    
//   - 依赖 MediaPipe FaceDetection 的全局 FaceDetection 构造（模型资源位于 ./vendor/face_detection/）。                                                                               
//   - 运行于渲染进程，使用 <video> + <canvas>。                                                                                                                                       
                                                                                                                                                                                    
//   注意点                                                                                                                                                                            
                                                                                                                                                                                    
//   - 仅处理第一张人脸（如需多人脸需扩展）。                                                                                                                                          
//   - 资源路径依赖 vendor/face_detection 已被正确拷贝（对应仓库的 vendor 获取流程）。                                                                                                 
//   - 镜像只影响显示与叠加绘制，裁剪数据仍基于原始方向。       

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

// WebcamSource: central camera manager and frame distributor
// - Wraps FaceCam to keep existing behavior intact
// - Provides optional consumer hooks for server streaming (stub), VA, and Gaze
// - By default, all consumers are no-ops; external code may still use cam.onFrame()
export class WebcamSource {
  constructor(canvas, video, opts = {}) {
    this.cam = new FaceCam(canvas, video, opts);

    // Optional external consumers; all default to no-op
    this._serverStreamer = null; // design stub: function(frameMeta) {}
    this._vaConsumer = null;     // function(imgDataOrNull, meta) {}
    this._gazeConsumer = null;   // function(canvasOrNull, bbPix, meta) {}

    // Preserve user onFrame subscription, while auto-distributing first
    this._userOnFrame = null;

    // Wire internal distribution pipeline
    this.cam.onFrame(async (info) => {
      try { await this._distribute(info); } catch (e) { /* swallow */ }
      if (this._userOnFrame) {
        try { this._userOnFrame(info); } catch {}
      }
    });
  }

  // Public API parity with FaceCam
  async start() { return this.cam.start(); }
  stop() { return this.cam.stop(); }
  setDebug(v) { return this.cam.setDebug(v); }
  onFrame(cb) { this._userOnFrame = (typeof cb === 'function') ? cb : null; }

  // Consumers registration
  setServerStreamer(fn) { this._serverStreamer = (typeof fn === 'function') ? fn : null; }
  setVAConsumer(fn) { this._vaConsumer = (typeof fn === 'function') ? fn : null; }
  setGazeConsumer(fn) { this._gazeConsumer = (typeof fn === 'function') ? fn : null; }

  // Internal: clone a 2D canvas to a fresh canvas (used when duplicating to independent consumers)
  _cloneCanvas(src) {
    if (!src) return null;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    return c;
  }

  async _distribute(info) {
    // info: { detections, used, crop, dbg:{bbPix, eyes} }
    const cropCanvas = info && info.crop && info.crop.canvas ? info.crop.canvas : null;
    const bbPix = info && info.dbg ? info.dbg.bbPix : null;

    // 1) Server image stream (design stub) — do nothing by default
    if (this._serverStreamer && cropCanvas) {
      try {
        const ts = performance.now();
        // Design: pass metadata only for now; avoid heavy copies unless needed
        // The streamer may request its own extraction strategy later
        this._serverStreamer({ ts, width: cropCanvas.width, height: cropCanvas.height });
      } catch {}
    }

    // 2) VA consumer — provide ImageData or null, plus minimal meta (detections count)
    if (this._vaConsumer) {
      try {
        let imgData = null;
        if (cropCanvas) {
          const ctx = cropCanvas.getContext('2d', { willReadFrequently: true });
          imgData = ctx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
        }
        this._vaConsumer(imgData, { detections: info?.detections || 0 });
      } catch {}
    }

    // 3) Gaze consumer — provide a canvas (clone to avoid side-effects) and face bbox if any
    if (this._gazeConsumer) {
      try {
        const gazeCanvas = cropCanvas ? this._cloneCanvas(cropCanvas) : null;
        this._gazeConsumer(gazeCanvas, bbPix, { used: info?.used || 'none' });
      } catch {}
    }
  }
}
