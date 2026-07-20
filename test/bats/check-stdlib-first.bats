#!/usr/bin/env bats

SCRIPT="scripts/check-stdlib-first.sh"

@test "passes when the direct dependency lists have not changed" {
  run env STDLIB_FIRST_BASE_REF=HEAD bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new direct dependencies"* ]]
}

@test "requires a decision record for a new direct dependency" {
  local package_backup
  local result_output
  local result_status
  package_backup="$(mktemp)"
  cp package.json "$package_backup"

  jq '.devDependencies["stdlib-first-bats-fixture"] = "1.0.0"' package.json > package.json.tmp
  mv package.json.tmp package.json

  run env STDLIB_FIRST_BASE_REF=HEAD bash "$SCRIPT"
  result_status="$status"
  result_output="$output"
  cp "$package_backup" package.json
  rm -f "$package_backup" docs/decisions/stdlib-first-bats-fixture.md

  [ "$result_status" -eq 1 ]
  [[ "$result_output" == *"stdlib-first-bats-fixture"* ]]
}

@test "requires a decision record for a new optional dependency" {
  local package_backup
  local result_output
  local result_status
  package_backup="$(mktemp)"
  cp package.json "$package_backup"

  jq '.optionalDependencies["stdlib-first-optional-fixture"] = "1.0.0"' package.json > package.json.tmp
  mv package.json.tmp package.json

  run env STDLIB_FIRST_BASE_REF=HEAD bash "$SCRIPT"
  result_status="$status"
  result_output="$output"
  cp "$package_backup" package.json
  rm -f "$package_backup" docs/decisions/stdlib-first-optional-fixture.md

  [ "$result_status" -eq 1 ]
  [[ "$result_output" == *"stdlib-first-optional-fixture"* ]]
}
