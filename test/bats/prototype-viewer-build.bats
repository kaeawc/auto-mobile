#!/usr/bin/env bats
# Build orchestration only: Apple compiler, icon generation and signing are stubbed.
setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  FIXTURE="${BATS_TEST_TMPDIR}/repo space"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${FIXTURE}/scripts/ios" "${FIXTURE}/scripts/lib" "${MOCK_BIN}" \
    "${FIXTURE}/ios/prototype-agent/Viewer" \
    "${FIXTURE}/ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore" \
    "${FIXTURE}/ios/prototype-agent/Sources/AutoMobilePrototypeAgent"
  cp "${REPO_ROOT}/scripts/ios/prototype-viewer-build.sh" "${FIXTURE}/scripts/ios/"
  cp "${REPO_ROOT}/scripts/lib/spotlight-exclude.sh" "${REPO_ROOT}/scripts/lib/lipo-verify-arch.sh" "${FIXTURE}/scripts/lib/"
  cp "${REPO_ROOT}/ios/prototype-agent/Viewer/Info.plist" \
    "${REPO_ROOT}/ios/prototype-agent/Viewer/Viewer.entitlements" "${FIXTURE}/ios/prototype-agent/Viewer/"
  touch "${FIXTURE}/ios/prototype-agent/Viewer/ViewerApp.swift"
  export BUILD_LOG="${BATS_TEST_TMPDIR}/build.log"
  export LINKED_ENTITLEMENTS="${BATS_TEST_TMPDIR}/linked.entitlements"
  export CODESIGN_TARGET_LOG="${BATS_TEST_TMPDIR}/codesign-target.log"
  export VIEWER_ENTITLEMENTS="${FIXTURE}/ios/prototype-agent/Viewer/Viewer.entitlements"
  cat > "${FIXTURE}/scripts/ios/prototype-effects-metallib.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1"
touch "$1/PrototypeEffectsMetallib.swift"
echo "$1/PrototypeEffectsMetallib.swift"
SCRIPT
  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == '--sdk iphonesimulator --show-sdk-path' ]]; then
  echo /fake/sdk
elif [[ "$1 $2 $3" == '--sdk iphonesimulator swiftc' ]]; then
  printf '%s\n' "$*" >> "$BUILD_LOG"
  # Check individual arguments, including a plist path containing spaces.
  while [[ "$1" != -Xlinker ]]; do shift; done
  [[ "$1 $2 $3 $4 $5 $6 $7" == '-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements -Xlinker' ]]
  [[ "$8" == "$VIEWER_ENTITLEMENTS" && -s "$8" ]]
  cp "$8" "$LINKED_ENTITLEMENTS"
  while [[ "$1" != -o ]]; do shift; done
  printf 'slice\n' > "$2"
else
  [[ "$1 $2 $3" == '--sdk macosx swift' ]]
fi
SCRIPT
  cat > "${MOCK_BIN}/lipo" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == -create ]]; then
  while [[ "$1" != -output ]]; do shift; done
  printf 'universal\n' > "$2"
else
  [[ "$2" == -verify_arch && $# -eq 3 ]]
fi
SCRIPT
  cat > "${MOCK_BIN}/plutil" <<'SCRIPT'
#!/usr/bin/env bash
[[ "$1" == -replace || "$1" == -lint ]]
SCRIPT
  cat > "${MOCK_BIN}/codesign" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
# Entitlements must be linked, never supplied to codesign.
[[ $# -eq 4 && "$1 $2 $3" == '--force --sign -' ]]
# The target must be the completed bundle: binary and Info.plist already in place.
[[ -d "$4" && -s "$4/PrototypeViewer" && -s "$4/Info.plist" ]]
printf '%s\n' "$4" >> "$CODESIGN_TARGET_LOG"
printf 'codesign %s\n' "$*" >> "$BUILD_LOG"
SCRIPT
  chmod +x "${FIXTURE}/scripts/ios/prototype-effects-metallib.sh" "${MOCK_BIN}/"*
  export PATH="${MOCK_BIN}:${PATH}"
  unset PROTOTYPE_VIEWER_ARCHS PROTOTYPE_VIEWER_MIN_IOS
}

@test "links simulator Keychain entitlements into every viewer slice before plain ad-hoc signing" {
  run bash "${FIXTURE}/scripts/ios/prototype-viewer-build.sh" "${BATS_TEST_TMPDIR}/out space"
  [ "$status" -eq 0 ]
  [ -s "${BATS_TEST_TMPDIR}/out space/PrototypeViewer.app/PrototypeViewer" ]
  [ "$(grep -c 'iphonesimulator swiftc' "$BUILD_LOG")" -eq 2 ]
  for arch in arm64 x86_64; do
    run grep -F -- "-target ${arch}-apple-ios17.0-simulator" "$BUILD_LOG"
    [ "$status" -eq 0 ]
    [[ "$output" == *"-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements -Xlinker ${VIEWER_ENTITLEMENTS}"* ]]
  done
  run tail -n 1 "$BUILD_LOG"
  [[ "$output" == 'codesign --force --sign - '* ]]
  [ "$(cat "$CODESIGN_TARGET_LOG")" == "${BATS_TEST_TMPDIR}/out space/PrototypeViewer.app" ]
}

@test "linked entitlements name the viewer bundle as application id and first keychain access group" {
  run bash "${FIXTURE}/scripts/ios/prototype-viewer-build.sh" "${BATS_TEST_TMPDIR}/out space"
  [ "$status" -eq 0 ]
  run python3 - "$LINKED_ENTITLEMENTS" <<'PY'
import plistlib, sys
entitlements = plistlib.load(open(sys.argv[1], "rb"))
groups = entitlements["keychain-access-groups"]
print(entitlements["application-identifier"], groups[0], len(groups))
PY
  [ "$status" -eq 0 ]
  # Matches the template's CFBundleIdentifier, the Keychain group the viewer writes to.
  [ "$output" == "dev.jasonpearson.automobile.prototype-viewer dev.jasonpearson.automobile.prototype-viewer 1" ]
  grep -F '<key>CFBundleIdentifier</key><string>dev.jasonpearson.automobile.prototype-viewer</string>' \
    "${FIXTURE}/ios/prototype-agent/Viewer/Info.plist"
}
