#!/usr/bin/env bash
#
# Fail when the Linux SwiftLint pin and the Mac SwiftLint pin name different
# versions, or when the Linux pin's SHA-256 is not a 64-character hex digest.
# The two lanes must lint with the same SwiftLint so they report the same
# findings (#17581).
#
# Usage: check_swiftlint_pin_consistency.sh [pin_dir]
#   pin_dir defaults to this script's directory (tests pass a fixture dir).

set -euo pipefail

pin_dir="${1:-$(dirname "${BASH_SOURCE[0]}")}"

# shellcheck source=scripts/swiftlint/swiftlint_version.sh
source "${pin_dir}/swiftlint_version.sh"
# shellcheck source=scripts/swiftlint/swiftlint_linux_pin.sh
source "${pin_dir}/swiftlint_linux_pin.sh"

status=0
if [[ -z "${SWIFTLINT_VERSION:-}" || -z "${SWIFTLINT_LINUX_VERSION:-}" ]]; then
  echo "SwiftLint pin missing: SWIFTLINT_VERSION='${SWIFTLINT_VERSION:-}' SWIFTLINT_LINUX_VERSION='${SWIFTLINT_LINUX_VERSION:-}'." >&2
  status=1
elif [[ "$SWIFTLINT_VERSION" != "$SWIFTLINT_LINUX_VERSION" ]]; then
  echo "SwiftLint pins diverge: Mac pins '${SWIFTLINT_VERSION}' (swiftlint_version.sh), Linux pins '${SWIFTLINT_LINUX_VERSION}' (swiftlint_linux_pin.sh)." >&2
  echo "Bump both together and refresh SWIFTLINT_LINUX_SHA256 for the new swiftlint_linux.zip." >&2
  status=1
fi

if [[ ! "${SWIFTLINT_LINUX_SHA256:-}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "SWIFTLINT_LINUX_SHA256 must be a lowercase 64-character hex SHA-256, got '${SWIFTLINT_LINUX_SHA256:-}'." >&2
  status=1
fi

if [[ "$status" -eq 0 ]]; then
  echo "SwiftLint pins agree: ${SWIFTLINT_VERSION} on Mac and Linux."
fi
exit "$status"
