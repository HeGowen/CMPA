// renderer/js/gaze_math.js
// [NEW] 基础数学/几何工具，与 Python utils 同步：gaze2dTo3d(L2CS), 射线-平面交点, 屏幕 mm→px 映射, 简单平滑

export const LANDMARK_IDS = [33, 133, 362, 263, 61, 291, 1];

export function rad(deg){ return deg * Math.PI / 180.0; }
export function deg(rad){ return rad * 180.0 / Math.PI; }

export function gaze2dTo3dL2CS(pitchYawRad /* [p,y] */) {
  const p = pitchYawRad[0], y = pitchYawRad[1];
  const x = -Math.sin(p) * Math.cos(y);
  const yy = -Math.sin(y);
  const z = -Math.cos(p) * Math.cos(y);
  const n = Math.sqrt(x*x + yy*yy + z*z) || 1.0;
  return [x/n, yy/n, z/n];
}

/** n·X + d = 0 ; here n = [0,0,-1], d=0 (z=0 平面) */
export function rayPlaneIntersection(origin3, dir3, planeN = [0,0,-1], planeD = 0.0) {
  const nd = planeN[0]*dir3[0] + planeN[1]*dir3[1] + planeN[2]*dir3[2];
  if (Math.abs(nd) < 1e-6) return null;
  // 解线性方程与 Python 步骤等价：这里直接求 t = -(n·O + d)/(n·d)
  const no = planeN[0]*origin3[0] + planeN[1]*origin3[1] + planeN[2]*origin3[2];
  const t = -(no + planeD) / nd;
  return [origin3[0] + t*dir3[0], origin3[1] + t*dir3[1], origin3[2] + t*dir3[2]];
}

/** mm→px 映射，与 Python get_point_on_screen 一致 */
export function mmToPx(mmW, mmH, pxW, pxH, inter3 /* [xmm,ymm,z] */) {
  if (!inter3 || inter3.some(v => !isFinite(v))) return [-1, -1];
  let x = inter3[0], y = inter3[1];
  // x: -x + w/2 → → pxW / mmW
  let u = (-x + mmW / 2.0) * (pxW / mmW);
  // y: 直接 mm → px (可加 offset，这里默认 0)
  y = Math.min(y, mmH);
  let v = (y) * (pxH / mmH);
  return [Math.round(u), Math.round(v)];
}

// —— 简单滑动平均的 px 平滑器 —— //
export class MovingAverage2 {
  constructor(win = 5){ this.win = win; this.buf = []; }
  step(u, v) {
    if (!(Number.isFinite(u) && Number.isFinite(v))) return [-1, -1];
    this.buf.push([u,v]); if (this.buf.length > this.win) this.buf.shift();
    const s = this.buf.reduce((a,b)=>[a[0]+b[0], a[1]+b[1]],[0,0]);
    const n = this.buf.length || 1;
    return [Math.round(s[0]/n), Math.round(s[1]/n)];
  }
}
