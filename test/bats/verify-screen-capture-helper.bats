#!/usr/bin/env bats
#
# Tests for scripts/ci/verify-screen-capture-helper.sh (issue #4392).
#
# lipo and codesign are stubbed on PATH so the checks are exercised without a
# real universal Mach-O; sha256 uses the runner's real shasum/sha256sum.

# shellcheck disable=SC2030,SC2031

SCRIPT="scripts/ci/verify-screen-capture-helper.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  WORK_DIR="$(mktemp -d)"
  ORIG_PATH="$PATH"
  CHMOD="$(command -v chmod)"
  RM="$(command -v rm)"
  HELPER="${WORK_DIR}/screen-capture-helper"
  printf 'fake helper payload\n' > "$HELPER"
  "$CHMOD" +x "$HELPER"
}

teardown() {
  "$RM" -rf "$MOCK_BIN" "$WORK_DIR"
  export PATH="$ORIG_PATH"
}

# Stub `lipo` to report a fixed arch list via FAKE_LIPO_ARCHS.
stub_lipo() {
  cat > "${MOCK_BIN}/lipo" <<'STUB'
#!/bin/sh
# lipo -archs <file>
printf '%s\n' "${FAKE_LIPO_ARCHS}"
STUB
  "$CHMOD" +x "${MOCK_BIN}/lipo"
}

# Stub `codesign` to succeed or fail via FAKE_CODESIGN_EXIT.
stub_codesign() {
  cat > "${MOCK_BIN}/codesign" <<'STUB'
#!/bin/sh
exit "${FAKE_CODESIGN_EXIT:-0}"
STUB
  "$CHMOD" +x "${MOCK_BIN}/codesign"
}

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

@test "passes for a universal executable with both required architectures" {
  stub_lipo
  export PATH="${MOCK_BIN}:${PATH}"
  export FAKE_LIPO_ARCHS="x86_64 arm64"

  run bash "$SCRIPT" "$HELPER"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Screen-capture helper verified successfully."* ]]
  [[ "$output" == *"sha256=$(sha_of "$HELPER")"* ]]
}

@test "fails when a required architecture is missing (thin binary)" {
  stub_lipo
  export PATH="${MOCK_BIN}:${PATH}"
  export FAKE_LIPO_ARCHS="x86_64"

  run bash "$SCRIPT" "$HELPER"
  [ "$status" -eq 1 ]
  [[ "$output" == *"missing required architecture: arm64"* ]]
}

@test "fails when the binary is not executable" {
  stub_lipo
  export PATH="${MOCK_BIN}:${PATH}"
  export FAKE_LIPO_ARCHS="x86_64 arm64"
  "$CHMOD" -x "$HELPER"

  run bash "$SCRIPT" "$HELPER"
  [ "$status" -eq 1 ]
  [[ "$output" == *"not executable"* ]]
}

@test "fails when the binary is missing" {
  stub_lipo
  export PATH="${MOCK_BIN}:${PATH}"
  export FAKE_LIPO_ARCHS="x86_64 arm64"

  run bash "$SCRIPT" "${WORK_DIR}/does-not-exist"
  [ "$status" -eq 1 ]
  [[ "$output" == *"not found"* ]]
}

@test "passes when the expected sha256 matches" {
  stub_lipo
  export PATH="${MOCK_BIN}:${PATH}"
  export FAKE_LIPO_ARCHS="x86_64 arm64"
  expected="$(sha_of "$HELPER")"

  run bash "$SCRIPT" "$HELPER" --expected-sha256 "$expected"
  [ "$status" -eq 0 ]
  [[ "$output" == *"verified successfully."* ]]
}

@test "fails when the expected sha256 does not match" {
  stub_lipo
  export PATH="${MOCK_BIN}:${PATH}"
  export FAKE_LIPO_ARCHS="x86_64 arm64"

  run bash "$SCRIPT" "$HELPER" --expected-sha256 "deadbeef"
  [ "$status" -eq 1 ]
  [[ "$output" == *"SHA256 mismatch"* ]]
}

@test "verifies the code signature when --require-signature is set" {
  stub_lipo
  stub_codesign
  export PATH="${MOCK_BIN}:${PATH}"
  export FAKE_LIPO_ARCHS="x86_64 arm64"
  export FAKE_CODESIGN_EXIT=0

  run bash "$SCRIPT" "$HELPER" --require-signature
  [ "$status" -eq 0 ]
  [[ "$output" == *"Code signature: verified"* ]]
}

@test "fails when --require-signature is set and the signature is invalid" {
  stub_lipo
  stub_codesign
  export PATH="${MOCK_BIN}:${PATH}"
  export FAKE_LIPO_ARCHS="x86_64 arm64"
  export FAKE_CODESIGN_EXIT=1

  run bash "$SCRIPT" "$HELPER" --require-signature
  [ "$status" -eq 1 ]
  [[ "$output" == *"failed code-signature verification"* ]]
}

@test "rejects an unknown option" {
  run bash "$SCRIPT" "$HELPER" --bogus
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown option"* ]]
}

@test "script is executable" {
  [ -x "$SCRIPT" ]
}

@test "script has bash shebang" {
  head -1 "$SCRIPT" | grep -q "bash"
}
