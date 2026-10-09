#!/usr/bin/env bats
# Guards scripts/ci/select-self-hosted-xcode.sh (#11011): the self-hosted Mac jobs
# select their Xcode per job through DEVELOPER_DIR and fail loudly when the
# requested toolchain is missing.

setup() {
  script="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)/scripts/ci/select-self-hosted-xcode.sh"
  export XCODE_APPLICATIONS_DIR="${BATS_TEST_TMPDIR}/Applications"
  export GITHUB_ENV="${BATS_TEST_TMPDIR}/github_env"
  mkdir -p "${XCODE_APPLICATIONS_DIR}" "${BATS_TEST_TMPDIR}/bin"
  : > "${GITHUB_ENV}"
  # plutil only exists on macOS; the stub reads the version from a sidecar file.
  cat > "${BATS_TEST_TMPDIR}/bin/plutil" << 'STUB'
#!/usr/bin/env bash
cat "${@: -1}"
STUB
  chmod +x "${BATS_TEST_TMPDIR}/bin/plutil"
  export PATH="${BATS_TEST_TMPDIR}/bin:${PATH}"
}

fake_xcode() {
  mkdir -p "${XCODE_APPLICATIONS_DIR}/$1/Contents"
  printf '%s' "$2" > "${XCODE_APPLICATIONS_DIR}/$1/Contents/version.plist"
}

@test "exports DEVELOPER_DIR for the matching Xcode" {
  fake_xcode Xcode.app 26.6
  fake_xcode Xcode-26.5.0.app 26.5
  run bash "${script}" 26.5
  [ "$status" -eq 0 ]
  [ "$(cat "${GITHUB_ENV}")" = "DEVELOPER_DIR=${XCODE_APPLICATIONS_DIR}/Xcode-26.5.0.app/Contents/Developer" ]
}

@test "accepts a .0 patch version" {
  fake_xcode Xcode_27.app 27.0
  run bash "${script}" 27
  [ "$status" -eq 0 ]
  [[ "$(cat "${GITHUB_ENV}")" == *"/Xcode_27.app/Contents/Developer" ]]
}

@test "fails and lists installed versions when the version is missing" {
  fake_xcode Xcode.app 26.6
  run bash "${script}" 26.5
  [ "$status" -eq 1 ]
  [[ "$output" == *"Xcode 26.5 is not installed"* ]]
  [[ "$output" == *"26.6 (${XCODE_APPLICATIONS_DIR}/Xcode.app)"* ]]
  [ ! -s "${GITHUB_ENV}" ]
}

@test "rejects a malformed version" {
  run bash "${script}" latest
  [ "$status" -eq 2 ]
}
