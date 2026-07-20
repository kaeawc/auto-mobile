#!/usr/bin/env bats

SCRIPT="scripts/android/validate-kotlin-conventions.sh"

@test "passes with the shared validator and query encoder" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Kotlin convention checks passed."* ]]
}

@test "fails when a second test plan validator is introduced" {
  local fixture_dir="android/ide-plugin/src/test/kotlin/dev/jasonpearson/automobile/ide/yaml"
  local fixture="$fixture_dir/TestPlanValidator.kt"
  mkdir -p "$fixture_dir"
  printf 'class TestPlanValidator\n' > "$fixture"

  run bash "$SCRIPT"
  rm -f "$fixture"

  [ "$status" -ne 0 ]
  [[ "$output" == *"TestPlanValidator must exist only"* ]]
}

@test "fails when a changed Kotlin utility file is introduced" {
  local fixture_dir="android/desktop-core/src/test/kotlin/dev/jasonpearson/automobile/desktop/core"
  local fixture="$fixture_dir/ConventionUtil.kt"
  mkdir -p "$fixture_dir"
  printf 'class ConventionUtil\n' > "$fixture"

  run bash "$SCRIPT"
  rm -f "$fixture"

  [ "$status" -ne 0 ]
  [[ "$output" == *"avoid new generic utility files"* ]]
}
