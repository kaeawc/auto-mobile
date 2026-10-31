#!/usr/bin/env bash
# Verify that a release APK carries a valid signature from a non-debug key.
#
# The shared Android signing convention falls back to the Android debug key when
# release keystore inputs are incomplete. A release asset signed that way would
# install fine but chain to a throwaway certificate, so release builders run this
# gate on the built APK (#15301).
#
# Usage: verify-apk-release-signature.sh <apk-path>
# Env:   APKSIGNER_BIN  explicit apksigner binary (else PATH, then
#                       $ANDROID_HOME|$ANDROID_SDK_ROOT/build-tools/*/apksigner)
# Prints "certificate-sha256=<digest>" on success.
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "Usage: verify-apk-release-signature.sh <apk-path>" >&2
  exit 2
fi
apk="$1"
if [[ ! -f "$apk" ]]; then
  echo "ERROR: APK not found at $apk" >&2
  exit 1
fi

resolve_apksigner() {
  if [[ -n "${APKSIGNER_BIN:-}" ]]; then
    printf '%s\n' "$APKSIGNER_BIN"
    return
  fi
  if command -v apksigner > /dev/null 2>&1; then
    command -v apksigner
    return
  fi
  local sdk_root candidate
  for sdk_root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}"; do
    [[ -n "$sdk_root" ]] || continue
    # Newest build-tools first so the strictest verifier is used.
    while IFS= read -r candidate; do
      if [[ -x "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return
      fi
    done < <(find "$sdk_root/build-tools" -mindepth 2 -maxdepth 2 -name apksigner 2> /dev/null | sort -r)
  done
  echo "ERROR: apksigner not found (set APKSIGNER_BIN or ANDROID_HOME)" >&2
  return 1
}

apksigner_bin="$(resolve_apksigner)"
certs="$("$apksigner_bin" verify --print-certs "$apk")" || {
  echo "ERROR: apksigner could not verify the signature of $apk" >&2
  exit 1
}

signer_count="$(grep -c '^Signer #[0-9]* certificate DN:' <<< "$certs" || true)"
if [[ "$signer_count" -lt 1 ]]; then
  echo "ERROR: apksigner reported no signer certificate for $apk" >&2
  exit 1
fi
if grep -Eq '^Signer #[0-9]+ certificate DN:.*CN=Android Debug' <<< "$certs"; then
  echo "ERROR: $apk is signed with the Android debug certificate, not the release key." >&2
  echo "A release build must run with RELEASE_KEYSTORE_* inputs; refusing to publish." >&2
  exit 1
fi

digest="$(awk -F ': ' '/^Signer #1 certificate SHA-256 digest:/ { print $2; exit }' <<< "$certs")"
if ! [[ "$digest" =~ ^[a-f0-9]{64}$ ]]; then
  echo "ERROR: could not read the signer #1 SHA-256 digest from apksigner output" >&2
  exit 1
fi
echo "Release signature verified for $(basename "$apk")"
echo "certificate-sha256=$digest"
