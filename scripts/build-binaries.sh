#!/usr/bin/env bash
# Compile five self-contained binaries into Host-compatible native archives.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=dist-bin
rm -rf "$OUT" && mkdir -p "$OUT"
bun scripts/stamp-version.mjs
VERSION=$(node -p "JSON.parse(require('node:fs').readFileSync('package.json')).version")
TOOL=querying-lca-datasets
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

# Baseline x64 targets do not require AVX2.
TARGETS=(
  "darwin-arm64=bun-darwin-arm64"
  "darwin-x64=bun-darwin-x64-baseline"
  "linux-x64=bun-linux-x64-baseline"
  "linux-arm64=bun-linux-arm64"
  "win32-x64=bun-windows-x64-baseline"
)

for entry in "${TARGETS[@]}"; do
  platform="${entry%%=*}"
  target="${entry#*=}"
  ext=""; [[ "$platform" == win32-* ]] && ext=".exe"
  root="$STAGING/$TOOL-$VERSION"
  mkdir -p "$root/bin"
  bin="$root/bin/$TOOL$ext"
  printf 'Building %s\n' "$platform"
  bun build src/cli.ts --compile --minify --sourcemap=none --target="$target" --outfile "$bin"
  if [[ "$platform" == darwin-* && "$(uname -s)" == Darwin ]]; then
    codesign --force --sign - "$bin"
  fi
  chmod +x "$bin"
  rm -f "$bin.map"
  node scripts/write-native-manifest.mjs "$root" "$platform"
  chmod 755 "$root" "$root/bin"
  chmod 644 "$root/manifest.json"
  TZ=UTC touch -t 197001010000.00 "$root" "$root/bin" "$root/manifest.json" "$bin"
  if [[ "$(uname -s)" == Darwin ]]; then
    COPYFILE_DISABLE=1 tar --format ustar --uid 0 --gid 0 --uname root --gname root -cf - -C "$STAGING" "$TOOL-$VERSION" | gzip -n > "$OUT/$TOOL-$platform.tar.gz"
  else
    tar --format ustar --owner=0 --group=0 --numeric-owner -cf - -C "$STAGING" "$TOOL-$VERSION" | gzip -n > "$OUT/$TOOL-$platform.tar.gz"
  fi
  rm -rf "$root"
done

(cd "$OUT" && shasum -a 256 ./*.tar.gz > checksums.txt)
ls -lh "$OUT"
