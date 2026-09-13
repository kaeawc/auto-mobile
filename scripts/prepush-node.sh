#!/usr/bin/env bash
#
# Reproduce the Node/TypeScript pull-request gates before pushing. This is
# deliberately serial: quick deterministic gates stop a doomed push before the
# unit lane starts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

# Keep local validation hermetic when the caller cannot chmod the default
# user-level AutoMobile directories (for example, a restricted agent sandbox).
export AUTOMOBILE_DATA_DIR="${AUTOMOBILE_DATA_DIR:-$ROOT/scratch/prepush-node-data}"
export AUTOMOBILE_LOG_DIR="${AUTOMOBILE_LOG_DIR:-$ROOT/scratch/prepush-node-logs}"

changed_mode=0
if [[ "${1:-}" == "--changed" ]]; then
  changed_mode=1
  shift
elif [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage: scripts/prepush-node.sh [--changed]

Run the Node pull-request gates in fail-fast order. --changed uses the
repository's affected-unit-test runner; format, typecheck, and lint remain
full because their repository-wide baselines and boundaries have no safe
changed-file mode.
EOF
  exit 0
fi

if [[ "$#" -ne 0 ]]; then
  echo "Unknown option: $1" >&2
  exit 2
fi

gate_names=()
gate_results=()
gate_seconds=()
started_at="$(date +%s)"

print_summary() {
  local index total elapsed
  total=$(( $(date +%s) - started_at ))
  echo
  echo "Node pre-push validation summary:"
  for index in "${!gate_names[@]}"; do
    printf '  %-8s %3ss  %s\n' "${gate_results[$index]}" "${gate_seconds[$index]}" "${gate_names[$index]}"
  done
  printf '  total    %3ss\n' "$total"
}

run_gate() {
  local name="$1"
  local gate_started status elapsed
  shift

  gate_started="$(date +%s)"
  echo "==> ${name}"
  if "$@"; then
    status="PASS"
  else
    status="FAIL"
  fi
  elapsed=$(( $(date +%s) - gate_started ))
  gate_names+=("$name")
  gate_results+=("$status")
  gate_seconds+=("$elapsed")
  if [[ "$status" != "PASS" ]]; then
    print_summary
    exit 1
  fi
}

stale_base_guard() {
  git fetch --quiet origin main
  if ! git merge-base --is-ancestor origin/main HEAD; then
    echo "Current HEAD does not contain origin/main. Rebase or merge origin/main before trusting local Node gates." >&2
    return 1
  fi
}

run_gate "stale-base guard" stale_base_guard
run_gate "format check" bun run format:check
run_gate "typecheck" bun run typecheck
run_gate "lint" bun run lint
run_gate "repository lint tests" bun test test/lint/

unit_mode="unit"
if [[ "$changed_mode" -eq 1 ]]; then
  unit_mode="changed"
  echo "Using changed unit-test selection against origin/main."
fi
run_gate "${unit_mode} unit tests" env \
  AUTOMOBILE_TEST_MODE=true \
  AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=720 \
  AUTOMOBILE_UNIT_JUNIT_DIR=scratch/timing-unit-reports \
  bash scripts/test-ts.sh "$unit_mode"
if [[ "$changed_mode" -eq 1 ]]; then
  # The timing gate owns affected-test selection in this mode. Do not give it
  # the earlier changed-only JUnit report as though it were a complete lane.
  run_gate "unit timing budget" env \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    bash scripts/validate-bun-test-timings.sh
else
  run_gate "unit timing budget" env \
    BUN_TEST_TIMING_BASE_REF=origin/main \
    BUN_TEST_TIMING_REPORT_DIR=scratch/timing-unit-reports \
    bash scripts/validate-bun-test-timings.sh
fi

print_summary
echo "Node pre-push validation passed."
