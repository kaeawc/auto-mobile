#!/usr/bin/env bats
# Recorder contract with text placeholders only: no simulator or PNG encoder is used.
setup() {
  bats_require_minimum_version 1.5.0
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="${REPO_ROOT}/scripts/ios/prototype-record-goldens.sh"
  export STUB_ROOT="${BATS_TEST_TMPDIR}"
  export CALLS="${STUB_ROOT}/calls"
  export HOST_OS=Darwin DEVICE_STATE=Booted DEVICE_TYPE=com.apple.CoreSimulator.SimDeviceType.iPhone-16
  export RAW_WIDTH=1179 STABLE_AT=1 CLOCK_STEP=0
  unset PROTOTYPE_GOLDEN_STABLE_MAX_CAPTURES PROTOTYPE_GOLDEN_STABLE_BUDGET_SECS
  unset PROTOTYPE_GOLDEN_STABLE_SETTLE_SECS PROTOTYPE_GOLDEN_CAPTURE_TIMEOUT_SECS
  unset CAPTURE_FAIL_AT CAPTURE_EMPTY_AT CAPTURE_HANG_AT CAPTURE_BLOCK_AT REAL_SLEEP
  unset AUTOMOBILE_FORCE_PORTABLE_TIMEOUT AUTOMOBILE_WATCHDOG_DEADLINE_SECONDS
  mkdir -p "${STUB_ROOT}/bin" "${STUB_ROOT}/Viewer.app" "${STUB_ROOT}/container"
  cat > "${STUB_ROOT}/bin/uname" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "${HOST_OS}"
STUB
  cat > "${STUB_ROOT}/bin/bun" <<'STUB'
#!/usr/bin/env bash
printf 'emitter %s\n' "$*" >> "${CALLS}"
printf '%s\n' '{"width":1179,"height":2556,"cropTopPx":0,"cases":[{"golden":"sample","mode":"dark"}]}' > "$2/cases.json"
printf '%s\n' '{"root":{"type":"text","text":"fixture"}}' > "$2/sample.json"
STUB
  cat > "${STUB_ROOT}/bin/xcrun" <<'STUB'
#!/usr/bin/env bash
printf 'xcrun %s\n' "$*" >> "${CALLS}"
case "$2" in
  list) printf '{"devices":{"runtime":[{"udid":"test-udid","state":"%s","deviceTypeIdentifier":"%s"}]}}\n' "${DEVICE_STATE}" "${DEVICE_TYPE}" ;;
  get_app_container) printf '%s/container\n' "${STUB_ROOT}" ;;
  io)
    count=0
    if [[ -f "${STUB_ROOT}/capture-count" ]]; then read -r count < "${STUB_ROOT}/capture-count"; fi
    count=$((count + 1))
    printf '%s\n' "${count}" > "${STUB_ROOT}/capture-count"
    # Comma lists of capture numbers that fail, write nothing, or hang (the timeout's 124).
    case ",${CAPTURE_FAIL_AT:-}," in *",${count},"*) exit 1 ;; esac
    case ",${CAPTURE_HANG_AT:-}," in *",${count},"*) exit 124 ;; esac
    case ",${CAPTURE_BLOCK_AT:-}," in *",${count},"*) exec /bin/sleep 30 ;; esac
    case ",${CAPTURE_EMPTY_AT:-}," in *",${count},"*) : > "${@: -1}"; exit 0 ;; esac
    frame="${count}"
    if (( STABLE_AT > 0 && count >= STABLE_AT )); then frame="${STABLE_AT}"; fi
    printf 'frame %s\n' "${frame}" > "${@: -1}"
    ;;
esac
STUB
  cat > "${STUB_ROOT}/bin/sips" <<'STUB'
#!/usr/bin/env bash
printf 'sips %s\n' "$*" >> "${CALLS}"
if [[ "$1" == -g ]]; then
  if [[ "${@: -1}" == */screen.png ]]; then
    printf 'pixelWidth: %s\npixelHeight: 2556\n' "${RAW_WIDTH}"
  else
    printf 'pixelWidth: 1179\npixelHeight: 2556\n'
  fi
