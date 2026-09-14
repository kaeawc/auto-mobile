#!/usr/bin/env bats

SCRIPT="scripts/run-live-device-acceptance.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  COMMAND_LOG="${MOCK_BIN}/commands.log"
  RUN_SCOPE_LOG="${MOCK_BIN}/run-scope.log"
  OPERATOR_KEY="${MOCK_BIN}/operator.key"
  OWNERSHIP_MANIFEST="${MOCK_BIN}/ownership.json"
  export COMMAND_LOG
  export RUN_SCOPE_LOG
  ORIGINAL_PATH="${PATH}"

  cat > "${MOCK_BIN}/bun" <<'EOF'
#!/usr/bin/env bash
printf 'bun %s\n' "$*" >> "${COMMAND_LOG}"
if [[ "$1" == "run" && "$2" == "build" ]]; then
  mkdir -p dist/src
  printf '#!/usr/bin/env bun\n' > dist/src/index.js
  exit 0
fi
if [[ "${BUN_FAIL_ANDROID:-}" == "1" && "$*" == *"--platform android"* ]]; then
  exit 1
fi
if [[ "$*" == *"scripts/live-device-acceptance.ts --platform "* ]]; then
  printf '%s\t%s\n' \
    "${AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET}" \
    "${AUTOMOBILE_ACCEPTANCE_DISCOVERY_CAPABILITY}" >> "${RUN_SCOPE_LOG}"
fi
EOF
  chmod +x "${MOCK_BIN}/bun"

  cat > "${MOCK_BIN}/timeout" <<'EOF'
#!/usr/bin/env bash
printf 'timeout %s\n' "$*" >> "${COMMAND_LOG}"
shift 3 # -k 2 <seconds>
if [[ "${TIMEOUT_ANDROID:-}" == "1" && "$*" == *"--platform android"* ]]; then
  exit 124
fi
"$@"
EOF
  chmod +x "${MOCK_BIN}/timeout"
  dd if=/dev/zero of="${OPERATOR_KEY}" bs=32 count=1 status=none
  chmod 600 "${OPERATOR_KEY}"
}

teardown() {
  rm -rf "${MOCK_BIN}"
  export PATH="${ORIGINAL_PATH}"
}

run_harness() {
  run env AUTOMOBILE_ACCEPTANCE_LIVE=1 PATH="${MOCK_BIN}:${PATH}" bash "${SCRIPT}" \
    --confirm-live \
    --test-owned-devices \
    --android-avd-name "acceptance-android" \
    --android-sibling-avd-name "acceptance-android-sibling" \
    --android-duplicate-serial "emulator-5556" \
    --android-runtime "system-images;android-36;google_apis;x86_64" \
    --android-device-type "pixel_9" \
    --android-memory-mb "4096" \
    --android-cpu-cores "4" \
    --android-min-os-version "35" \
    --android-max-os-version "36" \
    --ios-simulator-name "Acceptance iPhone 17" \
    --ios-simulator-uuid "ACCEPTANCE-IOS-UUID" \
    --ios-same-name-sibling-uuid "ACCEPTANCE-IOS-SIBLING-UUID" \
    --ios-runtime "com.apple.CoreSimulator.SimRuntime.iOS-26-0" \
    --ios-device-type "com.apple.CoreSimulator.SimDeviceType.iPhone-17" \
    --ios-min-os-version "25.0" \
    --ios-max-os-version "26.0" \
    --ownership-manifest "${OWNERSHIP_MANIFEST}" \
    --operator-key-file "${OPERATOR_KEY}" \
    --evidence-dir "${MOCK_BIN}/evidence" \
    --total-timeout-seconds 30 \
    --platform-timeout-seconds 10 \
    "$@"
}

@test "requires explicit confirmation, opt-in, and test-owned-device acknowledgement" {
  run env PATH="${MOCK_BIN}:${PATH}" bash "${SCRIPT}" \
    --android-avd-name "acceptance-android" \
    --android-sibling-avd-name "acceptance-android-sibling" \
    --android-duplicate-serial "emulator-5556" \
    --android-runtime "system-image" \
    --android-device-type "pixel" \
    --android-memory-mb "4096" \
    --android-cpu-cores "4" \
    --android-min-os-version "35" \
    --android-max-os-version "36" \
    --ios-simulator-name "Acceptance iPhone" \
    --ios-simulator-uuid "acceptance-ios" \
    --ios-same-name-sibling-uuid "acceptance-ios-sibling" \
    --ios-runtime "ios-runtime" \
    --ios-device-type "iphone" \
    --ios-min-os-version "25.0" \
    --ios-max-os-version "26.0"

  [ "${status}" -eq 2 ]
  [[ "${output}" == *"--test-owned-devices"* ]]
  [ ! -f "${COMMAND_LOG}" ]
}

