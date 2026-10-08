#!/usr/bin/env bats
# Offline regression coverage for CircleCI artifact indexing/blob races (#8991).

SCRIPT="scripts/ci/fetch-circleci-swift-badge.sh"
WORKFLOW=".github/workflows/merge.yml"

setup() {
  TEST_ROOT="$(mktemp -d)"
  BIN_DIR="${TEST_ROOT}/bin"
  OUTPUT_PATH="${TEST_ROOT}/coverage/swift-coverage-badge.json"
  mkdir -p "$BIN_DIR"

  # Separate listing/download counters and configurable comma-separated results.
  # Every listing returns a new URL; the fake rejects use of a stale URL.
  cat > "${BIN_DIR}/curl" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
url='' output_file='' write_status=0 fail_http=0 token_header=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -H)
      [[ "$2" == "Circle-Token: $CIRCLECI_TOKEN" ]] || exit 90
      token_header=$((token_header + 1)); shift 2 ;;
    -o) output_file="$2"; shift 2 ;;
    -w) [[ "$2" == '%{http_code}' ]] || exit 91; write_status=1; shift 2 ;;
    --retry|--retry-delay|--connect-timeout|--max-time) shift 2 ;;
    -fsS|-fsSL) fail_http=1; shift ;;
    -sSL) shift ;;
    https://*) url="$1"; shift ;;
    *) exit 92 ;;
  esac
done
[[ "$token_header" -eq 1 ]] || exit 93
[[ ! -e "$FAKE_OUTPUT_PATH" ]] || exit 94

if [[ "$url" == 'https://circleci.test/api/v2/project/gh/kaeawc/auto-mobile/123/artifacts' ]]; then
  kind=listing
  sequence="${FAKE_LIST_SEQUENCE:-ok}"
else
  kind=download
  sequence="${FAKE_DOWNLOAD_SEQUENCE:-ok}"
  listing_count="$(cat "$FAKE_ROOT/listing.count")"
  [[ "$url" == "https://artifacts.test/badge/$listing_count" ]] || exit 95
fi
counter="$FAKE_ROOT/$kind.count"
n="$(cat "$counter" 2>/dev/null || echo 0)"
n=$((n + 1))
echo "$n" > "$counter"
echo "$kind:$n" >> "$FAKE_ROOT/calls"
IFS=, read -r -a results <<< "$sequence"
index=$((n - 1))
if ((index >= ${#results[@]})); then index=$((${#results[@]} - 1)); fi
result="${results[$index]}"

if [[ "$kind" == listing ]]; then
  case "$result" in
    error) echo "listing diagnostic: $CIRCLECI_TOKEN" >&2; exit 22 ;;
    invalid) echo "invalid listing: $CIRCLECI_TOKEN" ;;
    empty) echo '{"items":[]}' ;;
    ok)
      printf '{"items":[{"path":"coverage/swift-coverage-badge.json.extra","url":"https://artifacts.test/wrong"},{"path":"prefix/coverage/swift-coverage-badge.json","url":"https://artifacts.test/badge/%s"},{"path":"coverage/swift-coverage-badge.json","url":"https://artifacts.test/wrong"}]}' "$n" ;;
    *) exit 96 ;;
  esac
  exit 0
fi

case "$result" in
  ok) http=200; body='{"schemaVersion":1,"label":"coverage","message":"90%"}' ;;
  invalid) http=200; body="invalid badge: $CIRCLECI_TOKEN" ;;
  404|503) http="$result"; body='{"error":"not available"}' ;;
  transport) http=000; body='partial' ;;
  *) exit 97 ;;
esac
[[ -n "$output_file" ]] || exit 98
printf '%s\n' "$body" > "$output_file"
if [[ "$write_status" -eq 1 ]]; then printf '%s' "$http"; fi
if [[ "$result" == transport ]]; then
  echo "download diagnostic: $CIRCLECI_TOKEN" >&2
  exit 7
