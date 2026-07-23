#!/usr/bin/env bash
# Run the opt-in device capture -> WHIP -> MediaMTX -> WHEP decoder integration.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly repo_root
readonly runner="${repo_root}/scripts/webrtc/run-mediamtx-publisher-integration.sh"

if [[ "${AUTOMOBILE_WEBRTC_DEVICE_INTEGRATION:-}" != "1" ]]; then
  echo "Set AUTOMOBILE_WEBRTC_DEVICE_INTEGRATION=1 to run device WebRTC integration." >&2
  exit 2
fi

export AUTOMOBILE_MEDIAMTX_TEST_FILE="test/integration/webrtcDeviceCapture.integration.test.ts"
exec bash "${runner}"
