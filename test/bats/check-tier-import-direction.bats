#!/usr/bin/env bats
# bats file_tags=serial
# Fixtures and the remaining baselines are restored after every test; run serially with source scans.

SCRIPT="scripts/check-tier-import-direction.ts"
MODELS_FIXTURE="src/db/TierImportDirectionFixture.ts"
FEATURES_FIXTURE="src/features/TierImportDirectionFixture.ts"
DAEMON_FIXTURE="src/daemon/TierImportDirectionFixture.ts"
BASELINE_DIR="scripts/import-direction-baselines"

setup() {
  SAVED_BASELINES="$(mktemp -d)"
  cp "$BASELINE_DIR"/*.txt "$SAVED_BASELINES"/
}

teardown() {
  rm -f "$MODELS_FIXTURE" "$FEATURES_FIXTURE" "$DAEMON_FIXTURE"
  cp "$SAVED_BASELINES"/*.txt "$BASELINE_DIR"/
  rm -rf "$SAVED_BASELINES"
}

@test "allows the current tier imports and remaining baselines" {
  run bun "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"db has no upward imports"* ]]
  [[ "$output" == *"features has no upward imports"* ]]
  [[ "$output" == *"daemon has no new upward imports"* ]]
}

@test "allows the current baselines with CRLF line endings" {
  for file in "$SAVED_BASELINES"/*.txt; do
    awk '{ printf "%s\r\n", $0 }' "$file" > "$BASELINE_DIR/$(basename "$file")"
  done

  run bun "$SCRIPT"

  [ "$status" -eq 0 ]
}

@test "rejects a new db upward import" {
  printf '%s\n' 'import type { X } from "../daemon/somethingNew";' > "$MODELS_FIXTURE"

  run bun "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"src/db/TierImportDirectionFixture.ts -> src/daemon/somethingNew"* ]]
}

@test "rejects a new features import of server but allows features importing daemon" {
  printf '%s\n' \
    'import { a } from "../server/serverNew";' \
    'import { b } from "../daemon/daemonOk";' \
    > "$FEATURES_FIXTURE"

  run bun "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"src/server/serverNew"* ]]
  [[ "$output" != *"src/daemon/daemonOk"* ]]
}

@test "baseline-free tiers fail outright even with --update --allow-grow" {
  printf '%s\n' 'import { x } from "../daemon/somethingNew";' > "$MODELS_FIXTURE"

  run bun "$SCRIPT" --update --allow-grow
  [ "$status" -eq 1 ]
  [[ "$output" == *"src/db/TierImportDirectionFixture.ts -> src/daemon/somethingNew"* ]]
  [ ! -e "$BASELINE_DIR/db.txt" ]
}

@test "update removes stale edges and refuses growth unless explicitly allowed for a baselined tier" {
  printf '%s\n' 'src/daemon/Old.ts -> src/server/oldTarget' >> "$BASELINE_DIR/daemon.txt"
  run bun "$SCRIPT" --update
  [ "$status" -eq 0 ]
  ! grep -q 'src/daemon/Old.ts' "$BASELINE_DIR/daemon.txt"

  printf '%s\n' 'import { x } from "../server/somethingNew";' > "$DAEMON_FIXTURE"
  run bun "$SCRIPT" --update
  [ "$status" -eq 1 ]
  ! grep -q 'TierImportDirectionFixture' "$BASELINE_DIR/daemon.txt"

  run bun "$SCRIPT" --update --allow-grow
  [ "$status" -eq 0 ]
  grep -q 'src/daemon/TierImportDirectionFixture.ts -> src/server/somethingNew' "$BASELINE_DIR/daemon.txt"
}
