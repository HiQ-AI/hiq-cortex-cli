#!/usr/bin/env bash
# Publish reviewed native output directly to immutable, versioned CDN keys.
set -euo pipefail
cd "$(dirname "$0")/.."
INPUT=$(cd "${1:?Usage: publish-cdn.sh <native-output-directory>}" && pwd)
BUCKET="${DOWNLOAD_S3_BUCKET:-cortex-desktop-downloads}"
TOOL=querying-lca-datasets
CDN=https://download.hiq.earth
node .github/scripts/verify-release.mjs
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$INPUT" && sha256sum -c checksums.txt)
else
  (cd "$INPUT" && shasum -a 256 -c checksums.txt)
fi
node scripts/check-native.mjs "$INPUT"
VERSION=$(node -p "JSON.parse(require('node:fs').readFileSync('package.json')).version")
PREFIX="cli/$TOOL/releases/v$VERSION"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
node scripts/render-installers.mjs "$tmp/installers"

put_new_or_identical() {
  local file="$1" key="$2" type="$3"
  if aws s3api head-object --bucket "$BUCKET" --key "$key" >"$tmp/head.json" 2>"$tmp/head.error"; then
    aws s3api get-object --bucket "$BUCKET" --key "$key" "$tmp/existing-object" >/dev/null
    cmp -s "$file" "$tmp/existing-object" || { printf 'Refusing to replace existing object: %s\n' "$key" >&2; exit 1; }
  else
    grep -q '(404)' "$tmp/head.error" || { printf 'Cannot confirm object is absent: %s\n' "$key" >&2; exit 1; }
    aws s3api put-object --bucket "$BUCKET" --key "$key" --body "$file" \
      --if-none-match '*' --cache-control 'public,max-age=31536000,immutable' --content-type "$type" >/dev/null
  fi
  curl -fsSL "$CDN/$key" -o "$tmp/readback"
  cmp -s "$file" "$tmp/readback" || { printf 'CDN readback differs: %s\n' "$key" >&2; exit 1; }
  printf 'Created or verified CDN object: %s\n' "$key"
}

for file in "$INPUT"/*.tar.gz; do
  put_new_or_identical "$file" "$PREFIX/$(basename "$file")" 'application/gzip'
done
put_new_or_identical "$INPUT/checksums.txt" "$PREFIX/checksums.txt" 'text/plain'
put_new_or_identical "$tmp/installers/install.sh" "$PREFIX/install.sh" 'text/x-shellscript'
put_new_or_identical "$tmp/installers/install.ps1" "$PREFIX/install.ps1" 'text/plain'