fi
# Model curl -f's exit 22 for HTTP 404: --retry does not retry this status.
if [[ "$fail_http" -eq 1 && "$http" == 404 ]]; then exit 22; fi
FAKE
  chmod +x "${BIN_DIR}/curl"
  # Record waits without consuming real time, including the default backoff test.
  cat > "${BIN_DIR}/sleep" <<'FAKE'
#!/usr/bin/env bash
echo "$1" >> "$FAKE_ROOT/sleeps"
FAKE
  chmod +x "${BIN_DIR}/sleep"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

run_fetch() {
  run env PATH="${BIN_DIR}:${PATH}" CIRCLECI_TOKEN='secret-never-print-8991' \
    FAKE_ROOT="$TEST_ROOT" FAKE_OUTPUT_PATH="$OUTPUT_PATH" BADGE_RETRY_SLEEP=0 "$@" \
    bash "$SCRIPT" https://circleci.test/api/v2 project/gh/kaeawc/auto-mobile 123 "$OUTPUT_PATH"
}

assert_success() {
  [ "$status" -eq 0 ]
  jq -e '.message == "90%"' "$OUTPUT_PATH" >/dev/null
  [[ "$output" != *'secret-never-print-8991'* ]]
  [ -z "$(find "${TEST_ROOT}/coverage" -name '*.tmp.*' -print)" ]
}

@test "fetches the first suffix-matching badge on the first attempt" {
  run_fetch
  assert_success
  [ "$(cat "$TEST_ROOT/calls")" = $'listing:1\ndownload:1' ]
  [[ "$output" == *'attempt 1/7'* ]]
  [ -x "$SCRIPT" ]
}

@test "re-lists after a download 404 and succeeds with a fresh URL" {
  run_fetch FAKE_DOWNLOAD_SEQUENCE=404,ok
  assert_success
  [[ "$output" == *'download HTTP 404'* ]]
  [ "$(cat "$TEST_ROOT/calls")" = $'listing:1\ndownload:1\nlisting:2\ndownload:2' ]
}

@test "retries an empty artifact listing before downloading" {
  run_fetch FAKE_LIST_SEQUENCE=empty,ok
  assert_success
  [[ "$output" == *'has no Swift coverage badge artifact'* ]]
  [ "$(cat "$TEST_ROOT/calls")" = $'listing:1\nlisting:2\ndownload:1' ]
}

@test "exits 3 when every attempt lists no badge artifact so callers can skip" {
  run_fetch BADGE_RETRY_SLEEP=0 FAKE_LIST_SEQUENCE=empty,empty,empty,empty,empty,empty,empty
  [ "$status" -eq 3 ]
  [[ "$output" == *'published no Swift coverage badge artifact'* ]]
  [ ! -e "$OUTPUT_PATH" ]
}

@test "re-lists after invalid badge JSON without publishing invalid content" {
  run_fetch FAKE_DOWNLOAD_SEQUENCE=invalid,ok
  assert_success
  [[ "$output" == *'HTTP 200: invalid JSON'* ]]
  [ "$(cat "$TEST_ROOT/listing.count")" -eq 2 ]
  [ "$(cat "$TEST_ROOT/download.count")" -eq 2 ]
}

@test "retries listing request failures and malformed listing JSON" {
  run_fetch FAKE_LIST_SEQUENCE=error,invalid,ok
  assert_success
  [[ "$output" == *'artifact listing request failed: curl exit 22'* ]]
  [[ "$output" == *'invalid artifact listing JSON'* ]]
  [ "$(cat "$TEST_ROOT/listing.count")" -eq 3 ]
  [ "$(cat "$TEST_ROOT/download.count")" -eq 1 ]
}

@test "retries transport errors and other download HTTP failures" {
  run_fetch FAKE_DOWNLOAD_SEQUENCE=transport,503,ok
  assert_success
  [[ "$output" == *'download HTTP 000: curl exit 7'* ]]
  [[ "$output" == *'download HTTP 503'* ]]
  [ "$(cat "$TEST_ROOT/listing.count")" -eq 3 ]
  [ "$(cat "$TEST_ROOT/download.count")" -eq 3 ]
}

