#!/usr/bin/env bats
# Tests for scripts/ci/pr-review-threads.sh (issue #4120).

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/scripts/ci/pr-review-threads.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  STUB_DIR="${TEST_ROOT}/bin"
  mkdir -p "$STUB_DIR"

  cat >"${STUB_DIR}/gh" <<'SHIM'
#!/usr/bin/env bash
set -u

printf '%s\n' "$*" >> "${GH_CALLS:?}"

case "$*" in
  "api graphql "*)
    case "${GH_SCENARIO:?}" in
      two-pages)
        jq -s '.' <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"thread-one","isResolved":false,"isOutdated":false,"path":"one.ts","line":1,"originalLine":1,"diffSide":"RIGHT","comments":{"nodes":[{"author":{"login":"first"},"body":"first body","url":"https://example.test/one","createdAt":"2026-01-01T00:00:00Z"}]}}],"pageInfo":{"hasNextPage":true,"endCursor":"cursor-one"}}}}}}
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"thread-two","isResolved":true,"isOutdated":false,"path":"two.ts","line":2,"originalLine":2,"diffSide":"RIGHT","comments":{"nodes":[]}},{"id":"thread-three","isResolved":false,"isOutdated":true,"path":"three.ts","line":3,"originalLine":3,"diffSide":"RIGHT","comments":{"nodes":[]}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}
JSON
        ;;
      empty)
        printf '%s\n' '[{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}]'
        ;;
      incomplete)
        printf '%s\n' '[{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"thread-one","isResolved":false,"isOutdated":false,"path":"one.ts","line":1,"originalLine":1,"diffSide":"RIGHT","comments":{"nodes":[]}}],"pageInfo":{"hasNextPage":true,"endCursor":"cursor-one"}}}}}}]'
        ;;
      api-error)
        printf '%s\n' 'simulated GitHub API failure' >&2
        exit 1
        ;;
      *)
        echo "unknown scenario: ${GH_SCENARIO}" >&2
        exit 99
        ;;
    esac
    ;;
  "pr view "*)
    printf '%s\n' '42'
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 99
    ;;
esac
SHIM
  chmod +x "${STUB_DIR}/gh"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

run_script() {
  if [ -n "${2:-}" ]; then
    run env \
      PATH="${STUB_DIR}:/opt/homebrew/bin:/usr/bin:/bin" \
      GH_CALLS="${TEST_ROOT}/gh-calls" \
      GH_SCENARIO="$1" \
      bash "$SCRIPT" 42 "$2"
  else
    run env \
      PATH="${STUB_DIR}:/opt/homebrew/bin:/usr/bin:/bin" \
      GH_CALLS="${TEST_ROOT}/gh-calls" \
      GH_SCENARIO="$1" \
      bash "$SCRIPT" 42
  fi
}

@test "flattens every GraphQL page into one JSON array" {
  run_script two-pages

  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -e 'type == "array" and length == 3')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.[].id' | tr '\n' ' ')" = "thread-one thread-two thread-three " ]
  [ "$(printf '%s' "$output" | jq -e '.[0].comments | type == "array" and .[0].author.login == "first"')" = "true" ]
  grep -q -- '--paginate --slurp' "${TEST_ROOT}/gh-calls"
}

@test "unresolved-only filters by isResolved without dropping outdated threads" {
  run_script two-pages --unresolved-only

  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -e 'length == 2 and all(.[]; .isResolved | not)')" = "true" ]
  [ "$(printf '%s' "$output" | jq -r '.[].id' | tr '\n' ' ')" = "thread-one thread-three " ]
}

@test "an empty review-thread response emits an empty JSON array" {
  run_script empty

  [ "$status" -eq 0 ]
  [ "$output" = "[]" ]
}

@test "an API failure exits non-zero without writing a partial array to stdout" {
  stdout_file="${TEST_ROOT}/stdout"
  stderr_file="${TEST_ROOT}/stderr"

  run bash -c 'env PATH="$1:/opt/homebrew/bin:/usr/bin:/bin" GH_CALLS="$2" GH_SCENARIO=api-error bash "$3" 42 >"$4" 2>"$5"' \
    _ "$STUB_DIR" "${TEST_ROOT}/gh-calls" "$SCRIPT" "$stdout_file" "$stderr_file"

  [ "$status" -ne 0 ]
  [ ! -s "$stdout_file" ]
  grep -q 'simulated GitHub API failure' "$stderr_file"
}

@test "a response whose final page has more pages fails without emitting a partial array" {
  stdout_file="${TEST_ROOT}/stdout"
  stderr_file="${TEST_ROOT}/stderr"

  run bash -c 'env PATH="$1:/opt/homebrew/bin:/usr/bin:/bin" GH_CALLS="$2" GH_SCENARIO=incomplete bash "$3" 42 >"$4" 2>"$5"' \
    _ "$STUB_DIR" "${TEST_ROOT}/gh-calls" "$SCRIPT" "$stdout_file" "$stderr_file"

  [ "$status" -ne 0 ]
  [ ! -s "$stdout_file" ]
  grep -q 'final GraphQL page indicates more review threads' "$stderr_file"
}
