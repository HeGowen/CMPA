# scripts/fetch_vendor.ps1
# Run: cd D:\CMPA ; powershell -ExecutionPolicy Bypass -File .\scripts\fetch_vendor.ps1
$ErrorActionPreference = "Stop"

function New-Dir($p) { if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null } }
function Try-Download {
  param([Parameter(Mandatory=$true)][string[]]$Urls,[Parameter(Mandatory=$true)][string]$OutPath,[int]$TimeoutSec = 60)
  New-Dir (Split-Path $OutPath -Parent)
  foreach ($u in $Urls) {
    try {
      Write-Host "Downloading: $u"
      $wc = New-Object System.Net.WebClient
      $wc.Encoding = [System.Text.Encoding]::UTF8
      $wc.DownloadFile($u, $OutPath)
      if ((Test-Path $OutPath) -and ((Get-Item $OutPath).Length -gt 0)) { Write-Host "OK -> $OutPath"; return $true }
    } catch { Write-Warning "Failed: $u ($(($_.Exception.Message)))" }
  }
  return $false
}

$ROOT   = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")
$VENDOR = Join-Path $ROOT "renderer\vendor"
$MP_DIR = Join-Path $VENDOR "mediapipe\face_mesh"
$OCV_DIR= Join-Path $VENDOR "opencv"
$THR_DIR= Join-Path $VENDOR "three"
$YML_DIR= Join-Path $VENDOR "js-yaml"
$GAZE_DST = Join-Path $ROOT "renderer\gaze_assets"
$GAZE_SRC = Join-Path $ROOT "gaze_tracking"

New-Dir $VENDOR; New-Dir $MP_DIR; New-Dir $OCV_DIR; New-Dir $THR_DIR; New-Dir $YML_DIR; New-Dir $GAZE_DST

# ---- 1) OpenCV.js ----
$opencvTargets = @(
  "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0/build/opencv.js",
  "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0/opencv.js",
  "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.9.0/build/opencv.js",
  "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.8.0/build/opencv.js",
  "https://unpkg.com/@techstark/opencv-js@4.10.0/build/opencv.js",
  "https://docs.opencv.org/4.x/opencv.js"
)
$opencvOut = Join-Path $OCV_DIR "opencv.js"
if (-not (Try-Download -Urls $opencvTargets -OutPath $opencvOut)) { throw "OpenCV.js download failed." }

# ---- 2) MediaPipe FaceMesh (本地齐全：js + wasm + data + binarypb + loader) ----
$mpBase = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4"
$mpOk = $true
$mpOk = $mpOk -and (Try-Download -Urls @("$mpBase/face_mesh.js") -OutPath (Join-Path $MP_DIR "face_mesh.js"))
$mpOk = $mpOk -and (Try-Download -Urls @("$mpBase/face_mesh_solution_packed_assets.data") -OutPath (Join-Path $MP_DIR "face_mesh_solution_packed_assets.data"))
$mpOk = $mpOk -and (Try-Download -Urls @("$mpBase/face_mesh_solution_packed_assets_loader.js") -OutPath (Join-Path $MP_DIR "face_mesh_solution_packed_assets_loader.js"))
# 关键：同时下 .js 和 .wasm 两个同名文件
$mpOk = $mpOk -and (Try-Download -Urls @("$mpBase/face_mesh_solution_simd_wasm_bin.js") -OutPath (Join-Path $MP_DIR "face_mesh_solution_simd_wasm_bin.js"))
$mpOk = $mpOk -and (Try-Download -Urls @("$mpBase/face_mesh_solution_simd_wasm_bin.wasm") -OutPath (Join-Path $MP_DIR "face_mesh_solution_simd_wasm_bin.wasm"))
# 关键：有些构建需要 face_mesh.binarypb
$mpOk = $mpOk -and (Try-Download -Urls @("$mpBase/face_mesh.binarypb") -OutPath (Join-Path $MP_DIR "face_mesh.binarypb"))
if (-not $mpOk) { throw "MediaPipe FaceMesh assets download failed." }

# ---- 3) three.js ----
$threeOk = Try-Download -Urls @(
  "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js",
  "https://unpkg.com/three@0.160.0/build/three.min.js"
) -OutPath (Join-Path $THR_DIR "three.min.js")
if (-not $threeOk) { throw "three.min.js download failed." }

# ---- 4) js-yaml ----
$yamlOk = Try-Download -Urls @(
  "https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js",
  "https://unpkg.com/js-yaml@4.1.0/dist/js-yaml.min.js"
) -OutPath (Join-Path $YML_DIR "js-yaml.min.js")
if (-not $yamlOk) { throw "js-yaml.min.js download failed." }

# ---- 5) Copy gaze assets ----
$copyList = @("face_model_all.npy","camera_calibration_matrix.yaml","individualized_calibration.yaml","mdsk_gaze_model.onnx")
foreach ($f in $copyList) {
  $src = Join-Path $GAZE_SRC $f
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $GAZE_DST $f) -Force
    Write-Host "Copied: $f -> renderer\gaze_assets\$f"
  } else {
    Write-Warning "Missing (skip copy): $src"
  }
}
Write-Host "`n[ALL DONE] Vendors ready."
