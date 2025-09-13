// scripts/rebuild_addon.js
// Rebuild native addon for the currently installed Electron version.
const { spawnSync } = require('child_process');

function getElectronVersion() {
  try {
    const ver = require('electron/package.json').version;
    if (!ver) throw new Error('No version in electron/package.json');
    return ver;
  } catch (e) {
    console.error('[rebuild:addon] Cannot resolve electron version:', e.message || e);
    process.exit(1);
  }
}

function run() {
  const target = getElectronVersion();
  const arch = process.arch; // 'x64', 'arm64', etc.

  const args = [
    'rebuild',
    '--runtime=electron',
    `--target=${target}`,
    '--dist-url=https://electronjs.org/headers',
    `--arch=${arch}`,
  ];

  console.log(`[rebuild:addon] node-gyp ${args.join(' ')}`);
  const r = spawnSync(process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp', args, {
    stdio: 'inherit',
    env: process.env,
  });
  if (r.error) {
    console.error('[rebuild:addon] spawn error:', r.error);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`[rebuild:addon] failed with code ${r.status}`);
    process.exit(r.status || 1);
  }
  console.log('[rebuild:addon] done');
}

run();

