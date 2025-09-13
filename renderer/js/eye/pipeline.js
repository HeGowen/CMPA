// renderer/js/eye/pipeline.js
// EyeTrackingPipeline: FaceMesh -> 7 landmarks -> PnP -> center(mm)
//                      -> aligned face crop -> Gaze ONNX -> yaw/pitch
//                      -> gaze vector + screen hit

import { parseNPY } from '../npy.js';

export class EyeTrackingPipeline {
  constructor(cb = {}) {
    this.onCenter = cb.onCenter || (()=>{});
    this.on3D     = cb.on3D     || (()=>{}); // (face3d, center, gazeVec, hit)
    this.onArrow  = cb.onArrow  || (()=>{}); // ({px:[cx,cy], yaw, pitch})
    this.onHit    = cb.onHit    || (()=>{});
    this.onDebug  = cb.onDebug  || (()=>{});

    this.ready = false;
    this.LANDMARK_IDS = [33, 133, 362, 263, 61, 291, 1];
    this._cvs = document.createElement('canvas');
    this._ctx = this._cvs.getContext('2d');
  }

  async ensureReady(opts = {}) {
    if (this.ready) return;
    if (typeof cv === 'undefined') throw new Error('OpenCV.js not loaded');
    // FaceMesh
    this.fm = new FaceMesh({ locateFile: (f) => 'renderer/vendor/mediapipe/face_mesh/' + f });
    this.fm.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5, modelComplexity: 1 });
    // Camera YAML
    const camYaml = await window.fsio.readText('renderer/gaze_assets/camera_calibration_matrix.yaml');
    const y = (typeof jsyaml !== 'undefined') ? jsyaml.load(camYaml) : null;
    const Karr = y.camera_matrix?.data || y.K; this.K = new Float64Array(Karr);
    const Darr = y.dist_coeffs?.data || y.dist || [0,0,0,0,0]; this.dist = new Float64Array(Darr);
    // Face model
    const buf = await window.fsio.readBin('renderer/gaze_assets/face_model_all.npy');
    const npy = parseNPY(buf); const f = new Float32Array(npy.data.length); f.set(npy.data);
    const bx=f[3], by=f[4], bz=f[5]; for (let i=0;i<468;i++){ const ix=i*3; f[ix]=(f[ix]-bx)*10; f[ix+1]=-(f[ix+1]-by)*10; f[ix+2]=-(f[ix+2]-bz)*10; }
    this.faceAll=f; const sel=this.LANDMARK_IDS; this.face7=new Float32Array(sel.length*3); sel.forEach((id,k)=>{this.face7[k*3]=f[id*3];this.face7[k*3+1]=f[id*3+1];this.face7[k*3+2]=f[id*3+2];});
    // Gaze ONNX
    const gbuf = await window.va.readModel('models/mdsk_gaze_model.onnx');
    const eps = ['wasm'];
    this.ort = await window.ort.InferenceSession.create(gbuf, { executionProviders: eps });
    this.gazeInput = this.ort.inputNames[0];
    this.ready = true;
  }

  async _fmOnce(image) {
    return new Promise((resolve) => { this.fm.onResults((r)=>resolve(r)); this.fm.send({ image }); });
  }

  _toExpectedImageData(src, w, h) {
    const off = document.createElement('canvas'); off.width=w; off.height=h; const ctx=off.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h); return ctx.getImageData(0, 0, w, h);
  }

  async step(frame) {
    if (!this.ready || !frame || !frame.canvas) return;
    const cnv = frame.canvas; const w=cnv.width, h=cnv.height; this._cvs.width=w; this._cvs.height=h; this._ctx.drawImage(cnv,0,0,w,h);
    try { window.dbg && window.dbg.log('[eye] process begin', { w, h }); } catch{}
    const res = await this._fmOnce(this._cvs);
    const faces = (res && res.multiFaceLandmarks) || res.faceLandmarks || [];
    const lm = faces[0]; if (!lm || !lm.length) { this.onDebug('no landmarks'); return; }
    const k7 = new Float64Array(this.LANDMARK_IDS.length*2);
    for (let i=0;i<this.LANDMARK_IDS.length;i++){ const id=this.LANDMARK_IDS[i]; k7[i*2]=lm[id].x*w; k7[i*2+1]=lm[id].y*h; }
    try { window.dbg && window.dbg.log('[eye] landmarks sample', { count: lm.length, p0:{x:lm[this.LANDMARK_IDS[0]].x,y:lm[this.LANDMARK_IDS[0]].y} }); } catch{}
    // PnP
    const obj = cv.matFromArray(7,3,cv.CV_64F, Array.from(this.face7, v=>+v));
    const img = cv.matFromArray(7,2,cv.CV_64F, Array.from(k7,     v=>+v));
    const K   = cv.matFromArray(3,3,cv.CV_64F, Array.from(this.K, v=>+v));
    const D   = cv.matFromArray(1,this.dist.length,cv.CV_64F, Array.from(this.dist,v=>+v));
    let rvec=new cv.Mat(), tvec=new cv.Mat();
    let ok=false; try { ok=cv.solvePnP(obj,img,K,D,rvec,tvec,false,cv.SOLVEPNP_EPNP); if(ok) for(let i=0;i<10;i++) cv.solvePnP(obj,img,K,D,rvec,tvec,true,cv.SOLVEPNP_ITERATIVE);} catch(e){ ok=false; }
    if (!ok) { this.onDebug('PnP fail'); obj.delete(); img.delete(); K.delete(); D.delete(); rvec.delete(); tvec.delete(); return; }
    const rSm=new Float64Array(rvec.data64F), tSm=new Float64Array(tvec.data64F);
    const rMat=cv.matFromArray(3,1,cv.CV_64F, Array.from(rSm)); const R=new cv.Mat(); cv.Rodrigues(rMat,R); const RM=new Float64Array(R.data64F);
    // center and face3d
    const N=468, face3d=new Float64Array(N*3); let cx=0,cy=0,cz=0; for(let i=0;i<N;i++){ const X=this.faceAll[i*3],Y=this.faceAll[i*3+1],Z=this.faceAll[i*3+2]; const tx=RM[0]*X+RM[1]*Y+RM[2]*Z + tSm[0]; const ty=RM[3]*X+RM[4]*Y+RM[5]*Z + tSm[1]; const tz=RM[6]*X+RM[7]*Y+RM[8]*Z + tSm[2]; face3d[i*3]=tx;face3d[i*3+1]=ty;face3d[i*3+2]=tz; cx+=tx;cy+=ty;cz+=tz; }
    cx/=N; cy/=N; cz/=N; const center=new Float64Array([cx,cy,cz]);
    this.onCenter(center);
    // aligned face crop for gaze ONNX using eye corners (33,263)
    const le = lm[33], re = lm[263]; const dx=(re.x-le.x)*w, dy=(re.y-le.y)*h; const angle=Math.atan2(dy,dx); const base=Math.max(Math.hypot(dx,dy)*2.2, 80);
    const cx2 = (le.x+re.x)/2*w, cy2=(le.y+re.y)/2*h; const off=document.createElement('canvas'); off.width=w;off.height=h; const oc=off.getContext('2d',{willReadFrequently:true}); oc.save(); oc.translate(cx2,cy2); oc.rotate(-angle); oc.drawImage(cnv,-cx2,-cy2,w,h); oc.restore();
    const half=Math.round(base/2); const x1=Math.max(0,Math.floor(cx2-half)), y1=Math.max(0,Math.floor(cy2-half)), x2=Math.min(w,Math.floor(cx2+half)), y2=Math.min(h,Math.floor(cy2+half));
    const face=document.createElement('canvas'); face.width=448; face.height=448; face.getContext('2d',{willReadFrequently:true}).drawImage(off,x1,y1,x2-x1,y2-y1,0,0,448,448);
    // gaze ONNX
    const imgData=this._toExpectedImageData(face,448,448); const tensor=new window.ort.Tensor('float32', this._imgToNCHW(imgData), [1,3,448,448]);
    const out = await this.ort.run({ [this.gazeInput]: tensor }); const { pitchDeg, yawDeg } = this._parseAnglesDeg(out);
    // vector + hit
    const yaw=yawDeg*Math.PI/180, pitch=pitchDeg*Math.PI/180; const vx=-Math.sin(pitch)*Math.cos(yaw); const vy=-Math.sin(yaw); const vz=-Math.cos(pitch)*Math.cos(yaw); const n=Math.hypot(vx,vy,vz)||1; const gv=[vx/n,vy/n,vz/n];
    const vz2=gv[2]; let hit=null; if (Math.abs(vz2) > 1e-9) { const t=-center[2]/vz2; hit=[center[0]+t*gv[0], center[1]+t*gv[1], 0]; }
    this.on3D(face3d, center, gv, hit);
    // 2D arrow position use mid-eye px
    this.onArrow({ px:[Math.round(cx2), Math.round(cy2)], yaw: yawDeg, pitch: pitchDeg });
    if (hit) this.onHit(hit);
  }

  _imgToNCHW(imgData){ const { data,width,height }=imgData; const N=width*height; const MEAN=[0.485,0.456,0.406], STD=[0.229,0.224,0.225]; const arr=new Float32Array(1*3*N); let p=0; for(let i=0;i<height;i++){ for(let j=0;j<width;j++){ const idx=(i*width+j)*4; const r=data[idx]/255,g=data[idx+1]/255,b=data[idx+2]/255; arr[0*N+p]=(r-MEAN[0])/STD[0]; arr[1*N+p]=(g-MEAN[1])/STD[1]; arr[2*N+p]=(b-MEAN[2])/STD[2]; p++; }} return arr; }
  _parseAnglesDeg(resultMap){ const outs=Object.values(resultMap); const cand=outs.filter(t=>{const d=t.dims||t.dims_; if(!d) return false; const n=d[d.length-1]; return d.length>=2 && n>=30;}); let pitch=null,yaw=null,bins=66; if(cand.length>=2){ const t0=cand[0],t1=cand[1]; const n0=(t0.dims||t0.dims_).slice(-1)[0], n1=(t1.dims||t1.dims_).slice(-1)[0]; bins=Math.min(n0,n1); pitch=Array.from(t0.data).slice(0,bins); yaw=Array.from(t1.data).slice(0,bins);} else if(cand.length===1){ const t=cand[0]; const n=(t.dims||t.dims_).slice(-1)[0]; bins=Math.floor(n/2); const d=Array.from(t.data); pitch=d.slice(0,bins); yaw=d.slice(bins,bins*2);} else { throw new Error('no gaze logits'); } const angs=this._lin(-99,99,bins); const pSm=this._softmax(pitch), ySm=this._softmax(yaw); return { pitchDeg:this._expect(angs,pSm), yawDeg:this._expect(angs,ySm) } }
  _softmax(x){ const m=Math.max(...x); const ex=x.map(v=>Math.exp(v-m)); const s=ex.reduce((a,b)=>a+b,0)||1; return ex.map(v=>v/s); }
  _lin(a,b,n){ if(n<=1) return [a]; const step=(b-a)/(n-1); const out=new Array(n); for(let i=0;i<n;i++) out[i]=a+i*step; return out; }
  _expect(vals,probs){ let s=0; for(let i=0;i<vals.length && i<probs.length;i++) s+=vals[i]*probs[i]; return s; }
}

