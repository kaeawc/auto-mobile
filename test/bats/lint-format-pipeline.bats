#!/usr/bin/env bats
#
# Keep local autofix output format-clean and CI checks read-only.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  TEST_DIR="$(mktemp -d)"
  FIXTURE="$TEST_DIR/fixture.ts"
  printf 'if (true) console.log("fixture");\n' >"$FIXTURE"
  REAL_BASH="$(command -v bash)"
  mkdir -p "$TEST_DIR/bin"
  # Run real oxlint/oxfmt with the repo config, but keep repo-wide gates hermetic.
  printf '#!%s\n' "$REAL_BASH" >"$TEST_DIR/bin/bash"
  cat >>"$TEST_DIR/bin/bash" <<'EOF'
set -euo pipefail
case "${1:-}" in
  scripts/oxlint-baseline.sh | scripts/check-boundaries.sh | scripts/check-element-resolution-ratchet.sh)
    printf 'follow-on: %s\n' "$1"
    ;;
  *) exec "$REAL_BASH" "$@" ;;
esac
EOF
  chmod +x "$TEST_DIR/bin/bash"
  cd "$REPO_ROOT"
}

run_lint() {
  run env -u CI "$@" REAL_BASH="$REAL_BASH" \
    PATH="$TEST_DIR/bin:$REPO_ROOT/node_modules/.bin:$PATH" \
    "$REAL_BASH" "$REPO_ROOT/scripts/lint.sh" "$FIXTURE"
}

assert_follow_on_checks() {
  [[ "$output" == *"follow-on: scripts/oxlint-baseline.sh"* ]]
  [[ "$output" == *"follow-on: scripts/check-boundaries.sh"* ]]
  [[ "$output" == *"follow-on: scripts/check-element-resolution-ratchet.sh"* ]]
}

