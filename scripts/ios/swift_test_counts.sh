#!/usr/bin/env bash
#
# Count the tests a `swift test` run actually executed (issue #4143).
#
# `swift test` exits 0 when it runs nothing, so a package whose suite was
# deleted, emptied, or not discovered is indistinguishable from one that passed
# on exit code alone. swift-test.sh uses this to require that a package
# declaring a testTarget actually executed tests.
#
# Both runners can appear in one package's output, so their counts are summed:
#   XCTest         "Executed 26 tests, with 0 failures ..."
#   swift-testing  "Test run with 0 tests in 0 suites passed ..."
#
# XCTest prints its summary once per test bundle AND again at the end, so the
# maximum of those lines is taken rather than their sum -- summing reports 54 for
# a 27-test run. Harmless for a >0 check, wrong for anything that reads the value.
#
# Sets EXECUTED_TESTS rather than echoing: calling a function inside $( ) makes
# bash silently disable set -e for that call (SC2311), and suppressing errexit
# inside a guard whose whole job is catching silent success is self-defeating.
#
# This file is meant to be sourced; it only defines a function and a variable.

# shellcheck disable=SC2034  # consumed by sourcing scripts (swift-test.sh, bats)
EXECUTED_TESTS=0

executed_test_count() {
    local output="$1" xctest swifttesting
    xctest="$(printf '%s\n' "${output}" \
        | sed -n 's/.*Executed \([0-9][0-9]*\) tests*,.*/\1/p' \
        | sort -n | tail -1)"
    swifttesting="$(printf '%s\n' "${output}" \
        | sed -n 's/.*Test run with \([0-9][0-9]*\) tests* in .*/\1/p' \
        | sort -n | tail -1)"
    # shellcheck disable=SC2034  # read by the sourcing script
    EXECUTED_TESTS=$(( ${xctest:-0} + ${swifttesting:-0} ))
}
