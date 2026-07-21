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
# Kept in sync with the product boot path (issue #4094):
#   * runtime resolution + 3-tier fallback -> SimCtlClient.resolveRuntimeIdentifier()
#   * boot post-condition (state == Booted) -> SimCtlClient.bootAndVerify()
#   * bounded retry of a wedged boot        -> SimCtlClient.bootAndVerify()
# Change one, change the other.
#
# Known divergence: the product orders runtime candidates numerically, while
# jq's sort_by(.version) here is a string sort, so this script would rank
# "26.9" above "26.10". Harmless today (single-digit minors) but not equivalent.
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

# `bootstatus` alone is not a trustworthy success signal, in BOTH directions:
#
#   * It can exit 0 on a wedged boot (the case #4078 set out to catch), and
#   * on macOS 26 / Xcode 26 a perfectly HEALTHY boot ends with
#     "Status=4294967295, isTerminal=YES" followed by "Finished" -- that code is
#     just how CoreSimulator reports its terminal state here. It appears in 100%
#     of boots, so it cannot distinguish a good boot from a bad one. Keying on it
#     rejected healthy 17-71s boots and failed every iOS PR.
#
# So verify the post-condition instead: the device must actually be in the
# "Booted" state. This mirrors how the Android emulator path proves readiness
# (independent signals rather than one command's exit code).
# A wedge is usually transient runner state, not a broken simulator definition, so
# a single failure should not red the build (issue #4095). Retry a bounded number
# of times: shut the device down, and before the final attempt erase it to clear
# corrupt per-device state. Both knobs are env-tunable so the tests can exercise
# the retry path without real sleeps.
MAX_BOOT_ATTEMPTS="${BOOT_SIMULATOR_MAX_ATTEMPTS:-2}"
RETRY_DELAY_SECONDS="${BOOT_SIMULATOR_RETRY_DELAY_SECONDS:-5}"

device_state() {
  xcrun simctl list devices -j \
    | jq -r --arg udid "$1" '
        .devices | to_entries[] | .value[]
        | select(.udid == $udid) | .state
      ' \
    | head -1
}

booted=0
BOOT_STATE=""
for attempt in $(seq 1 "${MAX_BOOT_ATTEMPTS}"); do
  set +e
  boot_log="$(xcrun simctl bootstatus "${UDID}" -b 2>&1)"
  boot_rc=$?
  set -e
  printf '%s\n' "${boot_log}" >&2

  BOOT_STATE="$(device_state "${UDID}")"
  if [[ ${boot_rc} -eq 0 && "${BOOT_STATE}" == "Booted" ]]; then
    booted=1
    break
  fi

  echo "warning: boot attempt ${attempt}/${MAX_BOOT_ATTEMPTS} failed for ${UDID} (bootstatus rc=${boot_rc}, state=${BOOT_STATE:-unknown})" >&2
  # Diagnostics: without these a recurrence is only ever inferred from the bare
  # timeout, which is what made the original wedge so hard to characterize.
  xcrun simctl list devices 2>/dev/null | grep -F "${UDID}" >&2 || true

  if [[ ${attempt} -lt ${MAX_BOOT_ATTEMPTS} ]]; then
    xcrun simctl shutdown "${UDID}" >/dev/null 2>&1 || true
    if [[ ${attempt} -eq $((MAX_BOOT_ATTEMPTS - 1)) ]]; then
      echo "Erasing ${UDID} to clear per-device state before the final attempt..." >&2
      xcrun simctl erase "${UDID}" >/dev/null 2>&1 || true
    fi
    if [[ "${RETRY_DELAY_SECONDS}" -gt 0 ]]; then
      sleep "${RETRY_DELAY_SECONDS}"
    fi
  fi
done

if [[ ${booted} -ne 1 ]]; then
  echo "error: simulator ${UDID} failed to boot after ${MAX_BOOT_ATTEMPTS} attempt(s) (last state=${BOOT_STATE:-unknown})" >&2
  exit 1
fi

echo "Booted: ${DEVICE_NAME} (${UDID})" >&2

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "simulator_udid=${UDID}" >> "${GITHUB_OUTPUT}"
fi

echo "${UDID}"
