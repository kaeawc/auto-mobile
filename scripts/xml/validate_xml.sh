#!/usr/bin/env bash

# Cross-platform XML validation using xmlstarlet or xml command
validate_xml() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    xml "$@"
  else
    xmlstarlet "$@"
  fi
}

# Check for required XML tools.
# Note: `$(! command -v xml &>/dev/null)` captures the command's *stdout*
# (redirected to /dev/null → always empty), so the old `[[ "" && "" ]]` guard
# was always false and never fired. Test the exit status directly instead.
if ! command -v xml &>/dev/null && ! command -v xmlstarlet &>/dev/null; then
  echo "xmlstarlet missing, please install."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Try 'brew install xmlstarlet'"
  else
    echo "Consult your OS package manager"
  fi
  exit 1
fi

# Start the timer
start_time=$(bash -c "$(pwd)/scripts/utils/get_timestamp.sh")

# shellcheck disable=SC1091 # Resolved relative to this script's location.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/vcs-diff.sh"

# Need to export this function for xargs bash to see it
export -f validate_xml

# Portable CPU count: nproc (GNU) is absent on stock macOS, where an empty
# `$(nproc)` made `xargs -P ""` fail. Fall back to sysctl/getconf (#3653).
NPROC="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

# Find XML files, excluding ignored files.
# shellcheck disable=SC2016
errors=$(vcs_list_files |
  grep -z '\.xml$' |
  xargs -0 -n 1 -P "$NPROC" bash -c 'validate_xml val -w -b -e "$0"' 2>&1)

# Calculate total elapsed time
end_time=$(bash -c "$(pwd)/scripts/utils/get_timestamp.sh")
total_elapsed=$((end_time - start_time))

# Check and report errors
if [[ -n $errors ]]; then
  echo "Errors in the following files:"
  echo "$errors"
  echo "Total time elapsed in $total_elapsed ms."
  exit 1
else
  echo "No XML errors found in $total_elapsed ms."
fi
