#!/usr/bin/env bats

SCRIPT="scripts/ci/verify-pinned-runtime-graph.sh"

setup() {
  REPO_ROOT="$(pwd)"
  FAKE_BIN="$BATS_TEST_TMPDIR/fake-bin"
  CONSUMER_DIR="$BATS_TEST_TMPDIR/consumer"
  CACHE_DIR="$BATS_TEST_TMPDIR/cache"
  export SMOKE_ARGS="$BATS_TEST_TMPDIR/smoke-args"
  export PACK_ENV="$BATS_TEST_TMPDIR/pack-env"
  export STEP_LOG="$BATS_TEST_TMPDIR/steps"
  ASSERT_ARGS="$BATS_TEST_TMPDIR/assert-args"
  COUNTER="$BATS_TEST_TMPDIR/mktemp-count"
  LOG_FILE="$REPO_ROOT/ci-logs/pinned-runtime-graph.log"
  rm -f "$LOG_FILE"
  mkdir -p "$FAKE_BIN"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'if [[ "$1" == *"pin-runtime-deps.ts" ]]; then exit 0; fi' \
    'if [[ "$1" == *"assert-installed-runtime-graph.ts" ]]; then' \
    '  printf "%s\n" "$@" > "$ASSERT_ARGS"' \
    '  echo assert >> "$STEP_LOG"' \
    '  exit "${ASSERT_STATUS:-0}"' \
    'fi' \
    'if [[ "$1" == *"smoke-installed-bundled-deps.ts" ]]; then' \
    '  printf "%s\n" "$@" > "$SMOKE_ARGS"' \
    '  echo smoke >> "$STEP_LOG"' \
    '  exit "${SMOKE_STATUS:-0}"' \
    'fi' \
    'if [[ "$1" == "install" ]]; then exit 0; fi' \
    'exit 0' > "$FAKE_BIN/bun"
  chmod +x "$FAKE_BIN/bun"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'printf "%s\n" "${AUTOMOBILE_TRIM_BUNDLED_DEPS:-unset}" > "$PACK_ENV"' \
    'touch automobile-cleanroom-fixture.tgz' \
    'printf "%s\n" "[{\"filename\":\"automobile-cleanroom-fixture.tgz\"}]"' > "$FAKE_BIN/npm"
  chmod +x "$FAKE_BIN/npm"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'count=0' \
    'if [[ -f "$MKTEMP_COUNTER" ]]; then count="$(<"$MKTEMP_COUNTER")"; fi' \
    'count=$((count + 1))' \
    'printf "%s" "$count" > "$MKTEMP_COUNTER"' \
    'if [[ "$count" -eq 1 ]]; then dir="$CLEANROOM_CONSUMER_DIR"; else dir="$CLEANROOM_CACHE_DIR"; fi' \
    'mkdir -p "$dir"' \
    'printf "%s\n" "$dir"' > "$FAKE_BIN/mktemp"
  chmod +x "$FAKE_BIN/mktemp"
}

@test "failure checks nested packages first and removes all temporary artifacts" {
  run env \
    PATH="$FAKE_BIN:$PATH" \
    ASSERT_ARGS="$ASSERT_ARGS" \
    ASSERT_STATUS=1 \
    CLEANROOM_CONSUMER_DIR="$CONSUMER_DIR" \
    CLEANROOM_CACHE_DIR="$CACHE_DIR" \
    MKTEMP_COUNTER="$COUNTER" \
    bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [ "$(sed -n '2p' "$ASSERT_ARGS")" = "$CONSUMER_DIR/node_modules/@kaeawc/auto-mobile" ]
  [ "$(sed -n '3p' "$ASSERT_ARGS")" = "$CONSUMER_DIR/node_modules" ]
  [ ! -e "$REPO_ROOT/automobile-cleanroom-fixture.tgz" ]
  [ ! -e "$CONSUMER_DIR" ]
  [ ! -e "$CACHE_DIR" ]
  grep -Fq 'Packed artifact: automobile-cleanroom-fixture.tgz' "$LOG_FILE"
}


@test "trimmed pack smoke runs after assertion against installed root" {
  run env PATH="$FAKE_BIN:$PATH" ASSERT_ARGS="$ASSERT_ARGS" \
    AUTOMOBILE_TRIM_BUNDLED_DEPS=false CI=false \
    CLEANROOM_CONSUMER_DIR="$CONSUMER_DIR" CLEANROOM_CACHE_DIR="$CACHE_DIR" \
    MKTEMP_COUNTER="$COUNTER" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$PACK_ENV")" = true ]
  [ "$(sed -n '2p' "$SMOKE_ARGS")" = "$CONSUMER_DIR/node_modules/@kaeawc/auto-mobile" ]
  [ "$(cat "$STEP_LOG")" = "$(printf 'assert\nsmoke')" ]
}

@test "smoke failure fails gate and cleans artifacts" {
  run env PATH="$FAKE_BIN:$PATH" ASSERT_ARGS="$ASSERT_ARGS" SMOKE_STATUS=7 \
    CLEANROOM_CONSUMER_DIR="$CONSUMER_DIR" CLEANROOM_CACHE_DIR="$CACHE_DIR" \
    MKTEMP_COUNTER="$COUNTER" bash "$SCRIPT"
  [ "$status" -eq 7 ]
  [ ! -e "$REPO_ROOT/automobile-cleanroom-fixture.tgz" ]
  [ ! -e "$CONSUMER_DIR" ]
  [ ! -e "$CACHE_DIR" ]
}
