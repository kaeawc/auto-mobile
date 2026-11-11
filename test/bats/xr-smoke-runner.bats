#!/usr/bin/env bats
# scripts/ci/xr-smoke/run-xr-smoke.sh: image and settings checks, sdkmanager time limits, and
# diagnostics plus a step-summary line when setup fails (#16845). sdkmanager, bun and the
# diagnostics collector are stubs, so no SDK or emulator is needed.

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/ci/xr-smoke/run-xr-smoke.sh"
  OUT="$BATS_TEST_TMPDIR/out"
  FAKE_BIN="$BATS_TEST_TMPDIR/bin"
  SDK="$BATS_TEST_TMPDIR/sdk"
  mkdir -p "$FAKE_BIN" "$SDK/cmdline-tools/latest/bin"
  export DIAG_LOG="$BATS_TEST_TMPDIR/diagnostics.log"
  export BUN_LOG="$BATS_TEST_TMPDIR/bun.log"
  export SDK_LOG="$BATS_TEST_TMPDIR/sdkmanager.log"

  cat > "$BATS_TEST_TMPDIR/diagnostics.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s|%s\n' "$1" "$2" >> "$DIAG_LOG"
STUB
  cat > "$FAKE_BIN/bun" <<'STUB'
#!/usr/bin/env bash
printf '%s %s apk=%s\n' "${1##*/}" "${XR_SMOKE_OS_VERSION:-}" "${AUTOMOBILE_CTRL_PROXY_APK_PATH:-}" >> "$BUN_LOG"
case "$1" in
  *xrSmoke.ts)
    if [[ -n "${FAKE_SMOKE_SUMMARY:-}" ]]; then : > "$XR_SMOKE_OUT_DIR/summary.md"; fi
    exit "${FAKE_SMOKE_STATUS:-0}"
    ;;
esac
STUB
  cat > "$SDK/cmdline-tools/latest/bin/sdkmanager" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SDK_LOG"
if [[ "$1" == "${FAKE_SDK_STALL:-none}" ]]; then exec sleep 30; fi
if [[ "$1" == --install ]]; then exit "${FAKE_INSTALL_STATUS:-0}"; fi
# Read one answer, as sdkmanager stops reading once the licenses are accepted.
head -n 1 > /dev/null
STUB
  chmod +x "$BATS_TEST_TMPDIR/diagnostics.sh" "$FAKE_BIN/bun" "$SDK/cmdline-tools/latest/bin/sdkmanager"

  export PATH="$FAKE_BIN:$PATH"
  export ANDROID_HOME="$SDK"
  export XR_SMOKE_OUT_DIR="$OUT"
  export XR_SMOKE_DIAGNOSTICS_SCRIPT="$BATS_TEST_TMPDIR/diagnostics.sh"
  export GITHUB_STEP_SUMMARY="$BATS_TEST_TMPDIR/step-summary.md"
  unset XR_SMOKE_OS_VERSION XR_SMOKE_SYSTEM_IMAGE XR_SMOKE_SKIP_IMAGE_INSTALL ANDROID_SDK_ROOT \
    XR_SMOKE_CTRLPROXY_APK XR_SMOKE_GRADLEW
  # A prebuilt debug APK by default, so only the build tests run (a stubbed) Gradle.
  : > "$BATS_TEST_TMPDIR/ctrlproxy.apk"
  export XR_SMOKE_CTRLPROXY_APK="$BATS_TEST_TMPDIR/ctrlproxy.apk"
}

@test "without a prebuilt APK the debug CtrlProxy build runs and its APK is handed to the daemon" {
  unset XR_SMOKE_CTRLPROXY_APK
  mkdir -p "$BATS_TEST_TMPDIR/gw"
  cat > "$BATS_TEST_TMPDIR/gw/gradlew" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GRADLE_LOG"
: > "$XR_SMOKE_BUILT_APK"
STUB
  chmod +x "$BATS_TEST_TMPDIR/gw/gradlew"
  export GRADLE_LOG="$BATS_TEST_TMPDIR/gradle.log"
  export XR_SMOKE_BUILT_APK="$BATS_TEST_TMPDIR/built.apk"
  XR_SMOKE_GRADLEW="$BATS_TEST_TMPDIR/gw/gradlew" XR_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -qx -- "--no-daemon :control-proxy:assembleDebug" "$GRADLE_LOG"
  grep -qx "xrSmoke.ts 14 apk=$BATS_TEST_TMPDIR/built.apk" "$BUN_LOG"
}