@test "exhausts seven attempts with an honest error and no output or temporary file" {
  mkdir -p "$(dirname "$OUTPUT_PATH")"
  echo '{"old":"badge"}' > "$OUTPUT_PATH"
  run_fetch FAKE_DOWNLOAD_SEQUENCE=404
  [ "$status" -ne 0 ]
  [[ "$output" == *'::error::'*'after 7 attempts for job 123: download HTTP 404'* ]]
  [[ "$output" != *'secret-never-print-8991'* ]]
  [ "$(cat "$TEST_ROOT/listing.count")" -eq 7 ]
  [ "$(cat "$TEST_ROOT/download.count")" -eq 7 ]
  [ ! -e "$OUTPUT_PATH" ]
  [ -z "$(find "${TEST_ROOT}/coverage" -type f -print)" ]
}

@test "never prints the token when invalid content exhausts attempts" {
  run_fetch FAKE_DOWNLOAD_SEQUENCE=invalid
  [ "$status" -ne 0 ]
  [[ "$output" == *'after 7 attempts for job 123: download HTTP 200: invalid JSON'* ]]
  [[ "$output" != *'secret-never-print-8991'* ]]
  [ "$(cat "$TEST_ROOT/listing.count")" -eq 7 ]
  [ ! -e "$OUTPUT_PATH" ]
  [ -z "$(find "${TEST_ROOT}/coverage" -type f -print)" ]
}

@test "default backoff waits 155 seconds across six sleeps with no final sleep" {
  run_fetch BADGE_RETRY_SLEEP= FAKE_DOWNLOAD_SEQUENCE=404
  [ "$status" -ne 0 ]
  [ "$(cat "$TEST_ROOT/sleeps")" = $'5\n10\n20\n40\n40\n40' ]
  [ "$(cat "$TEST_ROOT/listing.count")" -eq 7 ]
  [ ! -e "$OUTPUT_PATH" ]
}

@test "old one-shot curl fails the 404-then-success scenario with exit 22" {
  # Temporary reproduction of the old download. Same fake as the regression
  # test: a second download would succeed, but curl --retry does not retry 404.
  local legacy_script="$TEST_ROOT/one-shot.sh"
  cat > "$legacy_script" <<'LEGACY'
#!/usr/bin/env bash
set -euo pipefail
artifacts="$(curl -fsS --retry 3 --retry-delay 5 -H "Circle-Token: $CIRCLECI_TOKEN" "$1/$2/$3/artifacts")"
badge_url="$(jq -r '[.items[]? | select(.path | endswith("coverage/swift-coverage-badge.json")) | .url] | first // empty' <<< "$artifacts")"
mkdir -p "$(dirname "$4")"
curl -fsSL --retry 3 --retry-delay 5 -H "Circle-Token: $CIRCLECI_TOKEN" "$badge_url" -o "$4"
jq -e . "$4" >/dev/null
LEGACY
  SCRIPT="$legacy_script"
  run_fetch FAKE_DOWNLOAD_SEQUENCE=404,ok
  [ "$status" -eq 22 ]
  [ "$(cat "$TEST_ROOT/listing.count")" -eq 1 ]
  [ "$(cat "$TEST_ROOT/download.count")" -eq 1 ]
}

@test "merge.yml invokes the fetch helper and removes the one-shot download" {
  # Use the repository's existing workflow parser to guard this specific step.
  run yq -r '.jobs."swift-code-coverage".steps[] | select(.name == "Run Swift coverage on CircleCI and download badge") | .run' "$WORKFLOW"
  [ "$status" -eq 0 ]
  [[ "$output" == *'bash scripts/ci/fetch-circleci-swift-badge.sh'* ]]
  [[ "$output" == *'"$api" "$project" "$job_number" coverage/swift-coverage-badge.json'* ]]
  [[ "$output" != *'badge_url='* ]]
  ! grep -Eq '\$badge_url.*-o' <<< "$output"
}
