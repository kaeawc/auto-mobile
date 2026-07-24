#!/usr/bin/env bash
# Verify a prebuilt iOS screen-capture-helper binary before it is attached to a
# GitHub release (issue #4392), and again on the client after download. Checks
# that the binary:
#   - exists and is marked executable (npm preserves mode bits, so a
#     non-executable staged binary would install unusable),
#   - is a universal Mach-O containing every required architecture,
#   - matches an expected SHA-256 when one is provided (transit integrity), and
#   - carries a valid code signature when --require-signature is set.
# On success it prints `sha256=<digest>` so a release job can capture the
# integrity digest for the release constants / registry.
#
# Usage:
#   verify-screen-capture-helper.sh <binary-path> \
#     [--expected-sha256 <sha>] [--require-signature]
set -euo pipefail

REQUIRED_ARCHS=(arm64 x86_64)

BINARY_PATH=""
EXPECTED_SHA256=""
REQUIRE_SIGNATURE="false"

usage() {
  echo "Usage: verify-screen-capture-helper.sh <binary-path>" \
    "[--expected-sha256 <sha>] [--require-signature]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expected-sha256)
      EXPECTED_SHA256="${2:?--expected-sha256 requires a value}"
      shift 2
      ;;
    --require-signature)
      REQUIRE_SIGNATURE="true"
      shift
      ;;
    -*)
      echo "ERROR: unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [[ -n "$BINARY_PATH" ]]; then
        echo "ERROR: unexpected argument: $1" >&2
        usage
        exit 2
      fi
      BINARY_PATH="$1"
      shift
      ;;
  esac
done

if [[ -z "$BINARY_PATH" ]]; then
  usage
  exit 2
fi

if [[ ! -f "$BINARY_PATH" ]]; then
  echo "ERROR: helper binary not found at $BINARY_PATH" >&2
  exit 1
fi

if [[ ! -x "$BINARY_PATH" ]]; then
  echo "ERROR: helper binary is not executable: $BINARY_PATH" >&2
  exit 1
fi

# lipo lists the architecture slices in a (possibly universal) Mach-O. Requiring
# every supported architecture ensures a single-arch build cannot ship.
archs="$(lipo -archs "$BINARY_PATH")"
echo "Architectures: ${archs}"
for required in "${REQUIRED_ARCHS[@]}"; do
  # Word-boundary match against the space-separated arch list.
  if ! printf ' %s ' "$archs" | grep -q " ${required} "; then
    echo "ERROR: helper binary is missing required architecture: ${required}" >&2
    exit 1
  fi
done

# sha256sum is GNU coreutils and absent on stock macOS; fall back to shasum
# (matching verify-transit-sha256.sh) so this works on any runner.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

ACTUAL_SHA256="$(sha256_of "$BINARY_PATH")"

if [[ -n "$EXPECTED_SHA256" && "$EXPECTED_SHA256" != "$ACTUAL_SHA256" ]]; then
  echo "ERROR: SHA256 mismatch for $(basename "$BINARY_PATH")" >&2
  echo "Expected: $EXPECTED_SHA256" >&2
  echo "Actual:   $ACTUAL_SHA256" >&2
  exit 1
fi

if [[ "$REQUIRE_SIGNATURE" == "true" ]]; then
  if ! codesign --verify --strict "$BINARY_PATH" 2>/dev/null; then
    echo "ERROR: helper binary failed code-signature verification" >&2
    exit 1
  fi
  echo "Code signature: verified"
fi

echo "sha256=${ACTUAL_SHA256}"
echo "Screen-capture helper verified successfully."
