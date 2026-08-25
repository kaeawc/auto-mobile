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
#   1. Parallel pass — everything EXCEPT files tagged `serial-boundary`. We
#      parallelize ACROSS files but keep each file's tests SERIAL
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
set -euo pipefail

BATS_DIR="${1:-test/bats}"
SERIAL_TAG="serial"

log() { printf '%s\n' "$*" >&2; }

ensure_gnu_parallel() {
  if command -v parallel > /dev/null 2>&1; then
    return 0
  fi
  log "GNU parallel not found; installing"
  if command -v brew > /dev/null 2>&1; then
    brew install parallel
  elif command -v apt-get > /dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq parallel
  else
    log "ERROR: cannot install GNU parallel (no brew or apt-get)"
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

ensure_gnu_parallel
silence_parallel_citation

# _NPROCESSORS_ONLN is portable across the Linux and macOS runners; fall back to
# 2 if the host does not expose it.
jobs="$(getconf _NPROCESSORS_ONLN 2> /dev/null || echo 2)"
if ! [[ "$jobs" =~ ^[0-9]+$ ]] || [[ "$jobs" -lt 1 ]]; then
  jobs=2
fi

log "Parallel pass: bats --jobs $jobs --no-parallelize-within-files (excluding $SERIAL_TAG) over $BATS_DIR"
bats --jobs "$jobs" --no-parallelize-within-files --filter-tags "!$SERIAL_TAG" "$BATS_DIR"

log "Serial pass: bats (only $SERIAL_TAG) over $BATS_DIR"
bats --filter-tags "$SERIAL_TAG" "$BATS_DIR"
