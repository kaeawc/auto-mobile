#!/usr/bin/env bats
#
# Pins how scripts/ios/setup-ios-simulator.sh picks its Xcode, runtime and
# simulator (#18812). xcrun, xcodebuild and rg are stubs: `simctl list ... --json`
# returns the runtime and device JSON each test writes (same keys as a real
# capture), so this runs on any host with no Xcode and boots nothing.
#
# The runner host has the general iOS-27-2 runtime next to iOS-27-2-iPhone19-4
# (iPhone Duo only, also listed as "iOS 27.2") and iOS-27-1 (Duo only). The old
# text parser could not tell them apart.

setup() {
  work="$(mktemp -d)"
  mkdir -p "${work}/bin"
  script="$BATS_TEST_DIRNAME/../../scripts/ios/setup-ios-simulator.sh"

  cat > "${work}/bin/xcrun" << 'STUB'
#!/bin/bash
case "$*" in
  "simctl list runtimes iOS --json") cat "${STUB_DIR}/runtimes.json" ;;
  "simctl list devices --json") cat "${STUB_DIR}/devices.json" ;;
  *) echo "unexpected xcrun $*" >&2; exit 2 ;;
esac
STUB
  # Reports the Xcode that DEVELOPER_DIR names (27.2 when it is the 27.2 bundle).
  cat > "${work}/bin/xcodebuild" << 'STUB'
#!/bin/bash
version=26.6
[[ "${DEVELOPER_DIR:-}" == *"27.2"* ]] && version=27.2
sdk="${version}"
[[ "${version}" == 26.6 ]] && sdk=26.5
case "$1" in
  -version) printf 'Xcode %s\nBuild version 00X000\n' "${version}" ;;
  -showsdks) printf 'iOS Simulator SDKs:\n\tSimulator - iOS %s\t-sdk iphonesimulator%s\n' "${sdk}" "${sdk}" ;;
  *) echo "unexpected xcodebuild $*" >&2; exit 2 ;;
esac
STUB
  printf '#!/bin/bash\nexit 1\n' > "${work}/bin/rg"
  chmod +x "${work}/bin/xcrun" "${work}/bin/xcodebuild" "${work}/bin/rg"
}

teardown() {
  rm -rf "${work}"
}

iphone_types='[
  {"name": "iPhone 16", "productFamily": "iPhone", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16"},
  {"name": "iPhone 17 Pro", "productFamily": "iPhone", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}
]'
duo_types='[{"name": "iPhone Duo", "productFamily": "iPhone", "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-19-4"}]'

runtime() {
  # runtime VERSION IDENTIFIER_SUFFIX DEVICE_TYPES_JSON
  printf '{"isAvailable": true, "version": "%s", "name": "iOS %s", "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-%s", "platform": "iOS", "supportedArchitectures": ["arm64"], "supportedDeviceTypes": %s}' \
    "$1" "$1" "$2" "$3"
}

device() {
  # device UDID NAME TYPE_SUFFIX STATE
  printf '{"udid": "%s", "isAvailable": true, "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.%s", "state": "%s", "name": "%s"}' \
    "$1" "$3" "$4" "$2"
}

# The runner host's iOS runtimes and one simulator per runtime.
write_host_json() {
  printf '%s\n' "{\"runtimes\": [$(runtime 26.5 26-5 "${iphone_types}"), $(runtime 27.1 27-1 "${duo_types}"), $(runtime 27.2 27-2-iPhone19-4 "${duo_types}"), $(runtime 27.2 27-2 "${iphone_types}")]}" > "${work}/runtimes.json"
  printf '%s\n' "{\"devices\": {
    \"com.apple.CoreSimulator.SimRuntime.iOS-26-5\": [$(device OLD-265 'iPhone 16' iPhone-16 Shutdown)],
    \"com.apple.CoreSimulator.SimRuntime.iOS-27-1\": [$(device DUO-271 'iPhone Duo' iPhone-19-4 Shutdown)],
    \"com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4\": [$(device DUO-272 'iPhone Duo' iPhone-19-4 Booted)],
    \"com.apple.CoreSimulator.SimRuntime.iOS-27-2\": [$(device PHONE-272 'iPhone 17 Pro' iPhone-17-Pro Shutdown)]}}" > "${work}/devices.json"
}

