#!/usr/bin/env bash
# Run the opt-in MediaMTX-backed WebRTC publisher integration test.
#
# The fast test suite discovers the test but skips it. This runner downloads the
# pinned MediaMTX release when AUTOMOBILE_MEDIAMTX_BINARY is not supplied, then
# enables the real SFU + FFmpeg + browser-decoder path explicitly.

set -euo pipefail

readonly MEDIAMTX_VERSION="1.19.2"
readonly TEST_FILE="${AUTOMOBILE_MEDIAMTX_TEST_FILE:-test/integration/mediamtxWebRtcPublisher.integration.test.ts}"
# The werift loopback suite shares the opt-in gate: its DTLS/ICE handshake runs
# over real UDP sockets, so it lives in this integration lane rather than the
# default `bun test` run (macos real-I/O hang class, #5391).
readonly LOOPBACK_TEST_FILE="test/features/webrtc/WebRtcPublisher.loopback.integration.test.ts"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cache_dir="${AUTOMOBILE_MEDIAMTX_CACHE_DIR:-${repo_root}/scratch/mediamtx}"

fail() {
  printf 'MediaMTX WebRTC integration: %s\n' "$*" >&2
  exit 1
}

# shellcheck source=scripts/lib/release-download.sh
source "${repo_root}/scripts/lib/release-download.sh"

# Run a command the way an `if` condition would (errexit is ignored inside it)
# and record its exit status in RUN_STATUS, so callers can branch on it without
# a function name in a condition.
RUN_STATUS=0
run_capture_status() {
  local run_rc=0
  "$@" || run_rc=$?
  RUN_STATUS="${run_rc}"
}

resolve_release() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "${os}:${arch}" in
    Darwin:arm64)
      mediamtx_asset="mediamtx_v${MEDIAMTX_VERSION}_darwin_arm64.tar.gz"
      mediamtx_sha256="c225e46ab65295f95ee9fcda75703129c07add8852483abda09299a78524391f"
      ;;
    Darwin:x86_64)
      mediamtx_asset="mediamtx_v${MEDIAMTX_VERSION}_darwin_amd64.tar.gz"
      mediamtx_sha256="b8851bf53d1e0d6d078240d54e78517a3a239b40040b22cddddf5a0ef2712c17"
      ;;
    Linux:aarch64 | Linux:arm64)
      mediamtx_asset="mediamtx_v${MEDIAMTX_VERSION}_linux_arm64.tar.gz"
      mediamtx_sha256="562f419912a8668c18216a9e8c95359ec82fbb754e4a44e2953ef62b98eec688"
      ;;
    Linux:x86_64 | Linux:amd64)
      mediamtx_asset="mediamtx_v${MEDIAMTX_VERSION}_linux_amd64.tar.gz"
      mediamtx_sha256="f9c601cc303ceca8fad2883917b022882672c5bc56311e92dbceb16e5f20c60c"
      ;;
    *)
      fail "no pinned MediaMTX ${MEDIAMTX_VERSION} binary for ${os}/${arch}; set AUTOMOBILE_MEDIAMTX_BINARY"
      ;;
  esac
}

download_mediamtx() {
  resolve_release
  local install_dir archive
  install_dir="${cache_dir}/v${MEDIAMTX_VERSION}/${mediamtx_asset%.tar.gz}"
  mediamtx_binary="${install_dir}/mediamtx"
  if [[ -x "${mediamtx_binary}" ]]; then
    return
  fi

  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 \
    || fail "curl or wget is required to download MediaMTX; set AUTOMOBILE_MEDIAMTX_BINARY instead"
  command -v tar >/dev/null 2>&1 || fail "tar is required to extract MediaMTX; set AUTOMOBILE_MEDIAMTX_BINARY instead"
  mkdir -p "${install_dir}"
  archive="${cache_dir}/.${mediamtx_asset}.$$"
  trap 'rm -f "${archive}"' RETURN
  # Reuses a cached archive whose SHA-256 matches the pin, else downloads with a
  # bounded backoff (UPSTREAM-DOWNLOAD-FAILURE marker on a GitHub outage) and
  # verifies the checksum before extracting or caching it (#17641).
  run_capture_status release_fetch_pinned \
    "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/${mediamtx_asset}" \
    "${mediamtx_sha256}" "${archive}" "mediamtx/${MEDIAMTX_VERSION}"
  if [[ "${RUN_STATUS}" -ne 0 ]]; then
    fail "could not fetch a MediaMTX ${MEDIAMTX_VERSION} archive matching the pinned checksum ${mediamtx_sha256}"
  fi
  tar -xzf "${archive}" -C "${install_dir}"
  [[ -x "${mediamtx_binary}" ]] || fail "MediaMTX archive did not contain an executable at ${mediamtx_binary}"
}

if [[ -n "${AUTOMOBILE_MEDIAMTX_BINARY:-}" ]]; then
  mediamtx_binary="${AUTOMOBILE_MEDIAMTX_BINARY}"
  [[ -x "${mediamtx_binary}" ]] || fail "AUTOMOBILE_MEDIAMTX_BINARY is not executable: ${mediamtx_binary}"
else
  download_mediamtx
fi

mediamtx_binary="$(cd "$(dirname "${mediamtx_binary}")" && pwd -P)/$(basename "${mediamtx_binary}")"

cd "${repo_root}"
AUTOMOBILE_MEDIAMTX_WEBRTC_INTEGRATION=1 \
AUTOMOBILE_MEDIAMTX_BINARY="${mediamtx_binary}" \
  exec bun test "${TEST_FILE}" "${LOOPBACK_TEST_FILE}"
