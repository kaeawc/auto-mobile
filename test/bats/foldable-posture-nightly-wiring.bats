#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/android/prepare-foldable-emulator.sh"
  NIGHTLY="$REPO_ROOT/.github/workflows/nightly.yml"
  export GITHUB_WORKSPACE="$BATS_TEST_TMPDIR/workspace"
  export FOLDABLE_SDK_ROOT="$BATS_TEST_TMPDIR/sdk"
  export FAKE_CALLS="$BATS_TEST_TMPDIR/calls"
  export FAKE_UPDATED="$BATS_TEST_TMPDIR/updated"
  export FAKE_BEFORE_DEVICES="$BATS_TEST_TMPDIR/devices-before"
  export FAKE_AFTER_DEVICES="$BATS_TEST_TMPDIR/devices-after"
  export FAKE_INSTALL_EXIT=0 FAKE_LICENSE_EXIT=0 FAKE_LIST_EXIT=0
  export FAKE_LDD_MISSING=1
  mkdir -p "$GITHUB_WORKSPACE" "$FOLDABLE_SDK_ROOT/cmdline-tools/latest/bin" \
    "$FOLDABLE_SDK_ROOT/emulator/qemu/linux-x86_64" \
    "$FOLDABLE_SDK_ROOT/emulator/lib64/qt/plugins/platforms" "$BATS_TEST_TMPDIR/bin"
  : > "$FAKE_CALLS"
  # Compact -c output derived exclusively from the real cmdline-tools capture.
  sed -n 's/^id: [0-9]* or "\([^"]*\)"$/\1/p' \
    "$REPO_ROOT/test/fixtures/android-avdmanager/list-device.txt" > "$FAKE_AFTER_DEVICES"
  grep -Fxv pixel_10_pro_fold "$FAKE_AFTER_DEVICES" > "$FAKE_BEFORE_DEVICES"
  printf 'Pkg.Revision=22.0\n' > "$FOLDABLE_SDK_ROOT/cmdline-tools/latest/source.properties"
  cat > "$BATS_TEST_TMPDIR/bin/sdkmanager" <<'FAKE'
#!/usr/bin/env bash
printf 'sdkmanager %s\n' "$*" | tee -a "$FAKE_CALLS"
case "$1" in
  --version) cat "$FOLDABLE_SDK_ROOT/cmdline-tools/latest/source.properties" ;;
  --licenses) read -r reply; exit "$FAKE_LICENSE_EXIT" ;;
  --install)
    if [[ "$FAKE_INSTALL_EXIT" -ne 0 ]]; then exit "$FAKE_INSTALL_EXIT"; fi
    touch "$FAKE_UPDATED"
    printf 'Pkg.Revision=23.0\n' > "$FOLDABLE_SDK_ROOT/cmdline-tools/latest/source.properties"
    ;;
esac
FAKE
  cat > "$BATS_TEST_TMPDIR/bin/avdmanager" <<'FAKE'
#!/usr/bin/env bash
printf 'avdmanager %s\n' "$*" >> "$FAKE_CALLS"
[[ "$*" == 'list device -c' ]] || exit 99
if [[ -f "$FAKE_UPDATED" ]]; then
  exit_status="$FAKE_LIST_EXIT"
  cat "$FAKE_AFTER_DEVICES"
  exit "$exit_status"
fi
cat "$FAKE_BEFORE_DEVICES"
FAKE
  cat > "$FOLDABLE_SDK_ROOT/emulator/emulator" <<'FAKE'
#!/usr/bin/env bash
printf 'emulator %s\n' "$*" >> "$FAKE_CALLS"
echo 'Android emulator version 37.1.11.0'
FAKE
  cat > "$BATS_TEST_TMPDIR/bin/sudo" <<'FAKE'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "$FAKE_CALLS"
exec "$@"
FAKE
  cat > "$BATS_TEST_TMPDIR/bin/apt-get" <<'FAKE'
#!/usr/bin/env bash
printf 'apt-get %s\n' "$*" | tee -a "$FAKE_CALLS"
FAKE
  cat > "$BATS_TEST_TMPDIR/bin/ldd" <<'FAKE'
