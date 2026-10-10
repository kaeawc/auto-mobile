#!/usr/bin/env bats
#
# Tests for the CI-parity guards in scripts/shellcheck/validate_shell_scripts.sh.
# CI runs shellcheck 0.9.0 (ubuntu-24.04 apt); a newer local shellcheck reports a
# never-invoked function as SC2329 where CI reports SC2317, so a lone
# `disable=SC2329` passed locally and failed On Merge (2026-10-10).
# SHELLCHECK_CMD injects a fake shellcheck so no real version is needed.

SCRIPT_DIR="${BATS_TEST_DIRNAME}/../../scripts"

setup() {
  WORK="$(mktemp -d)"
  mkdir -p "${WORK}/scripts/shellcheck" "${WORK}/scripts/lib" "${WORK}/scripts/utils"
  cp "${SCRIPT_DIR}/shellcheck/validate_shell_scripts.sh" "${WORK}/scripts/shellcheck/"
  cp "${SCRIPT_DIR}/lib/vcs-diff.sh" "${WORK}/scripts/lib/"
  cp "${SCRIPT_DIR}/utils/get_timestamp.sh" "${WORK}/scripts/utils/"
  FAKE="${WORK}/fake-shellcheck"
  printf '#!/usr/bin/env bash\nif [[ "${1:-}" == "--version" ]]; then printf "ShellCheck\\nversion: %%s\\n" "${FAKE_SC_VERSION:-0.11.0}"; fi\nexit 0\n' > "${FAKE}"
  chmod +x "${FAKE}"
  git -C "${WORK}" init -q
}

teardown() {
  rm -rf "${WORK}"
}

run_validate() {
  cd "${WORK}"
  git add -A >/dev/null
  run env SHELLCHECK_CMD="${FAKE}" bash scripts/shellcheck/validate_shell_scripts.sh "$@"
}

@test "a lone disable=SC2329 fails: CI shellcheck reports the same finding as SC2317" {
  printf '#!/usr/bin/env bash\n# shellcheck disable=SC2329 # invoked via the EXIT trap\ncleanup() { :; }\ntrap cleanup EXIT\n' > "${WORK}/scripts/lone.sh"
  run_validate
  [ "$status" -ne 0 ]
  [[ "$output" == *"scripts/lone.sh:2: disable=SC2329 without SC2317"* ]]
}

@test "disable=SC2317,SC2329 passes" {
  printf '#!/usr/bin/env bash\n# shellcheck disable=SC2317,SC2329 # invoked via the EXIT trap\ncleanup() { :; }\ntrap cleanup EXIT\n' > "${WORK}/scripts/paired.sh"
  run_validate
  [ "$status" -eq 0 ]
  [[ "$output" == *"All shell scripts are valid."* ]]
}

@test "a differing local shellcheck version prints a warning naming CI's version" {
  run_validate
  [ "$status" -eq 0 ]
  [[ "$output" == *"local shellcheck 0.11.0 differs from CI's 0.9.0"* ]]
}

@test "a matching shellcheck version prints no warning" {
  cd "${WORK}"
  git add -A >/dev/null
  run env FAKE_SC_VERSION=0.9.0 SHELLCHECK_CMD="${FAKE}" bash scripts/shellcheck/validate_shell_scripts.sh
  [ "$status" -eq 0 ]
  [[ "$output" != *"WARNING"* ]]
}
