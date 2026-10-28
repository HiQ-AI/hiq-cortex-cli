import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'A stable numeric version is required');
assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`, 'Tag must match the package version');
assert.match(process.env.GITHUB_SHA || '', /^[a-f0-9]{40}$/, 'A release commit is required');
execFileSync('git', ['merge-base', '--is-ancestor', process.env.GITHUB_SHA, 'origin/main'], {stdio: 'inherit'});
console.log(`Verified ${process.env.GITHUB_REF_NAME} on main ancestry.`);
