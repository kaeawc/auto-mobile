#!/usr/bin/env bats
# bats file_tags=serial
# Fixtures and baselines are restored after every test; run serially with source scans.

SCRIPT="scripts/check-tier-import-direction.sh"
MODELS_FIXTURE="src/models/TierImportDirectionFixture.ts"
FEATURES_FIXTURE="src/features/TierImportDirectionFixture.ts"
BASELINE_DIR="scripts/import-direction-baselines"

setup() {
  SAVED_BASELINES="$(mktemp -d)"
  cp "$BASELINE_DIR"/*.txt "$SAVED_BASELINES"/
}

teardown() {
  rm -f "$MODELS_FIXTURE" "$FEATURES_FIXTURE"
  cp "$SAVED_BASELINES"/*.txt "$BASELINE_DIR"/
  rm -rf "$SAVED_BASELINES"
}

@test "allows the current tier import baselines" {
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"models has no new upward imports"* ]]
  [[ "$output" == *"features has no new upward imports"* ]]
}

@test "allows the current baselines with CRLF line endings" {
  for file in "$SAVED_BASELINES"/*.txt; do
    awk '{ printf "%s\r\n", $0 }' "$file" > "$BASELINE_DIR/$(basename "$file")"
  done

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
}

@test "rejects a new models upward import" {
  printf '%s\n' 'import type { X } from "../daemon/somethingNew";' > "$MODELS_FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"src/models/TierImportDirectionFixture.ts -> src/daemon/somethingNew"* ]]
}

@test "rejects a new features import of server but allows features importing daemon" {
  printf '%s\n' \
    'import { a } from "../server/serverNew";' \
    'import { b } from "../daemon/daemonOk";' \
    > "$FEATURES_FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"src/server/serverNew"* ]]
  [[ "$output" != *"src/daemon/daemonOk"* ]]
}

@test "update removes stale edges and refuses growth unless explicitly allowed" {
  printf '%s\n' 'src/models/Old.ts -> src/daemon/oldTarget' >> "$BASELINE_DIR/models.txt"
  run bash "$SCRIPT" --update
  [ "$status" -eq 0 ]
  ! grep -q 'src/models/Old.ts' "$BASELINE_DIR/models.txt"

  printf '%s\n' 'import { x } from "../daemon/somethingNew";' > "$MODELS_FIXTURE"
  run bash "$SCRIPT" --update
  [ "$status" -eq 1 ]
  ! grep -q 'TierImportDirectionFixture' "$BASELINE_DIR/models.txt"

  run bash "$SCRIPT" --update --allow-grow
  [ "$status" -eq 0 ]
  grep -q 'src/models/TierImportDirectionFixture.ts -> src/daemon/somethingNew' "$BASELINE_DIR/models.txt"
}
