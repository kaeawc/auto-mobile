#!/usr/bin/env bats
#
# Contract tests for the opt-in MediaMTX publisher -> WHEP decoder integration
# runner. The real media path is intentionally outside the fast BATS suite.

SCRIPT="scripts/webrtc/run-mediamtx-publisher-integration.sh"
TEST_FILE="test/integration/mediamtxWebRtcPublisher.integration.test.ts"
LOOPBACK_TEST_FILE="test/features/webrtc/WebRtcPublisher.loopback.integration.test.ts"

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
  if [[ "${!index}" == "-o" ]]; then
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
  [[ "${output}" == *"Checksum mismatch"* ]]
  [[ "${output}" == *"could not fetch a MediaMTX"* ]]
  [ ! -e "${INVOCATIONS_FILE}" ]
}

make_linux_download_stubs() {
  cat > "${MOCK_BIN}/uname" <<'SCRIPT'
#!/usr/bin/env bash
if [[ "$1" == "-s" ]]; then printf '%s\n' Linux; else printf '%s\n' x86_64; fi
SCRIPT
  # A release-shaped archive whose mediamtx binary is executable.
  local src="${TEST_DIR}/archive-src"
  mkdir -p "${src}"
  printf '#!/bin/sh\nexit 0\n' > "${src}/mediamtx"
  chmod +x "${src}/mediamtx"
  FAKE_ARCHIVE="${TEST_DIR}/fake.tar.gz"
  tar -czf "${FAKE_ARCHIVE}" -C "${src}" mediamtx
  cat > "${MOCK_BIN}/curl" <<'SCRIPT'
#!/usr/bin/env bash
out="" prev=""
for a in "$@"; do
  [[ "$prev" == "-o" ]] && out="$a"
  prev="$a"
done
echo "$*" >> "${CURL_LOG}"
if [[ -n "${CURL_FAIL_HTTP:-}" ]]; then
  echo "curl: (22) The requested URL returned error: ${CURL_FAIL_HTTP}" >&2
  exit 22
fi
cp "${FAKE_ARCHIVE}" "$out"
SCRIPT
  # The fixture cannot hash to the real pin, so report the Linux x86_64 pin.
  cat > "${MOCK_BIN}/sha256sum" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s  %s\n' f9c601cc303ceca8fad2883917b022882672c5bc56311e92dbceb16e5f20c60c "$1"
SCRIPT
  cat > "${MOCK_BIN}/sleep" <<'SCRIPT'
#!/usr/bin/env bash
echo "$1" >> "${SLEEP_LOG}"
SCRIPT
  chmod +x "${MOCK_BIN}/uname" "${MOCK_BIN}/curl" "${MOCK_BIN}/sha256sum" "${MOCK_BIN}/sleep"
  CURL_LOG="${TEST_DIR}/curl.log"
  SLEEP_LOG="${TEST_DIR}/sleep.log"
  : > "${CURL_LOG}"
  : > "${SLEEP_LOG}"
}

run_download() {
  run env \
    PATH="${MOCK_BIN}:${PATH}" \
    AUTOMOBILE_MEDIAMTX_CACHE_DIR="${TEST_DIR}/install" \
    AUTOMOBILE_TOOL_CACHE_DIR="${TEST_DIR}/tools" \
    RELEASE_DOWNLOAD_ATTEMPTS=4 RELEASE_DOWNLOAD_JITTER=false \
    INVOCATIONS_FILE="${INVOCATIONS_FILE}" FAKE_ARCHIVE="${FAKE_ARCHIVE}" \
    CURL_LOG="${CURL_LOG}" SLEEP_LOG="${SLEEP_LOG}" \
    "$@" bash "${ABS}"
}

@test "download path verifies, caches and installs the pinned MediaMTX archive" {
  make_bun_stub
  make_linux_download_stubs

  run_download
  [ "${status}" -eq 0 ]
  [ "$(wc -l < "${CURL_LOG}")" -eq 1 ]
  [ -x "${TEST_DIR}/install/v1.19.2/mediamtx_v1.19.2_linux_amd64/mediamtx" ]
  [ -f "${TEST_DIR}/tools/mediamtx/1.19.2/f9c601cc303ceca8fad2883917b022882672c5bc56311e92dbceb16e5f20c60c/mediamtx_v1.19.2_linux_amd64.tar.gz" ]
  [[ "$(cat "${INVOCATIONS_FILE}")" == "gate=1 binary="*"/mediamtx args=test "* ]]
}

@test "a cached MediaMTX archive installs while GitHub returns 504" {
  make_bun_stub
  make_linux_download_stubs
  local cached="${TEST_DIR}/tools/mediamtx/1.19.2/f9c601cc303ceca8fad2883917b022882672c5bc56311e92dbceb16e5f20c60c"
  mkdir -p "${cached}"
  cp "${FAKE_ARCHIVE}" "${cached}/mediamtx_v1.19.2_linux_amd64.tar.gz"

  run_download CURL_FAIL_HTTP=504
  [ "${status}" -eq 0 ]
  [ ! -s "${CURL_LOG}" ]
  [[ "${output}" == *"Using cached mediamtx_v1.19.2_linux_amd64.tar.gz"* ]]
  [ -x "${TEST_DIR}/install/v1.19.2/mediamtx_v1.19.2_linux_amd64/mediamtx" ]
}

@test "a GitHub 504 retries with backoff and ends in the upstream-failure marker" {
  make_bun_stub
  make_linux_download_stubs

  run_download CURL_FAIL_HTTP=504
  [ "${status}" -eq 1 ]
  [ "$(wc -l < "${CURL_LOG}")" -eq 4 ]
  [ "$(paste -sd, "${SLEEP_LOG}")" = "3,6,12" ]
  [[ "${output}" == *"UPSTREAM-DOWNLOAD-FAILURE: https://github.com/bluenviron/mediamtx/releases/download/v1.19.2/mediamtx_v1.19.2_linux_amd64.tar.gz failed after 4 attempts"* ]]
  [ ! -e "${INVOCATIONS_FILE}" ]
}

@test "a 404 fails at once without the upstream-failure marker" {
  make_bun_stub
  make_linux_download_stubs

  run_download CURL_FAIL_HTTP=404
  [ "${status}" -eq 1 ]
  [ "$(wc -l < "${CURL_LOG}")" -eq 1 ]
  [ ! -s "${SLEEP_LOG}" ]
  [[ "${output}" != *"UPSTREAM-DOWNLOAD-FAILURE"* ]]
}
