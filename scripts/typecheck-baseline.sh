#!/usr/bin/env bash
#
# Scoped TypeScript type-check gate (issues #3001, #11787).
#
# Bun's bundler skips type-checking, so `bun build.ts` / `bun test` compile code
# that `tsgo` would reject. Two independent passes close that gap, and neither has
# a baseline: both baselines reached zero and were deleted, so ANY error fails.
#
#   scripts/typecheck-baseline.sh                  src (tsconfig.json)
#   scripts/typecheck-baseline.sh --project=test   every test/**/*.ts (tsconfig.test-*.json)
#
# The test project is checked as three sequential shards (daemon+server, features, everything
# else). One tsgo over all of test/ peaked near 7 GiB and was SIGKILLed on the Node ubuntu job
# (#15580); each shard peaks near 4.5 GiB. `tsconfig.test-rest.json` excludes the other shards'
# directories rather than listing its own, so a new test directory is covered by construction.
#
# Types guard: both projects resolve `bun:*` modules and the `Bun` global from
# `@types/bun` (tsconfig `types`). If that package is missing, tsgo reports
# TS2688 ("Cannot find type definition file") or TS2307 for a `bun:` module.
# Those are an environment failure, not code drift: the gate fails (exit 4) on
# them, so a broken install cannot pass silently.
#
# Usage:
#   scripts/typecheck-baseline.sh                         # src gate
#   scripts/typecheck-baseline.sh --project=test          # test gate (CI)

set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSCONFIGS=("tsconfig.json")
PROJECT="src"
cd "$ROOT"

# shellcheck source=scripts/lib/host-heavy-run.sh
source "$ROOT/scripts/lib/host-heavy-run.sh"

for arg in "$@"; do
  case "$arg" in
    --project=test)
      TSCONFIGS=("tsconfig.test-daemon.json" "tsconfig.test-features.json" "tsconfig.test-rest.json")
      PROJECT="test"
      ;;
    *)
      echo "Unknown argument: $arg (expected --project=test)" >&2
      exit 2
      ;;
  esac
done

# Run a command the way an `if` condition would (errexit is ignored inside it)
# and record its exit status in RUN_STATUS.
RUN_STATUS=0
run_capture_status() {
  local run_rc=0
  "$@" || run_rc=$?
  RUN_STATUS="${run_rc}"
}

# TYPECHECK_TSC_CMD overrides the invocation -- used by the BATS tests to inject
# canned output. It is `eval`ed, so treat it as TRUSTED input only.
run_tsc() {
  # A subshell, so an `exit` inside an injected TYPECHECK_TSC_CMD ends only the
  # type-check, not this script.
  (
    if [[ -n "${TYPECHECK_TSC_CMD:-}" ]]; then
      eval "$TYPECHECK_TSC_CMD" 2>&1
    else
      # Sequential, so only one shard's memory is live at a time; the worst status wins.
      local tsconfig shard_rc=0 worst_rc=0
      for tsconfig in "${TSCONFIGS[@]}"; do
        set +e
        host_heavy_run host_heavy_tsgo "$tsconfig" 2>&1
        shard_rc=$?
        set -e
        if [[ "$shard_rc" -gt "$worst_rc" ]]; then worst_rc="$shard_rc"; fi
      done
      exit "$worst_rc"
    fi
  )
}

# Top-level error lines only (indented detail lines and summaries are dropped).
error_lines() {
  { grep -E '^[^[:space:]].*\([0-9]+,[0-9]+\): error TS[0-9]+' || true; }
}

# tsgo exits non-zero when it reports diagnostics, so capture the status.
tsc_output_file="$(mktemp)"
run_capture_status run_tsc > "$tsc_output_file"
tsc_status="$RUN_STATUS"
raw_tsc="$(<"$tsc_output_file")"
rm -f "$tsc_output_file"
errors="$(printf '%s\n' "$raw_tsc" | error_lines)"
error_count="$(printf '%s' "$errors" | grep -c . || true)"

# Fail closed: a non-zero exit with NO parseable errors means tsgo never ran.
if [[ "$tsc_status" -ne 0 && "$error_count" -eq 0 ]]; then
  echo "ERROR: tsgo exited $tsc_status without reporting any parseable errors." >&2
  echo "The type-checker likely failed to run. Raw output:" >&2
  printf '%s\n' "$raw_tsc" >&2
  exit 3
fi

# Types guard (see header): missing @types/bun must never read as ordinary drift.
env_failures="$(printf '%s\n' "$errors" | grep -E "error TS2688|error TS2307: Cannot find module 'bun[:']" || true)"
if [[ -n "$env_failures" ]]; then
  echo "ERROR: type definitions are not resolving (is @types/bun installed? run bun install):" >&2
  printf '%s\n' "$env_failures" | head -5 >&2
  exit 4
fi

if [[ "$error_count" -gt 0 ]]; then
  echo "" >&2
  echo "❌ typecheck gate ($PROJECT): $error_count TypeScript error(s) (no baseline; any error fails):" >&2
  printf '%s\n' "$errors" >&2
  exit 1
fi
echo "✅ typecheck gate ($PROJECT): no type errors."
