#!/usr/bin/env bash

# CI ("Validate Shell Scripts" on ubuntu-latest) runs the apt shellcheck of the
# ubuntu-24.04 runner image. Keep this in step with the image readme.
CI_SHELLCHECK_VERSION="0.9.0"
SHELLCHECK_CMD="${SHELLCHECK_CMD:-shellcheck}"
export SHELLCHECK_CMD

# Check if shellcheck is installed
if ! command -v "$SHELLCHECK_CMD" &>/dev/null; then
    echo "shellcheck missing"
    if [[ "$OSTYPE" == "darwin"* ]]; then
      echo "Try 'brew install shellcheck'"
    else
      echo "Consult your OS package manager"
    fi
    exit 1
fi

# Start the timer
start_time=$(bash -c "$(pwd)/scripts/utils/get_timestamp.sh")

# shellcheck disable=SC1091 # Resolved relative to this script's location.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/vcs-diff.sh"

# A newer local shellcheck than CI passes things CI rejects (2026-10-10: three
# main-red runs). Say so loudly instead of silently reporting "valid".
local_shellcheck_version="$("$SHELLCHECK_CMD" --version 2>/dev/null | awk '/^version:/ {print $2}')"
if [[ "$local_shellcheck_version" != "$CI_SHELLCHECK_VERSION" ]]; then
  echo "WARNING: local shellcheck ${local_shellcheck_version:-unknown} differs from CI's ${CI_SHELLCHECK_VERSION}." >&2
  echo "  A pass here does not guarantee CI passes. Known gap: shellcheck >= 0.10 reports" >&2
  echo "  never-invoked functions as SC2329 where CI ${CI_SHELLCHECK_VERSION} reports SC2317; this script" >&2
  echo "  enforces the SC2317 pairing below, but other newer-version rules cannot be reproduced." >&2
fi

# CI parity: a disable directive naming SC2329 must also name SC2317, otherwise
# the older CI shellcheck still reports the same finding as SC2317.
# shellcheck disable=SC2016
parity_errors=$(vcs_list_files |
  grep -z '\.sh$' |
  xargs -0 awk -v ci="$CI_SHELLCHECK_VERSION" '
    /^[[:space:]]*#[[:space:]]*shellcheck[[:space:]]+disable=/ && /SC2329/ && !/SC2317/ {
      printf "%s:%d: disable=SC2329 without SC2317 (CI shellcheck %s reports SC2317): %s\n", FILENAME, FNR, ci, $0
    }' 2>&1)

# Portable CPU count: nproc (GNU) is absent on stock macOS, where an empty
# `$(nproc)` made `xargs -P ""` fail. Fall back to sysctl/getconf (#3653).
NPROC="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

# Find shell scripts and validate in parallel.
# shellcheck disable=SC2016
errors=$(vcs_list_files |
  grep -z '\.sh$' |
  xargs -0 -n 1 -P "$NPROC" bash -c '"$SHELLCHECK_CMD" "$0"' 2>&1)
if [[ -n $parity_errors ]]; then
  errors="${errors:+$errors$'\n'}${parity_errors}"
fi

# Calculate total elapsed time
end_time=$(bash -c "$(pwd)/scripts/utils/get_timestamp.sh")
total_elapsed=$((end_time - start_time))

# Check and report errors
if [[ -n $errors ]]; then
    echo "Errors in the following files:"
    echo "$errors"
    echo "Total time elapsed: $total_elapsed ms."
    exit 1
fi

echo "All shell scripts are valid."
