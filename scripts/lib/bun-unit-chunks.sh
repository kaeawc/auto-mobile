#!/usr/bin/env bash
# Internal shard child. The caller bounds this entire loop with one watchdog.
#
# Usage: bun-unit-chunks.sh ROOT RUNNER_OS CHUNK_FILES REPORT_DIR SHARD [CMD... --] FILES...
#
# Runs FILES in sequential `bun test` processes of at most CHUNK_FILES files, so
# no process lives long enough for its isolate overhead and RSS to grow (#10213).
#
# Unit lane (default): CMD is the canonical unit command and JUnit reports go to
# REPORT_DIR/shard-SHARD-chunk-N.xml, N from 0.
#
# Coverage mode: when CMD words precede a literal `--` and
# AUTOMOBILE_CHUNK_COVERAGE_ROOT is set, CMD is the `bun test ...` command with
# its --coverage flags. Each chunk then adds --config/--reporter flags and writes
# $AUTOMOBILE_CHUNK_COVERAGE_ROOT/shard-SHARD-chunk-N.{toml,xml,log} plus the
# lcov directory shard-SHARD-chunk-N/, with N from 1. A shard-SHARD.chunks
# manifest holds the chunk total so a consumer can tell a missing chunk from a
# passing one. Must run from the repository root (bunfig.toml is read from it).
set -euo pipefail
root="$1" runner_os="$2" chunk_files="$3" report_dir="$4" shard="$5"
shift 5
# shellcheck source=scripts/lib/bun-unit-test.sh disable=SC1091
source "$root/scripts/lib/bun-unit-test.sh"

has_separator=0
for arg in "$@"; do
  if [[ "$arg" == -- ]]; then
    has_separator=1
    break
  fi
done
command_words=()
if [[ "$has_separator" -eq 1 ]]; then
  while [[ "$1" != -- ]]; do
    command_words+=("$1")
    shift
  done
  shift
else
  configure_bun_unit_test "$root" "$runner_os"
  command_words=("${BUN_UNIT_TEST_COMMAND[@]}")
fi
files=("$@")
coverage_root="${AUTOMOBILE_CHUNK_COVERAGE_ROOT:-}"
total=$(((${#files[@]} + chunk_files - 1) / chunk_files))
if [[ -n "$coverage_root" ]]; then
  mkdir -p "$coverage_root"
  printf '%s\n' "$total" > "$coverage_root/shard-${shard}.chunks"
fi

current_label=""
current_log=""
# shellcheck disable=SC2329 # Invoked through the TERM trap below.
interrupted() {
  # The shard watchdog sends TERM to this group: surface the chunk it cut short.
  printf 'INTERRUPTED: coverage shard %s chunk %s was running when the shard budget expired; log tail:\n' \
    "$shard" "$current_label"
  if [[ -n "$current_log" && -f "$current_log" ]]; then tail -n 60 "$current_log"; fi
  exit 143
}
if [[ -n "$coverage_root" ]]; then trap interrupted TERM; fi

status=0
chunk=0
for ((offset = 0; offset < ${#files[@]}; offset += chunk_files)); do
  args=("${command_words[@]}")
  chunk_slice=("${files[@]:offset:chunk_files}")
  if [[ -n "$coverage_root" ]]; then
    chunk_id="shard-${shard}-chunk-$((chunk + 1))"
    chunk_base="$coverage_root/$chunk_id"
    current_label="$((chunk + 1))/${total}"
    current_log="${chunk_base}.log"
    # Bun 1.3.14 takes the lcov directory from bunfig, not --coverage-dir.
    bun scripts/lib/write-coverage-bunfig.ts "${chunk_base}.toml" "$chunk_base"
    args=("${args[0]}" "--config=${chunk_base}.toml" "${args[@]:1}"
      --reporter junit --reporter-outfile "${chunk_base}.xml")
    printf '\n==> coverage shard %s chunk %s: %d files, started %s\n' \
      "$shard" "$current_label" "${#chunk_slice[@]}" "$(date -u +%H:%M:%S)"
  elif [[ -n "$report_dir" ]]; then
    # The timing gate globs *.xml and artifact uploads include the whole directory.
    args+=(--reporter junit --reporter-outfile "$report_dir/shard-${shard}-chunk-${chunk}.xml")
  fi
  chunk_status=0
  if [[ -n "$coverage_root" ]]; then
    # Output goes to a file, as for the former whole-shard log: Bun can hit
    # WriteFailed on a pipe. The log is replayed after the chunk finishes.
    "${args[@]}" "${chunk_slice[@]}" > "$current_log" 2>&1 || chunk_status=$?
    command cat "$current_log"
    if [[ "$chunk_status" -ne 0 ]]; then
      printf 'FAIL: coverage shard %s chunk %s exited with status %d (log: %s)\n' \
        "$shard" "$current_label" "$chunk_status" "$current_log"
    fi
  else
    "${args[@]}" "${chunk_slice[@]}" || chunk_status=$?
  fi
  # Bun's ordinary (no --bail) shard runs remaining files after an assertion
  # failure. Keep that coverage, retaining the first failure across fresh runs.
  if [[ "$status" -eq 0 && "$chunk_status" -ne 0 ]]; then
    status="$chunk_status"
  fi
  chunk=$((chunk + 1))
done
exit "$status"
