#!/usr/bin/env bats
#
# Tests for scripts/ios/setup-ios-simulator.sh argument parsing
#
# Regression guard for #3645: the help documents `--min-ios VERSION`
# (space-separated), but the old `for arg in "$@"` loop only matched
# `--min-ios=*`, so the documented space form was silently dropped and the
# minimum was auto-detected instead. Both forms must be honored.
#
# The Xcode tools are stubbed as exported bash functions, not as executable
# files on PATH (#16429). Writing a stub file and exec'ing it moments later can
# fail transiently on a loaded runner (e.g. ETXTBSY), which killed the script
# before it logged the parsed value. Functions inherited by the child `bash`
# shadow PATH lookups, so nothing is written, chmod'ed or exec'ed, and no real
# simulator or Xcode tool is ever reached.

SCRIPT="scripts/ios/setup-ios-simulator.sh"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"

  # No runtimes, so the script stops at the --skip-download gate after logging
  # the parsed minimum.
  xcrun() { return 0; }
  # Only reached by auto-detection, which an explicit --min-ios skips.
  rg() { return 1; }
  xcode-select() { echo "/Applications/Xcode.app/Contents/Developer"; }
  xcodebuild() {
    case "$1" in
      -version) printf 'Xcode 15.0\nBuild version 15A240d\n' ;;
      -showsdks) printf 'iOS Simulator SDKs:\n        -sdk iphonesimulator17.0\n' ;;
      *) return 0 ;;
    esac
  }
  export -f xcrun rg xcode-select xcodebuild
}

# Runs the script with the given args and asserts it logged the expected
# minimum, then stopped at the --skip-download gate (no runtime available).
assert_min_ios_logged() {
  local expected="$1"
  shift
  run bash "$ABS_SCRIPT" "$@" --skip-download
  if [[ "$status" -ne 1 \
    || "$output" != *"Minimum iOS deployment target: ${expected}"* \
    || "$output" != *"Download skipped (--skip-download flag)"* ]]; then
    printf 'status=%s\noutput:\n%s\n' "$status" "$output" >&2
    return 1
  fi
}

@test "honors --min-ios VERSION (space-separated, as documented)" {
  assert_min_ios_logged 16.0 --min-ios 16.0
}

@test "still honors --min-ios=VERSION" {
  assert_min_ios_logged 17.2 --min-ios=17.2
}
