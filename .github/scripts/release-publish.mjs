// Never replace public assets. A rerun is a no-op only for an identical release.
import {execFileSync} from 'node:child_process';
import {readFileSync, lstatSync} from 'node:fs';
import {basename} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const repo = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
const files = process.argv.slice(2);
assert(files.length > 0);
const gh = (...args) => execFileSync('gh', args, {maxBuffer: 512 * 1024 * 1024});
const api = (...args) => JSON.parse(gh('api', ...args));
const hash = b => createHash('sha256').update(b).digest('hex');
const expected = files.map(file => {
  assert(lstatSync(file).isFile(), `Not a regular file: ${file}`);
  const bytes = readFileSync(file);
  return {name: basename(file), size: bytes.length, sha256: hash(bytes)};
});
assert.equal(new Set(expected.map(f => f.name)).size, expected.length);
// Enumeration distinguishes absence from auth/network/server errors: those throw.
const find = () => {
  const matches = api(`repos/${repo}/releases?per_page=100`, '--paginate', '--slurp')
    .flat().filter(r => r.tag_name === tag);
  assert(matches.length <= 1, 'Ambiguous release tag');
  return matches[0];
};
const verify = release => {
  assert(release && !release.draft && !release.prerelease, 'Expected a published stable release');
  const assets = api(`repos/${repo}/releases/${release.id}/assets?per_page=100`, '--paginate', '--slurp').flat();
  assert.deepEqual(assets.map(a => a.name).sort(), expected.map(f => f.name).sort(), 'Release asset set differs');
  for (const file of expected) {
    const asset = assets.find(a => a.name === file.name);
    assert.equal(asset.size, file.size, `Release asset size differs: ${file.name}`);
    const bytes = gh('api', `repos/${repo}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream');
    assert.equal(hash(bytes), file.sha256, `Release asset digest differs: ${file.name}`);
  }
};
const existing = find();
if (existing) {
  verify(existing);
  console.log('Existing release matches every candidate asset; nothing changed.');
} else {
  // Any creation failure is terminal, including a concurrent creator. No upload fallback.
  gh('release', 'create', tag, ...files, '--repo', repo, '--title', tag, '--generate-notes', '--verify-tag');
  verify(find());
  console.log('Created release and verified every asset.');
}
