#!/usr/bin/env bats

SCRIPT="scripts/prepush-node.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  COMMAND_LOG="${MOCK_BIN}/commands.log"
  export COMMAND_LOG
  if [[ -e scratch/timing-unit-reports ]]; then
    mv scratch/timing-unit-reports "$MOCK_BIN/timing-unit-reports.saved"
  fi

  cat > "${MOCK_BIN}/git" <<'SCRIPT'
#!/bin/bash
if [[ "$*" == *"rev-parse HEAD" ]]; then printf '%s\n' head; exit 0; fi
printf 'git %s\n'  "$*" >> "$COMMAND_LOG"
if [[ "$*" == "ls-files --others --exclude-standard" ]]; then
  printf '%s\n' "${MOCK_UNTRACKED_FILES:-}"
  exit "${MOCK_UNTRACKED_STATUS:-0}"
fi
if [[ "$1" == "merge-base" ]]; then
  exit "${MOCK_MERGE_BASE_STATUS:-0}"
fi
if [[ "$1" == "diff" && "$2" == "--no-renames" && "$3" == "--name-only" ]]; then
  if [[ -n "${MOCK_CHANGED_FILES_DIFF_STATUS:-}" ]]; then
    exit "$MOCK_CHANGED_FILES_DIFF_STATUS"
  fi
  if [[ -n "${MOCK_CHANGED_FILES:-}" ]]; then
    printf '%s\n' "$MOCK_CHANGED_FILES"
  fi
fi
if [[ "$1" == "diff" && "$2" == "--no-renames" && "$4" == "--diff-filter=ACMRD" && -n "${MOCK_WORKTREE_CHANGED_FILES:-}" ]]; then
  printf '%s\n' "$MOCK_WORKTREE_CHANGED_FILES"
fi
SCRIPT
  chmod +x "${MOCK_BIN}/git"

  cat > "${MOCK_BIN}/bun" <<'SCRIPT'
#!/bin/bash
if [[ "$*" == *"--print-dirty-at-start"* ]]; then printf '%s\n' "${MOCK_ATTESTATION_START:-clean}"; exit 0; fi
printf 'bun %s\n'  "$*" >> "$COMMAND_LOG"
if [[ "$1" == "scripts/lib/affectedTests.ts" ]]; then
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == "--changed-files" ]]; then cp "$2" "$COMMAND_LOG.changed"; fi
    if [[ "$1" == "--out-dir" ]]; then
      printf '%s\n' "$2" > "$COMMAND_LOG.selection-dir"
      printf '%s' "${MOCK_AFFECTED_UNIT:-}" > "$2/unit.txt"
      printf '%s' "${MOCK_AFFECTED_INTEGRATION:-}" > "$2/integration-safe.txt"
      printf '%s' "${MOCK_AFFECTED_FALLBACK:-}" > "$2/fallback.txt"
      printf '%s' "${MOCK_AFFECTED_BATS:-}" > "$2/bats.txt"
    fi
    shift
  done
  exit "${MOCK_SELECTOR_STATUS:-0}"
fi
if [[ "$*" == "run typecheck:test" ]]; then
  exit "${MOCK_TEST_TYPECHECK_STATUS:-0}"
fi
if [[ "$*" == "scripts/generate-tool-definitions.ts --check" ]]; then
  exit "${MOCK_TOOL_DEFINITIONS_STATUS:-0}"
fi
SCRIPT
  chmod +x "${MOCK_BIN}/bun"

  cat > "${MOCK_BIN}/bash" <<'SCRIPT'
#!/bin/bash
printf 'bash %s\n' "$*" >> "$COMMAND_LOG"
if [[ "$1" == "scripts/test-ts.sh" && -n "${AUTOMOBILE_UNIT_JUNIT_DIR:-}" && "${MOCK_UNIT_REPORT:-0}" -eq 1 ]]; then
  mkdir -p "$AUTOMOBILE_UNIT_JUNIT_DIR"
  printf '<testsuites/>\n' > "$AUTOMOBILE_UNIT_JUNIT_DIR/x.xml"
