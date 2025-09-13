(cmpa) C:\Users\ROG>setx PYTHON "C:\Users\ROG\miniconda3\envs\cmpa\python.exe"

成功: 指定的值已得到保存。

(cmpa) C:\Users\ROG>setx GYP_MSVS_VERSION 2022

成功: 指定的值已得到保存。
npm uninstall electron
setx ELECTRON_MIRROR "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = "1"
npm config set script-shell "powershell.exe"

# 在项目根 D:\CMPA 下执行
New-Item -ItemType Directory -Force node_modules\electron\dist | Out-Null

Expand-Archive `
  -Path "$env:LOCALAPPDATA\electron\Cache\electron-v31.3.0-win32-x64.zip" `
  -DestinationPath "node_modules\electron\dist" `
  -Force

# 告诉 electron 包二进制路径（index.js 会读取 path.txt）
$exePath = (Resolve-Path ".\node_modules\electron\dist\electron.exe").Path
Set-Content -NoNewline -Path ".\node_modules\electron\path.txt" -Value $exePath


npm i -D electron@31.3.0

npm i --ignore-scripts
npm run build:addon


npx node-gyp rebuild `
  --runtime=electron `
  --target=31.3.0 `
  --dist-url=https://electronjs.org/headers `
  --arch=x64


$env:ELECTRON_OVERRIDE_DIST_PATH = (Resolve-Path ".\node_modules\electron\dist").Path
$env:ELECTRON_ENABLE_LOGGING = "1"
npm start

npm run build:addon

# 2) 安装 electron-builder
npm i -D electron-builder

# 3) 构建安装包（NSIS）
npm run dist

$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -ErrorAction SilentlyContinue
Start-Process powershell -Verb runAs -ArgumentList 'reg add HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock /v AllowDevelopmentWithoutDevLicense /t REG_DWORD /d 1 /f'

# 在项目根目录 D:\CMPA 下执行
New-Item -ItemType Directory -Force renderer\vendor\face_detection | Out-Null
Copy-Item -Recurse -Force node_modules\@mediapipe\face_detection\* renderer\vendor\face_detection\

PS D:\CMPA> New-Item -ItemType Directory -Force .\renderer\vendor\onnxruntime | Out-Null
PS D:\CMPA> Copy-Item -Force .\node_modules\onnxruntime-web\dist\* `
>>   -Destination .\renderer\vendor\onnxruntime\

$src = "node_modules\onnxruntime-web\dist"
$dst = "renderer\vendor\onnxruntime"
New-Item -ItemType Directory -Force $dst | Out-Null

# 把 UMD 入口脚本和所有 wasm/worker/mjs 资产都复制过来（递归查找）
$files = Get-ChildItem $src -Recurse -File -Include `
  "ort.min.js", `
  "ort.js", `
  "ort-wasm*.wasm", `
  "ort-wasm*.worker.js", `
  "ort-wasm*.mjs", `
  "ort-wasm*.js", `
  "ort-wasm*.data"

if ($files.Count -eq 0) {
  Write-Error "No ORT assets found under $src. Check installed onnxruntime-web version."
} else {
  $files | Copy-Item -Destination $dst -Force
  "Copied $($files.Count) ORT file(s) to $dst"
}

# 看看拷了哪些
Get-ChildItem $dst | Select-Object Name,Length

(base) D:\CMPA>powershell -ExecutionPolicy Bypass -File .\scripts\fetch_vendor.ps1