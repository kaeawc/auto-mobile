#!/usr/bin/env bats
#
# Pins the optional project-name filter of scripts/ios/xcode-build.sh, which lets
# CI shard the two Xcode projects (Playground, CtrlProxy) one per macOS runner so
# the required "iOS Build" leg builds them in parallel. The dry-run path
# (XCODE_BUILD_DRY_RUN=1) prints the selected projects without invoking xcodebuild,
# so this runs on any host — no Xcode required. Mirrors xcode-test-project-filter.bats.

setup() {
  ios_dir="$(mktemp -d)"
  mkdir -p "$ios_dir/Playground/Playground.xcodeproj"
  mkdir -p "$ios_dir/control-proxy/CtrlProxy.xcodeproj"
  script="$BATS_TEST_DIRNAME/../../scripts/ios/xcode-build.sh"
}

teardown() {
  rm -rf "$ios_dir"
}

# Run the real build path entirely against recording stubs. The pinned version
# and adjacent templates make install-xcodegen.sh a no-op before any download.
setup_build_stubs() {
  export HOME="$ios_dir/home"
  local stubroot="$ios_dir/stubs"
  mkdir -p "$HOME" "$stubroot/bin" "$stubroot/share/xcodegen"
  export PATH="$stubroot/bin:$PATH"
  export XCODE_BUILD_LOG="$ios_dir/xcodebuild.log"
  # shellcheck source=scripts/ios/xcodegen_version.sh
  source "$BATS_TEST_DIRNAME/../../scripts/ios/xcodegen_version.sh"
  export XCODEGEN_VERSION
  cat > "$stubroot/bin/xcodebuild" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$XCODE_BUILD_LOG"
scheme=""
for ((i=1; i<=$#; i++)); do
  if [ "${!i}" = -scheme ]; then
    next=$((i + 1))
    scheme="${!next}"
  fi
done
case " $* " in
  *' -version '*) echo 'Xcode fixture' ;;
  *' -showsdks '*) echo 'iphonesimulator' ;;
  *' -list '*) printf 'Schemes:\n    AutoMobileTest\n    CtrlProxyWatch\n    AutoMobileTVTest\n\n' ;;
  *' -showBuildSettings '*)
    if [ "$scheme" = CtrlProxyWatch ]; then
      case "${PROBE_MODE:-}" in
        failure)
          echo '    PLATFORM_NAME = appletvos'
          echo 'probe failed' >&2
          exit 1 ;;
        unknown) echo '    PLATFORM_NAME = unsupported'; exit 0 ;;
        missing) echo '    OTHER_SETTING = value'; exit 0 ;;
      esac
    fi
    case "$scheme" in
      AutoMobileTest) platform=iphoneos ;;
      CtrlProxyWatch) platform=watchos ;;
      AutoMobileTVTest) platform=appletvos ;;
    esac
    printf '    PLATFORM_NAME = %s\n' "$platform"
    # A later target must not override the first platform setting.
    echo '    PLATFORM_NAME = iphoneos'
    ;;
  *' build '*) exit 0 ;;
  *) exit 1 ;;
esac
STUB
  cat > "$stubroot/bin/xcrun" <<'STUB'
#!/bin/bash
if [ "$*" = 'simctl list runtimes' ]; then
  echo 'iOS 26.0'
else
  exit 1
fi
STUB
  cat > "$stubroot/bin/xcodegen" <<'STUB'
#!/bin/bash
[ "$1" = --version ] || exit 1
echo "Version: $XCODEGEN_VERSION"
STUB
  # Fail locally if the installer ever unexpectedly tries to download.
  cat > "$stubroot/bin/curl" <<'STUB'
#!/bin/bash
echo 'unexpected network access' >> "$XCODE_BUILD_LOG"
exit 1
STUB
  chmod +x "$stubroot/bin/"*
}