fi
if [[ "$1" == "scripts/validate-bun-test-timings.sh" ]]; then
  exit "${MOCK_TIMING_STATUS:-0}"
fi
if [[ "$1" == "scripts/all_fast_validate_checks.sh" ]]; then
  exit "${MOCK_FAST_VALIDATION_STATUS:-0}"
fi
SCRIPT
  chmod +x "${MOCK_BIN}/bash"

  cat > "${MOCK_BIN}/env" <<'SCRIPT'
#!/bin/bash
if [[ "$*" == *"AUTOMOBILE_TEST_MODE=true"* || "$*" == *"BUN_TEST_TIMING_BASE_REF=origin/main"* ]]; then
  printf 'env %s\n' "$*" >> "$COMMAND_LOG"
fi
exec /usr/bin/env "$@"
SCRIPT
  chmod +x "${MOCK_BIN}/env"

  # Present so the offline link pass is part of the gate regardless of the host.
  printf '#!/bin/bash\nexit 0\n' > "${MOCK_BIN}/lychee"
  chmod +x "${MOCK_BIN}/lychee"

  cat > "${MOCK_BIN}/uname" <<'SCRIPT'
#!/bin/bash
printf '%s\n' "${MOCK_UNAME:-Linux}"
SCRIPT
  chmod +x "${MOCK_BIN}/uname"
}

teardown() {
  if [[ -n "${untracked_selection_dir:-}" ]]; then
    rm -rf "$untracked_selection_dir"
  fi
  if [[ -f "$COMMAND_LOG.selection-dir" ]]; then
    local selection_dir
    selection_dir="$(cat "$COMMAND_LOG.selection-dir")"
    rm -rf "$selection_dir"
  fi
  rm -rf scratch/timing-unit-reports
  if [[ -e "$MOCK_BIN/timing-unit-reports.saved" ]]; then
    mv "$MOCK_BIN/timing-unit-reports.saved" scratch/timing-unit-reports
  fi
  rm -rf "$MOCK_BIN"
}

