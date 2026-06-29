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
  DEVICE_ID="$("${PROJECT_ROOT}/scripts/ios/boot-simulator.sh")"
fi

export AUTOMOBILE_IOS_VIDEO_RECORDING_INTEGRATION=1
export AUTOMOBILE_IOS_VIDEO_RECORDING_DEVICE_ID="${DEVICE_ID}"

cd "${PROJECT_ROOT}"
bun test test/integration/iosVideoRecordingStartStop.integration.test.ts
