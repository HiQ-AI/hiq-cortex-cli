#!/usr/bin/env sh
# Querying LCA Datasets installer; release defaults are rendered at CDN publication.
set -eu

DEFAULT_VERSION=""
DEFAULT_BASE=""
TOOL=querying-lca-datasets
INSTALL_DIR="${QUERYING_LCA_DATASETS_INSTALL:-$HOME/.local/bin}"
version="${QUERYING_LCA_DATASETS_VERSION:-$DEFAULT_VERSION}"
version="${version#v}"

die() { printf 'Error: %s\n' "$1" >&2; exit 1; }
info() { printf '%s\n' "$1" >&2; }
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

if [ -n "${QUERYING_LCA_DATASETS_BASE_URL:-}" ]; then
  base="$QUERYING_LCA_DATASETS_BASE_URL"
elif [ -n "${QUERYING_LCA_DATASETS_VERSION:-}" ]; then
  base="https://download.hiq.earth/cli/$TOOL/releases/v$version"
else
  base="$DEFAULT_BASE"
fi
[ -n "$base" ] || die "Use a versioned CDN installer, or set QUERYING_LCA_DATASETS_BASE_URL"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "Unsupported OS; use the Windows installer on Windows" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "Unsupported architecture: $(uname -m)" ;;
esac

archive="$TOOL-$os-$arch.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
info "Downloading Querying LCA Datasets ${version:-from configured origin} ($os-$arch)"
curl -fsSL "$base/$archive" -o "$tmp/$archive" || die "Archive download failed"
curl -fsSL "$base/checksums.txt" -o "$tmp/sums.txt" || die "Checksum download failed"
if command -v shasum >/dev/null 2>&1; then sha=$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)
elif command -v sha256sum >/dev/null 2>&1; then sha=$(sha256sum "$tmp/$archive" | cut -d' ' -f1)
else die "shasum or sha256sum is required"; fi
expected=$(while read -r digest name; do
  if [ "${name#./}" = "$archive" ]; then printf '%s\n' "$digest"; fi
done < "$tmp/sums.txt")
[ "$sha" = "$expected" ] || die "Checksum mismatch or duplicate record"
mkdir "$tmp/unpacked"
tar xzf "$tmp/$archive" -C "$tmp/unpacked" --strip-components 1 || die "Extraction failed"
[ -f "$tmp/unpacked/bin/$TOOL" ] || die "Missing native executable"
mkdir -p "$INSTALL_DIR"
mv "$tmp/unpacked/bin/$TOOL" "$INSTALL_DIR/$TOOL"
chmod +x "$INSTALL_DIR/$TOOL"
info "Installed: $INSTALL_DIR/$TOOL"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) info "Next: querying-lca-datasets login" ;;
  *) info "Next: $INSTALL_DIR/querying-lca-datasets login (or add the install directory to PATH)" ;;
esac
