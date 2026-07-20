#!/usr/bin/env bats
#
# Tests for scripts/generate-release-constants.sh

SCRIPT="scripts/generate-release-constants.sh"
APK_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
IPA_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
RUNNER_SHA="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
VIDEO_JAR_SHA="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

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

# Read a field from the block anchored on `version: "$1"` (either a registry
# entry like "0.0.44" or the standalone NIGHTLY_CHECKSUM_ENTRY, "nightly").
read_field_for_version() {
  awk -v want="$1" -v field="$2" '
    $0 ~ ("^[[:space:]]+version: \"" want "\"") { in_block = 1 }
    in_block && $0 ~ ("^[[:space:]]+" field ": \"") {
      line = $0
      sub(".*" field ": \"", "", line)
      sub(/".*/, "", line)
      print line
      exit
    }
    in_block && /^[[:space:]]*}/ { exit }
  ' "$3"
}

@test "writes NIGHTLY_CHECKSUM_ENTRY runnerSha256 in checksum-only mode" {
  release_runner_before="$(read_field_for_version 0.0.44 runnerSha256 "${TEST_ROOT}/src/constants/release.ts")"
  [ -n "$release_runner_before" ]

  run env \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    IOS_CTRL_PROXY_RUNNER_SHA256="$RUNNER_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -eq 0 ]
  # The nightly slot moved.
  nightly_runner="$(read_field_for_version nightly runnerSha256 "${TEST_ROOT}/src/constants/release.ts")"
  [ "$nightly_runner" = "$RUNNER_SHA" ]
  # The tagged release entry (registry[0], 0.0.44) is untouched.
  release_runner_after="$(read_field_for_version 0.0.44 runnerSha256 "${TEST_ROOT}/src/constants/release.ts")"
  [ "$release_runner_after" = "$release_runner_before" ]
}

@test "updates NIGHTLY_CHECKSUM_ENTRY apk/ipa (not registry[0]) in checksum-only mode" {
  # Regression for #3784 + the follow-up design fix: the nightly checksum-only
  # path must move the APK/IPA shas on the dedicated `nightly` slot, never on a
  # tagged registry entry, and never on the `apkSha256: string;` interface
  # declaration that precedes the registry.
  release_apk_before="$(read_field_for_version 0.0.44 apkSha256 "${TEST_ROOT}/src/constants/release.ts")"
  release_ipa_before="$(read_field_for_version 0.0.44 ipaSha256 "${TEST_ROOT}/src/constants/release.ts")"
  [ -n "$release_apk_before" ]
  [ "$release_apk_before" != "$APK_SHA" ]

  run env \
    APK_SHA256_CHECKSUM="$APK_SHA" \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"
  [ "$status" -eq 0 ]

  # The nightly slot now carries the new shas.
  nightly_apk="$(read_field_for_version nightly apkSha256 "${TEST_ROOT}/src/constants/release.ts")"
  nightly_ipa="$(read_field_for_version nightly ipaSha256 "${TEST_ROOT}/src/constants/release.ts")"
  [ "$nightly_apk" = "$APK_SHA" ]
  [ "$nightly_ipa" = "$IPA_SHA" ]

  # The tagged release entry (registry[0], 0.0.44) is untouched.
  release_apk_after="$(read_field_for_version 0.0.44 apkSha256 "${TEST_ROOT}/src/constants/release.ts")"
  release_ipa_after="$(read_field_for_version 0.0.44 ipaSha256 "${TEST_ROOT}/src/constants/release.ts")"
  [ "$release_apk_after" = "$release_apk_before" ]
  [ "$release_ipa_after" = "$release_ipa_before" ]

  # The second registry entry (0.0.43) keeps its original apkSha256. Coupled to
  # the real release.ts the harness copies in setup(); if 0.0.43 ever ages out of
  # the registry or its sha changes, update this literal.
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
  # Count only semver release entries; the standalone NIGHTLY_CHECKSUM_ENTRY
  # (version: "nightly") is not part of the capped registry.
  version_count="$(grep -cE 'version: "[0-9]' "${TEST_ROOT}/src/constants/release.ts")"
  open_count="$(grep -c '^  {$' "${TEST_ROOT}/src/constants/release.ts")"
  close_count="$(grep -c '^  },$' "${TEST_ROOT}/src/constants/release.ts")"
  [ "$version_count" -eq 100 ]
  [ "$open_count" -eq "$close_count" ]
  # The nightly slot survives the cap untouched.
  grep -q '^  version: "nightly",$' "${TEST_ROOT}/src/constants/release.ts"
}

