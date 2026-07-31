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
  chmod +x "${STUB_DIR}/xcrun" "${STUB_DIR}/codesign"
}

teardown() {
  rm -rf "${TEST_ROOT}" "${STUB_DIR}"
}

@test "patches the generated runner with CtrlProxy's icon metadata" {
  run env PATH="${STUB_DIR}:$PATH" bash "${SCRIPT}" --derived-data "${DERIVED_DATA}"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Patched CtrlProxyUITests-Runner"* ]]
  [ -f "${RUNNER_APP}/Assets.car" ]
  [ -f "${RUNNER_APP}/AppIcon60x60@2x.png" ]
  [ -f "${RUNNER_APP}/AppIcon76x76@2x~ipad.png" ]
  [ "$(plutil -extract CFBundleDisplayName raw "${RUNNER_APP}/Info.plist")" = "CtrlProxy" ]
  [ "$(plutil -extract CFBundleName raw "${RUNNER_APP}/Info.plist")" = "CtrlProxy" ]
  [ "$(plutil -extract CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconName raw "${RUNNER_APP}/Info.plist")" = "AppIcon" ]
}

@test "all maintained CtrlProxy build paths patch the generated runner" {
  local repository_root
  repository_root="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

  run grep -F 'patch-ctrl-proxy-ui-test-runner-icon.sh' "${repository_root}/scripts/ios/ctrl-proxy-build-for-testing.sh"
  [ "$status" -eq 0 ]

  run grep -F 'patch-ctrl-proxy-ui-test-runner-icon.sh' "${repository_root}/scripts/ios/ctrl-proxy-create-ipa.sh"
  [ "$status" -eq 0 ]

  run grep -F 'patch-ctrl-proxy-ui-test-runner-icon.sh' "${repository_root}/scripts/local-dev/lib/ctrl-proxy-ios.sh"
  [ "$status" -eq 0 ]
}
