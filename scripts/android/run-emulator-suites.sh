#!/usr/bin/env bash
#
# Run the JUnit Runner and Playground emulator suites against one booted
# emulator (#10891). Pull-request CI used to boot one emulator per suite; this
# runs both from the single android-emulator action invocation.
#
# Both suites always run, so one red suite cannot hide the other; the exit
# status is non-zero when either fails. The AutoMobile daemon is stopped between
# them: the JUnit Runner suite starts a daemon with the default tool set and may
# still hold a device assignment, while the Playground chain must start its own
# daemon with only the navigation tools enabled.
#
# Run from the android/ directory (the action's working-directory).
#
# Usage:
#   ../scripts/android/run-emulator-suites.sh <ctrl-proxy-apk>
#
# Environment (test seams):
#   GRADLE_CMD         Gradle wrapper (default: ./gradlew)
#   RESET_DAEMON_CMD   daemon reset between suites
#                      (default: scripts/android/reset-daemon-before-retry.sh)
#   PERMISSION_CMD     SDK/CtrlProxy permission contract check
#   NAV_GRAPH_CMD      navigation-graph SDK event integration

set -euo pipefail

ctrl_proxy_apk="${1:?usage: run-emulator-suites.sh <ctrl-proxy-apk>}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

gradle_cmd="${GRADLE_CMD:-./gradlew}"
reset_daemon_cmd="${RESET_DAEMON_CMD:-${script_dir}/reset-daemon-before-retry.sh}"
permission_cmd="${PERMISSION_CMD:-${script_dir}/verify-sdk-ctrl-proxy-permission-contract.sh}"
nav_graph_cmd="${NAV_GRAPH_CMD:-${script_dir}/navigation-graph-sdk-event-integration.sh}"
playground_tools="navigateTo,getNavigationGraph,explore"

junit_status=0
playground_status=0

echo "=== JUnit Runner emulator suite ==="
"$gradle_cmd" :junit-runner:test --stacktrace --info || junit_status=$?

echo "=== Resetting AutoMobile daemon between suites ==="
"$reset_daemon_cmd"

echo "=== Playground Automobile emulator suite ==="
# The subshell keeps the tool restriction out of this script's environment.
# errexit does not apply inside a `( ... ) ||` list, so the chain uses && to
# stop at its first failing step.
(
  export AUTOMOBILE_ENABLED_TOOLS="$playground_tools"
  "$permission_cmd" "$ctrl_proxy_apk" \
    && "$nav_graph_cmd" \
    && "$gradle_cmd" :playground:app:test --stacktrace --info
) || playground_status=$?

echo "JUnit Runner emulator suite exit status: ${junit_status}"
echo "Playground Automobile emulator suite exit status: ${playground_status}"
if [[ "$junit_status" -ne 0 || "$playground_status" -ne 0 ]]; then
  exit 1
fi
