#!/usr/bin/env bats
#
# Tests for scripts/ios/video-recording-start-stop-integration.sh.
# The simulator display warm-up is mocked so no Xcode installation is needed.

SCRIPT="scripts/ios/video-recording-start-stop-integration.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  INVOCATIONS_FILE="${MOCK_BIN}/invocations"
}

teardown() {
  rm -rf "$MOCK_BIN"
  export PATH="$ORIG_PATH"
}

make_mock_commands() {
  cat > "${MOCK_BIN}/xcrun" <<SCRIPT
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${INVOCATIONS_FILE}"
if [[ "\$1" == "simctl" && "\$2" == "io" && "\$4" == "screenshot" ]]; then
  printf 'warm display frame\n' > "\$5"
  exit 0
fi
echo "unexpected xcrun invocation: \$*" >&2
exit 1
SCRIPT
  cat > "${MOCK_BIN}/bun" <<SCRIPT
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${INVOCATIONS_FILE}"
exit 0
SCRIPT
  cat > "${MOCK_BIN}/ffmpeg" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
  cat > "${MOCK_BIN}/ffprobe" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
  cat > "${MOCK_BIN}/jq" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun" "${MOCK_BIN}/bun" "${MOCK_BIN}/ffmpeg" "${MOCK_BIN}/ffprobe" "${MOCK_BIN}/jq"
  export PATH="${MOCK_BIN}:${PATH}"
}

@test "script is executable" {
  [ -x "$SCRIPT" ]
}

@test "warms the selected simulator display before starting the integration test" {
  make_mock_commands

  run env AUTOMOBILE_IOS_VIDEO_RECORDING_DEVICE_ID="SIM-UDID" bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$(sed -n '1p' "$INVOCATIONS_FILE")" == "simctl io SIM-UDID screenshot "* ]]
  [ "$(sed -n '2p' "$INVOCATIONS_FILE")" = "test test/integration/iosVideoRecordingStartStop.integration.test.ts" ]
}

@test "uses AutoMobile product boot when no iPhone simulator is already booted" {
  make_mock_commands
  cat > "${MOCK_BIN}/xcrun" <<SCRIPT
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${INVOCATIONS_FILE}"
if [[ "\$1" == "simctl" && "\$2" == "list" ]]; then
  printf '%s\n' '{"devices":{}}'
  exit 0
fi
if [[ "\$1" == "--sdk" && "\$2" == "iphonesimulator" && "\$3" == "--show-sdk-version" ]]; then
  printf '%s\n' '26.5'
  exit 0
fi
if [[ "\$1" == "simctl" && "\$2" == "io" && "\$4" == "screenshot" ]]; then
  printf 'warm display frame\n' > "\$5"
  exit 0
fi
exit 1
SCRIPT
  cat > "${MOCK_BIN}/bun" <<SCRIPT
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${INVOCATIONS_FILE}"
if [[ "\$1" == "run" && "\$2" == "src/index.ts" ]]; then
  printf '%s\n' '{"deviceId":"PRODUCT-UDID"}'
fi
SCRIPT
  cat > "${MOCK_BIN}/jq" <<'SCRIPT'
#!/usr/bin/env bash
if [[ "$1" == "-r" && "$2" == ".deviceId" ]]; then
  cat >/dev/null
  printf '%s\n' 'PRODUCT-UDID'
else
  cat >/dev/null
fi
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun" "${MOCK_BIN}/bun" "${MOCK_BIN}/jq"

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  grep -q -- "run src/index.ts --boot-device --platform ios --create-if-missing --timeout-ms 600000 --min-os-version 26.5 --max-os-version 26.5" "$INVOCATIONS_FILE"
  grep -q -- "simctl io PRODUCT-UDID screenshot" "$INVOCATIONS_FILE"
}

@test "fails before the integration test when the simulator cannot produce a warm-up frame" {
  make_mock_commands
  cat > "${MOCK_BIN}/xcrun" <<SCRIPT
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${INVOCATIONS_FILE}"
exit 1
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun"

  run env AUTOMOBILE_IOS_VIDEO_RECORDING_DEVICE_ID="SIM-UDID" bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"failed to warm simulator display"* ]]
  ! grep -q -- "test test/integration/iosVideoRecordingStartStop.integration.test.ts" "$INVOCATIONS_FILE"
}

@test "fails before the integration test when the warm-up screenshot is empty" {
  make_mock_commands
  cat > "${MOCK_BIN}/xcrun" <<SCRIPT
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${INVOCATIONS_FILE}"
exit 0
SCRIPT
  chmod +x "${MOCK_BIN}/xcrun"

  run env AUTOMOBILE_IOS_VIDEO_RECORDING_DEVICE_ID="SIM-UDID" bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"screenshot was empty"* ]]
  ! grep -q -- "test test/integration/iosVideoRecordingStartStop.integration.test.ts" "$INVOCATIONS_FILE"
}
