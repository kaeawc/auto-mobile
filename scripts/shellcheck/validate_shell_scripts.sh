#!/usr/bin/env bash

# Check if shellcheck is installed
if ! command -v shellcheck &>/dev/null; then
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

# Portable CPU count: nproc (GNU) is absent on stock macOS, where an empty
# `$(nproc)` made `xargs -P ""` fail. Fall back to sysctl/getconf (#3653).
NPROC="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

# Find shell scripts and validate in parallel.
# shellcheck disable=SC2016
errors=$(vcs_list_files |
  grep -z '\.sh$' |
  xargs -0 -n 1 -P "$NPROC" bash -c 'shellcheck "$0"' 2>&1)

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
