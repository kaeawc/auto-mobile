#!/usr/bin/env bats
# scripts/ci/wear-smoke/run-wear-smoke.sh: settings checks, image install and AVD creation, the
# optional fixture build, and diagnostics plus a step-summary line when setup fails (#16829).
# sdkmanager, avdmanager, bun, gradlew and the diagnostics collector are stubs, so no SDK,
# Gradle or emulator is needed.

setup() {
  REAL_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/ci/wear-smoke/run-wear-smoke.sh"
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  # A throwaway project root, so the fixture-module checks see only what each test creates.
  ROOT="$BATS_TEST_TMPDIR/root"
  mkdir -p "$ROOT/scripts/ci/wear-smoke" "$ROOT/scripts/ci/emulator-smoke" "$ROOT/scripts/ios" "$ROOT/android"
  cp "$REAL_SCRIPT" "$ROOT/scripts/ci/wear-smoke/run-wear-smoke.sh"
  cp "$REPO_ROOT/scripts/ci/emulator-smoke/install-system-image.sh" "$ROOT/scripts/ci/emulator-smoke/"
  cp "$REPO_ROOT/scripts/ios/run_with_timeout.sh" "$ROOT/scripts/ios/"
  SCRIPT="$ROOT/scripts/ci/wear-smoke/run-wear-smoke.sh"

  OUT="$BATS_TEST_TMPDIR/out"
  FAKE_BIN="$BATS_TEST_TMPDIR/bin"
  SDK="$BATS_TEST_TMPDIR/sdk"
  mkdir -p "$FAKE_BIN" "$SDK/cmdline-tools/latest/bin"
  export DIAG_LOG="$BATS_TEST_TMPDIR/diagnostics.log"
  export BUN_LOG="$BATS_TEST_TMPDIR/bun.log"
  export SDK_LOG="$BATS_TEST_TMPDIR/sdkmanager.log"
  export AVD_LOG="$BATS_TEST_TMPDIR/avdmanager.log"
  export GRADLE_LOG="$BATS_TEST_TMPDIR/gradle.log"

  cat > "$BATS_TEST_TMPDIR/diagnostics.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s|%s\n' "$1" "$2" >> "$DIAG_LOG"
STUB
  cat > "$FAKE_BIN/bun" <<'STUB'
#!/usr/bin/env bash
printf '%s avd=%s apk=%s\n' "${1##*/}" "${WEAR_SMOKE_AVD_NAME:-}" "${WEAR_SMOKE_FIXTURE_APK:-}" >> "$BUN_LOG"
if [[ -n "${FAKE_SMOKE_SUMMARY:-}" ]]; then : > "$WEAR_SMOKE_OUT_DIR/summary.md"; fi
exit "${FAKE_SMOKE_STATUS:-0}"
STUB
  cat > "$SDK/cmdline-tools/latest/bin/sdkmanager" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SDK_LOG"
if [[ "$1" == "${FAKE_SDK_STALL:-none}" ]]; then exec sleep 30; fi
if [[ "$1" == --install ]]; then exit "${FAKE_INSTALL_STATUS:-0}"; fi
head -n 1 > /dev/null
STUB
  cat > "$SDK/cmdline-tools/latest/bin/avdmanager" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$AVD_LOG"
exit "${FAKE_AVD_STATUS:-0}"
STUB
  chmod +x "$BATS_TEST_TMPDIR/diagnostics.sh" "$FAKE_BIN/bun" \
    "$SDK/cmdline-tools/latest/bin/sdkmanager" "$SDK/cmdline-tools/latest/bin/avdmanager"

  export PATH="$FAKE_BIN:$PATH"
  export ANDROID_HOME="$SDK"
  export WEAR_SMOKE_OUT_DIR="$OUT"
  export WEAR_SMOKE_DIAGNOSTICS_SCRIPT="$BATS_TEST_TMPDIR/diagnostics.sh"
  export GITHUB_STEP_SUMMARY="$BATS_TEST_TMPDIR/step-summary.md"
  unset WEAR_SMOKE_SYSTEM_IMAGE WEAR_SMOKE_CREATE_VIA WEAR_SMOKE_FIXTURE_APK \
    WEAR_SMOKE_FIXTURE_MODULE WEAR_SMOKE_SKIP_IMAGE_INSTALL WEAR_SMOKE_AVD_NAME ANDROID_SDK_ROOT
}

