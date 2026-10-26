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
COHERENCE_WORKFLOW_FIXTURE=".github/workflows/zz-bun-coherence-fixture.yml"
LIST_CHECKS_FIXTURE=""

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
}

teardown() {
  rm -rf "$(dirname "$COHERENCE_FIXTURE")"
  rm -f "$COHERENCE_WORKFLOW_FIXTURE"
  if [[ -n "${LIST_CHECKS_FIXTURE}" ]]; then
    rm -rf "${LIST_CHECKS_FIXTURE}"
  fi
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

@test "fast validation lists the quiet grep pipeline guard" {
  run "$ABS_SCRIPT" --list

  [ "$status" -eq 0 ]
  [[ "$output" == *"pipefail-grep-q"*"(groups: lint,shell)"* ]]
}

@test "fast validation lists registered implementation scripts" {
  run "$ABS_SCRIPT" --list-checks

  [ "$status" -eq 0 ]
  [[ "$output" == *$'claude-plugin\tscripts/claude/validate_plugin.sh'* ]]
  [[ "$output" == *$'manual-test-python\tscripts/validate_manual_test_python.sh'* ]]
  [[ "$output" == *$'pipefail-grep-q\tscripts/shellcheck/validate_shell_pipefail_grepq.sh'* ]]
  while IFS=$'\t' read -r name script_path; do
    [[ -n "$name" ]]
    [[ -n "$script_path" ]]
    [[ "$script_path" == scripts/* ]]
  done <<< "$output"
  if [[ "$output" == *$'github-python-lock\t'* ]]; then
    grep -Eq $'^github-python-lock\t$' <<< "$output"
  fi
}

@test "fast validation lists missing registered implementation scripts" {
  LIST_CHECKS_FIXTURE="$(mktemp -d)"
  mkdir -p "${LIST_CHECKS_FIXTURE}/scripts/lib"
  cp "${ABS_SCRIPT}" "${LIST_CHECKS_FIXTURE}/scripts/all_fast_validate_checks.sh"
  cp "scripts/lib/spotlight-exclude.sh" "${LIST_CHECKS_FIXTURE}/scripts/lib/"
  cp "scripts/lib/shell-core.sh" "${LIST_CHECKS_FIXTURE}/scripts/lib/shell-core.sh"

  run "${LIST_CHECKS_FIXTURE}/scripts/all_fast_validate_checks.sh" --list-checks

  [ "$status" -eq 0 ]
  grep -Fqx -- $'claude-plugin\tscripts/claude/validate_plugin.sh' <<< "$output"
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

@test "Bun coherence rejects a setup-bun version off the repo pin" {
  run bun "$COHERENCE_SCRIPT"
  [ "$status" -eq 0 ]

  printf '%s\n' \
    'name: Bun coherence fixture' \
    'on: workflow_dispatch' \
    'jobs:' \
    '  some-other-job:' \
    '    runs-on: ubuntu-latest' \
    '    steps:' \
    '      - uses: oven-sh/setup-bun@v2' \
    '        with:' \
    '          bun-version: 1.5.0' > "$COHERENCE_WORKFLOW_FIXTURE"

  run bun "$COHERENCE_SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"zz-bun-coherence-fixture.yml"* ]]
  [[ "$output" == *"1.5.0"* ]]
}

@test "fast validation registers the tool definitions drift check" {
  run "$ABS_SCRIPT" --list-checks

  [ "$status" -eq 0 ]
  [[ "$output" == *$'tool-definitions\tscripts/generate-tool-definitions.ts'* ]]
}

@test "pull_request Fast Validation runs the tool definitions drift check" {
  # CI runs an explicit --only list; a registered check missing from it never runs.
  run grep -E -- '--only .*(^|,)tool-definitions(,|[[:space:]])' .github/workflows/pull_request.yml

  [ "$status" -eq 0 ]
}

@test "fast validation registers the prototype model drift check" {
  run "$ABS_SCRIPT" --list-checks

  [ "$status" -eq 0 ]
  [[ "$output" == *$'prototype-spec-models\tscripts/prototype/generate-prototype-spec-models.ts'* ]]
}

@test "pull_request Fast Validation runs the prototype model drift check" {
  run grep -E -- '--only .*(^|,)prototype-spec-models(,|[[:space:]])' .github/workflows/pull_request.yml

  [ "$status" -eq 0 ]
}

@test "fast validation registers the ProtoViewer notices drift check" {
  run "$ABS_SCRIPT" --list-checks

  [ "$status" -eq 0 ]
  [[ "$output" == *$'protoviewer-notices\tscripts/ios/protoviewer-notices.ts'* ]]
}

@test "all_fast_validate_checks registers the ProtoViewer store-listing check" {
  run "$ABS_SCRIPT" --list-checks

  [ "$status" -eq 0 ]
  [[ "$output" == *$'store-listing\tscripts/store-listing/validate-store-listing.ts'* ]]
}

@test "pull_request Fast Validation runs the ProtoViewer store-listing check" {
  run grep -E -- '--only .*(^|,)store-listing(,|[[:space:]])' .github/workflows/pull_request.yml

  [ "$status" -eq 0 ]
}

@test "pull_request Fast Validation runs the ProtoViewer notices drift check" {
  run grep -E -- '--only .*(^|,)protoviewer-notices(,|[[:space:]])' .github/workflows/pull_request.yml

  [ "$status" -eq 0 ]
}
