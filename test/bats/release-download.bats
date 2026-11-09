#!/usr/bin/env bats
# bats file_tags=parallel-within-file
#
# Tests for scripts/lib/release-download.sh (#17624): the checksum-verified tool
# cache, the bounded download backoff, and the upstream-failure marker.
# curl and sleep are stubbed, so no test touches the network or waits.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  LIB="$REPO_ROOT/scripts/lib/release-download.sh"
  STUB_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB_BIN"
  export CURL_LOG="$BATS_TEST_TMPDIR/curl.log"
  export SLEEP_LOG="$BATS_TEST_TMPDIR/sleep.log"
  export CURL_COUNT="$BATS_TEST_TMPDIR/curl.count"
  # One outcome per curl call (last one repeats): "ok" writes CURL_BODY,
  # an HTTP code fails the way `curl -f` does.
  export CURL_PLAN="ok"
  export CURL_BODY="pinned asset bytes"
  export AUTOMOBILE_TOOL_CACHE_DIR="$BATS_TEST_TMPDIR/cache"
  export RELEASE_DOWNLOAD_JITTER=false
  : > "$CURL_LOG"
  : > "$SLEEP_LOG"

  cat > "$STUB_BIN/curl" <<'STUB'
#!/usr/bin/env bash
out="" prev=""
for a in "$@"; do
  [[ "$prev" == "-o" ]] && out="$a"
  prev="$a"
