#!/usr/bin/env bats
# Isolated build fixture: Apple compiler/signing tools are mocked, plist parsing is structural.
setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  FIXTURE="${BATS_TEST_TMPDIR}/repo"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${FIXTURE}/scripts/ios" "${MOCK_BIN}" \
    "${FIXTURE}/ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore" \
    "${FIXTURE}/ios/prototype-agent/Sources/AutoMobilePrototypeAgent" \
    "${FIXTURE}/ios/prototype-agent/ProtoViewer" "${FIXTURE}/ios/prototype-agent/Viewer"
  cp "${REPO_ROOT}/scripts/ios/protoviewer-build.sh" "${FIXTURE}/scripts/ios/"
  cp "${REPO_ROOT}/ios/prototype-agent/ProtoViewer/Info.plist" "${FIXTURE}/ios/prototype-agent/ProtoViewer/"
  touch "${FIXTURE}/ios/prototype-agent/ProtoViewer/ProtoViewerApp.swift" \
    "${FIXTURE}/ios/prototype-agent/Viewer/ViewerApp.swift" \
    "${FIXTURE}/ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/Core.swift" \
    "${FIXTURE}/ios/prototype-agent/Sources/AutoMobilePrototypeAgent/Agent.swift"
  export BUILD_LOG="${BATS_TEST_TMPDIR}/build.log"
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$BUILD_LOG"
if [[ "$*" == '--sdk iphonesimulator --show-sdk-path' ]]; then
  echo /fake/sdk
elif [[ "$3" == swiftc ]]; then
  [[ "$*" == *'-swift-version 6 -warnings-as-errors'* ]]
  [[ "$*" == *'/ProtoViewer/ProtoViewerApp.swift'* ]]
  [[ "$*" != *'/Viewer/ViewerApp.swift'* && "$*" != *'Loader.c'* ]]
  [[ "${BUILD_TEST_FAILURE:-}" != compiler ]] || exit 1
  while [[ "$1" != -o ]]; do shift; done
  printf 'slice\n' > "$2"
else
  [[ "$1 $2 $3" == '--sdk macosx swift' ]]
  app="${!#}"
  touch "$app/ProtoViewerIcon60x60@2x.png" "$app/ProtoViewerIcon60x60@3x.png"
fi
SCRIPT
  cat > "${MOCK_BIN}/lipo" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$BUILD_LOG"
if [[ "$1" == -create ]]; then
  while [[ "$1" != -output ]]; do shift; done
  printf 'universal\n' > "$2"
else
  [[ "$2" == -verify_arch ]]
fi
SCRIPT
  cat > "${MOCK_BIN}/plutil" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == -replace || "$1" == -lint ]]
SCRIPT
  cat > "${MOCK_BIN}/codesign" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$BUILD_LOG"
[[ "$1 $2 $3 $4" == '--force --sign - '* ]]
SCRIPT
  chmod +x "${MOCK_BIN}/"{xcrun,lipo,plutil,codesign}
  export PATH="${MOCK_BIN}:${PATH}"
  SCRIPT="${FIXTURE}/scripts/ios/protoviewer-build.sh"
  OUT="${BATS_TEST_TMPDIR}/out space"
}

@test "builds both simulator slices and signs the separate ProtoViewer app" {
  run bash "$SCRIPT" "$OUT"
  [ "$status" -eq 0 ]
  [ -s "$OUT/ProtoViewer.app/ProtoViewer" ]
  [[ "$output" == *'/ProtoViewer.app'* ]]
  run cat "$BUILD_LOG"
  [[ "$output" == *'arm64-apple-ios17.0-simulator'* ]]
  [[ "$output" == *'x86_64-apple-ios17.0-simulator'* ]]
  [[ "$output" == *'-verify_arch arm64 x86_64'* ]]
  [[ "$output" == *'--force --sign - '* ]]
}

@test "plist has the exact app identity and no ATS file sharing or compiled icon key" {
  run python3 - "$FIXTURE/ios/prototype-agent/ProtoViewer/Info.plist" <<'PY'
import plistlib
import sys
with open(sys.argv[1], 'rb') as source:
    value = plistlib.load(source)
assert value['CFBundleIdentifier'] == 'dev.jasonpearson.automobile.protoviewer'
assert value['CFBundleDisplayName'] == value['CFBundleName'] == value['CFBundleExecutable'] == 'ProtoViewer'
def check(value):
    if isinstance(value, dict):
        assert not {'NSAppTransportSecurity', 'UIFileSharingEnabled', 'CFBundleIconName'} & value.keys()
        for item in value.values():
            check(item)
    elif isinstance(value, list):
        for item in value:
            check(item)
check(value)
PY
  [ "$status" -eq 0 ]
}

@test "rejects unsupported architectures before compilation" {
  PROTOVIEWER_ARCHS=mips run bash "$SCRIPT" "$OUT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'Unsupported simulator architecture: mips'* ]]
}

@test "propagates compiler failure without signing an app" {
  BUILD_TEST_FAILURE=compiler run bash "$SCRIPT" "$OUT"
  [ "$status" -ne 0 ]
  run cat "$BUILD_LOG"
  [[ "$output" != *'--force --sign'* ]]
}

@test "supports an explicit simulator architecture" {
  PROTOVIEWER_ARCHS=arm64 run bash "$SCRIPT" "$OUT"
  [ "$status" -eq 0 ]
  run cat "$BUILD_LOG"
  [[ "$output" != *'x86_64-apple'* ]]
  [[ "$output" == *'-verify_arch arm64'* ]]
}
