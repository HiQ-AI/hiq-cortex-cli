import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {expectedFiles} from '../.github/scripts/release-contract.mjs';

const dir = resolve(process.argv[2] || 'dist-bin');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const name = Object.keys(pkg.bin)[0];
const expected = expectedFiles('binaries');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.deepEqual(readdirSync(dir).sort(), Object.keys(expected).sort(), 'Unexpected native output set');
const lines = readFileSync(join(dir, 'checksums.txt'), 'utf8').trim().split('\n');
const sums = new Map(lines.map(line => {
  const match = line.match(/^([a-f0-9]{64})\s+\.\/(\S+)$/);
  assert(match, 'Invalid checksum record');
  return [match[2], match[1]];
}));
assert.equal(lines.length, sums.size, 'Duplicate checksum record');
assert.deepEqual([...sums.keys()].sort(), Object.keys(expected).filter(file => file !== 'checksums.txt').sort());
const home = mkdtempSync(join(tmpdir(), `${name}-native-check-`));
let executed = false;
try {
  for (const [filename, platform] of Object.entries(expected)) {
    if (filename === 'checksums.txt') continue;
    const archive = join(dir, filename);
    assert.equal(hash(readFileSync(archive)), sums.get(filename));
    const root = `${name}-${pkg.version}`;
    const member = `bin/${name}` + (platform === 'win32-x64' ? '.exe' : '');
    const listing = execFileSync('tar', ['-tzf', archive], {encoding: 'utf8'}).trim().split('\n').map(path => path.replace(/\/$/, ''));
    assert.deepEqual(listing.sort(), [root, `${root}/bin`, `${root}/${member}`, `${root}/manifest.json`].sort());
    const types = execFileSync('tar', ['-tvzf', archive], {encoding: 'utf8'}).trim().split('\n');
    assert(types.every(line => /^[d-]/.test(line)), 'Only ordinary directories/files are allowed');
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, `${root}/manifest.json`], {encoding: 'utf8'}));
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.platform, platform);
    assert.equal(manifest.executable, `bin/${name}`);
    if (process.env.GITHUB_SHA) assert.equal(manifest.sourceCommit, process.env.GITHUB_SHA);
    const binary = execFileSync('tar', ['-xOzf', archive, `${root}/${member}`], {maxBuffer: 256 * 1024 * 1024});
    assert.equal(hash(binary), manifest.binarySha256);
    if (platform.startsWith('darwin-')) {
      assert.equal(binary.subarray(0, 4).toString('hex'), 'cffaedfe');
      assert.equal(binary.readUInt32LE(4), platform.endsWith('arm64') ? 0x0100000c : 0x01000007);
    } else if (platform.startsWith('linux-')) {
      assert.equal(binary.subarray(0, 6).toString('hex'), '7f454c460201');
      assert.equal(binary.readUInt16LE(18), platform.endsWith('arm64') ? 183 : 62);
    } else {
      assert.equal(binary.subarray(0, 2).toString(), 'MZ');
      const pe = binary.readUInt32LE(0x3c);
      assert.equal(binary.subarray(pe, pe + 4).toString('hex'), '50450000');
      assert.equal(binary.readUInt16LE(pe + 4), 0x8664);
    }
    if (platform === `${process.platform}-${process.arch}`) {
      const executable = join(home, name + (platform.startsWith('win32-') ? '.exe' : ''));
      writeFileSync(executable, binary, {mode: 0o755});
      const env = {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, 'config'), QUERYING_LCA_DATASETS_BASE: 'http://127.0.0.1:9',
        QUERYING_LCA_DATASETS_OAUTH_URL: 'http://127.0.0.1:9/api/cortex/oauth',
      };
      const run = args => execFileSync(executable, args, {env, cwd: home, encoding: 'utf8', timeout: 30_000});
      assert.equal(run(['version']).trim(), pkg.version);
      assert(run(['--help']).includes(name));
      assert(run(['search-datasets', '--help']).includes('search-datasets'));
      assert.throws(() => run(['doctor']), error => error.status === 2 && String(error.stdout).includes(`${name} login`));
      executed = true;
    }
    console.log(`Verified ${filename}: SHA256, single-root manifest, binary digest and ${platform} architecture.`);
  }
  assert(executed, 'No native binary matched this build host');
  console.log(`Native version/help/missing-credential doctor passed on ${process.platform}-${process.arch}.`);
} finally {
  rmSync(home, {recursive: true, force: true});
}
