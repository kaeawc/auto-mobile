#!/usr/bin/env bash
#
# Start an iOS Simulator and Wait for Readiness
#
# Boots an iOS simulator by name or UDID, then blocks until the device is
# fully ready using `xcrun simctl bootstatus`. This mirrors what the
# existing boot-simulator.sh does but accepts a device identifier directly,
# making it useful for quick iteration and debugging boot-await timing.
#
# Usage:
#   ./scripts/ios/start-simulator.sh [OPTIONS]
#
# Options:
#   --udid UDID            Boot simulator by UDID
#   --name NAME            Boot first matching simulator by name (e.g. "iPhone 16")
#   --ios-version VERSION  Filter by iOS version when using --name (default: auto-detect)
#   --timeout SECONDS      Boot timeout in seconds (default: 120)
#   --prefer-booted        If a matching simulator is already booted, reuse it
#
# Outputs:
#   stdout - JSON: { "udid": "...", "name": "...", "state": "Booted", "bootDurationMs": N }
#   stderr - progress messages

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ios/run_with_timeout.sh disable=SC1091
source "${SCRIPT_DIR}/run_with_timeout.sh"

UDID=""
NAME=""
IOS_VERSION=""
TIMEOUT_SECS=120
PREFER_BOOTED=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --udid)        UDID="$2"; shift 2 ;;
    --name)        NAME="$2"; shift 2 ;;
    --ios-version) IOS_VERSION="$2"; shift 2 ;;
    --timeout)     TIMEOUT_SECS="$2"; shift 2 ;;
    --prefer-booted) PREFER_BOOTED=true; shift ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${UDID}" && -z "${NAME}" ]]; then
  echo "error: must specify --udid or --name" >&2
  exit 1
fi

# ── Helper: resolve UDID from name ───────────────────────────────────────────

resolve_udid_from_name() {
  local name="$1"
  local version_filter="${2:-}"
  local devices_json

  devices_json=$(xcrun simctl list devices available --json)

  if [[ -n "${version_filter}" ]]; then
    # Look up runtime identifier for the requested version
    local runtimes_json major_minor major runtime_id
    runtimes_json=$(xcrun simctl list runtimes iOS --json)
    major_minor="${version_filter%.*}"
    major="${major_minor%%.*}"

    pick_runtime() {
      echo "${runtimes_json}" \
        | jq -r --arg v "$1" '
            [.runtimes[] | select(.version | startswith($v))]
            | sort_by(.version) | last
            | .identifier // empty
          '
    }

    runtime_id=$(pick_runtime "${version_filter}")
    [[ -z "${runtime_id}" ]] && runtime_id=$(pick_runtime "${major_minor}.")
    [[ -z "${runtime_id}" ]] && runtime_id=$(pick_runtime "${major}.")

    if [[ -z "${runtime_id}" ]]; then
      echo "error: no runtime found for iOS ${version_filter}" >&2
      return 1
    fi

    echo "${devices_json}" | jq -r --arg name "${name}" --arg rt "${runtime_id}" '
      .devices | to_entries[]
      | select(.key == $rt)
      | .value[]
      | select(.name | contains($name))
      | .udid
    ' | head -1
  else
    echo "${devices_json}" | jq -r --arg name "${name}" '
      .devices | to_entries[] | .value[]
      | select(.name | contains($name))
      | .udid
    ' | head -1
  fi
}

# ── Helper: check if a UDID is already booted ────────────────────────────────

is_booted() {
  local udid="$1"
  xcrun simctl list devices booted --json \
    | jq -e --arg udid "${udid}" '
        .devices | to_entries[] | .value[]
        | select(.udid == $udid)
      ' > /dev/null 2>&1
}

# ── Helper: get device name from UDID ────────────────────────────────────────

get_device_name() {
  local udid="$1"
  xcrun simctl list devices --json \
    | jq -r --arg udid "${udid}" '
        .devices | to_entries[] | .value[]
        | select(.udid == $udid) | .name
      '
}

# ── Resolve target UDID ──────────────────────────────────────────────────────

if [[ -z "${UDID}" ]]; then
  echo "Resolving simulator matching '${NAME}'..." >&2
  UDID=$(resolve_udid_from_name "${NAME}" "${IOS_VERSION}")
  if [[ -z "${UDID}" ]]; then
    echo "error: no available simulator matching '${NAME}'" >&2
    xcrun simctl list devices available 2>/dev/null | head -30 >&2
    exit 1
  fi
fi

DEVICE_NAME=$(get_device_name "${UDID}")
echo "Target: ${DEVICE_NAME} (${UDID})" >&2

# ── Check for already-booted device ──────────────────────────────────────────

if is_booted "${UDID}"; then
  if [[ "${PREFER_BOOTED}" == "true" ]]; then
    echo "Simulator already booted, reusing." >&2
    jq -n --arg udid "${UDID}" --arg name "${DEVICE_NAME}" \
      '{ udid: $udid, name: $name, state: "Booted", bootDurationMs: 0, source: "already-booted" }'
    exit 0
  else
    echo "Simulator already booted. Shutting down first for clean boot..." >&2
    xcrun simctl shutdown "${UDID}"
    sleep 1
  fi
fi

# ── Boot and await ────────────────────────────────────────────────────────────

echo "Booting ${DEVICE_NAME}..." >&2
millis_now() { python3 -c 'import time; print(int(time.time()*1000))'; }
BOOT_START=$(millis_now)

xcrun simctl boot "${UDID}"

echo "Waiting for boot to complete (timeout: ${TIMEOUT_SECS}s)..." >&2

# Run a command with a wall-clock timeout. Prefer GNU coreutils `timeout`,
# then `gtimeout` (Homebrew coreutils on macOS); fall back to a pure-bash
# implementation because stock macOS ships neither — without this, `timeout`
# resolved to 127 (command not found) and the boot was falsely reported as
# failed even when the simulator booted fine (#3644).

# bootstatus -b blocks until the device is fully booted.
# It exits 0 on success, non-zero on failure/timeout.
if ! run_with_timeout "${TIMEOUT_SECS}" xcrun simctl bootstatus "${UDID}" -b >&2; then
  echo "error: simulator boot did not complete within ${TIMEOUT_SECS}s" >&2
  echo "Current state:" >&2
  xcrun simctl list devices --json | jq --arg udid "${UDID}" '
    .devices | to_entries[] | .value[] | select(.udid == $udid)
  ' >&2
  exit 1
fi

BOOT_END=$(millis_now)
BOOT_DURATION=$(( BOOT_END - BOOT_START ))

echo "Booted: ${DEVICE_NAME} (${UDID}) in ${BOOT_DURATION}ms" >&2

# ── Output JSON ───────────────────────────────────────────────────────────────

jq -n \
  --arg udid "${UDID}" \
  --arg name "${DEVICE_NAME}" \
  --argjson durationMs "${BOOT_DURATION}" \
  '{ udid: $udid, name: $name, state: "Booted", bootDurationMs: $durationMs, source: "cold-boot" }'
