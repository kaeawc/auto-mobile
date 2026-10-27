#!/usr/bin/env bats
# Isolated build fixture: Apple compiler/signing tools are mocked, plist parsing is structural.
setup() {
  export AUTOMOBILE_SPOTLIGHT_EXCLUDE_FORCE=1
  unset AUTOMOBILE_SPOTLIGHT_EXCLUDE
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  FIXTURE="${BATS_TEST_TMPDIR}/repo"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${FIXTURE}/scripts/ios" "${MOCK_BIN}" \
    "${FIXTURE}/ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore" \
    "${FIXTURE}/ios/prototype-agent/Sources/AutoMobilePrototypeAgent" \
    "${FIXTURE}/ios/prototype-agent/ProtoViewer" "${FIXTURE}/ios/prototype-agent/Viewer"
  cp "${REPO_ROOT}/scripts/ios/protoviewer-build.sh" "${FIXTURE}/scripts/ios/"
  cp "${REPO_ROOT}/ios/prototype-agent/ProtoViewer/Info.plist" \
    "${REPO_ROOT}/ios/prototype-agent/ProtoViewer/PrivacyInfo.xcprivacy" "${FIXTURE}/ios/prototype-agent/ProtoViewer/"
  cp "${REPO_ROOT}/ios/prototype-agent/ProtoViewer/"*.xcstrings "${FIXTURE}/ios/prototype-agent/ProtoViewer/"
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
elif [[ "$1 ${2:-}" == 'xcstringstool compile' ]]; then
  [[ -s "$3" && "$4" == --output-directory ]]
  mkdir -p "$5/en.lproj"
  touch "$5/en.lproj/$(basename "$3" .xcstrings).strings"
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
  mkdir -p "${FIXTURE}/scripts/lib"
  cp "${REPO_ROOT}/scripts/lib/spotlight-exclude.sh" "${FIXTURE}/scripts/lib/"
  unset PROTOVIEWER_CLEARTEXT
  SCRIPT="${FIXTURE}/scripts/ios/protoviewer-build.sh"
  OUT="${BATS_TEST_TMPDIR}/out space"
}

@test "builds both simulator slices and signs the separate ProtoViewer app" {
  run bash "$SCRIPT" "$OUT"
  [ "$status" -eq 0 ]
  # Caller-owned output outside the fixture repo must remain searchable.
  [ ! -e "$OUT/.metadata_never_index" ]
  [ -s "$OUT/ProtoViewer.app/ProtoViewer" ]
  # The privacy manifest ships at the bundle root (#14151).
  cmp "$FIXTURE/ios/prototype-agent/ProtoViewer/PrivacyInfo.xcprivacy" "$OUT/ProtoViewer.app/PrivacyInfo.xcprivacy"
  [[ "$output" == *'/ProtoViewer.app'* ]]
  run cat "$BUILD_LOG"
  [[ "$output" == *'arm64-apple-ios17.0-simulator'* ]]
  [[ "$output" == *'x86_64-apple-ios17.0-simulator'* ]]
  [[ "$output" == *'-verify_arch arm64 x86_64'* ]]
  [[ "$output" == *'--force --sign - '* ]]
}

