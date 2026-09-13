#!/usr/bin/env bats

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/scripts/prepush-integration.sh"
FIXTURE="test/daemon/socketServerKeyValue.integration.test.ts"
FIXTURE_BACKUP=""

teardown() {
  if [[ -n "$FIXTURE_BACKUP" ]]; then
    cp "$FIXTURE_BACKUP" "$FIXTURE"
  fi
}

@test "runs only an affected integration file and skips unchanged runtime inputs" {
  FIXTURE_BACKUP="$BATS_TEST_TMPDIR/socket-server-key-value.backup"
  cp "$FIXTURE" "$FIXTURE_BACKUP"
  printf '\n// prepush fixture\n' >> "$FIXTURE"

  run env TEST_TS_PRINT_CMD=1 AUTOMOBILE_INTEGRATION_TEST_BASE_REF=origin/main bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Integration tests: running 1 affected file(s)."* ]]
  [[ "$output" == *"$FIXTURE"* ]]
  [[ "$output" == *"Pinned runtime graph: skipped"* ]]
}

@test "fails when the integration base ref cannot be resolved" {
  run env AUTOMOBILE_INTEGRATION_TEST_BASE_REF=definitely-no-such-ref bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"Revision 'definitely-no-such-ref' does not exist"* ]]
  [[ "$output" != *"no changed test/**/*.integration.test.ts files"* ]]
}