assert_local_autofix() {
  [ "$status" -eq 0 ]
  assert_follow_on_checks
  grep -q 'if (true) {' "$FIXTURE"
  run "$REPO_ROOT/node_modules/.bin/oxfmt" --check "$FIXTURE"
  [ "$status" -eq 0 ]
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "oxlint autofix output is oxfmt-clean and idempotent" {
  run bash -c 'cd "$1" && bunx oxlint --fix "$2"' _ "$REPO_ROOT" "$FIXTURE"
  [ "$status" -eq 0 ]

  run bash -c 'cd "$1" && bunx oxfmt --write "$2"' _ "$REPO_ROOT" "$FIXTURE"
  [ "$status" -eq 0 ]

  run bash -c 'cd "$1" && bunx oxfmt --check "$2"' _ "$REPO_ROOT" "$FIXTURE"
  [ "$status" -eq 0 ]

  first_output="$(<"$FIXTURE")"
  run bash -c 'cd "$1" && bunx oxlint --fix "$2" && bunx oxfmt --write "$2"' _ "$REPO_ROOT" "$FIXTURE"
  [ "$status" -eq 0 ]
  [ "$(<"$FIXTURE")" = "$first_output" ]

  run bash -c 'cd "$1" && bunx oxfmt --check "$2"' _ "$REPO_ROOT" "$FIXTURE"
  [ "$status" -eq 0 ]
}

@test "oxfmt runs when oxlint reports an unfixed violation" {
  fixture_with_error="$TEST_DIR/fixture-with-error.ts"
  printf 'if (true) console.log("fixture");\nif (a == b) { console.log(a); }\n' >"$fixture_with_error"

  run env -u CI PATH="$REPO_ROOT/node_modules/.bin:$PATH" bash "$REPO_ROOT/scripts/lint.sh" "$fixture_with_error"
  [ "$status" -ne 0 ]
  [[ "$output" == *"skipping baseline and boundary checks"* ]]
  grep -q 'if (true) {' "$fixture_with_error"

  run bash -c 'cd "$1" && bunx oxfmt --check "$2"' _ "$REPO_ROOT" "$fixture_with_error"
  [ "$status" -eq 0 ]
}

@test "CI=true rejects an autofixable curly violation without rewriting" {
  cp "$FIXTURE" "$TEST_DIR/original.ts"
  run_lint CI=true
  [ "$status" -ne 0 ]
  [[ "$output" == *"curly"* ]]
  [[ "$output" == *"Checking formatting"* ]]
  [[ "$output" != *"follow-on:"* ]]
  cmp "$FIXTURE" "$TEST_DIR/original.ts"
}

@test "CI=1 rejects an autofixable curly violation without rewriting" {
  cp "$FIXTURE" "$TEST_DIR/original.ts"
  run_lint CI=1
  [ "$status" -ne 0 ]
  [[ "$output" == *"curly"* ]]
  cmp "$FIXTURE" "$TEST_DIR/original.ts"
}

@test "CI accepts a clean fixture and runs all follow-on checks" {
  printf 'console.log("fixture");\n' >"$FIXTURE"
  cp "$FIXTURE" "$TEST_DIR/original.ts"
  run_lint CI=true
  [ "$status" -eq 0 ]
  assert_follow_on_checks
  cmp "$FIXTURE" "$TEST_DIR/original.ts"
}

@test "CI check mode supports system Bash" {
  [ -x /bin/bash ] || skip "system Bash is unavailable"
  REAL_BASH=/bin/bash
  printf 'console.log("fixture");\n' >"$FIXTURE"
  run_lint CI=true
  [ "$status" -eq 0 ]
  assert_follow_on_checks
}

@test "CI rejects formatting-only violations without rewriting" {
  printf 'console.log(  "fixture"  );\n' >"$FIXTURE"
  cp "$FIXTURE" "$TEST_DIR/original.ts"
  run "$REPO_ROOT/node_modules/.bin/oxlint" "$FIXTURE"
  [ "$status" -eq 0 ]
  run_lint CI=true
  [ "$status" -ne 0 ]
  [[ "$output" == *"Format issues found"* ]]
  [[ "$output" != *"follow-on:"* ]]
  cmp "$FIXTURE" "$TEST_DIR/original.ts"
}

@test "CI unset keeps local autofixing" {
  run_lint
  assert_local_autofix
}

@test "CI=false keeps local autofixing" {
  run_lint CI=false
  assert_local_autofix
}

@test "CI empty keeps local autofixing" {
  run_lint CI=
  assert_local_autofix
}

@test "Windows CI skips formatting-only violations without rewriting" {
  printf 'console.log(  "fixture"  );\n' >"$FIXTURE"
  cp "$FIXTURE" "$TEST_DIR/original.ts"
  for ci_value in true 1; do
    run_lint CI="$ci_value" RUNNER_OS=Windows
    [ "$status" -eq 0 ]
    [[ "$output" == *"format is gated on Linux (Fast Validation format step); skipped on Windows: CRLF checkout"* ]]
    [[ "$output" != *"Checking formatting"* ]]
    assert_follow_on_checks
    cmp "$FIXTURE" "$TEST_DIR/original.ts"
  done
}

@test "Windows CI rejects curly violations without formatting or rewriting" {
  cp "$FIXTURE" "$TEST_DIR/original.ts"
  run_lint CI=true RUNNER_OS=Windows
  [ "$status" -ne 0 ]
  [[ "$output" == *"curly"* ]]
  [[ "$output" == *"skipped on Windows: CRLF checkout"* ]]
  [[ "$output" != *"Checking formatting"* ]]
  [[ "$output" != *"follow-on:"* ]]
  cmp "$FIXTURE" "$TEST_DIR/original.ts"
}

@test "Windows CI accepts a clean fixture and runs all follow-on checks" {
  printf 'console.log("fixture");\n' >"$FIXTURE"
  cp "$FIXTURE" "$TEST_DIR/original.ts"
  run_lint CI=true RUNNER_OS=Windows
  [ "$status" -eq 0 ]
  assert_follow_on_checks
  cmp "$FIXTURE" "$TEST_DIR/original.ts"
}

@test "Windows CI oxlint accepts CRLF without rewriting" {
  printf 'console.log("fixture");\r\n' >"$FIXTURE"
  cp "$FIXTURE" "$TEST_DIR/original.ts"
  run_lint CI=true RUNNER_OS=Windows
  [ "$status" -eq 0 ]
  [[ "$output" != *"Checking formatting"* ]]
  assert_follow_on_checks
  cmp "$FIXTURE" "$TEST_DIR/original.ts"
}

@test "Linux and macOS CI still reject formatting-only violations" {
  printf 'console.log(  "fixture"  );\n' >"$FIXTURE"
  cp "$FIXTURE" "$TEST_DIR/original.ts"
  for runner_os in Linux macOS; do
    run_lint CI=true RUNNER_OS="$runner_os"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Checking formatting"* ]]
    [[ "$output" == *"Format issues found"* ]]
    [[ "$output" != *"skipped on Windows"* ]]
    [[ "$output" != *"follow-on:"* ]]
    cmp "$FIXTURE" "$TEST_DIR/original.ts"
  done
}

@test "Windows runner detection keeps local autofixing" {
  run_lint RUNNER_OS=Windows
  [[ "$output" != *"skipped on Windows"* ]]
  [[ "$output" != *"Checking formatting"* ]]
  assert_local_autofix
}

@test "CI failures print the local fix hint exactly once" {
  fix_hint="CI lint check failed: run 'bun run lint' locally (without CI set) to apply fixes, or 'bun run format' for formatting."
  printf 'if (true) console.log(  "fixture"  );\n' >"$FIXTURE"
  for runner_os in Linux Windows; do
    run_lint CI=true RUNNER_OS="$runner_os"
    [ "$status" -ne 0 ]
    [[ "$output" == *"curly"* ]]
    if [[ "$runner_os" == Linux ]]; then
      [[ "$output" == *"Format issues found"* ]]
    fi
    [ "$(printf '%s\n' "$output" | grep -Fxc "$fix_hint")" -eq 1 ]
  done

  printf 'console.log(  "fixture"  );\n' >"$FIXTURE"
  run_lint CI=true RUNNER_OS=Linux
  [ "$status" -ne 0 ]
  [[ "$output" == *"Format issues found"* ]]
  [ "$(printf '%s\n' "$output" | grep -Fxc "$fix_hint")" -eq 1 ]
}

@test "Passing CI and local runs do not print the fix hint" {
  printf 'console.log("fixture");\n' >"$FIXTURE"
  for runner_os in Linux Windows; do
    run_lint CI=true RUNNER_OS="$runner_os"
    [ "$status" -eq 0 ]
    [[ "$output" != *"CI lint check failed:"* ]]
  done

  printf 'if (true) console.log("fixture");\n' >"$FIXTURE"
  run_lint RUNNER_OS=Windows
  [[ "$output" != *"CI lint check failed:"* ]]
  assert_local_autofix
}

@test "CI detects Windows from uname when RUNNER_OS is unset" {
  printf '#!%s\nprintf "MINGW64_NT-10.0\\n"\n' "$REAL_BASH" >"$TEST_DIR/bin/uname"
  chmod +x "$TEST_DIR/bin/uname"
  printf 'console.log(  "fixture"  );\n' >"$FIXTURE"
  cp "$FIXTURE" "$TEST_DIR/original.ts"
  run_lint -u RUNNER_OS CI=true
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipped on Windows: CRLF checkout"* ]]
  [[ "$output" != *"Checking formatting"* ]]
  assert_follow_on_checks
  cmp "$FIXTURE" "$TEST_DIR/original.ts"
}
