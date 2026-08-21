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

@test "required gate jobs exist with stable context names" {
  grep -q '^    name: "iOS Build"$' "$WF"
  grep -q '^    name: "CodeQL"$' "$WF"
  grep -q '^    name: "Shell Tests"$' "$WF"
  grep -q '^    name: "Pinned Runtime Graph Gate"$' "$WF"
}

@test "required gates run with always() so they always post a conclusion" {
  # A required check that never posts hangs as "Expected"; always() guarantees a
  # success/failure/skipped conclusion in every path.
  for job in ios-build-gate codeql-gate shell-tests-gate runtime-graph-gate; do
    block="$(job_block "$job")"
    [[ "$block" == *"if: always() &&"* ]]
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
  for job in ios-build-gate codeql-gate shell-tests-gate runtime-graph-gate; do
    block="$(job_block "$job")"
    [[ -n "$block" ]]
    [[ "$block" == *'"$r" == "failure" || "$r" == "cancelled"'* ]]
    [[ "$block" == *"exit 1"* ]]
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
  block="$(job_block runtime-graph-gate)"
  [[ "$block" == *"- runtime-graph-verification"* ]]
  [[ "$block" == *"needs.runtime-graph-verification.result"* ]]
}

@test "runtime-graph-verification runs the clean-room pinned-graph check exactly once (#5421)" {
  # The heavy pack+install verification must live in its own required-able job
  # and NOT be duplicated back into the benchmarks job (it was extracted from
  # there). Assert exactly one invocation across the whole workflow.
  count="$(grep -c 'scripts/ci/verify-pinned-runtime-graph.sh' "$WF")"
  [[ "$count" -eq 1 ]]
  block="$(job_block runtime-graph-verification)"
  [[ -n "$block" ]]
  [[ "$block" == *"scripts/ci/verify-pinned-runtime-graph.sh"* ]]
  # Gated to the same source/dependency surface as benchmarks, minus the
  # automated sha256-only chores.
  [[ "$block" == *"needs.detect-changes.outputs.ts_changed == 'true'"* ]]
  # Preserves the ci-logs artifact upload.
  [[ "$block" == *"pinned-runtime-graph-report"* ]]
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
