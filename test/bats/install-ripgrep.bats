#!/usr/bin/env bats
# bats file_tags=parallel-within-file
#
# Tests for .github/actions/setup-ripgrep/install-ripgrep.sh's pinned archive
# install (#17624): checksum-verified cache reuse, bounded retry on a GitHub
# release 5xx with the upstream-failure marker, and the per-platform checksum
# pin. uname, curl, sha256sum and sleep are stubbed, so nothing touches the
# network or the real HOME.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/.github/actions/setup-ripgrep/install-ripgrep.sh"
  STUB_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB_BIN"
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  unset AUTOMOBILE_TOOL_CACHE_DIR XDG_CACHE_HOME
  export CURL_LOG="$BATS_TEST_TMPDIR/curl.log"
  export SLEEP_LOG="$BATS_TEST_TMPDIR/sleep.log"
  : > "$CURL_LOG"
  : > "$SLEEP_LOG"

  # shellcheck source=.github/actions/setup-ripgrep/ripgrep_version.sh
  source "$REPO_ROOT/.github/actions/setup-ripgrep/ripgrep_version.sh"
  TARGET="x86_64-unknown-linux-musl"
  export PINNED_SHA256
  PINNED_SHA256="$(ripgrep_release_sha256 "$TARGET")"
  ASSET="ripgrep-${RIPGREP_VERSION}-${TARGET}.tar.gz"
  CACHE_DIR="$HOME/.cache/auto-mobile/tools/ripgrep/${RIPGREP_VERSION}/${PINNED_SHA256}"
  ASSET_URL="https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${ASSET}"

  # A release-shaped archive whose rg prints the pinned version.
  export FAKE_ARCHIVE="$BATS_TEST_TMPDIR/$ASSET"
  local src="$BATS_TEST_TMPDIR/archive-src/ripgrep-${RIPGREP_VERSION}-${TARGET}"
  mkdir -p "$src"
  printf '#!/bin/sh\necho "ripgrep %s"\n' "$RIPGREP_VERSION" > "$src/rg"
  chmod +x "$src/rg"
  tar -czf "$FAKE_ARCHIVE" -C "$BATS_TEST_TMPDIR/archive-src" "ripgrep-${RIPGREP_VERSION}-${TARGET}"

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
  export PATH="$STUB_BIN:$PATH"
}

@test "every ripgrep asset the installer can request has a pinned checksum" {
  for target in x86_64-unknown-linux-musl aarch64-unknown-linux-gnu x86_64-apple-darwin aarch64-apple-darwin x86_64-pc-windows-msvc aarch64-pc-windows-msvc; do
    [[ "$(ripgrep_release_sha256 "$target")" =~ ^[0-9a-f]{64}$ ]]
  done
  ! ripgrep_release_sha256 riscv64-unknown-linux-gnu
}

@test "the action defaults to the pinned version and keys its cache on the pin file" {
  action="$REPO_ROOT/.github/actions/setup-ripgrep/action.yml"
  grep -q 'default: ""' "$action"
  grep -q "hashFiles('.github/actions/setup-ripgrep/ripgrep_version.sh')" "$action"
  grep -q 'path: ~/.cache/auto-mobile/tools/ripgrep' "$action"
}

@test "a cached archive with the pinned checksum installs without downloading" {
  mkdir -p "$CACHE_DIR"
  cp "$FAKE_ARCHIVE" "$CACHE_DIR/$ASSET"
  run env CURL_FAIL_HTTP=504 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ ! -s "$CURL_LOG" ]
  [[ "$output" == *"Using cached $ASSET"* ]]
  [ -x "$HOME/.local/bin/rg" ]
}

@test "a download is verified, installed and cached for the next run" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -qF "$ASSET_URL" "$CURL_LOG"
  [ -x "$HOME/.local/bin/rg" ]
  [ -s "$CACHE_DIR/$ASSET" ]
  [[ "$output" == *"ripgrep ${RIPGREP_VERSION}"* ]]
}

@test "a GitHub 504 is retried with backoff and reported as an upstream failure" {
  run env CURL_FAIL_HTTP=504 RELEASE_DOWNLOAD_ATTEMPTS=4 RELEASE_DOWNLOAD_JITTER=false bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [ "$(wc -l < "$CURL_LOG" | tr -d ' ')" -eq 4 ]
  [ "$(paste -sd' ' "$SLEEP_LOG")" = "3 6 12" ]
  [[ "$output" == *"UPSTREAM-DOWNLOAD-FAILURE: ${ASSET_URL} failed after 4 attempts"* ]]
  [ ! -e "$HOME/.local/bin/rg" ]
}

@test "a downloaded archive whose checksum differs from the pin is rejected" {
  run env FAKE_SHA256=deadbeef bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Checksum mismatch"* ]]
  [ ! -e "$HOME/.local/bin/rg" ]
  [ ! -e "$CACHE_DIR/$ASSET" ]
}

@test "a version without a pinned checksum is refused before any download" {
  run bash "$SCRIPT" --version 14.0.0
  [ "$status" -ne 0 ]
  [[ "$output" == *"No pinned checksum for ripgrep 14.0.0"* ]]
  [ ! -s "$CURL_LOG" ]
}
