#!/usr/bin/env bash
#
# Notarize a single macOS artifact (a .zip, .dmg, or .pkg that `notarytool`
# accepts) and fail unless Apple's verdict is "Accepted".
#
# `xcrun notarytool submit --wait` exits 0 even when the verdict is Invalid,
# which previously let callers run on to `stapler staple` and die with an opaque
# "Record not found" (error 65). This script parses the JSON verdict instead:
# anything but Accepted is a hard failure, after dumping the notary log so the
# per-file rejection reasons land in CI output.
#
# Stapling is intentionally NOT done here — the caller staples the artifact it
# actually ships (the app bundle, then the DMG) after notarization succeeds.
#
# Usage:  notarize-macos-artifact.sh <artifact-path>
# Env:    APPLE_NOTARY_KEY_PATH, APPLE_NOTARY_KEY_ID, APPLE_NOTARY_ISSUER_ID
#         XCRUN (optional) — override the `xcrun` binary, for tests.
set -euo pipefail

artifact="${1:-}"
if [ -z "${artifact}" ]; then
  echo "usage: notarize-macos-artifact.sh <artifact-path>" >&2
  exit 2
fi
if [ ! -e "${artifact}" ]; then
  echo "notarize-macos-artifact: artifact not found: ${artifact}" >&2
  exit 2
fi

: "${APPLE_NOTARY_KEY_PATH:?APPLE_NOTARY_KEY_PATH is required}"
: "${APPLE_NOTARY_KEY_ID:?APPLE_NOTARY_KEY_ID is required}"
: "${APPLE_NOTARY_ISSUER_ID:?APPLE_NOTARY_ISSUER_ID is required}"

xcrun_bin="${XCRUN:-xcrun}"

echo "Notarizing ${artifact}"
submission_json=$("${xcrun_bin}" notarytool submit "${artifact}" \
  --key "${APPLE_NOTARY_KEY_PATH}" \
  --key-id "${APPLE_NOTARY_KEY_ID}" \
  --issuer "${APPLE_NOTARY_ISSUER_ID}" \
  --wait \
  --output-format json)
echo "${submission_json}"

submission_id=$(jq -r '.id // empty' <<<"${submission_json}")
status=$(jq -r '.status // empty' <<<"${submission_json}")

if [ "${status}" != "Accepted" ]; then
  echo "Notarization verdict: ${status:-unknown} (submission ${submission_id:-unknown})" >&2
  if [ -n "${submission_id}" ]; then
    # Best-effort: the log service can lag right after the verdict.
    "${xcrun_bin}" notarytool log "${submission_id}" \
      --key "${APPLE_NOTARY_KEY_PATH}" \
      --key-id "${APPLE_NOTARY_KEY_ID}" \
      --issuer "${APPLE_NOTARY_ISSUER_ID}" >&2 || true
  fi
  exit 1
fi

echo "Notarization accepted (submission ${submission_id:-unknown})"
