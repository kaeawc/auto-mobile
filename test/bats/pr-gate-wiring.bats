#!/usr/bin/env bats
#
# Guards the "required status check" gate wiring in pull_request.yml (PR #3860).
#
# ios-build-gate / codeql-gate / shell-tests-gate are always() roll-up jobs that
# report STABLE context names so their families' deterministic build/scan legs
# can be promoted to required checks without the matrix-skip footgun (a gated-out
# matrix job reports its literal "(${{ ... }})" name, which would hang a required
# check as "Expected").
#
# These gates roll up NAMED jobs, so their completeness depends on humans keeping
# each gate's `needs:` in sync. The required-checks config lives in GitHub's
# ruleset API (no in-repo source of truth), so a gate that silently drops a job
# would turn a required check into a permanent false-green. This suite is that
# backstop: rename/remove a rolled-up job, or slip the flaky simulator leg into
# the required iOS gate, and Fast Validation (BATS Shell Tests → Shell Tests) goes
# red instead.

WF=".github/workflows/pull_request.yml"

# Print the YAML block for a top-level job id (2-space indent), from its header
# up to the next job header.
job_block() {
  awk -v j="$1" '
    $0 ~ "^  " j ":[[:space:]]*$" { cap = 1; next }
    cap && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { exit }
    cap { print }
  ' "$WF"
}

wiring_requires_yq() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo "yq is required in CI to verify pull-request workflow wiring" >&2
    return 1
  fi
  skip "yq not installed"
}

@test "required gate jobs exist with stable context names" {
  wiring_requires_yq
  local job expected
  for job in ios-build-gate codeql-gate shell-tests-gate runtime-graph-gate; do
    case "$job" in
      ios-build-gate) expected="iOS Build" ;;
      codeql-gate) expected="CodeQL" ;;
      shell-tests-gate) expected="Shell Tests" ;;
      runtime-graph-gate) expected="Pinned Runtime Graph Gate" ;;
    esac
    run yq -r ".jobs.\"${job}\".name" "$WF"
    [ "$status" -eq 0 ]
    [ "$output" = "$expected" ]
  done
}

@test "required gates run with always() so they always post a conclusion" {
  # A required check that never posts hangs as "Expected"; always() guarantees a
  # success/failure/skipped conclusion in every path.
  wiring_requires_yq
  for job in ios-build-gate codeql-gate shell-tests-gate runtime-graph-gate; do
    run yq -r ".jobs.\"${job}\".if" "$WF"
    [ "$status" -eq 0 ]
    [[ "$output" == "always() &&"* ]]
  done
}

@test "ios-build-gate rolls up both deterministic iOS build legs" {
  block="$(job_block ios-build-gate)"
  [[ "$block" == *"- ios-swift-packages"* ]]
  [[ "$block" == *"- ios-xcode-build"* ]]
  # And actually checks their results (not just declares needs).
  [[ "$block" == *"needs.ios-swift-packages.result"* ]]
  [[ "$block" == *"needs.ios-xcode-build.result"* ]]
}

@test "ios-build-gate EXCLUDES the simulator-flaky job (keeps the required check deterministic)" {
  block="$(job_block ios-build-gate)"
  # Guard against a vacuous pass: a renamed gate id would make job_block return
  # "", and the `!=` below would pass on an empty string.
  [[ -n "$block" ]]
  [[ "$block" != *"ios-xctest-runner-simulator-tests"* ]]
}

