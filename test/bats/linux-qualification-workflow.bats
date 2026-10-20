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
  # The pre-extraction commands are pinned verbatim: comparing against HEAD's
  # android-emulator action breaks as soon as that commit already contains the
  # extraction (main red #12755).
  kvm="$BATS_TEST_DIRNAME/../../.github/actions/enable-kvm/action.yml"
  expected="$(printf '%s\n' \
    'echo '\''KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"'\'' | sudo tee /etc/udev/rules.d/99-kvm4all.rules' \
    'sudo udevadm control --reload-rules' \
    'sudo udevadm trigger --name-match=kvm')"
  [ "$(yq -r '.runs.steps[0].run' "$kvm")" = "$expected" ]
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
@test "emulator-cell puts SDK cmdline-tools on PATH before the first sdkmanager use" {
  script="$BATS_TEST_DIRNAME/../../scripts/ci/linux-qualification/emulator-cell.sh"
  path_line=$(grep -n 'export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:' "$script" | head -1 | cut -d: -f1)
  sdk_line=$(grep -n '^timeout .*sdkmanager --licenses' "$script" | head -1 | cut -d: -f1)
  [ -n "$path_line" ] && [ -n "$sdk_line" ] && [ "$path_line" -lt "$sdk_line" ]
  # The private SDK shadow re-points ANDROID_HOME later; PATH must use the real one.
  real_line=$(grep -n 'export REAL_EMULATOR=' "$script" | head -1 | cut -d: -f1)
  [ "$real_line" -lt "$path_line" ]
}
@test "global AutoMobile install uses an absolute path and verifies the bin link" {
  # Run 38897261151: `bun add -g .` installed a nameless "@" package without
  # the auto-mobile bin, so every automobile cell failed before booting.
  action="$BATS_TEST_DIRNAME/../../.github/actions/setup-auto-mobile-npm-package/action.yml"
  yq -r '.runs.steps[] | select(.name=="Globally Install AutoMobile") | .run' "$action" > "$BATS_TEST_TMPDIR/install.sh"
  mkdir -p "$BATS_TEST_TMPDIR/bin" "$BATS_TEST_TMPDIR/global" "$BATS_TEST_TMPDIR/pkg"
  export CALLS="$BATS_TEST_TMPDIR/calls" GLOBAL_BIN="$BATS_TEST_TMPDIR/global"
  printf '#!/usr/bin/env bash\nif [[ "$1 $2" == "pm bin" ]]; then echo "$GLOBAL_BIN"; else printf "%%s\\n" "$*" >> "$CALLS"; fi\n' > "$BATS_TEST_TMPDIR/bin/bun"
  chmod +x "$BATS_TEST_TMPDIR/bin/bun"
  cd "$BATS_TEST_TMPDIR/pkg"
  run env RUNNER_OS=Linux PATH="$BATS_TEST_TMPDIR/bin:$PATH" bash -e "$BATS_TEST_TMPDIR/install.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"auto-mobile bin missing"* ]]
  [ "$(cat "$CALLS")" = "add -g $PWD" ]
  printf '#!/bin/sh\n' > "$GLOBAL_BIN/auto-mobile"; chmod +x "$GLOBAL_BIN/auto-mobile"
  run env RUNNER_OS=Linux PATH="$BATS_TEST_TMPDIR/bin:$PATH" bash -e "$BATS_TEST_TMPDIR/install.sh"
  [ "$status" -eq 0 ]
}
@test "automobile cell without the CLI is a harness error before SDK setup or host exit" {
  repo="$BATS_TEST_DIRNAME/../.."
  fake="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$fake" "$BATS_TEST_TMPDIR/sdk/emulator"
  # Restricted PATH: real auto-mobile installs on the host must not leak in.
  for tool in bash jq git date mktemp dirname cat mkdir touch cp rm uname printf env; do
    real=$(command -v "$tool") && [ -x "$real" ] && ln -sf "$real" "$fake/$tool"
  done
  export CALLS="$BATS_TEST_TMPDIR/calls"
  for cmd in sdkmanager avdmanager sudo lscpu free lspci; do
    printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" "${0##*/}" "$*" >> "$CALLS"\n' > "$fake/$cmd"
    chmod +x "$fake/$cmd"
  done
  printf '#!/usr/bin/env bash\necho "Android emulator version test"\n' > "$BATS_TEST_TMPDIR/sdk/emulator/emulator"
  # Never chmod "$fake"/*: most entries are symlinks to root-owned system tools,
  # and chmod follows them ("Operation not permitted" on Linux runners).
  chmod +x "$BATS_TEST_TMPDIR/sdk/emulator/emulator"
  touch "$BATS_TEST_TMPDIR/kvm"
  cell="$BATS_TEST_TMPDIR/cell"
  # host proves the preflight runs before the no-/dev/dri unexercised exit.
  for gpu in host swangle; do
    rm -rf "$cell"; : > "$CALLS"
    cd "$repo"
    run env PATH="$fake" RUNNER_TEMP="$BATS_TEST_TMPDIR" CELL_DIR="$cell" GPU="$gpu" \
      GPU_ARGS="[\"-gpu\",\"$gpu\"]" WORKLOAD=automobile CELL_STARTED_AT=1 CELL_BUDGET_SECONDS=999999999 \
      ANDROID_HOME="$BATS_TEST_TMPDIR/sdk" KVM_DEVICE="$BATS_TEST_TMPDIR/kvm" \
      bash scripts/ci/linux-qualification/emulator-cell.sh --budgeted
    [ "$status" -eq 1 ]
    [ "$(jq -r .outcome "$cell/result.json")" = harness-error ]
    grep -qF 'auto-mobile CLI not found on PATH' "$cell/harness-error.txt"
    ! grep -qE '^(sdkmanager|avdmanager)' "$CALLS"
  done
}
