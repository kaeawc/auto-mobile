#!/usr/bin/env bash
# Verify the universal iOS simulator prototype-agent dylib before it is attached to
# a release: both simulator slices are present, each targets the iOS simulator
# platform at the expected minimum OS, and the file carries a valid ad-hoc
# signature.
#
# Usage: verify-prototype-agent.sh <dylib-path> [expected-min-ios]
#   expected-min-ios defaults to $PROTOTYPE_AGENT_MIN_IOS, then 17.0.
set -euo pipefail

dylib="${1:?Usage: verify-prototype-agent.sh <dylib-path> [expected-min-ios]}"
expected_min="${2:-${PROTOTYPE_AGENT_MIN_IOS:-17.0}}"

if [[ ! -s "${dylib}" ]]; then
  echo "ERROR: prototype agent not found or empty: ${dylib}" >&2
  exit 1
fi

errors=()

architectures="$(lipo -archs "${dylib}")"
for arch in arm64 x86_64; do
  if [[ " ${architectures} " != *" ${arch} "* ]]; then
    errors+=("missing ${arch} slice (found: ${architectures:-none})")
    continue
  fi
  build_info="$(vtool -arch "${arch}" -show-build "${dylib}" 2>&1 || true)"
  platform="$(awk '$1 == "platform" { print $2; exit }' <<<"${build_info}")"
  minos="$(awk '$1 == "minos" { print $2; exit }' <<<"${build_info}")"
  if [[ "${platform}" != "IOSSIMULATOR" ]]; then
    errors+=("${arch} slice platform must be IOSSIMULATOR, got '${platform:-none}'")
  fi
  if [[ "${minos}" != "${expected_min}" ]]; then
    errors+=("${arch} slice minos must be ${expected_min}, got '${minos:-none}'")
  fi
  if [[ "${platform}" == "IOSSIMULATOR" && "${minos}" == "${expected_min}" ]]; then
    echo "  OK  ${arch}: IOSSIMULATOR minos ${minos}"
  fi
done

if ! codesign --verify --strict "${dylib}" 2>/dev/null; then
  errors+=("code signature is missing or invalid")
elif sign_info="$(codesign -dv "${dylib}" 2>&1)"; ! grep -q '^Signature=adhoc' <<<"${sign_info}"; then
  errors+=("signature must be ad-hoc")
else
  echo "  OK  ad-hoc signature valid"
fi

if [[ ${#errors[@]} -gt 0 ]]; then
  echo "ERROR: prototype agent verification failed for ${dylib}:" >&2
  for e in "${errors[@]}"; do
    echo "  - ${e}" >&2
  done
  exit 1
fi

echo "Prototype agent verified: ${dylib}"
