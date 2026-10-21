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

@test "merge workflow no longer pushes badge commits to main" {
  ! grep -q "update-readme-badges" .github/workflows/merge.yml
}

@test "docs workflow publishes the test count badges" {
  grep -q "generate-test-count-badges.sh site" .github/workflows/docs.yml
}
