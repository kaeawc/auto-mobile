#!/usr/bin/env bats
#
# Regression guards for the latent shell bugs fixed in #3654:
#   - hot-reload.sh excluded the current PID by substring (grep -v) instead of
#     exact match, sparing orphans whose PID contained the self PID's digits.
#   - avd_experiments.sh used the bash-4 `mapfile` builtin, aborting under the
#     macOS default bash 3.2.
#   - await_idle.sh gated process-idle on `grep -c ... -eq 3`, which counts
#     matching LINES (not distinct flags) and aborts under set -e on zero match.

HOT_RELOAD="scripts/local-dev/hot-reload.sh"
AVD="scripts/avd_experiments.sh"
AWAIT_IDLE="scripts/await_idle.sh"

# --- hot-reload.sh: exact PID exclusion -------------------------------------

@test "hot-reload self-PID exclusion is exact, not substring" {
  # The fix uses `grep -vxF "\$\$"`; the old `grep -v "\$\$"` matched substrings.
  grep -q 'grep -vxF "\$\$"' "$HOT_RELOAD"
  ! grep -qE 'pgrep -f "hot-reload.sh"[^|]*\| *grep -v "\$\$"' "$HOT_RELOAD"
}

@test "grep -vxF excludes only the exact self PID" {
  # self=456: orphans 4560 and 3456 must NOT be excluded.
  run bash -c 'printf "456\n4560\n3456\n" | grep -vxF 456'
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf "4560\n3456")" ]
}

# --- avd_experiments.sh: no bash-4 mapfile ----------------------------------

@test "avd_experiments does not use the bash-4 mapfile builtin" {
  ! grep -qE '^\s*mapfile\b' "$AVD"
}

@test "avd_experiments parses under macOS default bash 3.2" {
  # The array-populating loop must run under bash 3.2 (/bin/bash on macOS).
  run /bin/bash -c 'a=(); while IFS= read -r x; do a+=("$x"); done < <(printf "p1\np2\n"); echo "${#a[@]}:${a[0]}"'
  [ "$status" -eq 0 ]
  [ "$output" = "2:p1" ]
}

# --- await_idle.sh: independent flag checks ---------------------------------

@test "await_idle no longer uses grep -c for the idle flags" {
  ! grep -q 'grep -cE "mSleeping=false' "$AWAIT_IDLE"
}

@test "await_idle checks each idle flag independently" {
  grep -q 'grep "mSleeping=false" >/dev/null' "$AWAIT_IDLE"
  grep -q 'grep "mBooted=true" >/dev/null' "$AWAIT_IDLE"
  grep -q 'grep "mBooting=false" >/dev/null' "$AWAIT_IDLE"
}

@test "idle requires all three flags; missing one is not idle" {
  check() {
    echo "$1" | grep -q "mSleeping=false" &&
      echo "$1" | grep -q "mBooted=true" &&
      echo "$1" | grep -q "mBooting=false"
  }
  all=$'mSleeping=false\nmBooted=true\nmBooting=false'
  run check "$all"
  [ "$status" -eq 0 ]

  booting=$'mSleeping=false\nmBooted=true\nmBooting=true'
  run check "$booting"
  [ "$status" -ne 0 ]
}

@test "hot-reload override accepts a simulator in a large inventory" {
  local fixture="$BATS_TEST_TMPDIR/simulator-helper.sh"
  awk '/^get_current_simulator\(\)/ { copy=1 } copy { print } copy && /^}/ { exit }' "$HOT_RELOAD" > "$fixture"
  cat > "$BATS_TEST_TMPDIR/xcrun" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' '"test-udid"'
awk 'BEGIN { for (i=0; i<20000; i++) print "simulator filler" }'
exit "${SIMCTL_STATUS:-0}"
STUB
  chmod +x "$BATS_TEST_TMPDIR/xcrun"
  run env PATH="$BATS_TEST_TMPDIR:$PATH" SIMULATOR_ID_OVERRIDE=test-udid bash -euo pipefail -c 'source "$1"; get_current_simulator' _ "$fixture"
  [ "$status" -eq 0 ]
  [ "$output" = test-udid ]
  run env PATH="$BATS_TEST_TMPDIR:$PATH" SIMULATOR_ID_OVERRIDE=test-udid SIMCTL_STATUS=7 bash -euo pipefail -c 'source "$1"; get_current_simulator' _ "$fixture"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "iOS watch helper accepts an override in a large inventory without starting a process" {
  local fixture="$BATS_TEST_TMPDIR/watch-helper.sh"
  awk '/^watch_loop\(\)/ { copy=1 } copy { print } copy && /^}/ { exit }' scripts/local-dev/lib/ctrl-proxy-ios.sh > "$fixture"
  cat > "$BATS_TEST_TMPDIR/xcrun" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' '"test-udid"'
awk 'BEGIN { for (i=0; i<20000; i++) print "simulator filler" }'
STUB
  chmod +x "$BATS_TEST_TMPDIR/xcrun"
  run env PATH="$BATS_TEST_TMPDIR:$PATH" SIMULATOR_ID_OVERRIDE=test-udid bash -euo pipefail -c '
    source "$1"
    log_info() { echo "$*"; }
    log_warn() { :; }; build_ctrl_proxy_ios() { :; }; hash_watch_state() { echo fixed; }
    polls=0
    sleep() { polls=$((polls + 1)); [ "$polls" -le 1 ] || exit 1; }
    stop_ctrl_proxy_ios() { :; }
    start_ctrl_proxy_ios() { echo "start:$1"; exit 0; }
    XCODEBUILD_PID=""
    watch_loop
  ' _ "$fixture"
  [ "$status" -eq 0 ]
  [[ "$output" == *"start:test-udid"* ]]
}
