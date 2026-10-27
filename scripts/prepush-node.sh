#!/usr/bin/env bash
#
# Reproduce the Node/TypeScript pull-request gates before pushing. This is
# deliberately serial: quick deterministic gates stop a doomed push before the
# unit lane starts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=scripts/lib/spotlight-exclude.sh
source "${ROOT}/scripts/lib/spotlight-exclude.sh"
cd "$ROOT"

# shellcheck source=scripts/lib/vcs-diff.sh
source "$ROOT/scripts/lib/vcs-diff.sh"
# shellcheck source=scripts/lib/db-integration-paths.sh
source "$ROOT/scripts/lib/db-integration-paths.sh"

# Keep local validation hermetic when the caller cannot chmod the default
# user-level AutoMobile directories (for example, a restricted agent sandbox).
export AUTOMOBILE_DATA_DIR="${AUTOMOBILE_DATA_DIR:-$ROOT/scratch/prepush-node-data}"
export AUTOMOBILE_LOG_DIR="${AUTOMOBILE_LOG_DIR:-$ROOT/scratch/prepush-node-logs}"

changed_mode=0
timing_requested=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --changed)
      changed_mode=1
      ;;
    --timing)
      timing_requested=1
      ;;
    --help | -h)
      cat <<'EOF'
Usage: scripts/prepush-node.sh [--changed] [--timing]

