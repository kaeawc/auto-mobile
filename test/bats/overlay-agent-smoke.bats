#!/usr/bin/env bats
# Tests scripts/ios/overlay-agent-smoke.sh with stubbed xcrun/simctl and a stubbed host driver.
# No simulator is touched.

setup() {
  repo_root="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  script="${repo_root}/scripts/ios/overlay-agent-smoke.sh"
  stubs="${BATS_TEST_TMPDIR}/stubs"
  mkdir -p "${stubs}"
  export STUB_LOG="${BATS_TEST_TMPDIR}/calls.log"
  export STUB_STATE="${BATS_TEST_TMPDIR}/state"
  mkdir -p "${STUB_STATE}"
  : > "${STUB_LOG}"
  export OVERLAY_SMOKE_LOG_DIR="${BATS_TEST_TMPDIR}/out"
  export OVERLAY_SMOKE_SETTLE_SECONDS=0
  export OVERLAY_SMOKE_CONNECT_ATTEMPTS=3
  export OVERLAY_SMOKE_BUILD_SCRIPT="${stubs}/build.sh"
  export OVERLAY_SMOKE_DRIVER="${stubs}/driver"
  export STUB_SAME_SCREENSHOTS=0
  export STUB_DRIVER_MODE=ok
  export PATH="${stubs}:${PATH}"

  cat > "${stubs}/build.sh" << 'STUB'
#!/usr/bin/env bash
echo "build" >> "${STUB_LOG}"
STUB

  cat > "${stubs}/xcrun" << 'STUB'
#!/usr/bin/env bash
echo "xcrun $*" >> "${STUB_LOG}"
case "$1 $2" in
  "simctl list")
    cat << 'JSON'
{"runtimes":[
 {"version":"18.5","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-18-5","isAvailable":true,
  "supportedDeviceTypes":[{"identifier":"dt.iPad","productFamily":"iPad"},{"identifier":"dt.iPhone16","productFamily":"iPhone"}]},
 {"version":"26.4","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-4","isAvailable":true,
  "supportedDeviceTypes":[{"identifier":"dt.iPhone17","productFamily":"iPhone"}]},
 {"version":"26.5","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","isAvailable":true,
  "supportedDeviceTypes":[{"identifier":"dt.iPhone17","productFamily":"iPhone"},{"identifier":"dt.iPhone17Pro","productFamily":"iPhone"},{"identifier":"dt.iPad","productFamily":"iPad"}]},
 {"version":"17.5","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-17-5","isAvailable":false,
  "supportedDeviceTypes":[{"identifier":"dt.iPhone15","productFamily":"iPhone"}]}
]}
JSON
    ;;
  "simctl create") echo "UDID-FRESH" ;;
  "simctl io")
    n=$(($(cat "${STUB_STATE}/shots" 2> /dev/null || echo 0) + 1))
    echo "${n}" > "${STUB_STATE}/shots"
    if [[ ${STUB_SAME_SCREENSHOTS} == 1 ]]; then n=1; fi
    echo "pixels-${n}" > "$5"
    ;;
  "simctl bootstatus") [[ ${STUB_BOOT_FAIL:-0} == 1 ]] && exit 1 ;;
esac
exit 0
STUB

  cat > "${stubs}/driver" << 'STUB'
#!/usr/bin/env bash
echo "driver $*" >> "${STUB_LOG}"
shown_file="${STUB_STATE}/shown"
case "$1" in
  launch) exit 0 ;;
  status)
    if [[ ${STUB_DRIVER_MODE} == never-connects ]]; then
      echo "not listening" >&2
      exit 1
    fi
    if [[ -f ${shown_file} ]]; then
      echo '{"type":"overlay_result","success":true,"status":{"shown":true,"id":"floating-demo"}}'
    else
      echo '{"type":"overlay_result","success":true,"status":{"shown":false,"id":null}}'
    fi
    ;;
  floating)
    touch "${shown_file}"
    if [[ ${STUB_DRIVER_MODE} == show-fails ]]; then
      echo '{"type":"overlay_result","success":false,"error":"nope"}'
    else
      echo '{"type":"overlay_result","success":true}'
    fi
    ;;
  dismiss)
    rm -f "${shown_file}"
    echo '{"type":"overlay_result","success":true}'
    ;;
esac
STUB
  chmod +x "${stubs}/build.sh" "${stubs}/xcrun" "${stubs}/driver"
}

@test "passes on the newest matching runtime and cleans up the simulator it created" {
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  [[ ${output} == *"PASS on iOS 26.5"* ]]
  grep -q "xcrun simctl create overlay-agent-smoke-26.5-.* dt.iPhone17Pro com.apple.CoreSimulator.SimRuntime.iOS-26-5" "${STUB_LOG}"
  grep -q "xcrun simctl boot UDID-FRESH" "${STUB_LOG}"
  grep -q "driver launch UDID-FRESH com.apple.Preferences" "${STUB_LOG}"
  grep -q "xcrun simctl shutdown UDID-FRESH" "${STUB_LOG}"
  grep -q "xcrun simctl delete UDID-FRESH" "${STUB_LOG}"
  [ -f "${OVERLAY_SMOKE_LOG_DIR}/shown.png" ]
}

@test "builds the agent before creating a simulator" {
  run bash "${script}" latest
  [ "${status}" -eq 0 ]
  [[ ${output} == *"PASS on iOS 26.5"* ]]
  build_line="$(grep -n '^build$' "${STUB_LOG}" | head -1 | cut -d: -f1)"
  create_line="$(grep -n 'simctl create' "${STUB_LOG}" | head -1 | cut -d: -f1)"
  [ "${build_line}" -lt "${create_line}" ]
}

@test "exact version selects that runtime" {
  run bash "${script}" 18.5
  [ "${status}" -eq 0 ]
  [[ ${output} == *"PASS on iOS 18.5"* ]]
  grep -q "dt.iPhone16" "${STUB_LOG}"
}

@test "an unavailable or missing runtime exits 3 without creating a simulator" {
  run bash "${script}" 17
  [ "${status}" -eq 3 ]
  ! grep -q "simctl create" "${STUB_LOG}"
}

@test "rejects a malformed version argument" {
  run bash "${script}" "26; rm -rf /"
  [ "${status}" -eq 2 ]
  run bash "${script}"
  [ "${status}" -eq 2 ]
}

@test "fails and still deletes the simulator when the agent never answers" {
  export STUB_DRIVER_MODE=never-connects
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ ${output} == *"agent never answered"* ]]
  grep -q "xcrun simctl delete UDID-FRESH" "${STUB_LOG}"
}

@test "fails when show_overlay reports failure" {
  export STUB_DRIVER_MODE=show-fails
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ ${output} == *"show_overlay failed"* ]]
  grep -q "xcrun simctl delete UDID-FRESH" "${STUB_LOG}"
}

@test "fails when the overlay screenshot equals the baseline" {
  export STUB_SAME_SCREENSHOTS=1
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ ${output} == *"not in the pixels"* ]]
}

@test "fails when the simulator never finishes booting" {
  export STUB_BOOT_FAIL=1
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ ${output} == *"did not finish booting"* ]]
  grep -q "xcrun simctl delete UDID-FRESH" "${STUB_LOG}"
  ! grep -q "driver launch" "${STUB_LOG}"
}