@test "plist declares prototype and JSON imports without ATS file sharing or compiled icon keys" {
  run python3 - "$FIXTURE/ios/prototype-agent/ProtoViewer/Info.plist" <<'PY'
import plistlib
import sys
with open(sys.argv[1], 'rb') as source:
    value = plistlib.load(source)
assert value['CFBundleIdentifier'] == 'dev.jasonpearson.automobile.protoviewer'
assert value['CFBundleDisplayName'] == value['CFBundleName'] == value['CFBundleExecutable'] == 'ProtoViewer'
assert value['LSSupportsOpeningDocumentsInPlace'] is False
assert value['NSLocalNetworkUsageDescription'] == ('Used only when you allow network for imported prototypes, '
    'to reach devices on your local network.')
assert 'NSBonjourServices' not in value
uti = 'dev.jasonpearson.automobile.prototype'
declaration, = value['UTExportedTypeDeclarations']
assert declaration['UTTypeIdentifier'] == uti
assert set(declaration['UTTypeConformsTo']) == {'public.data', 'public.zip-archive'}
assert declaration['UTTypeTagSpecification'] == {
    'public.filename-extension': ['automobile-proto'],
    'public.mime-type': 'application/vnd.automobile.prototype+zip',
}
document, = value['CFBundleDocumentTypes']
assert document['CFBundleTypeRole'] == 'Viewer'
assert document['LSHandlerRank'] == 'Alternate'
assert set(document['LSItemContentTypes']) == {uti, 'public.json'}
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

@test "ProtoViewer and Viewer plists run natively on iPad with every orientation (#15431)" {
  run python3 - "${REPO_ROOT}/ios/prototype-agent/ProtoViewer/Info.plist" \
    "${REPO_ROOT}/ios/prototype-agent/Viewer/Info.plist" <<'PY'
import plistlib
import re
import sys
orientations = {
    'UIInterfaceOrientationPortrait',
    'UIInterfaceOrientationPortraitUpsideDown',
    'UIInterfaceOrientationLandscapeLeft',
    'UIInterfaceOrientationLandscapeRight',
}
for path in sys.argv[1:]:
    with open(path, 'rb') as source:
        # The Viewer template's stamping comment contains `--` flags, which expat rejects.
        value = plistlib.loads(re.sub(rb'<!--.*?-->', b'', source.read(), flags=re.S))
    assert value['UIDeviceFamily'] == [1, 2], path
    assert set(value['UISupportedInterfaceOrientations~ipad']) == orientations, path
    assert len(value['UISupportedInterfaceOrientations~ipad']) == 4, path
    # iPhone orientations stay unchanged: no upside-down on the phone.
    assert 'UIInterfaceOrientationPortraitUpsideDown' not in value['UISupportedInterfaceOrientations'], path
    assert value['UIApplicationSceneManifest']['UIApplicationSupportsMultipleScenes'] is False, path
    assert 'UIRequiresFullScreen' not in value, path
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

@test "only the dev ProtoViewer compile path enables cleartext by default" {
  run bash "$SCRIPT" "$OUT"
  [ "$status" -eq 0 ]
  run python3 - "$BUILD_LOG" "$REPO_ROOT/scripts/ios" <<'PY'
from pathlib import Path
import sys
lines = Path(sys.argv[1]).read_text().splitlines()
compiles = [line for line in lines if ' swiftc ' in line]
assert len(compiles) == 2
assert all('-D PROTOVIEWER_ALLOW_CLEARTEXT' in line for line in compiles)
assert all('PROTOVIEWER_ALLOW_CLEARTEXT' not in line for line in lines if line not in compiles)
# Agent, MCP-direct viewer and release entry points must not gain the dev opt-in.
for path in Path(sys.argv[2]).glob('*.sh'):
    if path.name != 'protoviewer-build.sh':
        assert 'PROTOVIEWER_ALLOW_CLEARTEXT' not in path.read_text(), path
PY
  [ "$status" -eq 0 ]
}

@test "omits the cleartext define when PROTOVIEWER_CLEARTEXT is 0" {
  PROTOVIEWER_CLEARTEXT=0 run bash "$SCRIPT" "$OUT"
  [ "$status" -eq 0 ]
  run cat "$BUILD_LOG"
  [[ "$output" == *' swiftc '* ]]
  [[ "$output" != *'PROTOVIEWER_ALLOW_CLEARTEXT'* ]]
}

@test "compiles both string catalogs into localized bundle resources" {
  run bash "$SCRIPT" "$OUT"
  [ "$status" -eq 0 ]
  [ -f "$OUT/ProtoViewer.app/en.lproj/Localizable.strings" ]
  [ -f "$OUT/ProtoViewer.app/en.lproj/InfoPlist.strings" ]
  run cat "$BUILD_LOG"
  [[ "$output" == *'xcstringstool compile '*'Localizable.xcstrings --output-directory'* ]]
  [[ "$output" == *'xcstringstool compile '*'InfoPlist.xcstrings --output-directory'* ]]
}

@test "rejects stray root InfoPlist strings and compiled assets" {
  mkdir -p "$OUT/ProtoViewer.app"
  touch "$OUT/ProtoViewer.app/InfoPlist.strings"
  run bash "$SCRIPT" "$OUT"
  [ "$status" -ne 0 ]
  rm "$OUT/ProtoViewer.app/InfoPlist.strings"
  mkdir -p "$OUT/ProtoViewer.app/stray"
  touch "$OUT/ProtoViewer.app/stray/InfoPlist.strings"
  run bash "$SCRIPT" "$OUT"
  [ "$status" -ne 0 ]
  rm "$OUT/ProtoViewer.app/stray/InfoPlist.strings"
  mkdir -p "$OUT/ProtoViewer.app/en.lproj"
  touch "$OUT/ProtoViewer.app/en.lproj/Assets.car"
  run bash "$SCRIPT" "$OUT"
  [ "$status" -ne 0 ]
}
