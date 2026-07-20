#!/usr/bin/env bash
#
# Boot an iOS Simulator
#
# Finds the first available iPhone device for a given iOS version, boots it,
# and waits until it is ready. Prints the booted device UDID to stdout.
#
# Usage:
#   ./scripts/ios/boot-simulator.sh [--ios-version VERSION]
#
# Options:
#   --ios-version VERSION  iOS runtime version to target (default: auto-detect from Xcode SDK)
#
# Outputs:
#   stdout     - UDID of the booted simulator
#   GITHUB_OUTPUT (if set) - simulator_udid=<udid>

set -euo pipefail

IOS_VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ios-version)
      IOS_VERSION="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Auto-detect iOS version from the active Xcode SDK if not specified
if [[ -z "${IOS_VERSION}" ]]; then
  IOS_VERSION=$(xcrun --sdk iphonesimulator --show-sdk-version 2>/dev/null)
  if [[ -z "${IOS_VERSION}" ]]; then
    echo "error: could not detect iOS SDK version from Xcode" >&2
    exit 1
  fi
fi

echo "Looking for iPhone simulator running iOS ${IOS_VERSION}..." >&2

# Look up the actual runtime identifier from simctl rather than constructing it.
# The identifier format varies across Xcode versions (e.g. iOS-26-3 vs iOS-26-3-0).
#
# Strategy: try exact version first, then major.minor, then major-only fallback.
# This handles CI runners where the exact SDK version runtime may not be
# pre-installed (e.g. Xcode SDK 26.3 but only runtimes 26.1, 26.2, 26.4).
RUNTIMES_JSON=$(xcrun simctl list runtimes iOS --json)

pick_runtime() {
  echo "${RUNTIMES_JSON}" \
    | jq -r --arg v "$1" '
        [.runtimes[] | select(.version | startswith($v))]
        | sort_by(.version) | last
        | .identifier // empty
      '
}

MAJOR_MINOR="${IOS_VERSION%.*}"
MAJOR="${MAJOR_MINOR%%.*}"

# 1) Exact version match (e.g. "26.3" matches "26.3.0")
RUNTIME_ID=$(pick_runtime "${IOS_VERSION}")

# 2) Major.minor match (handles "26.3.1" SDK → "26.3.x" runtime)
if [[ -z "${RUNTIME_ID}" ]]; then
  RUNTIME_ID=$(pick_runtime "${MAJOR_MINOR}.")
fi

# 3) Major-only fallback — pick the highest runtime in the same major (e.g. 26.x)
if [[ -z "${RUNTIME_ID}" ]]; then
  echo "No iOS ${MAJOR_MINOR} runtime found, falling back to highest iOS ${MAJOR}.x runtime..." >&2
  RUNTIME_ID=$(pick_runtime "${MAJOR}.")
fi

if [[ -z "${RUNTIME_ID}" ]]; then
  echo "error: no simulator runtime found for iOS ${IOS_VERSION} (tried ${MAJOR_MINOR}, ${MAJOR}.x)" >&2
  echo "Available runtimes:" >&2
  xcrun simctl list runtimes 2>/dev/null | grep iOS >&2 || true
  exit 1
fi

echo "Using runtime: ${RUNTIME_ID}" >&2

# Find the first available iPhone device for the requested iOS version
UDID=$(xcrun simctl list devices available -j \
  | jq -r --arg runtime "${RUNTIME_ID}" '
      .devices
      | to_entries[]
      | select(.key == $runtime)
      | .value[]
      | select(.name | startswith("iPhone"))
      | .udid
    ' \
  | head -1)

# If no device exists for this runtime, create one
if [[ -z "${UDID}" ]]; then
  echo "No existing iPhone device for iOS ${IOS_VERSION}, creating one..." >&2
  DEVICE_TYPE=$(xcrun simctl list devicetypes -j \
    | jq -r '.devicetypes[] | select(.name | startswith("iPhone")) | .identifier' \
    | tail -1)
  if [[ -z "${DEVICE_TYPE}" ]]; then
    echo "error: no iPhone device type found to create simulator" >&2
    exit 1
  fi
  echo "Creating device: ${DEVICE_TYPE} with runtime ${RUNTIME_ID}" >&2
  UDID=$(xcrun simctl create "CI iPhone" "${DEVICE_TYPE}" "${RUNTIME_ID}")
fi

if [[ -z "${UDID}" ]]; then
  echo "error: no available iPhone simulator found for iOS ${IOS_VERSION}" >&2
  echo "Available runtimes:" >&2
  xcrun simctl list runtimes 2>/dev/null | grep iOS >&2 || true
  exit 1
fi

DEVICE_NAME=$(xcrun simctl list devices available -j \
  | jq -r --arg udid "${UDID}" '
      .devices | to_entries[] | .value[]
      | select(.udid == $udid) | .name
    ')

echo "Ensuring ${DEVICE_NAME} (${UDID}) is booted..." >&2

# bootstatus can "Finish" with an internal failure status -- e.g. it stalls in
# "Waiting on System App" for tens of minutes and then reports
# "Status=4294967295, isTerminal=YES" -- while still exiting 0. Pressing on
# would print "Booted:" for a wedged simulator that hangs every downstream step
# (issue #4078). Capture the outcome and treat a failing exit OR that terminal
# error status as a hard boot failure.
set +e
boot_log="$(xcrun simctl bootstatus "${UDID}" -b 2>&1)"
boot_rc=$?
set -e
printf '%s\n' "${boot_log}" >&2

if [[ ${boot_rc} -ne 0 ]] || printf '%s' "${boot_log}" | grep -q 'Status=4294967295'; then
  echo "error: simulator ${UDID} failed to boot (bootstatus rc=${boot_rc})" >&2
  exit 1
fi

echo "Booted: ${DEVICE_NAME} (${UDID})" >&2

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "simulator_udid=${UDID}" >> "${GITHUB_OUTPUT}"
fi

echo "${UDID}"
