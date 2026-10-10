#!/usr/bin/env bats
# Tests scripts/ios/prototype-agent-smoke.sh with stubbed xcrun/simctl and a stubbed host driver.
# No simulator is touched.

setup() {
  repo_root="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  script="${repo_root}/scripts/ios/prototype-agent-smoke.sh"
  stubs="${BATS_TEST_TMPDIR}/stubs"
  mkdir -p "${stubs}"
  export STUB_LOG="${BATS_TEST_TMPDIR}/calls.log"
  export STUB_STATE="${BATS_TEST_TMPDIR}/state"
  mkdir -p "${STUB_STATE}"
  : > "${STUB_LOG}"
  export PROTOTYPE_SMOKE_LOG_DIR="${BATS_TEST_TMPDIR}/out"
  export PROTOTYPE_SMOKE_SETTLE_SECONDS=0
  export PROTOTYPE_SMOKE_CONNECT_ATTEMPTS=3
  export PROTOTYPE_SMOKE_BUILD_SCRIPT="${stubs}/build.sh"
  export PROTOTYPE_SMOKE_DRIVER="${stubs}/driver"
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
    if [[ ${STUB_DRIVER_MODE} == hello-and-pretty-reply ]]; then
      # The shape an older driver printed on the iOS 26 leg: a labelled handshake line, then the
      # get_prototype_status reply pretty-printed across several lines.
      echo 'agent {"agentVersion":"0.1.0","protocolVersion":1,"type":"hello","bundleId":"com.apple.Preferences"}'
      shown=false id=null
      if [[ -f ${shown_file} ]]; then shown=true id='"floating-demo"'; fi
      cat << JSON
{
  "type": "prototype_result",
  "requestId": "r1",
  "status": {
    "shown": ${shown},
    "id": ${id}
  },
  "success": true
}
JSON
    elif [[ -f ${shown_file} ]]; then
      echo '{"type":"prototype_result","success":true,"status":{"shown":true,"id":"floating-demo"}}'
    else
      echo '{"type":"prototype_result","success":true,"status":{"shown":false,"id":null}}'
    fi
    ;;
  floating)
    touch "${shown_file}"
    if [[ ${STUB_DRIVER_MODE} == show-fails ]]; then
      echo '{"type":"prototype_result","success":false,"error":"nope"}'
    else
      echo '{"type":"prototype_result","success":true}'
    fi
    ;;
  tap)
    n=$(($(cat "${STUB_STATE}/taps" 2> /dev/null || echo 0) + 1))
    echo "${n}" > "${STUB_STATE}/taps"
    if [[ ${STUB_DRIVER_MODE} == hello-and-pretty-reply ]]; then
      echo 'agent {"agentVersion":"0.1.0","protocolVersion":1,"type":"hello"}'
    fi
    case "${STUB_DRIVER_MODE}" in
      tap-rejected) echo '{"result":{"type":"prototype_result","success":false,"error":"simulate_tap is a test hook"},"events":[]}' ;;
      tap-no-event) echo '{"result":{"type":"prototype_result","success":true},"events":[]}' ;;
      tap-flat-sequence) echo '{"result":{"type":"prototype_result","success":true},"events":[{"type":"prototype_event","id":"floating-demo","kind":"emit","name":"liked","sequence":4}]}' ;;
      *) echo "{\"result\":{\"type\":\"prototype_result\",\"success\":true},\"events\":[{\"type\":\"prototype_event\",\"id\":\"floating-demo\",\"kind\":\"emit\",\"name\":\"liked\",\"sequence\":${n}}]}" ;;
    esac
    ;;
  dismiss)
    rm -f "${shown_file}"
    if [[ ${STUB_DRIVER_MODE} == event-before-reply ]]; then
      echo 'event {"kind":"dismissed","id":"floating-demo","type":"prototype_event","sequence":1}'
    fi
    if [[ ${STUB_DRIVER_MODE} == garbage-dismiss ]]; then
      echo 'Traceback: not json at all'
    elif [[ ${STUB_DRIVER_MODE} != event-only ]]; then
      echo '{"type":"prototype_result","success":true}'
    fi
    ;;
