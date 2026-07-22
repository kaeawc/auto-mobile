#!/usr/bin/env bats

SCRIPT="scripts/android/ensure-emulator-sdk.sh"

setup() {
  SCRIPT_PATH="$(pwd)/$SCRIPT"
  SDK_ROOT="$(mktemp -d)"
  GITHUB_ENV_FILE="$(mktemp)"
  GITHUB_PATH_FILE="$(mktemp)"
}

teardown() {
  rm -rf "$SDK_ROOT"
  rm -f "$GITHUB_ENV_FILE" "$GITHUB_PATH_FILE"
}

make_emulator() {
  mkdir -p "${SDK_ROOT}/emulator"
  printf '#!/usr/bin/env bash\n' > "${SDK_ROOT}/emulator/emulator"
  chmod +x "${SDK_ROOT}/emulator/emulator"
}

make_sdkmanager() {
  mkdir -p "${SDK_ROOT}/cmdline-tools/latest/bin"
  cat > "${SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager" <<MOCK
#!/usr/bin/env bash
if [[ "\$*" == *"emulator"* ]]; then
  mkdir -p "${SDK_ROOT}/emulator"
  printf '#!/usr/bin/env bash\n' > "${SDK_ROOT}/emulator/emulator"
  chmod +x "${SDK_ROOT}/emulator/emulator"
fi
MOCK
  chmod +x "${SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager"
}

@test "publishes ANDROID_HOME and the emulator directory to later workflow steps" {
  make_emulator

  run env ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT= ANDROID_SDK_HOME= \
    GITHUB_ENV="$GITHUB_ENV_FILE" GITHUB_PATH="$GITHUB_PATH_FILE" \
    bash "$SCRIPT_PATH"

  [ "$status" -eq 0 ]
  [[ "$(<"$GITHUB_ENV_FILE")" == *"ANDROID_HOME=${SDK_ROOT}"* ]]
  [[ "$(<"$GITHUB_ENV_FILE")" == *"ANDROID_SDK_ROOT=${SDK_ROOT}"* ]]
  [[ "$(<"$GITHUB_PATH_FILE")" == *"${SDK_ROOT}/emulator"* ]]
  [[ "$(<"$GITHUB_PATH_FILE")" == *"${SDK_ROOT}/platform-tools"* ]]
}

@test "installs the emulator package when the AVD cache hit skipped the runner action" {
  # This is issue #4237: on an AVD cache hit the third-party emulator-runner
  # step never runs, so the SDK has no emulator/ directory at all.
  make_sdkmanager

  run env ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT= ANDROID_SDK_HOME= \
    GITHUB_ENV="$GITHUB_ENV_FILE" GITHUB_PATH="$GITHUB_PATH_FILE" \
    bash "$SCRIPT_PATH"

  [ "$status" -eq 0 ]
  [ -x "${SDK_ROOT}/emulator/emulator" ]
  [[ "$output" == *"installing via"* ]]
}

@test "names the resolved ANDROID_HOME and PATH when the emulator cannot be resolved" {
  run env ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT= ANDROID_SDK_HOME= \
    GITHUB_ENV="$GITHUB_ENV_FILE" GITHUB_PATH="$GITHUB_PATH_FILE" \
    bash "$SCRIPT_PATH"

  [ "$status" -eq 1 ]
  [[ "$output" == *"resolved ANDROID_HOME=${SDK_ROOT}"* ]]
  [[ "$output" == *"expected emulator binary=${SDK_ROOT}/emulator/emulator"* ]]
  [[ "$output" == *"PATH="* ]]
  [[ "$output" != *"Homebrew"* ]]
}

# Skipping locally is a convenience; skipping in CI would silently retire the
# wiring assertions below, which is the fail-green this guard exists to catch.
wiring_requires_yq() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo "yq is required in CI to verify android-emulator action wiring" >&2
    return 1
  fi
  skip "yq not installed"
}

@test "the android-emulator action resolves the SDK before it boots the emulator (#4237)" {
  wiring_requires_yq
  action=".github/actions/android-emulator/action.yml"

  ensure_index="$(yq -r \
    '[.runs.steps[] | .run // ""] | to_entries | map(select(.value | test("ensure-emulator-sdk.sh"))) | .[0].key' \
    "$action")"
  boot_index="$(yq -r \
    '[.runs.steps[] | .run // ""] | to_entries | map(select(.value | test("boot-emulator.sh"))) | .[0].key' \
    "$action")"

  [ "$ensure_index" != "null" ]
  [ "$boot_index" != "null" ]
  [ "$ensure_index" -lt "$boot_index" ]
}

@test "reports the resolved environment when no SDK root can be found at all" {
  run env -u ANDROID_HOME -u ANDROID_SDK_ROOT -u ANDROID_SDK_HOME -u HOME \
    bash -c 'cd / && exec "$0"' "$SCRIPT_PATH"

  # Either it resolved a real SDK on this machine (status 0) or it failed with a
  # diagnostic that names what it looked at -- never a bare failure.
  if [ "$status" -ne 0 ]; then
    [[ "$output" == *"ANDROID_HOME="* ]]
    [[ "$output" == *"PATH="* ]]
  fi
}

