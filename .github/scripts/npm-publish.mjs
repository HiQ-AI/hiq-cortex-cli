// Publish the exact packed bytes once; only an identical npm version is a no-op.
import {execFileSync, spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const [tarball] = process.argv.slice(2);
assert.equal(process.argv.length, 3, 'Expected exactly one tarball');
const {name, version} = JSON.parse(readFileSync('package.json'));
assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, 'Tag and package version differ');
const bytes = readFileSync(tarball);
const digest = (algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
const registry = 'https://registry.npmjs.org/';
const view = spawnSync('npm', ['view', `${name}@${version}`, 'dist', '--json', '--registry', registry], {encoding: 'utf8'});
if (view.error) throw view.error;
if (view.status === 0) {
  const dist = JSON.parse(view.stdout);
  assert.equal(dist.shasum, digest('sha1', 'hex'), 'Existing npm version has different bytes');
  assert.equal(dist.integrity, `sha512-${digest('sha512', 'base64')}`, 'Existing npm integrity differs');
  console.log('Existing npm version matches candidate; publish skipped.');
} else {
  // npm emits a structured error for --json. Never interpret general failure as absence.
  const error = JSON.parse(view.stdout).error;
  assert.equal(error?.code, 'E404', `npm registry lookup failed: ${view.stderr}`);
  execFileSync('npm', ['publish', tarball, '--access', 'public', '--provenance', '--ignore-scripts', '--registry', registry], {stdio: 'inherit'});
}