else
  cp "$7" "${@: -1}"
fi
STUB
  cat > "${STUB_ROOT}/bin/sleep" <<'STUB'
#!/usr/bin/env bash
printf 'sleep %s\n' "$*" >> "${CALLS}"
# Only the watchdog deadline under test really waits; every recorder sleep is instant.
if [[ -n "${REAL_SLEEP:-}" && "$*" == "${REAL_SLEEP}" ]]; then exec /bin/sleep "$@"; fi
STUB
  # Shadow GNU timeout so every host takes the same deterministic path; the hang is the stub's 124.
  cat > "${STUB_ROOT}/bin/timeout" <<'STUB'
#!/usr/bin/env bash
printf 'timeout %s\n' "$*" >> "${CALLS}"
shift 3
exec "$@"
STUB
  cat > "${STUB_ROOT}/bin/date" <<'STUB'
#!/usr/bin/env bash
[[ "$*" == +%s ]] || exit 1
count=0
if [[ -f "${STUB_ROOT}/capture-count" ]]; then read -r count < "${STUB_ROOT}/capture-count"; fi
printf '%s\n' "$((count * CLOCK_STEP))"
STUB
  chmod +x "${STUB_ROOT}/bin/"*
  export PATH="${STUB_ROOT}/bin:${PATH}"
}

record() {
  run bash "${SCRIPT}" test-udid --viewer "${STUB_ROOT}/Viewer.app" --out "${STUB_ROOT}/out" "$@"
}

@test "recorder refuses the CI iPhone UDID including lower-case spelling" {
  run bash "${SCRIPT}" 18a2d9b1-cdfa-445a-93aa-a532ea4b5498
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"refusing the CI iPhone"* ]]
  [ ! -e "${CALLS}" ]
}

@test "recorder refuses non-darwin without invoking simctl" {
  export HOST_OS=Linux
  record
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"macOS is required"* ]]
  [ ! -e "${CALLS}" ]
}

@test "recorder rejects missing arguments and unknown options" {
  run bash "${SCRIPT}"
  [ "${status}" -eq 2 ]
  record --viewer
  [ "${status}" -eq 2 ]
  record --out
  [ "${status}" -eq 2 ]
  record --bogus
  [ "${status}" -eq 2 ]
  [ ! -e "${CALLS}" ]
}

@test "recorder requires a booted iPhone 16 and never boots it" {
  export DEVICE_STATE=Shutdown
  record
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"xcrun simctl boot test-udid"* ]]
  export DEVICE_STATE=Booted DEVICE_TYPE=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro
  record
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"device type must be iPhone 16"* ]]
  run ! grep -q 'simctl boot ' "${CALLS}"
}

@test "recorder rejects unknown goldens before changing appearance" {
  record absent
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"unknown golden: absent"* ]]
  run ! grep -q 'status_bar' "${CALLS}"
}

@test "recorder installs saved layout, crops with Y X and H W, and restores state" {
  record sample
  [ "${status}" -eq 0 ]
  [ -f "${STUB_ROOT}/out/sample.png" ]
  grep -qx '{"formatVersion":1,"specFile":"spec.json","assets":\[\],"fonts":\[\]}' "${STUB_ROOT}/container/Documents/prototype/manifest.json"
  grep -q 'fixture' "${STUB_ROOT}/container/Documents/prototype/spec.json"
  grep -q 'simctl uninstall test-udid dev.jasonpearson.automobile.prototype-viewer' "${CALLS}"
  grep -q 'simctl install test-udid' "${CALLS}"
  grep -q 'simctl ui test-udid appearance dark' "${CALLS}"
  grep -q 'simctl launch test-udid dev.jasonpearson.automobile.prototype-viewer --automobile-prototype-recording' "${CALLS}"
  grep -q 'sips --cropOffset 0 0 --cropToHeightWidth 2556 1179' "${CALLS}"
  grep -q 'simctl terminate test-udid' "${CALLS}"
  grep -q 'simctl status_bar test-udid clear' "${CALLS}"
  grep -q 'simctl ui test-udid appearance light' "${CALLS}"
  run ! grep -Eq 'shutdown|Simulator.app|pkill' "${CALLS}"
  emitted_dir="$(awk '/^emitter / {print $3}' "${CALLS}")"
  [ ! -e "${emitted_dir}" ]
}

