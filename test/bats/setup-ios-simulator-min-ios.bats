#!/usr/bin/env bats
#
# Tests for scripts/ios/setup-ios-simulator.sh argument parsing
#
# Regression guard for #3645: the help documents `--min-ios VERSION`
# (space-separated), but the old `for arg in "$@"` loop only matched
# `--min-ios=*`, so the documented space form was silently dropped and the
# minimum was auto-detected instead. Both forms must be honored.

SCRIPT="scripts/ios/setup-ios-simulator.sh"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  STUB_DIR="$(mktemp -d)"
  # Stub every tool the early gates require so the script reaches (and logs)
  # the parsed min-ios value on any OS (Linux CI has no Xcode), then exits
  # without touching real simulators.
  printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_DIR/xcrun"   # no runtimes
  printf '#!/usr/bin/env bash\nexit 1\n' > "$STUB_DIR/rg"      # no detected versions
  printf '#!/usr/bin/env bash\necho "/Applications/Xcode.app/Contents/Developer"\n' > "$STUB_DIR/xcode-select"
  cat > "$STUB_DIR/xcodebuild" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -version)  echo "Xcode 15.0"; echo "Build version 15A240d" ;;
  -showsdks) echo "iOS Simulator SDKs:"; echo "        -sdk iphonesimulator17.0" ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$STUB_DIR/xcrun" "$STUB_DIR/rg" "$STUB_DIR/xcode-select" "$STUB_DIR/xcodebuild"
}

teardown() {
  rm -rf "$STUB_DIR"
}

@test "honors --min-ios VERSION (space-separated, as documented)" {
  run env PATH="$STUB_DIR:$PATH" bash "$ABS_SCRIPT" --min-ios 16.0 --skip-download
  [[ "$output" == *"Minimum iOS deployment target: 16.0"* ]]
}

@test "still honors --min-ios=VERSION" {
  run env PATH="$STUB_DIR:$PATH" bash "$ABS_SCRIPT" --min-ios=17.2 --skip-download
  [[ "$output" == *"Minimum iOS deployment target: 17.2"* ]]
}