@test "runs the full Android then iOS matrix with one private run scope and exact required arguments" {
  run_harness

  [ "${status}" -eq 0 ]
  [ "$(grep -c '^bun ' "${COMMAND_LOG}")" -eq 3 ]
  grep -q '^bun run build$' "${COMMAND_LOG}"
  android_line="$(grep -n -- '--platform android' "${COMMAND_LOG}" | head -n 1 | cut -d: -f1)"
  ios_line="$(grep -n -- '--platform ios' "${COMMAND_LOG}" | head -n 1 | cut -d: -f1)"
  [ "${android_line}" -lt "${ios_line}" ]
  grep -q -- '--avd-name acceptance-android' "${COMMAND_LOG}"
  grep -q -- '--android-sibling-avd-name acceptance-android-sibling' "${COMMAND_LOG}"
  grep -q -- '--android-duplicate-serial emulator-5556' "${COMMAND_LOG}"
  grep -q -- '--runtime system-images;android-36;google_apis;x86_64' "${COMMAND_LOG}"
  grep -q -- '--device-type pixel_9' "${COMMAND_LOG}"
  grep -q -- '--min-os-version 35' "${COMMAND_LOG}"
  grep -q -- '--max-os-version 36' "${COMMAND_LOG}"
  grep -q -- '--android-memory-mb 4096' "${COMMAND_LOG}"
  grep -q -- '--android-cpu-cores 4' "${COMMAND_LOG}"
  grep -q -- '--simulator-name Acceptance iPhone 17' "${COMMAND_LOG}"
  grep -q -- '--simulator-uuid ACCEPTANCE-IOS-UUID' "${COMMAND_LOG}"
  grep -q -- '--ios-same-name-sibling-uuid ACCEPTANCE-IOS-SIBLING-UUID' "${COMMAND_LOG}"
  grep -q -- '--runtime com.apple.CoreSimulator.SimRuntime.iOS-26-0' "${COMMAND_LOG}"
  grep -q -- '--device-type com.apple.CoreSimulator.SimDeviceType.iPhone-17' "${COMMAND_LOG}"
  grep -q -- '--min-os-version 25.0' "${COMMAND_LOG}"
  grep -q -- '--max-os-version 26.0' "${COMMAND_LOG}"
  grep -q -- '--scenario full' "${COMMAND_LOG}"
  grep -q -- '--confirm-live --test-owned-devices' "${COMMAND_LOG}"
  grep -q -- "--ownership-manifest ${OWNERSHIP_MANIFEST}" "${COMMAND_LOG}"
  grep -q -- "--operator-key-file ${OPERATOR_KEY}" "${COMMAND_LOG}"
  grep -q -- "--entrypoint ${PWD}/dist/src/index.js" "${COMMAND_LOG}"
  grep -q -- '--timeout-ms 8000' "${COMMAND_LOG}"
  [ "$(grep -c '^timeout -k 2 8 bun ' "${COMMAND_LOG}")" -eq 2 ]
  [ "$(wc -l < "${RUN_SCOPE_LOG}")" -eq 2 ]
  IFS=$'\t' read -r android_startup_secret android_discovery_capability < "${RUN_SCOPE_LOG}"
  IFS=$'\t' read -r ios_startup_secret ios_discovery_capability < <(tail -n 1 "${RUN_SCOPE_LOG}")
  [ "${android_startup_secret}" = "${ios_startup_secret}" ]
  [ "${android_discovery_capability}" = "${ios_discovery_capability}" ]
  [ "${#android_startup_secret}" -eq 64 ]
  [ "${#android_discovery_capability}" -eq 64 ]
  [[ "${output}" != *"${android_startup_secret}"* ]]
  [[ "${output}" != *"${android_discovery_capability}"* ]]
  ! grep -Fq -- "${android_startup_secret}" "${COMMAND_LOG}"
  ! grep -Fq -- "${android_discovery_capability}" "${COMMAND_LOG}"
}

@test "stops before iOS when Android exhausts its platform timeout" {
  run env AUTOMOBILE_ACCEPTANCE_LIVE=1 TIMEOUT_ANDROID=1 PATH="${MOCK_BIN}:${PATH}" bash "${SCRIPT}" \
    --confirm-live \
    --test-owned-devices \
    --android-avd-name "acceptance-android" \
    --android-sibling-avd-name "acceptance-android-sibling" \
    --android-duplicate-serial "emulator-5556" \
    --android-runtime "system-image" \
    --android-device-type "pixel" \
    --android-memory-mb "4096" \
    --android-cpu-cores "4" \
    --android-min-os-version "35" \
    --android-max-os-version "36" \
    --ios-simulator-name "Acceptance iPhone" \
    --ios-simulator-uuid "acceptance-ios" \
    --ios-same-name-sibling-uuid "acceptance-ios-sibling" \
    --ios-runtime "ios-runtime" \
    --ios-device-type "iphone" \
    --ios-min-os-version "25.0" \
    --ios-max-os-version "26.0" \
    --ownership-manifest "${OWNERSHIP_MANIFEST}" \
    --operator-key-file "${OPERATOR_KEY}" \
    --evidence-dir "${MOCK_BIN}/evidence" \
    --total-timeout-seconds 30 \
    --platform-timeout-seconds 10

  [ "${status}" -eq 124 ]
  [[ "${output}" == *"android full failed"* ]]
  grep -q -- '--platform android' "${COMMAND_LOG}"
  ! grep -q -- '--platform ios' "${COMMAND_LOG}"
}

@test "rejects overlapping signed controls before build or live-driver invocation" {
  run_harness --android-sibling-avd-name "acceptance-android"

  [ "${status}" -eq 2 ]
  [[ "${output}" == *"--android-sibling-avd-name must differ"* ]]
  [ ! -f "${COMMAND_LOG}" ]

  run_harness --ios-same-name-sibling-uuid "ACCEPTANCE-IOS-UUID"

  [ "${status}" -eq 2 ]
  [[ "${output}" == *"--ios-same-name-sibling-uuid must differ"* ]]
  [ ! -f "${COMMAND_LOG}" ]
}
