#!/usr/bin/env bats
#
# Tests for scripts/generate-release-constants.sh

SCRIPT="scripts/generate-release-constants.sh"
APK_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
IPA_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
RUNNER_SHA="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

setup() {
  TEST_ROOT="$(mktemp -d)"
  mkdir -p "${TEST_ROOT}/scripts" "${TEST_ROOT}/src/constants"
  cp "$SCRIPT" "${TEST_ROOT}/scripts/generate-release-constants.sh"
  cp "src/constants/release.ts" "${TEST_ROOT}/src/constants/release.ts"
  chmod +x "${TEST_ROOT}/scripts/generate-release-constants.sh"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

@test "prepends release registry entry in release mode" {
  run env \
    RELEASE_VERSION="99.99.99" \
    APK_SHA256_CHECKSUM="$APK_SHA" \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Added registry entry for version: 99.99.99"* ]]

  first_version="$(grep -m1 '^[[:space:]]*version: "' "${TEST_ROOT}/src/constants/release.ts")"
  [[ "$first_version" == *'version: "99.99.99"'* ]]
  grep -q "apkSha256: \"${APK_SHA}\"" "${TEST_ROOT}/src/constants/release.ts"
  grep -q "ipaSha256: \"${IPA_SHA}\"" "${TEST_ROOT}/src/constants/release.ts"
}

@test "writes IOS_CTRL_PROXY_RUNNER_SHA256 in release mode" {
  run env \
    RELEASE_VERSION="99.99.99" \
    APK_SHA256_CHECKSUM="$APK_SHA" \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    IOS_CTRL_PROXY_RUNNER_SHA256="$RUNNER_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -eq 0 ]
  grep -q "export const IOS_CTRL_PROXY_RUNNER_SHA256: string = \"${RUNNER_SHA}\";" \
    "${TEST_ROOT}/src/constants/release.ts"
}

@test "writes IOS_CTRL_PROXY_RUNNER_SHA256 in checksum-only mode" {
  run env \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    IOS_CTRL_PROXY_RUNNER_SHA256="$RUNNER_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -eq 0 ]
  grep -q "export const IOS_CTRL_PROXY_RUNNER_SHA256: string = \"${RUNNER_SHA}\";" \
    "${TEST_ROOT}/src/constants/release.ts"
}

@test "refreshes runner sha for an already-registered version (no duplicate entry)" {
  # First release adds the entry but with an empty runner sha (pre-wiring state).
  run env \
    RELEASE_VERSION="99.99.99" \
    APK_SHA256_CHECKSUM="$APK_SHA" \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"
  [ "$status" -eq 0 ]

  # Re-running for the SAME version must not duplicate the entry, but must still
  # populate the runner sha scalar (self-heal at release time).
  run env \
    RELEASE_VERSION="99.99.99" \
    APK_SHA256_CHECKSUM="$APK_SHA" \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    IOS_CTRL_PROXY_RUNNER_SHA256="$RUNNER_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"
  [ "$status" -eq 0 ]

  entry_count="$(grep -c 'version: "99.99.99"' "${TEST_ROOT}/src/constants/release.ts")"
  [ "$entry_count" -eq 1 ]
  grep -q "export const IOS_CTRL_PROXY_RUNNER_SHA256: string = \"${RUNNER_SHA}\";" \
    "${TEST_ROOT}/src/constants/release.ts"
}

@test "rejects a malformed IOS_CTRL_PROXY_RUNNER_SHA256" {
  run env \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    IOS_CTRL_PROXY_RUNNER_SHA256="not-a-sha" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"IOS_CTRL_PROXY_RUNNER_SHA256 must be a valid SHA256"* ]]
}
