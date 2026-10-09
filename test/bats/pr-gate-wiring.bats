#!/usr/bin/env bats
#
# Guards the "required status check" gate wiring in pull_request.yml (PR #3860).
#
# ide-plugin-gate / ios-build-gate / shell-tests-gate are always() roll-up jobs
# that report STABLE context names ("IDE Plugin", "iOS Build", "Shell Tests") that
# the green-main ruleset requires, without the matrix-skip footgun (a gated-out
# matrix job reports its literal "(${{ ... }})" name, which would hang a required
# check as "Expected"). Non-required roll-ups were removed: each cost a runner
# slot per PR without blocking a merge.
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
  for job in ide-plugin-gate ios-build-gate shell-tests-gate; do
    case "$job" in
      ide-plugin-gate) expected="IDE Plugin" ;;
      ios-build-gate) expected="iOS Build" ;;
      shell-tests-gate) expected="Shell Tests" ;;
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
  for job in ios-build-gate shell-tests-gate; do
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
  for job in ios-build-gate shell-tests-gate; do
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

@test "shell-tests-gate rolls up the BATS job (unit + integration lanes)" {
  block="$(job_block shell-tests-gate)"
  [[ "$block" == *"- bats-tests"* ]]
  [[ "$block" == *"needs.bats-tests.result"* ]]
  # The integration lane is a step of bats-tests (folded to save a runner slot).
  [[ "$block" != *"bats-integration-tests"* ]]
}

@test "BATS runs only on shell-relevant changes while Shell Tests always reports (#10889)" {
  wiring_requires_yq
  local condition
  condition="$(yq -r '.jobs."bats-tests".if' "$WF")"
  [[ "$condition" == *"needs.detect-changes.outputs.shell_changed == 'true'"* ]]
  # The required roll-up must not inherit the path filter: it always posts, and a
  # skipped bats-tests is not a failure.
  condition="$(yq -r '.jobs."shell-tests-gate".if' "$WF")"
  [[ "$condition" == "always()"* ]]
  [[ "$condition" != *"shell_changed"* ]]
  [[ "$(job_block shell-tests-gate)" == *'"$r" == "failure" || "$r" == "cancelled"'* ]]

  run yq -r '
    .jobs."detect-changes".steps[]
    | select(.id == "filter-shell")
    | (.with.filters | from_yaml | .shell[])
  ' "$WF"
  [ "$status" -eq 0 ]
  local path
  for path in "scripts/**" "test/bats/**" ".github/**" "package.json" "bun.lock" "skills/**" ".agents/**" "oxlint-plugins/**"; do
    [[ $'\n'"$output"$'\n' == *$'\n'"$path"$'\n'* ]]
  done
  # A TypeScript-only change must not trigger the suite.
  [[ $'\n'"$output"$'\n' != *$'\n'"src/**"$'\n'* ]]
  [[ "$(yq -r '.jobs."detect-changes".outputs.shell_changed' "$WF")" == *"steps.filter-shell.outputs.shell"* ]]
}

@test "Android emulator compile smoke includes test-source compilation" {
  block="$(job_block android-emulator-compile-smoke)"
  [[ -n "$block" ]]
  [[ "$block" == *":junit-runner:compileTestKotlin"* ]]
  [[ "$block" == *":playground:app:compileDebugUnitTestKotlin"* ]]
}

@test "portable PR matrices leave macOS coverage to nightly" {
  wiring_requires_yq
  local job expected
  for job in bats-tests; do
    run yq -r ".jobs.\"${job}\".strategy.matrix.os[]" "$WF"
    [ "$status" -eq 0 ]
    [ "$output" = "ubuntu-latest" ]
  done
  for job in node-unit-tests node-host-integration-tests; do
    run yq -r ".jobs.\"${job}\".strategy.matrix.os[]" "$WF"
    [ "$status" -eq 0 ]
    [ "$output" = $'ubuntu-latest\nwindows-latest' ]
  done
}

@test "unit, integration, and stress jobs invoke their canonical lanes" {
  local unit host bats_unit
  unit="$(job_block node-unit-tests)"
  host="$(job_block node-host-integration-tests)"
  bats_unit="$(job_block bats-tests)"

  [[ "$unit" == *"bash scripts/test-ts.sh unit"* ]]
  [[ "$host" == *"bash scripts/test-ts.sh integration"* ]]
  [[ "$host" == *"bash scripts/test-ts.sh stress"* ]]
  [[ "$bats_unit" == *"scripts/ci/run-bats.sh unit"* ]]
  [[ "$bats_unit" == *"scripts/ci/run-bats.sh integration"* ]]
  [[ "$bats_unit" != *"AUTOMOBILE_BATS_SERIAL_ONLY"* ]]
}

