#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  PROJECT="${BATS_TEST_TMPDIR}/project"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  CALLER="${BATS_TEST_TMPDIR}/caller"
  mkdir -p "$PROJECT/scripts/ios" "$PROJECT/scripts/lib" "$PROJECT/ios/control-proxy" "$MOCK_BIN" "$CALLER"
  cp "$REPO_ROOT/scripts/ios/build-simulator-runner-release.sh" "$PROJECT/scripts/ios/"
  cp "$REPO_ROOT/scripts/lib/spotlight-exclude.sh" "$PROJECT/scripts/lib/"
  SCRIPT="$PROJECT/scripts/ios/build-simulator-runner-release.sh"
  cat > "$MOCK_BIN/xcodegen" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$PWD $*" >> "$BATS_TEST_TMPDIR/xcodegen.log"
mkdir -p CtrlProxy.xcodeproj
STUB
  # Builds the products of whichever scheme is requested, named as Xcode names them.
  cat > "$MOCK_BIN/xcodebuild" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$BATS_TEST_TMPDIR/xcodebuild.args"
[[ "${RUNNER_TEST_BUILD_FAIL:-}" != 1 ]] || exit 42
while [[ $# -gt 0 ]]; do
  case "$1" in
    -derivedDataPath) derived="$2"; shift ;;
    -scheme) scheme="$2"; shift ;;
  esac
  shift
done
case "$scheme" in
  CtrlProxyWatch) sdk=watchsimulator; ui=CtrlProxyWatchUITests ;;
  AutoMobileVisionTest) sdk=xrsimulator; ui=CtrlProxyVisionUITests ;;
  *) exit 64 ;;
esac
printf '%s\n' "$derived" > "$BATS_TEST_TMPDIR/derived-path"
products="$derived/Build/Products"
mkdir -p "$products/Debug-$sdk/$scheme.app"
runner="$products/Debug-$sdk/$ui-Runner.app"
mkdir -p "$runner/PlugIns/$ui.xctest"
printf 'executable\n' > "$runner/$ui-Runner"
chmod 755 "$runner/$ui-Runner"
[[ "${RUNNER_TEST_MISSING_RUNNER:-}" != 1 ]] || rm -rf "$runner"
if [[ "${RUNNER_TEST_MISSING_XCTESTRUN:-}" != 1 ]]; then
  touch "$products/${scheme}_${sdk}26.5-arm64.xctestrun"
else
  touch "$products/AutoMobileTest_iphonesimulator26.5-arm64.xctestrun"
fi
STUB
  chmod +x "$MOCK_BIN/xcodegen" "$MOCK_BIN/xcodebuild"
  export PATH="$MOCK_BIN:$PATH"
  export GITHUB_OUTPUT="$BATS_TEST_TMPDIR/github-output"
}

assert_packaged() {
  local platform="$1" scheme="$2" destination="$3" sdk="$4" ui="$5"
  run bash -c 'cd "$1" && bash "$2" --platform "$3" --output "artifacts/$3-runner.zip"' _ "$CALLER" "$SCRIPT" "$platform"
  [ "$status" -eq 0 ]
  local archive="$CALLER/artifacts/$platform-runner.zip"
  [ -f "$archive" ]
  local sha
  sha="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
  grep -Fxq "sha256=$sha" "$GITHUB_OUTPUT"
  [[ "$output" == *"sha256=$sha"* ]]
  grep -Fxq "$scheme" "$BATS_TEST_TMPDIR/xcodebuild.args"
  grep -Fxq "$destination" "$BATS_TEST_TMPDIR/xcodebuild.args"
  grep -Fxq 'Debug' "$BATS_TEST_TMPDIR/xcodebuild.args"
  grep -Fxq 'CODE_SIGNING_ALLOWED=NO' "$BATS_TEST_TMPDIR/xcodebuild.args"
  [ "$(head -1 "$BATS_TEST_TMPDIR/xcodebuild.args")" = 'build-for-testing' ]
  grep -Fq "$PROJECT/ios/control-proxy generate" "$BATS_TEST_TMPDIR/xcodegen.log"
  unzip -q "$archive" -d "$BATS_TEST_TMPDIR/unpacked"
  [ -f "$BATS_TEST_TMPDIR/unpacked/Build/Products/${scheme}_${sdk}26.5-arm64.xctestrun" ]
  [ -x "$BATS_TEST_TMPDIR/unpacked/Build/Products/Debug-$sdk/$ui-Runner.app/$ui-Runner" ]
  [ ! -d "$(cat "$BATS_TEST_TMPDIR/derived-path")" ]
}

@test "builds the watchOS scheme and packages products with SHA256 and executable modes" {
  assert_packaged watchos CtrlProxyWatch 'generic/platform=watchOS Simulator' watchsimulator CtrlProxyWatchUITests
}

@test "builds the visionOS scheme and packages products with SHA256 and executable modes" {
  assert_packaged visionos AutoMobileVisionTest 'generic/platform=visionOS Simulator' xrsimulator CtrlProxyVisionUITests
}

@test "defaults the archive name to the platform" {
  mkdir -p "$PROJECT/ios/control-proxy/CtrlProxy.xcodeproj"
  run bash -c 'cd "$1" && bash "$2" --platform watchos' _ "$CALLER" "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -f "$CALLER/watchos-runner-macos.zip" ]
  [ ! -f "$BATS_TEST_TMPDIR/xcodegen.log" ]
}

@test "propagates build failure without publishing or emitting a checksum" {
  export RUNNER_TEST_BUILD_FAIL=1
  run bash "$SCRIPT" --platform visionos --output "$CALLER/runner.zip"
  [ "$status" -eq 42 ]
  [ ! -f "$CALLER/runner.zip" ]
  [ ! -f "$GITHUB_OUTPUT" ]
}

@test "requires the platform's own xctestrun rather than an iOS one" {
  export RUNNER_TEST_MISSING_XCTESTRUN=1
  run bash "$SCRIPT" --platform watchos --output "$CALLER/runner.zip"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Expected one watchsimulator xctestrun"* ]]
  [ ! -f "$CALLER/runner.zip" ]
}

@test "requires the UI-test runner bundle" {
  export RUNNER_TEST_MISSING_RUNNER=1
  run bash "$SCRIPT" --platform visionos --output "$CALLER/runner.zip"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Missing visionOS runner artifact"* ]]
  [ ! -f "$CALLER/runner.zip" ]
}

@test "rejects a missing or unknown platform and an incomplete argument" {
  run bash "$SCRIPT" --output "$CALLER/runner.zip"
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --platform tvos
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" --platform
  [ "$status" -eq 2 ]
  [ ! -f "$BATS_TEST_TMPDIR/xcodebuild.args" ]
}
