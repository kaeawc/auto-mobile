#!/usr/bin/env bats
#
# Contract tests for the opt-in MediaMTX publisher -> WHEP decoder integration
# runner. The real media path is intentionally outside the fast BATS suite.

SCRIPT="scripts/webrtc/run-mediamtx-publisher-integration.sh"
TEST_FILE="test/integration/mediamtxWebRtcPublisher.integration.test.ts"
LOOPBACK_TEST_FILE="test/features/webrtc/WebRtcPublisher.loopback.test.ts"

setup() {
  TEST_DIR="$(mktemp -d)"
  MOCK_BIN="${TEST_DIR}/bin"
  INVOCATIONS_FILE="${TEST_DIR}/invocations"
  ABS="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  mkdir -p "${MOCK_BIN}"
  ORIG_PATH="${PATH}"
}

teardown() {
  rm -rf "${TEST_DIR}"
  export PATH="${ORIG_PATH}"
}

make_bun_stub() {
  cat > "${MOCK_BIN}/bun" <<'SCRIPT'
#!/usr/bin/env bash
printf 'gate=%s binary=%s args=%s\n' \
  "${AUTOMOBILE_MEDIAMTX_WEBRTC_INTEGRATION:-}" \
  "${AUTOMOBILE_MEDIAMTX_BINARY:-}" \
  "$*" >> "${INVOCATIONS_FILE}"
SCRIPT
  chmod +x "${MOCK_BIN}/bun"
}

@test "runner is executable and package.json exposes it" {
  [ -x "${SCRIPT}" ]
  run bun -e 'const pkg = require("./package.json"); process.exit(pkg.scripts["test:integration:webrtc-mediamtx"] ? 0 : 1);'
  [ "${status}" -eq 0 ]
}

@test "injected MediaMTX binary is forwarded to the opt-in test without downloading" {
  make_bun_stub
  local binary="${TEST_DIR}/mediamtx"
  cat > "${binary}" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
  chmod +x "${binary}"
  local resolved_binary="$(cd "$(dirname "${binary}")" && pwd -P)/$(basename "${binary}")"

  run env \
    PATH="${MOCK_BIN}:${PATH}" \
    AUTOMOBILE_MEDIAMTX_BINARY="${binary}" \
    INVOCATIONS_FILE="${INVOCATIONS_FILE}" \
    bash "${ABS}"

  [ "${status}" -eq 0 ]
  [ "$(cat "${INVOCATIONS_FILE}")" = "gate=1 binary=${resolved_binary} args=test ${TEST_FILE} ${LOOPBACK_TEST_FILE}" ]
}

@test "runner resolves an injected relative MediaMTX binary before forwarding it" {
  make_bun_stub
  local binary="${TEST_DIR}/mediamtx"
  cat > "${binary}" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
  chmod +x "${binary}"
  local resolved_binary="$(cd "$(dirname "${binary}")" && pwd -P)/$(basename "${binary}")"

  cd "${TEST_DIR}"
  run env \
    PATH="${MOCK_BIN}:${PATH}" \
    AUTOMOBILE_MEDIAMTX_BINARY="./mediamtx" \
    INVOCATIONS_FILE="${INVOCATIONS_FILE}" \
    bash "${ABS}"

  [ "${status}" -eq 0 ]
  [ "$(cat "${INVOCATIONS_FILE}")" = "gate=1 binary=${resolved_binary} args=test ${TEST_FILE} ${LOOPBACK_TEST_FILE}" ]
}

@test "download path rejects a MediaMTX archive whose pinned checksum does not match" {
  make_bun_stub
  cat > "${MOCK_BIN}/uname" <<'SCRIPT'
#!/usr/bin/env bash
if [[ "$1" == "-s" ]]; then
  printf '%s\n' Darwin
else
  printf '%s\n' arm64
fi
SCRIPT
  cat > "${MOCK_BIN}/curl" <<'SCRIPT'
#!/usr/bin/env bash
for ((index = 1; index <= $#; index++)); do
  if [[ "${!index}" == "--output" ]]; then
    next=$((index + 1))
    printf 'untrusted archive' > "${!next}"
    exit 0
  fi
done
exit 1
SCRIPT
  cat > "${MOCK_BIN}/sha256sum" <<'SCRIPT'
#!/usr/bin/env bash
printf '%064d  %s\n' 0 "$1"
SCRIPT
  chmod +x "${MOCK_BIN}/uname" "${MOCK_BIN}/curl" "${MOCK_BIN}/sha256sum"

  run env \
    PATH="${MOCK_BIN}:${PATH}" \
    AUTOMOBILE_MEDIAMTX_CACHE_DIR="${TEST_DIR}/cache" \
    INVOCATIONS_FILE="${INVOCATIONS_FILE}" \
    bash "${SCRIPT}"

  [ "${status}" -eq 1 ]
  [[ "${output}" == *"checksum mismatch"* ]]
  [ ! -e "${INVOCATIONS_FILE}" ]
}
