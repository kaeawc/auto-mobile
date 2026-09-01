#!/usr/bin/env bats
#
# Argument-validation and fail-fast coverage for the Darling CI experiment
# scripts (.github/workflows/darling-experiment.yml). The real probe paths
# need an installed Darling and only run on the Linux CI runner; these
# tests pin down the cheap contracts every platform can check: usage errors,
# tool preconditions, and refusal to guess at an Xcode archive.

setup() {
    REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    export REPO_ROOT
}

@test "darling-install.sh without args prints usage and exits 2" {
    run bash "$REPO_ROOT/scripts/ci/darling-install.sh"
    [ "$status" -eq 2 ]
    [[ "$output" == *"Usage:"* ]]
}

@test "darling-install.sh requires both url and sha256" {
    run bash "$REPO_ROOT/scripts/ci/darling-install.sh" "https://example.invalid/debs.zip"
    [ "$status" -eq 2 ]
    [[ "$output" == *"Usage:"* ]]
}

@test "darling-smoke.sh fails fast when darling is not installed" {
    # A PATH without darling reproduces every non-Linux machine and any
    # runner where the install step was skipped.
    run env PATH="/usr/bin:/bin" bash "$REPO_ROOT/scripts/ci/darling-smoke.sh"
    [ "$status" -eq 2 ]
    [[ "$output" == *"'darling' is not on PATH"* ]]
}

@test "darling-xcodebuild-probe.sh refuses to run without an explicit archive" {
    run bash "$REPO_ROOT/scripts/ci/darling-xcodebuild-probe.sh"
    [ "$status" -eq 2 ]
    [[ "$output" == *"No Xcode archive supplied"* ]]
}
