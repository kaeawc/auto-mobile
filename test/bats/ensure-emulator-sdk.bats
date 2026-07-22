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
echo "error: No android device matching criteria found. name=automobile-sdk-resolution-probe Available images: none."
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
  # The script asserts substrings of DeviceBootService.provisionAndBoot's
  # ActionableError. If the product reworks that message, catch it here rather
  # than by turning main red on the next push.
  #
  # The product interpolates `${request.platform}` and `${request.name}`, so the
  # script's resolved strings can never appear literally in the source. Split
  # each one into the part the probe chooses and the part the product spells out,
  # and pin both halves.
  script="$(pwd)/scripts/android/verify-emulator-sdk-resolution.sh"
  product="$(pwd)/src/utils/deviceBootService.ts"

  expected="$(grep -o 'expected_diagnostic="[^"]*"' "$script" \
    | head -n 1 | sed 's/^expected_diagnostic="//; s/"$//')"
  [ -n "$expected" ]

  # "No <platform> <invariant tail>"
  platform="${expected#No }"
  platform="${platform%% *}"
  invariant="${expected#No ${platform} }"
  [ -n "$invariant" ]
  [ "$invariant" != "$expected" ]

  # The platform baked into the expectation must be the one the probe asks for,
  # or the guard could pass on a platform it never exercised.
  [ "$platform" = "android" ]
  grep -qF -- "--platform ${platform}" "$script"

  # ...and the product must still build exactly "No <platform> <invariant tail>".
  grep -qF "No \${request.platform} ${invariant}" "$product"

  # The probe-name half: literal in the script (pre-expansion), interpolated in
  # the product.
  probe_name="$(grep -o 'expected_probe_name="[^"]*"' "$script" \
    | head -n 1 | sed 's/^expected_probe_name="//; s/"$//')"
  [ "$probe_name" = 'name=${missing_avd}' ]
  grep -qF 'name=${request.name}' "$product"
}

@test "the resolution tripwire rejects an iOS no-match diagnostic" {
  # Regression guard: the expectation used to be the platform-agnostic
  # "device matching criteria found", which the iOS path also emits. A
  # boot-device CLI that ignored --platform android, or routed through the iOS
  # manager, would then report a healthy *Android* SDK without touching Android.
  make_emulator
  fake_bin="$(mktemp -d)"
  cat > "${fake_bin}/bun" <<'MOCK'
#!/usr/bin/env bash
echo "error: No ios device matching criteria found. name=automobile-sdk-resolution-probe Available images: none."
exit 1
MOCK
  chmod +x "${fake_bin}/bun"

  run env ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT= ANDROID_SDK_HOME= \
    PATH="${fake_bin}:${PATH}" \
    bash "$(pwd)/scripts/android/verify-emulator-sdk-resolution.sh"

  rm -rf "$fake_bin"
  [ "$status" -eq 1 ]
  [[ "$output" == *"failed for an unexpected reason"* ]]
  [[ "$output" != *"resolvable by the product boot flow"* ]]
}

@test "the resolution tripwire rejects an Android no-match for some other device" {
  # The diagnostic has to be about the AVD this probe asked for; any other
  # no-match leaves the SDK precondition unverified.
  make_emulator
  fake_bin="$(mktemp -d)"
  cat > "${fake_bin}/bun" <<'MOCK'
#!/usr/bin/env bash
echo "error: No android device matching criteria found. name=some-other-avd Available images: none."
exit 1
MOCK
  chmod +x "${fake_bin}/bun"

  run env ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT= ANDROID_SDK_HOME= \
    PATH="${fake_bin}:${PATH}" \
    bash "$(pwd)/scripts/android/verify-emulator-sdk-resolution.sh"

  rm -rf "$fake_bin"
  [ "$status" -eq 1 ]
  [[ "$output" == *"not for the AVD this probe asked for"* ]]
  [[ "$output" != *"resolvable by the product boot flow"* ]]
}

@test "the resolution tripwire survives a healthy probe with lots of trailing output" {
  # `printf | grep -q` under `set -o pipefail` can report failure when grep exits
  # on an early match and printf takes SIGPIPE, failing a healthy probe.
  make_emulator
  fake_bin="$(mktemp -d)"
  cat > "${fake_bin}/bun" <<'MOCK'
#!/usr/bin/env bash
echo "error: No android device matching criteria found. name=automobile-sdk-resolution-probe Available images: none."
# Trailing diagnostics large enough that the reader can stop before the writer.
i=0
while [ "$i" -lt 20000 ]; do
  echo "trailing diagnostic line $i padded out to keep the pipe buffer busy"
  i=$((i + 1))
done
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
