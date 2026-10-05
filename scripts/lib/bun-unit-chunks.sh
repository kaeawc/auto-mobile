#!/usr/bin/env bash
# Internal shard child. The caller bounds this entire loop with one watchdog.
set -euo pipefail
root="$1" runner_os="$2" chunk_files="$3" report_dir="$4" shard="$5"
shift 5
# shellcheck source=scripts/lib/bun-unit-test.sh disable=SC1091
source "$root/scripts/lib/bun-unit-test.sh"
configure_bun_unit_test "$root" "$runner_os"
files=("$@")
status=0
chunk=0
for ((offset = 0; offset < ${#files[@]}; offset += chunk_files)); do
  args=("${BUN_UNIT_TEST_COMMAND[@]}")
  if [[ -n "$report_dir" ]]; then
    # The timing gate globs *.xml and artifact uploads include the whole directory.
    args+=(--reporter junit --reporter-outfile "$report_dir/shard-${shard}-chunk-${chunk}.xml")
  fi
  chunk_status=0
  "${args[@]}" "${files[@]:offset:chunk_files}" || chunk_status=$?
  # Bun's ordinary (no --bail) shard runs remaining files after an assertion
  # failure. Keep that coverage, retaining the first failure across fresh runs.
  if [[ "$status" -eq 0 && "$chunk_status" -ne 0 ]]; then
    status="$chunk_status"
  fi
  chunk=$((chunk + 1))
done
exit "$status"
