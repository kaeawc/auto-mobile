#!/usr/bin/env bash
# Shared hermetic unit invocation for the canonical shards and timing samples.
# Sourced by callers after they resolve the repository root and runner OS.
# bunfig.toml supplies the suite-wide preloads in both paths.

bun_test_timeout_ms() {
  local runner_os="$1"
  if [[ "$runner_os" == macOS ]]; then
    printf '%s\n' "${AUTOMOBILE_TEST_TIMEOUT_MS:-20000}"
  else
    printf '%s\n' "${AUTOMOBILE_TEST_TIMEOUT_MS:-5000}"
  fi
}

# Files per `bun test --isolate` process in a unit shard's isolated group
# (0 = one process for the whole group). A long isolated process slows down as
# it ages, so the group is split into fixed-size sequential chunks (#10583).
# The default comes from the sweep in docs/design-docs/ci/unit-lane-scaling.md.
UNIT_ISOLATED_CHUNK_DEFAULT=30
unit_isolated_chunk_size() {
  printf '%s\n' "${AUTOMOBILE_UNIT_ISOLATED_CHUNK_SIZE-$UNIT_ISOLATED_CHUNK_DEFAULT}"
}

configure_bun_unit_test() {
  local root="$1" runner_os="$2"
  export AUTOMOBILE_TEST_MODE="${AUTOMOBILE_TEST_MODE:-true}"
  # Selection (shards/changed/files), JUnit paths and bail belong to the caller.
  # Timing/watchdog log paths label each shard; they do not change test semantics.
  # The randomized diagnostic deliberately uses a separate non-isolated command.
  # Windows' unsharded lane retains its existing platform-specific flags.
  # Consumed by the sourcing scripts; Bash arrays cannot be exported.
  # shellcheck disable=SC2034
  BUN_UNIT_TEST_COMMAND=(bun test --isolate --timeout "$(bun_test_timeout_ms "$runner_os")" \
    --no-orphans --preload "$root/test/setup/fileTimingProbe.ts")
  # The same contract without --isolate, for the allow-listed files that share
  # one process per shard (test/shared-process-allowlist.txt, #10583).
  # shellcheck disable=SC2034
  BUN_UNIT_SHARED_TEST_COMMAND=(bun test --timeout "$(bun_test_timeout_ms "$runner_os")" \
    --no-orphans --preload "$root/test/setup/fileTimingProbe.ts")
}
