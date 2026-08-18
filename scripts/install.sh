#!/usr/bin/env sh
# hiq-cortex installer — macOS / Linux
#
#   curl -fsSL https://raw.githubusercontent.com/HiQ-AI/hiq-cortex-cli/main/scripts/install.sh | sh
#
# Env:
#   HIQ_CORTEX_VERSION   version to install (default: latest release)
#   HIQ_CORTEX_INSTALL   install directory  (default: ~/.local/bin)
#   HIQ_CORTEX_BASE_URL  download origin    (default: GitHub Releases; set this to a mirror)
#
# Deliberately POSIX sh: this gets piped into whatever /bin/sh the box has.
set -eu

REPO=HiQ-AI/hiq-cortex-cli
INSTALL_DIR="${HIQ_CORTEX_INSTALL:-$HOME/.local/bin}"

die() { printf '错误: %s\n' "$1" >&2; exit 1; }
info() { printf '%s\n' "$1" >&2; }

command -v curl >/dev/null 2>&1 || die "需要 curl"
command -v tar  >/dev/null 2>&1 || die "需要 tar"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) die "不支持的系统: $(uname -s)。Windows 请用 scripts/install.ps1" ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "不支持的架构: $(uname -m)" ;;
esac

# No version lookup: GitHub resolves `releases/latest/download/<asset>` itself,
# which keeps a first install off the anonymous API and its 60-req/hour limit.
version="${HIQ_CORTEX_VERSION:-}"
if [ -n "${HIQ_CORTEX_BASE_URL:-}" ]; then
  base="$HIQ_CORTEX_BASE_URL"
elif [ -n "$version" ]; then
  base="https://github.com/$REPO/releases/download/v${version#v}"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

archive="hiq-cortex-$os-$arch.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

info "下载 hiq-cortex ${version:-latest} ($os-$arch)…"
curl -fsSL "$base/$archive" -o "$tmp/$archive" || die "下载失败: $base/$archive"

# Checksums are advisory: verify when the file and a hashing tool are both
# available, never block the install because the box lacks shasum.
if curl -fsSL "$base/checksums.txt" -o "$tmp/sums.txt" 2>/dev/null; then
  if command -v shasum >/dev/null 2>&1; then sha=$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)
  elif command -v sha256sum >/dev/null 2>&1; then sha=$(sha256sum "$tmp/$archive" | cut -d' ' -f1)
  else sha=""; fi
  if [ -n "$sha" ]; then
    grep -q "$sha" "$tmp/sums.txt" || die "校验和不匹配,已中止安装"
    info "校验和 OK"
  fi
fi

tar xzf "$tmp/$archive" -C "$tmp" || die "解压失败"
mkdir -p "$INSTALL_DIR"
mv "$tmp/hiq-cortex" "$INSTALL_DIR/hiq-cortex"
chmod +x "$INSTALL_DIR/hiq-cortex"

# Downloads via curl carry no quarantine flag, but a binary that took a detour
# through a browser or an archiver does — clear it so Gatekeeper stays quiet.
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$INSTALL_DIR/hiq-cortex" 2>/dev/null || true

info ""
info "已安装: $INSTALL_DIR/hiq-cortex"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) info "下一步: hiq-cortex login" ;;
  *)
    info ""
    info "$INSTALL_DIR 不在 PATH 里,把这行加进 ~/.zshrc 或 ~/.bashrc:"
    info "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
