#!/usr/bin/env bats
#
# Pins how scripts/ios/xcode-test.sh picks the simulator it tests on. xcrun and
# xcodebuild are stubs: `simctl list --json` returns the runtime and device JSON
# written by each test (same keys as a real capture), and `xcodebuild test`
# records its -destination, so this runs on any host with no Xcode.
#
# The CircleCI Playground job once picked "iPhone 17 Pro" on an iOS 26.5 runtime
# that listed no supported architectures while the SDK was 26.6, and failed with
# "SimDevice native architecture is nil".

setup() {
  work="$(mktemp -d)"
  ios_dir="${work}/ios"
  mkdir -p "${ios_dir}/Playground/Playground.xcodeproj" "${work}/bin"
  script="$BATS_TEST_DIRNAME/../../scripts/ios/xcode-test.sh"
  sdk_version="26.6"

  cat > "${work}/bin/xcrun" << 'STUB'
#!/bin/bash
case "$*" in
  "--sdk iphonesimulator --show-sdk-version") cat "${STUB_DIR}/sdk" ;;
  "simctl list --json runtimes") cat "${STUB_DIR}/runtimes.json" ;;
  "simctl list --json devices") cat "${STUB_DIR}/devices.json" ;;
  "simctl create "*)
    printf '%s\n' "$*" >> "${STUB_DIR}/create.log"
    echo "CREATED-0000-0000-0000-000000000001"
    ;;
  *) echo "unexpected xcrun $*" >&2; exit 2 ;;
esac
STUB
  cat > "${work}/bin/xcodebuild" << 'STUB'
#!/bin/bash
case "$1" in
  -version) printf 'Xcode 26.6\nBuild version 17X000\n' ;;
  -project)
    if [[ " $* " == *" -list "* ]]; then
      printf 'Information about project "Playground":\n    Schemes:\n        Playground\n\n'
      exit 0
    fi
    prev=""
    for arg in "$@"; do
      [[ "${prev}" == "-destination" ]] && printf '%s\n' "${arg}" > "${STUB_DIR}/destination"
      prev="${arg}"
    done
    ;;
esac
STUB
  chmod +x "${work}/bin/xcrun" "${work}/bin/xcodebuild"
}

teardown() {
  rm -rf "${work}"
}

write_json() {
  printf '%s\n' "${sdk_version}" > "${work}/sdk"
  printf '%s\n' "$1" > "${work}/runtimes.json"
  printf '%s\n' "$2" > "${work}/devices.json"
}

run_xcode_test() {
  # DEVELOPER_DIR set: select_pinned_xcode keeps the stubbed toolchain.
  run env "$@" PATH="${work}/bin:${PATH}" STUB_DIR="${work}" IOS_DIR="${ios_dir}" \
    DEVELOPER_DIR=/nonexistent bash "${script}" Playground
}