run_stubbed_build() {
  run env IOS_DIR="$ios_dir" XCODE_BUILD_DRY_RUN=0 CI=1 \
    AUTOMOBILE_XCODE_DERIVED_DATA= XCODEGEN_PREFIX="$ios_dir/install" \
    bash "$script" CtrlProxy
  [ "$status" -eq 0 ]
  [[ "$output" == *"XcodeGen $XCODEGEN_VERSION already installed."* ]]
  [[ "$output" != *"probe failed"* ]]
  ! grep -q 'unexpected network access' "$XCODE_BUILD_LOG"
}

assert_build_destination() {
  grep -F -- "-scheme $1 -destination generic/platform=$2 Simulator " "$XCODE_BUILD_LOG" | grep -q ' build$'
}

@test "iOS scheme keeps the iOS Simulator destination" {
  setup_build_stubs
  run_stubbed_build
  assert_build_destination AutoMobileTest iOS
}

@test "watch scheme uses the watchOS Simulator destination from build settings" {
  setup_build_stubs
  run_stubbed_build
  assert_build_destination CtrlProxyWatch watchOS
}

@test "tvOS scheme uses the tvOS Simulator destination from build settings" {
  setup_build_stubs
  run_stubbed_build
  assert_build_destination AutoMobileTVTest tvOS
}

@test "failed build settings probe falls back to iOS even with platform output" {
  setup_build_stubs
  export PROBE_MODE=failure
  run_stubbed_build
  assert_build_destination CtrlProxyWatch iOS
}

@test "unknown build settings platform falls back to iOS without guessing from scheme" {
  setup_build_stubs
  export PROBE_MODE=unknown
  run_stubbed_build
  assert_build_destination CtrlProxyWatch iOS
}

@test "missing build settings platform falls back to iOS" {
  setup_build_stubs
  export PROBE_MODE=missing
  run_stubbed_build
  assert_build_destination CtrlProxyWatch iOS
}

@test "no args selects every xcodeproj" {
  run env IOS_DIR="$ios_dir" XCODE_BUILD_DRY_RUN=1 bash "$script"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Playground"* ]]
  [[ "$output" == *"CtrlProxy"* ]]
}

@test "a project-name arg restricts the selection to that project" {
  run env IOS_DIR="$ios_dir" XCODE_BUILD_DRY_RUN=1 bash "$script" CtrlProxy
  [ "$status" -eq 0 ]
  [[ "$output" == *"CtrlProxy"* ]]
  [[ "$output" != *"Playground"* ]]
}

@test "the --dry-run flag is not treated as a project name" {
  run env IOS_DIR="$ios_dir" XCODE_BUILD_DRY_RUN=1 bash "$script" --dry-run Playground
  [ "$status" -eq 0 ]
  [[ "$output" == *"Playground"* ]]
  [[ "$output" != *"CtrlProxy"* ]]
}

@test "an unknown project-name arg fails closed (non-zero, no silent no-op)" {
  run env IOS_DIR="$ios_dir" XCODE_BUILD_DRY_RUN=1 bash "$script" Nonexistent
  [ "$status" -ne 0 ]
  [[ "$output" == *"no Xcode project"* ]]
  [[ "$output" == *"Nonexistent"* ]]
}

@test "a valid + invalid name pair fails closed and names only the unmatched" {
  run env IOS_DIR="$ios_dir" XCODE_BUILD_DRY_RUN=1 bash "$script" Playground Typo
  [ "$status" -ne 0 ]
  [[ "$output" == *"Typo"* ]]
  # The error must list the unmatched request, not the valid one.
  [[ "$output" != *"matched: Playground"* ]]
}

@test "nested .xcodeproj below depth 2 (SwiftPM checkouts, build trees) is ignored" {
  mkdir -p "$ios_dir/XCTestRunner/.build/checkouts/Vendor/Sample.xcodeproj"
  run env IOS_DIR="$ios_dir" XCODE_BUILD_DRY_RUN=1 bash "$script"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Playground"* ]]
  [[ "$output" == *"CtrlProxy"* ]]
  [[ "$output" != *"Sample"* ]]
}
