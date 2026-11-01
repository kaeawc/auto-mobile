#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/../.." && pwd)"
# shellcheck source=scripts/ios/run_with_timeout.sh
source "${script_dir}/run_with_timeout.sh"

if [[ $# -ne 0 ]]; then
  echo 'usage: tvos-smoke-advisory.sh (no arguments)' >&2
  exit 2
fi
timeout_seconds="${TVOS_SMOKE_TIMEOUT_SECONDS:-900}"
if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo 'TVOS_SMOKE_TIMEOUT_SECONDS must be a positive integer' >&2
  exit 2
fi
for tool in xcrun xcodebuild jq; do
  command -v "$tool" >/dev/null || { echo "Required tool missing: $tool" >&2; exit 1; }
done
log_dir="${TVOS_SMOKE_LOG_DIR:-${project_root}/scratch/tvos-smoke}"
mkdir -p "$log_dir"
runtimes="$(xcrun simctl list runtimes --json)"
runtime_id="$(jq -er '[.runtimes[] | select(.isAvailable == true and (.identifier | startswith("com.apple.CoreSimulator.SimRuntime.tvOS-")))] | sort_by(.version | split(".") | map(tonumber)) | last | .identifier // empty' <<< "$runtimes")" || {
  echo 'No installed, available tvOS simulator runtime; install one in Xcode before running this smoke.' >&2
  exit 1
}
device_id=""
# shellcheck disable=SC2329 # Invoked by the EXIT trap.
cleanup() {
  local exit_status=$?
  trap - EXIT
  if [[ -n "$device_id" ]]; then
    xcrun simctl shutdown "$device_id" || true
    if ! xcrun simctl delete "$device_id"; then
      echo "::warning title=tvOS smoke cleanup::Could not delete created simulator $device_id"
      exit_status=1
    fi
  fi
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
device_id="$(xcrun simctl create "am-tvos-smoke-$(uuidgen)" \
  com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation-4K "$runtime_id")"
[[ -n "$device_id" ]] || { echo 'simctl create returned no UDID' >&2; exit 1; }
xcrun simctl boot "$device_id"
run_with_timeout "$timeout_seconds" xcrun simctl bootstatus "$device_id" -b

# xcode-test.sh selects iPhone destinations and cannot filter the tvOS test class.
# XCTest installs and launches AutoMobileTVTest via its UI-test target dependency.
status=0
result_dir="$(mktemp -d "${log_dir}/result.XXXXXX")"
run_with_timeout "$timeout_seconds" xcodebuild test \
  -project "${project_root}/ios/control-proxy/CtrlProxy.xcodeproj" \
  -scheme AutoMobileTVTest -configuration Debug -destination "id=${device_id}" \
  -only-testing:CtrlProxyTVUITests/TVCommandRouterSmokeTests \
  -resultBundlePath "${result_dir}/smoke.xcresult" \
  TEST_RUNNER_AM_TVOS_SMOKE=1 CODE_SIGNING_ALLOWED=NO \
  > "${log_dir}/xcodebuild.log" 2>&1 || status=$?
cat "${log_dir}/xcodebuild.log"
echo "tvOS smoke exit status: ${status} (advisory)"
if [[ "$status" -eq 124 ]]; then
  echo '::warning title=tvOS simulator smoke::Test run timed out (advisory)'
elif [[ "$status" -ne 0 ]]; then
  # A compiler/destination/configuration failure is setup failure, not a failed
  # smoke assertion. Require evidence that tests actually ran before softening it.
  summary="$(xcrun xcresulttool get test-results summary --path "${result_dir}/smoke.xcresult" --format json)" || {
    echo 'tvOS smoke setup failed before producing test results' >&2
    exit "$status"
  }
  if ! jq -e '.totalTestCount > 0' <<< "$summary" >/dev/null; then
    echo 'tvOS smoke setup failed: no tests executed' >&2
    exit "$status"
  fi
  echo '::warning title=tvOS simulator smoke::Test run failed (advisory); inspect xcodebuild.log'
fi
exit 0
