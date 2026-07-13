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

# shellcheck source=scripts/lib/read-registry-field.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/read-registry-field.sh"

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

# Read the checksum from registry[0] via the shared, entry-anchored helper. A
# plain `grep "$FIELD" | head -1` would instead match the `ReleaseChecksumEntry`
# interface declaration (`ipaSha256: string;`) that precedes the registry: the
# whole pipeline then yields an empty value and a real release aborts with a
# misleading "No SHA256 checksum found" even though the checksum is populated
# (interface-collision bug, #3784).
SOURCE_SHA256=$(read_registry_field "$FIELD" "$RELEASE_TS")
# The helper does no format validation, so enforce the 64-hex floor here: an
# empty or malformed registry value (e.g. `ipaSha256: ""`) yields empty
# SOURCE_SHA256 so the `-z` guard below fires with the actionable "No checksum"
# error rather than a spurious mismatch (#3658).
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
