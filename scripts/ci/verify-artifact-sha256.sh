#!/usr/bin/env bash
# Verify that a built artifact's SHA256 matches the checksum stored in the
# RELEASE_CHECKSUM_REGISTRY in src/constants/release.ts.
#
# Usage: verify-artifact-sha256.sh <artifact-path> <platform>
#
# Platform is "android" or "ios", which selects apkSha256 or ipaSha256
# from the first (newest) registry entry.
#
# Example:
#   verify-artifact-sha256.sh /tmp/control-proxy-debug.apk android
#   verify-artifact-sha256.sh /tmp/control-proxy.ipa ios
set -euo pipefail

ARTIFACT_PATH="${1:?Usage: verify-artifact-sha256.sh <artifact-path> <platform>}"
PLATFORM="${2:?Usage: verify-artifact-sha256.sh <artifact-path> <platform>}"

RELEASE_TS="src/constants/release.ts"

# sha256sum is GNU coreutils and absent on stock macOS; fall back to shasum
# (matching verify-release-integrity.sh) so this works on any runner (#3658).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

if [ ! -f "$ARTIFACT_PATH" ]; then
  echo "ERROR: Artifact not found at $ARTIFACT_PATH"
  exit 1
fi

if [ ! -f "$RELEASE_TS" ]; then
  echo "ERROR: Release constants file not found at $RELEASE_TS"
  exit 1
fi

BUILT_SHA256=$(sha256_of "$ARTIFACT_PATH")
echo "Built artifact SHA256: $BUILT_SHA256"

if [ "$PLATFORM" = "android" ]; then
  FIELD="apkSha256"
elif [ "$PLATFORM" = "ios" ]; then
  FIELD="ipaSha256"
else
  echo "ERROR: Platform must be 'android' or 'ios', got '$PLATFORM'"
  exit 1
fi

# Read the field from the FIRST registry ENTRY (the block beginning with
# `version: "`), mirroring verify-release-integrity.sh. A plain
# `grep "$FIELD" | head -1` matches the `ReleaseChecksumEntry` interface
# declaration (`ipaSha256: string;`) that precedes the registry and returns the
# type line, not registry[0] — so a real release aborts with a misleading
# "No SHA256 checksum found" even though the checksum is populated (same
# interface-collision bug fixed in nightly.yml + generate-release-constants.sh).
# `in_first` only arms after a quoted `version: "` line, which the interface
# (`version: string;`, no quote) never trips.
SOURCE_SHA256=$(awk -v field="$FIELD" '
  /^[[:space:]]+version: "/ { in_first = 1 }
  in_first && $0 ~ ("^[[:space:]]+" field ": \"") {
    line = $0
    sub(".*" field ": \"", "", line)
    sub(/".*/, "", line)
    print line
    exit
  }
  in_first && /^[[:space:]]+}/ { exit }
' "$RELEASE_TS")
# Only a real 64-hex value counts; an empty or malformed registry value (e.g.
# `ipaSha256: ""`) yields empty SOURCE_SHA256 so the `-z` guard below fires with
# the actionable "No checksum" error rather than a spurious mismatch (#3658).
if ! [[ "$SOURCE_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  SOURCE_SHA256=""
fi
echo "Source SHA256:         $SOURCE_SHA256"

if [ -z "$SOURCE_SHA256" ]; then
  echo ""
  echo "ERROR: No SHA256 checksum found for $FIELD in RELEASE_CHECKSUM_REGISTRY."
  echo ""
  echo "A release cannot proceed without a checksum in $RELEASE_TS."
  echo "Please:"
  echo "1. Trigger the nightly workflow to generate a checksum update PR"
  echo "2. Merge the update PR before releasing"
  exit 1
fi

if [ "$BUILT_SHA256" != "$SOURCE_SHA256" ]; then
  echo ""
  echo "ERROR: SHA256 mismatch for $FIELD!"
  echo ""
  echo "The built artifact has a different checksum than what's in source."
  echo "This likely means the source code changed after the last"
  echo "checksum update PR was merged."
  echo ""
  echo "Please:"
  echo "1. Check if there's a pending SHA256 update PR"
  echo "2. If not, trigger the nightly workflow to generate one"
  echo "3. Merge the update PR before releasing"
  exit 1
fi

echo ""
echo "SHA256 verified successfully."
echo "checksum=$BUILT_SHA256"
