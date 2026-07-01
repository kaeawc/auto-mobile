#!/usr/bin/env bats
#
# Guards the wiring the issue #2745 regression was about: every workflow that
# generates release constants must pass the computed iOS runner SHA256 into the
# script, and the release paths must run the integrity gate before publishing.

@test "release.yml passes runner sha256 into generate-release-constants" {
  grep -q "IOS_CTRL_PROXY_RUNNER_SHA256:" ".github/workflows/release.yml"
  grep -q "runner_sha256" ".github/workflows/release.yml"
}

@test "prepare-release.yml passes runner sha256 into generate-release-constants" {
  grep -q "IOS_CTRL_PROXY_RUNNER_SHA256:" ".github/workflows/prepare-release.yml"
  grep -q "runner_sha256" ".github/workflows/prepare-release.yml"
}

@test "nightly.yml passes runner sha256 into generate-release-constants" {
  grep -q "IOS_CTRL_PROXY_RUNNER_SHA256:" ".github/workflows/nightly.yml"
  grep -q "runner_sha256" ".github/workflows/nightly.yml"
}

@test "release.yml runs the release-integrity gate" {
  grep -q "verify-release-integrity.sh" ".github/workflows/release.yml"
}

@test "prepare-release.yml runs the release-integrity gate" {
  grep -q "verify-release-integrity.sh" ".github/workflows/prepare-release.yml"
}
