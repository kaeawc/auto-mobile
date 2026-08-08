#!/usr/bin/env bash
#
# scripts/validate-loop.sh — one fail-fast local pre-push command (issue #5149).
#
# Composes the fast local primitives added across the build/test optimization
# set:
#   1. self-heal deps (ensure_node_modules, #5051) so a fresh worktree just works;
#   2. run the cheap gate — `turbo run lint build typecheck` — where turbo
#      parallelizes the three tasks. `lint` already includes the parallel
#      boundary-check runner (#5121); `typecheck` is the cached tsgo gate (#5124);
#   3. run the fast parallel test suite (`test:fast`, bun test --parallel, #5033)
#      ONLY if the gate passed.
#
# Tests run AFTER the gate rather than alongside it: `test:fast` already uses
# cores-2 workers, so overlapping it with the gate would oversubscribe the CPU.
# A gate failure exits in a few seconds without paying for the ~20s test run.
#
# bash-3.2 safe. Two env seams let the BATS test inject controlled gate/test
# commands (trusted test-only input; never wire from an untrusted source).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# shellcheck source=scripts/lib/shell-core.sh disable=SC1091
source "$ROOT/scripts/lib/shell-core.sh"
ensure_node_modules "$ROOT"

gate_cmd="${VALIDATE_LOOP_GATE_CMD:-turbo run lint build typecheck --output-logs=errors-only}"
test_cmd="${VALIDATE_LOOP_TEST_CMD:-bash scripts/test-fast.sh}"

echo "==> gate: ${gate_cmd}"
# shellcheck disable=SC2086 # intentional word-split of the command string
if ! ${gate_cmd}; then
  echo "==> gate failed — skipping tests" >&2
  exit 1
fi

echo "==> gate passed; running tests: ${test_cmd}"
# shellcheck disable=SC2086 # intentional word-split of the command string
exec ${test_cmd}
