#!/usr/bin/env bats
#
# Tests for scripts/ios/local-sim-build-args.sh (issue #5024).
#
# Local iOS simulator builds on Apple Silicon default to a fat x86_64+arm64
# binary; the x86_64 slice never runs on an arm64 simulator, so every file is
# compiled and linked twice for nothing. `local_sim_build_args` emits the
# xcodebuild settings that trim a local build to the arch the simulator actually
# runs (arm64) and skip the index store that only an interactive Xcode needs —
# but ONLY on a local arm64 host, so CI and Intel machines keep building
# universal. `uname` is stubbed on PATH so these never depend on the real host.

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  HELPER="$REPO_ROOT/scripts/ios/local-sim-build-args.sh"
  STUB_DIR="$BATS_TEST_TMPDIR/stubs"
  mkdir -p "$STUB_DIR"
  # Neutral default: unset CI so the "local" branch is exercised unless a test
  # opts back into CI. BATS may run under CI itself.
  unset CI
}

# Fake `uname` on PATH reporting $1 for `uname -m` (and a sane -s otherwise).
stub_uname() {
  cat > "$STUB_DIR/uname" <<EOF
#!/bin/bash
if [ "\$1" = "-m" ]; then echo "$1"; else echo "Darwin"; fi
EOF
  chmod +x "$STUB_DIR/uname"
  PATH="$STUB_DIR:$PATH"
}

@test "local arm64 host (CI unset) emits arm64-only + no-index settings" {
  stub_uname arm64
  run bash -c "source '$HELPER'; local_sim_build_args"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "ONLY_ACTIVE_ARCH=YES" ]
  [ "${lines[1]}" = "ARCHS=arm64" ]
  [ "${lines[2]}" = "COMPILER_INDEX_STORE_ENABLE=NO" ]
  [ "${#lines[@]}" -eq 3 ]
}

@test "CI set (arm64) emits nothing — CI keeps building universal" {
  stub_uname arm64
  run bash -c "export CI=1; source '$HELPER'; local_sim_build_args"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "non-arm64 host (x86_64, CI unset) emits nothing — Intel keeps universal" {
  stub_uname x86_64
  run bash -c "source '$HELPER'; local_sim_build_args"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "helper is side-effect free to source" {
  stub_uname arm64
  run bash -c "source '$HELPER'; echo sourced-ok"
  [ "$status" -eq 0 ]
  # Negative array subscripts (${lines[-1]}) need bash 4.3+; the macOS CI runner
  # rejects them, so index the last line explicitly to stay bash-3.2 portable.
  [ "${lines[$((${#lines[@]} - 1))]}" = "sourced-ok" ]
}

# --- Wiring: the four local build/test scripts must consult the helper. ---

@test "ctrl-proxy-build-for-testing.sh consults local_sim_build_args" {
  grep -q "local_sim_build_args" "$REPO_ROOT/scripts/ios/ctrl-proxy-build-for-testing.sh"
}

@test "xcode-build.sh consults local_sim_build_args" {
  grep -q "local_sim_build_args" "$REPO_ROOT/scripts/ios/xcode-build.sh"
}

@test "xcode-test.sh consults local_sim_build_args" {
  grep -q "local_sim_build_args" "$REPO_ROOT/scripts/ios/xcode-test.sh"
}

@test "swift-build.sh consults local_sim_build_args" {
  grep -q "local_sim_build_args" "$REPO_ROOT/scripts/ios/swift-build.sh"
}

# --- The release IPA path must stay universal: it must NOT consult the helper. ---

@test "ctrl-proxy-create-ipa.sh does NOT consult local_sim_build_args (stays universal)" {
  ! grep -q "local_sim_build_args" "$REPO_ROOT/scripts/ios/ctrl-proxy-create-ipa.sh"
}