@test "required gates fail on a failing/cancelled dependency (not just declare membership)" {
  # The whole point of the gate is to go red when a dependency fails; a gate that
  # never `exit 1`s is a permanent false-green. Pin the failure semantics so
  # weakening the loop (e.g. exit 1 -> exit 0) fails this guard.
  wiring_requires_yq
  for job in ios-build-gate codeql-gate shell-tests-gate runtime-graph-gate; do
    run yq -r "
      .jobs.\"${job}\".steps[]
      | select(.name == \"Check results\")
      | .run
    " "$WF"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -Fqx '  if [[ "$r" == "failure" || "$r" == "cancelled" ]]; then'
    printf '%s\n' "$output" | grep -Fqx '  exit 1'
  done
}

@test "codeql-gate rolls up codeql-node" {
  block="$(job_block codeql-gate)"
  [[ "$block" == *"- codeql-node"* ]]
  [[ "$block" == *"needs.codeql-node.result"* ]]
}

@test "shell-tests-gate rolls up bats-tests" {
  block="$(job_block shell-tests-gate)"
  [[ "$block" == *"- bats-tests"* ]]
  [[ "$block" == *"needs.bats-tests.result"* ]]
}

@test "runtime-graph-gate rolls up runtime-graph-verification (#5421)" {
  wiring_requires_yq
  run yq -r '.jobs."runtime-graph-gate".needs[]' "$WF"
  [ "$status" -eq 0 ]
  [[ $'\n'"$output"$'\n' == *$'\nruntime-graph-verification\n'* ]]

  run yq -r '
    .jobs."runtime-graph-gate".steps[]
    | select(.name == "Check results")
    | .run
  ' "$WF"
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" \
    | grep -Fqx '  [runtime-graph-verification]="${{ needs.runtime-graph-verification.result }}"'
}

@test "runtime-graph-verification runs the clean-room pinned-graph check exactly once (#5421)" {
  # The heavy pack+install verification must live in its own required-able job
  # and NOT be duplicated back into the benchmarks job (it was extracted from
  # there). Read parsed `run` fields so a commented-out command cannot satisfy
  # the guard.
  wiring_requires_yq
  run yq -r '
    [.jobs[] | .steps[]? | .run? | select(. == "bash scripts/ci/verify-pinned-runtime-graph.sh")]
    | length
  ' "$WF"
  [ "$status" -eq 0 ]
  [ "$output" -eq 1 ]

  run yq -r '
    .jobs."runtime-graph-verification".steps[]
    | select(.name == "Verify pinned runtime dependency graph (#5421)")
    | .run
  ' "$WF"
  [ "$status" -eq 0 ]
  [ "$output" = "bash scripts/ci/verify-pinned-runtime-graph.sh" ]

  # Gated to the same source/dependency surface as benchmarks, minus the
  # automated sha256-only chores.
  run yq -r '.jobs."runtime-graph-verification".if' "$WF"
  [ "$status" -eq 0 ]
  [ "$output" = "needs.detect-changes.outputs.ts_changed == 'true' && needs.detect-changes.outputs.sha256_only != 'true'" ]

  # Preserves the ci-logs artifact upload.
  run yq -r '
    .jobs."runtime-graph-verification".steps[]
    | select(.name == "Upload Pinned Runtime Graph Report")
    | .with.name
  ' "$WF"
  [ "$status" -eq 0 ]
  [ "$output" = "pinned-runtime-graph-report" ]
}

@test "runtime-graph verification runs when its workflow wiring changes (#5421)" {
  wiring_requires_yq
  run yq -r '
    .jobs."detect-changes".steps[]
    | select(.id == "filter-ts")
    | (.with.filters | from_yaml | .ts[])
  ' "$WF"
  [ "$status" -eq 0 ]
  [[ $'\n'"$output"$'\n' == *$'\n.github/workflows/pull_request.yml\n'* ]]
  [[ $'\n'"$output"$'\n' == *$'\n.github/actions/setup-auto-mobile-npm-package/**\n'* ]]
}

@test "ios-gate reuses ios-build-gate so build-leg membership is declared once" {
  # The broad non-required "iOS" gate must not re-list the build jobs (that would
  # double the drift surface); it depends on ios-build-gate instead.
  block="$(job_block ios-gate)"
  [[ -n "$block" ]]
  [[ "$block" == *"- ios-build-gate"* ]]
  [[ "$block" == *"needs.ios-build-gate.result"* ]]
  [[ "$block" != *"- ios-swift-packages"* ]]
  [[ "$block" != *"- ios-xcode-build"* ]]
}

@test "cross-platform unit lane avoids Windows isolation and enforces its unit timeout" {
  wiring_requires_yq
  local run_step
  run_step="$(yq -r '
    .jobs."mcp-build-and-test".steps[]
    | select(.name == "Run Tests")
    | .run
  ' "$WF")"
  [[ "$run_step" == *'[[ "$RUNNER_OS" == "Windows" ]]'* ]]
  [[ "$run_step" == *"bun run test"* ]]
  [[ "$run_step" == *"run_with_timeout 30 bun run test"* ]]
}
