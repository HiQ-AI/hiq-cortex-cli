import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const [dir, platform] = process.argv.slice(2);
assert(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'].includes(platform));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const name = Object.keys(pkg.bin)[0];
const binary = readFileSync(join(dir, 'bin', name + (platform.startsWith('win32-') ? '.exe' : '')));
const manifest = {
  name, version: pkg.version, platform, executable: `bin/${name}`,
  binarySha256: createHash('sha256').update(binary).digest('hex'),
};
if (process.env.GITHUB_SHA) {
  assert.match(process.env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  manifest.sourceCommit = process.env.GITHUB_SHA;
}
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
