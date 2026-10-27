#!/usr/bin/env bash
# Internal unit shard child (#10583). The caller bounds the whole run with one
# watchdog, which signals this script's process group.
#
# Usage: bun-unit-groups.sh ROOT RUNNER_OS REPORT_DIR SHARD FILES...
#
# The first AUTOMOBILE_UNIT_SHARED_FILE_COUNT files are on
# test/shared-process-allowlist.txt: they run together in ONE `bun test`
# process without --isolate. The remaining files then run in sequential
# `bun test --isolate` processes of at most AUTOMOBILE_UNIT_ISOLATED_CHUNK_SIZE
# files each (0 = a single process), because a long isolated process slows down
# as it ages. All use the canonical unit flags, preloads and timing probe. With
# REPORT_DIR set, JUnit goes to REPORT_DIR/shard-SHARD-shared.xml, then to
# REPORT_DIR/shard-SHARD.xml for an unsplit isolated group or to
# REPORT_DIR/shard-SHARD-iso-K.xml (K from 0) per isolated chunk. The isolated
# chunks still run after a shared-group failure and after a failed chunk; the
# first non-zero status is the exit status.
# Changed lanes also set AUTOMOBILE_UNIT_SHARED_CHUNK_SIZE to bound shared
# processes; ordinary unit lanes keep one shared process per shard.
set -euo pipefail
# The direct parent is a watchdog/shard subshell which can survive test-ts.
# Watch the exported lane owner instead; standalone callers watch their parent.
original_parent_pid="${AUTOMOBILE_TEST_TS_PARENT_PID:-$PPID}"
parent_is_alive() {
  if ! kill -0 "$original_parent_pid" 2>/dev/null; then
    echo 'test-ts: unit chunk caller is gone; stopping' >&2
    exit 1
  fi
}
root="$1" runner_os="$2" report_dir="$3" shard="$4"
shift 4
# shellcheck source=scripts/lib/bun-unit-test.sh
source "$root/scripts/lib/bun-unit-test.sh"
configure_bun_unit_test "$root" "$runner_os"

shared_count="${AUTOMOBILE_UNIT_SHARED_FILE_COUNT:-0}"
if ! [[ "$shared_count" =~ ^[0-9]+$ ]] || [[ "$shared_count" -gt "$#" ]]; then
  echo "AUTOMOBILE_UNIT_SHARED_FILE_COUNT must be 0..$#, got: ${shared_count}" >&2
  exit 2
fi
files=("$@")
shared_files=("${files[@]:0:shared_count}")
isolated_files=("${files[@]:shared_count}")

status=0
shared_chunk="${AUTOMOBILE_UNIT_SHARED_CHUNK_SIZE:-0}"
if ! [[ "$shared_chunk" =~ ^(0|[1-9][0-9]{0,8})$ ]]; then
  echo 'AUTOMOBILE_UNIT_SHARED_CHUNK_SIZE must be a non-negative integer below 1000000000' >&2
  exit 2
fi
if [[ "$shared_chunk" -eq 0 ]]; then shared_chunk="${#shared_files[@]}"; fi
for ((shared_offset = 0, shared_index = 0; shared_offset < ${#shared_files[@]}; shared_offset += shared_chunk, shared_index += 1)); do
  shared_slice=("${shared_files[@]:shared_offset:shared_chunk}")
  parent_is_alive
  args=("${BUN_UNIT_SHARED_TEST_COMMAND[@]}")
  if [[ -n "$report_dir" ]]; then
    shared_report="shard-${shard}-shared.xml"
    if [[ "$shared_chunk" -lt "${#shared_files[@]}" ]]; then shared_report="shard-${shard}-shared-${shared_index}.xml"; fi
    args+=(--reporter junit --reporter-outfile "$report_dir/$shared_report")
  fi
  printf 'test-ts: unit shard %s shared process: %d allow-listed files\n' "$shard" "${#shared_slice[@]}"
  group_status=0
  # Preloads run once in a shared process, so the timing probe records one
  # entry for the group; Bun's per-file headers in this log name the file.
  AUTOMOBILE_TEST_TIMING_GROUP_LABEL="unit shard ${shard} shared process (${#shared_slice[@]} files)" \
    "${args[@]}" "${shared_slice[@]}" || group_status=$?
  if [[ "$group_status" -ne 0 ]]; then
    printf 'FAIL: unit shard %s shared process exited with status %d\n' "$shard" "$group_status"
    if [[ "$status" -eq 0 ]]; then status="$group_status"; fi
  fi
done
isolated_chunk="$(unit_isolated_chunk_size)"
if ! [[ "$isolated_chunk" =~ ^(0|[1-9][0-9]{0,8})$ ]]; then
  echo "AUTOMOBILE_UNIT_ISOLATED_CHUNK_SIZE must be a non-negative integer below 1000000000, got: ${isolated_chunk}" >&2
  exit 2
fi
isolated_total="${#isolated_files[@]}"
split=0
if [[ "$isolated_chunk" -eq 0 || "$isolated_chunk" -ge "$isolated_total" ]]; then
  isolated_chunk="$isolated_total"
else
  split=1
fi
for ((offset = 0, chunk = 0; offset < isolated_total; offset += isolated_chunk, chunk += 1)); do
  parent_is_alive
  slice=("${isolated_files[@]:offset:isolated_chunk}")
  args=("${BUN_UNIT_TEST_COMMAND[@]}")
  report_name="shard-${shard}.xml"
  if [[ "$split" -eq 1 ]]; then
    report_name="shard-${shard}-iso-${chunk}.xml"
    printf 'test-ts: unit shard %s isolated chunk %d: %d of %d files\n' \
      "$shard" "$chunk" "${#slice[@]}" "$isolated_total"
  else
    printf 'test-ts: unit shard %s isolated process: %d files\n' "$shard" "$isolated_total"
  fi
  if [[ -n "$report_dir" ]]; then
    args+=(--reporter junit --reporter-outfile "$report_dir/$report_name")
  fi
  group_status=0
  "${args[@]}" "${slice[@]}" || group_status=$?
  if [[ "$status" -eq 0 ]]; then
    status="$group_status"
  fi
done
exit "$status"
