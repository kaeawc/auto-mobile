#!/usr/bin/env bats
# scripts/ci/aaos-smoke/run-aaos-smoke.sh: settings checks, sdkmanager time limits, and
# diagnostics plus a step-summary line when setup fails (#16777). sdkmanager, bun and the
# diagnostics collector are stubs, so no SDK or emulator is needed.

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/ci/aaos-smoke/run-aaos-smoke.sh"
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
printf '%s %s\n' "${1##*/}" "${AAOS_SMOKE_OS_VERSION:-}" >> "$BUN_LOG"
case "$1" in
  *enableFeatureFlags.ts) exit "${FAKE_FLAGS_STATUS:-0}" ;;
  *aaosSmoke.ts)
    if [[ -n "${FAKE_SMOKE_SUMMARY:-}" ]]; then : > "$AAOS_SMOKE_OUT_DIR/summary.md"; fi
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
  export AAOS_SMOKE_OUT_DIR="$OUT"
  export AAOS_SMOKE_DIAGNOSTICS_SCRIPT="$BATS_TEST_TMPDIR/diagnostics.sh"
  export GITHUB_STEP_SUMMARY="$BATS_TEST_TMPDIR/step-summary.md"
  unset AAOS_SMOKE_OS_VERSION AAOS_SMOKE_SYSTEM_IMAGE AAOS_SMOKE_SKIP_IMAGE_INSTALL ANDROID_SDK_ROOT
}

@test "an image whose API level does not match the pinned OS version is rejected before install" {
  AAOS_SMOKE_SYSTEM_IMAGE="system-images;android-35;android-automotive;x86_64" run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"API 35 but AAOS_SMOKE_OS_VERSION=14 needs API 34"* ]]
  [ ! -e "$SDK_LOG" ]
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"**Failed** during setup"* ]]
}

@test "an overridden OS version and matching image install and reach the smoke" {
  AAOS_SMOKE_OS_VERSION=15 AAOS_SMOKE_SYSTEM_IMAGE="system-images;android-35-ext15;android-automotive;x86_64" \
    run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -qx -- "--install system-images;android-35-ext15;android-automotive;x86_64" "$SDK_LOG"
  grep -qx "aaosSmoke.ts 15" "$BUN_LOG"
  # A passing run still collects diagnostics once, and the trap adds nothing.
  [ "$(wc -l < "$DIAG_LOG")" -eq 1 ]
  [ ! -e "$GITHUB_STEP_SUMMARY" ]
}

@test "an unknown OS version is rejected" {
  AAOS_SMOKE_OS_VERSION=fourteen run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"AAOS_SMOKE_OS_VERSION must be an Android release"* ]]
}

@test "a missing sdkmanager collects diagnostics and writes a summary line" {
  rm "$SDK/cmdline-tools/latest/bin/sdkmanager"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  grep -q "^$OUT/diagnostics|AAOS smoke setup failed while locating sdkmanager (exit 1)$" "$DIAG_LOG"
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"setup failed while locating sdkmanager"* ]]
}

@test "a stalled sdkmanager --install is bounded and reports the timeout" {
  FAKE_SDK_STALL=--install AAOS_SMOKE_SDKMANAGER_TIMEOUT_SECONDS=1 run bash "$SCRIPT"
  [ "$status" -eq 124 ]
  [[ "$output" == *"sdkmanager --install timed out after 1s"* ]]
  [ "$(wc -l < "$DIAG_LOG")" -eq 1 ]
  [ ! -e "$BUN_LOG" ]
}

@test "a stalled sdkmanager --licenses is bounded too" {
  FAKE_SDK_STALL=--licenses AAOS_SMOKE_SDKMANAGER_TIMEOUT_SECONDS=1 run bash "$SCRIPT"
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

@test "a failed feature flag enable collects diagnostics and writes a summary line" {
  FAKE_FLAGS_STATUS=4 AAOS_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 4 ]
  grep -q "setup failed while enabling the device-condition feature flag (exit 4)" "$DIAG_LOG"
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"enabling the device-condition feature flag"* ]]
  ! grep -q aaosSmoke.ts "$BUN_LOG"
}

@test "a stale summary.md from an earlier run does not hide a crash" {
  mkdir -p "$OUT"
  : > "$OUT/summary.md"
  FAKE_SMOKE_STATUS=1 AAOS_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"before the smoke wrote its summary"* ]]
}

@test "a smoke that dies before its summary gets one diagnostics run and a summary line" {
  FAKE_SMOKE_STATUS=1 AAOS_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [ "$(wc -l < "$DIAG_LOG")" -eq 1 ]
  grep -q "|AAOS smoke exited 1$" "$DIAG_LOG"
  [[ "$(<"$GITHUB_STEP_SUMMARY")" == *"AAOS smoke exited 1 before the smoke wrote its summary"* ]]
}

@test "a smoke that wrote its own summary gets no extra summary line" {
  FAKE_SMOKE_SUMMARY=1 FAKE_SMOKE_STATUS=1 AAOS_SMOKE_SKIP_IMAGE_INSTALL=1 run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [ ! -e "$GITHUB_STEP_SUMMARY" ]
}