@test "host integration job evaluates after the fast-validation fan-in" {
  wiring_requires_yq
  local condition dependencies
  condition="$(yq -r '.jobs."node-host-integration-tests".if' "$WF")"
  dependencies="$(yq -r '.jobs."node-host-integration-tests".needs[]' "$WF")"
  [[ "$condition" == "always() && !cancelled() && needs.detect-changes.result == 'success' && needs.fast-validation.result == 'success'"* ]]
  [[ "$condition" == *"needs.detect-changes.outputs.docs_only != 'true'"* ]]
  [ "$dependencies" = $'detect-changes\nfast-validation' ]
}

@test "PR and merge TypeScript coverage have setup headroom beyond the 12 minute wall budget" {
  wiring_requires_yq
  local workflow
  for workflow in "$WF" .github/workflows/merge.yml; do
    run yq -r '.jobs."ts-code-coverage"."timeout-minutes" >= 20' "$workflow"
    [ "$status" -eq 0 ]
    [ "$output" = "true" ]
  done
}

@test "merge TypeScript coverage uploads diagnostics after failures with bounded retention" {
  local workflow=".github/workflows/merge.yml"
  run yq -r '.jobs."ts-code-coverage".steps[] | select(.name == "Upload TypeScript Coverage Diagnostics") | [.if, .with.name, .with.path, .with."if-no-files-found", .with."retention-days"] | @tsv' "$workflow"
  [ "$status" -eq 0 ]
  [[ "$output" == $'always()\tts-coverage-diagnostics\t'* ]]
  [[ "$output" == *"ci-logs/ts-coverage.log"* ]]
  [[ "$output" == *"coverage/shards/*.ndjson"* ]]
  [[ "$output" == *"coverage/shards/*.log"* ]]
  [[ "$output" == *$'\tignore\t7' ]]
}

@test "merge TypeScript coverage badge upload remains unchanged" {
  local workflow=".github/workflows/merge.yml"
  run yq -r '.jobs."ts-code-coverage".steps[] | select(.name == "Upload Coverage Badge") | [.uses, .with.name, .with.path, .with."retention-days"] | @tsv' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = $'actions/upload-artifact@v6\tts-coverage-badge\tcoverage/ts-coverage-badge.json\t90' ]
}

@test "merge workflow preserves the same four lane boundaries" {
  local workflow=".github/workflows/merge.yml"
  [[ "$(job_block node-unit-tests "$workflow")" == *"bash scripts/test-ts.sh unit"* ]]
  [[ "$(job_block node-host-integration-tests "$workflow")" == *"bash scripts/test-ts.sh integration"* ]]
  [[ "$(job_block node-host-integration-tests "$workflow")" == *"bash scripts/test-ts.sh stress"* ]]
  [[ "$(job_block bats-tests "$workflow")" == *"scripts/ci/run-bats.sh unit"* ]]
  [[ "$(job_block bats-integration-tests "$workflow")" == *"scripts/ci/run-bats.sh integration"* ]]
}

@test "PR MCP build remains on Windows after merge-side removal" {
  wiring_requires_yq
  local pr_mcp
  pr_mcp="$(job_block mcp-build-and-test)"

  [[ "$pr_mcp" == *"windows-latest"* ]]
  [[ "$pr_mcp" != *"macos-latest"* ]]

  run yq -r '.jobs.mcp-build-and-test.strategy.matrix.os[]' "$WF"
  [ "$status" -eq 0 ]
  [ "$output" = "windows-latest" ]
}

@test "nightly preserves the moved macOS portable test lanes" {
  local workflow=".github/workflows/nightly.yml"
  local bats_unit bats_integration unit host
  bats_unit="$(job_block macos-bats-tests "$workflow")"
  bats_integration="$(job_block macos-bats-integration-tests "$workflow")"
  unit="$(job_block macos-node-unit-tests "$workflow")"
  host="$(job_block macos-node-host-integration-tests "$workflow")"

  for block in "$bats_unit" "$bats_integration" "$unit" "$host"; do
    [[ "$block" == *"runs-on: macos-latest"* ]]
    [[ "$block" == *"scripts/ci/install-bun-deps.sh"* ]]
  done
  [[ "$bats_unit" == *"scripts/ci/run-bats.sh unit"* ]]
  [[ "$bats_integration" == *"scripts/ci/run-bats.sh integration"* ]]
  [[ "$unit" == *"bash scripts/test-ts.sh unit"* ]]
  [[ "$host" == *"bash scripts/test-ts.sh integration"* ]]
  [[ "$host" == *"bash scripts/test-ts.sh stress"* ]]
}