#!/usr/bin/env bash
printf 'ldd %s\n' "$*" >> "$FAKE_CALLS"
if [[ "$FAKE_LDD_MISSING" == 1 ]]; then
  echo 'libpulse.so.0 => not found'
else
  echo 'libpulse.so.0 => /lib/libpulse.so.0 (0x123)'
fi
FAKE
  chmod +x "$BATS_TEST_TMPDIR/bin/"* "$FOLDABLE_SDK_ROOT/emulator/emulator"
  export FOLDABLE_SDKMANAGER="$BATS_TEST_TMPDIR/bin/sdkmanager"
  export FOLDABLE_AVDMANAGER="$BATS_TEST_TMPDIR/bin/avdmanager"
  export FOLDABLE_SUDO="$BATS_TEST_TMPDIR/bin/sudo"
  export FOLDABLE_APT_GET="$BATS_TEST_TMPDIR/bin/apt-get"
  export FOLDABLE_LDD="$BATS_TEST_TMPDIR/bin/ldd"
  SUMMARY="$GITHUB_WORKSPACE/scratch/foldable-lane/sdk-diagnostics.txt"
}

wiring_requires_yq() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo "yq is required in CI to verify foldable nightly wiring" >&2
    return 1
  fi
  skip "yq not installed"
}

@test "prepare prints versions and device diagnostics before updating cmdline-tools" {
  run bash "$SCRIPT" pixel_10_pro_fold
  [ "$status" -eq 0 ]
  [[ "$output" == *'cmdline-tools revision: 22.0'* ]]
  [[ "$output" == *'Android emulator version 37.1.11.0'* ]]
  [[ "$output" == *'cmdline-tools revision: 23.0'* ]]
  [[ "$output" == *'sdkmanager --install cmdline-tools;latest'* ]]
  [ "$(head -n 5 "$FAKE_CALLS")" = $'sdkmanager --version\nemulator -version\navdmanager list device -c\nsdkmanager --licenses\nsdkmanager --install cmdline-tools;latest' ]
  [ "$(tail -n 2 "$FAKE_CALLS")" = $'sdkmanager --version\navdmanager list device -c' ]
  ! grep -q 'apt-get' "$FAKE_CALLS"
  grep -Fxq 'requested_profile=pixel_10_pro_fold' "$SUMMARY"
  grep -Fxq 'cmdline_tools_revision_before=22.0' "$SUMMARY"
  grep -Fxq 'cmdline_tools_revision_after=23.0' "$SUMMARY"
  grep -Fxq 'profile_found=true' "$SUMMARY"
  grep -Fq 'Android emulator version 37.1.11.0' "$SUMMARY"
  # The summary preserves the entire updated compact listing.
  sed -n '/^avdmanager_devices_after_begin$/,/^avdmanager_devices_after_end$/p' "$SUMMARY" | sed '1d;$d' > "$BATS_TEST_TMPDIR/recorded"
  cmp "$FAKE_AFTER_DEVICES" "$BATS_TEST_TMPDIR/recorded"
}

@test "prepare fails early with every available fold profile and never substitutes one" {
  cp "$FAKE_BEFORE_DEVICES" "$FAKE_AFTER_DEVICES"
  run bash "$SCRIPT" pixel_10_pro_fold
  [ "$status" -ne 0 ]
  [[ "$output" == *"requested AVD profile 'pixel_10_pro_fold' is unavailable"* ]]
  [[ "$output" == *'no fallback is permitted'* ]]
  while IFS= read -r available; do
    [[ "$output" == *"$available"* ]]
  done < <(grep -i fold "$FAKE_AFTER_DEVICES")
  ! grep -q 'apt-get\|create avd' "$FAKE_CALLS"
  grep -Fxq 'requested_profile=pixel_10_pro_fold' "$SUMMARY"
  grep -Fxq 'profile_found=false' "$SUMMARY"
}

