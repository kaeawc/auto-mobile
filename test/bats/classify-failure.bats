#!/usr/bin/env bats
# bats file_tags=parallel-within-file

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/scripts/ci/classify-failure.sh"

setup() {
  FAKE_BIN="$BATS_TEST_TMPDIR/fake-bin"
  FIXTURE="$BATS_TEST_TMPDIR/run.json"
  mkdir -p "$FAKE_BIN"
  cat > "$FIXTURE" <<'JSON'
{
  "headBranch": "work/example",
  "jobs": [
    {"databaseId": 1, "name": "Node Unit Timing Budget", "conclusion": "failure", "steps": [{"name": "Enforce 100ms budget for changed unit tests", "conclusion": "failure"}]},
    {"databaseId": 2, "name": "Node Tests", "conclusion": "failure", "steps": [{"name": "Check results", "conclusion": "failure"}]}
  ]
}
JSON
  cat > "$FAKE_BIN/gh" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
annotation_response() {
  local page="$1"
  if [[ "$gh_args" == *"--paginate"* ]]; then
    printf '[%s]\n' "$page"
  else
    printf '%s\n' "$page"
  fi
}
gh_args="$*"
case "$1 $2" in
  'run view')
    if [[ -n "${FAKE_GH_RUN_VIEW_ARGS:-}" ]]; then
      printf '%s\n' "$*" > "$FAKE_GH_RUN_VIEW_ARGS"
    fi
    cat "$CLASSIFY_FIXTURE"
    ;;
  api\ *)
    # Model gh's flag-sensitivity so fetch_job_log's feature detection is
    # exercised. FAKE_GH_ALLOW_ESCAPE selects the client:
    #   supported (default) = gh >= 2.101.0: --help lists the flag, and a job-log
    #     request REFUSES (non-zero, nothing written) unless the flag is passed.
    #   unsupported          = gh < 2.101.0: --help omits the flag, and passing
    #     it is an "unknown flag" error; the log emits only WITHOUT the flag.
    if [[ "$*" == *"--help"* ]]; then
      if [[ "${FAKE_GH_ALLOW_ESCAPE:-supported}" == "supported" ]]; then
        printf '%s\n' '      --allow-escape-sequences   Allow escape sequences in the output'
      else
        printf '%s\n' '      --paginate   Make additional HTTP requests to fetch all pages'
      fi
      exit 0
    fi
    if [[ "$*" == *"/logs" ]]; then
      if [[ "${FAKE_GH_ALLOW_ESCAPE:-supported}" == "supported" ]]; then
        if [[ "$*" != *"--allow-escape-sequences"* ]]; then
          echo "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway" >&2
          exit 1
        fi
      elif [[ "$*" == *"--allow-escape-sequences"* ]]; then
        echo "unknown flag: --allow-escape-sequences" >&2
        exit 1
      fi
    fi
    case "$*" in
      */check-runs/1/annotations*) annotation_response '[]' ;;
      */actions/jobs/1/logs) printf 'Test exceeded 100ms: timing budget fixture\n' ;;
      */check-runs/3/annotations*) annotation_response '[{"message":"sharp: Could not load the sharp module"}]' ;;
      */check-runs/4/annotations*) annotation_response '[{"message":"expect(received).toBe(expected) ... deviceDiscoveryReconcileFunnel assertion failed"}]' ;;
      */check-runs/5/annotations*) annotation_response '[{"message":"XCTAssertEqual failed: (\"foo\") is not equal to (\"bar\")"}]' ;;
      */check-runs/9/annotations*) annotation_response '[{"message":"expect(received).toBe(expected) ... some product assertion failed"}]' ;;
      */check-runs/10/annotations*) annotation_response '[{"message":"oxlint: no-unused-vars lint failure"}]' ;;
      */check-runs/30/annotations*)
        if [[ "$gh_args" == *"--paginate"* ]]; then
          printf '%s\n' '[[],[{"message":"sys.boot_completed is not 1"}]]'
        else
          printf '[]\n'
        fi
        ;;
      */check-runs/33/annotations*) annotation_response '[]' ;;
      */check-runs/34/annotations*) annotation_response '[]' ;;
      */check-runs/37/annotations*) annotation_response '[]' ;;
      */check-runs/12/annotations*|*/check-runs/13/annotations*|*/check-runs/14/annotations*) annotation_response '[]' ;;
      */check-runs/15/annotations*|*/check-runs/16/annotations*|*/check-runs/17/annotations*) annotation_response '[]' ;;
      */actions/jobs/6/logs) printf 'readiness phase exceeded the remaining deadline\n' ;;
      */actions/jobs/45/logs) printf '%s\n' "$FAKE_EMULATOR_LOG" ;;
      */actions/jobs/46/logs) printf '%s\n' "$FAKE_RUNNER_LOG" ;;
      */actions/jobs/44/logs) printf '%s\n' "$FAKE_XCTEST_LOG" ;;
      */actions/jobs/35/logs) printf 'First emulator attempt failed; captured diagnostics follow:\ngetAndroid automation runner readiness failed: phase=runner-connect attempts=241\nStarting emulator retry attempt 2.\ngetAndroid automation runner readiness failed: phase=runner-connect attempts=237: readiness phase exceeded the remaining deadline\n' ;;
      */actions/jobs/36/logs) printf 'getAndroid automation runner readiness failed: phase=runner-health attempts=4\n' ;;
      */actions/jobs/31/logs) printf 'First emulator attempt failed; captured diagnostics follow:\nsys.boot_completed is not 1\nStarting emulator retry attempt 2.\nexpect(received).toBe(expected) ... someRealRegression assertion failed\n' ;;
      */actions/jobs/32/logs) printf 'First emulator attempt failed; captured diagnostics follow:\nsys.boot_completed is not 1\nexpect(received).toBe(expected) ... someRealRegression assertion failed\n' ;;
      */actions/jobs/33/logs) printf '##[group]Run for attempt in $(seq 1 "${attempts}"); do\n  echo "::group::iOS device capture integration (attempt ${attempt}/${attempts})"\n  if [ "${attempt}" -gt 1 ]; then\n    echo "Starting emulator retry attempt 2."\n  fi\n  ...\n##[endgroup]\niOS device capture attempt 1 failed (exit 1): iOS WHEP viewer did not recover to a fresh IDR within ~2000ms of the relayed PLI\nReaping MediaMTX / daemon / Chrome before one retry.\nStarting emulator retry attempt 2.\niOS device capture attempt 2 failed (exit 1): TypeError: Cannot read properties of undefined (reading '\''sessionId'\'')\niOS device capture failed after 2 attempts.\n' ;;
      */actions/jobs/34/logs) printf '##[group]Run for attempt in $(seq 1 "${attempts}"); do\n  if [ "${attempt}" -gt 1 ]; then\n    echo "Starting emulator retry attempt 2."\n  fi\n##[endgroup]\niOS device capture attempt 1 failed (exit 1): iOS WHEP viewer did not recover to a fresh IDR within ~2000ms of the relayed PLI\niOS device capture failed after 1 attempts.\n' ;;
      */actions/jobs/37/logs) printf 'iOS device capture attempt 1 failed (exit 1): first attempt failure\nStarting emulator retry attempt 2.\niOS device capture attempt 2 failed (exit 1): No connected ios devices found (after 5 attempts).\niOS device capture failed after 2 attempts.\n' ;;
      */actions/jobs/18/logs) printf 'Test exceeded 100ms: some/test.ts > some test (median 142.31ms of 3 isolated runs)\n' ;;
      */actions/jobs/22/logs) printf 'Test exceeded 100ms: foo.bar (150.00ms; recheck produced 2 of 5 isolated samples)\n' ;;
      */actions/jobs/43/logs) printf '2026-09-27T14:26:44.12Z WATCHDOG: integration test exceeded 899s; last started-but-not-ended file: test/server/toolRegistry.collaborators.integration.test.ts\n' ;;
      */actions/jobs/19/logs|*/actions/jobs/20/logs|*/actions/jobs/21/logs) : ;;
      */actions/runs/*/artifacts*)
        if [[ "$*" == *"--paginate"* ]]; then
          printf '%s\n' '[{"artifacts":[{"id":102,"name":"mcp-build-test-logs-ubuntu-latest"}]},{"artifacts":[{"id":101,"name":"mcp-build-test-logs-windows-latest"}]}]'
        else
          printf '%s\n' '{"artifacts":[{"id":102,"name":"mcp-build-test-logs-ubuntu-latest"}]}'
        fi
        ;;
      */actions/artifacts/101/zip) printf 'sharp: Could not load the sharp module\n' ;;
      */actions/artifacts/102/zip) printf 'ordinary ubuntu log text\n' ;;
      */actions/jobs/12/logs|*/actions/jobs/13/logs|*/actions/jobs/14/logs|*/actions/jobs/15/logs|*/actions/jobs/16/logs|*/actions/jobs/17/logs) printf 'integration fixture failure\n' ;;
      *) printf '[]\n' ;;
    esac
    ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
