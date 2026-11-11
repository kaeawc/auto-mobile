#!/usr/bin/env bats
# bats file_tags=parallel-within-file
#
# Tests for scripts/act/install_act.sh's pinned Linux release install (#17641):
# checksum-verified cache reuse, bounded retry on a GitHub release 5xx with the
# upstream-failure marker, and the per-asset checksum pin. uname, curl,
# sha256sum and sleep are stubbed and PATH is limited to system directories, so
# nothing touches the network, the real HOME, or an act the host already has.

setup() {
  # The macOS branch installs act with Homebrew; only the Linux download is pinned.
  [[ "$OSTYPE" == linux* ]] || skip "install_act.sh downloads a release only on Linux"
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/act/install_act.sh"
  STUB_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB_BIN"
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  unset AUTOMOBILE_TOOL_CACHE_DIR XDG_CACHE_HOME
  export RELEASE_DOWNLOAD_ATTEMPTS=4 RELEASE_DOWNLOAD_JITTER=false
  export CURL_LOG="$BATS_TEST_TMPDIR/curl.log"
  export SLEEP_LOG="$BATS_TEST_TMPDIR/sleep.log"
  : > "$CURL_LOG"
  : > "$SLEEP_LOG"

  # shellcheck source=scripts/act/act_version.sh
  source "$REPO_ROOT/scripts/act/act_version.sh"
  ASSET="act_Linux_x86_64.tar.gz"
  export PINNED_SHA256
  PINNED_SHA256="$(act_release_sha256 "$ASSET")"
  CACHE_DIR="$HOME/.cache/auto-mobile/tools/act/${ACT_VERSION}/${PINNED_SHA256}"
  ASSET_URL="https://github.com/nektos/act/releases/download/v${ACT_VERSION}/${ASSET}"

  export FAKE_ARCHIVE="$BATS_TEST_TMPDIR/$ASSET"
  local src="$BATS_TEST_TMPDIR/archive-src"
  mkdir -p "$src"
  printf '#!/bin/sh\necho "act version %s"\n' "$ACT_VERSION" > "$src/act"
  chmod +x "$src/act"
  tar -czf "$FAKE_ARCHIVE" -C "$src" act

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
cp "$FAKE_ARCHIVE" "$out"
STUB
  # A fixture archive cannot hash to the real pin; report the pin unless
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
  export PATH="$STUB_BIN:/usr/bin:/bin"
}

@test "every architecture the installer maps has a pinned checksum" {
  [[ "$(act_release_sha256 act_Linux_x86_64.tar.gz)" =~ ^[0-9a-f]{64}$ ]]
  [[ "$(act_release_sha256 act_Linux_arm64.tar.gz)" =~ ^[0-9a-f]{64}$ ]]
  ! act_release_sha256 act_Linux_riscv64.tar.gz
}

@test "download verifies, caches and installs the pinned act archive" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$CURL_LOG")" -eq 1 ]
  [[ "$(cat "$CURL_LOG")" == *"$ASSET_URL"* ]]
  [ -x "$HOME/bin/act" ]
  [ -f "$CACHE_DIR/$ASSET" ]
  [[ "$output" == *"act ${ACT_VERSION} installed successfully!"* ]]
}

@test "arm64 hosts fetch the arm64 asset" {
  export PINNED_SHA256
  PINNED_SHA256="$(act_release_sha256 act_Linux_arm64.tar.gz)"
  run env UNAME_M=aarch64 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$(cat "$CURL_LOG")" == *"/act_Linux_arm64.tar.gz"* ]]
}

@test "a cached archive with the pinned checksum installs while GitHub returns 504" {
  mkdir -p "$CACHE_DIR"
  cp "$FAKE_ARCHIVE" "$CACHE_DIR/$ASSET"
  run env CURL_FAIL_HTTP=504 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ ! -s "$CURL_LOG" ]
  [[ "$output" == *"Using cached $ASSET"* ]]
  [ -x "$HOME/bin/act" ]
}

@test "a GitHub 504 retries with backoff and ends in the upstream-failure marker" {
  run env CURL_FAIL_HTTP=504 bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [ "$(wc -l < "$CURL_LOG")" -eq 4 ]
  [ "$(paste -sd, "$SLEEP_LOG")" = "3,6,12" ]
  [[ "$output" == *"UPSTREAM-DOWNLOAD-FAILURE: ${ASSET_URL} failed after 4 attempts"* ]]
  [ ! -e "$HOME/bin/act" ]
}

@test "a 404 fails at once without the upstream-failure marker" {
  run env CURL_FAIL_HTTP=404 bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [ "$(wc -l < "$CURL_LOG")" -eq 1 ]
  [ ! -s "$SLEEP_LOG" ]
  [[ "$output" != *"UPSTREAM-DOWNLOAD-FAILURE"* ]]
}

@test "an archive whose checksum does not match the pin is rejected" {
  run env FAKE_SHA256=deadbeef bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Checksum mismatch"* ]]
  [ ! -e "$HOME/bin/act" ]
  [ ! -e "$CACHE_DIR/$ASSET" ]
}
