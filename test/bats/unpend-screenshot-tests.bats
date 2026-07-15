#!/usr/bin/env bats
#
# Tests for scripts/screenshot/unpend_screenshot_tests.sh — the helper the
# record-screenshot-baselines workflow runs to turn recorded placeholder tests
# into active checks by dropping `pending = true`. The removal must be precise
# (only `= true`, only the `pending` arg), idempotent, and byte-preserving apart
# from the removed text, so a follow-up ktfmt pass produces no spurious churn.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/screenshot/unpend_screenshot_tests.sh"
  TEST_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "removes trailing pending argument" {
  printf 'x = screenshotTest("light", pending = true) {\n' > "$TEST_DIR/T.kt"
  run "$SCRIPT" "$TEST_DIR/T.kt"
  [ "$status" -eq 0 ]
  [ "$(cat "$TEST_DIR/T.kt")" = 'x = screenshotTest("light") {' ]
}

@test "removes leading pending argument" {
  printf 'x = screenshotTest(pending = true, "light") {\n' > "$TEST_DIR/T.kt"
  run "$SCRIPT" "$TEST_DIR/T.kt"
  [ "$status" -eq 0 ]
  [ "$(cat "$TEST_DIR/T.kt")" = 'x = screenshotTest("light") {' ]
}

@test "leaves an already-active test untouched" {
  printf 'x = screenshotTest("light") {\n' > "$TEST_DIR/T.kt"
  run "$SCRIPT" "$TEST_DIR/T.kt"
  [ "$status" -eq 0 ]
  [ "$(cat "$TEST_DIR/T.kt")" = 'x = screenshotTest("light") {' ]
  [[ "$output" == *"no pending tests"* ]]
}

@test "is idempotent" {
  printf 'x = screenshotTest("light", pending = true) {\n' > "$TEST_DIR/T.kt"
  "$SCRIPT" "$TEST_DIR/T.kt"
  first="$(cat "$TEST_DIR/T.kt")"
  "$SCRIPT" "$TEST_DIR/T.kt"
  [ "$(cat "$TEST_DIR/T.kt")" = "$first" ]
}

@test "does not touch pending = false" {
  printf 'x = screenshotTest("light", pending = false) {\n' > "$TEST_DIR/T.kt"
  run "$SCRIPT" "$TEST_DIR/T.kt"
  [ "$status" -eq 0 ]
  [ "$(cat "$TEST_DIR/T.kt")" = 'x = screenshotTest("light", pending = false) {' ]
}

@test "preserves the trailing newline (no ktfmt churn)" {
  printf 'a\nx = screenshotTest("light", pending = true) {\nb\n' > "$TEST_DIR/T.kt"
  "$SCRIPT" "$TEST_DIR/T.kt"
  # Last byte must remain a newline.
  [ "$(tail -c1 "$TEST_DIR/T.kt" | od -An -tx1 | tr -d ' ')" = "0a" ]
}

@test "un-pends multiple cases across the file" {
  cat > "$TEST_DIR/T.kt" <<'EOF'
fun a() = screenshotTest("a", pending = true) {}
fun b() = screenshotTest("b", pending = true) {}
fun c() = screenshotTest("c") {}
EOF
  run "$SCRIPT" "$TEST_DIR/T.kt"
  [ "$status" -eq 0 ]
  run grep -c "pending = true" "$TEST_DIR/T.kt"
  [ "$output" = "0" ]
}

@test "fails on a missing file" {
  run "$SCRIPT" "$TEST_DIR/nope.kt"
  [ "$status" -ne 0 ]
}

@test "errors with usage when given no arguments" {
  run "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"usage:"* ]]
}
