#!/usr/bin/env bats
# Each Bats test gets a fresh setup environment; changes never cross tests.
# shellcheck disable=SC2030,SC2031

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$PROJECT_ROOT/scripts/android/build-lmk-pressure.sh"
  WORK_DIR="$(mktemp -d)"
  export HOME="$WORK_DIR/home"
  export ANDROID_HOME="$WORK_DIR/sdk"
  export ANDROID_SDK_ROOT=""
  export ANDROID_NDK_HOME=""
  export ANDROID_NDK_ROOT=""
  export LMK_PRESSURE_OUT="$WORK_DIR/output with spaces"
  export COMPILER_LOG="$WORK_DIR/compilers.log"
  export STUB_HOST=Linux
  mkdir -p "$WORK_DIR/bin"
  cat > "$WORK_DIR/bin/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$STUB_HOST"
EOF
  chmod +x "$WORK_DIR/bin/uname"
  export PATH="$WORK_DIR/bin:$PATH"
  cd "$WORK_DIR" || return 1
}

teardown() {
  rm -rf "$WORK_DIR"
}

make_ndk() {
  local bin="$1/toolchains/llvm/prebuilt/${2:-linux-x86_64}/bin"
  mkdir -p "$bin"
  cat > "$bin/aarch64-linux-android26-clang" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$0" >> "$COMPILER_LOG"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -o ]]; then
    touch "$2"
    exit 0
  fi
  shift
done
echo 'Missing -o argument' >&2
exit 1
EOF
  cp "$bin/aarch64-linux-android26-clang" "$bin/x86_64-linux-android26-clang"
  chmod +x "$bin/"*clang
}

@test "missing NDK fails clearly without invoking a compiler" {
  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"No Android NDK found. Set ANDROID_NDK_HOME or ANDROID_NDK_ROOT"* ]]
  [[ "$output" == *"$ANDROID_HOME/ndk"* ]]
  [ ! -e "$COMPILER_LOG" ]
  [ ! -d "$LMK_PRESSURE_OUT" ]
}

@test "NDK HOME takes precedence and stub compilers produce both ABI outputs" {
  export ANDROID_NDK_HOME="$WORK_DIR/ndk home"
  export ANDROID_NDK_ROOT="$WORK_DIR/ndk root"
  make_ndk "$ANDROID_NDK_HOME"
  make_ndk "$ANDROID_NDK_ROOT"

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [ -f "$LMK_PRESSURE_OUT/arm64-v8a/lmk_pressure" ]
  [ -f "$LMK_PRESSURE_OUT/x86_64/lmk_pressure" ]
  [ "${lines[0]}" = "$LMK_PRESSURE_OUT/arm64-v8a/lmk_pressure" ]
  [ "${lines[1]}" = "$LMK_PRESSURE_OUT/x86_64/lmk_pressure" ]
  [ "$(wc -l < "$COMPILER_LOG" | tr -d ' ')" -eq 2 ]
  [[ "$(cat "$COMPILER_LOG")" != *"$ANDROID_NDK_ROOT/"* ]]
}

@test "invalid NDK HOME falls through to NDK ROOT" {
  export ANDROID_NDK_HOME="$WORK_DIR/missing"
  export ANDROID_NDK_ROOT="$WORK_DIR/ndk"
  make_ndk "$ANDROID_NDK_ROOT"

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$(cat "$COMPILER_LOG")" == *"$ANDROID_NDK_ROOT/"* ]]
}

@test "SDK discovery selects the newest numeric revision and uses default outputs" {
  make_ndk "$ANDROID_HOME/ndk/9.0.123"
  make_ndk "$ANDROID_HOME/ndk/27.2.999"
  make_ndk "$ANDROID_HOME/ndk/27.10.100"
  unset LMK_PRESSURE_OUT

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [ -f build/lmk-pressure/arm64-v8a/lmk_pressure ]
  [ -f build/lmk-pressure/x86_64/lmk_pressure ]
  [ "${lines[0]}" = build/lmk-pressure/arm64-v8a/lmk_pressure ]
  [ "${lines[1]}" = build/lmk-pressure/x86_64/lmk_pressure ]
  [[ "$(cat "$COMPILER_LOG")" == *"/ndk/27.10.100/"* ]]
  [[ "$(cat "$COMPILER_LOG")" != *"/ndk/9.0.123/"* ]]
  [[ "$(cat "$COMPILER_LOG")" != *"/ndk/27.2.999/"* ]]
}

@test "SDK ROOT fallback supports the Darwin prebuilt layout" {
  export ANDROID_HOME=""
  export ANDROID_SDK_ROOT="$WORK_DIR/alternate-sdk"
  export STUB_HOST=Darwin
  make_ndk "$ANDROID_SDK_ROOT/ndk/27.0.123" darwin-x86_64

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [ -f "$LMK_PRESSURE_OUT/arm64-v8a/lmk_pressure" ]
  [ -f "$LMK_PRESSURE_OUT/x86_64/lmk_pressure" ]
  [[ "$(cat "$COMPILER_LOG")" == *"/darwin-x86_64/"* ]]
}

@test "default SDK location and alternate prebuilt directory are supported" {
  export ANDROID_HOME=""
  export ANDROID_SDK_ROOT=""
  make_ndk "$HOME/Library/Android/sdk/ndk/27.0.123" darwin-x86_64

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [ -f "$LMK_PRESSURE_OUT/arm64-v8a/lmk_pressure" ]
  [ -f "$LMK_PRESSURE_OUT/x86_64/lmk_pressure" ]
}

@test "missing second compiler fails before producing partial outputs" {
  export ANDROID_NDK_HOME="$WORK_DIR/ndk"
  make_ndk "$ANDROID_NDK_HOME"
  rm "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android26-clang"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"Android NDK compiler not found or not executable:"*"x86_64-linux-android26-clang"* ]]
  [ ! -e "$COMPILER_LOG" ]
  [ ! -d "$LMK_PRESSURE_OUT" ]
}