done
echo "$*" >> "$CURL_LOG"
n=$(( $(cat "$CURL_COUNT" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$CURL_COUNT"
read -r -a plan <<< "$CURL_PLAN"
idx=$(( n - 1 < ${#plan[@]} ? n - 1 : ${#plan[@]} - 1 ))
outcome="${plan[$idx]}"
if [[ "$outcome" == ok ]]; then
  printf '%s' "$CURL_BODY" > "$out"
  exit 0
fi
echo "curl: (22) The requested URL returned error: ${outcome}" >&2
exit 22
STUB
  cat > "$STUB_BIN/sleep" <<'STUB'
#!/usr/bin/env bash
echo "$1" >> "$SLEEP_LOG"
STUB
  chmod +x "$STUB_BIN"/*
  export PATH="$STUB_BIN:$PATH"

  URL="https://github.com/example/tool/releases/download/v1.0/tool-1.0.jar"
  DEST="$BATS_TEST_TMPDIR/install/tool.jar"
  # Hash with the library's own helper: stock macOS has shasum but no sha256sum.
  printf '%s' "$CURL_BODY" > "$BATS_TEST_TMPDIR/body"
  GOOD_SHA="$(bash -c 'source "$1"; release_sha256_of "$2"' _ "$LIB" "$BATS_TEST_TMPDIR/body")"
  CACHE_FILE="$AUTOMOBILE_TOOL_CACHE_DIR/tool/1.0/$GOOD_SHA/tool-1.0.jar"
}

fetch() {
  # shellcheck source=scripts/lib/release-download.sh
  run bash -c 'source "$1"; release_fetch_pinned "$2" "$3" "$4" "$5"' _ "$LIB" "$URL" "$1" "$DEST" "tool/1.0"
}

curl_calls() { wc -l < "$CURL_LOG" | tr -d ' '; }

@test "a 5xx is retried with exponential backoff, then the verified asset is installed and cached" {
  export CURL_PLAN="504 502 ok"
  fetch "$GOOD_SHA"
  [ "$status" -eq 0 ]
  [ "$(curl_calls)" -eq 3 ]
  [ "$(paste -sd' ' "$SLEEP_LOG")" = "3 6" ]
  [ "$(cat "$DEST")" = "$CURL_BODY" ]
  [ "$(cat "$CACHE_FILE")" = "$CURL_BODY" ]
  [[ "$output" != *"UPSTREAM-DOWNLOAD-FAILURE"* ]]
  # Each attempt is time-bounded, and curl itself does not retry in a burst.
  grep -q -- "--connect-timeout" "$CURL_LOG"
  ! grep -q -- "--retry" "$CURL_LOG"
}

@test "a persistent 504 exhausts a bounded backoff and names the upstream failure" {
  export CURL_PLAN="504"
  fetch "$GOOD_SHA"
  [ "$status" -eq 1 ]
  [ "$(curl_calls)" -eq 6 ]
  [ "$(paste -sd' ' "$SLEEP_LOG")" = "3 6 12 24 24" ]
  [[ "$output" == *"UPSTREAM-DOWNLOAD-FAILURE: $URL failed after 6 attempts"* ]]
  [[ "$output" == *"returned error: 504"* ]]
  [ ! -e "$DEST" ]
  [ -z "$(find "$(dirname "$DEST")" -name '*.partial.*')" ]
}

@test "jitter stays within a quarter of the base delay" {
  # Retry 5 caps at 24 s; jitter may add up to 24/4 = 6 s.
  run env -u RELEASE_DOWNLOAD_JITTER bash -c 'source "$1"; for i in $(seq 1 50); do release_backoff_delay 5; done' _ "$LIB"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 50 ]
  [ "$(awk '$1 < 24 || $1 > 30' <<< "$output")" = "" ]
}

@test "a 404 fails at once without retrying or claiming an upstream outage" {
  export CURL_PLAN="404"
  fetch "$GOOD_SHA"
  [ "$status" -eq 1 ]
  [ "$(curl_calls)" -eq 1 ]
  [ ! -s "$SLEEP_LOG" ]
  [[ "$output" == *"HTTP 404; not retrying"* ]]
  [[ "$output" != *"UPSTREAM-DOWNLOAD-FAILURE"* ]]
}

@test "a downloaded asset whose checksum does not match the pin is neither installed nor cached" {
  fetch "0000000000000000000000000000000000000000000000000000000000000000"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Checksum mismatch"* && "$output" == *"Refusing to install"* ]]
  [ ! -e "$DEST" ]
  [ -z "$(find "$AUTOMOBILE_TOOL_CACHE_DIR" -type f 2>/dev/null)" ]
}

@test "a cache hit with a matching checksum skips the download" {
  mkdir -p "$(dirname "$CACHE_FILE")"
  printf '%s' "$CURL_BODY" > "$CACHE_FILE"
  export CURL_PLAN="500"
  fetch "$GOOD_SHA"
  [ "$status" -eq 0 ]
  [ "$(curl_calls)" -eq 0 ]
  [[ "$output" == *"Using cached tool-1.0.jar"* ]]
  [ "$(cat "$DEST")" = "$CURL_BODY" ]
}

@test "a corrupt cache entry is discarded, re-downloaded and verified" {
  mkdir -p "$(dirname "$CACHE_FILE")"
  printf 'tampered' > "$CACHE_FILE"
  fetch "$GOOD_SHA"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Checksum mismatch"* && "$output" == *"Discarding cached"* ]]
  [ "$(curl_calls)" -eq 1 ]
  [ "$(cat "$DEST")" = "$CURL_BODY" ]
  [ "$(cat "$CACHE_FILE")" = "$CURL_BODY" ]
}

@test "wget fallback: a 404 fails at once without the upstream-failure marker" {
  # Hide curl so the helper uses wget; GNU wget -nv reports "ERROR 404: Not Found." and exits 8.
  rm "$STUB_BIN/curl"
  cat > "$STUB_BIN/wget" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$CURL_LOG"
echo "https://example/x: 2026-11-09 06:00:00 ERROR 404: Not Found." >&2
exit 8
STUB
  chmod +x "$STUB_BIN/wget"
  # A PATH with no real curl: only the tools the helper needs, linked in.
  local tool
  for tool in bash mktemp cat tail grep rm; do
    ln -s "$(command -v "$tool")" "$STUB_BIN/$tool"
  done
  run env PATH="$STUB_BIN" bash -c 'source "$1"; release_download_with_backoff "$2" "$3"' _ "$LIB" "$URL" "$DEST"
  [ "$status" -eq 1 ]
  [ "$(curl_calls)" -eq 1 ]
  [ ! -s "$SLEEP_LOG" ]
  [[ "$output" == *"HTTP 404; not retrying"* ]]
  [[ "$output" != *"UPSTREAM-DOWNLOAD-FAILURE"* ]]
}

@test "installed assets get the umask default mode, not mktemp's 0600" {
  run bash -c 'umask 022; source "$1"; release_fetch_pinned "$2" "$3" "$4" "$5"' _ "$LIB" "$URL" "$GOOD_SHA" "$DEST" "tool/1.0"
  [ "$status" -eq 0 ]
  [ "$(ls -l "$DEST" | cut -c1-10)" = "-rw-r--r--" ]
  rm "$DEST"
  run bash -c 'umask 022; source "$1"; release_fetch_pinned "$2" "$3" "$4" "$5"' _ "$LIB" "$URL" "$GOOD_SHA" "$DEST" "tool/1.0"
  [[ "$output" == *"Using cached"* ]]
  [ "$(ls -l "$DEST" | cut -c1-10)" = "-rw-r--r--" ]
}
