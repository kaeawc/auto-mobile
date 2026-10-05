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

@test "default profile preserves the existing AVD cache keys" {
  wiring_requires_yq
  local profile_fragment key restore_keys
  profile_fragment="\${{ inputs.profile != '' && format('{0}-', inputs.profile) || '' }}"
  [ "$(yq -r '.inputs.profile.default' "$ACTION")" = "" ]
  [ "$(yq -r '.runs.steps[] | select(.name == "Create AVD and generate snapshot for caching") | .with.profile' "$ACTION")" = '${{ inputs.profile }}' ]
  key="$(yq -r '.runs.steps[] | select(.id == "avd-cache") | .with.key' "$ACTION")"
  restore_keys="$(yq -r '.runs.steps[] | select(.id == "avd-cache") | .with."restore-keys"' "$ACTION")"
  [[ "$key" == *"$profile_fragment"* ]]
  [[ "$restore_keys" == *"$profile_fragment"* ]]
  [ "${key//$profile_fragment/}" = 'avd-${{ runner.os }}-${{ inputs.avd-name }}-${{ inputs.api_level }}-${{ inputs.arch }}-${{ inputs.target }}' ]
  [ "${restore_keys//$profile_fragment/}" = $'avd-${{ runner.os }}-${{ inputs.avd-name }}-${{ inputs.api_level }}-${{ inputs.arch }}-\navd-${{ runner.os }}-${{ inputs.avd-name }}-${{ inputs.api_level }}-\navd-${{ runner.os }}-${{ inputs.avd-name }}-' ]
}

@test "windowed emulation is opt in for resize-display" {
  wiring_requires_yq
  local prep_options boot_options retry_options
  [ "$(yq -r '.inputs.windowed.default' "$ACTION")" = "false" ]
  prep_options="$(yq -r '.runs.steps[] | select(.name == "Create AVD and generate snapshot for caching") | .with."emulator-options"' "$ACTION")"
  boot_options="$(yq -r '.runs.steps[] | select(.id == "emulator-attempt-1") | .run' "$ACTION")"
  retry_options="$(yq -r '.runs.steps[] | select(.id == "emulator-attempt-2") | .run' "$ACTION")"
  [[ "$prep_options" == *"inputs.windowed == 'true'"* ]]
  [[ "$prep_options" == *"'-no-window -gpu swiftshader_indirect -noaudio -no-boot-anim -camera-back none'"* ]]
  [[ "$boot_options" == *"inputs.windowed == 'true'"* ]]
  [[ "$retry_options" == *"inputs.windowed == 'true'"* ]]
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

@test "foldable posture lane stays advisory and nightly-only with profile artifacts" {
  wiring_requires_yq
  local nightly workflow artifact_name artifact_paths
  nightly=".github/workflows/nightly.yml"
  [ "$(yq -r '.jobs | has("foldable-posture-tests")' "$nightly")" = "true" ]
  for workflow in .github/workflows/*.yml; do
    [ "$workflow" = "$nightly" ] && continue
    [ "$(yq -r '.jobs | has("foldable-posture-tests")' "$workflow")" = "false" ]
  done
  [ "$(yq -r '.jobs."foldable-posture-tests"."continue-on-error"' "$nightly")" = "true" ]
  [ "$(yq -r '.jobs."foldable-posture-tests".env.AUTOMOBILE_FOLDABLE_LANE' "$nightly")" = "1" ]
  artifact_name="$(yq -r '.jobs."foldable-posture-tests".steps[] | select(.uses == "actions/upload-artifact@v6") | .with.name' "$nightly")"
  [[ "$artifact_name" == *"\${{ matrix.profile }}"* ]]
  artifact_paths="$(yq -r '.jobs."foldable-posture-tests".steps[] | select(.uses == "actions/upload-artifact@v6") | .with.path' "$nightly")"
  [[ "$artifact_paths" == *'scratch/foldable-lane/'* ]]
}

@test "AVD creation failure immediately collects and prints diagnostics" {
  wiring_requires_yq
  local creation_index diagnostics_index condition diagnostics_run
  creation_index="$(yq -r '.runs.steps | to_entries[] | select(.value.id == "avd-create") | .key' "$ACTION")"
  diagnostics_index="$(yq -r '.runs.steps | to_entries[] | select(.value.name == "Surface AVD Creation Diagnostics") | .key' "$ACTION")"
  [ -n "$creation_index" ]
  [ "$diagnostics_index" -eq "$((creation_index + 1))" ]
  condition="$(yq -r '.runs.steps[] | select(.name == "Surface AVD Creation Diagnostics") | .if' "$ACTION")"
  [ "$condition" = "failure() && steps.avd-create.outcome == 'failure'" ]
  diagnostics_run="$(yq -r '.runs.steps[] | select(.name == "Surface AVD Creation Diagnostics") | .run' "$ACTION")"
  [[ "$diagnostics_run" == *"collect-emulator-diagnostics.sh"*"print-emulator-diagnostics.sh"* ]]
  [[ "$diagnostics_run" == *"android-emulator-diagnostics/avd-create"* ]]
}

@test "retry failure immediately prints diagnostics even after job failure" {
  wiring_requires_yq
  local retry_index diagnostics_index diagnostics_run
  retry_index="$(yq -r '.runs.steps | to_entries[] | select(.value.id == "emulator-attempt-2") | .key' "$ACTION")"
  diagnostics_index="$(yq -r '.runs.steps | to_entries[] | select(.value.name == "Surface Emulator Diagnostics After Retry") | .key' "$ACTION")"
  [ "$diagnostics_index" -eq "$((retry_index + 1))" ]
  [ "$(yq -r '.runs.steps[] | select(.name == "Surface Emulator Diagnostics After Retry") | .if' "$ACTION")" = "always() && steps.emulator-attempt-2.outcome == 'failure'" ]
  diagnostics_run="$(yq -r '.runs.steps[] | select(.name == "Surface Emulator Diagnostics After Retry") | .run' "$ACTION")"
  [[ "$diagnostics_run" == *"print-emulator-diagnostics.sh"*"android-emulator-diagnostics/attempt-2"* ]]
}

@test "diagnostic upload covers AVD creation failure and all attempt directories" {
  wiring_requires_yq
  [ "$(yq -r '.runs.steps[] | select(.name == "Upload Emulator Diagnostics") | .if' "$ACTION")" = "always() && (steps.emulator-attempt-1.outcome == 'failure' || steps.avd-create.outcome == 'failure')" ]
  [ "$(yq -r '.runs.steps[] | select(.name == "Upload Emulator Diagnostics") | .with.path' "$ACTION")" = "android-emulator-diagnostics/" ]
}
