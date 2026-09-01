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

sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${file}" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "${file}" | awk '{print $2}'
  else
    fail "need sha256sum, shasum, or openssl to verify MediaMTX"
  fi
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
  local install_dir archive actual_sha
  install_dir="${cache_dir}/v${MEDIAMTX_VERSION}/${mediamtx_asset%.tar.gz}"
  mediamtx_binary="${install_dir}/mediamtx"
  if [[ -x "${mediamtx_binary}" ]]; then
    return
  fi

  command -v curl >/dev/null 2>&1 || fail "curl is required to download MediaMTX; set AUTOMOBILE_MEDIAMTX_BINARY instead"
  command -v tar >/dev/null 2>&1 || fail "tar is required to extract MediaMTX; set AUTOMOBILE_MEDIAMTX_BINARY instead"
  mkdir -p "${install_dir}"
  archive="$(mktemp "${cache_dir}/.${mediamtx_asset}.XXXXXX")"
  trap 'rm -f "${archive}"' RETURN
  curl --fail --location --retry 3 --output "${archive}" \
    "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/${mediamtx_asset}"
  actual_sha="$(sha256_of "${archive}")"
  [[ "${actual_sha}" == "${mediamtx_sha256}" ]] || fail "downloaded MediaMTX checksum mismatch (wanted ${mediamtx_sha256}, got ${actual_sha})"
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