# A stub gradlew that "builds" the fixture APK (or fails with FAKE_BUILD_STATUS).
make_fixture_module() {
  mkdir -p "$ROOT/android/wear-fixture"
  cat > "$ROOT/android/gradlew" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GRADLE_LOG"
if [[ "${FAKE_BUILD_STATUS:-0}" -ne 0 ]]; then exit "$FAKE_BUILD_STATUS"; fi
mkdir -p wear-fixture/build/outputs/apk/debug
: > wear-fixture/build/outputs/apk/debug/wear-fixture-debug.apk
STUB
  chmod +x "$ROOT/android/gradlew"
}

@test "a non-Wear image is rejected before install" {
  WEAR_SMOKE_SYSTEM_IMAGE="system-images;android-36;google_apis;x86_64" run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"must be an android-wear system image"* ]]
  [ ! -e "$SDK_LOG" ]
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"**Failed** during setup"* ]]
}

@test "an unknown creation mode is rejected" {
  WEAR_SMOKE_CREATE_VIA=gradle run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"WEAR_SMOKE_CREATE_VIA must be avdmanager or startDevice"* ]]
}

@test "without the fixture module the default run installs, creates a round AVD and warns" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -qx -- "--install system-images;android-37.0;android-wear-signed;x86_64" "$SDK_LOG"
  grep -q -- "--name automobile-wear-smoke --package system-images;android-37.0;android-wear-signed;x86_64 --device wearos_small_round" "$AVD_LOG"
  [[ "$output" == *"::warning title=Wear smoke::android/wear-fixture does not exist yet"* ]]
  grep -qx "wearSmoke.ts avd=automobile-wear-smoke apk=" "$BUN_LOG"
  [ "$(wc -l < "$DIAG_LOG")" -eq 1 ]
  [ ! -e "$GITHUB_STEP_SUMMARY" ]
}

@test "startDevice creation skips avdmanager and passes no AVD name" {
  WEAR_SMOKE_CREATE_VIA=startDevice run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ ! -e "$AVD_LOG" ]
  grep -qx "wearSmoke.ts avd= apk=" "$BUN_LOG"
}

@test "a fixture module is built and its APK handed to the smoke" {
  make_fixture_module
  WEAR_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -q ":wear-fixture:assembleDebug" "$GRADLE_LOG"
  grep -qx "wearSmoke.ts avd=automobile-wear-smoke apk=$ROOT/android/wear-fixture/build/outputs/apk/debug/wear-fixture-debug.apk" "$BUN_LOG"
  [[ "$output" != *"::warning"* ]]
}

@test "a failed fixture build fails setup with diagnostics and never runs the smoke" {
  make_fixture_module
  FAKE_BUILD_STATUS=5 WEAR_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 5 ]
  grep -q "setup failed while building the wear-fixture fixture (exit 5)" "$DIAG_LOG"
  [ ! -e "$BUN_LOG" ]
}

@test "a missing prebuilt APK is rejected" {
  WEAR_SMOKE_FIXTURE_APK="$BATS_TEST_TMPDIR/nope.apk" WEAR_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"WEAR_SMOKE_FIXTURE_APK does not exist"* ]]
}

@test "a failed AVD creation collects diagnostics and writes a summary line" {
  FAKE_AVD_STATUS=3 run bash "$SCRIPT"
  [ "$status" -eq 3 ]
  grep -q "setup failed while creating the automobile-wear-smoke AVD (exit 3)" "$DIAG_LOG"
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"creating the automobile-wear-smoke AVD"* ]]
}

@test "a stalled sdkmanager --install is bounded and reports the timeout" {
  FAKE_SDK_STALL=--install WEAR_SMOKE_SDKMANAGER_TIMEOUT_SECONDS=1 run bash "$SCRIPT"
  [ "$status" -eq 124 ]
  [[ "$output" == *"::error title=Wear smoke::sdkmanager --install timed out after 1s"* ]]
  [ ! -e "$BUN_LOG" ]
}

@test "a smoke that dies before its summary gets one diagnostics run and a summary line" {
  FAKE_SMOKE_STATUS=1 WEAR_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [ "$(wc -l < "$DIAG_LOG")" -eq 1 ]
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"Wear smoke exited 1 before the smoke wrote its summary"* ]]
}

@test "a smoke that wrote its own summary gets no extra summary line" {
  FAKE_SMOKE_SUMMARY=1 FAKE_SMOKE_STATUS=1 WEAR_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [ ! -e "$GITHUB_STEP_SUMMARY" ]
}
