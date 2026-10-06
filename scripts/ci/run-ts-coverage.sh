#!/usr/bin/env bash
#
# Run TypeScript tests with Bun coverage. Coverage output is intentionally
# written to a log file instead of streamed live because Bun can hit WriteFailed
# when GitHub Actions receives the large coverage table.
#
# scripts/test-ts.sh runs the suite as a few shard processes, each recycling its
# Bun process every chunk of files (#10213). Every chunk has its own log, lcov
# directory and JUnit report under coverage/shards/shard-N-chunk-M.*.
#
# Usage:
#   scripts/ci/run-ts-coverage.sh [log-file]

set -euo pipefail

log_file="${1:-ci-logs/ts-coverage.log}"
mkdir -p "$(dirname "${log_file}")"
rm -rf coverage

# A chunk log is clean only when it reports zero failures and no non-zero count.
# Store the result instead of returning it so callers stay outside conditionals
# and set -e keeps its normal behavior for the helper invocation.
log_is_clean() {
  log_clean=0
  if grep -Eq '(^|[^0-9])0 fail' "$1" && ! grep -Eq '(^|[^0-9])[1-9][0-9]* fail' "$1"; then
    log_clean=1
  fi
}

set +e
bash scripts/test-ts.sh coverage > "${log_file}" 2>&1
status=$?
set -e

if [[ "${status}" -eq 0 ]]; then
  tail -n 80 "${log_file}"
  bash scripts/ci/verify-ts-coverage-output.sh coverage
  exit 0
fi

# Per-chunk logs when the chunked path ran; otherwise whatever per-shard logs exist.
unit_logs=(coverage/shards/shard-*-chunk-*.log)
if [[ ! -f "${unit_logs[0]:-}" ]]; then
  unit_logs=(coverage/shards/shard-*.log)
fi
if [[ -f "${unit_logs[0]:-}" ]]; then
  tolerated=1
  saw_write_failed=0
  coverage_lcov_files=()
  coverage_junit_files=()
  # A chunk that never started (the shard budget fired first) has no log, so a
  # tolerated run must still account for every chunk its shard planned.
  for manifest in coverage/shards/shard-*.chunks; do
    [[ -f "${manifest}" ]] || continue
    planned="$(< "${manifest}")"
    for ((chunk = 1; chunk <= planned; chunk += 1)); do
      if [[ ! -f "${manifest%.chunks}-chunk-${chunk}.log" ]]; then
        tolerated=0
      fi
    done
  done
  for unit_log in "${unit_logs[@]}"; do
    if grep -Eq 'error: An internal error occurred \(WriteFailed\)' "${unit_log}"; then
      saw_write_failed=1
    fi
    log_is_clean "${unit_log}"
    if [[ "${log_clean}" -eq 0 ]]; then
      tolerated=0
      break
    fi
  done
  if [[ "${tolerated}" -eq 1 && "${saw_write_failed}" -eq 1 ]]; then
    for unit_log in "${unit_logs[@]}"; do
      unit_dir="${unit_log%.log}"
      bash scripts/ci/verify-ts-coverage-output.sh "${unit_dir}"
      coverage_lcov_files+=("${unit_dir}/lcov.info")
      if [[ -f "${unit_dir}.xml" ]]; then
        coverage_junit_files+=("${unit_dir}.xml")
      fi
    done
    echo "::warning::Bun coverage ended with WriteFailed after tests passed; continuing to verify coverage output"
    tail -n 80 "${log_file}"
    if [[ "${#coverage_lcov_files[@]}" -eq 1 ]]; then
      cp "${coverage_lcov_files[0]}" coverage/lcov.info
    elif [[ "${#coverage_lcov_files[@]}" -gt 1 ]]; then
      bun scripts/lib/merge-lcov.ts coverage/lcov.info "${coverage_lcov_files[@]+"${coverage_lcov_files[@]}"}"
    fi
    if [[ "${#coverage_junit_files[@]}" -eq 1 ]]; then
      cp "${coverage_junit_files[0]}" coverage/junit.xml
    elif [[ "${#coverage_junit_files[@]}" -gt 1 ]]; then
      bun scripts/lib/merge-junit-reports.ts coverage/junit.xml "${coverage_junit_files[@]+"${coverage_junit_files[@]}"}"
    fi
    exit 0
  fi
elif grep -Eq 'error: An internal error occurred \(WriteFailed\)' "${log_file}" && grep -Eq '(^|[^0-9])0 fail' "${log_file}"; then
  echo "::warning::Bun coverage ended with WriteFailed after tests passed; continuing to verify coverage output"
  tail -n 80 "${log_file}"
  bash scripts/ci/verify-ts-coverage-output.sh coverage
  exit 0
fi

echo "::group::Failing tests"
bash "$(dirname "${BASH_SOURCE[0]}")/summarize-bun-failures.sh" "${log_file}" || true
echo "::endgroup::"
tail -n 200 "${log_file}"
# The combined log holds every shard and chunk, so its tail shows only the last
# one. Print the tail of each chunk (or shard) that did not finish clean.
if [[ -f "${unit_logs[0]:-}" ]]; then
  for unit_log in "${unit_logs[@]}"; do
    log_is_clean "${unit_log}"
    if [[ "${log_clean}" -eq 0 ]]; then
      echo "::group::Unclean coverage log: ${unit_log}"
      tail -n 60 "${unit_log}"
      echo "::endgroup::"
    fi
  done
fi
# Every watchdog, interrupted-chunk and failed-chunk line, not just the last
# shard's: with several shards each can fail for a different reason.
{ grep -hE 'wall-clock budget|^WATCHDOG:|^INTERRUPTED:|^FAIL: coverage' "${log_file}" || true; } |
  sed 's/^/::error::coverage: /' >&2
exit "${status}"
