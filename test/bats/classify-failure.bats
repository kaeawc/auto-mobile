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

@test "classifies an advisory timing-budget log flake and its red aggregator without annotations" {
  run env PATH="$FAKE_BIN:$PATH" CLASSIFY_FIXTURE="$FIXTURE" bash "$SCRIPT" 123
  [ "$status" -eq 0 ]
  [[ "$output" == *"Node Unit Timing Budget → Enforce 100ms budget for changed unit tests → none → RERUN-DONT-FIX"* ]]
  [[ "$output" == *"Node Tests → Check results → none → CHECK-UPSTREAM-FIRST"* ]]
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
