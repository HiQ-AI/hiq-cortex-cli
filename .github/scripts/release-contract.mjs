// Expected build output contract, independent of producer manifest claims.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const binaries = {
  "lca-background-data-darwin-arm64.tar.gz": "darwin-arm64",
  "lca-background-data-darwin-x64.tar.gz": "darwin-x64",
  "lca-background-data-linux-x64.tar.gz": "linux-x64",
  "lca-background-data-linux-arm64.tar.gz": "linux-arm64",
  "lca-background-data-windows-x64.zip": "windows-x64",
  "checksums.txt": "portable"
};
export function expectedFiles(kind) {
  if (kind === 'binaries') return binaries;
  assert.equal(kind, 'npm-package');
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
  return {[`${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`]: 'portable'};
}
export function validateManifest(manifest, kind) {
  const expected = expectedFiles(kind);
  assert.deepEqual(manifest.files.map(f => f.name).sort(), Object.keys(expected).sort(), 'Unexpected candidate file set');
  for (const file of manifest.files) assert.equal(file.platform, expected[file.name], `Wrong platform: ${file.name}`);
  const producers = kind === 'binaries' ? ['macOS-ARM64', 'macOS-X64'] : ['Linux-X64'];
  assert(producers.includes(manifest.producerPlatform), 'Unexpected producer platform');
}
