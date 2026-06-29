#!/usr/bin/env bats
#
# Tests for the Android SDK platform helpers in scripts/install.sh
# (issue #2680 — install.sh should detect a missing platforms/android-<compileSdk>).
#
# Helpers are pure (no gum / network) and are loaded by sourcing install.sh
# with INSTALL_SH_SOURCE_ONLY=true, which suppresses the main() invocation.

SCRIPT="scripts/install.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  ANDROID_HOME_DIR="${TEST_ROOT}/sdk"
  TOML="${TEST_ROOT}/libs.versions.toml"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

# Run a helper from install.sh in an isolated subshell so the script's
# `set -euo pipefail` cannot affect the BATS process.
run_helper() {
  run bash -c "INSTALL_SH_SOURCE_ONLY=true source '${BATS_TEST_DIRNAME}/../../${SCRIPT}' && $*"
}

write_toml() {
  cat > "$TOML"
}

# ---------------------------------------------------------------------------
# read_required_compile_sdk
# ---------------------------------------------------------------------------

@test "read_required_compile_sdk extracts version from libs.versions.toml" {
  write_toml <<'TOML'
[versions]
build-android-buildTools = "36.0.0"
build-android-compileSdk = "37"
TOML

  run_helper "read_required_compile_sdk '${TOML}'"

  [ "$status" -eq 0 ]
  [ "$output" = "37" ]
}

@test "read_required_compile_sdk tolerates extra whitespace and trailing comment" {
  write_toml <<'TOML'
build-android-compileSdk   =   "41"    # Used in playground Android modules
TOML

  run_helper "read_required_compile_sdk '${TOML}'"

  [ "$status" -eq 0 ]
  [ "$output" = "41" ]
}

@test "read_required_compile_sdk fails when the key is absent" {
  write_toml <<'TOML'
[versions]
build-android-buildTools = "36.0.0"
TOML

  run_helper "read_required_compile_sdk '${TOML}'"

  [ "$status" -ne 0 ]
}