@test "resizable installs windowed audio and Qt libraries through the injected apt command" {
  run bash "$SCRIPT" resizable
  [ "$status" -eq 0 ]
  grep -Fxq 'apt-get update' "$FAKE_CALLS"
  grep -Eq '^apt-get install -y --no-install-recommends libpulse0 libasound2t64 ' "$FAKE_CALLS"
  [[ "$output" == *'Installed windowed emulator packages:'* ]]
  grep -Fxq 'requested_profile=resizable' "$SUMMARY"
  grep -Fxq 'profile_found=true' "$SUMMARY"
}

@test "failed SDK update is visible but an already available exact profile can pass" {
  export FAKE_INSTALL_EXIT=7 FAKE_LICENSE_EXIT=8
  cp "$FAKE_AFTER_DEVICES" "$FAKE_BEFORE_DEVICES"
  run bash "$SCRIPT" pixel_10_pro_fold
  [ "$status" -eq 0 ]
  [[ "$output" == *'sdkmanager --licenses failed (exit 8)'* ]]
  [[ "$output" == *'cmdline-tools update failed (exit 7)'* ]]
  grep -Fxq 'update_exit=7' "$SUMMARY"
  grep -Fxq 'cmdline_tools_revision_after=22.0' "$SUMMARY"
}

@test "failed SDK update with a missing profile still fails early" {
  export FAKE_INSTALL_EXIT=7
  run bash "$SCRIPT" pixel_10_pro_fold
  [ "$status" -ne 0 ]
  [[ "$output" == *'cmdline-tools update failed (exit 7)'* ]]
  [[ "$output" == *'no fallback is permitted'* ]]
}

@test "failed updated avdmanager enumeration cannot pass even with a partial profile list" {
  export FAKE_LIST_EXIT=9
  run bash "$SCRIPT" pixel_10_pro_fold
  [ "$status" -ne 0 ]
  grep -Fxq 'avdmanager_list_exit=9' "$SUMMARY"
  grep -Fxq 'profile_found=false' "$SUMMARY"
}

@test "default tools resolve from latest bin and SDK root follows ANDROID_SDK_ROOT" {
  cp "$FOLDABLE_SDKMANAGER" "$FOLDABLE_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
  cp "$FOLDABLE_AVDMANAGER" "$FOLDABLE_SDK_ROOT/cmdline-tools/latest/bin/avdmanager"
  export ANDROID_SDK_ROOT="$FOLDABLE_SDK_ROOT"
  unset FOLDABLE_SDK_ROOT FOLDABLE_SDKMANAGER FOLDABLE_AVDMANAGER ANDROID_HOME ANDROID_SDK_HOME
  # Fakes need the resolved SDK path, without overriding the script's root lookup.
  sed -i.bak 's/\$FOLDABLE_SDK_ROOT/\$ANDROID_SDK_ROOT/g' "$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
  run bash "$SCRIPT" pixel_10_pro_fold
  [ "$status" -eq 0 ]
  grep -Fxq 'profile_found=true' "$SUMMARY"
}

@test "library diagnostic reports missing qemu and Qt libraries and appends without failing" {
  touch "$FOLDABLE_SDK_ROOT/emulator/qemu/linux-x86_64/qemu-system-x86_64" \
    "$FOLDABLE_SDK_ROOT/emulator/lib64/qt/plugins/platforms/libqxcb.so"
  mkdir -p "$(dirname "$SUMMARY")"
  echo 'requested_profile=resizable' > "$SUMMARY"
  run bash "$SCRIPT" --check-emulator-libs
  [ "$status" -eq 0 ]
  [[ "$output" == *'libpulse.so.0 => not found'* ]]
  [ "$(grep -c 'libpulse.so.0 => not found' "$SUMMARY")" -eq 2 ]
  grep -Fxq 'requested_profile=resizable' "$SUMMARY"
  ! grep -q 'sdkmanager\|apt-get' "$FAKE_CALLS"
}

@test "library diagnostic reports resolved libraries and tolerates absent binaries or ldd" {
  touch "$FOLDABLE_SDK_ROOT/emulator/qemu/linux-x86_64/qemu-system-x86_64"
  export FAKE_LDD_MISSING=0
  run bash "$SCRIPT" --check-emulator-libs
  [ "$status" -eq 0 ]
  [[ "$output" == *'all shared libraries resolved'* ]]
  [[ "$output" == *'Not present; shared library check skipped.'* ]]
  export FOLDABLE_LDD="$BATS_TEST_TMPDIR/nonexistent-ldd"
  run bash "$SCRIPT" --check-emulator-libs
  [ "$status" -eq 0 ]
  [[ "$output" == *'ldd failed:'* ]]
}

