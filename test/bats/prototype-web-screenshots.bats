#!/usr/bin/env bats

# Argument handling of scripts/prototype/web-screenshots.sh (#16534). The browser
# checks themselves are opt-in integration tests; these cases exit before bun runs.

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/prototype/web-screenshots.sh"
}

@test "--help documents the parity budgets and --allow-grow" {
  run bash "${SCRIPT}" --help
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"android-parity-budgets.json"* ]]
  [[ "${output}" == *"--allow-grow"* ]]
}

@test "--allow-grow without --update is refused" {
  run bash "${SCRIPT}" --allow-grow
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"--allow-grow needs --update"* ]]
}

@test "an unknown argument is refused" {
  run bash "${SCRIPT}" --nope
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"unknown argument: --nope"* ]]
}
