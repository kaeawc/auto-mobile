#!/usr/bin/env bash
#
# Install Bun dependencies for CI from the checked-in lockfile.
#
# Usage:
#   scripts/ci/install-bun-deps.sh

set -euo pipefail

bun install --frozen-lockfile --force || {
  bun pm cache rm
  bun install --frozen-lockfile --force
}

if [[ -n "${GITHUB_PATH:-}" && -n "${GITHUB_WORKSPACE:-}" ]]; then
  echo "${GITHUB_WORKSPACE}/node_modules/.bin" >> "${GITHUB_PATH}"
fi
