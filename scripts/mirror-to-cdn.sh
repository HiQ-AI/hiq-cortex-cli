#!/usr/bin/env bash
# Mirrors a release to download.hiq.earth (AWS S3 + CloudFront).
#
# GitHub is the source of truth; the CDN is what end users actually reach —
# github.com and raw.githubusercontent.com are both blocked in mainland China,
# where most of these users are.
#
#   AWS_PROFILE=cortex-cw ./scripts/mirror-to-cdn.sh v0.1.2
#
# Layout under the shared cortex-desktop-downloads bucket:
#   cli/latest/<asset>        stable names — what install.sh fetches
#   cli/releases/v<ver>/…     archive
#   cli/install.sh|.ps1       the installers themselves, CDN-default variants
set -euo pipefail

TAG="${1:?用法: mirror-to-cdn.sh v<version>}"
BUCKET="${DOWNLOAD_S3_BUCKET:-cortex-desktop-downloads}"
DIST="${DOWNLOAD_CF_DIST_ID:-E9A45DLEU078N}"
CDN=https://download.hiq.earth
REPO=HiQ-AI/hiq-cortex-cli

cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

echo "→ 拉 $TAG 的产物"
gh release download "$TAG" --repo "$REPO" --dir "$tmp" \
  --pattern 'hiq-cortex-*' --pattern 'checksums.txt'

echo "→ 传 S3"
for f in "$tmp"/*; do
  name=$(basename "$f")
  aws s3 cp "$f" "s3://$BUCKET/cli/latest/$name"       --cache-control 'public,max-age=300' --only-show-errors
  aws s3 cp "$f" "s3://$BUCKET/cli/releases/$TAG/$name" --cache-control 'public,max-age=31536000,immutable' --only-show-errors
done

# The installers served from the CDN default to the CDN — otherwise someone who
# reached us through the mirror would immediately be sent back to a blocked host.
sed "s#^DEFAULT_BASE=.*#DEFAULT_BASE=\"$CDN/cli/latest\"#" scripts/install.sh > "$tmp/install.sh"
sed "s#else { \"https://github.com/\$Repo/releases/latest/download\" }#else { \"$CDN/cli/latest\" }#" scripts/install.ps1 > "$tmp/install.ps1"
grep -q "^DEFAULT_BASE=\"$CDN/cli/latest\"$" "$tmp/install.sh" || { echo "install.sh 的 DEFAULT_BASE 没被改写,格式变了?"; exit 1; }
grep -q "$CDN/cli/latest" "$tmp/install.ps1" || { echo "install.ps1 的默认 base 没被改写,格式变了?"; exit 1; }

aws s3 cp "$tmp/install.sh"  "s3://$BUCKET/cli/install.sh"  --content-type 'text/x-shellscript' --cache-control 'public,max-age=300' --only-show-errors
aws s3 cp "$tmp/install.ps1" "s3://$BUCKET/cli/install.ps1" --content-type 'text/plain'         --cache-control 'public,max-age=300' --only-show-errors

echo "→ CloudFront 失效"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/cli/*' --query 'Invalidation.Id' --output text

echo
echo "已镜像: $CDN/cli/install.sh"