@test "recorder refuses unexpected raw dimensions and still cleans up" {
  export RAW_WIDTH=100
  record sample
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"wrong screenshot size"* ]]
  [ ! -e "${STUB_ROOT}/out/sample.png" ]
  grep -q 'simctl status_bar test-udid clear' "${CALLS}"
  grep -q 'simctl ui test-udid appearance light' "${CALLS}"
  grep -q 'simctl terminate test-udid' "${CALLS}"
}

@test "recorder captures stable on second screenshot without fallback" {
  record sample
  [ "${status}" -eq 0 ]
  [ "$(cat "${STUB_ROOT}/capture-count")" -eq 2 ]
  [[ "${output}" == *"prototype-record-goldens: sample: capture=stable (2 captures)"* ]]
  run grep -qx 'sleep 2' "${CALLS}"
  [ "${status}" -eq 1 ]
  [ "$(grep -c '^sleep 0.5$' "${CALLS}")" -eq 1 ]
  grep -qx 'frame 1' "${STUB_ROOT}/out/sample.png"
}

@test "recorder waits the settle floor before the first capture" {
  record sample
  [ "${status}" -eq 0 ]
  [ "$(grep -m1 -E '^sleep |^xcrun simctl io ' "${CALLS}")" = 'sleep 1.5' ]
  rm -f "${CALLS}" "${STUB_ROOT}/capture-count"
  export PROTOTYPE_GOLDEN_STABLE_SETTLE_SECS=3
  record sample
  [ "${status}" -eq 0 ]
  [ "$(grep -m1 -E '^sleep |^xcrun simctl io ' "${CALLS}")" = 'sleep 3' ]
}

@test "recorder bounds each capture by the remaining budget" {
  export STABLE_AT=3 CLOCK_STEP=3 PROTOTYPE_GOLDEN_CAPTURE_TIMEOUT_SECS=20
  record sample
  [ "${status}" -eq 0 ]
  [ "$(grep '^timeout ' "${CALLS}" | awk '{print $4}' | tr '\n' ' ')" = '15 12 9 6 ' ]
  [[ "${output}" == *"capture=stable (4 captures)"* ]]
}

@test "recorder discards failed captures and needs two good frames after them" {
  export CAPTURE_FAIL_AT=1
  record sample
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"sample: capture 1 failed with status 1; discarding it"* ]]
  [[ "${output}" == *"capture=stable (3 captures)"* ]]
  grep -qx 'frame 1' "${STUB_ROOT}/out/sample.png"
}

@test "recorder never treats two empty captures as stable" {
  export CAPTURE_EMPTY_AT=1,2
  record sample
  [ "${status}" -eq 0 ]
  [ "$(grep -c 'wrote an empty file; discarding it' <<< "${output}")" -eq 2 ]
  [[ "${output}" == *"capture=stable (4 captures)"* ]]
  grep -qx 'frame 1' "${STUB_ROOT}/out/sample.png"
}

@test "recorder discards a timed-out capture" {
  export CAPTURE_HANG_AT=1
  record sample
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"sample: capture 1 timed out after 10s; discarding it"* ]]
  [[ "${output}" == *"capture=stable (3 captures)"* ]]
}

@test "recorder kills a capture that really hangs on the portable watchdog path" {
  # A real 2 s watchdog deadline (normal stub captures finish far sooner); the kill grace is instant.
  export CAPTURE_BLOCK_AT=1 AUTOMOBILE_FORCE_PORTABLE_TIMEOUT=1 AUTOMOBILE_WATCHDOG_DEADLINE_SECONDS=2.0 REAL_SLEEP=2.0
  export AUTOMOBILE_WATCHDOG_SNAPSHOT_FILE="${STUB_ROOT}/watchdog-snapshot.txt"
  started="${SECONDS}"
  record sample
  [ "${status}" -eq 0 ]
  (( SECONDS - started < 10 ))
  [[ "${output}" == *"sample: capture 1 timed out after 10s; discarding it"* ]]
  [[ "${output}" == *"capture=stable (3 captures)"* ]]
  run ! grep -q '^timeout -k ' "${CALLS}"
}