run_setup() {
  run env "$@" PATH="${work}/bin:${PATH}" STUB_DIR="${work}" \
    bash "${script}" --dry-run --skip-download --min-ios 17.0
}

@test "on a 27.2 SDK picks the general iOS-27-2 runtime and an iPhone on it, never the Duo runtime" {
  write_host_json

  run_setup DEVELOPER_DIR=/stub/Xcode-27.2.0.app/Contents/Developer

  [ "$status" -eq 0 ]
  [[ "$output" == *"Found compatible iOS runtime: iOS 27.2 (com.apple.CoreSimulator.SimRuntime.iOS-27-2)"* ]]
  [[ "$output" == *"-destination 'platform=iOS Simulator,id=PHONE-272'"* ]]
  [[ "$output" != *"DUO-"* ]]
}

@test "with only the Duo runtimes at 27.x falls back to the newest general runtime in range" {
  printf '%s\n' "{\"runtimes\": [$(runtime 26.5 26-5 "${iphone_types}"), $(runtime 27.2 27-2-iPhone19-4 "${duo_types}")]}" > "${work}/runtimes.json"
  printf '%s\n' "{\"devices\": {
    \"com.apple.CoreSimulator.SimRuntime.iOS-26-5\": [$(device OLD-265 'iPhone 16' iPhone-16 Shutdown)],
    \"com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4\": [$(device DUO-272 'iPhone Duo' iPhone-19-4 Booted)]}}" > "${work}/devices.json"

  run_setup DEVELOPER_DIR=/stub/Xcode-27.2.0.app/Contents/Developer

  [ "$status" -eq 0 ]
  [[ "$output" == *"iOS 26.5 (com.apple.CoreSimulator.SimRuntime.iOS-26-5)"* ]]
  [[ "$output" == *"platform=iOS Simulator,id=OLD-265"* ]]
}

@test "a runtime newer than the selected Xcode's SDK is not picked" {
  write_host_json

  # Xcode 26.6 (SDK 26.5) chosen explicitly: the 27.x runtimes cannot run its builds.
  run_setup DEVELOPER_DIR=/stub/Xcode.app/Contents/Developer

  [ "$status" -eq 0 ]
  [[ "$output" == *"iOS 26.5 (com.apple.CoreSimulator.SimRuntime.iOS-26-5)"* ]]
  [[ "$output" == *"platform=iOS Simulator,id=OLD-265"* ]]
}

@test "with xcode-select on Xcode 26.6 selects the installed pinned Xcode via DEVELOPER_DIR" {
  write_host_json
  # shellcheck source=scripts/ios/xcode_version.sh
  source "$BATS_TEST_DIRNAME/../../scripts/ios/xcode_version.sh"
  local apps="${work}/Applications" pin="${AUTOMOBILE_XCODE_VERSION}"
  mkdir -p "${apps}/Xcode.app/Contents/Developer" "${apps}/Xcode-${pin}.0.app/Contents/Developer"
  printf '26.6' > "${apps}/Xcode.app/Contents/version.plist"
  printf '%s' "${pin}" > "${apps}/Xcode-${pin}.0.app/Contents/version.plist"
  printf '#!/bin/bash\necho %q\n' "${apps}/Xcode.app/Contents/Developer" > "${work}/bin/xcode-select"
  printf '#!/bin/bash\ncat "${@: -1}"\n' > "${work}/bin/plutil"
  chmod +x "${work}/bin/xcode-select" "${work}/bin/plutil"

  run_setup -u DEVELOPER_DIR XCODE_APPLICATIONS_DIR="${apps}"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Xcode path: ${apps}/Xcode-${pin}.0.app/Contents/Developer"* ]]
  [[ "$output" == *"platform=iOS Simulator,id=PHONE-272"* ]]
}

@test "reports no runtime and stops at --skip-download when none is usable" {
  printf '%s\n' "{\"runtimes\": [$(runtime 27.2 27-2-iPhone19-4 "${duo_types}")]}" > "${work}/runtimes.json"
  printf '%s\n' '{"devices": {}}' > "${work}/devices.json"

  run_setup DEVELOPER_DIR=/stub/Xcode-27.2.0.app/Contents/Developer

  [ "$status" -eq 1 ]
  [[ "$output" == *"No compatible iOS runtime found (need >= 17.0, <= 27.2)"* ]]
  [[ "$output" == *"Download skipped (--skip-download flag)"* ]]
}