@test "development installer jobs are removed from PR and merge workflows" {
  [[ -z "$(job_block installer-development "$WF")" ]]
  [[ -z "$(job_block installer-development ".github/workflows/merge.yml")" ]]
}

@test "PR WebRTC device jobs and merge Android device job remain" {
  local workflow android ios
  for workflow in "$WF" ".github/workflows/merge.yml"; do
    android="$(job_block android-device-webrtc "$workflow")"
    [[ -n "$android" ]]
    [[ "$android" == *"AUTOMOBILE_WEBRTC_DEVICE_PLATFORM=android"* ]]
    [[ "$android" == *"bun run test:integration:webrtc-device"* ]]
  done
  ios="$(job_block ios-device-webrtc "$WF")"
  [[ -n "$ios" ]]
  [[ "$ios" == *"AUTOMOBILE_WEBRTC_DEVICE_PLATFORM: ios"* ]]
  [[ "$ios" == *"bun run test:integration:webrtc-device"* ]]
  [[ ! -e ".github/workflows/webrtc-device-integration.yml" ]]
}

@test "PR WebRTC device jobs share path and opt-in gating" {
  local block
  block="$(job_block android-device-webrtc)"
  [[ "$block" == *"needs: [detect-changes, build-android-control-proxy]"* ]]
  [[ "$block" == *"if: needs.detect-changes.outputs.webrtc_should_run == 'true'"* ]]

  block="$(job_block ios-device-webrtc)"
  [[ "$block" == *"needs: [detect-changes, fast-validation]"* ]]
  [[ "$block" == *"if: needs.detect-changes.outputs.webrtc_should_run == 'true' && needs.fast-validation.result == 'success'"* ]]
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
    "test/helpers/captureStageTimeline.ts" \
    "test/helpers/webrtcDeviceCaptureHelpers.ts" \
    ".github/workflows/pull_request.yml" \
    ".github/workflows/merge.yml"; do
    [[ $'\n'"$output"$'\n' == *$'\n'"$path"$'\n'* ]]
  done
}

@test "desktop_core change detection covers the desktop wire-contract fixtures (#10838)" {
  # The daemon-side TS test writes test/fixtures/desktop-wire/*.json and the Kotlin
  # DesktopWireFixtureCompositionTest (desktop-core) replays them. A daemon-only PR that
  # regenerates the fixtures must still trigger the Kotlin replay.
  wiring_requires_yq
  run yq -r '
    .jobs."detect-changes".steps[]
    | select(.id == "filter-desktop-core")
    | (.with.filters | from_yaml | .desktop_core[])
  ' "$WF"
  [ "$status" -eq 0 ]
  local path
  for path in \
    "android/desktop-core/**" \
    "test/fixtures/desktop-wire/**" \
    "test/daemon/desktopWireContract.test.ts"; do
    [[ $'\n'"$output"$'\n' == *$'\n'"$path"$'\n'* ]]
  done
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

@test "non-required roll-up gates stay removed (runner-slot budget)" {
  # Each roll-up costs a runner slot (plus queue time) per PR. Only names the
  # green-main ruleset requires may have a gate; these were advisory and removed.
  local job
  for job in ios-gate android-gate codeql-gate node-tests-gate webrtc-gate runtime-graph-gate; do
    [[ -z "$(job_block "$job")" ]]
  done
  wiring_requires_yq
  run yq -r '.jobs[].name' "$WF"
  [ "$status" -eq 0 ]
  local name
  for name in "iOS" "Android" "CodeQL" "Node Tests" "WebRTC" "Pinned Runtime Graph Gate"; do
    [[ $'\n'"$output"$'\n' != *$'\n'"$name"$'\n'* ]]
  done
}

@test "ide-plugin-gate rolls up the IDE plugin build and unit tests" {
  block="$(job_block ide-plugin-gate)"
  [[ "$block" == *"- build-ide-plugin"* ]]
  [[ "$block" == *"needs.build-ide-plugin.result"* ]]
  [[ "$block" == *"- ide-plugin-unit-tests"* ]]
  [[ "$block" == *"needs.ide-plugin-unit-tests.result"* ]]
}
