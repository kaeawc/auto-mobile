#!/usr/bin/env bash
#
# Install ripgrep by downloading pre-built binaries from GitHub releases
#
# Usage: ./install-ripgrep.sh [OPTIONS]
#
# Options:
#   --version VERSION   ripgrep version to install (default and only: the pin)
#   --install-dir DIR   Directory to install binary (default: ~/.local/bin)
#   --dry-run           Print what would be done without executing
#   --help              Show this help message
#
# Supported platforms:
#   - Linux (x86_64, aarch64)
#   - macOS (x86_64, aarch64/Apple Silicon)
#   - Windows (x86_64, aarch64)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.github/actions/setup-ripgrep/ripgrep_version.sh
source "${SCRIPT_DIR}/ripgrep_version.sh"
# Cached, checksum-verified, backed-off release download (#17624).
# shellcheck source=scripts/lib/release-download.sh
source "${SCRIPT_DIR}/../../../scripts/lib/release-download.sh"

# Defaults
VERSION="$RIPGREP_VERSION"
INSTALL_DIR=""
DRY_RUN=false
TEMP_DIR=""

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

usage() {
  head -n 17 "$0" | tail -n 15 | sed 's/^# //' | sed 's/^#//'
}

log() {
  echo "[setup-ripgrep] $*"
}

error() {
  echo "[setup-ripgrep] ERROR: $*" >&2
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --version)
      VERSION="$2"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

# Detect OS
detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "macos" ;;
    CYGWIN*|MINGW*|MSYS*) echo "windows" ;;
    *)
      # Check for Windows via OS env var
      if [[ "${OS:-}" == "Windows_NT" ]]; then
        echo "windows"
      else
        error "Unsupported operating system: $(uname -s)"
        exit 1
      fi
      ;;
  esac
}

# Detect architecture
detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "x86_64" ;;
    aarch64|arm64) echo "aarch64" ;;
    *)
      error "Unsupported architecture: $(uname -m)"
      exit 1
      ;;
  esac
}

# Release target triple for the platform; the asset is
# ripgrep-<version>-<target>.tar.gz (.zip on Windows).
get_release_target() {
  local os="$1"
  local arch="$2"

  case "${os}-${arch}" in
    linux-x86_64) echo "x86_64-unknown-linux-musl" ;;
    linux-aarch64) echo "aarch64-unknown-linux-gnu" ;;
    macos-x86_64) echo "x86_64-apple-darwin" ;;
    macos-aarch64) echo "aarch64-apple-darwin" ;;
    windows-x86_64) echo "x86_64-pc-windows-msvc" ;;
    windows-aarch64) echo "aarch64-pc-windows-msvc" ;;
    *)
      error "Unsupported platform: ${os}-${arch}"
      exit 1
      ;;
  esac
}

get_download_url() {
  local os="$1"
  local target="$2"
  local version="$3"
  local ext="tar.gz"
  if [[ "$os" == "windows" ]]; then
    ext="zip"
  fi
  echo "https://github.com/BurntSushi/ripgrep/releases/download/${version}/ripgrep-${version}-${target}.${ext}"
}

# Get default install directory
get_default_install_dir() {
  local os="$1"
  case "$os" in
    windows)
      echo "${USERPROFILE:-$HOME}/.local/bin"
      ;;
    *)
      echo "$HOME/.local/bin"
      ;;
  esac
}

# Main installation logic
main() {
  local os arch target url install_dir archive_name expected_sha

  os=$(detect_os)
  arch=$(detect_arch)
  target=$(get_release_target "$os" "$arch")
  url=$(get_download_url "$os" "$target" "$VERSION")

  # Only the pinned version has committed checksums; refuse anything else
  # rather than install an unverified binary.
  if [[ "$VERSION" != "$RIPGREP_VERSION" ]] || ! expected_sha="$(ripgrep_release_sha256 "$target")"; then
    error "No pinned checksum for ripgrep ${VERSION} on ${target}; this action pins ${RIPGREP_VERSION} in ripgrep_version.sh."
    exit 1
  fi

  if [[ -z "$INSTALL_DIR" ]]; then
    install_dir=$(get_default_install_dir "$os")
  else
    install_dir="$INSTALL_DIR"
  fi

  archive_name=$(basename "$url")

  log "Platform: ${os}-${arch}"
  log "Version: ${VERSION}"
  log "Download URL: ${url}"
  log "Install directory: ${install_dir}"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "[DRY-RUN] Would create directory: ${install_dir}"
    log "[DRY-RUN] Would download: ${url}"
    log "[DRY-RUN] Would extract to: ${install_dir}"
    log "[DRY-RUN] Would verify: rg --version"
    exit 0
  fi

  # Create install directory
  mkdir -p "$install_dir"

  # Create temp directory for download (uses global TEMP_DIR for cleanup trap)
  TEMP_DIR=$(mktemp -d)

  # Download, or restore from the checksum-verified tool cache. On an upstream
  # outage release_fetch_pinned prints the UPSTREAM-DOWNLOAD-FAILURE line that
  # scripts/ci/known-flakes.txt matches.
  log "Fetching ripgrep ${VERSION} (sha256 ${expected_sha})..."
  if ! release_fetch_pinned "$url" "$expected_sha" "${TEMP_DIR}/${archive_name}" "ripgrep/${VERSION}"; then
    error "Failed to download ripgrep from ${url}"
    exit 1
  fi

  # Extract
  log "Extracting..."
  cd "$TEMP_DIR"

  case "$archive_name" in
    *.tar.gz)
      tar -xzf "$archive_name"
      # Find the rg binary in the extracted directory
      local extracted_dir
      extracted_dir=$(find . -maxdepth 1 -type d -name "ripgrep-*" | head -1)
      if [[ -n "$extracted_dir" ]]; then
        cp "${extracted_dir}/rg" "$install_dir/"
        chmod +x "${install_dir}/rg"
      else
        error "Could not find extracted ripgrep directory"
        exit 1
      fi
      ;;
    *.zip)
      if command -v unzip >/dev/null 2>&1; then
        unzip -q "$archive_name"
      elif command -v 7z >/dev/null 2>&1; then
        7z x -y "$archive_name" >/dev/null
      else
        # Try PowerShell on Windows
        powershell -Command "Expand-Archive -Path '$archive_name' -DestinationPath '.' -Force"
      fi
      # Find the rg binary
      local extracted_dir
      extracted_dir=$(find . -maxdepth 1 -type d -name "ripgrep-*" | head -1)
      if [[ -n "$extracted_dir" ]]; then
        cp "${extracted_dir}/rg.exe" "$install_dir/" 2>/dev/null || cp "${extracted_dir}/rg" "$install_dir/"
        chmod +x "${install_dir}/rg.exe" 2>/dev/null || chmod +x "${install_dir}/rg" 2>/dev/null || true
      else
        error "Could not find extracted ripgrep directory"
        exit 1
      fi
      ;;
    *)
      error "Unknown archive format: ${archive_name}"
      exit 1
      ;;
  esac

  log "Successfully installed ripgrep ${VERSION} to ${install_dir}"

  # Verify
  if [[ "$os" == "windows" ]]; then
    "${install_dir}/rg.exe" --version || "${install_dir}/rg" --version
  else
    "${install_dir}/rg" --version
  fi
}

main
