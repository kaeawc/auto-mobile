#!/usr/bin/env bash
#
# Verify Runtime Dependencies
#
# Checks that all expected runtime tools are available after running the
# installer. Exits non-zero if any required dependency is missing.
#
# Usage:
#   ./scripts/ci/verify-runtime-deps.sh

set -euo pipefail

# Refresh PATH — installer may have added ~/.bun/bin or Homebrew paths
prepend_path_if_dir() {
  local candidate="$1"
  if [[ -d "${candidate}" && ":${PATH}:" != *":${candidate}:"* ]]; then
    export PATH="${candidate}:${PATH}"
  fi
}

if [[ "$(uname -s)" == "Darwin" ]]; then
  homebrew_prefix=""
  if command -v brew >/dev/null 2>&1; then
    homebrew_prefix="$(brew --prefix 2>/dev/null || true)"
  fi
  prepend_path_if_dir "/usr/local/bin"
  prepend_path_if_dir "/opt/homebrew/bin"
  if [[ -n "${homebrew_prefix}" ]]; then
    prepend_path_if_dir "${homebrew_prefix}/bin"
  fi
fi
prepend_path_if_dir "${HOME}/.bun/bin"
# shellcheck disable=SC1091
if [[ -f "${HOME}/.bashrc" ]]; then source "${HOME}/.bashrc" 2>/dev/null || true; fi
hash -r 2>/dev/null || true

missing=()

# Core runtime
command -v bun     >/dev/null 2>&1 || missing+=("bun")
command -v bunx    >/dev/null 2>&1 || missing+=("bunx")

# Runtime deps (ffmpeg installed by installer on macOS via brew,
# pre-installed on ubuntu-latest). When the workflow told the installer to
# skip ffmpeg (AUTOMOBILE_INSTALL_SKIP_FFMPEG, #5385 — the ubuntu apt install
# stalled for ~10 minutes per run), requiring it here would contradict that
# skip and deterministically fail the job.
if [[ "${AUTOMOBILE_INSTALL_SKIP_FFMPEG:-}" == "true" ]]; then
  echo "Skipping ffmpeg check: AUTOMOBILE_INSTALL_SKIP_FFMPEG=true"
else
  command -v ffmpeg  >/dev/null 2>&1 || missing+=("ffmpeg")
fi

# Dev tools (installed by development preset via brew on macOS,
# some pre-installed on ubuntu-latest)
command -v shellcheck  >/dev/null 2>&1 || missing+=("shellcheck")
command -v jq          >/dev/null 2>&1 || missing+=("jq")
command -v rg          >/dev/null 2>&1 || missing+=("ripgrep")

# macOS-specific
if [[ "$(uname -s)" == "Darwin" ]]; then
  command -v yq          >/dev/null 2>&1 || missing+=("yq")
  command -v swiftformat >/dev/null 2>&1 || missing+=("swiftformat")
  command -v swiftlint   >/dev/null 2>&1 || missing+=("swiftlint")
  command -v iproxy      >/dev/null 2>&1 || missing+=("iproxy")
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "::error::Missing runtime dependencies: ${missing[*]}"
  exit 1
fi
echo "All runtime dependencies verified."