SHIM
  chmod +x "$FAKE_BIN/gh"
}

@test "passes the selected attempt to gh run view and classifies its watchdog log" {
  fixture="$BATS_TEST_TMPDIR/earlier-attempt-run.json"
  calls="$BATS_TEST_TMPDIR/run-view-args.txt"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "docs-only-pr",
  "jobs": [
    {"databaseId": 43, "name": "Node Host Integration Tests (ubuntu-latest)", "conclusion": "failure", "steps": [{"name": "Run host integration lane", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" FAKE_GH_RUN_VIEW_ARGS="$calls" bash "$SCRIPT" 36324886670 --attempt 1
  [ "$status" -eq 0 ]
  [ "$(cat "$calls")" = "run view 36324886670 -R kaeawc/auto-mobile --attempt 1 --json jobs,headBranch" ]
  [[ "$output" == *"Node Host Integration Tests (ubuntu-latest) → Run host integration lane → none → RERUN-DONT-FIX — historical pre-#7773"* ]]
}

@test "no attempt selector keeps the latest-attempt query and empty-run output" {
  fixture="$BATS_TEST_TMPDIR/latest-attempt-run.json"
  calls="$BATS_TEST_TMPDIR/run-view-args.txt"
  cat > "$fixture" <<'JSON'
{"headBranch":"docs-only-pr","jobs":[]}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" FAKE_GH_RUN_VIEW_ARGS="$calls" bash "$SCRIPT" 36324886670
  [ "$status" -eq 0 ]
  [ "$(cat "$calls")" = "run view 36324886670 -R kaeawc/auto-mobile --json jobs,headBranch" ]
  [ "$output" = "No failed or cancelled jobs in run 36324886670." ]
}

@test "classifies a Dependabot sharp failure as a known non-fix" {
  fixture="$BATS_TEST_TMPDIR/dependabot-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "dependabot/npm_and_yarn/sharp-0.35.4",
  "jobs": [
    {"databaseId": 3, "name": "Bun Security Audit", "conclusion": "failure", "steps": [{"name": "Audit", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 456
  [ "$status" -eq 0 ]
  [[ "$output" == *"Bun Security Audit → Audit → sharp: Could not load the sharp module → KNOWN-NONFIX"* ]]
}

@test "does not classify an unrelated failure on a Dependabot sharp branch as a known non-fix" {
  fixture="$BATS_TEST_TMPDIR/dependabot-sharp-unrelated-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "dependabot/npm_and_yarn/sharp-0.35.4",
  "jobs": [
    {"databaseId": 10, "name": "Bun Lint", "conclusion": "failure", "steps": [{"name": "Run oxlint", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 457
  [ "$status" -eq 0 ]
  [[ "$output" == *"Bun Lint → Run oxlint → oxlint: no-unused-vars lint failure → UNKNOWN"* ]]
  [[ "$output" != *"KNOWN-NONFIX"* ]]
}

@test "does not classify an unrelated Node Unit Tests assertion as a rerun flake" {
  fixture="$BATS_TEST_TMPDIR/node-bug-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/device-discovery",
  "jobs": [
    {"databaseId": 4, "name": "Node Unit Tests (ubuntu-latest)", "conclusion": "failure", "steps": [{"name": "Run unit lane", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 789
  [ "$status" -eq 0 ]
  [[ "$output" == *"Node Unit Tests (ubuntu-latest) → Run unit lane → expect(received).toBe(expected) ... deviceDiscoveryReconcileFunnel assertion failed → UNKNOWN"* ]]
  [[ "$output" != *"RERUN-DONT-FIX"* ]]
}

@test "does not let a non-producer job inherit a build/test artifact diagnostic" {
  fixture="$BATS_TEST_TMPDIR/matrix-artifact-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "dependabot/npm_and_yarn/sharp-0.35.4",
  "jobs": [
    {"databaseId": 19, "name": "Node Unit Tests (windows-latest)", "conclusion": "failure", "steps": [{"name": "Run unit lane", "conclusion": "failure"}]},
    {"databaseId": 20, "name": "Node Unit Tests (ubuntu-latest)", "conclusion": "failure", "steps": [{"name": "Run unit lane", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 790
  [ "$status" -eq 0 ]
  [[ "$output" == *"Node Unit Tests (windows-latest) → Run unit lane → none → UNKNOWN"* ]]
  [[ "$output" == *"Node Unit Tests (ubuntu-latest) → Run unit lane → none → UNKNOWN"* ]]
}

@test "uses the matching build/test artifact for its producer job" {
  fixture="$BATS_TEST_TMPDIR/build-test-artifact-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "dependabot/npm_and_yarn/sharp-0.35.4",
  "jobs": [
    {"databaseId": 21, "name": "Node TypeScript Build and Test (windows-latest)", "conclusion": "failure", "steps": [{"name": "Run build/test lane", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 791
  [ "$status" -eq 0 ]
  [[ "$output" == *"Node TypeScript Build and Test (windows-latest) → Run build/test lane → none → KNOWN-NONFIX"* ]]
}

@test "classifies an advisory timing-budget log flake and its red aggregator without annotations" {
  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$FIXTURE" bash "$SCRIPT" 123
  [ "$status" -eq 0 ]
  [[ "$output" == *"Node Unit Timing Budget → Enforce 100ms budget for changed unit tests → none → RERUN-DONT-FIX"* ]]
  [[ "$output" == *"Node Tests → Check results → none → CHECK-UPSTREAM-FIRST"* ]]
}

@test "classifies a timing-budget flap on the folded budget step of the ubuntu unit leg" {
  fixture="$BATS_TEST_TMPDIR/folded-timing-budget-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/folded-timing-budget",
  "jobs": [
    {"databaseId": 1, "name": "Node Unit Tests (ubuntu-latest)", "conclusion": "failure", "steps": [{"name": "Enforce 100ms budget for changed unit tests", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 127
  [ "$status" -eq 0 ]
  [[ "$output" == *"Node Unit Tests (ubuntu-latest) → Enforce 100ms budget for changed unit tests → none → RERUN-DONT-FIX"* ]]
}

@test "investigates a timing-budget breach retained by isolated median rechecks" {
  fixture="$BATS_TEST_TMPDIR/timing-budget-median-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/timing-budget-median",
  "jobs": [
    {"databaseId": 18, "name": "Node Unit Timing Budget", "conclusion": "failure", "steps": [{"name": "Enforce 100ms budget for changed unit tests", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 125
  [ "$status" -eq 0 ]
  [[ "$output" == *"Node Unit Timing Budget → Enforce 100ms budget for changed unit tests → none → INVESTIGATE"* ]]
  [[ "$output" != *"Node Unit Timing Budget"*"RERUN-DONT-FIX"* ]]
}

@test "investigates an incomplete timing-budget isolated recheck" {
  fixture="$BATS_TEST_TMPDIR/timing-budget-incomplete-recheck-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/timing-budget-incomplete-recheck",
  "jobs": [
    {"databaseId": 22, "name": "Node Unit Timing Budget", "conclusion": "failure", "steps": [{"name": "Enforce 100ms budget for changed unit tests", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 126
  [ "$status" -eq 0 ]
  [[ "$output" == *"Node Unit Timing Budget → Enforce 100ms budget for changed unit tests → none → INVESTIGATE"* ]]
  [[ "$output" != *"Node Unit Timing Budget"*"RERUN-DONT-FIX"* ]]
}

@test "does not classify a plain XCTest assertion as a rerun flake" {
  fixture="$BATS_TEST_TMPDIR/xctest-assertion-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/xctest-assertion",
  "jobs": [
    {"databaseId": 5, "name": "XCTestRunner Simulator Tests", "conclusion": "failure", "steps": [{"name": "Run XCTestRunner integration tests", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 987
  [ "$status" -eq 0 ]
  [[ "$output" == *"XCTestRunner Simulator Tests → Run XCTestRunner integration tests → XCTAssertEqual failed"*"→ UNKNOWN"* ]]
  [[ "$output" != *"RERUN-DONT-FIX"* ]]
}

@test "classifies the JUnit emulator display name as a known advisory flake" {
  fixture="$BATS_TEST_TMPDIR/junit-emulator-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/android-emulator",
  "jobs": [
    {"databaseId": 6, "name": "Run JUnit Runner Emulator Tests", "conclusion": "failure", "steps": [{"name": "Run AutoMobile tests that require emulator", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 654
  [ "$status" -eq 0 ]
  [[ "$output" == *"Run JUnit Runner Emulator Tests → Run AutoMobile tests that require emulator → none → RERUN-DONT-FIX"* ]]
}

@test "classifies anchored XCTestRunner caret-probe and Xcode launch timing as advisory flakes" {
  fixture="$BATS_TEST_TMPDIR/xctest-ui-timing-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/xctest-ui-timing",
  "jobs": [
    {"databaseId": 44, "name": "XCTestRunner Simulator Tests", "conclusion": "failure", "steps": [{"name": "Run CtrlProxy iOS UI tests", "conclusion": "failure"}]}
  ]
}
JSON

  for message in \
    "2026-10-05T03:47:22.1307380Z /Users/runner/work/auto-mobile/auto-mobile/ios/control-proxy/Tests/CtrlProxyUITests/HierarchyIntegrationTests.swift:278: error: -[CtrlProxyUITests.HierarchyIntegrationTests testPressKeyForwardDeleteRemovesFollowingCharacter] : failed - first arrow_left press failed: arrow key was not sent: runner time budget exhausted at caret probe after 4363ms; retry" \
    "2026-10-04T15:43:10.4341440Z /Users/runner/work/auto-mobile/auto-mobile/ios/control-proxy/Tests/CtrlProxyUITests/HierarchyIntegrationTests.swift:38: error: -[CtrlProxyUITests.HierarchyIntegrationTests testScreenshotMatchesNativeDimensionsOnOddWidthDevice] : Failed to launch <XCUIApplicationImpl: 0x102ba7800 dev.jasonpearson.automobile.ctrlproxy at /private/tmp/automobile-ctrl-proxy/Build/Products/Debug-iphonesimulator/AutoMobileTest.app> via Xcode: Timed out while launching application via Xcode."; do
    run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" FAKE_XCTEST_LOG="$message" bash "$SCRIPT" 9565
    [ "$status" -eq 0 ]
    [[ "$output" == *"XCTestRunner Simulator Tests → Run CtrlProxy iOS UI tests → none → RERUN-DONT-FIX"* ]]
    [[ "$output" == *"non-required, rerun; #9565"* ]]
  done
}

@test "does not classify an XCTestRunner session heartbeat failure as a rerun flake" {
  fixture="$BATS_TEST_TMPDIR/xctest-ui-timing-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/xctest-ui-timing",
  "jobs": [
    {"databaseId": 44, "name": "XCTestRunner Simulator Tests", "conclusion": "failure", "steps": [{"name": "Run CtrlProxy iOS UI tests", "conclusion": "failure"}]}
  ]
}
JSON

  message="error: session ownership heartbeat failed: The token no longer owns session 5d4881bf-a0e1-4636-b64a-51d1c73f525b's liveness. Re-claim with a fresh token and --claim-liveness-ownership, or stop the keeper."
  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" FAKE_XCTEST_LOG="$message" bash "$SCRIPT" 9565
  [ "$status" -eq 0 ]
  [[ "$output" == *"XCTestRunner Simulator Tests → Run CtrlProxy iOS UI tests → none → UNKNOWN"* ]]
  [[ "$output" != *"RERUN-DONT-FIX"* ]]
}

@test "does not classify XCTestRunner product assertions or unanchored timing text as rerun flakes" {
  fixture="$BATS_TEST_TMPDIR/xctest-ui-timing-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/xctest-ui-timing",
  "jobs": [
    {"databaseId": 44, "name": "XCTestRunner Simulator Tests", "conclusion": "failure", "steps": [{"name": "Run CtrlProxy iOS UI tests", "conclusion": "failure"}]}
  ]
}
JSON

  for message in \
    "2026-10-05T02:44:15.5935830Z /Users/runner/work/auto-mobile/auto-mobile/ios/control-proxy/Sources/CtrlProxyRewrite/GesturePerformer.swift:1792: error: -[CtrlProxyUITests.HierarchyIntegrationTests testPressKeyForwardDeleteRemovesFollowingCharacter] : failed: caught error: \"gestureFailed(\"Forward delete unavailable: could not verify the caret position; use text replacement instead\")\"" \
    "2026-10-05T03:49:57.4071890Z /Users/runner/work/auto-mobile/auto-mobile/ios/control-proxy/Tests/CtrlProxyUITests/HierarchyIntegrationTests.swift:354: error: -[CtrlProxyUITests.HierarchyIntegrationTests testHierarchyIncludesTypedTextInputsMissingFromSnapshotTree] : failed - Element 'secure-field' did not gain keyboard focus" \
    "runner time budget exhausted at caret probe" \
    "Timed out while launching application via Xcode"; do
    run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" FAKE_XCTEST_LOG="$message" bash "$SCRIPT" 9565
    [ "$status" -eq 0 ]
    [[ "$output" == *"XCTestRunner Simulator Tests → Run CtrlProxy iOS UI tests → none → UNKNOWN"* ]]
    [[ "$output" != *"RERUN-DONT-FIX"* ]]
  done
}

@test "does not let a keyboard-focus assertion mask an XCTestRunner session heartbeat failure" {
  fixture="$BATS_TEST_TMPDIR/xctest-ui-timing-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/xctest-ui-timing",
  "jobs": [
    {"databaseId": 44, "name": "XCTestRunner Simulator Tests", "conclusion": "failure", "steps": [{"name": "Run CtrlProxy iOS UI tests", "conclusion": "failure"}]}
  ]
}
JSON

  message="error: session ownership heartbeat failed: The token no longer owns session 5d4881bf-a0e1-4636-b64a-51d1c73f525b's liveness. Re-claim with a fresh token and --claim-liveness-ownership, or stop the keeper."
  message+=$'\n'
  message+="2026-10-05T03:49:57.4071890Z /Users/runner/work/auto-mobile/auto-mobile/ios/control-proxy/Tests/CtrlProxyUITests/HierarchyIntegrationTests.swift:354: error: -[CtrlProxyUITests.HierarchyIntegrationTests testHierarchyIncludesTypedTextInputsMissingFromSnapshotTree] : failed - Element 'secure-field' did not gain keyboard focus"
  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" FAKE_XCTEST_LOG="$message" bash "$SCRIPT" 9565
  [ "$status" -eq 0 ]
  [[ "$output" == *"XCTestRunner Simulator Tests → Run CtrlProxy iOS UI tests → none → UNKNOWN"* ]]
  [[ "$output" != *"RERUN-DONT-FIX"* ]]
}

@test "keeps Playground getAndroid runner-connect separate from boot flakes" {
  fixture="$BATS_TEST_TMPDIR/playground-runner-connect-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/android-runner-connect",
  "jobs": [
    {"databaseId": 35, "name": "Run Playground Automobile Emulator Tests", "conclusion": "failure", "steps": [{"name": "Run ./.github/actions/android-emulator", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 7785
  [ "$status" -eq 0 ]
  [[ "$output" == *"Run Playground Automobile Emulator Tests → Run ./.github/actions/android-emulator → none → INVESTIGATE"* ]]
  [[ "$output" != *"RERUN-DONT-FIX"* ]]
}

@test "does not classify a Playground runner-health failure as runner-connect" {
  fixture="$BATS_TEST_TMPDIR/playground-runner-health-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/android-runner-health",
  "jobs": [
    {"databaseId": 36, "name": "Run Playground Automobile Emulator Tests", "conclusion": "failure", "steps": [{"name": "Run ./.github/actions/android-emulator", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 7785
  [ "$status" -eq 0 ]
  [[ "$output" == *"Run Playground Automobile Emulator Tests → Run ./.github/actions/android-emulator → none → UNKNOWN"* ]]
}
@test "reads job logs on gh < 2.101.0 that lacks --allow-escape-sequences" {
  # Feature detection must OMIT the flag on an older gh that rejects it as an
  # unknown flag, or every job-log read would fail there and log-based
  # signatures would silently stop matching. Same fixture as above, older client.
  fixture="$BATS_TEST_TMPDIR/junit-emulator-old-gh-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/android-emulator",
  "jobs": [
    {"databaseId": 6, "name": "Run JUnit Runner Emulator Tests", "conclusion": "failure", "steps": [{"name": "Run AutoMobile tests that require emulator", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" FAKE_GH_ALLOW_ESCAPE=unsupported bash "$SCRIPT" 656
  [ "$status" -eq 0 ]
  [[ "$output" == *"Run JUnit Runner Emulator Tests → Run AutoMobile tests that require emulator → none → RERUN-DONT-FIX"* ]]
}

@test "classifies the terminal Android emulator retry instead of attempt one's flake" {
  fixture="$BATS_TEST_TMPDIR/junit-emulator-terminal-regression-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/android-terminal-regression",
  "jobs": [
    {"databaseId": 31, "name": "Run JUnit Runner Emulator Tests", "conclusion": "failure", "steps": [{"name": "Boot and test Emulator (Retry)", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 655
  [ "$status" -eq 0 ]
  [[ "$output" == *"Run JUnit Runner Emulator Tests → Boot and test Emulator (Retry) → none → UNKNOWN"* ]]
  [[ "$output" != *"RERUN-DONT-FIX"* ]]
}

@test "does not classify ambiguous markerless emulator retry diagnostics as a known flake" {
  fixture="$BATS_TEST_TMPDIR/junit-emulator-markerless-retry-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/android-markerless-retry",
  "jobs": [
    {"databaseId": 32, "name": "Run JUnit Runner Emulator Tests", "conclusion": "failure", "steps": [{"name": "Boot and test Emulator (Retry)", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 658
  [ "$status" -eq 0 ]
  [[ "$output" == *"Run JUnit Runner Emulator Tests → Boot and test Emulator (Retry) → none → UNKNOWN"* ]]
  [[ "$output" == *"log predates the retry marker"* ]]
  [[ "$output" != *"RERUN-DONT-FIX"* ]]
}

@test "does not classify a terminal iOS regression behind a stale attempt-one IDR flake" {
  fixture="$BATS_TEST_TMPDIR/ios-device-capture-terminal-regression-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/ios-terminal-regression",
  "jobs": [
    {"databaseId": 33, "name": "iOS Device Capture to WHEP", "conclusion": "failure", "steps": [{"name": "Run iOS device capture", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 660
  [ "$status" -eq 0 ]
  [[ "$output" == *"iOS Device Capture to WHEP → Run iOS device capture → none → UNKNOWN"* ]]
  [[ "$output" != *"RERUN-DONT-FIX"* ]]
}

@test "does not classify exhausted iOS discovery after the second attempt as a flake" {
  fixture="$BATS_TEST_TMPDIR/ios-discovery-exhausted-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/ios-discovery",
  "jobs": [
    {"databaseId": 37, "name": "iOS Device Capture to WHEP", "conclusion": "failure", "steps": [{"name": "Run iOS device capture", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 662
  [ "$status" -eq 0 ]
  [[ "$output" == *"iOS Device Capture to WHEP → Run iOS device capture → none → UNKNOWN"* ]]
  [[ "$output" != *"RERUN-DONT-FIX"* ]]
}

@test "does not classify an echoed retry marker as an executed retry" {
  fixture="$BATS_TEST_TMPDIR/ios-device-capture-never-retried-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/ios-retry-never-executed",
  "jobs": [
    {"databaseId": 34, "name": "iOS Device Capture to WHEP", "conclusion": "failure", "steps": [{"name": "Run iOS device capture", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 661
  [ "$status" -eq 0 ]
  [[ "$output" == *"iOS Device Capture to WHEP → Run iOS device capture → none → UNKNOWN"* ]]
  [[ "$output" == *"retry attempt never executed"* ]]
  [[ "$output" != *"RERUN-DONT-FIX"* ]]
}

@test "uses a known flake annotation from the second page" {
  fixture="$BATS_TEST_TMPDIR/paginated-annotations-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/paginated-annotations",
  "jobs": [
    {"databaseId": 30, "name": "Run JUnit Runner Emulator Tests", "conclusion": "failure", "steps": [{"name": "Run AutoMobile tests that require emulator", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 656
  [ "$status" -eq 0 ]
  [[ "$output" == *"sys.boot_completed is not 1 → RERUN-DONT-FIX"* ]]
}

@test "classifies timed out jobs and failed timed out steps" {
  fixture="$BATS_TEST_TMPDIR/timed-out-job-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/timed-out-job",
  "jobs": [
    {"databaseId": 40, "name": "Unexpected Timeout Job", "conclusion": "timed_out", "steps": [{"name": "Wait for service", "conclusion": "timed_out"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 657
  [ "$status" -eq 0 ]
  [[ "$output" == *"Unexpected Timeout Job → Wait for service → none → UNKNOWN"* ]]
  [[ "$output" != *"No failed or cancelled jobs"* ]]
}

@test "classifies startup failure jobs" {
  fixture="$BATS_TEST_TMPDIR/startup-failure-job-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/startup-failure-job",
  "jobs": [
    {"databaseId": 41, "name": "Unexpected Startup Failure", "conclusion": "startup_failure", "steps": []}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 658
  [ "$status" -eq 0 ]
  [[ "$output" == *"Unexpected Startup Failure → none → none → UNKNOWN"* ]]
  [[ "$output" != *"No failed or cancelled jobs"* ]]
}

@test "does not mark Node Tests advisory-only when a matrix host integration job also fails" {
  fixture="$BATS_TEST_TMPDIR/node-matrix-hard-and-advisory-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/node-matrix-hard-and-advisory",
  "jobs": [
    {"databaseId": 1, "name": "Node Unit Timing Budget", "conclusion": "failure", "steps": [{"name": "Enforce 100ms budget for changed unit tests", "conclusion": "failure"}]},
    {"databaseId": 42, "name": "Node Host Integration Tests (ubuntu-latest)", "conclusion": "failure", "steps": [{"name": "Run host integration", "conclusion": "failure"}]},
    {"databaseId": 2, "name": "Node Tests", "conclusion": "failure", "steps": [{"name": "Check results", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 659
  [ "$status" -eq 0 ]
  [[ "$output" == *"Node Tests → Check results → none → UNKNOWN — no signature match, investigate"* ]]
  [[ "$output" != *"Node Tests → Check results → none → CHECK-UPSTREAM-FIRST"* ]]
}

@test "does not classify a JUnit assertion in Playground Emulator Tests as an advisory flake" {
  fixture="$BATS_TEST_TMPDIR/playground-emulator-assertion-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/playground-emulator-assertion",
  "jobs": [
    {"databaseId": 9, "name": "Run Playground Automobile Emulator Tests", "conclusion": "failure", "steps": [{"name": "Run AutoMobile tests that require emulator", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 912
  [ "$status" -eq 0 ]
  [[ "$output" == *"Run Playground Automobile Emulator Tests → Run AutoMobile tests that require emulator → expect(received).toBe(expected) ... some product assertion failed → UNKNOWN"* ]]
  [[ "$output" != *"RERUN-DONT-FIX"* ]]
}

@test "marks Android as upstream-only when Playground Automobile Emulator is its only failure" {
  fixture="$BATS_TEST_TMPDIR/android-advisory-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/android-emulator",
  "jobs": [
    {"databaseId": 7, "name": "Run Playground Automobile Emulator Tests", "conclusion": "failure", "steps": [{"name": "Run AutoMobile tests that require emulator", "conclusion": "failure"}]},
    {"databaseId": 8, "name": "Android", "conclusion": "failure", "steps": [{"name": "Check results", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 321
  [ "$status" -eq 0 ]
  [[ "$output" == *"Android → Check results → none → CHECK-UPSTREAM-FIRST"* ]]
}

@test "does not mark Android advisory-only when Build CtrlProxy APK also fails" {
  fixture="$BATS_TEST_TMPDIR/android-hard-and-advisory-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/android-hard-and-advisory",
  "jobs": [
    {"databaseId": 7, "name": "Run Playground Automobile Emulator Tests", "conclusion": "failure", "steps": [{"name": "Run AutoMobile tests that require emulator", "conclusion": "failure"}]},
    {"databaseId": 11, "name": "Build CtrlProxy APK", "conclusion": "failure", "steps": [{"name": "Build Android APK", "conclusion": "failure"}]},
    {"databaseId": 8, "name": "Android", "conclusion": "failure", "steps": [{"name": "Check results", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 322
  [ "$status" -eq 0 ]
  [[ "$output" == *"Android → Check results → none → UNKNOWN — no signature match, investigate"* ]]
  [[ "$output" != *"Android → Check results → none → CHECK-UPSTREAM-FIRST"* ]]
}

@test "does not mark Android advisory-only when Android Emulator Compile Smoke also fails" {
  fixture="$BATS_TEST_TMPDIR/android-compile-smoke-hard-and-advisory-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/android-compile-smoke-hard",
  "jobs": [
    {"databaseId": 7, "name": "Run Playground Automobile Emulator Tests", "conclusion": "failure", "steps": [{"name": "Run AutoMobile tests that require emulator", "conclusion": "failure"}]},
    {"databaseId": 12, "name": "Android Emulator Compile Smoke", "conclusion": "failure", "steps": [{"name": "Compile test sources", "conclusion": "failure"}]},
    {"databaseId": 8, "name": "Android", "conclusion": "failure", "steps": [{"name": "Check results", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 323
  [ "$status" -eq 0 ]
  [[ "$output" == *"Android → Check results → none → UNKNOWN — no signature match, investigate"* ]]
  [[ "$output" != *"Android → Check results → none → CHECK-UPSTREAM-FIRST"* ]]
}

@test "does not mark iOS advisory-only when matrix Playground Tests also fails" {
  fixture="$BATS_TEST_TMPDIR/ios-hard-and-advisory-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/ios-playground-hard-failure",
  "jobs": [
    {"databaseId": 12, "name": "XCTestRunner Simulator Tests", "conclusion": "failure", "steps": [{"name": "Run XCTestRunner integration tests", "conclusion": "failure"}]},
    {"databaseId": 13, "name": "iOS Playground Tests (iPhone 17)", "conclusion": "failure", "steps": [{"name": "Run Playground tests", "conclusion": "failure"}]},
    {"databaseId": 14, "name": "iOS", "conclusion": "failure", "steps": [{"name": "Check results", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 323
  [ "$status" -eq 0 ]
  [[ "$output" == *"iOS → Check results → none → UNKNOWN — no signature match, investigate"* ]]
  [[ "$output" != *"iOS → Check results → none → CHECK-UPSTREAM-FIRST"* ]]
}

@test "does not mark iOS advisory-only even when it is the only failure (no advisory lane left in the gate)" {
  fixture="$BATS_TEST_TMPDIR/ios-simulator-only-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/ios-simulator-only-failure",
  "jobs": [
    {"databaseId": 20, "name": "XCTestRunner Simulator Tests", "conclusion": "failure", "steps": [{"name": "Run XCTestRunner integration tests", "conclusion": "failure"}]},
    {"databaseId": 21, "name": "iOS", "conclusion": "failure", "steps": [{"name": "Check results", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 324
  [ "$status" -eq 0 ]
  [[ "$output" == *"iOS → Check results → none → UNKNOWN — no signature match, investigate"* ]]
  [[ "$output" != *"iOS → Check results → none → CHECK-UPSTREAM-FIRST"* ]]
}

@test "does not mark WebRTC upstream-only when the publisher lane fails" {
  fixture="$BATS_TEST_TMPDIR/webrtc-advisory-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/webrtc-capture",
  "jobs": [
    {"databaseId": 15, "name": "WebRTC Publisher Integration (MediaMTX)", "conclusion": "failure", "steps": [{"name": "Run MediaMTX integration", "conclusion": "failure"}]},
    {"databaseId": 16, "name": "iOS Device Capture to WHEP", "conclusion": "failure", "steps": [{"name": "Run iOS capture", "conclusion": "failure"}]},
    {"databaseId": 17, "name": "WebRTC", "conclusion": "failure", "steps": [{"name": "Check results", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 324
  [ "$status" -eq 0 ]
  [[ "$output" == *"WebRTC → Check results → none → UNKNOWN — no signature match, investigate"* ]]
  [[ "$output" != *"WebRTC → Check results → none → CHECK-UPSTREAM-FIRST"* ]]
}

@test "marks WebRTC upstream-only when only an iOS capture lane fails" {
  fixture="$BATS_TEST_TMPDIR/webrtc-ios-advisory-run.json"
  cat > "$fixture" <<'JSON'
{
  "headBranch": "work/webrtc-capture",
  "jobs": [
    {"databaseId": 16, "name": "iOS Device Capture to WHEP", "conclusion": "failure", "steps": [{"name": "Run iOS capture", "conclusion": "failure"}]},
    {"databaseId": 17, "name": "WebRTC", "conclusion": "failure", "steps": [{"name": "Check results", "conclusion": "failure"}]}
  ]
}
JSON

  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$fixture" bash "$SCRIPT" 325
  [ "$status" -eq 0 ]
  [[ "$output" == *"WebRTC → Check results → none → CHECK-UPSTREAM-FIRST"* ]]
}

startup_fixture() {
  local job="$1"
  jq -n --arg job "$job" '{headBranch:"work/ci", jobs:[{databaseId:45,name:$job,conclusion:"failure",steps:[{name:"Create AVD and generate snapshot for caching",conclusion:"failure"}]}]}' > "$FIXTURE"
}

@test "JUnit emulator startup log classifies without an executed retry" {
  startup_fixture "Run JUnit Runner Emulator Tests"
  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$FIXTURE" FAKE_EMULATOR_LOG=$'Warning: Error on ZipFile unknown archive\nerror: could not connect to TCP port 5554: Connection refused' bash "$SCRIPT" 123
  [ "$status" -eq 0 ]
  [[ "$output" == *"RERUN-DONT-FIX — emulator start-up infra failure"* ]]
}

@test "Playground emulator connection refusal and ZipFile each classify" {
  startup_fixture "Run Playground Automobile Emulator Tests"
  for message in 'could not connect to TCP port 5554: Connection refused' 'Error on ZipFile unknown archive'; do
    run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$FIXTURE" FAKE_EMULATOR_LOG="$message" bash "$SCRIPT" 123
    [ "$status" -eq 0 ]
    [[ "$output" == *"RERUN-DONT-FIX — emulator start-up infra failure"* ]]
  done
}

@test "JUnit connection refusal and ZipFile each classify with ANSI log text" {
  startup_fixture "Run JUnit Runner Emulator Tests"
  for message in 'could not connect to TCP port 5554: Connection refused' 'Error on ZipFile unknown archive'; do
    run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$FIXTURE" FAKE_EMULATOR_LOG=$'\033[31m'"$message"$'\033[0m' bash "$SCRIPT" 123
    [ "$status" -eq 0 ]
    [[ "$output" == *"RERUN-DONT-FIX — emulator start-up infra failure"* ]]
  done
}

@test "unrelated Node job cannot inherit emulator startup signatures" {
  startup_fixture "Node Unit Tests"
  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$FIXTURE" FAKE_EMULATOR_LOG=$'Error on ZipFile unknown archive\ncould not connect to TCP port 5554: Connection refused' bash "$SCRIPT" 123
  [ "$status" -eq 0 ]
  [[ "$output" == *"UNKNOWN"* ]]
  [[ "$output" != *"RERUN-DONT-FIX"* ]]
}

runner_shutdown_fixture() {
  local job="$1"
  jq -n --arg job "$job" '{headBranch:"work/ci", jobs:[{databaseId:46,name:$job,conclusion:"failure",steps:[{name:"Run build/test lane",conclusion:"failure"}]}]}' > "$FIXTURE"
}

# Real capture from #10015 (runs 37396277713 and 37398684911).
RUNNER_SHUTDOWN_LOG=$'##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.\n##[error]Process completed with exit code 143.'

@test "classifies a hosted runner shutdown signal as a rerun infrastructure failure on any job" {
  for job in "Node TypeScript Build and Test (ubuntu-latest)" "JUnit Runner Kotlin Consumer Compatibility"; do
    runner_shutdown_fixture "$job"
    run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$FIXTURE" FAKE_RUNNER_LOG="$RUNNER_SHUTDOWN_LOG" bash "$SCRIPT" 123
    [ "$status" -eq 0 ]
    [[ "$output" == *"RERUN-DONT-FIX — hosted runner shut down mid-job (exit 143), infrastructure failure"* ]]
    [[ "$output" != *"UNKNOWN"* ]]
  done
}

@test "classifies a runner shutdown signal in a timestamped ANSI log line" {
  runner_shutdown_fixture "Node TypeScript Build and Test (ubuntu-latest)"
  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$FIXTURE" FAKE_RUNNER_LOG=$'2026-10-06T01:02:03.4567890Z \033[31m'"$RUNNER_SHUTDOWN_LOG"$'\033[0m' bash "$SCRIPT" 123
  [ "$status" -eq 0 ]
  [[ "$output" == *"RERUN-DONT-FIX — hosted runner shut down mid-job"* ]]
}

@test "does not classify a bare exit code 143 without the runner shutdown message" {
  runner_shutdown_fixture "Node TypeScript Build and Test (ubuntu-latest)"
  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$FIXTURE" FAKE_RUNNER_LOG=$'expect(received).toBe(expected) ... someRealRegression assertion failed\n##[error]Process completed with exit code 143.' bash "$SCRIPT" 123
  [ "$status" -eq 0 ]
  [[ "$output" == *"UNKNOWN"* ]]
  [[ "$output" != *"RERUN-DONT-FIX"* ]]
}

# Unit-shard infra retry (#10583): lines as scripts/test-ts.sh prints them.
@test "investigates a unit shard that timed out on both attempts of its infra retry" {
  runner_shutdown_fixture "Node Unit Tests (ubuntu-latest)"
  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$FIXTURE" FAKE_RUNNER_LOG=$'RETRY: unit shard 2 hit its 720s wall-clock budget (exit 124) after 721s; retrying once with the same budget\nTIMEOUT: unit shard 2 exceeded its wall-clock budget after a retry\ntest-ts: unit shards total wall=1450s status=124 retried=1' bash "$SCRIPT" 123
  [ "$status" -eq 0 ]
  [[ "$output" == *"INVESTIGATE — unit shard hit its wall budget on both attempts of the in-job infra retry"* ]]
}

@test "investigates a unit shard killed by a signal on both attempts of its infra retry" {
  runner_shutdown_fixture "Node Unit Tests (ubuntu-latest)"
  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$FIXTURE" FAKE_RUNNER_LOG=$'RETRY: unit shard 0 was killed by signal 9 (exit 137) after 300s; retrying once with the same budget\nFAIL: unit shard 0 exited with status 137 after a retry' bash "$SCRIPT" 123
  [ "$status" -eq 0 ]
  [[ "$output" == *"INVESTIGATE — unit shard was killed by a signal on both attempts of the in-job infra retry"* ]]
}

@test "does not classify an ordinary unit shard failure or a passing retry as a retry signature" {
  runner_shutdown_fixture "Node Unit Tests (ubuntu-latest)"
  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$FIXTURE" FAKE_RUNNER_LOG=$'RETRY: unit shard 0 hit its 720s wall-clock budget (exit 124) after 721s; retrying once with the same budget\ntest-ts: unit shard 0 passed on its retry\nFAIL: unit shard 1 exited with status 1' bash "$SCRIPT" 123
  [ "$status" -eq 0 ]
  [[ "$output" == *"UNKNOWN"* ]]
  [[ "$output" != *"infra retry"* ]]
}
