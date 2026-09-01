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
  ' "${2:-$WF}"
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
  for job in ios-build-gate codeql-gate shell-tests-gate node-tests-gate runtime-graph-gate; do
    case "$job" in
      ios-build-gate) expected="iOS Build" ;;
      codeql-gate) expected="CodeQL" ;;
      shell-tests-gate) expected="Shell Tests" ;;
      node-tests-gate) expected="Node Tests" ;;
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
  for job in ios-build-gate codeql-gate shell-tests-gate node-tests-gate runtime-graph-gate; do
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
  for job in ios-build-gate codeql-gate shell-tests-gate node-tests-gate runtime-graph-gate; do
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

@test "shell-tests-gate rolls up unit and integration BATS jobs" {
  block="$(job_block shell-tests-gate)"
  [[ "$block" == *"- bats-tests"* ]]
  [[ "$block" == *"needs.bats-tests.result"* ]]
  [[ "$block" == *"- bats-integration-tests"* ]]
  [[ "$block" == *"needs.bats-integration-tests.result"* ]]
}

@test "node-tests-gate rolls up complete unit and host integration matrices" {
  block="$(job_block node-tests-gate)"
  [[ "$block" == *"- node-unit-tests"* ]]
  [[ "$block" == *"needs.node-unit-tests.result"* ]]
  [[ "$block" == *"- node-host-integration-tests"* ]]
  [[ "$block" == *"needs.node-host-integration-tests.result"* ]]
}

@test "fast and integration jobs invoke their canonical lanes" {
  local unit host bats_unit bats_integration
  unit="$(job_block node-unit-tests)"
  host="$(job_block node-host-integration-tests)"
  bats_unit="$(job_block bats-tests)"
  bats_integration="$(job_block bats-integration-tests)"

  [[ "$unit" == *"bash scripts/test-ts.sh unit"* ]]
  [[ "$host" == *"bash scripts/test-ts.sh integration"* ]]
  [[ "$bats_unit" == *"scripts/ci/run-bats.sh unit"* ]]
  [[ "$bats_integration" == *"scripts/ci/run-bats.sh integration"* ]]
  [[ "$bats_unit" != *"AUTOMOBILE_BATS_SERIAL_ONLY"* ]]
}

@test "merge workflow preserves the same four lane boundaries" {
  local workflow=".github/workflows/merge.yml"
  [[ "$(job_block node-unit-tests "$workflow")" == *"bash scripts/test-ts.sh unit"* ]]
  [[ "$(job_block node-host-integration-tests "$workflow")" == *"bash scripts/test-ts.sh integration"* ]]
  [[ "$(job_block bats-tests "$workflow")" == *"scripts/ci/run-bats.sh unit"* ]]
  [[ "$(job_block bats-integration-tests "$workflow")" == *"scripts/ci/run-bats.sh integration"* ]]
}

@test "development installer jobs are removed from PR and merge workflows" {
  [[ -z "$(job_block installer-development "$WF")" ]]
  [[ -z "$(job_block installer-development ".github/workflows/merge.yml")" ]]
}

@test "WebRTC device jobs are folded into PR and merge workflows" {
  local workflow android ios
  for workflow in "$WF" ".github/workflows/merge.yml"; do
    android="$(job_block android-device-webrtc "$workflow")"
    ios="$(job_block ios-device-webrtc "$workflow")"
    [[ -n "$android" ]]
    [[ -n "$ios" ]]
    [[ "$android" == *"AUTOMOBILE_WEBRTC_DEVICE_PLATFORM=android"* ]]
    [[ "$android" == *"bun run test:integration:webrtc-device"* ]]
    [[ "$ios" == *"AUTOMOBILE_WEBRTC_DEVICE_PLATFORM: ios"* ]]
    [[ "$ios" == *"bun run test:integration:webrtc-device"* ]]
  done
  [[ ! -e ".github/workflows/webrtc-device-integration.yml" ]]
}

@test "PR WebRTC device jobs share path and opt-in gating" {
  local job block
  for job in android-device-webrtc ios-device-webrtc; do
    block="$(job_block "$job")"
    [[ "$block" == *"needs: detect-changes"* ]]
    [[ "$block" == *"if: needs.detect-changes.outputs.webrtc_should_run == 'true'"* ]]
  done
}

@test "WebRTC change detection covers publisher and device inputs" {
  wiring_requires_yq
  run yq -r '
    .jobs."detect-changes".steps[]
    | select(.id == "filter-webrtc")
    | (.with.filters | from_yaml | .webrtc[])
  ' "$WF"
  [ "$status" -eq 0 ]
  local path
  for path in \
    "src/features/webrtc/**" \
    "src/features/screen-stream/**" \
    "android/video-server/**" \
    "ios/screen-capture/**" \
    "test/integration/webrtcDeviceCapture.integration.test.ts" \
    ".github/workflows/pull_request.yml" \
    ".github/workflows/merge.yml"; do
    [[ $'\n'"$output"$'\n' == *$'\n'"$path"$'\n'* ]]
  done
}

@test "webrtc-gate rolls up publisher and device coverage" {
  local block
  block="$(job_block webrtc-gate)"
  for job in webrtc-integration-test android-device-webrtc ios-device-webrtc; do
    [[ "$block" == *"- $job"* ]]
    [[ "$block" == *"needs.$job.result"* ]]
  done
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