@test "read_required_compile_sdk fails when the file does not exist" {
  run_helper "read_required_compile_sdk '${TEST_ROOT}/nope.toml'"

  [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# android_platform_installed
# ---------------------------------------------------------------------------

@test "android_platform_installed succeeds when android.jar is present" {
  mkdir -p "${ANDROID_HOME_DIR}/platforms/android-37"
  touch "${ANDROID_HOME_DIR}/platforms/android-37/android.jar"

  run_helper "android_platform_installed '${ANDROID_HOME_DIR}' 37"

  [ "$status" -eq 0 ]
}

@test "android_platform_installed fails when the platform dir exists but android.jar is missing" {
  mkdir -p "${ANDROID_HOME_DIR}/platforms/android-37"

  run_helper "android_platform_installed '${ANDROID_HOME_DIR}' 37"

  [ "$status" -ne 0 ]
}

@test "android_platform_installed fails when the platform is entirely absent" {
  mkdir -p "${ANDROID_HOME_DIR}/platforms/android-35"
  touch "${ANDROID_HOME_DIR}/platforms/android-35/android.jar"

  run_helper "android_platform_installed '${ANDROID_HOME_DIR}' 37"

  [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# find_sdkmanager
# ---------------------------------------------------------------------------

@test "find_sdkmanager locates cmdline-tools/latest/bin/sdkmanager" {
  local bin="${ANDROID_HOME_DIR}/cmdline-tools/latest/bin"
  mkdir -p "$bin"
  touch "${bin}/sdkmanager"
  chmod +x "${bin}/sdkmanager"

  run_helper "find_sdkmanager '${ANDROID_HOME_DIR}'"

  [ "$status" -eq 0 ]
  [ "$output" = "${bin}/sdkmanager" ]
}

@test "find_sdkmanager falls back to a versioned cmdline-tools dir" {
  local bin="${ANDROID_HOME_DIR}/cmdline-tools/13.0/bin"
  mkdir -p "$bin"
  touch "${bin}/sdkmanager"
  chmod +x "${bin}/sdkmanager"

  run_helper "find_sdkmanager '${ANDROID_HOME_DIR}'"

  [ "$status" -eq 0 ]
  [ "$output" = "${bin}/sdkmanager" ]
}

@test "find_sdkmanager falls back to legacy tools/bin/sdkmanager" {
  local bin="${ANDROID_HOME_DIR}/tools/bin"
  mkdir -p "$bin"
  touch "${bin}/sdkmanager"
  chmod +x "${bin}/sdkmanager"

  run_helper "find_sdkmanager '${ANDROID_HOME_DIR}'"

  [ "$status" -eq 0 ]
  [ "$output" = "${bin}/sdkmanager" ]
}

@test "find_sdkmanager prefers cmdline-tools/latest over legacy tools/bin" {
  local latest="${ANDROID_HOME_DIR}/cmdline-tools/latest/bin"
  local legacy="${ANDROID_HOME_DIR}/tools/bin"
  mkdir -p "$latest" "$legacy"
  touch "${latest}/sdkmanager" "${legacy}/sdkmanager"
  chmod +x "${latest}/sdkmanager" "${legacy}/sdkmanager"

  run_helper "find_sdkmanager '${ANDROID_HOME_DIR}'"

  [ "$status" -eq 0 ]
  [ "$output" = "${latest}/sdkmanager" ]
}

@test "find_sdkmanager fails when no sdkmanager exists" {
  mkdir -p "${ANDROID_HOME_DIR}/platform-tools"

  run_helper "find_sdkmanager '${ANDROID_HOME_DIR}'"

  [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# android_platform_install_advice (the composed installer decision — this is
# the behavior the issue is about: adb present but platform missing).
# ---------------------------------------------------------------------------

@test "advice returns ok (0) when the required platform is installed" {
  write_toml <<'TOML'
build-android-compileSdk = "37"
TOML
  mkdir -p "${ANDROID_HOME_DIR}/platforms/android-37"
  touch "${ANDROID_HOME_DIR}/platforms/android-37/android.jar"

  run_helper "android_platform_install_advice '${ANDROID_HOME_DIR}' '${TOML}'"

  [ "$status" -eq 0 ]
}

@test "advice flags missing platform (2) with an actionable sdkmanager command" {
  write_toml <<'TOML'
build-android-compileSdk = "37"
TOML
  # adb is present but the android-37 platform is not — the issue's scenario.
  mkdir -p "${ANDROID_HOME_DIR}/platform-tools"
  local bin="${ANDROID_HOME_DIR}/cmdline-tools/latest/bin"
  mkdir -p "$bin"
  touch "${bin}/sdkmanager"
  chmod +x "${bin}/sdkmanager"

  run_helper "android_platform_install_advice '${ANDROID_HOME_DIR}' '${TOML}'"

  [ "$status" -eq 2 ]
  [[ "$output" == *"platforms;android-37"* ]]
  [[ "$output" == *"${bin}/sdkmanager"* ]]
}

@test "advice tracks the compileSdk version from the toml (no hardcoded 37)" {
  write_toml <<'TOML'
build-android-compileSdk = "41"
TOML
  mkdir -p "${ANDROID_HOME_DIR}/platform-tools"

  run_helper "android_platform_install_advice '${ANDROID_HOME_DIR}' '${TOML}'"

  [ "$status" -eq 2 ]
  [[ "$output" == *"platforms;android-41"* ]]
  # Falls back to a bare `sdkmanager` command when none is installed yet.
  [[ "$output" == *'sdkmanager "platforms;android-41"'* ]]
}

@test "advice returns 1 (skip) when compileSdk cannot be determined" {
  write_toml <<'TOML'
[versions]
build-android-buildTools = "36.0.0"
TOML

  run_helper "android_platform_install_advice '${ANDROID_HOME_DIR}' '${TOML}'"

  [ "$status" -eq 1 ]
}
