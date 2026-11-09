#!/usr/bin/env bats
# bats file_tags=parallel-within-file
#
# Tests for scripts/shellcheck/install_shfmt.sh's pinned binary install (#17624):
# checksum-verified cache reuse, bounded retry on a GitHub release 5xx, and the
# per-platform checksum pin. uname, curl, sha256sum and sleep are stubbed, so
# nothing touches the network or the real HOME.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/shellcheck/install_shfmt.sh"
  STUB_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB_BIN"
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  unset AUTOMOBILE_TOOL_CACHE_DIR XDG_CACHE_HOME
  export CURL_LOG="$BATS_TEST_TMPDIR/curl.log"
  export SLEEP_LOG="$BATS_TEST_TMPDIR/sleep.log"
  : > "$CURL_LOG"
  : > "$SLEEP_LOG"

  # shellcheck source=scripts/shellcheck/shfmt_version.sh
  source "$REPO_ROOT/scripts/shellcheck/shfmt_version.sh"
  export PINNED_SHA256
  PINNED_SHA256="$(shfmt_release_sha256 linux_amd64)"
  CACHE_DIR="$HOME/.cache/auto-mobile/tools/shfmt/${SHFMT_VERSION}/${PINNED_SHA256}"
  ASSET="shfmt_v${SHFMT_VERSION}_linux_amd64"

  cat > "$STUB_BIN/uname" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "-m" ]]; then echo "${UNAME_M:-x86_64}"; else echo Linux; fi
STUB
  cat > "$STUB_BIN/curl" <<'STUB'
#!/usr/bin/env bash
out="" prev=""
for a in "$@"; do
  [[ "$prev" == "-o" ]] && out="$a"
  prev="$a"
done
echo "$*" >> "$CURL_LOG"
if [[ -n "${CURL_FAIL_HTTP:-}" ]]; then
  echo "curl: (22) The requested URL returned error: ${CURL_FAIL_HTTP}" >&2
  exit 22
fi
printf '#!/bin/sh\necho v3.10.0\n' > "$out"
STUB
  # A stub binary cannot hash to the real pin; report the pin unless
  # FAKE_SHA256 models a corrupt asset.
  cat > "$STUB_BIN/sha256sum" <<'STUB'
#!/usr/bin/env bash
echo "${FAKE_SHA256:-$PINNED_SHA256}  $1"
STUB
  cat > "$STUB_BIN/sleep" <<'STUB'
#!/usr/bin/env bash
echo "$1" >> "$SLEEP_LOG"
STUB
  chmod +x "$STUB_BIN"/*
  export PATH="$STUB_BIN:$PATH"
}

@test "every shfmt asset the installer can request has a pinned checksum" {
  for platform in darwin_amd64 darwin_arm64 linux_386 linux_amd64 linux_arm linux_arm64 windows_386 windows_amd64; do
    [[ "$(shfmt_release_sha256 "$platform")" =~ ^[0-9a-f]{64}$ ]]
  done
  ! shfmt_release_sha256 plan9_amd64
}

@test "a cached binary with the pinned checksum installs without downloading" {
  mkdir -p "$CACHE_DIR"
  printf '#!/bin/sh\necho v3.10.0\n' > "$CACHE_DIR/$ASSET"
  run env CURL_FAIL_HTTP=504 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ ! -s "$CURL_LOG" ]
  [[ "$output" == *"Using cached $ASSET"* ]]
  [ -x "$HOME/.local/bin/shfmt" ]
}

@test "a download is verified, installed and cached for the next run" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -q "releases/download/v${SHFMT_VERSION}/${ASSET}" "$CURL_LOG"
  [ -x "$HOME/.local/bin/shfmt" ]
  [ -s "$CACHE_DIR/$ASSET" ]
}

@test "a GitHub 504 is retried with backoff and reported as an upstream failure" {
  run env CURL_FAIL_HTTP=504 RELEASE_DOWNLOAD_ATTEMPTS=4 RELEASE_DOWNLOAD_JITTER=false bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [ "$(wc -l < "$CURL_LOG" | tr -d ' ')" -eq 4 ]
  [ "$(paste -sd' ' "$SLEEP_LOG")" = "3 6 12" ]
  [[ "$output" == *"UPSTREAM-DOWNLOAD-FAILURE: https://github.com/mvdan/sh/releases/download/v${SHFMT_VERSION}/${ASSET} failed after 4 attempts"* ]]
  [[ "$output" == *"Installation failed!"* ]]
  [ ! -e "$HOME/.local/bin/shfmt" ]
}

@test "a downloaded binary whose checksum differs from the pin is rejected" {
  run env FAKE_SHA256=deadbeef bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Checksum mismatch"* ]]
  [ ! -e "$HOME/.local/bin/shfmt" ]
  [ ! -e "$CACHE_DIR/$ASSET" ]
}
