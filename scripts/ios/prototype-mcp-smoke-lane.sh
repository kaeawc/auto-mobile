#!/usr/bin/env bash
# Per-runtime simulator smoke test for the iOS prototype MCP/CLI path.
#
# Creates ONE fresh simulator, builds Playground (Debug) for it, and runs the MCP smoke
# beside the agent demo lane. The smoke checks launch, show, tap, awaitEvent, dismiss and
# host-session release. Cleans up its simulator and stale simulators from other runs.
#
# Usage: scripts/ios/prototype-mcp-smoke-lane.sh <ios-version|latest>   e.g. 26, 18.5, latest
#
# Environment:
#   XCRUN_BIN                         xcrun executable (default xcrun)
#   XCODEBUILD_BIN                    xcodebuild executable (default xcodebuild)
#   AUTO_MOBILE_CMD                   CLI command (default bun run src/index.ts --debug --embedded-sdk --cli)
#   PROTOTYPE_MCP_SMOKE_SCRIPT        MCP smoke script (default prototype-mcp-smoke.sh beside this)
#   PROTOTYPE_MCP_SMOKE_LOG_DIR       output dir (default scratch/prototype-mcp-smoke-lane/ios-<request>)
#   PROTOTYPE_MCP_SMOKE_AUX_ROOT      private socket dir parent (default /tmp; keep paths short)
#   PROTOTYPE_MCP_SMOKE_RETRY_SLEEP   seconds between simulator delete attempts (default 5)
#   PROTOTYPE_SMOKE_DEVICE_TYPE       simulator device type (default highest iPhone model generation)
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
aux_root=""
# shellcheck source=scripts/ios/run_with_timeout.sh
source "${script_dir}/run_with_timeout.sh"

delete_simulator() {
  local attempt delete_status caller_options="$-"
  for attempt in 1 2 3; do
    set +e
    run_with_timeout 120 "${XCRUN_BIN}" simctl delete "$1" > /dev/null 2>&1
    delete_status=$?
    if [[ "${caller_options}" == *e* ]]; then set -e; fi
    if [[ ${delete_status} -eq 0 ]]; then
      return 0
    fi
    if [[ ${attempt} -lt 3 ]]; then
      sleep "${PROTOTYPE_MCP_SMOKE_RETRY_SLEEP:-5}"
    fi
  done
  return 1
}

cleanup() {
  local result=$?
  local cleanup_status
  trap - EXIT
  if [[ -n ${aux_root} ]]; then
    local -a words=(auto-mobile) cli_words=()
    local word
    if [[ -n "${AUTO_MOBILE_CMD:-}" ]]; then
      read -r -a cli_words <<< "$AUTO_MOBILE_CMD"
      words=()
      for word in "${cli_words[@]}"; do
        [[ "$word" == --* ]] && break
        words+=("$word")
      done
    fi
    set +e
    run_with_timeout 60 "${words[@]+"${words[@]}"}" --daemon stop
    cleanup_status=$?
    set -e
    if [[ ${cleanup_status} -ne 0 ]]; then
      echo "prototype-mcp-smoke-lane: daemon stop failed for ${aux_root}" >&2
    fi
  fi
  if [[ -n ${udid} ]]; then
    set +e
    run_with_timeout 60 "${XCRUN_BIN}" simctl shutdown "${udid}" > /dev/null 2>&1
    cleanup_status=$?
    set -e
    if [[ ${cleanup_status} -ne 0 ]]; then
      echo "prototype-mcp-smoke-lane: shutdown skipped (not booted?)"
    fi
    set +e
    delete_simulator "${udid}"
    cleanup_status=$?
    set -e
    if [[ ${cleanup_status} -ne 0 ]]; then
      echo "prototype-mcp-smoke-lane: FAIL: could not delete simulator ${udid}" >&2
      if [[ ${result} -eq 0 ]]; then result=1; fi
    fi
  fi
  if [[ -n ${aux_root} ]]; then
    rm -rf -- "${aux_root}" || true
  fi
  if [[ -n ${derived_data} ]]; then
    rm -rf -- "${derived_data}" || true
  fi
  exit "${result}"
}
trap cleanup EXIT

while IFS= read -r name; do
  case "${name}" in
    AUTOMOBILE_DAEMON_* | AUTO_MOBILE_DAEMON_* | AUTOMOBILE_SESSION_* | AUTO_MOBILE_SESSION_*)
      unset "${name}"
      ;;
  esac
done < <(compgen -e)
aux_root="$(mktemp -d "${PROTOTYPE_MCP_SMOKE_AUX_ROOT:-/tmp}/apm-aux.XXXXXX")" || fail 'could not allocate private aux socket dir'
export AUTOMOBILE_AUX_SOCKET_DIR="${aux_root}"

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
      | select(.productFamily == "iPhone")
      | . + {gen: ([.name | match("iPhone ([0-9]+)") | .captures[0].string | tonumber][0] // 0)}]
    | sort_by(.gen) | last // empty | .identifier')" || fail 'could not parse device types'
fi
[[ -n ${device_type} ]] || fail "runtime ${runtime_id} lists no iPhone device type"

run_tag=runlocal
if [[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ ]]; then run_tag="run${GITHUB_RUN_ID}"; fi
set +e
devices_json="$(run_with_timeout 60 "${XCRUN_BIN}" simctl list devices --json)"
sweep_status=$?
set -e
if [[ ${sweep_status} -eq 0 ]]; then
  stale_udids="$(jq -r --arg tag "-${run_tag}-" '
    .devices[][] | select(.name | startswith("prototype-mcp-smoke-"))
    | select(.name | contains($tag) | not) | .udid' <<< "${devices_json}")" || {
    echo 'prototype-mcp-smoke-lane: warning: could not parse stale simulators' >&2
    stale_udids=""
  }
  while IFS= read -r stale_udid; do
    [[ -n ${stale_udid} ]] || continue
    set +e
    run_with_timeout 60 "${XCRUN_BIN}" simctl shutdown "${stale_udid}" > /dev/null 2>&1
    sweep_status=$?
    set -e
    set +e
    delete_simulator "${stale_udid}"
    sweep_status=$?
    set -e
    if [[ ${sweep_status} -ne 0 ]]; then
      echo "prototype-mcp-smoke-lane: warning: could not delete stale simulator ${stale_udid}" >&2
    fi
  done <<< "${stale_udids}"
else
  echo 'prototype-mcp-smoke-lane: warning: could not list stale simulators' >&2
fi

udid="$("${XCRUN_BIN}" simctl create "prototype-mcp-smoke-${runtime_version}-${run_tag}-$$" "${device_type}" "${runtime_id}")" || fail 'simctl create failed'
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
