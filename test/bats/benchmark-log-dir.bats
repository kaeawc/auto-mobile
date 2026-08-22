#!/usr/bin/env bats

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
RESOLVER="$REPO_ROOT/scripts/resolve-auto-mobile-log-dir.ts"

setup() {
  FIXTURE="$(mktemp -d)"
  unset AUTOMOBILE_LOG_DIR AUTO_MOBILE_LOG_DIR AUTOMOBILE_DATA_DIR AUTO_MOBILE_DATA_DIR
}

teardown() {
  rm -rf "$FIXTURE"
}

@test "legacy override is used when the canonical variable is absent" {
  run env \
    AUTO_MOBILE_LOG_DIR="  legacy-logs  " \
    AUTOMOBILE_DAEMON_LAUNCH_CWD="$FIXTURE" \
    bun "$RESOLVER"

  [ "$status" -eq 0 ]
  [ "$output" = "$FIXTURE/legacy-logs" ]
}

@test "empty canonical override suppresses an inherited legacy value" {
  run env \
    AUTOMOBILE_LOG_DIR="" \
    AUTO_MOBILE_LOG_DIR="$FIXTURE/stale-legacy" \
    AUTOMOBILE_DATA_DIR="$FIXTURE/data" \
    AUTOMOBILE_DAEMON_LAUNCH_CWD="$FIXTURE" \
    bun "$RESOLVER"

  [ "$status" -eq 0 ]
  [ "$output" = "$FIXTURE/data/logs" ]
}

@test "canonical override is trimmed before benchmark diagnostics read it" {
  run env \
    AUTOMOBILE_LOG_DIR="  relative-logs  " \
    AUTOMOBILE_DAEMON_LAUNCH_CWD="$FIXTURE" \
    bun "$RESOLVER"

  [ "$status" -eq 0 ]
  [ "$output" = "$FIXTURE/relative-logs" ]
}