@test "runs Node gates in fail-fast order" {
  run env -u RUNNER_OS MOCK_UNAME=Linux PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -eq 0 ]
  local -a lint_integrations=(test/lint/*.integration.test.ts)
  local lint_command="bun test ${lint_integrations[*]}"
  expected_log=$'git fetch --quiet origin main\ngit merge-base --is-ancestor origin/main HEAD\nbun run format:check\nbun run typecheck\nbun run lint\nbun run typecheck:test\nbun scripts/generate-tool-definitions.ts --check\nbash scripts/all_fast_validate_checks.sh --only yaml,schema-copy-drift,bun-version-coherence,stdlib-first,dependency-decisions,sharp-matrix,runtime-pins,shell-quote-boundary,security-boundary,app-bundle-metadata-boundary,ios-ctrl-proxy-process-boundary,element-resolution-ratchet,shared-process-allowlist,workflow-assertion-triggers,mkdocs-nav,docs-assets,env-var-docs,debug-tags,datetime-now-literal,lfs-pointers,lychee-offline --max-parallel 4\n'"$lint_command"$'\nbun run test:image:bun\nenv AUTOMOBILE_TEST_MODE=true AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=720 AUTOMOBILE_UNIT_JUNIT_DIR=scratch/timing-unit-reports bash scripts/test-ts.sh unit\nbash scripts/test-ts.sh unit\ngit diff --no-renames --name-only origin/main...HEAD --\ngit diff --no-renames --cached --name-only --diff-filter=ACMRD\ngit diff --no-renames --name-only --diff-filter=ACMRD\nenv BUN_TEST_TIMING_BASE_REF=origin/main BUN_TEST_TIMING_REPORT_DIR=scratch/timing-unit-reports bash scripts/validate-bun-test-timings.sh\nbash scripts/validate-bun-test-timings.sh'
  [ "$(grep -v '/scripts/ci/record-attestations.sh node ' "$COMMAND_LOG")" = "$expected_log" ] || {
    printf 'Expected:\n%s\nActual:\n%s\n' "$expected_log" "$(cat "$COMMAND_LOG")"
    return 1
  }
  [ "$(grep -c '/scripts/ci/record-attestations.sh node ' "$COMMAND_LOG")" -eq 1 ]
  [[ "$output" == *"Node pre-push validation passed"* ]]
}

@test "records attestations after success and recorder failure does not fail the gate" {
  local recorder="${MOCK_BIN}/record-attestations"
  cat > "$recorder" <<'SCRIPT'
#!/bin/bash
printf 'record %s\n' "$*" >> "$COMMAND_LOG"
exit 1
SCRIPT
  chmod +x "$recorder"
  run env -u RUNNER_OS PREPUSH_ATTESTATION_RECORDER="$recorder" MOCK_UNAME=Linux PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  [ "$(grep -c '^record node ' "$COMMAND_LOG")" -eq 1 ]
  [[ "$output" == *"Node pre-push validation passed."* ]]
  grep -F '=pass:' "$COMMAND_LOG"
  grep -F 'test/db integration fast path=skip:' "$COMMAND_LOG"
  grep -F -- '--scope partial --scope-note changed-mode unit selection' "$COMMAND_LOG"
  ! grep -F '=PASS:' "$COMMAND_LOG"
  [ "$(grep -n '^record node ' "$COMMAND_LOG" | cut -d: -f1)" -gt "$(grep -n '^env BUN_TEST_TIMING_BASE_REF=origin/main bash scripts/validate-bun-test-timings.sh' "$COMMAND_LOG" | tail -1 | cut -d: -f1)" ]
}

@test "test typecheck runs once in default and changed modes" {
  for mode in default changed; do
    : > "$COMMAND_LOG"
    if [[ "$mode" == "changed" ]]; then
      run env -u RUNNER_OS MOCK_UNAME=Linux PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
    else
      run env -u RUNNER_OS MOCK_UNAME=Linux PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"
    fi

    [ "$status" -eq 0 ]
    [ "$(grep -c '^bun run typecheck:test$' "$COMMAND_LOG")" -eq 1 ]
    [[ "$output" == *"PASS"*"test typecheck"* ]]
  done
}

@test "test typecheck failure stops later gates" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_TEST_TYPECHECK_STATUS=1 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed

  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL"*"test typecheck"* ]]
  ! grep -F 'bun scripts/generate-tool-definitions.ts --check' "$COMMAND_LOG"
  ! grep -F 'bun test test/lint/' "$COMMAND_LOG"
  ! grep -F 'bun scripts/lib/affectedTests.ts ' "$COMMAND_LOG"
}

@test "tool definitions drift passes in default and changed modes" {
  for mode in default changed; do
    : > "$COMMAND_LOG"
    if [[ "$mode" == "changed" ]]; then
      run env -u RUNNER_OS MOCK_UNAME=Linux PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
    else
      run env -u RUNNER_OS MOCK_UNAME=Linux PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"
    fi

    [ "$status" -eq 0 ]
    [ "$(grep -c '^bun scripts/generate-tool-definitions.ts --check$' "$COMMAND_LOG")" -eq 1 ]
    [[ "$output" == *"PASS"*"tool definitions drift"* ]]
  done
}

@test "tool definitions drift failure stops later gates and gives regenerate command" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_TOOL_DEFINITIONS_STATUS=1 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed

  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL"*"tool definitions drift"* ]]
  [[ "$output" == *"bun scripts/generate-tool-definitions.ts && bunx oxfmt schemas/tool-definitions.json"* ]]
  ! grep -F 'bun test test/lint/' "$COMMAND_LOG"
  ! grep -F 'bun scripts/lib/affectedTests.ts ' "$COMMAND_LOG"
}

@test "static Fast Validation subset runs in both modes and failure stops later gates" {
  for mode in default changed; do
    : > "$COMMAND_LOG"
    if [[ "$mode" == "changed" ]]; then
      run env -u RUNNER_OS MOCK_UNAME=Linux PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
    else
      run env -u RUNNER_OS MOCK_UNAME=Linux PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"
    fi

    [ "$status" -eq 0 ]
    [ "$(grep -c '^bash scripts/all_fast_validate_checks.sh --only ' "$COMMAND_LOG")" -eq 1 ]
    grep -F 'shared-process-allowlist' "$COMMAND_LOG"
    grep -F 'runtime-pins' "$COMMAND_LOG"
    grep -F 'lychee-offline' "$COMMAND_LOG"
    [[ "$output" == *"PASS"*"fast validation static checks"* ]]
  done

  : > "$COMMAND_LOG"
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_FAST_VALIDATION_STATUS=1 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL"*"fast validation static checks"* ]]
  ! grep -F 'bun test test/lint/' "$COMMAND_LOG"
  ! grep -F 'bun scripts/lib/affectedTests.ts ' "$COMMAND_LOG"
}

@test "DB integration fast path runs for each selected directory" {
  local changed_file
  for changed_file in src/daemon/session.ts src/db/store.ts src/server/api.ts test/db/query.integration.test.ts; do
    : > "$COMMAND_LOG"
    run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_CHANGED_FILES="$changed_file" PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

    [ "$status" -eq 0 ]
    [ "$(grep -c '^bun test test/db/.*\.integration\.test\.ts' "$COMMAND_LOG")" -eq 1 ]
    grep -F 'env AUTOMOBILE_TEST_MODE=true bun test test/db/' "$COMMAND_LOG"
    [[ "$output" == *"PASS"*"test/db integration fast path"* ]]
  done
}

@test "DB integration fast path skips unrelated changes" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_CHANGED_FILES=src/tools/observe.ts PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipping test/db integration fast path; no changes under src/daemon/, src/db/, src/server/, or test/db/."* ]]
  ! grep -F 'bun test test/db/' "$COMMAND_LOG"
  [[ "$output" == *"SKIP"*"test/db integration fast path"* ]]
}

@test "DB integration fast path sees tracked worktree changes" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_WORKTREE_CHANGED_FILES=src/db/local.ts PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(grep -c '^bun test test/db/.*\.integration\.test\.ts' "$COMMAND_LOG")" -eq 1 ]
}

@test "DB integration fast path fails when branch diff fails" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_CHANGED_FILES_DIFF_STATUS=2 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL"*"test/db integration fast path"* ]]
  ! grep -F 'bun test test/db/' "$COMMAND_LOG"
}

@test "changed mode uses the existing changed-test lane" {
  run env -u RUNNER_OS MOCK_UNAME=Linux PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed

  [ "$status" -eq 0 ]
  grep -Fx 'bun run test:image:bun' "$COMMAND_LOG"
  [ "$(grep -cx 'bash scripts/test-ts.sh changed' "$COMMAND_LOG")" -eq 1 ]
  grep -Fx 'env BUN_TEST_TIMING_BASE_REF=origin/main bash scripts/validate-bun-test-timings.sh' "$COMMAND_LOG"
  grep -Fx 'env AUTOMOBILE_TEST_MODE=true AUTOMOBILE_UNIT_JUNIT_DIR=scratch/timing-unit-reports bash scripts/test-ts.sh changed' "$COMMAND_LOG"
  ! grep -F 'AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=720' "$COMMAND_LOG"
  grep -Fx 'bash scripts/validate-bun-test-timings.sh' "$COMMAND_LOG"
}

@test "changed source without unit reports leaves timing selection to the validator" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_CHANGED_FILES=src/a.ts MOCK_UNIT_REPORT=0 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  [ ! -f scratch/timing-unit-reports/x.xml ]
  grep -Fx 'env BUN_TEST_TIMING_BASE_REF=origin/main bash scripts/validate-bun-test-timings.sh' "$COMMAND_LOG"
  ! grep -F 'BUN_TEST_TIMING_REPORT_DIR=' "$COMMAND_LOG"
}

@test "changed source with unit reports passes them to the timing validator" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_CHANGED_FILES=src/a.ts MOCK_UNIT_REPORT=1 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  [ -f scratch/timing-unit-reports/x.xml ]
  grep -Fx 'env BUN_TEST_TIMING_BASE_REF=origin/main BUN_TEST_TIMING_REPORT_DIR=scratch/timing-unit-reports bash scripts/validate-bun-test-timings.sh' "$COMMAND_LOG"
}

@test "Windows keeps the wall-timeout opt-out" {
  run env -u RUNNER_OS MOCK_UNAME=MINGW64_NT-10.0 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -eq 0 ]
  ! grep -F 'AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=720' "$COMMAND_LOG"
  grep -Fx 'env AUTOMOBILE_TEST_MODE=true AUTOMOBILE_UNIT_JUNIT_DIR=scratch/timing-unit-reports bash scripts/test-ts.sh unit' "$COMMAND_LOG"
  ! grep -F 'validate-bun-test-timings.sh' "$COMMAND_LOG"
}

@test "macOS skips timing by default and --timing forces it" {
  run env -u RUNNER_OS MOCK_UNAME=Darwin PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipping unit timing budget gate on macOS; CI only runs it on Linux. Pass --timing to force it locally."* ]]
  ! grep -F 'validate-bun-test-timings.sh' "$COMMAND_LOG"

  : > "$COMMAND_LOG"
  run env -u RUNNER_OS MOCK_UNAME=Darwin PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --timing --changed

  [ "$status" -eq 0 ]
  grep -Fx 'bash scripts/validate-bun-test-timings.sh' "$COMMAND_LOG"
}

@test "stale base stops before local gates" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_MERGE_BASE_STATUS=1 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"does not contain origin/main"* ]]
  [ "$(cat "$COMMAND_LOG")" = $'git fetch --quiet origin main\ngit merge-base --is-ancestor origin/main HEAD' ]
}

@test "full Node run records full scope and preserves initial dirtiness" {
  local recorder="${MOCK_BIN}/record-attestations"
  cat > "$recorder" <<'SCRIPT'
#!/bin/bash
printf 'record %s\n' "$*" >> "$COMMAND_LOG"
SCRIPT
  chmod +x "$recorder"
  run env -u RUNNER_OS PREPUSH_ATTESTATION_RECORDER="$recorder" MOCK_ATTESTATION_START=dirty MOCK_UNAME=Darwin PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -F -- '--expected-head head --started-dirty --scope full' "$COMMAND_LOG"
  grep -F '=pass:' "$COMMAND_LOG"
  grep -F 'test/db integration fast path=skip:' "$COMMAND_LOG"
  ! grep -F '=PASS:' "$COMMAND_LOG"
}

@test "changed selection invokes selector and reference-only unit and safe integration runners" {
  run env MOCK_UNAME=macOS MOCK_CHANGED_FILES=src/a.ts MOCK_WORKTREE_CHANGED_FILES=src/deleted.ts \
    MOCK_AFFECTED_UNIT=$'test/packaging/runtimeGraphPinning.test.ts\n' MOCK_AFFECTED_INTEGRATION=$'test/a.integration.test.ts\n' \
    PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  grep -F 'bun scripts/lib/affectedTests.ts --changed-files ' "$COMMAND_LOG"
  grep -Fx 'src/a.ts' "$COMMAND_LOG.changed"
  grep -Fx 'src/deleted.ts' "$COMMAND_LOG.changed"
  grep -Fx 'bash scripts/test-ts.sh unit test/packaging/runtimeGraphPinning.test.ts' "$COMMAND_LOG"
  grep -Fx 'bash scripts/prepush-integration-safe.sh test/a.integration.test.ts' "$COMMAND_LOG"
}

@test "changed selection runs the always-run unit and bats tests the selector emits" {
  printf '#!/bin/bash\nprintf "bats %%s\\n" "$*" >> "$COMMAND_LOG"\n' > "${MOCK_BIN}/bats"
  chmod +x "${MOCK_BIN}/bats"
  run env MOCK_UNAME=macOS MOCK_CHANGED_FILES=benchmark/x.json \
    MOCK_AFFECTED_UNIT=$'test/server/interactionTools.outputSchema.test.ts\ntest/lint/validToolsRegistryParity.test.ts\n' \
    MOCK_AFFECTED_BATS=$'test/bats/linux-qualification-workflow.bats\n' \
    PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  grep -Fx 'bash scripts/test-ts.sh unit test/server/interactionTools.outputSchema.test.ts test/lint/validToolsRegistryParity.test.ts' "$COMMAND_LOG"
  grep -Fx 'bats test/bats/linux-qualification-workflow.bats' "$COMMAND_LOG"
}

@test "changed selection fallbacks run full lanes" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_AFFECTED_UNIT=$'test/extra.test.ts\n' MOCK_AFFECTED_FALLBACK=$'unit\nintegration\n' \
    PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  [ "$(grep -cx 'bash scripts/test-ts.sh unit' "$COMMAND_LOG")" -eq 1 ]
  ! grep -F 'bash scripts/test-ts.sh changed' "$COMMAND_LOG"
  ! grep -F 'bash scripts/test-ts.sh unit test/extra.test.ts' "$COMMAND_LOG"
  grep -Fx 'env AUTOMOBILE_TEST_MODE=true AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=720 AUTOMOBILE_UNIT_JUNIT_DIR=scratch/timing-unit-reports bash scripts/test-ts.sh unit' "$COMMAND_LOG"
  grep -Fx 'env BUN_TEST_TIMING_BASE_REF=origin/main BUN_TEST_TIMING_REPORT_DIR=scratch/timing-unit-reports bash scripts/validate-bun-test-timings.sh' "$COMMAND_LOG"
  [[ "$output" == *"PASS"*"unit tests (selection fell back to full lane)"* ]]
  grep -Fx 'bash scripts/prepush-integration-safe.sh' "$COMMAND_LOG"
}

@test "empty reference-only selection leaves import-covered units to Bun changed" {
  run env MOCK_UNAME=macOS PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  grep -Fx 'bash scripts/test-ts.sh changed' "$COMMAND_LOG"
  ! grep -F 'bash scripts/test-ts.sh unit' "$COMMAND_LOG"
  [[ "$output" == *"No reference-only unit extras selected."* ]]
}

@test "selector failure stops the changed gate" {
  run env MOCK_SELECTOR_STATUS=1 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL"*"affected-test selection"* ]]
  ! grep -F 'bun test test/lint/' "$COMMAND_LOG"
  ! grep -F 'bun run test:image:bun' "$COMMAND_LOG"
  ! grep -F 'bash scripts/test-ts.sh ' "$COMMAND_LOG"
  local selection_dir
  selection_dir="$(cat "$COMMAND_LOG.selection-dir")"
  [ -f "$selection_dir/changed.txt" ]
  [[ "$output" == *"Affected-test selection diagnostics kept at: $selection_dir"* ]]
}

@test "changed selection includes untracked integration tests and fixtures" {
  run env MOCK_UNTRACKED_FILES=$'test/new.integration.test.ts\ntest/data/new.json' \
    PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  grep -Fx 'git ls-files --others --exclude-standard' "$COMMAND_LOG"
  grep -Fx 'test/new.integration.test.ts' "$COMMAND_LOG.changed"
  grep -Fx 'test/data/new.json' "$COMMAND_LOG.changed"
}

@test "untracked file enumeration failure stops selection" {
  run env MOCK_UNTRACKED_STATUS=2 MOCK_CHANGED_FILES=src/a.ts PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL"*"affected-test selection"* ]]
  ! grep -F 'bun scripts/lib/affectedTests.ts ' "$COMMAND_LOG"
  ! grep -F 'bun test test/lint/' "$COMMAND_LOG"
  untracked_selection_dir="$(printf '%s\n' "$output" | sed -n 's/^Affected-test selection diagnostics kept at: //p')"
  [ -d "$untracked_selection_dir" ]
  grep -Fx 'src/a.ts' "$untracked_selection_dir/changed.txt"
}

@test "unlisted integration exit 3 fails gate and keeps diagnostics" {
  run env MOCK_SELECTOR_STATUS=3 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL"*"affected-test selection"* ]]
  local selection_dir
  selection_dir="$(cat "$COMMAND_LOG.selection-dir")"
  [ -d "$selection_dir" ]
  [ -f "$selection_dir/changed.txt" ]
  [[ "$output" == *"Affected-test selection diagnostics kept at: $selection_dir"* ]]
  ! grep -F 'bash scripts/prepush-integration-safe.sh' "$COMMAND_LOG"
  ! grep -F 'bun test test/lint/' "$COMMAND_LOG"
}

@test "successful gate removes its unique affected selection directory" {
  run env PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  local selection_dir
  selection_dir="$(cat "$COMMAND_LOG.selection-dir")"
  [[ "$selection_dir" == */scratch/affected-tests.* ]]
  [ ! -e "$selection_dir" ]
  [[ "$output" != *"diagnostics kept"* ]]
}

