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
# `--wait` is bounded by `--timeout` (NOTARY_WAIT_TIMEOUT, default 30m) so a
# submission stuck at Apple fails here with its submission id instead of
# silently consuming the whole CI job's time limit (#18176).
#
# Usage:  notarize-macos-artifact.sh <artifact-path>
# Env:    APPLE_NOTARY_KEY_PATH, APPLE_NOTARY_KEY_ID, APPLE_NOTARY_ISSUER_ID
#         NOTARY_WAIT_TIMEOUT (optional) — notarytool --timeout, e.g. 30m, 1h.
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

wait_timeout="${NOTARY_WAIT_TIMEOUT:-30m}"
if ! [[ "${wait_timeout}" =~ ^[1-9][0-9]*[smh]?$ ]]; then
  echo "notarize-macos-artifact: invalid NOTARY_WAIT_TIMEOUT '${wait_timeout}' (expected e.g. 30m, 1h, 1800)" >&2
  exit 2
fi

xcrun_bin="${XCRUN:-xcrun}"

echo "Notarizing ${artifact} (waiting up to ${wait_timeout})"
submit_rc=0
submission_json=$("${xcrun_bin}" notarytool submit "${artifact}" \
  --key "${APPLE_NOTARY_KEY_PATH}" \
  --key-id "${APPLE_NOTARY_KEY_ID}" \
  --issuer "${APPLE_NOTARY_ISSUER_ID}" \
  --wait \
  --timeout "${wait_timeout}" \
  --output-format json) || submit_rc=$?
echo "${submission_json}"

# Empty when the output is not JSON: a failed submit can print plain text, and
# an empty status is never Accepted, so this cannot pass a bad submission.
submission_id=$(jq -r '.id // empty' 2>/dev/null <<<"${submission_json}" || true)
status=$(jq -r '.status // empty' 2>/dev/null <<<"${submission_json}" || true)

if [ "${submit_rc}" -ne 0 ]; then
  # notarytool exits non-zero when --timeout elapses before Apple finishes, or
  # when the upload itself fails.
  echo "notarytool submit failed (exit ${submit_rc}) for ${artifact}: no notarization verdict within ${wait_timeout} (status: ${status:-unknown}, submission ${submission_id:-unknown})." >&2
  if [ -n "${submission_id}" ]; then
    echo "Check it later with: xcrun notarytool info ${submission_id}" >&2
  fi
  exit 1
fi

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
