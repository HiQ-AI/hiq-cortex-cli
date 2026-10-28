#!/usr/bin/env bash
# Mirrors a release to download.hiq.earth (AWS S3 + CloudFront).
#
# GitHub is the source of truth; the CDN is what end users actually reach —
# github.com and raw.githubusercontent.com are both blocked in mainland China,
# where most of these users are.
#
#   AWS_PROFILE=cortex-cw ./scripts/mirror-to-cdn.sh v0.1.2
#
# Layout under the shared cortex-desktop-downloads bucket — namespaced per tool,
# so hiq-editor and anything after it drop in beside this one:
#   cli/<tool>/install.sh|.ps1   the installers, CDN-default variants
#   cli/<tool>/latest/<asset>    stable names — what install.sh fetches
#   cli/<tool>/releases/v<ver>/… archive
set -euo pipefail

TAG="${1:?用法: mirror-to-cdn.sh v<version>}"
BUCKET="${DOWNLOAD_S3_BUCKET:-cortex-desktop-downloads}"
DIST="${DOWNLOAD_CF_DIST_ID:-E9A45DLEU078N}"
CDN=https://download.hiq.earth
REPO=HiQ-AI/hiq-cortex-cli
TOOL=lca-background-data

cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

echo "→ 拉 $TAG 的产物"
gh release download "$TAG" --repo "$REPO" --dir "$tmp" \
  --pattern 'lca-background-data-*' --pattern 'checksums.txt'

# Fail closed on checksum errors before creating any CDN object.
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp" && sha256sum -c checksums.txt)
else
  (cd "$tmp" && shasum -a 256 -c checksums.txt)
fi

put_new_or_identical() {
  local file="$1" key="$2" cache="$3" type="$4"
  if aws s3api head-object --bucket "$BUCKET" --key "$key" >"$tmp/head.json" 2>"$tmp/head.error"; then
    aws s3api get-object --bucket "$BUCKET" --key "$key" "$tmp/existing-object" >/dev/null
    cmp -s "$file" "$tmp/existing-object" || { printf 'Refusing to replace existing object: %s\n' "$key" >&2; exit 1; }
    return
  fi
  grep -q '(404)' "$tmp/head.error" || { printf 'Cannot confirm object is absent: %s\n' "$key" >&2; exit 1; }
  aws s3api put-object --bucket "$BUCKET" --key "$key" --body "$file" \
    --if-none-match '*' --cache-control "$cache" --content-type "$type" >/dev/null
}

echo "→ 传 S3（只创建新对象或验证相同字节，不覆盖）"
for f in "$tmp"/*; do
  name=$(basename "$f")
  put_new_or_identical "$f" "cli/$TOOL/releases/$TAG/$name" 'public,max-age=31536000,immutable' 'application/octet-stream'
  put_new_or_identical "$f" "cli/$TOOL/latest/$name" 'public,max-age=300' 'application/octet-stream'
done

# The installers served from the CDN default to the CDN — otherwise someone who
# reached us through the mirror would immediately be sent back to a blocked host.
sed "s#^DEFAULT_BASE=.*#DEFAULT_BASE=\"$CDN/cli/$TOOL/latest\"#" scripts/install.sh > "$tmp/install.sh"
sed "s#else { \"https://github.com/\$Repo/releases/latest/download\" }#else { \"$CDN/cli/$TOOL/latest\" }#" scripts/install.ps1 > "$tmp/install.ps1"
grep -q "^DEFAULT_BASE=\"$CDN/cli/$TOOL/latest\"$" "$tmp/install.sh" || { echo "install.sh 的 DEFAULT_BASE 没被改写,格式变了?"; exit 1; }
grep -q "$CDN/cli/$TOOL/latest" "$tmp/install.ps1" || { echo "install.ps1 的默认 base 没被改写,格式变了?"; exit 1; }

put_new_or_identical "$tmp/install.sh" "cli/$TOOL/install.sh" 'public,max-age=300' 'text/x-shellscript'
put_new_or_identical "$tmp/install.ps1" "cli/$TOOL/install.ps1" 'public,max-age=300' 'text/plain'

echo "→ CloudFront 失效"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/cli/$TOOL/*" --query 'Invalidation.Id' --output text

echo
echo "已镜像: $CDN/cli/$TOOL/install.sh"
