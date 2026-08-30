#!/usr/bin/env bash
#
# Run the iOS simulator videoRecording start -> stop MP4 integration test.
#
# Usage:
#   scripts/ios/video-recording-start-stop-integration.sh
#
# Environment:
#   AUTOMOBILE_IOS_VIDEO_RECORDING_DEVICE_ID  Use an already booted simulator UDID.
#   AUTOMOBILE_IOS_VIDEO_RECORDING_WAIT_MS    Milliseconds to record before stop.
#   AUTOMOBILE_IOS_VIDEO_RECORDING_TEST_TIMEOUT_MS  Bun test timeout in milliseconds.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "error: ${command_name} is required" >&2
    exit 1
  fi
}

require_command bun
require_command ffmpeg
require_command ffprobe
require_command jq
require_command xcrun

DEVICE_ID="${AUTOMOBILE_IOS_VIDEO_RECORDING_DEVICE_ID:-}"
if [[ -z "${DEVICE_ID}" ]]; then
  DEVICE_ID="$(xcrun simctl list devices booted -j \
    | jq -r '
        .devices
        | to_entries[]
        | .value[]
        | select(.name | startswith("iPhone"))
        | .udid
      ' \
    | head -1)"
fi

if [[ -z "${DEVICE_ID}" ]]; then
  ios_version="$(xcrun --sdk iphonesimulator --show-sdk-version)"
  # 600000ms matches the Android product-boot budget: the shared boot deadline
  # must cover a cold `bootstatus -b` plus the in-process erase-and-reboot
  # recovery on a loaded runner.
  boot_result="$(cd "${PROJECT_ROOT}" && bun run src/index.ts --boot-device --platform ios --create-if-missing --timeout-ms 600000 --min-os-version "${ios_version}" --max-os-version "${ios_version}")"
  DEVICE_ID="$(printf '%s' "${boot_result}" | jq -r '.deviceId')"
  if [[ -z "${DEVICE_ID}" || "${DEVICE_ID}" == "null" ]]; then
    echo "error: AutoMobile product boot returned no deviceId" >&2
    exit 1
  fi
fi

export AUTOMOBILE_IOS_VIDEO_RECORDING_INTEGRATION=1
export AUTOMOBILE_IOS_VIDEO_RECORDING_DEVICE_ID="${DEVICE_ID}"

# A simulator can report booted while its display service has not yet produced a
# frame. Starting `simctl io recordVideo` in that state can leave the raw .mov at
# zero bytes even after a graceful SIGINT. Capture one screenshot first: this
# both exercises the same display service and gives the test a concrete readiness
# signal before it begins recording.
DISPLAY_WARMUP_DIR="$(mktemp -d)"
DISPLAY_WARMUP_SCREENSHOT="${DISPLAY_WARMUP_DIR}/display-warmup.png"
if ! xcrun simctl io "${DEVICE_ID}" screenshot "${DISPLAY_WARMUP_SCREENSHOT}"; then
  rm -rf "${DISPLAY_WARMUP_DIR}"
  echo "error: failed to warm simulator display for ${DEVICE_ID}" >&2
  exit 1
fi
if [[ ! -s "${DISPLAY_WARMUP_SCREENSHOT}" ]]; then
  rm -rf "${DISPLAY_WARMUP_DIR}"
  echo "error: failed to warm simulator display for ${DEVICE_ID}: screenshot was empty" >&2
  exit 1
fi
rm -rf "${DISPLAY_WARMUP_DIR}"

# This integration test legitimately drives the real videoRecording start/stop
# handler, which resolves the file-backed database (VideoRecordingRepository ->
# getDatabase() -> resolveDbPath()). Under bun test, NODE_ENV=test arms a guard
# that throws when a test resolves the DEFAULT ~/.auto-mobile DB. We are not a
# unit test and must not touch the runner's home DB, so we point the DB at a
# fresh temp dir: this is exactly the guard's documented opt-out (an explicit
# AUTOMOBILE_DB_DIR / AUTOMOBILE_DB_PATH override). A temp dir — not
# AUTOMOBILE_DB_PATH=':memory:' —
# is used deliberately, since :memory: additionally trips the #3071 production
# in-memory guard unless AUTOMOBILE_ALLOW_IN_MEMORY_DB is set.
# The workflow may have started its stable warmed daemon with an isolated
# database already. Reuse that override so the CLI does not silently talk to a
# daemon backed by ~/.auto-mobile while this test process points elsewhere.
if [[ -z "${AUTOMOBILE_DB_DIR:-}" ]]; then
  AUTOMOBILE_DB_DIR="$(mktemp -d)"
fi
export AUTOMOBILE_DB_DIR
# `auto-mobile --cli` may start or restart the shared daemon with this database.
# The following navigation integration step reuses that daemon, so deleting its
# live database here causes SQLite disk-I/O failures. The directory is under the
# runner's temporary storage and is discarded with the CI runner.

cd "${PROJECT_ROOT}"
bun test test/integration/iosVideoRecordingStartStop.integration.test.ts
