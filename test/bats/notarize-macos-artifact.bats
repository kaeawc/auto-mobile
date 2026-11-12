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

# Write a fake `xcrun` whose `notarytool submit` prints the given verdict JSON
# and exits with the optional second argument (default 0).
make_fake_xcrun() {
  local status="$1" submit_rc="${2:-0}"
  cat >"${TEST_ROOT}/xcrun" <<FAKE
#!/usr/bin/env bash
echo "\$@" >> "${XCRUN_LOG}"
case "\$2" in
  submit) echo '{"id":"sub-123","status":"${status}"}'; exit ${submit_rc} ;;
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

@test "bounds the notary wait with a default 30m --timeout (#18176)" {
  make_fake_xcrun "Accepted"
  run bash "${SCRIPT}" "${ARTIFACT}"
  [ "$status" -eq 0 ]
  grep -q -- "--wait --timeout 30m --output-format json" "${XCRUN_LOG}"
}

@test "honors NOTARY_WAIT_TIMEOUT" {
  make_fake_xcrun "Accepted"
  NOTARY_WAIT_TIMEOUT=45m run bash "${SCRIPT}" "${ARTIFACT}"
  [ "$status" -eq 0 ]
  grep -q -- "--timeout 45m" "${XCRUN_LOG}"
}

@test "rejects a malformed NOTARY_WAIT_TIMEOUT before submitting" {
  make_fake_xcrun "Accepted"
  NOTARY_WAIT_TIMEOUT="30 minutes" run bash "${SCRIPT}" "${ARTIFACT}"
  [ "$status" -eq 2 ]
  [[ "$output" == *"invalid NOTARY_WAIT_TIMEOUT"* ]]
  [ ! -e "${XCRUN_LOG}" ]
}

@test "a submission still in progress at the timeout fails with a clear message" {
  make_fake_xcrun "In Progress" 1
  run bash "${SCRIPT}" "${ARTIFACT}"
  [ "$status" -eq 1 ]
  [[ "$output" == *"notarytool submit failed (exit 1)"* ]]
  [[ "$output" == *"no notarization verdict within 30m"* ]]
  [[ "$output" == *"status: In Progress, submission sub-123"* ]]
  [[ "$output" == *"notarytool info sub-123"* ]]
}

@test "a failed submit with non-JSON output still fails clearly" {
  cat >"${TEST_ROOT}/xcrun" <<'FAKE'
#!/usr/bin/env bash
echo "Error: HTTP status code: 401. Unable to authenticate."
exit 69
FAKE
  chmod +x "${TEST_ROOT}/xcrun"
  export XCRUN="${TEST_ROOT}/xcrun"
  run bash "${SCRIPT}" "${ARTIFACT}"
  [ "$status" -eq 1 ]
  [[ "$output" == *"notarytool submit failed (exit 69)"* ]]
  [[ "$output" == *"submission unknown"* ]]
}

load yq-helpers

@test "the dmg job's time limit covers packaging plus two notary waits (#18176)" {
  require_mikefarah_yq
  local workflow=".github/workflows/build-desktop-app-installers.yml"

  run yq -r '.jobs.build."timeout-minutes"' "$workflow"
  [ "$output" = '${{ matrix.timeout-minutes }}' ]

  # Two 30m notary waits plus packaging must fit.
  run yq -r '.jobs.build.strategy.matrix.include[] | select(.format == "dmg") | ."timeout-minutes"' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" -ge 90 ]

  # Every matrix entry sets its own limit, so none falls back to the 360m default.
  run yq -r '[.jobs.build.strategy.matrix.include[] | select(has("timeout-minutes") | not)] | length' "$workflow"
  [ "$output" = "0" ]
}
