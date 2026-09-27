#!/usr/bin/env bats

ACTION=".github/actions/android-emulator/action.yml"

wiring_requires_yq() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo "yq is required in CI to verify android-emulator action wiring" >&2
    return 1
  fi
  skip "yq not installed"
}

@test "emulator retry marker is wired only to the retry step" {
  wiring_requires_yq
  local retry_run attempt_run
  retry_run="$(yq -r '.runs.steps[] | select(.id == "emulator-attempt-2") | .run' "$ACTION")"
  attempt_run="$(yq -r '.runs.steps[] | select(.id == "emulator-attempt-1") | .run' "$ACTION")"

  [[ "$retry_run" == *"Starting emulator retry attempt 2."* ]]
  [[ "$attempt_run" != *"Starting emulator retry attempt 2."* ]]
}

@test "daemon reset runs only after a failed first attempt and before retry" {
  wiring_requires_yq
  local reset_index retry_index reset_condition reset_run attempt_condition reset_working_directory
  reset_index="$(yq -r '.runs.steps | to_entries[] | select(.value.name == "Reset AutoMobile Daemon Before Retry") | .key' "$ACTION")"
  retry_index="$(yq -r '.runs.steps | to_entries[] | select(.value.id == "emulator-attempt-2") | .key' "$ACTION")"
  reset_condition="$(yq -r '.runs.steps[] | select(.name == "Reset AutoMobile Daemon Before Retry") | .if' "$ACTION")"
  reset_run="$(yq -r '.runs.steps[] | select(.name == "Reset AutoMobile Daemon Before Retry") | .run' "$ACTION")"
  reset_working_directory="$(yq -r '.runs.steps[] | select(.name == "Reset AutoMobile Daemon Before Retry") | ."working-directory"' "$ACTION")"
  attempt_condition="$(yq -r '.runs.steps[] | select(.id == "emulator-attempt-1") | .if' "$ACTION")"

  [ -n "$reset_index" ]
  [ "$reset_index" -lt "$retry_index" ]
  [ "$reset_condition" = "steps.emulator-attempt-1.outcome == 'failure'" ]
  [[ "$reset_run" == *"scripts/android/reset-daemon-before-retry.sh"* ]]
  [ "$reset_working_directory" = "null" ]
  [ "$attempt_condition" = "null" ]
}
