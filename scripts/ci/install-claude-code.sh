#!/usr/bin/env bash
#
# Installs a pinned Claude Code CLI for CI jobs that run
# scripts/claude/validate_plugin.sh, which fails in CI without `claude` (#16963).
#
# Downloads the platform package tarball from the npm registry, checks its
# pinned SHA-256, unpacks the `claude` binary into INSTALL_DIR and, under GitHub
# Actions, appends INSTALL_DIR to GITHUB_PATH. 2.1.318 is the first version
# checked with `claude plugin validate --profile directory`; bump the version
# and both checksums together.
#
# CI restores INSTALL_DIR from actions/cache (.github/actions/install-claude-code,
# #16985). A stamp file records the version and checksum the binary was installed
# from; when it matches the pin and `claude --version` runs, the download is
# skipped. `--cache-key` prints the key for that cache: platform, version and
# checksum, so a bump of either invalidates it.
set -euo pipefail

CLAUDE_CODE_VERSION="2.1.318"
SHA256_LINUX_X64="2a4d5e3bd0f5bd2959bb1955bd99ea97f57af162681991dcae00fee82f9d554f"
SHA256_LINUX_ARM64="429ff4a26e9782a8cbc6d1c011c4924906ecdd65e6de096f7f4bc5fcae416c8a"

REGISTRY="${CLAUDE_CODE_REGISTRY:-https://registry.npmjs.org}"
INSTALL_DIR="${CLAUDE_CODE_INSTALL_DIR:-${RUNNER_TEMP:-/tmp}/claude-code}"
MACHINE="${CLAUDE_CODE_MACHINE:-$(uname -s)-$(uname -m)}"
MAX_ATTEMPTS="${CLAUDE_CODE_MAX_ATTEMPTS:-3}"
RETRY_DELAY_SECONDS="${CLAUDE_CODE_RETRY_DELAY_SECONDS:-5}"

log() {
  echo "[install-claude-code] $*"
}

die() {
  echo "[install-claude-code] ERROR: $*" >&2
  exit 1
}

case "$MACHINE" in
  Linux-x86_64)
    platform="linux-x64"
    expected_sha="$SHA256_LINUX_X64"
    ;;
  Linux-aarch64 | Linux-arm64)
    platform="linux-arm64"
    expected_sha="$SHA256_LINUX_ARM64"
    ;;
  *)
    die "unsupported runner '$MACHINE'; only Linux x64 and arm64 are pinned"
    ;;
esac

if [[ "${1:-}" == "--cache-key" ]]; then
  echo "claude-code-${platform}-${CLAUDE_CODE_VERSION}-${expected_sha}"
  exit 0
elif [[ $# -gt 0 ]]; then
  die "unknown argument '$1'; usage: install-claude-code.sh [--cache-key]"
fi

add_to_github_path() {
  if [[ -n "${GITHUB_PATH:-}" ]]; then
    echo "$INSTALL_DIR" >>"$GITHUB_PATH"
  fi
}

stamp="${INSTALL_DIR}/.claude-code-pin"
pin="${CLAUDE_CODE_VERSION} ${expected_sha}"
if [[ -x "${INSTALL_DIR}/claude" && -f "$stamp" && "$(cat "$stamp")" == "$pin" ]]; then
  if cached_version="$("${INSTALL_DIR}/claude" --version)"; then
    log "using cached ${cached_version} at ${INSTALL_DIR}/claude"
    add_to_github_path
    exit 0
  fi
  log "cached binary at ${INSTALL_DIR}/claude did not run; reinstalling"
fi
rm -f "$stamp"

package="claude-code-${platform}"
url="${REGISTRY}/@anthropic-ai/${package}/-/${package}-${CLAUDE_CODE_VERSION}.tgz"
mkdir -p "$INSTALL_DIR"
tarball="${INSTALL_DIR}/${package}-${CLAUDE_CODE_VERSION}.tgz"

attempt=1
until curl -fsSL --max-time 300 -o "$tarball" "$url"; do
  if ((attempt >= MAX_ATTEMPTS)); then
    die "download of $url failed after $attempt attempts"
  fi
  log "download attempt $attempt failed; retrying in $((RETRY_DELAY_SECONDS * attempt))s"
  sleep "$((RETRY_DELAY_SECONDS * attempt))"
  attempt=$((attempt + 1))
done

actual_sha="$(sha256sum "$tarball" | awk '{print $1}')"
if [[ "$actual_sha" != "$expected_sha" ]]; then
  die "checksum mismatch for $url: expected $expected_sha, got $actual_sha"
fi

tar -xzf "$tarball" -C "$INSTALL_DIR" --strip-components=1 package/claude
rm -f "$tarball"
chmod +x "${INSTALL_DIR}/claude"
log "installed $("${INSTALL_DIR}/claude" --version) at ${INSTALL_DIR}/claude"
echo "$pin" >"$stamp"

add_to_github_path
