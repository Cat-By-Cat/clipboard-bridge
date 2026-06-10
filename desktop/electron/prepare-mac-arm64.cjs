const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  process.exit(0);
}

function commandPath(command) {
  const result = spawnSync('/bin/zsh', ['-lc', 'command -v ' + command], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

let sevenZip = commandPath('7zz') || commandPath('7z');
if (!sevenZip) {
  const install = spawnSync('/bin/zsh', ['-lc', 'brew install p7zip'], { stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status ?? 1);
  sevenZip = commandPath('7zz') || commandPath('7z');
}

if (!sevenZip) {
  console.error('Could not find 7zz or 7z after installing p7zip.');
  process.exit(1);
}

const target = path.resolve(__dirname, '..', '..', 'node_modules', '7zip-bin', 'mac', 'arm64', '7za');
fs.mkdirSync(path.dirname(target), { recursive: true });
try { fs.rmSync(target, { force: true }); } catch {}
fs.symlinkSync(sevenZip, target);
fs.chmodSync(target, 0o755);

const verify = spawnSync(target, ['--help'], { stdio: 'ignore' });
if (verify.status !== 0) {
  console.error('Prepared 7za at ' + target + ', but it did not execute.');
  process.exit(verify.status ?? 1);
}
console.log('Prepared Electron Builder 7za shim: ' + target + ' -> ' + sevenZip);
