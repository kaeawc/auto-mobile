#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  FIXTURE_ROOT="$(mktemp -d)"
  mkdir -p "$FIXTURE_ROOT/scripts/prototype" "$FIXTURE_ROOT/schemas" \
    "$FIXTURE_ROOT/android/protocol/src/main/kotlin/dev/jasonpearson/automobile/protocol" \
    "$FIXTURE_ROOT/ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore"
  cp "$REPO_ROOT/scripts/prototype/generate-prototype-spec-models.ts" \
    "$REPO_ROOT/scripts/prototype/prototype-model-selection.ts" "$FIXTURE_ROOT/scripts/prototype/"
  cp "$REPO_ROOT/schemas/prototype-spec-contract.json" "$FIXTURE_ROOT/schemas/"
  KOTLIN_OUTPUT="$FIXTURE_ROOT/android/protocol/src/main/kotlin/dev/jasonpearson/automobile/protocol/PrototypeSpecModels.generated.kt"
  SWIFT_OUTPUT="$FIXTURE_ROOT/ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeSpecModels.generated.swift"
  GENERATOR="$FIXTURE_ROOT/scripts/prototype/generate-prototype-spec-models.ts"
}

teardown() {
  rm -rf "$FIXTURE_ROOT"
}

@test "model generator check rejects missing outputs without creating them" {
  run bun "$GENERATOR" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *"PrototypeSpecModels.generated.kt is stale"* ]]
  [[ "$output" == *"PrototypeSpecModels.generated.swift is stale"* ]]
  [ ! -e "$KOTLIN_OUTPUT" ]
  [ ! -e "$SWIFT_OUTPUT" ]
}

@test "model generator writes current outputs and check rejects each stale output without rewriting" {
  run bun "$GENERATOR"
  [ "$status" -eq 0 ]
  run bun "$GENERATOR" --check
  [ "$status" -eq 0 ]

  printf '\n// stale\n' >> "$KOTLIN_OUTPUT"
  run bun "$GENERATOR" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *"PrototypeSpecModels.generated.kt is stale"* ]]
  [[ "$output" != *"PrototypeSpecModels.generated.swift is stale"* ]]
  [[ "$(tail -1 "$KOTLIN_OUTPUT")" == "// stale" ]]

  run bun "$GENERATOR"
  [ "$status" -eq 0 ]
  printf '\n// stale\n' >> "$SWIFT_OUTPUT"
  run bun "$GENERATOR" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *"PrototypeSpecModels.generated.swift is stale"* ]]
  [[ "$output" != *"PrototypeSpecModels.generated.kt is stale"* ]]
  [[ "$(tail -1 "$SWIFT_OUTPUT")" == "// stale" ]]
}
