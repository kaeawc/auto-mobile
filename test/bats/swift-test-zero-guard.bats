#!/usr/bin/env bats
#
# Guards issue #4143: `swift test` exits 0 when it runs nothing, so a package
# whose suite was deleted, emptied, or not discovered was reported as passing.
# Verified directly:
#
#   $ swift test --filter ThisSuiteDoesNotExistAnywhere
#   ✔ Test run with 0 tests in 0 suites passed after 0.001 seconds.
#   $ echo $?
#   0
#
# swift-test.sh now requires a package that declares a testTarget to have
# actually executed tests. These tests pin the counting, which is the piece that
# decides pass-vs-fail; feeding it a zero-test transcript must yield 0.
#
# Absolute path: several bats files here `cd` inside a test body without a
# subshell, so a relative path resolves against whatever cwd they left behind.
SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/scripts/ios/swift-test.sh"

# Pull just the counter out of the script so the parsing is testable offline,
# with no Swift toolchain and no network.
load_counter() {
  # shellcheck source=/dev/null
  source <(sed -n '/^executed_test_count()/,/^}/p' "$SCRIPT")
}

@test "the counter is defined in swift-test.sh" {
  load_counter
  declare -F executed_test_count
}

@test "an XCTest transcript reports its executed count" {
  load_counter
  out=$'\t Executed 27 tests, with 0 failures (0 unexpected) in 0.057 (0.059) seconds'
  [ "$(executed_test_count "$out")" -eq 27 ]
}

@test "XCTest's duplicated summary line is not double counted" {
  # XCTest prints the summary once per bundle AND again at the end. Summing the
  # lines would report 54 for a 27-test run, which is harmless for a >0 check but
  # wrong for anything that later reads this number.
  load_counter
  out=$'\t Executed 27 tests, with 0 failures (0 unexpected) in 0.057 (0.059) seconds\n\t Executed 27 tests, with 0 failures (0 unexpected) in 0.057 (0.060) seconds'
  [ "$(executed_test_count "$out")" -eq 27 ]
}

@test "a zero-test run counts zero (the case that used to pass silently)" {
  load_counter
  out='✔ Test run with 0 tests in 0 suites passed after 0.001 seconds.'
  [ "$(executed_test_count "$out")" -eq 0 ]
}

@test "a real package emitting both runners sums them" {
  # XCTestRunner emits an XCTest count AND a swift-testing count in one run.
  load_counter
  out=$'Executed 12 tests, with 0 failures (0 unexpected) in 1.0 (1.0) seconds\n✔ Test run with 5 tests in 2 suites passed after 0.1 seconds.'
  [ "$(executed_test_count "$out")" -eq 17 ]
}

@test "swift-testing-only packages are counted" {
  load_counter
  out='✔ Test run with 8 tests in 3 suites passed after 0.2 seconds.'
  [ "$(executed_test_count "$out")" -eq 8 ]
}

@test "output with no recognizable count yields zero rather than empty" {
  # An empty string here would make the `-eq 0` comparison in swift-test.sh a
  # syntax error rather than a clean failure.
  load_counter
  out='some unrelated build chatter'
  [ "$(executed_test_count "$out")" -eq 0 ]
}

@test "swift-test.sh fails a testTarget package that executed no tests" {
  # The guard itself, not just the counter: the zero-test branch must mark the
  # package failed rather than passed.
  grep -q 'executed 0 tests' "$SCRIPT"
  grep -q 'FAILED_PACKAGES+=("${package} (0 tests executed)")' "$SCRIPT"
}
