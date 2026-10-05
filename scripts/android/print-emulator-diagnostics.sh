#!/usr/bin/env bash
# Print bounded CI diagnostic excerpts without masking the original failure.
set -euo pipefail

# shellcheck source=scripts/ios/run_with_timeout.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../ios/run_with_timeout.sh"
if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <diagnostics-dir> <label>" >&2
  exit 2
fi
set +e
printf '%s\n' "$2"
run_with_timeout "${AUTOMOBILE_EMULATOR_DIAGNOSTICS_TIMEOUT_SECONDS:-10}" \
  find "$1" -maxdepth 1 -type f -print -exec sed -n '1,160p' {} \; 2>/dev/null
exit 0
