#!/usr/bin/env bats

setup() {
  fixture="src/utils/GitMetadataBoundaryFixture.ts"
}

teardown() {
  rm -f "$fixture"
}

@test "rejects a new direct argv git execution outside the owner" {
  printf '%s\n' 'import { spawnSync } from "node:child_process";' 'spawnSync("git", ["rev-parse", "HEAD"]);' > "$fixture"

  run bash "$BATS_TEST_DIRNAME/../../scripts/check-no-new-direct-git-metadata.sh"

  [ "$status" -eq 1 ]
  [[ "$output" == *"GitMetadataBoundaryFixture.ts"* ]]
}

@test "rejects a multiline template shell command" {
  printf '%s\n' 'import { execSync } from "node:child_process";' 'execSync(`' 'git rev-parse HEAD' '`);' > "$fixture"

  run bash "$BATS_TEST_DIRNAME/../../scripts/check-no-new-direct-git-metadata.sh"

  [ "$status" -eq 1 ]
  [[ "$output" == *"GitMetadataBoundaryFixture.ts"* ]]
}

@test "rejects Bun argv execution" {
  printf '%s\n' 'Bun.spawnSync(["git", "rev-parse", "HEAD"]);' > "$fixture"

  run bash "$BATS_TEST_DIRNAME/../../scripts/check-no-new-direct-git-metadata.sh"

  [ "$status" -eq 1 ]
  [[ "$output" == *"GitMetadataBoundaryFixture.ts"* ]]
}

@test "rejects an aliased child-process execution" {
  printf '%s\n' 'import { execFileSync } from "node:child_process";' 'const run = execFileSync;' 'run("git", ["rev-parse", "HEAD"]);' > "$fixture"

  run bash "$BATS_TEST_DIRNAME/../../scripts/check-no-new-direct-git-metadata.sh"

  [ "$status" -eq 1 ]
  [[ "$output" == *"GitMetadataBoundaryFixture.ts"* ]]
}

@test "rejects a destructured CommonJS child-process execution" {
  printf '%s\n' 'const { execSync } = require("child_process");' 'execSync("git status");' > "$fixture"

  run bash "$BATS_TEST_DIRNAME/../../scripts/check-no-new-direct-git-metadata.sh"

  [ "$status" -eq 1 ]
  [[ "$output" == *"GitMetadataBoundaryFixture.ts"* ]]
}
