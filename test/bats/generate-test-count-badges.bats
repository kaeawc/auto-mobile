#!/usr/bin/env bats
#
# Tests for scripts/coverage/generate-test-count-badges.sh (issue #11871).

SCRIPT="scripts/coverage/generate-test-count-badges.sh"

setup() {
  ROOT="$(mktemp -d)"
  mkdir -p "$ROOT/test" "$ROOT/android/app/src/test" "$ROOT/ios/Tests"
  printf 'it("a", () => {});\n  test("b", () => {});\nit.skip("c", () => {});\n' > "$ROOT/test/x.test.ts"
  printf '@Test\n@Test\n' > "$ROOT/android/app/src/test/A.kt"
  printf '@Test\n' > "$ROOT/android/app/B.kt"
  printf 'func testOne() {}\n' > "$ROOT/ios/Tests/T.swift"
}

teardown() {
  rm -rf "$ROOT"
}

@test "writes shields endpoint JSON with the grep counts" {
  run env REPO_ROOT="$ROOT" bash "$SCRIPT" "$ROOT/out"
  [ "$status" -eq 0 ]
  grep -q '"message": "2"' "$ROOT/out/typescript-tests-badge.json"
  grep -q '"message": "2"' "$ROOT/out/kotlin-tests-badge.json"
  grep -q '"message": "1"' "$ROOT/out/swift-tests-badge.json"
  grep -q '"schemaVersion": 1' "$ROOT/out/swift-tests-badge.json"
}

@test "formats thousands with commas" {
  for i in $(seq 1 1200); do echo 'it("n", () => {});'; done > "$ROOT/test/y.test.ts"
  run env REPO_ROOT="$ROOT" bash "$SCRIPT" "$ROOT/out"
  [ "$status" -eq 0 ]
  grep -q '"message": "1,202"' "$ROOT/out/typescript-tests-badge.json"
}

@test "a tree with no Swift tests publishes a zero count (#14574)" {
  printf 'struct NotATest {}\n' > "$ROOT/ios/Tests/T.swift"
  run env REPO_ROOT="$ROOT" bash "$SCRIPT" "$ROOT/out"
  [ "$status" -eq 0 ]
  grep -q '"message": "0"' "$ROOT/out/swift-tests-badge.json"
}

@test "no TypeScript or Kotlin matches is a zero count, not an error" {
  printf 'const x = 1;\n' > "$ROOT/test/x.test.ts"
  printf 'class A\n' > "$ROOT/android/app/src/test/A.kt"
  printf 'class B\n' > "$ROOT/android/app/B.kt"
  run env REPO_ROOT="$ROOT" bash "$SCRIPT" "$ROOT/out"
  [ "$status" -eq 0 ]
  grep -q '"message": "0"' "$ROOT/out/typescript-tests-badge.json"
  grep -q '"message": "0"' "$ROOT/out/kotlin-tests-badge.json"
}

@test "a missing source tree fails instead of publishing a zero badge (#14575)" {
  rm -rf "$ROOT/test" "$ROOT/android"
  run env REPO_ROOT="$ROOT" bash "$SCRIPT" "$ROOT/out"
  [ "$status" -ne 0 ]
  [[ "$output" == *"grep failed with status 2"* ]]
  [ ! -e "$ROOT/out/typescript-tests-badge.json" ]
}

@test "merge workflow no longer pushes badge commits to main" {
  ! grep -q "update-readme-badges" .github/workflows/merge.yml
}

@test "docs workflow publishes the test count badges" {
  grep -q "generate-test-count-badges.sh site" .github/workflows/docs.yml
}
