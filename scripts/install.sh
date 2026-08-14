#!/bin/sh
# niuma install script — https://github.com/Ariaszzzhc/niuma
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Ariaszzzhc/niuma/main/scripts/install.sh | sh
#   curl -fsSL ... | sh -s v0.1.0          # pin a version (default: latest)
#   NIUMA_INSTALL=/opt/niuma sh install.sh   # install-root override
#
# Downloads the matching prebuilt archive from GitHub Releases, verifies it
# against the release's SHA256SUMS, and installs the binary as
# $NIUMA_INSTALL/bin/niuma (default ~/.local/bin). Supported targets:
# linux-amd64, darwin-aarch64 (Windows: use scripts/install.ps1).
# Requires the repository to be public (anonymous release downloads).

set -eu

REPO="Ariaszzzhc/niuma"

err() { echo "niuma install: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || err "required tool not found: $1"; }

need curl
need tar

# ---- Target ----
os=$(uname -s | tr '[:upper:]' '[:lower:]')
machine=$(uname -m)
case "$machine" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=aarch64 ;;
  *) err "unsupported architecture: $machine" ;;
esac
case "$os-$arch" in
  linux-amd64 | darwin-aarch64) target="$os-$arch" ;;
  *) err "no prebuilt niuma binary for $os-$arch (available: linux-amd64, darwin-aarch64, windows-amd64)" ;;
esac

# ---- Version: arg > $NIUMA_VERSION > latest release ----
version="${1:-${NIUMA_VERSION:-}}"
if [ -z "$version" ]; then
  version=$(
    curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
      grep '"tag_name"' | head -1 | cut -d'"' -f4
  )
  [ -n "$version" ] || err "could not resolve the latest release version"
fi
case "$version" in
  v*) ;;
  *) version="v$version" ;;
esac

asset="niuma-$target.tar.gz"
base="https://github.com/$REPO/releases/download/$version"

# ---- Download + verify ----
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "niuma install: downloading $asset ($version)"
curl -fsSL "$base/$asset" -o "$tmp/$asset" ||
  err "download failed: $base/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" ||
  err "download failed: $base/SHA256SUMS"

grep "  $asset\$" "$tmp/SHA256SUMS" > "$tmp/sum" ||
  err "SHA256SUMS has no entry for $asset"
if command -v sha256sum > /dev/null 2>&1; then
  (cd "$tmp" && sha256sum -c sum > /dev/null) ||
    err "checksum mismatch for $asset"
else
  need shasum
  (cd "$tmp" && shasum -a 256 -c sum > /dev/null) ||
    err "checksum mismatch for $asset"
fi

# ---- Install ----
bin_dir="${NIUMA_INSTALL:-$HOME/.local}/bin"
mkdir -p "$bin_dir"
tar -xzf "$tmp/$asset" -C "$bin_dir"
chmod +x "$bin_dir/niuma"

echo "niuma install: installed niuma $("$bin_dir/niuma" --version) to $bin_dir/niuma"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    echo
    echo "Add niuma to your PATH, e.g.:"
    echo "  export PATH=\"$bin_dir:\$PATH\""
    ;;
esac
