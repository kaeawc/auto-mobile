#!/usr/bin/env bats
# scripts/ci/tv-smoke/run-tv-smoke.sh: validation, image installation, AVD creation, fixture build,
# and diagnostics. All external tools are stubs; no SDK, Gradle or emulator is needed.

setup() {
  REAL_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/ci/tv-smoke/run-tv-smoke.sh"
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  ROOT="$BATS_TEST_TMPDIR/root"
  mkdir -p "$ROOT/scripts/ci/tv-smoke" "$ROOT/scripts/ci/emulator-smoke" "$ROOT/scripts/ios" "$ROOT/android"
  cp "$REAL_SCRIPT" "$ROOT/scripts/ci/tv-smoke/run-tv-smoke.sh"
  cp "$REPO_ROOT/scripts/ci/emulator-smoke/install-system-image.sh" "$ROOT/scripts/ci/emulator-smoke/"
  cp "$REPO_ROOT/scripts/ios/run_with_timeout.sh" "$ROOT/scripts/ios/"
  SCRIPT="$ROOT/scripts/ci/tv-smoke/run-tv-smoke.sh"

  OUT="$BATS_TEST_TMPDIR/out"
  FAKE_BIN="$BATS_TEST_TMPDIR/bin"
  SDK="$BATS_TEST_TMPDIR/sdk"
  mkdir -p "$FAKE_BIN" "$SDK/cmdline-tools/latest/bin"
  export DIAG_LOG="$BATS_TEST_TMPDIR/diagnostics.log"
  export BUN_LOG="$BATS_TEST_TMPDIR/bun.log"
  export OS_LOG="$BATS_TEST_TMPDIR/os-version.log"
  export SDK_LOG="$BATS_TEST_TMPDIR/sdkmanager.log"
  export AVD_LOG="$BATS_TEST_TMPDIR/avdmanager.log"
  export GRADLE_LOG="$BATS_TEST_TMPDIR/gradle.log"

  cat > "$BATS_TEST_TMPDIR/diagnostics.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s|%s\n' "$1" "$2" >> "$DIAG_LOG"
STUB
  cat > "$FAKE_BIN/bun" <<'STUB'
#!/usr/bin/env bash
printf '%s avd=%s apk=%s\n' "${1##*/}" "${TV_SMOKE_AVD_NAME:-}" "${TV_SMOKE_FIXTURE_APK:-}" >> "$BUN_LOG"
printf '%s\n' "${TV_SMOKE_OS_VERSION:-}" > "$OS_LOG"
if [[ -n "${FAKE_SMOKE_SUMMARY:-}" ]]; then : > "$TV_SMOKE_OUT_DIR/summary.md"; fi
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
  export TV_SMOKE_OUT_DIR="$OUT"
  export TV_SMOKE_DIAGNOSTICS_SCRIPT="$BATS_TEST_TMPDIR/diagnostics.sh"
  export GITHUB_STEP_SUMMARY="$BATS_TEST_TMPDIR/step-summary.md"
  unset TV_SMOKE_SYSTEM_IMAGE TV_SMOKE_CREATE_VIA TV_SMOKE_FIXTURE_APK \
    TV_SMOKE_FIXTURE_MODULE TV_SMOKE_SKIP_IMAGE_INSTALL TV_SMOKE_AVD_NAME TV_SMOKE_OS_VERSION ANDROID_SDK_ROOT
  make_fixture_module
}

make_fixture_module() {
  mkdir -p "$ROOT/android/tv-fixture"
  cat > "$ROOT/android/gradlew" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GRADLE_LOG"
if [[ "${FAKE_BUILD_STATUS:-0}" -ne 0 ]]; then exit "$FAKE_BUILD_STATUS"; fi
mkdir -p tv-fixture/build/outputs/apk/debug
: > tv-fixture/build/outputs/apk/debug/tv-fixture-debug.apk
STUB
  chmod +x "$ROOT/android/gradlew"
}

@test "a non-TV image is rejected before installation" {
  TV_SMOKE_SYSTEM_IMAGE="system-images;android-36;google_apis;x86_64" run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"must be an android-tv or google-tv system image"* ]]
  [ ! -e "$SDK_LOG" ]
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"**Failed** during setup"* ]]
}

@test "the OS version is derived from the image API level" {
  TV_SMOKE_SYSTEM_IMAGE="system-images;android-35;android-tv;x86_64" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(<"$OS_LOG")" = "15" ]
}

@test "an OS version that does not match the image is rejected before installation" {
  TV_SMOKE_OS_VERSION=16 TV_SMOKE_SYSTEM_IMAGE="system-images;android-35;android-tv;x86_64" \
    run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"is API 35 (Android 15) but TV_SMOKE_OS_VERSION=16"* ]]
  [ ! -e "$SDK_LOG" ]
}

@test "a Google TV ARM image is accepted and installed by default for custom inputs" {
  TV_SMOKE_SYSTEM_IMAGE="system-images;android-36;google-tv;arm64-v8a" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -qx -- "--install system-images;android-36;google-tv;arm64-v8a" "$SDK_LOG"
}

@test "default installs the Android TV image and leaves AVD creation to startDevice" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -qx -- "--install system-images;android-36;android-tv;x86_64" "$SDK_LOG"
  [ ! -e "$AVD_LOG" ]
  grep -qx "tvSmoke.ts avd= apk=$ROOT/android/tv-fixture/build/outputs/apk/debug/tv-fixture-debug.apk" "$BUN_LOG"
  grep -q ":tv-fixture:assembleDebug" "$GRADLE_LOG"
  [ "$(wc -l < "$DIAG_LOG")" -eq 1 ]
}

@test "avdmanager creates the named TV profile and passes the AVD name to the smoke" {
  TV_SMOKE_CREATE_VIA=avdmanager run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -q -- "--name automobile-tv-smoke --package system-images;android-36;android-tv;x86_64 --device tv_1080p" "$AVD_LOG"
  grep -qx "tvSmoke.ts avd=automobile-tv-smoke apk=$ROOT/android/tv-fixture/build/outputs/apk/debug/tv-fixture-debug.apk" "$BUN_LOG"
}

@test "a supplied fixture APK skips the build and is passed to the smoke" {
  FIXTURE_APK="$BATS_TEST_TMPDIR/tv.apk"
  : > "$FIXTURE_APK"
  TV_SMOKE_FIXTURE_APK="$FIXTURE_APK" TV_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ ! -e "$GRADLE_LOG" ]
  grep -qx "tvSmoke.ts avd= apk=$FIXTURE_APK" "$BUN_LOG"
}

@test "a missing fixture module fails setup and collects diagnostics" {
  rm -rf "$ROOT/android/tv-fixture"
  rm -f "$ROOT/android/gradlew"
  TV_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"android/tv-fixture does not exist"* ]]
  [ ! -e "$BUN_LOG" ]
  [ "$(wc -l < "$DIAG_LOG")" -eq 1 ]
}

@test "a failed smoke writes a fallback summary and gathers diagnostics" {
  FAKE_SMOKE_STATUS=1 TV_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"TV smoke exited 1 before the smoke wrote its summary"* ]]
  [ "$(wc -l < "$DIAG_LOG")" -eq 1 ]
}

@test "a stalled sdkmanager call is bounded" {
  FAKE_SDK_STALL=--install TV_SMOKE_SDKMANAGER_TIMEOUT_SECONDS=1 run bash "$SCRIPT"
  [ "$status" -eq 124 ]
  [[ "$output" == *"sdkmanager --install timed out after 1s"* ]]
  [ ! -e "$BUN_LOG" ]
}
