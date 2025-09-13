// renderer/js/gaze_calib.js
// 负责载入个体化标定 YAML，并构造校正函数；缺失时回退 identity。
// 依赖：window.fsio.readTextSmart 或 readText + 相对路径尝试、window.jsyaml

function _now() { return Date.now(); }
let _lastWarn = 0;
function _warnOnce(msg, gap=1500){
  const t=_now(); if(t-_lastWarn>gap){ console.warn(msg); _lastWarn=t; }
}

// 智能读取文本（相对路径多候选）
async function readTextSmart(relPath) {
  if (!relPath) throw new Error('readTextSmart: empty path');
  const cand = [
    relPath,
    `./${relPath.replace(/^[.\\/]+/, '')}`,
    `renderer/${relPath.replace(/^[.\\/]+/, '')}`,
    `./renderer/${relPath.replace(/^[.\\/]+/, '')}`
  ];
  // 优先使用 preload 提供的 readTextSmart
  if (window.fsio && typeof window.fsio.readTextSmart === 'function') {
    try { return await window.fsio.readTextSmart(relPath); } catch(e){}
  }
  // 退化到 readText + 多候选
  if (!(window.fsio && typeof window.fsio.readText === 'function')) {
    throw new Error(`readText not found: ${relPath}`);
  }
  let lastErr = null;
  for (const p of cand) {
    try {
      const txt = await window.fsio.readText(p);
      if (txt && txt.length) return txt;
    } catch (e) { lastErr = e; }
  }
  throw (lastErr || new Error(`All candidates failed for: ${relPath}`));
}

// ===== 导出：加载 YAML 文本 =====
export async function loadCalibrationYamlText(relPath /* e.g. 'gaze_assets/individualized_calibration.yaml' */) {
  try {
    const txt = await readTextSmart(relPath);
    return txt;
  } catch (e) {
    _warnOnce(`[gaze-calib] calibration YAML missing, fallback identity. path=${relPath} err=${e?.message||e}`);
    return null; // 让上层回退 identity
  }
}

// ===== 导出：根据 YAML 构建校准函数 =====
// 目前支持两类：
// 1) 完全缺失 / 解析失败 → identity
// 2) 二次多项式（poly2）：
//    yaml:
//      type: poly2
//      px: [a0, a1, a2, a3, a4, a5]   # pitch_rad, yaw_rad → px = a0 + a1*p + a2*y + a3*p^2 + a4*p*y + a5*y^2
//      py: [b0, b1, b2, b3, b4, b5]
export function buildCalibrator(yamlText, mode = 'poly2') {
  if (!yamlText || typeof yamlText !== 'string') {
    console.warn('[gaze-calib] no yaml text, using identity calibrator');
    return (py) => py; // [pitch_rad, yaw_rad]
  }
  let y = null;
  try { y = window.jsyaml.load(yamlText) || {}; }
  catch(e) {
    console.warn('[gaze-calib] yaml parse fail, identity:', e?.message||e);
    return (py) => py;
  }

  const typ = String(y.type || mode || 'poly2').toLowerCase();
  if (typ === 'poly2') {
    const ax = Array.isArray(y.px) ? y.px.map(Number) : null;
    const ay = Array.isArray(y.py) ? y.py.map(Number) : null;
    const ok = ax && ay && ax.length === 6 && ay.length === 6 && ax.every(isFinite) && ay.every(isFinite);
    if (!ok) {
      console.warn('[gaze-calib] poly2 coeff missing or invalid, identity');
      return (py) => py;
    }
    // 返回：输入 [pitch_rad, yaw_rad] → 修正后 [pitch_rad, yaw_rad]
    return (py) => {
      const p = Number(py?.[0]); const yv = Number(py?.[1]);
      if (!isFinite(p) || !isFinite(yv)) return py;
      const px = ax[0] + ax[1]*p + ax[2]*yv + ax[3]*p*p + ax[4]*p*yv + ax[5]*yv*yv;
      const py2= ay[0] + ay[1]*p + ay[2]*yv + ay[3]*p*p + ay[4]*p*yv + ay[5]*yv*yv;
      return [px, py2];
    };
  }

  console.warn(`[gaze-calib] unsupported type "${typ}", identity`);
  return (py) => py;
}
