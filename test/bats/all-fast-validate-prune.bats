#!/usr/bin/env bats
#
# Tests for prune_finished_jobs in scripts/all_fast_validate_checks.sh
#
# Regression guard for #3650: reassigning `pids=("${new_pids[@]}")` with an
# empty new_pids under `set -u` on bash < 4.4 (macOS default 3.2) throws
# "unbound variable" once all in-flight jobs drain. The empty case must be
# guarded.

SCRIPT="scripts/all_fast_validate_checks.sh"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
}

@test "prune_finished_jobs handles an empty job list under set -u" {
  # The bug only manifests on bash < 4.4; skip on newer bash (e.g. Linux CI).
  local major minor
  major="$(/bin/bash -c 'echo "${BASH_VERSINFO[0]}"')"
  minor="$(/bin/bash -c 'echo "${BASH_VERSINFO[1]}"')"
  if [[ "$major" -gt 4 || ( "$major" -eq 4 && "$minor" -ge 4 ) ]]; then
    skip "/bin/bash $major.$minor handles empty arrays under set -u"
  fi

  run /bin/bash -c '
    set -euo pipefail
    eval "$(awk "/^prune_finished_jobs\\(\\) \\{/{f=1} f{print} f&&/^\\}/{exit}" "$1")"
    pids=(); pid_names=()
    prune_finished_jobs
    echo DONE
  ' _ "$ABS_SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"DONE"* ]]
}

@test "fast validation lists the Bun version coherence check" {
  run "$ABS_SCRIPT" --list

  [ "$status" -eq 0 ]
  [[ "$output" == *"bun-version-coherence"* ]]
}