esac
STUB
  chmod +x "${stubs}/build.sh" "${stubs}/xcrun" "${stubs}/driver"
}

@test "passes on the newest matching runtime and cleans up the simulator it created" {
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  [[ ${output} == *"PASS on iOS 26.5"* ]]
  grep -q "xcrun simctl create prototype-agent-smoke-26.5-.* dt.iPhone17Pro com.apple.CoreSimulator.SimRuntime.iOS-26-5" "${STUB_LOG}"
  grep -q "xcrun simctl boot UDID-FRESH" "${STUB_LOG}"
  grep -q "driver launch UDID-FRESH com.apple.Preferences --test-hooks" "${STUB_LOG}"
  [ "$(grep -c '^driver tap like-button$' "${STUB_LOG}")" -eq 2 ]
  grep -q "xcrun simctl shutdown UDID-FRESH" "${STUB_LOG}"
  grep -q "xcrun simctl delete UDID-FRESH" "${STUB_LOG}"
  [ -f "${PROTOTYPE_SMOKE_LOG_DIR}/shown.png" ]
}

@test "skips asynchronous prototype_event lines the driver prints before the dismiss reply" {
  export STUB_DRIVER_MODE=event-before-reply
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  [[ ${output} == *"PASS on iOS 26.5"* ]]
  [ "$(jq -r '.type' "${PROTOTYPE_SMOKE_LOG_DIR}/dismiss.json")" = prototype_result ]
}

@test "reads a pretty-printed multi-line reply after a labelled agent handshake line" {
  export STUB_DRIVER_MODE=hello-and-pretty-reply
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  [[ ${output} == *"PASS on iOS 26.5"* ]]
  [[ ${output} != *"parse error"* ]]
  [ "$(jq -c '.status' "${PROTOTYPE_SMOKE_LOG_DIR}/status-initial.json")" = '{"shown":false,"id":null}' ]
  [ "$(jq -r '.status.id' "${PROTOTYPE_SMOKE_LOG_DIR}/status-shown.json")" = floating-demo ]
  [ "$(jq -r '.events[0].sequence' "${PROTOTYPE_SMOKE_LOG_DIR}/tap-2.json")" -eq 2 ]
}

@test "fails clearly when the driver output is not JSON" {
  export STUB_DRIVER_MODE=garbage-dismiss
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ ${output} == *"driver output for prototype_result is not JSON"* ]]
  grep -q "xcrun simctl delete UDID-FRESH" "${STUB_LOG}"
}

@test "fails clearly when the driver prints no prototype_result reply" {
  export STUB_DRIVER_MODE=event-only
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ ${output} == *"no prototype_result reply"* ]]
  grep -q "xcrun simctl delete UDID-FRESH" "${STUB_LOG}"
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

@test "fails when show_prototype reports failure" {
  export STUB_DRIVER_MODE=show-fails
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ ${output} == *"show_prototype failed"* ]]
  grep -q "xcrun simctl delete UDID-FRESH" "${STUB_LOG}"
}

@test "fails when the prototype screenshot equals the baseline" {
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

@test "taps the like button headlessly and asserts increasing prototype_event sequences" {
  run bash "${script}" 26
  [ "${status}" -eq 0 ]
  [ "$(jq -r '.events[0].sequence' "${PROTOTYPE_SMOKE_LOG_DIR}/tap-1.json")" -eq 1 ]
  [ "$(jq -r '.events[0].sequence' "${PROTOTYPE_SMOKE_LOG_DIR}/tap-2.json")" -eq 2 ]
}

@test "fails when the agent rejects simulate_tap" {
  export STUB_DRIVER_MODE=tap-rejected
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ ${output} == *"simulate_tap failed"* ]]
  grep -q "xcrun simctl delete UDID-FRESH" "${STUB_LOG}"
}

@test "fails when a tap delivers no prototype_event" {
  export STUB_DRIVER_MODE=tap-no-event
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ ${output} == *"did not deliver exactly one prototype_event"* ]]
}

@test "fails when the prototype_event sequence does not increase" {
  export STUB_DRIVER_MODE=tap-flat-sequence
  run bash "${script}" 26
  [ "${status}" -eq 1 ]
  [[ ${output} == *"sequence did not increase"* ]]
}
