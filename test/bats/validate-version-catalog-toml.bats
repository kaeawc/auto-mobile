#!/usr/bin/env bats
#
# Tests for scripts/android/validate-version-catalog-toml.sh (#16815)

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$PROJECT_ROOT/scripts/android/validate-version-catalog-toml.sh"
  CATALOG="$BATS_TEST_TMPDIR/libs.versions.toml"
  if ! command -v bun > /dev/null 2>&1; then
    skip "bun is unavailable"
  fi
}

write_catalog() {
  printf '%s\n' "$@" > "$CATALOG"
}

@test "the checked-in Android version catalog has no duplicate keys" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"android/gradle/libs.versions.toml: valid TOML with no duplicate keys"* ]]
}

@test "the same key in different tables is allowed" {
  write_catalog '[versions]' 'androidx-car-app = "1.7.0"' '[libraries]' \
    'androidx-car-app = { module = "androidx.car.app:app", version.ref = "androidx-car-app" }'
  run bash "$SCRIPT" "$CATALOG"
  [ "$status" -eq 0 ]
  [[ "$output" == *"valid TOML with no duplicate keys"* ]]
}

@test "fails on a key duplicated at two places in one table" {
  write_catalog '[versions]' 'androidx-car-app = "1.7.0"' 'kotlin = "2.3.0"' 'androidx-car-app = "1.7.0"'
  run bash "$SCRIPT" "$CATALOG"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Cannot redefine key 'androidx-car-app'"* ]]
  [[ "$output" == *"Version catalog TOML validation failed"* ]]
}

@test "fails on a table header defined twice" {
  write_catalog '[versions]' 'kotlin = "2.3.0"' '[libraries]' '[versions]' 'agp = "9.0.0"'
  run bash "$SCRIPT" "$CATALOG"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Cannot redefine table 'versions'"* ]]
}

@test "fails when a dotted key extends an existing inline table" {
  write_catalog '[libraries]' 'car-app = { module = "androidx.car.app:app" }' 'car-app.version = "1.7.0"'
  run bash "$SCRIPT" "$CATALOG"
  [ "$status" -eq 1 ]
  [[ "$output" == *"car-app"* ]]
}

@test "fails on a missing catalog file" {
  run bash "$SCRIPT" "$BATS_TEST_TMPDIR/missing.toml"
  [ "$status" -eq 1 ]
  [[ "$output" == *"missing.toml: file not found"* ]]
}

@test "checks every catalog argument and fails if any is invalid" {
  write_catalog '[versions]' 'a = "1"' 'a = "2"'
  printf '[versions]\nb = "1"\n' > "$BATS_TEST_TMPDIR/ok.toml"
  run bash "$SCRIPT" "$BATS_TEST_TMPDIR/ok.toml" "$CATALOG"
  [ "$status" -eq 1 ]
  [[ "$output" == *"ok.toml: valid TOML with no duplicate keys"* ]]
  [[ "$output" == *"Cannot redefine key 'a'"* ]]
}

@test "is registered as a Fast Validation check and run by PR CI" {
  run bash "$PROJECT_ROOT/scripts/all_fast_validate_checks.sh" --list-checks
  [ "$status" -eq 0 ]
  [[ "$output" == *"version-catalog-toml"* ]]
  grep -Eq -- '--only .*[,]version-catalog-toml[,]' "$PROJECT_ROOT/.github/workflows/pull_request.yml"
}
