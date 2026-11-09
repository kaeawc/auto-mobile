#!/usr/bin/env bats
# Recorder contract with text placeholders only: no simulator or PNG encoder is used.
setup() {
  bats_require_minimum_version 1.5.0
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="${REPO_ROOT}/scripts/ios/prototype-record-goldens.sh"
  export STUB_ROOT="${BATS_TEST_TMPDIR}"
  export CALLS="${STUB_ROOT}/calls"
  export HOST_OS=Darwin DEVICE_STATE=Booted DEVICE_TYPE=com.apple.CoreSimulator.SimDeviceType.iPhone-16
  export RAW_WIDTH=1179
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
  io) printf 'not image data\n' > "${@: -1}" ;;
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
  printf 'not image data\n' > "${@: -1}"
fi
STUB
  cat > "${STUB_ROOT}/bin/sleep" <<'STUB'
#!/usr/bin/env bash
printf 'sleep %s\n' "$*" >> "${CALLS}"
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
