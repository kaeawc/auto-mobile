#!/usr/bin/env bats
#
# Unit tests for scripts/ci/notarize-macos-artifact.sh — the shared macOS
# notarization-verdict gate used by the desktop installer workflow for both the
# app bundle and the DMG (#4955). `xcrun` is mocked via the XCRUN override so no
# network / Apple credentials are needed.

SCRIPT="scripts/ci/notarize-macos-artifact.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  ARTIFACT="${TEST_ROOT}/thing.zip"
  echo "artifact bytes" >"${ARTIFACT}"
  XCRUN_LOG="${TEST_ROOT}/xcrun.log"

  export APPLE_NOTARY_KEY_PATH="${TEST_ROOT}/key.p8"
  export APPLE_NOTARY_KEY_ID="KEYID"
  export APPLE_NOTARY_ISSUER_ID="ISSUER"
  echo "key" >"${APPLE_NOTARY_KEY_PATH}"
}

teardown() {
  rm -rf "${TEST_ROOT}"
}

# Write a fake `xcrun` whose `notarytool submit` prints the given verdict JSON.
make_fake_xcrun() {
  local status="$1"
  cat >"${TEST_ROOT}/xcrun" <<FAKE
#!/usr/bin/env bash
echo "\$@" >> "${XCRUN_LOG}"
case "\$2" in
  submit) echo '{"id":"sub-123","status":"${status}"}' ;;
  log)    echo '{"issues":[{"message":"example"}]}' ;;
esac
FAKE
  chmod +x "${TEST_ROOT}/xcrun"
  export XCRUN="${TEST_ROOT}/xcrun"
}

@test "exits 0 when the notary verdict is Accepted" {
  make_fake_xcrun "Accepted"
  run bash "${SCRIPT}" "${ARTIFACT}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Notarization accepted"* ]]
  # It must not have queried the failure log on success.
  ! grep -q "^notarytool log" "${XCRUN_LOG}"
}

@test "fails when the verdict is Invalid and dumps the notary log" {
  make_fake_xcrun "Invalid"
  run bash "${SCRIPT}" "${ARTIFACT}"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Notarization verdict: Invalid"* ]]
  # It fetched the per-file rejection log for the failed submission.
  grep -q "notarytool log sub-123" "${XCRUN_LOG}"
}

@test "fails when the verdict is missing (treated as not Accepted)" {
  make_fake_xcrun ""
  run bash "${SCRIPT}" "${ARTIFACT}"
  [ "$status" -eq 1 ]
}

@test "errors with usage when no artifact is given" {
  make_fake_xcrun "Accepted"
  run bash "${SCRIPT}"
  [ "$status" -eq 2 ]
  [[ "$output" == *"usage:"* ]]
}

@test "errors when the artifact path does not exist" {
  make_fake_xcrun "Accepted"
  run bash "${SCRIPT}" "${TEST_ROOT}/nope.zip"
  [ "$status" -eq 2 ]
  [[ "$output" == *"not found"* ]]
}

@test "errors when a required notary credential env var is unset" {
  make_fake_xcrun "Accepted"
  unset APPLE_NOTARY_KEY_ID
  run bash "${SCRIPT}" "${ARTIFACT}"
  [ "$status" -ne 0 ]
}
