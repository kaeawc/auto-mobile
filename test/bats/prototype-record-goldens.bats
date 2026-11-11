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
  grep -q 'simctl launch test-udid' "${CALLS}"
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
  [ "$(grep -c '^sleep 0.5$' "${CALLS}")" -eq 2 ]
  grep -qx 'frame 1' "${STUB_ROOT}/out/sample.png"
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
  [ ! -e "${CALLS}" ]
}
