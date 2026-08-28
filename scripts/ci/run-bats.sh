#!/usr/bin/env bash
#
# Runs the BATS shell-test suite with cross-file parallelism.
#
# The suite is ~900 tests across ~125 files and, run serially, dominated the
# CI wall-clock (~3.5min on the required "Shell Tests" gate). Most files isolate
# their state in `mktemp -d` temp dirs (temp git repos, temp roots passed to
# scripts via root-override args), so they are independent and can run
# concurrently.
#
# Two passes:
#
#   1. Parallel pass — everything EXCEPT files tagged `serial`. We parallelize
#      ACROSS files but keep each file's tests SERIAL
#      (`--no-parallelize-within-files`): tests inside one file share `setup()`
#      / `teardown()`, so serializing within a file is the conservative default
#      while still spreading the files across every core.
#
#   2. Serial pass — files tagged `serial`. Two hazard classes carry the tag:
#      (a) files that write a fixture into the REAL source tree and scan it, so
#      they race each other (and any tree scan) under parallelism; and (b) files
#      that spawn real processes and assert timing-bounded reaping, which flakes
#      under CPU oversubscription. They run one file at a time here, after the
#      parallel pass, so no fixture is present while an unrelated file scans, and
#      the process tests get an uncontended CPU. A guard test
#      (test/scripts/batsSerialTags.test.ts) fails if a new real-tree mutator
#      lands without the tag.
#
# `bats --jobs` requires GNU parallel; this script installs it when missing and
# suppresses its first-run citation notice so it does not spam CI logs.
#
# The functions are defined unconditionally but main() only runs when the script
# is executed, not sourced, so test/bats/run-bats.bats can source it and probe
# individual functions (e.g. is_gnu_parallel) without triggering an install.

SERIAL_TAG="serial"

log() { printf '%s\n' "$*" >&2; }

# `bats --jobs` requires *GNU* parallel specifically. A bare `command -v
# parallel` is not enough: the unrelated moreutils `parallel` is also named
# `parallel` and would satisfy it while breaking bats. Only GNU parallel prints
# a "GNU parallel" banner from `--version`, so probe that capability.
is_gnu_parallel() {
  parallel --version 2> /dev/null | head -1 | grep -q "GNU parallel"
}

ensure_gnu_parallel() {
  if is_gnu_parallel; then
    return 0
  fi
  log "GNU parallel not found (or a non-GNU 'parallel' is on PATH); installing"
  if command -v brew > /dev/null 2>&1; then
    brew install parallel
  elif command -v apt-get > /dev/null 2>&1; then
    sudo apt-get update -qq
    # The Debian/Ubuntu 'parallel' package IS GNU parallel.
    sudo apt-get install -y -qq parallel
  else
    log "ERROR: cannot install GNU parallel (no brew or apt-get)"
    return 1
  fi
  if ! is_gnu_parallel; then
    log "ERROR: GNU parallel still not available after install (a non-GNU 'parallel' may be shadowing it on PATH)"
    return 1
  fi
}

# GNU parallel prints a citation banner to stderr on every invocation until the
# user acknowledges it. Drop the marker so the suite's output stays readable.
silence_parallel_citation() {
  local home_dir="${PARALLEL_HOME:-$HOME/.parallel}"
  mkdir -p "$home_dir"
  touch "$home_dir/will-cite"
}

# _NPROCESSORS_ONLN is portable across the Linux and macOS runners; fall back to
# 2 if the host does not expose it.
job_count() {
  local jobs
  jobs="$(getconf _NPROCESSORS_ONLN 2> /dev/null || echo 2)"
  if ! [[ "$jobs" =~ ^[0-9]+$ ]] || [[ "$jobs" -lt 1 ]]; then
    jobs=2
  fi
  printf '%s\n' "$jobs"
}

# Run each file independently so a BATS suite-level discovery/counting defect
# cannot discard later files after earlier tests have passed. `read -d ''` and
# find's `-print0` preserve paths without relying on GNU-only sort options.
run_bats_serially() {
  local bats_dir="$1" bats_file rc=0
  while IFS= read -r -d '' bats_file; do
    bats "$bats_file" || rc=1
  done < <(find "$bats_dir" -type f -name '*.bats' -print0)
  return "$rc"
}

main() {
  # errexit is deliberately NOT set: this script branches on the exit status of
  # helper functions (ensure_gnu_parallel, is_gnu_parallel) and of each bats
  # pass, which under `set -e` both trips SC2310 (set -e is suppressed inside a
  # function invoked in a condition) and would abort before the serial pass.
  # Errors are handled explicitly instead, and rc aggregates both passes.
  set -uo pipefail
  local bats_dir="${1:-test/bats}"

  if [[ "${AUTOMOBILE_BATS_SERIAL_ONLY:-false}" == "true" ]]; then
    log "Serial-only pass: bats each file over $bats_dir"
    run_bats_serially "$bats_dir"
    return $?
  fi

  ensure_gnu_parallel || exit 1
  silence_parallel_citation

  local jobs
  jobs="$(job_count)"

  local rc=0
  log "Parallel pass: bats --jobs $jobs --no-parallelize-within-files (excluding $SERIAL_TAG) over $bats_dir"
  bats --jobs "$jobs" --no-parallelize-within-files --filter-tags "!$SERIAL_TAG" "$bats_dir" || rc=1

  log "Serial pass: bats (only $SERIAL_TAG) over $bats_dir"
  bats --filter-tags "$SERIAL_TAG" "$bats_dir" || rc=1

  return "$rc"
}

# Only run when executed directly; sourcing (from tests) just loads the functions.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
