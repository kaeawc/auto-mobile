#!/usr/bin/env bats
setup() {
  workflow="$BATS_TEST_DIRNAME/../../.github/workflows/linux-qualification.yml"
  command -v yq >/dev/null || skip "yq required"
}
@test "manual-only Linux workflow with read-only permissions and independent capture job" {
  [ "$(yq -r '.on | keys | join(",")' "$workflow")" = workflow_dispatch ]
  [ "$(yq -r '.permissions.contents' "$workflow")" = read ]
  [ "$(yq -r '.concurrency."cancel-in-progress"' "$workflow")" = false ]
  [ "$(yq -r '.concurrency.group' "$workflow")" = 'linux-qualification-${{ github.ref }}' ]
  for job in proc-fixtures emulator-sigsegv emulator-sigsegv-summary; do
    [ "$(yq -r ".jobs.\"$job\".\"runs-on\"" "$workflow")" = ubuntu-latest ]
  done
  [ "$(yq -r '.jobs."proc-fixtures".needs // "none"' "$workflow")" = none ]
  [ "$(yq -r '.jobs."emulator-sigsegv".needs // "none"' "$workflow")" = none ]
}
@test "12 independent matrix cells use env args and a 90 minute timeout" {
  [ "$(yq -r '.jobs."emulator-sigsegv".strategy.matrix.gpu | join(",")' "$workflow")" = swangle,swiftshader_indirect,host,angle_indirect ]
  [ "$(yq -r '.jobs."emulator-sigsegv".strategy.matrix.workload | join(",")' "$workflow")" = automobile,raw-adb-control,heartbeat-only ]
  [ "$(yq -r '.jobs."emulator-sigsegv".strategy."fail-fast"' "$workflow")" = false ]
  [ "$(yq -r '.jobs."emulator-sigsegv".strategy."max-parallel" // "none"' "$workflow")" = none ]
  [ "$(yq -r '.jobs."emulator-sigsegv"."timeout-minutes"' "$workflow")" = 90 ]
  [ "$(yq -r '.jobs."emulator-sigsegv".env.GPU_ARGS' "$workflow")" = '${{ matrix.gpu-args }}' ]
  ! yq -r '.jobs[].steps[] | .run // ""' "$workflow" | grep -F '${{'
}
@test "KVM reuse and checked-out package are wired without emulator-runner" {
  grep -qF 'uses: ./.github/actions/enable-kvm' "$workflow"
  grep -qF 'uses: ./.github/actions/enable-kvm' "$BATS_TEST_DIRNAME/../../.github/actions/android-emulator/action.yml"
  grep -qF "if: matrix.workload == 'automobile'" "$workflow"
  grep -qF 'scripts/android/ensure-emulator-sdk.sh' "$workflow"
  ! grep -q reactivecircus "$workflow"
}
@test "third party actions are SHA pinned with major version comments" {
  run awk '/uses:/ && !/uses: \.\// && !/uses: [^@]+@[a-f0-9]{40} # v[0-9]+$/ {print; bad=1} END {exit bad}' "$workflow"
  [ "$status" -eq 0 ]
}
@test "artifact names are unique, matrix interpolated, and summary always runs" {
  [ "$(yq -r '.jobs."emulator-sigsegv-summary".if' "$workflow")" = 'always()' ]
  [ "$(yq -r '.jobs."emulator-sigsegv-summary".needs' "$workflow")" = emulator-sigsegv ]
  grep -qF 'name: emulator-sigsegv-${{ matrix.gpu }}-${{ matrix.workload }}' "$workflow"
  [ "$(yq -r '[.jobs[].steps[] | select((.uses // "") | test("^actions/upload-artifact@")) | .with.name] | unique | length' "$workflow")" = 3 ]
  [ "$(yq -r '[.jobs[].steps[] | select((.uses // "") | test("^actions/upload-artifact@")) | .with."retention-days"] | unique | join(",")' "$workflow")" = 30 ]
}
@test "KVM extraction preserves the old commands and forwards the configured shell" {
  original="$BATS_TEST_TMPDIR/android-action.yml"
  git show HEAD:.github/actions/android-emulator/action.yml > "$original"
  kvm="$BATS_TEST_DIRNAME/../../.github/actions/enable-kvm/action.yml"
  [ "$(yq -r '.runs.steps[] | select(.name=="Enable KVM group perms") | .run' "$original")" = "$(yq -r '.runs.steps[0].run' "$kvm")" ]
  [ "$(yq -r '.inputs.shell.default' "$kvm")" = bash ]
  [ "$(yq -r '.runs.steps[] | select(.name=="Enable KVM group perms") | .with.shell' "$BATS_TEST_DIRNAME/../../.github/actions/android-emulator/action.yml")" = '${{ inputs.shell }}' ]
}
@test "every GPU JSON argv and artifact policy is pinned" {
  [ "$(yq -r '.jobs."emulator-sigsegv".strategy.matrix.include[]."gpu-args"' "$workflow")" = $'["-gpu","swangle","-feature","-Vulkan"]\n["-gpu","swiftshader_indirect"]\n["-gpu","host"]\n["-gpu","angle_indirect"]' ]
  [ "$(yq -r '.jobs."proc-fixtures"."timeout-minutes"' "$workflow")" = 15 ]
  [ "$(yq -r '.jobs."emulator-sigsegv-summary"."timeout-minutes"' "$workflow")" = 10 ]
  [ "$(yq -r '.jobs."proc-fixtures".steps[-1].with."if-no-files-found"' "$workflow")" = error ]
  [ "$(yq -r '.jobs."emulator-sigsegv".steps[-1].if' "$workflow")" = 'always()' ]
  [ "$(yq -r '.jobs."emulator-sigsegv".steps[-1].with."if-no-files-found"' "$workflow")" = warn ]
}
@test "emulator disk cleanup reuses the existing tool removal before SDK installation" {
  yq -r '.jobs."emulator-sigsegv".steps[] | select(.name=="Free disk space for emulator") | .run' "$workflow" > "$BATS_TEST_TMPDIR/cleanup.sh"
  grep -F '/usr/share/dotnet /opt/ghc /usr/local/share/boost' "$BATS_TEST_TMPDIR/cleanup.sh"
  # Execute only fake df/sudo and verify the commands, never remove real tools.
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  for cmd in df sudo; do
    printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" "${0##*/}" "$*" >> "$CALLS"\n' > "$BATS_TEST_TMPDIR/bin/$cmd"
  done
  chmod +x "$BATS_TEST_TMPDIR/bin"/*
  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" bash "$BATS_TEST_TMPDIR/cleanup.sh"
  [ "$status" -eq 0 ]
  [ "$(cat "$CALLS")" = $'df -h\nsudo rm -rf /usr/share/dotnet /opt/ghc /usr/local/share/boost\ndf -h' ]
  yq -o=json '.jobs."emulator-sigsegv".steps' "$workflow" | jq -e '(map(.name // "") | index("Free disk space for emulator")) < (map(.run // "") | index("bash scripts/android/ensure-emulator-sdk.sh"))'
}
@test "emulator runtime libraries (libpulse0) are installed after the SDK and before the cell" {
  yq -o=json '.jobs."emulator-sigsegv".steps' "$workflow" | jq -e '
    (map(.run // "") | index("bash scripts/android/ensure-emulator-sdk.sh")) as $sdk
    | (map(select((.run // "") | contains("libpulse0"))) | length) == 1
    and ((map((.run // "") | contains("libpulse0")) | index(true)) > $sdk)
    and ((map((.run // "") | contains("libpulse0")) | index(true)) < (map(.run // "") | index("bash scripts/ci/linux-qualification/emulator-cell.sh")))'
}
