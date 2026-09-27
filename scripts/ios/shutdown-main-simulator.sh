#!/usr/bin/env bash
# Shut down the main simulator before the odd-width iPhone 15 boot.
# Usage: shutdown-main-simulator.sh <simulator-udid> [deadline-seconds]
set -euo pipefail

simulator_udid="${1:-}"
shutdown_window="${2:-60}"
if [[ ! "${simulator_udid}" =~ ^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$ ]]; then
  echo "::error::Invalid main simulator UDID before odd-width screenshot test." >&2
  exit 1
fi
if [[ ! "${shutdown_window}" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::Invalid simulator shutdown deadline." >&2
  exit 1
fi

# shellcheck disable=SC1091 # Dynamic path resolves beside this script.
source "$(dirname "${BASH_SOURCE[0]}")/run_with_timeout.sh"
echo "Shutting down main simulator ${simulator_udid} before booting iPhone 15."
# The request and all state polls share one deadline. A slow request must not
# grant a fresh 60 seconds of polling after its own timeout.
shutdown_deadline=$((SECONDS + shutdown_window))
request_status=0
set +e
run_with_timeout 15 xcrun simctl shutdown "${simulator_udid}"
request_status=$?
set -e
if (( request_status != 0 )); then
  echo "::warning::Main simulator shutdown request timed out or failed; checking observed state." >&2
fi

simulator_state=""
while (( SECONDS < shutdown_deadline )); do
  remaining=$((shutdown_deadline - SECONDS))
  poll_timeout=$((remaining < 10 ? remaining : 10))
  set +e
  simulator_state="$(
    run_with_timeout "${poll_timeout}" xcrun simctl list devices --json |
      jq -r --arg udid "${simulator_udid}" '.devices[][] | select(.udid == $udid) | .state'
  )"
  poll_status=$?
  set -e
  if (( poll_status != 0 )); then
    simulator_state=""
  fi
  if [[ "${simulator_state}" == "Shutdown" ]]; then
    break
  fi
  remaining=$((shutdown_deadline - SECONDS))
  if (( remaining > 0 )); then
    sleep_for=$((remaining < 2 ? remaining : 2))
    sleep "${sleep_for}"
  fi
done
if [[ "${simulator_state}" != "Shutdown" ]]; then
  echo "::error::Main simulator ${simulator_udid} did not reach Shutdown within ${shutdown_window} seconds before booting iPhone 15." >&2
  exit 1
fi
