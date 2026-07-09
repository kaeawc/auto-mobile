#!/usr/bin/env bats

setup() {
  TEST_DIR="$(mktemp -d)"
  STUB_BIN="${TEST_DIR}/bin"
  mkdir -p "${STUB_BIN}"

  ORIG_PATH="${PATH}"
  CHMOD="$(command -v chmod)"
  RM="$(command -v rm)"

  export PATH="${STUB_BIN}:/usr/bin:/bin"
  export INSTALL_SH_SOURCE_ONLY=true
  # shellcheck source=/dev/null
  source scripts/install.sh
}

teardown() {
  export PATH="${ORIG_PATH}"
  "$RM" -rf "${TEST_DIR}"
}

@test "download_file passes bounded retry flags to curl" {
  cat > "${STUB_BIN}/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" > "${CURL_ARGS_FILE:?}"

destination=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then
    destination="$2"
    shift 2
    continue
  fi
  shift
done

printf 'archive' > "${destination}"
STUB
  "$CHMOD" +x "${STUB_BIN}/curl"

  export CURL_ARGS_FILE="${TEST_DIR}/curl-args"
  run download_file "https://example.test/gum.tar.gz" "${TEST_DIR}/gum.tar.gz"

  [ "$status" -eq 0 ]
  [[ "$(cat "${CURL_ARGS_FILE}")" == *"--retry 3"* ]]
  [[ "$(cat "${CURL_ARGS_FILE}")" == *"--retry-delay 2"* ]]
  [[ "$(cat "${CURL_ARGS_FILE}")" == *"--retry-all-errors"* ]]
  [ "$(cat "${TEST_DIR}/gum.tar.gz")" = "archive" ]
}
