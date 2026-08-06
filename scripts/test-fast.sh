#!/usr/bin/env bash
#
# Fast local test loop: run the suite with bun's multi-process parallelism
# (`bun test --parallel=N`, which implies `--isolate`) instead of the near-
# sequential default `bun test --isolate`. Measured ~9x faster on a 16-core
# machine (186s -> ~20s). See issue #5033.
#
# Worker count = cores - 2 (floor 1). Leaving two cores free keeps a co-running
# editor/emulator from starving a worker past bun's default per-test timeout,
# which is how a fast fake-based unit test can spuriously time out under load.
#
# Extra arguments are forwarded to `bun test` (e.g. a file path to run a subset
# in parallel). Set TEST_FAST_PRINT_CMD=1 to print the resolved invocation
# instead of running it (used by test/bats/test-fast.bats).
set -euo pipefail

# Portable CPU count: nproc (GNU) is absent on stock macOS, where an empty
# `$(nproc)` breaks arithmetic. Fall back to sysctl/getconf (#3653).
cores="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

workers=$((cores - 2))
if [ "$workers" -lt 1 ]; then
  workers=1
fi

if [ "${TEST_FAST_PRINT_CMD:-}" = "1" ]; then
  echo "bun test --parallel=${workers} $*"
  exit 0
fi

exec bun test --parallel="${workers}" "$@"
