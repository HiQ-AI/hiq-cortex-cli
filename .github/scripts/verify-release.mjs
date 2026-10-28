import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'A stable numeric version is required');
assert.equal(process.env.GITHUB_REF_NAME, 'main', 'CDN publication is dispatched from reviewed main, never a tag');
assert.match(process.env.GITHUB_SHA || '', /^[a-f0-9]{40}$/, 'A release commit is required');
assert.equal(git(['rev-parse', 'HEAD']), process.env.GITHUB_SHA, 'Build checkout must match the release commit');
assert.equal(git(['status', '--porcelain']), '', 'Publication requires a clean tracked/untracked worktree');
git(['merge-base', '--is-ancestor', process.env.GITHUB_SHA, 'origin/main']);
console.log(`Verified ${pkg.version} from reviewed main commit ${process.env.GITHUB_SHA}.`);
