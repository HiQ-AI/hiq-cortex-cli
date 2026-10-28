#!/usr/bin/env sh
# lca-background-data installer — macOS / Linux
#
#   curl -fsSL https://raw.githubusercontent.com/HiQ-AI/hiq-cortex-cli/main/scripts/install.sh | sh
#
# Env:
#   LCA_BACKGROUND_DATA_VERSION   version to install (default: latest release)
#   LCA_BACKGROUND_DATA_INSTALL   install directory  (default: ~/.local/bin)
#   LCA_BACKGROUND_DATA_BASE_URL  download origin    (default: GitHub Releases; set this to a mirror)
#
# Deliberately POSIX sh: this gets piped into whatever /bin/sh the box has.
set -eu

REPO=HiQ-AI/hiq-cortex-cli
INSTALL_DIR="${LCA_BACKGROUND_DATA_INSTALL:-$HOME/.local/bin}"

# Default download origin. scripts/mirror-to-cdn.sh rewrites this one line in
# the copy it serves from download.hiq.earth, so users behind the GFW get a
# reachable origin without a second copy of this script to keep in sync.
DEFAULT_BASE="https://github.com/$REPO/releases/latest/download"

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
version="${LCA_BACKGROUND_DATA_VERSION:-}"
if [ -n "${LCA_BACKGROUND_DATA_BASE_URL:-}" ]; then
  base="$LCA_BACKGROUND_DATA_BASE_URL"
elif [ -n "$version" ]; then
  base="https://github.com/$REPO/releases/download/v${version#v}"
else
  base="$DEFAULT_BASE"
fi

archive="lca-background-data-$os-$arch.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

info "下载 lca-background-data ${version:-latest} ($os-$arch)…"
curl -fsSL "$base/$archive" -o "$tmp/$archive" || die "下载失败: $base/$archive"

curl -fsSL "$base/checksums.txt" -o "$tmp/sums.txt" || die "无法取得校验和"
if command -v shasum >/dev/null 2>&1; then sha=$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)
elif command -v sha256sum >/dev/null 2>&1; then sha=$(sha256sum "$tmp/$archive" | cut -d' ' -f1)
else die "需要 shasum 或 sha256sum 校验下载"; fi
expected=$(while read -r digest name; do
  if [ "${name#./}" = "$archive" ]; then printf '%s\n' "$digest"; fi
done < "$tmp/sums.txt")
[ "$sha" = "$expected" ] || die "校验和不匹配或条目不唯一,已中止安装"
info "校验和 OK"

tar xzf "$tmp/$archive" -C "$tmp" || die "解压失败"
mkdir -p "$INSTALL_DIR"
mv "$tmp/lca-background-data" "$INSTALL_DIR/lca-background-data"
chmod +x "$INSTALL_DIR/lca-background-data"

# Downloads via curl carry no quarantine flag, but a binary that took a detour
# through a browser or an archiver does — clear it so Gatekeeper stays quiet.
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$INSTALL_DIR/lca-background-data" 2>/dev/null || true

info ""
info "已安装: $INSTALL_DIR/lca-background-data"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) info "下一步: lca-background-data login" ;;
  *)
    info ""
    info "$INSTALL_DIR 不在 PATH 里,把这行加进 ~/.zshrc 或 ~/.bashrc:"
    info "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
