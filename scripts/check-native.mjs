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
assert.deepEqual(readdirSync(dir).sort(), Object.keys(expected).sort(), 'Unexpected native output set');
const sums = new Map(readFileSync(join(dir, 'checksums.txt'), 'utf8').trim().split('\n').map(line => {
  const match = line.match(/^([a-f0-9]{64})\s+\.\/(\S+)$/);
  assert(match, 'Invalid checksum record');
  return [match[2], match[1]];
}));
assert.deepEqual([...sums.keys()].sort(), Object.keys(expected).filter(file => file !== 'checksums.txt').sort(), 'Unexpected checksum set');
const home = mkdtempSync(join(tmpdir(), `${name}-native-check-`));
let executed = false;
try {
  for (const [filename, platform] of Object.entries(expected)) {
    if (filename === 'checksums.txt') continue;
    const archive = join(dir, filename);
    assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), sums.get(filename));
    const member = name + (platform === 'windows-x64' ? '.exe' : '');
    const zipped = filename.endsWith('.zip');
    const command = zipped ? 'unzip' : 'tar';
    const listing = execFileSync(command, zipped ? ['-Z1', archive] : ['-tzf', archive], {encoding: 'utf8'}).trim().split('\n');
    assert.deepEqual(listing, [member], `Unexpected archive members: ${filename}`);
    const binary = execFileSync(command, zipped ? ['-p', archive, member] : ['-xOzf', archive, member], {maxBuffer: 256 * 1024 * 1024});
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
      const executable = join(home, member);
      writeFileSync(executable, binary, {mode: 0o755});
      const env = {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, 'config'), LCA_BACKGROUND_DATA_BASE: 'http://127.0.0.1:9',
        LCA_BACKGROUND_DATA_OAUTH_URL: 'http://127.0.0.1:9/api/cortex/oauth',
      };
      const run = args => execFileSync(executable, args, {env, cwd: tmpdir(), encoding: 'utf8', timeout: 30_000});
      assert.equal(run(['version']).trim(), pkg.version);
      assert(run(['--help']).includes(name));
      assert(run(['search-datasets', '--help']).includes('search-datasets'));
      assert.throws(() => run(['doctor']), error => error.status === 2 && String(error.stdout).includes(`${name} login`));
      executed = true;
    }
    console.log(`Verified ${filename}: SHA256, archive member and ${platform} executable header.`);
  }
  assert(executed, 'No native binary matched this build host');
  console.log(`Native version/help/missing-credential doctor passed on ${process.platform}-${process.arch}.`);
} finally {
  rmSync(home, {recursive: true, force: true});
}