Run the Node pull-request gates in fail-fast order. --changed selects tests
early, then uses Bun's changed runner plus reference-only unit extras and
affected safe integration tests; a unit cap fallback replaces the changed lane
with the full unit lane, and integration caps use the full safe lane.
Repository lint tests run only test/lint/*.integration.test.ts in full mode;
--changed runs all of test/lint/ only for changes under src/, test/, scripts/,
oxlint-plugins/, android/, ios/, docs/, skills/, schemas/, .claude/, .github/,
or root .oxlintrc.json, package.json, bun.lock, bunfig.toml, turbo.json, and
tsconfig*.json. Tests in test/always-run-tests.txt always run.
Format, typecheck, and lint remain full repository gates. Typecheck and lint
stay strictly serial and separate: oxlint 1.88's experimental --type-check and
tsgolint diagnostics do not replace the fail-closed typecheck parser, the
TS2688/@types/bun guard, or separate src/test tsconfig projects.
Tool definitions drift and the static Fast Validation subset run in both modes.
The timing gate measures the unit lane's JUnit reports when source or runtime
inputs changed; changed test files alone are still re-run individually. Changed
mode without reports uses the timing validator's own affected-test selection.
--timing forces the timing gate on every OS.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

attestation_head=""
if [[ -e "${ROOT}/.git" ]]; then
  attestation_head="$(git -C "${ROOT}" rev-parse HEAD 2>/dev/null || true)"
elif [[ -d "${ROOT}/.jj" ]]; then
  attestation_head="$(jj -R "${ROOT}" log -r @- --no-graph -T commit_id 2>/dev/null || true)"
fi
# Failure to capture initial cleanliness must suppress the attestation.
attestation_start="$(bun "${ROOT}/scripts/ci/produce-attestations.ts" --print-dirty-at-start --lane node 2>/dev/null || true)"
attestation_options=(--expected-head "$attestation_head")
if [[ "$attestation_start" != clean ]]; then
  attestation_options+=(--started-dirty)
fi


runner_os="${RUNNER_OS:-}"
if [[ -z "$runner_os" ]]; then
  case "$(uname -s 2> /dev/null || true)" in
    Darwin) runner_os="macOS" ;;
    MINGW* | MSYS* | CYGWIN*) runner_os="Windows" ;;
    *) runner_os="$(uname -s 2> /dev/null || echo unknown)" ;;
  esac
fi

gate_names=()
gate_results=()
gate_seconds=()
started_at="$(date +%s)"

print_summary() {
  local index total elapsed
  total=$(( $(date +%s) - started_at ))
  echo
  echo "Node pre-push validation summary:"
  for index in "${!gate_names[@]}"; do
    printf '  %-8s %3ss  %s\n' "${gate_results[$index]}" "${gate_seconds[$index]}" "${gate_names[$index]}"
  done
  printf '  total    %3ss\n' "$total"
}

run_gate() {
  local name="$1"
  local gate_started status elapsed
  shift

  gate_started="$(date +%s)"
  echo "==> ${name}"
  gate_skipped=0
  if "$@"; then
    status="PASS"
    if [[ "$gate_skipped" -eq 1 ]]; then status="SKIP"; fi
  else
    status="FAIL"
  fi
  elapsed=$(( $(date +%s) - gate_started ))
  gate_names+=("$name")
  gate_results+=("$status")
  gate_seconds+=("$elapsed")
  if [[ "$status" == "FAIL" ]]; then
    print_summary
    exit 1
  fi
}

stale_base_guard() {
  git fetch --quiet origin main
  if ! git merge-base --is-ancestor origin/main HEAD; then
    echo "Current HEAD does not contain origin/main. Rebase or merge origin/main before trusting local Node gates." >&2
    return 1
  fi
}

tool_definitions_drift_guard() {
  if bun scripts/generate-tool-definitions.ts --check; then
    return 0
  fi
  echo "Regenerate with: bun scripts/generate-tool-definitions.ts && bunx oxfmt schemas/tool-definitions.json" >&2
  return 1
}

# The tool-free, TypeScript-relevant subset of the CI Fast Validation job
# (pull_request.yml "Run fast validation checks" + "Run offline lychee link
# check"), about 10s wall. Boundary checks that `bun run lint` already runs via
# check-boundaries.sh are not repeated. Shell, Kotlin, XML and docs-syntax
# checks belong to scripts/prepush-shell.sh and the platform gates.
FAST_VALIDATION_CHECKS="yaml,schema-copy-drift,bun-version-coherence,stdlib-first,dependency-decisions,sharp-matrix,runtime-pins,shell-quote-boundary,security-boundary,app-bundle-metadata-boundary,ios-ctrl-proxy-process-boundary,element-resolution-ratchet,shared-process-allowlist,workflow-assertion-triggers,mkdocs-nav,docs-assets,env-var-docs,debug-tags,datetime-now-literal,lfs-pointers"

fast_validation_static_checks() {
  local checks="$FAST_VALIDATION_CHECKS"
  # CI always has lychee; skip the offline link pass on machines without it.
  if command -v lychee > /dev/null 2>&1; then
    checks="${checks},lychee-offline"
  else
    echo "lychee not installed; skipping lychee-offline (CI still runs it)." >&2
  fi
  bash scripts/all_fast_validate_checks.sh --only "$checks" --max-parallel 4
}

db_integration_fast_path() {
  local branch_changes worktree_changes rc paths_changed
  local -a path_filters=()
  branch_changes="$(vcs_changed_files_since_merge_base origin/main)"
  rc=$?
  if [[ "$rc" -ne 0 ]]; then return "$rc"; fi
  worktree_changes="$(vcs_touched_files_including_deleted ${path_filters[@]+"${path_filters[@]}"})"
  rc=$?
  if [[ "$rc" -ne 0 ]]; then return "$rc"; fi
  paths_changed="$(db_integration_paths_changed <<< "${branch_changes}"$'\n'"${worktree_changes}")"
  if [[ "$paths_changed" == "yes" ]]; then
    env AUTOMOBILE_TEST_MODE=true bun test test/db/*.integration.test.ts
  else
    gate_skipped=1
    echo "Skipping test/db integration fast path; no changes under src/daemon/, src/db/, src/server/, or test/db/."
  fi
}

affected_selection_dir=""
fallback_unit=0
repository_lint_directory_ran=0
cleanup_affected_selection() {
  local exit_code=$?
  if [[ -n "$affected_selection_dir" ]]; then
    if [[ "$exit_code" -eq 0 ]]; then
      rm -rf "$affected_selection_dir"
    else
      echo "Affected-test selection diagnostics kept at: $affected_selection_dir" >&2
    fi
  fi
}

affected_test_selection() {
  local branch_changes worktree_changes untracked_changes="" selection_dir rc caller_options="$-"
  local -a path_filters=()
  mkdir_spotlight_excluded "$ROOT/scratch"
  selection_dir="$(mktemp -d "$ROOT/scratch/affected-tests.XXXXXX")" || return $?
  affected_selection_dir="$selection_dir"
  trap cleanup_affected_selection EXIT
  set +e
  branch_changes="$(vcs_changed_files_since_merge_base origin/main)"
  rc=$?
  if [[ "$caller_options" == *e* ]]; then set -e; fi
  if [[ "$rc" -ne 0 ]]; then return "$rc"; fi
  set +e
  worktree_changes="$(vcs_touched_files_including_deleted ${path_filters[@]+"${path_filters[@]}"})"
  rc=$?
  if [[ "$caller_options" == *e* ]]; then set -e; fi
  if [[ "$rc" -ne 0 ]]; then return "$rc"; fi
  printf '%s\n%s\n' "$branch_changes" "$worktree_changes" > "$selection_dir/changed.txt"
  if [[ ! -d .jj || -e .git ]]; then
    untracked_changes="$(git ls-files --others --exclude-standard)" || return $?
  fi
  printf '%s\n' "$untracked_changes" >> "$selection_dir/changed.txt"
  bun scripts/lib/affectedTests.ts --changed-files "$selection_dir/changed.txt" --out-dir "$selection_dir" || return $?
  if grep -Fx unit "$selection_dir/fallback.txt" > /dev/null; then
    fallback_unit=1
  fi
  return 0
}

repository_lint_tests() {
  local file
  local -a integrations=()
  if [[ "$changed_mode" -eq 1 ]]; then
    if grep -E '^((src|test|scripts|oxlint-plugins|android|ios|docs|skills|schemas|\.claude|\.github)/|(\.oxlintrc\.json|package\.json|bun\.lock|bunfig\.toml|turbo\.json|tsconfig[^/]*\.json)$)' "$affected_selection_dir/changed.txt" > /dev/null; then
      bun test test/lint/ || return $?
      repository_lint_directory_ran=1
    else
      gate_skipped=1
      echo "Skipping repository lint tests; no changes to source, test, script, lint, native, documentation, skill, schema, workflow, or root configuration inputs."
    fi
  else
    for file in test/lint/*.integration.test.ts; do
      [[ ! -f "$file" ]] || integrations+=("$file")
    done
    if [[ "${#integrations[@]}" -gt 0 ]]; then
      bun test "${integrations[@]}"
    else
      gate_skipped=1
      echo "Skipping repository lint tests; no test/lint/*.integration.test.ts files."
    fi
  fi
}

affected_test_runs() {
  local selection_dir="$affected_selection_dir" file
  local -a units=() integrations=() bats_files=()
  # unit.txt adds references and the tier validator to Bun's changed run.
  while IFS= read -r file; do
    if [[ "$repository_lint_directory_ran" -eq 1 && "$file" == test/lint/* ]]; then continue; fi
    [[ -z "$file" ]] || units+=("$file")
  done < "$selection_dir/unit.txt"
  while IFS= read -r file; do
    if [[ "$repository_lint_directory_ran" -eq 1 && "$file" == test/lint/* ]]; then continue; fi
    [[ -z "$file" ]] || integrations+=("$file")
  done < "$selection_dir/integration-safe.txt"
  while IFS= read -r file; do
    [[ -z "$file" ]] || bats_files+=("$file")
  done < "$selection_dir/bats.txt"
  if [[ "$fallback_unit" -eq 1 ]]; then
    echo "Skipping reference-only unit extras; the full unit lane already ran."
  elif [[ "${#units[@]}" -gt 0 ]]; then
    env AUTOMOBILE_TEST_MODE=true bash scripts/test-ts.sh unit "${units[@]}" || return $?
  else
    echo "No reference-only unit extras selected."
  fi
  if [[ "${#bats_files[@]}" -gt 0 ]]; then
    # Always-run bats (test/always-run-tests.txt) compare workflow/action content.
    if command -v bats > /dev/null; then
      bats "${bats_files[@]}" || return $?
    else
      echo "bats not installed; skipping always-run bats: ${bats_files[*]}"
    fi
  fi
  if grep -Fx integration "$selection_dir/fallback.txt" > /dev/null; then
    bash scripts/prepush-integration-safe.sh || return $?
  elif [[ "${#integrations[@]}" -gt 0 ]]; then
    bash scripts/prepush-integration-safe.sh ${integrations[@]+"${integrations[@]}"} || return $?
  else
    echo "No affected safe integration tests selected."
  fi
}

# Keep tsgo and tsgolint separate: oxlint 1.88 documents --type-check as
# experimental in --help. Tsgolint diagnostics do not replace the typecheck
# gates' fail-closed parser, TS2688/@types/bun guard, or separate src/test
# tsconfig projects. All gates are strictly serial; programs never build concurrently.
run_gate "stale-base guard" stale_base_guard
run_gate "format check" bun run format:check
run_gate "typecheck" bun run typecheck
run_gate "lint" bun run lint
run_gate "test typecheck" bun run typecheck:test
run_gate "tool definitions drift" tool_definitions_drift_guard
run_gate "fast validation static checks" fast_validation_static_checks
if [[ "$changed_mode" -eq 1 ]]; then
  run_gate "affected-test selection" affected_test_selection
fi
run_gate "repository lint tests" repository_lint_tests
run_gate "image runtime smoke" bun run test:image:bun

unit_mode="unit"
unit_gate="unit unit tests"
if [[ "$changed_mode" -eq 1 ]]; then
  if [[ "$fallback_unit" -eq 1 ]]; then
    unit_gate="unit tests (selection fell back to full lane)"
  else
    unit_mode="changed"
    unit_gate="changed unit tests"
    echo "Using changed unit-test selection against origin/main."
  fi
fi
unit_env=(env AUTOMOBILE_TEST_MODE=true AUTOMOBILE_UNIT_JUNIT_DIR=scratch/timing-unit-reports)
if [[ "$runner_os" != "Windows" && "$unit_mode" == "unit" ]]; then
  unit_env=(env AUTOMOBILE_TEST_MODE=true AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS=720 AUTOMOBILE_UNIT_JUNIT_DIR=scratch/timing-unit-reports)
fi
run_gate "$unit_gate" "${unit_env[@]}" bash scripts/test-ts.sh "$unit_mode"
if [[ "$changed_mode" -eq 1 ]]; then
  run_gate "affected-test runs" affected_test_runs
fi
run_gate "test/db integration fast path" db_integration_fast_path

if [[ "$timing_requested" -eq 1 || ( "$runner_os" != "macOS" && "$runner_os" != "Windows" ) ]]; then
  timing_env=(env BUN_TEST_TIMING_BASE_REF=origin/main)
  if [[ "$unit_mode" == unit ]]; then
    timing_env+=(BUN_TEST_TIMING_REPORT_DIR=scratch/timing-unit-reports)
  else
    # Bun writes no JUnit when --changed selects nothing. Preserve the timing
    # validator's affected-test selection in that case, as on origin/main.
    for report in scratch/timing-unit-reports/*.xml; do
      if [[ -f "$report" ]]; then
        timing_env+=(BUN_TEST_TIMING_REPORT_DIR=scratch/timing-unit-reports)
        break
      fi
    done
  fi
  run_gate "unit timing budget" "${timing_env[@]}" bash scripts/validate-bun-test-timings.sh
else
  echo "Skipping unit timing budget gate on ${runner_os}; CI only runs it on Linux. Pass --timing to force it locally."
fi

print_summary
echo "Node pre-push validation passed."
attestation_scope=full
attestation_note=""
if [[ "$changed_mode" -eq 1 ]]; then
  attestation_scope=partial
  attestation_note="changed-mode unit selection"
fi
attestation_args=()
for index in "${!gate_names[@]}"; do
  result="$(printf '%s' "${gate_results[$index]}" | tr '[:upper:]' '[:lower:]')"
  attestation_args+=("${gate_names[$index]}=${result}:${gate_seconds[$index]}")
done
"${PREPUSH_ATTESTATION_RECORDER:-$ROOT/scripts/ci/record-attestations.sh}" node "${attestation_options[@]}" --scope "$attestation_scope" --scope-note "$attestation_note" ${attestation_args[@]+"${attestation_args[@]}"} || true