@test "a failed CtrlProxy build fails setup with diagnostics and never runs the smoke" {
  unset XR_SMOKE_CTRLPROXY_APK
  mkdir -p "$BATS_TEST_TMPDIR/gw"
  printf '#!/usr/bin/env bash\nexit 7\n' > "$BATS_TEST_TMPDIR/gw/gradlew"
  chmod +x "$BATS_TEST_TMPDIR/gw/gradlew"
  XR_SMOKE_GRADLEW="$BATS_TEST_TMPDIR/gw/gradlew" XR_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 7 ]
  grep -q "setup failed while building the debug CtrlProxy APK (exit 7)" "$DIAG_LOG"
  [ ! -e "$BUN_LOG" ]
}

@test "a missing prebuilt CtrlProxy APK is rejected" {
  XR_SMOKE_CTRLPROXY_APK="$BATS_TEST_TMPDIR/nope.apk" XR_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"CtrlProxy APK does not exist"* ]]
}

@test "an image whose API level does not match the pinned OS version is rejected before install" {
  XR_SMOKE_SYSTEM_IMAGE="system-images;android-35;google-xr;x86_64" run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"API 35 but XR_SMOKE_OS_VERSION=14 needs API 34"* ]]
  [ ! -e "$SDK_LOG" ]
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"**Failed** during setup"* ]]
}

@test "an unsupported image tag is rejected before install" {
  XR_SMOKE_SYSTEM_IMAGE="system-images;android-34;android-automotive;x86_64" run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"must use a supported XR headset image tag"* ]]
  [ ! -e "$SDK_LOG" ]
}

@test "an overridden OS version and matching image install and reach the smoke" {
  XR_SMOKE_OS_VERSION=15 XR_SMOKE_SYSTEM_IMAGE="system-images;android-35-ext15;google-xr;x86_64" \
    run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -qx -- "--install system-images;android-35-ext15;google-xr;x86_64" "$SDK_LOG"
  grep -q "^xrSmoke.ts 15 " "$BUN_LOG"
  # A passing run still collects diagnostics once, and the trap adds nothing.
  [ "$(wc -l < "$DIAG_LOG")" -eq 1 ]
  [ ! -e "$GITHUB_STEP_SUMMARY" ]
}

@test "an unknown OS version is rejected" {
  XR_SMOKE_OS_VERSION=fourteen run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"XR_SMOKE_OS_VERSION must be an Android release"* ]]
}

@test "a missing sdkmanager collects diagnostics and writes a summary line" {
  rm "$SDK/cmdline-tools/latest/bin/sdkmanager"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  grep -q "^$OUT/diagnostics|XR smoke setup failed while locating sdkmanager (exit 1)$" "$DIAG_LOG"
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"setup failed while locating sdkmanager"* ]]
}

@test "a stalled sdkmanager --install is bounded and reports the timeout" {
  FAKE_SDK_STALL=--install XR_SMOKE_SDKMANAGER_TIMEOUT_SECONDS=1 run bash "$SCRIPT"
  [ "$status" -eq 124 ]
  [[ "$output" == *"sdkmanager --install timed out after 1s"* ]]
  [ "$(wc -l < "$DIAG_LOG")" -eq 1 ]
  [ ! -e "$BUN_LOG" ]
}

@test "a stalled sdkmanager --licenses is bounded too" {
  FAKE_SDK_STALL=--licenses XR_SMOKE_SDKMANAGER_TIMEOUT_SECONDS=1 run bash "$SCRIPT"
  [ "$status" -eq 124 ]
  [[ "$output" == *"sdkmanager --licenses timed out after 1s"* ]]
  ! grep -q -- "--install" "$SDK_LOG"
}

@test "a failed install exits with its status and collects diagnostics" {
  FAKE_INSTALL_STATUS=3 run bash "$SCRIPT"
  [ "$status" -eq 3 ]
  [[ "$output" == *"sdkmanager could not install"* ]]
  grep -q "setup failed while installing" "$DIAG_LOG"
}

@test "the smoke receives a private database without feature flag setup" {
  XR_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -q "^xrSmoke.ts 14 " "$BUN_LOG"
  ! grep -q enableFeatureFlags "$BUN_LOG"
}

@test "a stale summary.md from an earlier run does not hide a crash" {
  mkdir -p "$OUT"
  : > "$OUT/summary.md"
  FAKE_SMOKE_STATUS=1 XR_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"before the smoke wrote its summary"* ]]
}

@test "a smoke that dies before its summary gets one diagnostics run and a summary line" {
  FAKE_SMOKE_STATUS=1 XR_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [ "$(wc -l < "$DIAG_LOG")" -eq 1 ]
  grep -q "|XR smoke exited 1$" "$DIAG_LOG"
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"XR smoke exited 1 before the smoke wrote its summary"* ]]
}

@test "a smoke that wrote its own summary gets no extra summary line" {
  FAKE_SMOKE_SUMMARY=1 FAKE_SMOKE_STATUS=1 XR_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [ ! -e "$GITHUB_STEP_SUMMARY" ]
}
