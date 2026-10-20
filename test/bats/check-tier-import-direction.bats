#!/usr/bin/env bats
# bats file_tags=serial
# Fixtures are removed after every test; run serially with source scans.

SCRIPT="scripts/check-tier-import-direction.ts"
MODELS_FIXTURE="src/db/TierImportDirectionFixture.ts"
FEATURES_FIXTURE="src/features/TierImportDirectionFixture.ts"
DAEMON_FIXTURE="src/daemon/TierImportDirectionFixture.ts"
CTRL_PROXY_FIXTURE="src/ctrlProxy/TierImportDirectionFixture.ts"

teardown() {
  rm -f "$MODELS_FIXTURE" "$FEATURES_FIXTURE" "$DAEMON_FIXTURE" "$CTRL_PROXY_FIXTURE"
}

@test "allows the current tier imports" {
  run bun "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"db has no upward imports"* ]]
  [[ "$output" == *"features has no upward imports"* ]]
  [[ "$output" == *"daemon has no upward imports"* ]]
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

@test "daemon and ctrlProxy upward imports fail even with removed update flags" {
  printf '%s\n' 'import { x } from "../server/somethingNew";' > "$DAEMON_FIXTURE"
  printf '%s\n' 'import { x } from "../daemon/somethingNew";' > "$CTRL_PROXY_FIXTURE"

  run bun "$SCRIPT" --update --allow-grow

  [ "$status" -eq 1 ]
  [[ "$output" == *"src/daemon/TierImportDirectionFixture.ts -> src/server/somethingNew"* ]]
  [[ "$output" == *"src/ctrlProxy/TierImportDirectionFixture.ts -> src/daemon/somethingNew"* ]]
}
