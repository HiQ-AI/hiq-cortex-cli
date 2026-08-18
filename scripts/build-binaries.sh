#!/usr/bin/env bash
# Cross-compiles the single-file executables shipped on GitHub Releases.
# One Bun toolchain builds every target, so this runs the same on a laptop and in CI.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION=$(bun -p "require('./package.json').version")
OUT=dist-bin
rm -rf "$OUT" && mkdir -p "$OUT"

bun scripts/stamp-version.mjs

# name=bun-target. `-baseline` targets omit AVX2 so the binaries also run on
# pre-2013 x64 hardware and inside VMs that mask CPU features.
TARGETS=(
  "darwin-arm64=bun-darwin-arm64"
  "darwin-x64=bun-darwin-x64-baseline"
  "linux-x64=bun-linux-x64-baseline"
  "linux-arm64=bun-linux-arm64"
  "windows-x64=bun-windows-x64-baseline"
)

for entry in "${TARGETS[@]}"; do
  name="${entry%%=*}"
  target="${entry#*=}"
  ext=""; [[ "$name" == windows-* ]] && ext=".exe"
  bin="$OUT/hiq-cortex-$name$ext"

  echo "→ $name"
  bun build src/cli.ts --compile --minify --sourcemap=none \
    --target="$target" --outfile "$bin"

  # Bun ad-hoc signs its Darwin output, but a re-sign here is what guarantees
  # the signature survives; unsigned arm64 Mach-O is killed on launch.
  if [[ "$name" == darwin-* && "$(uname -s)" == Darwin ]]; then
    codesign --force --sign - "$bin"
  fi

  # Archive per platform convention: zip on Windows, tar.gz elsewhere. The
  # member name is bare `hiq-cortex` so install scripts need no per-OS casing.
  staged="$OUT/hiq-cortex$ext"
  mv "$bin" "$staged"
  if [[ "$name" == windows-* ]]; then
    (cd "$OUT" && zip -q "hiq-cortex-$VERSION-$name.zip" "hiq-cortex$ext")
  else
    chmod +x "$staged"
    (cd "$OUT" && tar czf "hiq-cortex-$VERSION-$name.tar.gz" hiq-cortex)
  fi
  rm -f "$staged"
done

(cd "$OUT" && shasum -a 256 ./* > "hiq-cortex-$VERSION-checksums.txt")
echo && ls -lh "$OUT"