@test "failure after selection retains diagnostics until whole gate exits" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_CHANGED_FILES=src/a.ts MOCK_TIMING_STATUS=1 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL"*"unit timing budget"* ]]
  local selection_dir
  selection_dir="$(cat "$COMMAND_LOG.selection-dir")"
  [ -d "$selection_dir" ]
  grep -Fx 'src/a.ts' "$selection_dir/changed.txt"
  grep -Fx 'bash scripts/test-ts.sh changed' "$COMMAND_LOG"
  [[ "$output" == *"PASS"*"affected-test runs"*"FAIL"*"unit timing budget"* ]]
  [[ "$output" == *"Affected-test selection diagnostics kept at: $selection_dir"* ]]
}

@test "changed source runs repository lint directory once after selection and before the unit lane" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_CHANGED_FILES=src/a.ts PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  [ "$(grep -cx 'bun test test/lint/' "$COMMAND_LOG")" -eq 1 ]
  [ "$(grep -n '^bun scripts/lib/affectedTests.ts ' "$COMMAND_LOG" | cut -d: -f1)" -lt "$(grep -nx 'bun test test/lint/' "$COMMAND_LOG" | cut -d: -f1)" ]
  [ "$(grep -nx 'bun test test/lint/' "$COMMAND_LOG" | cut -d: -f1)" -lt "$(grep -nx 'bash scripts/test-ts.sh changed' "$COMMAND_LOG" | cut -d: -f1)" ]
}

