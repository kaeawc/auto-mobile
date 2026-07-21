#!/usr/bin/env bash
#
# Install Bun dependencies for CI from the checked-in lockfile.
#
# Usage:
#   scripts/ci/install-bun-deps.sh

set -euo pipefail

# Do not use --force on the normal path: CI may have restored a valid
# node_modules tree, and --force reinstalls every dependency even when it is
# already present. A normal frozen install verifies that tree and only repairs
# what is missing. Keep the forced rebuild as the corruption-recovery path.
bun install --frozen-lockfile || {
  bun pm cache rm
  bun install --frozen-lockfile --force
}

if [[ -n "${GITHUB_PATH:-}" && -n "${GITHUB_WORKSPACE:-}" ]]; then
  echo "${GITHUB_WORKSPACE}/node_modules/.bin" >> "${GITHUB_PATH}"
fi
