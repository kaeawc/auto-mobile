#!/usr/bin/env bats

SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/install.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  CLI_PATH="${TEST_ROOT}/auto-mobile"
  printf '#!/usr/bin/env bash\nexit 0\n' > "${CLI_PATH}"
  chmod +x "${CLI_PATH}"
}

teardown() {
  rm -rf "${TEST_ROOT}"
}

@test "uses the executable source CLI override for daemon lifecycle commands" {
  run env INSTALL_SH_SOURCE_ONLY=true AUTOMOBILE_CLI_PATH="${CLI_PATH}" SCRIPT="${SCRIPT}" bash -c '
    source "${SCRIPT}"
    command_exists() { return 1; }
    resolve_auto_mobile_command
    printf "%s\n" "${AUTO_MOBILE_CMD[@]}"
  '

  [ "$status" -eq 0 ]
  [ "$output" = "${CLI_PATH}" ]
}

@test "rejects a non-executable source CLI override" {
  chmod -x "${CLI_PATH}"

  run env INSTALL_SH_SOURCE_ONLY=true AUTOMOBILE_CLI_PATH="${CLI_PATH}" SCRIPT="${SCRIPT}" bash -c '
    source "${SCRIPT}"
    command_exists() { return 1; }
    if resolve_auto_mobile_command; then
      exit 1
    fi
  '

  [ "$status" -eq 0 ]
}
