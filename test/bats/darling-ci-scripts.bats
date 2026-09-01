#!/usr/bin/env bats
#
# Argument-validation and fail-fast coverage for the Darling CI experiment
# scripts (.github/workflows/darling-experiment.yml). The real probe paths
# need a built Darling install and only run on the Linux CI runner; these
# tests pin down the cheap contracts every platform can check: usage errors,
# root/tool preconditions, and refusal to guess at an Xcode archive.

setup() {
    REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    export REPO_ROOT
}

@test "darling-build.sh without args prints usage and exits 2" {
    run bash "$REPO_ROOT/scripts/ci/darling-build.sh"
    [ "$status" -eq 2 ]
    [[ "$output" == *"Usage:"* ]]
}

@test "darling-build.sh rejects unknown flags" {
    run bash "$REPO_ROOT/scripts/ci/darling-build.sh" --bogus value
    [ "$status" -eq 2 ]
    [[ "$output" == *"Usage:"* ]]
}

@test "darling-build.sh requires all three of ref/components/output" {
    run bash "$REPO_ROOT/scripts/ci/darling-build.sh" --ref v1 --components cli_dev
    [ "$status" -eq 2 ]
    [[ "$output" == *"Usage:"* ]]
}

@test "darling-install.sh without a tarball prints usage and exits 2" {
    run bash "$REPO_ROOT/scripts/ci/darling-install.sh"
    [ "$status" -eq 2 ]
    [[ "$output" == *"Usage:"* ]]
}

@test "darling-install.sh rejects a missing tarball path" {
    run bash "$REPO_ROOT/scripts/ci/darling-install.sh" "$BATS_TEST_TMPDIR/nope.tar.zst"
    [ "$status" -eq 2 ]
    [[ "$output" == *"tarball not found"* ]]
}

@test "darling-install.sh refuses to run as non-root" {
    # Root would proceed to extraction; CI and dev runs are non-root.
    if [ "$(id -u)" -eq 0 ]; then
        skip "running as root"
    fi
    tarball="$BATS_TEST_TMPDIR/empty.tar.zst"
    : >"$tarball"
    run bash "$REPO_ROOT/scripts/ci/darling-install.sh" "$tarball"
    [ "$status" -eq 2 ]
    [[ "$output" == *"must run as root"* ]]
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
