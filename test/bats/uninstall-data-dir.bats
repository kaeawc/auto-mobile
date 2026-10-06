#!/usr/bin/env bats

setup() {
  export HOME="${BATS_TEST_TMPDIR}/home" TMPDIR="${BATS_TEST_TMPDIR}/tmp"
  mkdir -p "${HOME}" "${TMPDIR}"
  export UNINSTALL_SH_SOURCE_ONLY=true
  source "${BATS_TEST_DIRNAME}/../../scripts/uninstall.sh"
  unset UNINSTALL_SH_SOURCE_ONLY
}

@test "detects and removes configured and legacy data directories" {
  export AUTOMOBILE_DATA_DIR="${HOME}/.auto-mobile"
  mkdir -p "${AUTOMOBILE_DATA_DIR}" "${HOME}/.automobile"
  mkdir -p "${HOME}/.automobile/bin"
  touch "${AUTOMOBILE_DATA_DIR}/auto-mobile.db" "${HOME}/.automobile/bin/gum"
  detect_data_dir
  [ "${DATA_DIR_EXISTS}" = true ]
  remove_data_dir
  [ ! -e "${AUTOMOBILE_DATA_DIR}/auto-mobile.db" ]
  [ ! -e "${HOME}/.automobile/bin/gum" ]
}

@test "dry run lists both data paths and preserves them" {
  export AUTOMOBILE_DATA_DIR="${HOME}/.auto-mobile" DRY_RUN=true
  mkdir -p "${AUTOMOBILE_DATA_DIR}" "${HOME}/.automobile"
  detect_data_dir
  run remove_data_dir
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"${AUTOMOBILE_DATA_DIR}"* ]]
  [[ "${output}" == *"${HOME}/.automobile"* ]]
  [ -d "${AUTOMOBILE_DATA_DIR}" ] && [ -d "${HOME}/.automobile" ]
}

@test "detects product data directory alone and honors override" {
  mkdir -p "${HOME}/.auto-mobile"
  detect_data_dir
  [ "${DATA_DIR_EXISTS}" = true ]
  local override="${HOME}/custom-data"
  mkdir -p "${override}"
  export AUTOMOBILE_DATA_DIR="${override}"
  detect_data_dir
  [ "${DATA_DIR_EXISTS}" = true ]
  remove_data_dir
  [ ! -e "${override}" ]
  [ -d "${HOME}/.auto-mobile" ]
}

@test "refuses unsafe data paths" {
  export AUTOMOBILE_DATA_DIR="${HOME}"
  DATA_DIR_EXISTS=true
  run remove_data_dir
  [ "${status}" -ne 0 ]
  [ -d "${HOME}" ]
}
