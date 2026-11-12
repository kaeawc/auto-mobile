#!/usr/bin/env bats
#
# Tests for scripts/metrics/release-run-in-progress.sh (#18175): the download
# metrics workflow skips its main commit while a Prepare Release or Release run
# is active, so the bot never moves main under a release being verified.

SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/metrics/release-run-in-progress.sh"
WORKFLOW="${BATS_TEST_DIRNAME}/../../.github/workflows/release-downloads-metrics.yml"

setup() {
  BIN_DIR="$(mktemp -d)"
  # Fake `gh api <path> --jq ...`: print FAKE_ACTIVE_RUN_ID only for the
  # workflow/status pair named by FAKE_ACTIVE (e.g. "release.yml:queued").
  cat > "${BIN_DIR}/gh" <<'FAKE'
#!/usr/bin/env bash
[ "${FAKE_GH_FAIL:-0}" = "1" ] && exit 1
path="$2"
workflow="${path#*/workflows/}"; workflow="${workflow%%/*}"
status="${path#*status=}"; status="${status%%&*}"
if [ "${workflow}:${status}" = "${FAKE_ACTIVE:-}" ]; then
  echo "${FAKE_ACTIVE_RUN_ID:-42}"
fi
exit 0
FAKE
  chmod +x "${BIN_DIR}/gh"
}

teardown() {
  rm -rf "$BIN_DIR"
}

run_guard() {
  run env PATH="${BIN_DIR}:${PATH}" "$@" bash "$SCRIPT" kaeawc/auto-mobile
}

@test "exits 1 when no release run is active" {
  run_guard
  [ "$status" -eq 1 ]
  [ -z "$output" ]
}

@test "reports an in-progress Prepare Release run" {
  run_guard FAKE_ACTIVE=prepare-release.yml:in_progress FAKE_ACTIVE_RUN_ID=43215278003
  [ "$status" -eq 0 ]
  [ "$output" = "prepare-release.yml run 43215278003 is in_progress" ]
}

@test "reports a queued or waiting Release run" {
  run_guard FAKE_ACTIVE=release.yml:queued
  [ "$status" -eq 0 ]
  [[ "$output" == "release.yml run 42 is queued" ]]

  run_guard FAKE_ACTIVE=release.yml:waiting
  [ "$status" -eq 0 ]
}

@test "fails with exit 2 when the API call fails" {
  run_guard FAKE_GH_FAIL=1
  [ "$status" -eq 2 ]
  [[ "$output" == *"Failed to list prepare-release.yml runs"* ]]
}

@test "requires a repository argument" {
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
}

load yq-helpers

@test "metrics workflow gates the snapshot push on the release guard" {
  require_mikefarah_yq

  run yq -r '.permissions.actions' "$WORKFLOW"
  [ "$output" = "read" ]

  run yq -r '.jobs.snapshot.steps[] | select(.id == "release-guard") | .run' "$WORKFLOW"
  [ "$status" -eq 0 ]
  [[ "$output" == *'bash scripts/metrics/release-run-in-progress.sh "$REPO"'* ]]

  run yq -r '.jobs.snapshot.steps[] | select(.name == "Collect and push download snapshot") | .if' "$WORKFLOW"
  [ "$output" = "steps.release-guard.outputs.skip != 'true'" ]
}