@test "rejects a malformed IOS_CTRL_PROXY_RUNNER_SHA256" {
  run env \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    IOS_CTRL_PROXY_RUNNER_SHA256="not-a-sha" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"IOS_CTRL_PROXY_RUNNER_SHA256 must be a valid SHA256"* ]]
}

# --- video-server jar (#3833) ---

@test "writes videoJarSha256 into the new registry entry in release mode" {
  run env \
    RELEASE_VERSION="99.99.99" \
    APK_SHA256_CHECKSUM="$APK_SHA" \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    IOS_CTRL_PROXY_RUNNER_SHA256="$RUNNER_SHA" \
    VIDEO_JAR_SHA256="$VIDEO_JAR_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -eq 0 ]
  # registry[0] (the new entry) carries the videoJarSha256.
  first_video="$(read_field_for_version 99.99.99 videoJarSha256 "${TEST_ROOT}/src/constants/release.ts")"
  [ "$first_video" = "$VIDEO_JAR_SHA" ]
}

@test "writes NIGHTLY_CHECKSUM_ENTRY videoJarSha256 (not registry[0]) in checksum-only mode" {
  run env \
    APK_SHA256_CHECKSUM="$APK_SHA" \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    VIDEO_JAR_SHA256="$VIDEO_JAR_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -eq 0 ]
  # The dedicated nightly slot carries the jar sha; registry[0] is untouched.
  nightly_video="$(read_field_for_version nightly videoJarSha256 "${TEST_ROOT}/src/constants/release.ts")"
  [ "$nightly_video" = "$VIDEO_JAR_SHA" ]
}

@test "inserts missing videoJarSha256 using the entry's existing indentation" {
  python3 - "${TEST_ROOT}/src/constants/release.ts" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
text = re.sub(r'\n\s+videoJarSha256: "[^"]+",', '', text)
path.write_text(text)
PY

  run env \
    APK_SHA256_CHECKSUM="$APK_SHA" \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    VIDEO_JAR_SHA256="$VIDEO_JAR_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"
  [ "$status" -eq 0 ]

  grep -q '^  videoJarSha256: "' "${TEST_ROOT}/src/constants/release.ts"
  ! grep -q '^    videoJarSha256: "' "${TEST_ROOT}/src/constants/release.ts"

  run env \
    RELEASE_VERSION="0.0.44" \
    APK_SHA256_CHECKSUM="$APK_SHA" \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    VIDEO_JAR_SHA256="$VIDEO_JAR_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"
  [ "$status" -eq 0 ]

  grep -q '^    videoJarSha256: "' "${TEST_ROOT}/src/constants/release.ts"
}

@test "rejects a malformed VIDEO_JAR_SHA256" {
  run env \
    IOS_CTRL_PROXY_SHA256_CHECKSUM="$IPA_SHA" \
    VIDEO_JAR_SHA256="not-a-sha" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"VIDEO_JAR_SHA256 must be a valid SHA256"* ]]
}

@test "caps registry without orphan braces when entries include videoJarSha256" {
  # Guards the dynamic cap-deletion range: entries with a videoJarSha256 line are
  # 7 lines, not 6, so a hardcoded +4 offset would orphan a trailing `},` when
  # such an entry is pruned. The end anchor must follow the entry's `},`.
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
    videoJarSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
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
    VIDEO_JAR_SHA256="$VIDEO_JAR_SHA" \
    bash "${TEST_ROOT}/scripts/generate-release-constants.sh"

  [ "$status" -eq 0 ]
  version_count="$(grep -cE 'version: "[0-9]' "${TEST_ROOT}/src/constants/release.ts")"
  open_count="$(grep -c '^  {$' "${TEST_ROOT}/src/constants/release.ts")"
  close_count="$(grep -c '^  },$' "${TEST_ROOT}/src/constants/release.ts")"
  [ "$version_count" -eq 100 ]
  [ "$open_count" -eq "$close_count" ]
  grep -q '^  version: "nightly",$' "${TEST_ROOT}/src/constants/release.ts"
}
