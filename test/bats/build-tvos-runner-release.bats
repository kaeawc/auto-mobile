#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  PROJECT="${BATS_TEST_TMPDIR}/project"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  CALLER="${BATS_TEST_TMPDIR}/caller"
  mkdir -p "$PROJECT/scripts/ios" "$PROJECT/scripts/lib" "$PROJECT/ios/control-proxy" "$MOCK_BIN" "$CALLER"
  cp "$REPO_ROOT/scripts/ios/build-tvos-runner-release.sh" "$PROJECT/scripts/ios/"
  cp "$REPO_ROOT/scripts/lib/spotlight-exclude.sh" "$PROJECT/scripts/lib/"
  SCRIPT="$PROJECT/scripts/ios/build-tvos-runner-release.sh"
  cat > "$MOCK_BIN/xcodegen" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$PWD $*" >> "$BATS_TEST_TMPDIR/xcodegen.log"
mkdir -p CtrlProxy.xcodeproj
STUB
  cat > "$MOCK_BIN/xcodebuild" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$BATS_TEST_TMPDIR/xcodebuild.args"
[[ "${TVOS_TEST_BUILD_FAIL:-}" != 1 ]] || exit 42
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -derivedDataPath ]]; then derived="$2"; break; fi
  shift
done
printf '%s\n' "$derived" > "$BATS_TEST_TMPDIR/derived-path"
products="$derived/Build/Products"
mkdir -p "$products/Debug-appletvsimulator/AutoMobileTVTest.app"
runner="$products/Debug-appletvsimulator/CtrlProxyTVUITests-Runner.app"
mkdir -p "$runner/PlugIns/CtrlProxyTVUITests.xctest"
printf 'executable\n' > "$runner/CtrlProxyTVUITests-Runner"
chmod 755 "$runner/CtrlProxyTVUITests-Runner"
[[ "${TVOS_TEST_MISSING_RUNNER:-}" != 1 ]] || rm -rf "$runner"
if [[ "${TVOS_TEST_MISSING_XCTESTRUN:-}" != 1 ]]; then
  touch "$products/AutoMobileTVTest_appletvsimulator26.5-arm64.xctestrun"
else
  touch "$products/AutoMobileTest_iphonesimulator26.5-arm64.xctestrun"
fi
STUB
  chmod +x "$MOCK_BIN/xcodegen" "$MOCK_BIN/xcodebuild"
  export PATH="$MOCK_BIN:$PATH"
  export GITHUB_OUTPUT="$BATS_TEST_TMPDIR/github-output"
}

@test "builds the tvOS scheme and packages products with SHA256 and executable modes" {
  run bash -c 'cd "$1" && bash "$2" --output artifacts/tvos-runner.zip' _ "$CALLER" "$SCRIPT"
  [ "$status" -eq 0 ]
  local archive="$CALLER/artifacts/tvos-runner.zip"
  [ -f "$archive" ]
  local sha
  sha="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
  grep -Fxq "sha256=$sha" "$GITHUB_OUTPUT"
  [[ "$output" == *"sha256=$sha"* ]]
  grep -Fxq 'AutoMobileTVTest' "$BATS_TEST_TMPDIR/xcodebuild.args"
  grep -Fxq 'generic/platform=tvOS Simulator' "$BATS_TEST_TMPDIR/xcodebuild.args"
  grep -Fxq 'Debug' "$BATS_TEST_TMPDIR/xcodebuild.args"
  grep -Fxq 'CODE_SIGNING_ALLOWED=NO' "$BATS_TEST_TMPDIR/xcodebuild.args"
  [ "$(head -1 "$BATS_TEST_TMPDIR/xcodebuild.args")" = 'build-for-testing' ]
  grep -Fq "$PROJECT/ios/control-proxy generate" "$BATS_TEST_TMPDIR/xcodegen.log"
  unzip -q "$archive" -d "$BATS_TEST_TMPDIR/unpacked"
  [ -x "$BATS_TEST_TMPDIR/unpacked/Build/Products/Debug-appletvsimulator/CtrlProxyTVUITests-Runner.app/CtrlProxyTVUITests-Runner" ]
  [ ! -d "$(cat "$BATS_TEST_TMPDIR/derived-path")" ]
}

@test "does not regenerate an existing project" {
  mkdir -p "$PROJECT/ios/control-proxy/CtrlProxy.xcodeproj"
  run bash "$SCRIPT" --output "$CALLER/runner.zip"
  [ "$status" -eq 0 ]
  [ ! -f "$BATS_TEST_TMPDIR/xcodegen.log" ]
}

@test "propagates build failure without publishing or emitting a checksum" {
  export TVOS_TEST_BUILD_FAIL=1
  run bash "$SCRIPT" --output "$CALLER/runner.zip"
  [ "$status" -eq 42 ]
  [ ! -f "$CALLER/runner.zip" ]
  [ ! -f "$GITHUB_OUTPUT" ]
}

@test "requires an appletvsimulator xctestrun rather than an iOS one" {
  export TVOS_TEST_MISSING_XCTESTRUN=1
  run bash "$SCRIPT" --output "$CALLER/runner.zip"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Expected one appletvsimulator xctestrun"* ]]
  [ ! -f "$CALLER/runner.zip" ]
}

@test "requires the CtrlProxyTVUITests runner bundle" {
  export TVOS_TEST_MISSING_RUNNER=1
  run bash "$SCRIPT" --output "$CALLER/runner.zip"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Missing tvOS runner artifact"* ]]
  [ ! -f "$CALLER/runner.zip" ]
}

@test "rejects an incomplete output argument" {
  run bash "$SCRIPT" --output
  [ "$status" -eq 2 ]
}
