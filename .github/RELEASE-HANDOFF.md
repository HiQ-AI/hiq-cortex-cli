# Historical release handoff operations

Querying LCA Datasets now builds and publishes directly to versioned CDN objects.
Its active workflow does not use GitHub releases, tags or this transfer. The
helpers and mock tests remain historical tooling; this document does not authorize
cleanup of old evidence or distribution through the retired path.

Previously, release jobs staged candidates in unpublished `ci-transfer-RUN-ATTEMPT-KIND`
draft Releases. Consumers use the producer's job outputs (including the manifest
SHA-256), so a failed-job rerun continues to read the original producer attempt.
The transfer never publishes a draft or replaces an asset. Existing Actions
artifacts, public Releases and CDN objects are not cleanup targets.

The checked-in contract fixes every expected filename and target-platform field,
plus the allowed producer OS/architecture. It rejects missing, extra or mislabeled
files even if the manifest checksum is internally consistent. These assertions
validate the transfer contract, not executable architecture: the existing build
and native binary tests remain the executable validation gates.

## Acceptance boundary

Mock tests exercise integrity, identity, exact output sets and publication reruns.
They are not live GitHub transport acceptance. Verify authenticated upload/download
and anonymous denial separately using a reviewed commit already merged into the
default branch, without invoking the product tag release workflow. GitHub can
reject draft creation when `target_commitish` changes workflows relative to the
default branch: do not broaden PAT/workflow permissions to bypass that restriction.

## Retention and manual cleanup

Retain candidates for at least 7 days after successful completion of the run.
For failed/cancelled runs, retain at least 30 days and explicitly decide to abandon
reruns before cleanup. Retention expiry alone does not delete anything. A completed
run must be rechecked, and active reruns prevent cleanup. Removing candidates makes
consumer-only reruns impossible; rebuild all jobs if work resumes afterward.

The script below defaults to a dry-run JSON plan for one exact draft Release ID.
It verifies the draft namespace, repository, source SHA, workflow path, producer
attempt, completed run and minimum age. Review its asset list and any remaining
rollback/evidence dependency before applying. Public Releases are always rejected.
Use an already authorized maintainer identity; no new secret or permission is needed.

```sh
GITHUB_REPOSITORY=OWNER/REPO node .github/scripts/release-handoff-cleanup.mjs RELEASE_ID
# After reviewing the plan and confirming no remaining evidence/rollback dependency:
GITHUB_REPOSITORY=OWNER/REPO node .github/scripts/release-handoff-cleanup.mjs RELEASE_ID --apply
# Failed/cancelled runs additionally require --abandon-reruns in both commands.
```

This migration does not execute cleanup. Keep existing Actions artifacts until the
separate inventory and rollback review authorizes deletion.