iphone_types='[
  {"name": "iPhone 16", "productFamily": "iPhone", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16"},
  {"name": "iPhone 17 Pro", "productFamily": "iPhone", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"},
  {"name": "iPad Pro 13-inch (M4)", "productFamily": "iPad", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB"}
]'

runtime() {
  # runtime VERSION IDENTIFIER_SUFFIX ARCHS_JSON
  printf '{"isAvailable": true, "version": "%s", "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-%s", "platform": "iOS", "supportedArchitectures": %s, "supportedDeviceTypes": %s}' \
    "$1" "$2" "$3" "${iphone_types}"
}

device() {
  # device UDID NAME TYPE_SUFFIX STATE
  printf '{"udid": "%s", "isAvailable": true, "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.%s", "state": "%s", "name": "%s"}' \
    "$1" "$3" "$4" "$2"
}

@test "skips an iPhone on a runtime with no architectures for one on the SDK's runtime" {
  write_json "{\"runtimes\": [$(runtime 26.5 26-5 '[]'), $(runtime 26.6 26-6 '["x86_64", "arm64"]')]}" \
    "{\"devices\": {
      \"com.apple.CoreSimulator.SimRuntime.iOS-26-5\": [$(device BROKEN-265 'iPhone 17 Pro' iPhone-17-Pro Shutdown)],
      \"com.apple.CoreSimulator.SimRuntime.iOS-26-6\": [$(device GOOD-266 'iPhone 16' iPhone-16 Shutdown)]}}"

  run_xcode_test -u CI

  [ "$status" -eq 0 ]
  [ "$(cat "${work}/destination")" = "platform=iOS Simulator,id=GOOD-266" ]
  [[ "$output" == *"iOS 26.6 (com.apple.CoreSimulator.SimRuntime.iOS-26-6)"* ]]
}

@test "prefers the runtime matching the SDK major.minor over an older one" {
  write_json "{\"runtimes\": [$(runtime 18.6 18-6 '["arm64"]'), $(runtime 26.6 26-6 '["arm64"]')]}" \
    "{\"devices\": {
      \"com.apple.CoreSimulator.SimRuntime.iOS-18-6\": [$(device OLD-186 'iPhone 16' iPhone-16 Shutdown)],
      \"com.apple.CoreSimulator.SimRuntime.iOS-26-6\": [$(device NEW-266 'iPhone 17 Pro' iPhone-17-Pro Shutdown)]}}"

  run_xcode_test -u CI

  [ "$status" -eq 0 ]
  [ "$(cat "${work}/destination")" = "platform=iOS Simulator,id=NEW-266" ]
}

@test "a three-part SDK version still matches the major.minor runtime" {
  sdk_version="26.6.1"
  write_json "{\"runtimes\": [$(runtime 26.5 26-5 '["arm64"]'), $(runtime 26.6 26-6 '["arm64"]')]}" \
    "{\"devices\": {
      \"com.apple.CoreSimulator.SimRuntime.iOS-26-5\": [$(device OLD-265 'iPhone 16' iPhone-16 Shutdown)],
      \"com.apple.CoreSimulator.SimRuntime.iOS-26-6\": [$(device NEW-266 'iPhone 16' iPhone-16 Shutdown)]}}"

  run_xcode_test -u CI

  [ "$status" -eq 0 ]
  [ "$(cat "${work}/destination")" = "platform=iOS Simulator,id=NEW-266" ]
}

@test "ignores the device-specific iPhone Duo runtime on a 27.2 SDK" {
  sdk_version="27.2"
  write_json "{\"runtimes\": [$(runtime 27.2 27-2 '["arm64"]'), $(runtime 27.2 27-2-iPhone19-4 '["arm64"]')]}" \
    "{\"devices\": {
      \"com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4\": [$(device DUO 'iPhone Duo' iPhone-Duo Booted)],
      \"com.apple.CoreSimulator.SimRuntime.iOS-27-2\": [$(device PHONE-272 'iPhone 17 Pro' iPhone-17-Pro Shutdown)]}}"

  run_xcode_test -u CI

  [ "$status" -eq 0 ]
  [ "$(cat "${work}/destination")" = "platform=iOS Simulator,id=PHONE-272" ]
}

@test "under CI, creates the dedicated simulator on the SDK's runtime when it has none" {
  write_json "{\"runtimes\": [$(runtime 26.6 26-6 '["arm64"]')]}" \
    "{\"devices\": {\"com.apple.CoreSimulator.SimRuntime.iOS-26-6\": []}}"

  run_xcode_test CI=true

  [ "$status" -eq 0 ]
  grep -qx 'simctl create AutoMobile Playground CI com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-6' "${work}/create.log"
  [ "$(cat "${work}/destination")" = "platform=iOS Simulator,id=CREATED-0000-0000-0000-000000000001" ]
}

@test "under CI, fails loudly when no runtime is usable" {
  write_json "{\"runtimes\": [$(runtime 26.5 26-5 '[]')]}" \
    "{\"devices\": {\"com.apple.CoreSimulator.SimRuntime.iOS-26-5\": [$(device BROKEN-265 'iPhone 17 Pro' iPhone-17-Pro Shutdown)]}}"

  run_xcode_test CI=true

  [ "$status" -eq 1 ]
  [[ "$output" == *"No usable iOS Simulator runtime"* ]]
  [ ! -e "${work}/destination" ]
}

@test "locally, a booted iPhone on a usable runtime wins and nothing is created" {
  write_json "{\"runtimes\": [$(runtime 18.6 18-6 '["arm64"]'), $(runtime 26.6 26-6 '["arm64"]')]}" \
    "{\"devices\": {
      \"com.apple.CoreSimulator.SimRuntime.iOS-18-6\": [$(device BOOTED-186 'My Phone' iPhone-16 Booted)],
      \"com.apple.CoreSimulator.SimRuntime.iOS-26-6\": [$(device IDLE-266 'iPhone 17 Pro' iPhone-17-Pro Shutdown)]}}"

  run_xcode_test -u CI

  [ "$status" -eq 0 ]
  [ "$(cat "${work}/destination")" = "platform=iOS Simulator,id=BOOTED-186" ]
  [ ! -e "${work}/create.log" ]
}

@test "locally, a booted iPhone on an SDK patch runtime wins over an idle newer patch runtime" {
  write_json "{\"runtimes\": [$(runtime 26.6.1 26-6-1 '["arm64"]'), $(runtime 26.6.2 26-6-2 '["arm64"]')]}" \
    "{\"devices\": {
      \"com.apple.CoreSimulator.SimRuntime.iOS-26-6-1\": [$(device BOOTED-2661 'iPhone 16' iPhone-16 Booted)],
      \"com.apple.CoreSimulator.SimRuntime.iOS-26-6-2\": []}}"

  run_xcode_test -u CI

  [ "$status" -eq 0 ]
  [ "$(cat "${work}/destination")" = "platform=iOS Simulator,id=BOOTED-2661" ]
  [ ! -e "${work}/create.log" ]
}

@test "locally, no simulator on the chosen runtime skips without creating one" {
  write_json "{\"runtimes\": [$(runtime 26.6 26-6 '["arm64"]')]}" \
    "{\"devices\": {\"com.apple.CoreSimulator.SimRuntime.iOS-26-6\": []}}"

  run_xcode_test -u CI

  [ "$status" -eq 0 ]
  [[ "$output" == *"will be skipped"* ]]
  [ ! -e "${work}/create.log" ]
  [ ! -e "${work}/destination" ]
}

@test "under CI, a booted foreign simulator is ignored and the dedicated one is created" {
  write_json "{\"runtimes\": [$(runtime 26.6 26-6 '["arm64"]')]}" \
    "{\"devices\": {\"com.apple.CoreSimulator.SimRuntime.iOS-26-6\": [$(device FOREIGN 'AutoMobile CI iPhone' iPhone-17-Pro Booted), $(device IDLE 'iPhone 16' iPhone-16 Shutdown)]}}"

  run_xcode_test CI=true

  [ "$status" -eq 0 ]
  grep -qx 'simctl create AutoMobile Playground CI com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-6' "${work}/create.log"
  [ "$(cat "${work}/destination")" = "platform=iOS Simulator,id=CREATED-0000-0000-0000-000000000001" ]
}

@test "under CI, an existing dedicated simulator is reused without creating" {
  write_json "{\"runtimes\": [$(runtime 26.6 26-6 '["arm64"]')]}" \
    "{\"devices\": {\"com.apple.CoreSimulator.SimRuntime.iOS-26-6\": [$(device FOREIGN 'AutoMobile CI iPhone' iPhone-17-Pro Booted), $(device DEDICATED 'AutoMobile Playground CI' iPhone-17-Pro Shutdown)]}}"

  run_xcode_test CI=true

  [ "$status" -eq 0 ]
  [ "$(cat "${work}/destination")" = "platform=iOS Simulator,id=DEDICATED" ]
  [ ! -e "${work}/create.log" ]
}

@test "a runtime that supports only iPhone Duo is not usable" {
  duo='[{"name": "iPhone Duo", "productFamily": "iPhone", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo"}]'
  duo_runtime='{"isAvailable": true, "version": "26.6", "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-6", "platform": "iOS", "supportedArchitectures": ["arm64"], "supportedDeviceTypes": '"${duo}"'}'
  write_json "{\"runtimes\": [$(runtime 26.5 26-5 '["arm64"]'), ${duo_runtime}]}" \
    "{\"devices\": {\"com.apple.CoreSimulator.SimRuntime.iOS-26-5\": [$(device OK-265 'iPhone 16' iPhone-16 Shutdown)]}}"

  run_xcode_test -u CI

  [ "$status" -eq 0 ]
  [ "$(cat "${work}/destination")" = "platform=iOS Simulator,id=OK-265" ]
}
