#!/usr/bin/env bats

setup() {
  TEST_ROOT="$(mktemp -d)"
  STUB_DIR="$(mktemp -d)"
  SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/scripts/ios/patch-ctrl-proxy-ui-test-runner-icon.sh"
  DERIVED_DATA="${TEST_ROOT}/DerivedData"
  RUNNER_APP="${DERIVED_DATA}/Build/Products/Debug-iphonesimulator/CtrlProxyUITests-Runner.app"
  mkdir -p "${RUNNER_APP}"
  cat > "${RUNNER_APP}/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.jasonpearson.automobile.ctrlproxy.uitests.xctrunner</string></dict></plist>
PLIST

  cat > "${STUB_DIR}/xcrun" <<'STUB'
#!/bin/bash
set -euo pipefail
[[ "$1" == "actool" ]]
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --compile)
      output_directory="$2"
      shift 2
      ;;
    --output-partial-info-plist)
      info_plist="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$output_directory"
touch "$output_directory/Assets.car" "$output_directory/AppIcon60x60@2x.png" "$output_directory/AppIcon76x76@2x~ipad.png"
cat > "$info_plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIcons</key><dict><key>CFBundlePrimaryIcon</key><dict><key>CFBundleIconName</key><string>AppIcon</string></dict></dict></dict></plist>
PLIST
STUB
  cat > "${STUB_DIR}/codesign" <<'STUB'
#!/bin/bash
exit 0
STUB
  cat > "${STUB_DIR}/PlistBuddy" <<'STUB'
#!/bin/bash
set -euo pipefail
[[ "$1" == "-c" ]]
partial_info_plist="${2#Merge }"
partial_info_plist="${partial_info_plist% :}"
runner_info_plist="$3"
python3 - "${partial_info_plist}" "${runner_info_plist}" <<'PY'
import plistlib
import sys

partial_path, runner_path = sys.argv[1:]
with open(partial_path, "rb") as partial_file:
    partial = plistlib.load(partial_file)
with open(runner_path, "rb") as runner_file:
    runner = plistlib.load(runner_file)
runner.update(partial)
with open(runner_path, "wb") as runner_file:
    plistlib.dump(runner, runner_file)
PY
STUB
  cat > "${STUB_DIR}/plutil" <<'STUB'
#!/bin/bash
set -euo pipefail
[[ "$1" == "-replace" ]]
key="$2"
[[ "$3" == "-string" ]]
value="$4"
info_plist="$5"
python3 - "${key}" "${value}" "${info_plist}" <<'PY'
import plistlib
import sys

key, value, info_path = sys.argv[1:]
with open(info_path, "rb") as info_file:
    info = plistlib.load(info_file)
info[key] = value
with open(info_path, "wb") as info_file:
    plistlib.dump(info, info_file)
PY
STUB
  chmod +x "${STUB_DIR}/xcrun" "${STUB_DIR}/codesign" "${STUB_DIR}/PlistBuddy" "${STUB_DIR}/plutil"
}

teardown() {
  rm -rf "${TEST_ROOT}" "${STUB_DIR}"
}

@test "patches the generated runner with CtrlProxy's icon metadata" {
  run env PATH="${STUB_DIR}:$PATH" PLIST_BUDDY="${STUB_DIR}/PlistBuddy" PLUTIL="${STUB_DIR}/plutil" bash "${SCRIPT}" --derived-data "${DERIVED_DATA}"

  [ "$status" -eq 0 ]

  run env PATH="${STUB_DIR}:$PATH" PLIST_BUDDY="${STUB_DIR}/PlistBuddy" PLUTIL="${STUB_DIR}/plutil" bash "${SCRIPT}" --derived-data "${DERIVED_DATA}"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Patched CtrlProxyUITests-Runner"* ]]
  [ -f "${RUNNER_APP}/Assets.car" ]
  [ -f "${RUNNER_APP}/AppIcon60x60@2x.png" ]
  [ -f "${RUNNER_APP}/AppIcon76x76@2x~ipad.png" ]
  python3 - "${RUNNER_APP}/Info.plist" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as info_file:
    info = plistlib.load(info_file)
assert info["CFBundleDisplayName"] == "CtrlProxy"
assert info["CFBundleName"] == "CtrlProxy"
assert info["CFBundleIcons"]["CFBundlePrimaryIcon"]["CFBundleIconName"] == "AppIcon"
PY
}

