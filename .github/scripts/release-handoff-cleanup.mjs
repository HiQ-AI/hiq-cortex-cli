// Manual, reviewable cleanup. Default is dry-run; never scans/deletes old Actions artifacts.
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [id, ...flags] = process.argv.slice(2);
assert.match(id || '', /^\d+$/, 'Pass one exact draft Release ID');
assert(flags.every(f => ['--apply', '--abandon-reruns'].includes(f)));
const repo = process.env.GITHUB_REPOSITORY;
assert(repo, 'Set GITHUB_REPOSITORY');
const api = (...args) => JSON.parse(execFileSync('gh', ['api', ...args], {encoding: 'utf8'}));
const check = () => {
  const release = api(`repos/${repo}/releases/${id}`);
  assert.equal(release.draft, true, 'Never delete a published release');
  const body = JSON.parse(release.body);
  assert.equal(body.repository, repo);
  assert(['binaries', 'npm-package'].includes(body.kind));
  assert.match(body.run, /^\d+$/); assert.match(body.attempt, /^\d+$/);
  assert.equal(release.tag_name, `ci-transfer-${body.run}-${body.attempt}-${body.kind}`);
  const run = api(`repos/${repo}/actions/runs/${body.run}`);
  assert.equal(run.head_sha, body.sha);
  assert.equal(run.path, '.github/workflows/release.yml');
  assert.equal(run.status, 'completed', 'A run is still active');
  assert(Number(body.attempt) <= run.run_attempt);
  const retainedSince = Math.max(Date.parse(release.created_at), Date.parse(run.updated_at));
  assert(Number.isFinite(retainedSince), 'Missing retention timestamps');
  const ageDays = (Date.now() - retainedSince) / 86400000;
  const success = run.conclusion === 'success';
  assert(success || flags.includes('--abandon-reruns'), 'Explicitly abandon failed/cancelled reruns first');
  assert(ageDays >= (success ? 7 : 30), 'Draft is still within its retention period');
  return {releaseId: id, repository: repo, tag: release.tag_name, sourceSHA: body.sha,
    run: body.run, producerAttempt: body.attempt, conclusion: run.conclusion,
    ageDays: Math.floor(ageDays), assets: release.assets.map(a => ({id: a.id, name: a.name, size: a.size, digest: a.digest}))};
};
const plan = check();
console.log(JSON.stringify(plan, null, 2));
if (flags.includes('--apply')) {
  assert.deepEqual(check(), plan, 'Cleanup target changed since planning');
  execFileSync('gh', ['api', `repos/${repo}/releases/${id}`, '-X', 'DELETE'], {stdio: 'inherit'});
} else console.log('Dry run only. Review this plan before repeating with --apply.');
