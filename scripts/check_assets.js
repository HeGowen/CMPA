// scripts/check_assets.js
// Fails fast if required vendor/model assets are missing before packaging.
const fs = require('fs');
const path = require('path');

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function main() {
  const root = process.cwd();

  // Core models (kept out of VCS; must be present locally)
  const modelFiles = [
    path.join(root, 'models', 'enet_b0_8_va_mtl.onnx'),
    path.join(root, 'models', 'mdsk_gaze_model.onnx'),
  ];

  // Vendor assets required by renderer
  const vendorFiles = [
    path.join(root, 'renderer', 'vendor', 'opencv', 'opencv.js'),
    path.join(root, 'renderer', 'vendor', 'three', 'three.min.js'),
    path.join(root, 'renderer', 'vendor', 'js-yaml', 'js-yaml.min.js'),
    path.join(root, 'renderer', 'vendor', 'mediapipe', 'face_mesh', 'face_mesh.js'),
    path.join(root, 'renderer', 'vendor', 'mediapipe', 'face_mesh', 'face_mesh_solution_packed_assets.data'),
    path.join(root, 'renderer', 'vendor', 'mediapipe', 'face_mesh', 'face_mesh_solution_packed_assets_loader.js'),
    path.join(root, 'renderer', 'vendor', 'mediapipe', 'face_mesh', 'face_mesh_solution_simd_wasm_bin.js'),
    path.join(root, 'renderer', 'vendor', 'mediapipe', 'face_mesh', 'face_mesh_solution_simd_wasm_bin.wasm'),
    path.join(root, 'renderer', 'vendor', 'mediapipe', 'face_mesh', 'face_mesh.binarypb'),
  ];

  const missingModels = modelFiles.filter(f => !exists(f));
  const missingVendors = vendorFiles.filter(f => !exists(f));

  if (missingModels.length || missingVendors.length) {
    console.error('\n[Asset Check] Missing required assets.');
    if (missingModels.length) {
      console.error('\nMissing models (place under models/):');
      for (const f of missingModels) console.error(' - ' + path.relative(root, f));
    }
    if (missingVendors.length) {
      console.error('\nMissing vendor files (populate via: npm run fetch:vendor):');
      for (const f of missingVendors) console.error(' - ' + path.relative(root, f));
    }
    console.error('\nFix the above, then re-run: npm run dist');
    process.exit(1);
  }

  console.log('[Asset Check] All required models and vendor files present.');
}

main();