@test "recorder fails and cleans up when the fallback capture is empty or fails" {
  export STABLE_AT=0 PROTOTYPE_GOLDEN_STABLE_MAX_CAPTURES=2 CAPTURE_EMPTY_AT=3
  record sample
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"sample: fallback screenshot wrote an empty file"* ]]
  [ ! -e "${STUB_ROOT}/out/sample.png" ]
  grep -q 'simctl terminate test-udid' "${CALLS}"
  grep -q 'simctl status_bar test-udid clear' "${CALLS}"
  rm -f "${CALLS}" "${STUB_ROOT}/capture-count"
  unset CAPTURE_EMPTY_AT
  export CAPTURE_FAIL_AT=3
  record sample
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"sample: fallback screenshot failed with status 1"* ]]
  [ ! -e "${STUB_ROOT}/out/sample.png" ]
  grep -q 'simctl ui test-udid appearance light' "${CALLS}"
}

@test "recorder captures stable after four screenshots at the count bound" {
  export STABLE_AT=3 PROTOTYPE_GOLDEN_STABLE_MAX_CAPTURES=4
  record sample
  [ "${status}" -eq 0 ]
  [ "$(cat "${STUB_ROOT}/capture-count")" -eq 4 ]
  [[ "${output}" == *"capture=stable (4 captures)"* ]]
  run grep -qx 'sleep 2' "${CALLS}"
  [ "${status}" -eq 1 ]
  grep -qx 'frame 3' "${STUB_ROOT}/out/sample.png"
}

@test "recorder falls back after default maximum captures and uses final screenshot" {
  export STABLE_AT=0
  record sample
  [ "${status}" -eq 0 ]
  [ "$(cat "${STUB_ROOT}/capture-count")" -eq 9 ]
  [[ "${output}" == *"prototype-record-goldens: sample: capture=fallback (not stable after 8 captures)"* ]]
  [ "$(grep -c '^sleep 2$' "${CALLS}")" -eq 1 ]
  grep -qx 'frame 9' "${STUB_ROOT}/out/sample.png"
}

@test "recorder falls back at the time budget before the maximum captures" {
  export STABLE_AT=0 CLOCK_STEP=3 PROTOTYPE_GOLDEN_STABLE_BUDGET_SECS=2
  record sample
  [ "${status}" -eq 0 ]
  [ "$(cat "${STUB_ROOT}/capture-count")" -eq 2 ]
  [[ "${output}" == *"capture=fallback (not stable after 1 captures)"* ]]
  grep -qx 'sleep 2' "${CALLS}"
  grep -qx 'frame 2' "${STUB_ROOT}/out/sample.png"
}

@test "recorder rejects invalid stability bounds before invoking simctl" {
  export PROTOTYPE_GOLDEN_STABLE_MAX_CAPTURES=0
  record sample
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"PROTOTYPE_GOLDEN_STABLE_MAX_CAPTURES must be a positive integer"* ]]
  unset PROTOTYPE_GOLDEN_STABLE_MAX_CAPTURES
  export PROTOTYPE_GOLDEN_STABLE_BUDGET_SECS=-1
  record sample
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"PROTOTYPE_GOLDEN_STABLE_BUDGET_SECS must be a nonnegative integer"* ]]
  unset PROTOTYPE_GOLDEN_STABLE_BUDGET_SECS
  export PROTOTYPE_GOLDEN_STABLE_SETTLE_SECS=1.
  record sample
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"PROTOTYPE_GOLDEN_STABLE_SETTLE_SECS must be a nonnegative number of seconds"* ]]
  unset PROTOTYPE_GOLDEN_STABLE_SETTLE_SECS
  export PROTOTYPE_GOLDEN_CAPTURE_TIMEOUT_SECS=0
  record sample
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"PROTOTYPE_GOLDEN_CAPTURE_TIMEOUT_SECS must be a positive integer"* ]]
  [ ! -e "${CALLS}" ]
}
