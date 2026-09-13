#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="${REPO_ROOT}/scripts/ios/build-network-filter-probe.sh"
  mkdir -p "${BATS_TEST_TMPDIR}/bin"
  cat > "${BATS_TEST_TMPDIR}/bin/swift" <<'MOCK'
#!/usr/bin/env bash
touch "${PROBE_TEST_BUILD_MARKER}"
exit 99
MOCK
  chmod +x "${BATS_TEST_TMPDIR}/bin/swift"
  export PATH="${BATS_TEST_TMPDIR}/bin:${PATH}"
  export PROBE_TEST_BUILD_MARKER="${BATS_TEST_TMPDIR}/build-started"
  export MACOS_DEVELOPER_ID_SIGNING_IDENTITY="test identity"
  export MACOS_DEVELOPER_ID_TEAM_ID="ABCDE12345"
  unset MACOS_PROBE_CONTROLLER_PROFILE MACOS_PROBE_PROVIDER_PROFILE
}

@test "unknown packaging mode fails before building" {
  run bash "${SCRIPT}" install
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"Usage:"* ]]
  [ ! -e "${PROBE_TEST_BUILD_MARKER}" ]
}

@test "signed build requires containing app provisioning before building" {
  run bash "${SCRIPT}" signed
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"containing-app Developer ID provisioning profile is required"* ]]
  [ ! -e "${PROBE_TEST_BUILD_MARKER}" ]
}

@test "signed build rejects missing provider profile file before building" {
  export MACOS_PROBE_CONTROLLER_PROFILE="${BATS_TEST_TMPDIR}/app.provisionprofile"
  export MACOS_PROBE_PROVIDER_PROFILE="${BATS_TEST_TMPDIR}/missing.provisionprofile"
  touch "${MACOS_PROBE_CONTROLLER_PROFILE}"
  run bash "${SCRIPT}" signed
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"Provisioning profile does not exist:"* ]]
  [ ! -e "${PROBE_TEST_BUILD_MARKER}" ]
}

@test "invalid team identifier cannot reach property-list commands" {
  export MACOS_DEVELOPER_ID_TEAM_ID="invalid team"
  run bash "${SCRIPT}" unsigned
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"ten-character Apple team identifier"* ]]
  [ ! -e "${PROBE_TEST_BUILD_MARKER}" ]
}
