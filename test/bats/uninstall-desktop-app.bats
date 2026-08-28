#!/usr/bin/env bats

SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/uninstall.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  TEST_HOME="${TEST_ROOT}/home"
  STUB_BIN="${TEST_ROOT}/bin"
  mkdir -p "${TEST_HOME}/Applications/AutoMobile.app/Contents" "${STUB_BIN}"
  printf '%s\n' '<plist/>' > "${TEST_HOME}/Applications/AutoMobile.app/Contents/Info.plist"
  printf '#!/usr/bin/env bash\nprintf "Darwin\\n"\n' > "${STUB_BIN}/uname"
  chmod +x "${STUB_BIN}/uname"
}

teardown() {
  rm -rf "${TEST_ROOT}"
}

@test "--all removes a desktop app installed in the user's Applications directory" {
  run env HOME="${TEST_HOME}" PATH="${STUB_BIN}:${PATH}" bash "${SCRIPT}" --all --force

  [ "$status" -eq 0 ]
  [ ! -e "${TEST_HOME}/Applications/AutoMobile.app" ]
  [[ "$output" == *"AutoMobile desktop app removed"* ]]
}

@test "dry-run detects but does not remove the desktop app" {
  run env HOME="${TEST_HOME}" PATH="${STUB_BIN}:${PATH}" bash "${SCRIPT}" --all --dry-run --force

  [ "$status" -eq 0 ]
  [ -d "${TEST_HOME}/Applications/AutoMobile.app" ]
  [[ "$output" == *"[DRY-RUN] Would remove ${TEST_HOME}/Applications/AutoMobile.app"* ]]
}