@test "the resolution tripwire fails when the product cannot find the emulator" {
  make_emulator
  fake_bin="$(mktemp -d)"
  cat > "${fake_bin}/bun" <<'MOCK'
#!/usr/bin/env bash
echo "error: Android emulator not found."
exit 1
MOCK
  chmod +x "${fake_bin}/bun"

  run env ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT= ANDROID_SDK_HOME= \
    PATH="${fake_bin}:${PATH}" \
    bash "$(pwd)/scripts/android/verify-emulator-sdk-resolution.sh"

  rm -rf "$fake_bin"
  [ "$status" -eq 1 ]
  [[ "$output" == *"cannot resolve the Android emulator in CI"* ]]
}

@test "the resolution tripwire passes when the emulator resolves but the AVD is absent" {
  make_emulator
  fake_bin="$(mktemp -d)"
  cat > "${fake_bin}/bun" <<'MOCK'
#!/usr/bin/env bash
echo "error: No android device matching criteria found. name=automobile-sdk-resolution-probe Available images: none."
exit 1
MOCK
  chmod +x "${fake_bin}/bun"

  run env ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT= ANDROID_SDK_HOME= \
    PATH="${fake_bin}:${PATH}" \
    bash "$(pwd)/scripts/android/verify-emulator-sdk-resolution.sh"

  rm -rf "$fake_bin"
  [ "$status" -eq 0 ]
  [[ "$output" == *"resolvable by the product boot flow"* ]]
}

@test "the resolution tripwire never provisions a device even if creation is enabled globally" {
  make_emulator
  fake_bin="$(mktemp -d)"
  seen="$(mktemp)"
  cat > "${fake_bin}/bun" <<MOCK
#!/usr/bin/env bash
printf '%s\n' "\${AUTOMOBILE_ALLOW_DEVICE_CREATE:-<unset>}" > "${seen}"
echo "error: No android device matching criteria found. Available images: none."
exit 1
MOCK
  chmod +x "${fake_bin}/bun"

  run env ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT= ANDROID_SDK_HOME= \
    AUTOMOBILE_ALLOW_DEVICE_CREATE=1 PATH="${fake_bin}:${PATH}" \
    bash "$(pwd)/scripts/android/verify-emulator-sdk-resolution.sh"

  [ "$status" -eq 0 ]
  [ "$(<"$seen")" = "0" ]
  rm -rf "$fake_bin"
  rm -f "$seen"
}

# --- fail-closed tripwire semantics (issue #4260) ------------------------------
#
# The guard used to key only off the absence of "Android emulator not found", so
# any other early failure fell through to the success message and reported a
# green SDK-resolution guard. These pin the closed door.

@test "the resolution tripwire fails when the probe dies for an unexpected reason" {
  make_emulator
  fake_bin="$(mktemp -d)"
  cat > "${fake_bin}/bun" <<'MOCK'
#!/usr/bin/env bash
echo "error: Cannot find module './cli/bootDevice'" >&2
exit 1
MOCK
  chmod +x "${fake_bin}/bun"

  run env ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT= ANDROID_SDK_HOME= \
    PATH="${fake_bin}:${PATH}" \
    bash "$(pwd)/scripts/android/verify-emulator-sdk-resolution.sh"

  rm -rf "$fake_bin"
  [ "$status" -eq 1 ]
  [[ "$output" == *"failed for an unexpected reason"* ]]
  # The actual probe output has to be surfaced, or the failure is unactionable.
  [[ "$output" == *"Cannot find module"* ]]
  [[ "$output" != *"resolvable by the product boot flow"* ]]
}

@test "the resolution tripwire fails when the probe crashes with no output at all" {
  make_emulator
  fake_bin="$(mktemp -d)"
  cat > "${fake_bin}/bun" <<'MOCK'
#!/usr/bin/env bash
exit 137
MOCK
  chmod +x "${fake_bin}/bun"

  run env ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT= ANDROID_SDK_HOME= \
    PATH="${fake_bin}:${PATH}" \
    bash "$(pwd)/scripts/android/verify-emulator-sdk-resolution.sh"

  rm -rf "$fake_bin"
  [ "$status" -eq 1 ]
  [[ "$output" == *"exit 137"* ]]
  [[ "$output" != *"resolvable by the product boot flow"* ]]
}

@test "the resolution tripwire fails when the probe unexpectedly succeeds" {
  make_emulator
  fake_bin="$(mktemp -d)"
  cat > "${fake_bin}/bun" <<'MOCK'
#!/usr/bin/env bash
echo '{"deviceId":"emulator-5554","platform":"android"}'
exit 0
MOCK
  chmod +x "${fake_bin}/bun"

  run env ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT= ANDROID_SDK_HOME= \
    PATH="${fake_bin}:${PATH}" \
    bash "$(pwd)/scripts/android/verify-emulator-sdk-resolution.sh"

  rm -rf "$fake_bin"
  [ "$status" -eq 1 ]
  [[ "$output" == *"unexpectedly succeeded"* ]]
  [[ "$output" != *"resolvable by the product boot flow"* ]]
}

@test "the tripwire's expected diagnostic still matches the product boot error text" {
  # The script asserts a substring of DeviceBootService.provisionAndBoot's
  # ActionableError. If the product reworks that message, catch it here rather
  # than by turning main red on the next push.
  expected="$(grep -o 'expected_diagnostic="[^"]*"' \
    "$(pwd)/scripts/android/verify-emulator-sdk-resolution.sh" \
    | head -n 1 | sed 's/^expected_diagnostic="//; s/"$//')"

  [ -n "$expected" ]
  run grep -q "$expected" "$(pwd)/src/utils/deviceBootService.ts"
  [ "$status" -eq 0 ]
}
