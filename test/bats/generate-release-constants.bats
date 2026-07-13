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
    IOS_CTRL_PROXY_RUNNER_SHA256="$RUNNER_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Added registry entry for version: 99.99.99"* ]]

  first_version="$(grep -m1 '^[[:space:]]*version: "' "${TEST_ROOT}/src/constants/release.ts")"
  [[ "$first_version" == *'version: "99.99.99"'* ]]
  grep -q "apkSha256: \"${APK_SHA}\"" "${TEST_ROOT}/src/constants/release.ts"
  grep -q "ipaSha256: \"${IPA_SHA}\"" "${TEST_ROOT}/src/constants/release.ts"
  grep -q "runnerSha256: \"${RUNNER_SHA}\"" "${TEST_ROOT}/src/constants/release.ts"
}

@test "writes runnerSha256 in release mode" {
  run env \
    RELEASE_VERSION="99.99.99" \
    APK_SHA256_CHECKSUM="$APK_SHA" \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    IOS_CTRL_PROXY_RUNNER_SHA256="$RUNNER_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -eq 0 ]
  grep -q "runnerSha256: \"${RUNNER_SHA}\"" "${TEST_ROOT}/src/constants/release.ts"
}

@test "writes registry[0].runnerSha256 in checksum-only mode" {
  run env \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    IOS_CTRL_PROXY_RUNNER_SHA256="$RUNNER_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -eq 0 ]
  grep -q "runnerSha256: \"${RUNNER_SHA}\"" "${TEST_ROOT}/src/constants/release.ts"
}

@test "updates registry[0].apkSha256 and ipaSha256 in checksum-only mode" {
  # Regression for #3784: the nightly checksum-only path must move the APK/IPA
  # shas on registry[0], not the `apkSha256: string;` interface declaration that
  # precedes the registry. Capture the pre-update values so we assert they change
  # (and that the update lands inside the first registry entry).
  old_apk="$(awk '
    /^[[:space:]]+version: "/ { in_first = 1 }
    in_first && /^[[:space:]]+apkSha256: "/ { sub(/.*apkSha256: "/, ""); sub(/".*/, ""); print; exit }
  ' "${TEST_ROOT}/src/constants/release.ts")"
  [ -n "$old_apk" ]
  [ "$old_apk" != "$APK_SHA" ]

  run env \
    APK_SHA256_CHECKSUM="$APK_SHA" \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"
  [ "$status" -eq 0 ]

  # First registry entry now carries the new shas.
  first_apk="$(awk '
    /^[[:space:]]+version: "/ { in_first = 1 }
    in_first && /^[[:space:]]+apkSha256: "/ { sub(/.*apkSha256: "/, ""); sub(/".*/, ""); print; exit }
  ' "${TEST_ROOT}/src/constants/release.ts")"
  first_ipa="$(awk '
    /^[[:space:]]+version: "/ { in_first = 1 }
    in_first && /^[[:space:]]+ipaSha256: "/ { sub(/.*ipaSha256: "/, ""); sub(/".*/, ""); print; exit }
  ' "${TEST_ROOT}/src/constants/release.ts")"
  [ "$first_apk" = "$APK_SHA" ]
  [ "$first_ipa" = "$IPA_SHA" ]

  # Only registry[0] moves: the second entry (0.0.43) keeps its original apkSha256.
  grep -q 'apkSha256: "7e4e2ce3c19b7473d171433186dbc7487df60ff6045dba66da7a320d31e63cd3"' \
    "${TEST_ROOT}/src/constants/release.ts"

  # The interface declaration must remain a type, never a checksum.
  grep -q '^  apkSha256: string;$' "${TEST_ROOT}/src/constants/release.ts"
  grep -q '^  ipaSha256: string;$' "${TEST_ROOT}/src/constants/release.ts"
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
  # populate the per-entry runner sha (self-heal at release time).
  run env \
    RELEASE_VERSION="99.99.99" \
    APK_SHA256_CHECKSUM="$APK_SHA" \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    IOS_CTRL_PROXY_RUNNER_SHA256="$RUNNER_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"
  [ "$status" -eq 0 ]

  entry_count="$(grep -c 'version: "99.99.99"' "${TEST_ROOT}/src/constants/release.ts")"
  [ "$entry_count" -eq 1 ]
  grep -q "runnerSha256: \"${RUNNER_SHA}\"" "${TEST_ROOT}/src/constants/release.ts"
}

@test "caps registry without orphan braces when entries include runnerSha256" {
  python3 - "${TEST_ROOT}/src/constants/release.ts" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
entries = []
for i in range(100):
    entries.append(f'''  {{
    version: "1.0.{i}",
    apkSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ipaSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    runnerSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  }},''')

text = path.read_text()
replacement = "export const RELEASE_CHECKSUM_REGISTRY: ReleaseChecksumEntry[] = [\n" + "\n".join(entries) + "\n];"
text = re.sub(
    r'export const RELEASE_CHECKSUM_REGISTRY: ReleaseChecksumEntry\[\] = \[\n.*?\n\];',
    replacement,
    text,
    count=1,
    flags=re.S,
)
path.write_text(text)
PY

  run env \
    RELEASE_VERSION="99.99.99" \
    APK_SHA256_CHECKSUM="$APK_SHA" \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    IOS_CTRL_PROXY_RUNNER_SHA256="$RUNNER_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -eq 0 ]
  version_count="$(grep -c 'version: "' "${TEST_ROOT}/src/constants/release.ts")"
  open_count="$(grep -c '^  {$' "${TEST_ROOT}/src/constants/release.ts")"
  close_count="$(grep -c '^  },$' "${TEST_ROOT}/src/constants/release.ts")"
  [ "$version_count" -eq 100 ]
  [ "$open_count" -eq "$close_count" ]
}

@test "rejects a malformed IOS_CTRL_PROXY_RUNNER_SHA256" {
  run env \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    IOS_CTRL_PROXY_RUNNER_SHA256="not-a-sha" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"IOS_CTRL_PROXY_RUNNER_SHA256 must be a valid SHA256"* ]]
}
