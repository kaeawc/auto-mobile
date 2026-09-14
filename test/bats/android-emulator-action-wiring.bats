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
