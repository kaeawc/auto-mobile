#!/usr/bin/env bats
#
# scripts/prototype/web-screenshots.sh with bun stubbed out: the test proves the
# argument mapping to the AUTOMOBILE_PROTOTYPE_WEB_* environment, not the browser
# check itself (webScreenshots.integration.test.ts covers that).

setup() {
  bats_require_minimum_version 1.5.0
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="${REPO_ROOT}/scripts/prototype/web-screenshots.sh"
  CALLS="${BATS_TEST_TMPDIR}/calls.log"
  STUB_DIR="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${STUB_DIR}"
  cat > "${STUB_DIR}/bun" <<'STUB'
#!/usr/bin/env bash
{
  printf 'args=%s\n' "$*"
  printf 'run=%s\n' "${AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS}"
  printf 'update=%s\n' "${AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_UPDATE}"
  printf 'engines=%s\n' "${AUTOMOBILE_PROTOTYPE_WEB_ENGINES}"
  printf 'allow_grow=%s\n' "${AUTOMOBILE_PROTOTYPE_WEB_PARITY_ALLOW_GROW}"
} > "${CALLS}"
STUB
  chmod +x "${STUB_DIR}/bun"
  export CALLS
  export PATH="${STUB_DIR}:${PATH}"
}

@test "web-screenshots: runs every engine against the goldens by default" {
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  grep -qx 'args=test test/features/prototype/web/webScreenshots.integration.test.ts test/features/prototype/web/webAndroidParity.integration.test.ts' "${CALLS}"
  grep -qx 'run=1' "${CALLS}"
  grep -qx 'update=0' "${CALLS}"
  grep -qx 'engines=' "${CALLS}"
  grep -qx 'allow_grow=0' "${CALLS}"
}

@test "web-screenshots: --engine is repeatable and --update rewrites the goldens" {
  run bash "${SCRIPT}" --engine webkit --update --engine chromium
  [ "${status}" -eq 0 ]
  grep -qx 'update=1' "${CALLS}"
  grep -qx 'engines=webkit,chromium' "${CALLS}"
}

@test "web-screenshots: an unknown engine is a usage error" {
  run bash "${SCRIPT}" --engine safari
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"unknown engine: safari"* ]]
  [ ! -e "${CALLS}" ]
}

@test "web-screenshots: --engine without a value is a usage error" {
  run bash "${SCRIPT}" --engine
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"--engine needs a value"* ]]
  [ ! -e "${CALLS}" ]
}

@test "web-screenshots: the Android parity check runs only when Chromium does (#16534)" {
  run bash "${SCRIPT}" --engine firefox --engine webkit
  [ "${status}" -eq 0 ]
  grep -qx 'args=test test/features/prototype/web/webScreenshots.integration.test.ts' "${CALLS}"
  run bash "${SCRIPT}" --engine firefox --engine chromium
  [ "${status}" -eq 0 ]
  grep -q 'webAndroidParity.integration.test.ts' "${CALLS}"
}

@test "web-screenshots: --update --allow-grow lets a parity budget rise" {
  run bash "${SCRIPT}" --update --allow-grow
  [ "${status}" -eq 0 ]
  grep -qx 'update=1' "${CALLS}"
  grep -qx 'allow_grow=1' "${CALLS}"
}

@test "web-screenshots: --allow-grow without --update is a usage error" {
  run bash "${SCRIPT}" --allow-grow
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"--allow-grow needs --update"* ]]
  [ ! -e "${CALLS}" ]
}

@test "web-screenshots: --help documents the parity budgets" {
  run bash "${SCRIPT}" --help
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"android-parity-budgets.json"* ]]
  [[ "${output}" == *"--allow-grow"* ]]
}
