#!/usr/bin/env bats
#
# scripts/ci/verify-prototype-agent.sh with lipo/vtool/codesign stubbed.

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="${REPO_ROOT}/scripts/ci/verify-prototype-agent.sh"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  DYLIB="${BATS_TEST_TMPDIR}/agent.dylib"
  mkdir -p "${MOCK_BIN}"
  printf 'fat\n' > "${DYLIB}"

  cat > "${MOCK_BIN}/lipo" <<'SCRIPT'
#!/usr/bin/env bash
echo "${VERIFY_TEST_ARCHS:-arm64 x86_64}"
SCRIPT
  # vtool -arch <arch> -show-build <file>
  cat > "${MOCK_BIN}/vtool" <<'SCRIPT'
#!/usr/bin/env bash
printf 'file (architecture %s):\n' "$2"
printf ' platform %s\n    minos %s\n      sdk 26.5\n' \
  "${VERIFY_TEST_PLATFORM:-IOSSIMULATOR}" "${VERIFY_TEST_MINOS:-17.0}"
SCRIPT
  cat > "${MOCK_BIN}/codesign" <<'SCRIPT'
#!/usr/bin/env bash
if [[ "$1" == "--verify" ]]; then
  [[ "${VERIFY_TEST_SIGNATURE:-adhoc}" == "none" ]] && exit 1
  exit 0
fi
echo "Signature=${VERIFY_TEST_SIGNATURE:-adhoc}" >&2
SCRIPT
  chmod +x "${MOCK_BIN}/"{lipo,vtool,codesign}
  export PATH="${MOCK_BIN}:${PATH}"
}

@test "accepts a universal ad-hoc-signed simulator dylib at the expected minos" {
  run bash "${SCRIPT}" "${DYLIB}"

  [ "${status}" -eq 0 ]
  [[ "${output}" == *"arm64: IOSSIMULATOR minos 17.0"* ]]
  [[ "${output}" == *"x86_64: IOSSIMULATOR minos 17.0"* ]]
  [[ "${output}" == *"Prototype agent verified"* ]]
}

@test "rejects a missing x86_64 slice" {
  VERIFY_TEST_ARCHS="arm64" run bash "${SCRIPT}" "${DYLIB}"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"missing x86_64 slice"* ]]
}

@test "rejects a device (non-simulator) platform" {
  VERIFY_TEST_PLATFORM="IOS" run bash "${SCRIPT}" "${DYLIB}"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"platform must be IOSSIMULATOR"* ]]
}

@test "rejects an unexpected minimum OS and honors the override argument" {
  VERIFY_TEST_MINOS="16.4" run bash "${SCRIPT}" "${DYLIB}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"minos must be 17.0, got '16.4'"* ]]

  VERIFY_TEST_MINOS="16.4" run bash "${SCRIPT}" "${DYLIB}" 16.4
  [ "${status}" -eq 0 ]
}

@test "rejects an unsigned dylib" {
  VERIFY_TEST_SIGNATURE="none" run bash "${SCRIPT}" "${DYLIB}"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"signature is missing or invalid"* ]]
}

@test "rejects a non-ad-hoc signature" {
  VERIFY_TEST_SIGNATURE="Developer ID" run bash "${SCRIPT}" "${DYLIB}"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"signature must be ad-hoc"* ]]
}

@test "fails when the dylib is missing" {
  run bash "${SCRIPT}" "${BATS_TEST_TMPDIR}/nope.dylib"

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"not found or empty"* ]]
}
