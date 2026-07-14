#!/usr/bin/env bats
#
# Tests for scripts/ci/prebuild-reminders-xctest-bundle.sh
# Mocks `swift` and `xcodebuild` so no real toolchain build runs.

SCRIPT="scripts/ci/prebuild-reminders-xctest-bundle.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  export INVOCATION_FILE="${MOCK_BIN}/invocations"
  export CWD_FILE="${MOCK_BIN}/cwd"
}

teardown() {
  rm -rf "$MOCK_BIN"
  export PATH="$ORIG_PATH"
}

make_mock_toolchain() {
  local swift_status="${1:-0}"
  cat > "${MOCK_BIN}/swift" <<SCRIPT
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${INVOCATION_FILE}"
pwd >> "${CWD_FILE}"
exit ${swift_status}
SCRIPT
  cat > "${MOCK_BIN}/xcodebuild" <<'SCRIPT'
#!/usr/bin/env bash
echo "Xcode 26.2"
SCRIPT
  chmod +x "${MOCK_BIN}/swift" "${MOCK_BIN}/xcodebuild"
  export PATH="${MOCK_BIN}:${PATH}"
}

@test "script is executable" {
  [ -x "$SCRIPT" ]
}

@test "script has bash shebang" {
  head -1 "$SCRIPT" | grep -q "bash"
}

@test "builds the test bundle from ios/XCTestRunner" {
  make_mock_toolchain 0
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -q -- "build --build-tests" "$INVOCATION_FILE"
  # The build must run with ios/XCTestRunner as the working directory so it
  # compiles the Reminders XCTest targets.
  grep -q "ios/XCTestRunner" "$CWD_FILE"
}

@test "propagates a swift build failure" {
  make_mock_toolchain 3
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
}