@test "all maintained CtrlProxy UI-test startup paths use patched build artifacts" {
  local repository_root
  repository_root="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

  run grep -F 'patch-ctrl-proxy-ui-test-runner-icon.sh' "${repository_root}/scripts/ios/ctrl-proxy-build-for-testing.sh"
  [ "$status" -eq 0 ]

  run grep -F 'patch-ctrl-proxy-ui-test-runner-icon.sh' "${repository_root}/scripts/ios/ctrl-proxy-create-ipa.sh"
  [ "$status" -eq 0 ]

  run grep -F 'patch-ctrl-proxy-ui-test-runner-icon.sh' "${repository_root}/scripts/local-dev/lib/ctrl-proxy-ios.sh"
  [ "$status" -eq 0 ]

  run grep -F 'ctrl-proxy-build-for-testing.sh' "${repository_root}/scripts/test-ctrl-proxy-ios.sh"
  [ "$status" -eq 0 ]

  run grep -F 'test-without-building' "${repository_root}/scripts/test-ctrl-proxy-ios.sh"
  [ "$status" -eq 0 ]

  run grep -F '! -name "automobile-runner-*.xctestrun"' "${repository_root}/scripts/test-ctrl-proxy-ios.sh"
  [ "$status" -eq 0 ]

  run grep -F '"*iphonesimulator*.xctestrun"' "${repository_root}/scripts/test-ctrl-proxy-ios.sh"
  [ "$status" -eq 0 ]

  run grep -F 'automobile-runner-${BOOTED_SIMULATOR}.xctestrun' "${repository_root}/scripts/test-ctrl-proxy-ios.sh"
  [ "$status" -eq 0 ]

  run grep -F 'CtrlProxyUITests.EnvironmentVariables.CTRL_PROXY_IOS_PORT' "${repository_root}/scripts/test-ctrl-proxy-ios.sh"
  [ "$status" -eq 0 ]

  run grep -F 'CtrlProxyUITests.EnvironmentVariables.AUTOMOBILE_DEVICE_ID' "${repository_root}/scripts/test-ctrl-proxy-ios.sh"
  [ "$status" -eq 0 ]

  run grep -F 'automobile-runner-${simulator_id}.xctestrun' "${repository_root}/scripts/local-dev/lib/ctrl-proxy-ios.sh"
  [ "$status" -eq 0 ]

  run grep -F 'CtrlProxyUITests.EnvironmentVariables.CTRL_PROXY_IOS_PORT' "${repository_root}/scripts/local-dev/lib/ctrl-proxy-ios.sh"
  [ "$status" -eq 0 ]

  run grep -F 'IOS_RUNNER_PID_FILE' "${repository_root}/scripts/local-dev/lib/ctrl-proxy-ios.sh"
  [ "$status" -eq 0 ]

  run grep -F 'pgrep -f "xcodebuild.*test.*CtrlProxy"' "${repository_root}/scripts/local-dev/lib/ctrl-proxy-ios.sh" "${repository_root}/scripts/local-dev/hot-reload.sh"
  [ "$status" -eq 1 ]

  run grep -E '^[[:space:]]*nohup xcodebuild test([[:space:]]|$)' "${repository_root}/scripts/test-ctrl-proxy-ios.sh"
  [ "$status" -eq 1 ]

  run grep -F 'command -v xcpretty' "${repository_root}/scripts/ios/ctrl-proxy-build-for-testing.sh"
  [ "$status" -eq 0 ]

  run grep -F 'BUILD_STATUSES=("${PIPESTATUS[@]}")' "${repository_root}/scripts/ios/ctrl-proxy-build-for-testing.sh"
  [ "$status" -eq 0 ]

  run grep -E 'xcpretty --color.*\|\| true' "${repository_root}/scripts/ios/ctrl-proxy-build-for-testing.sh"
  [ "$status" -eq 1 ]
}
