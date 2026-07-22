#!/usr/bin/env bats
#
# Tests for scripts/ios/start-simulator.sh timeout handling
#
# Regression guard for #3644: the boot wait used GNU `timeout`, which is absent
# on stock macOS (only `gtimeout` when coreutils is brew-installed). Inside
# `if ! timeout ...` the resulting 127 read as "boot failed", so the script
# reported failure even when the simulator booted — on the local-macOS path its
# header advertises. The fix resolves timeout/gtimeout with a pure-bash fallback.

SCRIPT="scripts/ios/start-simulator.sh"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  WORK_DIR="$(mktemp -d)"
  # A PATH without `timeout`/`gtimeout`, to force the pure-bash fallback path
  # deterministically. Beyond builtins (command/kill/wait) the fallback needs
  # sleep plus mktemp/rm -- the watchdog runs in a subshell, so a marker file is
  # the only way it can report back that it fired. All three are POSIX.
  BIN_DIR="$(mktemp -d)"
  # `sh` is not needed by the fallback; it is here so tests can build stub
  # commands to run under it.
  for _tool in bash sleep mktemp rm sh; do
    ln -s "$(command -v "$_tool")" "$BIN_DIR/$_tool"
  done

  # Extract run_with_timeout now (full PATH → awk available); run it later
  # under the restricted PATH by sourcing this file.
  # Source the shared library directly. This previously awk-extracted the
  # function out of start-simulator.sh; once it moved to its own sourceable file
  # (#4095, when boot-simulator.sh became the second consumer) the extraction
  # silently produced an EMPTY file, leaving run_with_timeout undefined. One test
  # then failed loudly and the other passed for the wrong reason -- it asserts a
  # non-zero rc, which an undefined function also returns.
  FN_FILE="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/scripts/ios/run_with_timeout.sh"
}

teardown() {
  rm -rf "$BIN_DIR" "$WORK_DIR"
}

# $1 = snippet to eval after sourcing run_with_timeout, under the restricted PATH.
run_helper() {
  run env PATH="$BIN_DIR" bash -c 'source "$1"; eval "$2"' _ "$FN_FILE" "$1"
}

@test "boot wait no longer calls bare GNU timeout (uses run_with_timeout)" {
  local hits
  hits="$(grep -vE '^\s*#' "$SCRIPT" | grep -E '(^|[^_])timeout .*bootstatus' || true)"
  [ -z "$hits" ]
}

@test "run_with_timeout succeeds via bash fallback when timeout/gtimeout absent" {
  # Sanity: neither timeout nor gtimeout resolvable here.
  run env PATH="$BIN_DIR" bash -c 'command -v timeout || command -v gtimeout'
  [ "$status" -ne 0 ]

  run_helper 'run_with_timeout 5 true; echo "rc=$?"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"rc=0"* ]]
}

@test "run_with_timeout reports 124 when the command exceeds the limit" {
  # Asserting only "non-zero" would also pass if run_with_timeout were undefined,
  # so require the function to exist first.
  run_helper 'declare -F run_with_timeout >/dev/null && echo defined'
  [[ "$output" == *"defined"* ]]

  # Pin the exact GNU-timeout expiry code. Asserting merely "non-zero" let the
  # fallback return 143 (128+SIGTERM) for years -- indistinguishable from a
  # command signalled for any other reason, which is the distinction
  # boot-simulator.sh relies on to tell a stall apart from a boot failure.
  run_helper 'run_with_timeout 1 sleep 5; echo "rc=$?"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"rc=124"* ]]
}

@test "run_with_timeout passes a genuine non-zero status through unchanged" {
  # Guards the inverse of the test above: expiry must not be conflated with a
  # command that simply failed fast.
  run_helper 'run_with_timeout 5 sh -c "exit 3"; echo "rc=$?"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"rc=3"* ]]
}

@test "run_with_timeout bounds a command whose descendant holds stdout open" {
  # The watchdog used to signal only the direct child. A command that leaves a
  # descendant on stdout then keeps the caller's `out="$(run_with_timeout ...)"`
  # blocked past the deadline waiting for EOF on the pipe -- so the bound did
  # not apply at all, and boot-simulator.sh's stalled-boot retry never ran.
  # The descendant self-exits well after the bound but still in finite time, so
  # a regression fails this test in ~20s rather than hanging the job. Killing a
  # wrapper shell would not bound it: bats reads the pipe until EOF, which the
  # surviving descendant holds open regardless of the shell's fate.
  cat > "$WORK_DIR/stallwrap" << 'EOS'
#!/bin/sh
# Deliberately no `exec`: the sleep is a descendant that inherits stdout.
sleep 20 &
wait
EOS
  chmod +x "$WORK_DIR/stallwrap"

  run_helper "s=\$SECONDS; out=\"\$(run_with_timeout 2 '$WORK_DIR/stallwrap' 2>&1)\"; echo \"rc=\$? elapsed=\$((SECONDS-s))\""
  [ "$status" -eq 0 ]
  [[ "$output" == *"rc=124"* ]]
  # Elapsed pins that the bound actually fired rather than the run merely
  # outliving the descendant: signalling only the direct child returns at ~20s.
  local elapsed="${output##*elapsed=}"
  [ "${elapsed}" -lt 15 ]
}
