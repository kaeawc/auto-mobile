#!/usr/bin/env bash
# Per-runtime simulator smoke test for the iOS prototype MCP/CLI path.
#
# Creates ONE fresh simulator, builds Playground (Debug) for it, and runs the MCP smoke
# beside the agent demo lane. The smoke checks launch, show, tap, awaitEvent, dismiss and
# host-session release. Always shuts down and deletes only the simulator created here.
#
# Usage: scripts/ios/prototype-mcp-smoke-lane.sh <ios-version|latest>   e.g. 26, 18.5, latest
#
# Environment:
#   XCRUN_BIN                         xcrun executable (default xcrun)
#   XCODEBUILD_BIN                    xcodebuild executable (default xcodebuild)
#   AUTO_MOBILE_CMD                   CLI command (default bun run src/index.ts --debug --embedded-sdk --cli)
#   PROTOTYPE_MCP_SMOKE_SCRIPT        MCP smoke script (default prototype-mcp-smoke.sh beside this)
#   PROTOTYPE_MCP_SMOKE_LOG_DIR       output dir (default scratch/prototype-mcp-smoke-lane/ios-<request>)
#   PROTOTYPE_SMOKE_DEVICE_TYPE       simulator device type (default newest supported iPhone)
#
# Exit codes: 0 pass; 1 setup/build failed; 2 usage; 3 no matching runtime (skip).
# MCP smoke exit codes are propagated, including 3 for unsupported capability/platform.
set -euo pipefail

if [[ $# -ne 1 || ! ${1:-} =~ ^(latest|[0-9]+(\.[0-9]+)*)$ ]]; then
  echo 'usage: prototype-mcp-smoke-lane.sh <ios-version|latest>' >&2
  exit 2
fi
requested="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
cd "${repo_root}"
export XCRUN_BIN="${XCRUN_BIN:-xcrun}"
xcodebuild_bin="${XCODEBUILD_BIN:-xcodebuild}"
smoke_script="${PROTOTYPE_MCP_SMOKE_SCRIPT:-${script_dir}/prototype-mcp-smoke.sh}"
export AUTO_MOBILE_CMD="${AUTO_MOBILE_CMD:-bun run src/index.ts --debug --embedded-sdk --cli}"
log_dir="${PROTOTYPE_MCP_SMOKE_LOG_DIR:-scratch/prototype-mcp-smoke-lane/ios-${requested}}"
mkdir -p "${log_dir}"
exec > >(tee "${log_dir}/smoke.log") 2>&1

fail() {
  echo "prototype-mcp-smoke-lane: FAIL: $*" >&2
  exit 1
}

udid=""
derived_data=""
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n ${udid} ]]; then
    # Best effort: cleanup must not mask the build or MCP smoke result.
    "${XCRUN_BIN}" simctl shutdown "${udid}" > /dev/null 2>&1 || echo "prototype-mcp-smoke-lane: shutdown skipped (not booted?)"
    "${XCRUN_BIN}" simctl delete "${udid}" > /dev/null 2>&1 || echo "prototype-mcp-smoke-lane: delete failed for ${udid}"
  fi
  if [[ -n ${derived_data} ]]; then
    rm -rf -- "${derived_data}" || true
  fi
  exit "${result}"
}
trap cleanup EXIT

# Pick the newest installed iOS runtime matching the request ("26" matches 26.x).
runtimes_json="$("${XCRUN_BIN}" simctl list runtimes available iOS --json)" || fail 'could not list runtimes'
prefix="${requested}"
if [[ ${requested} == latest ]]; then prefix=""; fi
runtime_line="$(printf '%s' "${runtimes_json}" | jq -r --arg p "${prefix}" '
  [.runtimes[]
    | select(.isAvailable != false)
    | select($p == "" or .version == $p or (.version | startswith($p + ".")))]
  | sort_by(.version | split(".") | map(tonumber? // 0))
  | last // empty
  | [.version, .identifier] | @tsv')" || fail 'could not parse runtimes'
if [[ -z ${runtime_line} ]]; then
  echo "prototype-mcp-smoke-lane: no installed iOS runtime matches '${requested}'; skipping"
  exit 3
fi
runtime_version="${runtime_line%%$'\t'*}"
runtime_id="${runtime_line#*$'\t'}"
echo "prototype-mcp-smoke-lane: iOS ${runtime_version} (${runtime_id})"
device_type="${PROTOTYPE_SMOKE_DEVICE_TYPE:-}"
if [[ -z ${device_type} ]]; then
  device_type="$(printf '%s' "${runtimes_json}" | jq -r --arg id "${runtime_id}" '
    [.runtimes[] | select(.identifier == $id) | .supportedDeviceTypes[]
      | select(.productFamily == "iPhone")] | last // empty | .identifier')" || fail 'could not parse device types'
fi
[[ -n ${device_type} ]] || fail "runtime ${runtime_id} lists no iPhone device type"

udid="$("${XCRUN_BIN}" simctl create "prototype-mcp-smoke-${runtime_version}-$$" "${device_type}" "${runtime_id}")" || fail 'simctl create failed'
[[ -n ${udid} ]] || fail 'simctl create returned no UDID'
"${XCRUN_BIN}" simctl boot "${udid}" || fail 'simulator boot failed'
"${XCRUN_BIN}" simctl bootstatus "${udid}" -b || fail 'simulator did not finish booting'

derived_data="$(mktemp -d "${TMPDIR:-/tmp}/auto-mobile-prototype-mcp.XXXXXX")"
# Debug, because Playground's SDK integration is enabled in Debug builds.
"${xcodebuild_bin}" \
  -project "${repo_root}/ios/Playground/Playground.xcodeproj" \
  -scheme Playground \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=${udid}" \
  -derivedDataPath "${derived_data}" \
  build || fail 'Playground build failed'
export PROTOTYPE_SMOKE_APP_BUNDLE="${derived_data}/Build/Products/Debug-iphonesimulator/Playground.app"
[[ -d ${PROTOTYPE_SMOKE_APP_BUNDLE} ]] || fail "Playground build produced no app at ${PROTOTYPE_SMOKE_APP_BUNDLE}"

# Run as a simple command so errexit and the EXIT trap preserve its exact status.
bash "${smoke_script}" "${udid}"