@test "benchmark-only changes skip repository lint directory" {
  run env -u RUNNER_OS MOCK_UNAME=Linux MOCK_CHANGED_FILES=benchmark/x.json PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  ! grep -F 'bun test test/lint/' "$COMMAND_LOG"
  [[ "$output" == *"Skipping repository lint tests; no changes"* ]]
  [[ "$output" == *"SKIP"*"repository lint tests"* ]]
}

@test "repository lint path triggers include all repository scan and root configuration inputs" {
  local file
  for file in src/a.ts test/a.ts scripts/a.sh oxlint-plugins/a.ts android/a.kt ios/a.swift docs/a.md skills/a.md schemas/a.json .claude/a.md .github/a.yml .oxlintrc.json package.json bun.lock bunfig.toml turbo.json tsconfig.json tsconfig.test.json; do
    : > "$COMMAND_LOG"
    run env -u RUNNER_OS MOCK_UNAME=Darwin MOCK_CHANGED_FILES="$file" PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
    [ "$status" -eq 0 ]
    [ "$(grep -cx 'bun test test/lint/' "$COMMAND_LOG")" -eq 1 ]
  done
}

@test "repository lint uses tracked worktree and untracked paths as well as branch paths" {
  run env -u RUNNER_OS MOCK_UNAME=Darwin MOCK_CHANGED_FILES=benchmark/x.json MOCK_WORKTREE_CHANGED_FILES=android/a.kt PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  grep -Fx 'bun test test/lint/' "$COMMAND_LOG"

  : > "$COMMAND_LOG"
  run env -u RUNNER_OS MOCK_UNAME=Darwin MOCK_CHANGED_FILES=benchmark/x.json MOCK_UNTRACKED_FILES=ios/a.swift PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  grep -Fx 'bun test test/lint/' "$COMMAND_LOG"
}