@test "help and invalid argument counts never touch the SDK" {
  run bash "$SCRIPT" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *'Usage:'* ]]
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  run bash "$SCRIPT" --check-emulator-libs unexpected
  [ "$status" -ne 0 ]
  [ ! -s "$FAKE_CALLS" ]
}

@test "nightly prepares the profile immediately before the emulator after Xvfb" {
  wiring_requires_yq
  local prepare_index emulator_index xvfb_index prepare_run
  prepare_index="$(yq -r '.jobs.foldable-posture-tests.steps | to_entries[] | select(.value.name == "Prepare foldable emulator SDK and libraries") | .key' "$NIGHTLY")"
  emulator_index="$(yq -r '.jobs.foldable-posture-tests.steps | to_entries[] | select(.value.uses == "./.github/actions/android-emulator") | .key' "$NIGHTLY")"
  xvfb_index="$(yq -r '.jobs.foldable-posture-tests.steps | to_entries[] | select(.value.name == "Start display server for Resizable emulator") | .key' "$NIGHTLY")"
  [ "$prepare_index" -eq "$((xvfb_index + 1))" ]
  [ "$emulator_index" -eq "$((prepare_index + 1))" ]
  prepare_run="$(yq -r '.jobs.foldable-posture-tests.steps[] | select(.name == "Prepare foldable emulator SDK and libraries") | .run' "$NIGHTLY")"
  [ "$prepare_run" = 'bash scripts/android/prepare-foldable-emulator.sh "$AUTOMOBILE_FOLDABLE_PROFILE"' ]
  [ "$(yq -r '.jobs.foldable-posture-tests.env.AUTOMOBILE_FOLDABLE_PROFILE' "$NIGHTLY")" = '${{ matrix.profile }}' ]
}

@test "nightly always diagnoses libraries after the emulator and before artifact upload" {
  wiring_requires_yq
  local diagnose_index emulator_index upload_index
  diagnose_index="$(yq -r '.jobs.foldable-posture-tests.steps | to_entries[] | select(.value.name == "Diagnose foldable emulator shared libraries") | .key' "$NIGHTLY")"
  emulator_index="$(yq -r '.jobs.foldable-posture-tests.steps | to_entries[] | select(.value.uses == "./.github/actions/android-emulator") | .key' "$NIGHTLY")"
  upload_index="$(yq -r '.jobs.foldable-posture-tests.steps | to_entries[] | select(.value.name == "Upload foldable diagnostics and screenshots") | .key' "$NIGHTLY")"
  [ "$diagnose_index" -eq "$((emulator_index + 1))" ]
  [ "$upload_index" -eq "$((diagnose_index + 1))" ]
  [ "$(yq -r '.jobs.foldable-posture-tests.steps[] | select(.name == "Diagnose foldable emulator shared libraries") | .if' "$NIGHTLY")" = 'always()' ]
  [ "$(yq -r '.jobs.foldable-posture-tests.steps[] | select(.name == "Diagnose foldable emulator shared libraries") | .continue-on-error' "$NIGHTLY")" = true ]
  [ "$(yq -r '.jobs.foldable-posture-tests.steps[] | select(.name == "Diagnose foldable emulator shared libraries") | .run' "$NIGHTLY")" = 'bash scripts/android/prepare-foldable-emulator.sh --check-emulator-libs' ]
}

@test "nightly foldable lane remains advisory with Resizable windowed" {
  wiring_requires_yq
  [ "$(yq -r '.jobs.foldable-posture-tests.continue-on-error' "$NIGHTLY")" = true ]
  [ "$(yq -r '.jobs.foldable-posture-tests.steps[] | select(.uses == "./.github/actions/android-emulator") | .with.windowed' "$NIGHTLY")" = "\${{ matrix.profile == 'resizable' }}" ]
}
