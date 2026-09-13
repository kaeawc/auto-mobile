#!/usr/bin/env bats

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
case "$1 $2" in
  'run view') cat "$CLASSIFY_FIXTURE" ;;
  api\ *)
    case "$2" in
      */check-runs/1/annotations) printf '[]\n' ;;
      */actions/jobs/1/logs) printf 'Test exceeded 100ms: timing budget fixture\n' ;;
      */check-runs/3/annotations) printf '[{"message":"sharp: Could not load the sharp module"}]\n' ;;
      */check-runs/4/annotations) printf '[{"message":"expect(received).toBe(expected) ... deviceDiscoveryReconcileFunnel assertion failed"}]\n' ;;
      */check-runs/5/annotations) printf '[{"message":"XCTAssertEqual failed: (\\"foo\\") is not equal to (\\"bar\\")"}]\n' ;;
      */check-runs/9/annotations) printf '[{"message":"expect(received).toBe(expected) ... some product assertion failed"}]\n' ;;
      */check-runs/10/annotations) printf '[{"message":"oxlint: no-unused-vars lint failure"}]\n' ;;
      */check-runs/12/annotations|*/check-runs/13/annotations|*/check-runs/14/annotations) printf '[]\n' ;;
      */check-runs/15/annotations|*/check-runs/16/annotations|*/check-runs/17/annotations) printf '[]\n' ;;
      */actions/jobs/6/logs) printf 'readiness phase exceeded the remaining deadline\n' ;;
      */actions/jobs/18/logs) printf 'Test exceeded 100ms: some/test.ts > some test (median 142.31ms of 3 isolated runs)\n' ;;
      */actions/jobs/19/logs|*/actions/jobs/20/logs|*/actions/jobs/21/logs) : ;;
      */actions/runs/*/artifacts) printf '%s\n' '{"artifacts":[{"id":101,"name":"mcp-build-test-logs-windows-latest"},{"id":102,"name":"mcp-build-test-logs-ubuntu-latest"}]}' ;;
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