@test "full mode runs only repository lint integration files in the separate gate" {
  run env -u RUNNER_OS MOCK_UNAME=Linux PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"
  [ "$status" -eq 0 ]
  ! grep -Fx 'bun test test/lint/' "$COMMAND_LOG"
  grep '^bun test test/lint/' "$COMMAND_LOG" | grep -E '(^| )test/lint/oxlintConfigScoping\.integration\.test\.ts( |$)'
  [ "$(grep -c '^bun test test/lint/' "$COMMAND_LOG")" -eq 1 ]
}

@test "changed lint directory gate removes lint extras from affected unit and integration runs" {
  run env -u RUNNER_OS MOCK_UNAME=Darwin MOCK_CHANGED_FILES=src/a.ts \
    MOCK_AFFECTED_UNIT=$'test/lint/validToolsRegistryParity.test.ts\ntest/extra.test.ts\n' \
    MOCK_AFFECTED_INTEGRATION=$'test/lint/oxlintConfigScoping.integration.test.ts\ntest/a.integration.test.ts\n' \
    PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  grep -Fx 'bun test test/lint/' "$COMMAND_LOG"
  grep -Fx 'bash scripts/test-ts.sh unit test/extra.test.ts' "$COMMAND_LOG"
  grep -Fx 'bash scripts/prepush-integration-safe.sh test/a.integration.test.ts' "$COMMAND_LOG"
  ! grep -F 'test/lint/validToolsRegistryParity.test.ts' "$COMMAND_LOG"
  ! grep -F 'test/lint/oxlintConfigScoping.integration.test.ts' "$COMMAND_LOG"
}

@test "skipped lint directory gate preserves lint extras in affected unit and integration runs" {
  run env -u RUNNER_OS MOCK_UNAME=Darwin MOCK_CHANGED_FILES=benchmark/x.json \
    MOCK_AFFECTED_UNIT=$'test/lint/validToolsRegistryParity.test.ts\n' \
    MOCK_AFFECTED_INTEGRATION=$'test/lint/oxlintConfigScoping.integration.test.ts\n' \
    PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed
  [ "$status" -eq 0 ]
  ! grep -Fx 'bun test test/lint/' "$COMMAND_LOG"
  grep -Fx 'bash scripts/test-ts.sh unit test/lint/validToolsRegistryParity.test.ts' "$COMMAND_LOG"
  grep -Fx 'bash scripts/prepush-integration-safe.sh test/lint/oxlintConfigScoping.integration.test.ts' "$COMMAND_LOG"
}
