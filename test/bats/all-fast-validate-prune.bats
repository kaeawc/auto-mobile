#!/usr/bin/env bats
#
# Tests for prune_finished_jobs in scripts/all_fast_validate_checks.sh
#
# Regression guard for #3650: reassigning `pids=("${new_pids[@]}")` with an
# empty new_pids under `set -u` on bash < 4.4 (macOS default 3.2) throws
# "unbound variable" once all in-flight jobs drain. The empty case must be
# guarded.

SCRIPT="scripts/all_fast_validate_checks.sh"
COHERENCE_SCRIPT="scripts/check-bun-version-coherence.ts"
COHERENCE_FIXTURE=".github/actions/bun-version-coherence-fixture/action.yml"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
}

teardown() {
  rm -rf "$(dirname "$COHERENCE_FIXTURE")"
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

@test "fast validation registers the runtime pin drift check" {
  run "$ABS_SCRIPT" --list

  [ "$status" -eq 0 ]
  [[ "$output" == *"runtime-pins"* ]]
}

@test "Bun coherence scans every composite action" {
  mkdir -p "$(dirname "$COHERENCE_FIXTURE")"
  printf '%s\n' \
    'name: Bun coherence fixture' \
    'runs:' \
    '  using: composite' \
    '  steps:' \
    '    - uses: oven-sh/setup-bun@v2' \
    '      with:' \
    '        bun-version: 0.1.0' > "$COHERENCE_FIXTURE"

  run bun "$COHERENCE_SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"bun-version-coherence-fixture/action.yml"* ]]
  [[ "$output" == *"0.1.0"* ]]
}
