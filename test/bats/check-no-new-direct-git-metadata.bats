#!/usr/bin/env bats
# bats file_tags=serial
# Writes fixtures into the real source tree (src/utils/GitMetadataBoundaryFixture*.ts)
# and scans the tree, so this file cannot run concurrently with the rest of the
# suite. scripts/ci/run-bats.sh runs serial-tagged files in a dedicated serial
# pass; the tag is enforced by test/scripts/batsSerialTags.test.ts.
#
# A full-tree scan parses every file under src/ (~3s on CI), and this file runs
# in the serial pass, so setup_file writes one uniquely named fixture per case
# and scans once (#17778). The scanner reports every violating file, so each
# test asserts only that its own fixture was flagged.

SCRIPT="scripts/check-no-new-direct-git-metadata.ts"
FIXTURE_PREFIX="GitMetadataBoundaryFixture"
FIXTURE_SLUGS=(ArgvSpawnSync MultilineTemplate BunArgv AliasedExecFileSync DestructuredRequire)

write_fixture() {
  local fixture="src/utils/${FIXTURE_PREFIX}$1.ts"
  shift
  printf '%s\n' "$@" > "$fixture"
}

remove_fixtures() {
  local slug fixture
  for slug in "${FIXTURE_SLUGS[@]}"; do
    fixture="src/utils/${FIXTURE_PREFIX}${slug}.ts"
    rm -f "$fixture"
  done
}

setup_file() {
  remove_fixtures
  write_fixture ArgvSpawnSync 'import { spawnSync } from "node:child_process";' 'spawnSync("git", ["rev-parse", "HEAD"]);'
  write_fixture MultilineTemplate 'import { execSync } from "node:child_process";' 'execSync(`' 'git rev-parse HEAD' '`);'
  write_fixture BunArgv 'Bun.spawnSync(["git", "rev-parse", "HEAD"]);'
  write_fixture AliasedExecFileSync 'import { execFileSync } from "node:child_process";' 'const run = execFileSync;' 'run("git", ["rev-parse", "HEAD"]);'
  write_fixture DestructuredRequire 'const { execSync } = require("child_process");' 'execSync("git status");'

  local scan_status=0
  bun "$SCRIPT" > "$BATS_FILE_TMPDIR/fixtures.out" 2>&1 || scan_status=$?
  printf '%s\n' "$scan_status" > "$BATS_FILE_TMPDIR/fixtures.status"
  remove_fixtures
}

teardown_file() {
  remove_fixtures
}

assert_flagged() {
  [ "$(cat "$BATS_FILE_TMPDIR/fixtures.status")" -eq 1 ]
  grep -qF "${FIXTURE_PREFIX}$1.ts" "$BATS_FILE_TMPDIR/fixtures.out"
}

@test "the fixture scan reports only the fixtures" {
  # Every reported location belongs to a fixture, so the committed tree is clean.
  run cat "$BATS_FILE_TMPDIR/fixtures.out"
  [ "${lines[0]}" = "error: production Git metadata execution must use GitMetadataClient:" ]
  local location found=0
  for location in "${lines[@]:1}"; do
    if [[ "$location" =~ ^[^[:space:]]+:[0-9]+:[0-9]+: ]]; then
      [[ "$location" == "utils/${FIXTURE_PREFIX}"* ]]
      found=$((found + 1))
    fi
  done
  [ "$found" -eq "${#FIXTURE_SLUGS[@]}" ]
}

@test "rejects a new direct argv git execution outside the owner" {
  assert_flagged ArgvSpawnSync
}

@test "rejects a multiline template shell command" {
  assert_flagged MultilineTemplate
}

@test "rejects Bun argv execution" {
  assert_flagged BunArgv
}

@test "rejects an aliased child-process execution" {
  assert_flagged AliasedExecFileSync
}

@test "rejects a destructured CommonJS child-process execution" {
  assert_flagged DestructuredRequire
}
