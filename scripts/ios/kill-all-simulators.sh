#!/usr/bin/env bash
#
# Kill All iOS Simulators
#
# Shuts down every booted iOS simulator. Safe to run when none are running.
#
# Usage:
#   ./scripts/ios/kill-all-simulators.sh
#
# Outputs:
#   stderr - progress messages
#   exit 0 - always (even if no simulators were running)

set -euo pipefail

BOOTED_JSON=$(xcrun simctl list devices booted --json)
BOOTED_COUNT=$(echo "${BOOTED_JSON}" | jq '[.devices | to_entries[] | .value[]] | length')

if [[ "${BOOTED_COUNT}" -eq 0 ]]; then
  echo "No booted iOS simulators found." >&2
  exit 0
fi

echo "Found ${BOOTED_COUNT} booted simulator(s), shutting down..." >&2

# List each one before killing
echo "${BOOTED_JSON}" | jq -r '
  .devices | to_entries[] | .value[]
  | "  \(.name) (\(.udid)) state=\(.state)"
' >&2

xcrun simctl shutdown all

echo "All simulators shut down." >&2
