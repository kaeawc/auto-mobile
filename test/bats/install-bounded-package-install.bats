#!/usr/bin/env bats
#
# Regression guard for issue #4162.
#
# Package installs in scripts/install.sh ran the host package manager unbounded
# with `>/dev/null 2>&1` (or behind `gum spin`, which hides output just as
# effectively). A stalled apt-get therefore ran for 45 minutes in
# `Installer Minimal (ubuntu-latest)` and emitted nothing at all, so the cause
# was unrecoverable from the logs. These tests pin both halves of the fix: the
# invocation is bounded, and its output survives a failure or a timeout.

# shellcheck disable=SC2329

setup() {
  TEST_DIR="$(mktemp -d)"
  STUB_BIN="${TEST_DIR}/bin"
  mkdir -p "${STUB_BIN}"

  ORIG_PATH="${PATH}"
  RM="$(command -v rm)"
  LN="$(command -v ln)"
  CHMOD="$(command -v chmod)"

  # Mirror the handful of utilities install.sh's bounded paths actually reach
  # for into the stub directory, so hide_real_timeout below can drop the system
  # directories from PATH entirely without also removing `mktemp` and `sleep`
  # out from under the watchdog fallback. Deliberately does NOT include
  # `timeout`/`gtimeout` -- an absence cannot be shadowed, so the only way to
  # reach the fallback is a PATH that never contained them.
  local tool
  for tool in bash env mktemp rm cat sleep chmod ln grep sed mkdir; do
    "$LN" -sf "$(command -v "${tool}")" "${STUB_BIN}/${tool}"
  done

  export PATH="${STUB_BIN}:/usr/bin:/bin"
  export INSTALL_SH_SOURCE_ONLY=true
  # shellcheck source=/dev/null
  source scripts/install.sh

  log_info() { printf '[INFO] %s\n' "$1"; }
  log_warn() { printf '[WARN] %s\n' "$1"; }
  log_error() { printf '[ERROR] %s\n' "$1"; }
  # Force the linux/apt-get branch of _install_system_package regardless of the
  # host actually running these tests.
  detect_os() { printf 'linux\n'; }

  NON_INTERACTIVE=true
  CHANGES_MADE=false

  # The linux branch shells out via sudo; run the command directly instead of
  # needing a password in the test environment.
  cat > "${STUB_BIN}/sudo" << 'STUB'
#!/usr/bin/env bash
exec "$@"
STUB
  "$CHMOD" +x "${STUB_BIN}/sudo"
}

teardown() {
  # Reap anything a watchdog test deliberately left behind, so a regression in
  # the kill escalation cannot leak a `sleep` into the rest of the run.
  if [ -n "${SURVIVOR_PID_FILE:-}" ] && [ -s "${SURVIVOR_PID_FILE}" ]; then
    kill -KILL "$(cat "${SURVIVOR_PID_FILE}")" 2> /dev/null || true
  fi
  export PATH="${ORIG_PATH}"
  "$RM" -rf "${TEST_DIR}"
}

# A stand-in package manager whose behaviour each test controls.
stub_apt_get() {
  cat > "${STUB_BIN}/apt-get"
  "$CHMOD" +x "${STUB_BIN}/apt-get"
}

# Drop the system directories from PATH so only stubs are resolvable.
#
# The setup PATH keeps /usr/bin:/bin because most tests need real `sleep`, `bash`
# and friends -- but ubuntu-latest ships /usr/bin/timeout, so a test asserting
# "no timeout binary exists" silently found the real one and only passed on the
# macOS laptop this was written on, where there is none. setup() mirrors the
# utilities the bounded paths need into STUB_BIN so this stays survivable.
hide_real_timeout() {
  export PATH="${STUB_BIN}"
}

# Put a real timeout binary on the restricted PATH under the name the resolver
# looks for, so the coreutils bound is exercised for real rather than against a
# stub. macOS ships neither, but provides gtimeout when coreutils is installed.
# Only the coreutils path skips: the watchdog fallback is pure bash, so its
# tests below run everywhere, which is the point -- stock macOS is the host
# where the bound used to silently not exist at all.
require_real_timeout() {
  local real
  real="$(PATH="${ORIG_PATH}" command -v timeout || PATH="${ORIG_PATH}" command -v gtimeout || true)"
  if [[ -z "${real}" ]]; then
    skip "neither timeout nor gtimeout available to exercise the bound"
  fi
  "$LN" -sf "${real}" "${STUB_BIN}/timeout"
}

@test "the bounded prefix uses timeout with a kill-after fallback" {
  hide_real_timeout
  "$LN" -sf /bin/echo "${STUB_BIN}/timeout"

  resolve_bounded_cmd_prefix 42

  [ "${#BOUNDED_CMD_PREFIX[@]}" -eq 4 ]
  [ "${BOUNDED_CMD_PREFIX[0]}" = "timeout" ]
  # -k matters: plain TERM leaves a package manager that ignores it running,
  # holding the captured pipe open past the deadline.
  [ "${BOUNDED_CMD_PREFIX[1]}" = "-k" ]
  [ "${BOUNDED_CMD_PREFIX[3]}" = "42" ]
}

@test "the bounded prefix falls back to gtimeout when timeout is absent" {
  hide_real_timeout
  "$LN" -sf /bin/echo "${STUB_BIN}/gtimeout"

  resolve_bounded_cmd_prefix 42

  [ "${BOUNDED_CMD_PREFIX[0]}" = "gtimeout" ]
}

@test "the bounded prefix is empty when no timeout binary exists" {
  hide_real_timeout

  resolve_bounded_cmd_prefix 42

  [ "${#BOUNDED_CMD_PREFIX[@]}" -eq 0 ]
}

@test "run_bounded_install succeeds via the watchdog fallback when no timeout binary exists" {
  # /bin/echo is spelled absolutely so it still resolves with the stub-only PATH.
  hide_real_timeout
  run run_bounded_install "Installing thing" /bin/echo hello
  [ "$status" -eq 0 ]
  [[ "$output" == *"Installing thing: ok"* ]]
}

@test "run_bounded_install still bounds a stall when no timeout binary exists" {
  # The regression this pins: on a stock macOS host neither `timeout` nor
  # `gtimeout` is on PATH, so an empty prefix meant every "bounded" install ran
  # with no bound at all -- the exact fail-open #4162 exists to close, on the
  # most likely developer platform. Verified before the fallback landed: a 30s
  # stall under a 2s bound returned 0 and reported "ok" after 30 seconds.
  #
  # No require_real_timeout here on purpose. The fallback is pure bash, so this
  # runs on every host, including the one where it used to be missing.
  hide_real_timeout
  cat > "${STUB_BIN}/stalling-pm" << 'STUB'
#!/usr/bin/env bash
sleep 60
STUB
  "$CHMOD" +x "${STUB_BIN}/stalling-pm"

  PACKAGE_INSTALL_TIMEOUT_SECONDS=1
  local start=${SECONDS}
  run run_bounded_install "Installing ffmpeg" stalling-pm
  local elapsed=$((SECONDS - start))

  [ "$status" -eq 124 ]
  [ "${elapsed}" -lt 30 ]
  # 124 must read as a stall, not a failure, or the two stay indistinguishable
  # in the logs -- which is the other half of what made #4162 undiagnosable.
  [[ "$output" == *"exceeded"* ]]
}

@test "the watchdog fallback bounds a stall that leaves a descendant holding stdout" {
  # Same grandchild hazard as the coreutils path: `bash -c "a && b"` does not
  # exec b, so signalling only the direct child leaves the grandchild alive.
  # The fallback relies on `set -m` giving the child its own process group and
  # on killing the group; without that this hangs for the full 60s.
  hide_real_timeout
  cat > "${STUB_BIN}/stalling-pm" << 'STUB'
#!/usr/bin/env bash
sleep 60
STUB
  "$CHMOD" +x "${STUB_BIN}/stalling-pm"

  PACKAGE_INSTALL_TIMEOUT_SECONDS=1
  local start=${SECONDS}
  run run_bounded_install "Installing ffmpeg" bash -c "true && stalling-pm"
  local elapsed=$((SECONDS - start))

  [ "$status" -eq 124 ]
  [ "${elapsed}" -lt 30 ]
}

@test "the watchdog fallback surfaces output and the exit code on failure" {
  # The fallback captures through a file rather than a command substitution, so
  # this also pins that the captured output survives that difference.
  hide_real_timeout
  cat > "${STUB_BIN}/failing-pm" << 'STUB'
#!/usr/bin/env bash
echo "E: Unable to locate package ffmpeg" >&2
exit 100
STUB
  "$CHMOD" +x "${STUB_BIN}/failing-pm"

  run run_bounded_install "Installing ffmpeg" failing-pm
  [ "$status" -eq 100 ]
  [[ "$output" == *"E: Unable to locate package ffmpeg"* ]]
  [[ "$output" == *"exit 100"* ]]
}

@test "run_bounded_install surfaces output and the exit code on failure" {
  # The output is the whole point: without it a failure is indistinguishable
  # from a stall, which is what made the 45-minute run undiagnosable.
  cat > "${STUB_BIN}/failing-pm" << 'STUB'
#!/usr/bin/env bash
echo "E: Unable to locate package ffmpeg" >&2
exit 100
STUB
  "$CHMOD" +x "${STUB_BIN}/failing-pm"

  run run_bounded_install "Installing ffmpeg" failing-pm
  [ "$status" -eq 100 ]
  [[ "$output" == *"E: Unable to locate package ffmpeg"* ]]
  [[ "$output" == *"exit 100"* ]]
}

@test "run_bounded_install bounds a stalled command and reports it as a timeout" {
  require_real_timeout
  cat > "${STUB_BIN}/stalling-pm" << 'STUB'
#!/usr/bin/env bash
sleep 60
STUB
  "$CHMOD" +x "${STUB_BIN}/stalling-pm"

  PACKAGE_INSTALL_TIMEOUT_SECONDS=1
  local start=${SECONDS}
  run run_bounded_install "Installing ffmpeg" stalling-pm
  local elapsed=$((SECONDS - start))

  [ "$status" -ne 0 ]
  [ "${elapsed}" -lt 30 ]
  # A timeout must read differently from a failure, or the two stay
  # indistinguishable in the logs.
  [[ "$output" == *"exceeded"* ]]
}

@test "a stall that leaves a descendant holding stdout is still bounded" {
  # `install_cmd` is an `&&` chain run through `bash -c`, so bash does not exec
  # the package manager and a naive kill of the direct child would leave the
  # grandchild alive holding the capture pipe open -- the bound would silently
  # not apply. GNU timeout signals the whole process group, which is what makes
  # the capture in run_bounded_install safe.
  require_real_timeout
  cat > "${STUB_BIN}/stalling-pm" << 'STUB'
#!/usr/bin/env bash
sleep 60
STUB
  "$CHMOD" +x "${STUB_BIN}/stalling-pm"

  PACKAGE_INSTALL_TIMEOUT_SECONDS=1
  local start=${SECONDS}
  run run_bounded_install "Installing ffmpeg" bash -c "true && stalling-pm"
  local elapsed=$((SECONDS - start))

  [ "$status" -ne 0 ]
  [ "${elapsed}" -lt 30 ]
}

@test "a successful package install reports success and is unchanged in behaviour" {
  stub_apt_get << 'STUB'
#!/usr/bin/env bash
exit 0
STUB

  run _install_system_package "ffmpeg" "required for video recording"
  [ "$status" -eq 0 ]
}

@test "a stalled package install is bounded rather than running to the job ceiling" {
  require_real_timeout
  stub_apt_get << 'STUB'
#!/usr/bin/env bash
sleep 60
STUB

  PACKAGE_INSTALL_TIMEOUT_SECONDS=1
  local start=${SECONDS}
  run _install_system_package "ffmpeg" "required for video recording"
  local elapsed=$((SECONDS - start))

  [ "$status" -eq 1 ]
  [ "${elapsed}" -lt 30 ]
  [[ "$output" == *"exceeded"* ]]
}

@test "a failed package install surfaces the package manager output" {
  stub_apt_get << 'STUB'
#!/usr/bin/env bash
echo "E: Could not get lock /var/lib/dpkg/lock-frontend" >&2
exit 100
STUB

  run _install_system_package "ffmpeg" "required for video recording"
  [ "$status" -eq 1 ]
  [[ "$output" == *"E: Could not get lock /var/lib/dpkg/lock-frontend"* ]]
  [[ "$output" == *"will be unavailable"* ]]
}

@test "no package install discards its output to /dev/null" {
  # Pins the defect shape directly, so reintroducing the redirect on any install
  # call site fails here even if the behavioural tests above stay satisfied.
  # `[[:space:]]` rather than `\s`: the latter is a GNU extension, and a guard
  # that silently fails to match on the BSD grep of macos-latest would pass for
  # the wrong reason. The companion test below proves this pattern discriminates.
  run grep -nE '(apt-get|dnf|pacman|apk|brew|yum) (install|add|-S).*>[[:space:]]*/dev/null' scripts/install.sh
  [ "$status" -ne 0 ]
}

@test "the discard guard actually matches a reintroduced redirect" {
  # Without this, the guard above passes whenever its pattern is broken --
  # exactly the failure mode of a source-scan check that greps for an absence.
  local fixture="${TEST_DIR}/reintroduced.sh"
  printf '%s\n' 'if run_spinner "x" bash -c "sudo apt-get install -y -qq ffmpeg >/dev/null 2>&1"; then' > "${fixture}"

  run grep -nE '(apt-get|dnf|pacman|apk|brew|yum) (install|add|-S).*>[[:space:]]*/dev/null' "${fixture}"
  [ "$status" -eq 0 ]

  run grep -nE 'run_spinner .*(brew install|apt-get install|dnf install|pacman -S|go install)' "${fixture}"
  [ "$status" -eq 0 ]
}

@test "no package install runs behind run_spinner, which hides its output" {
  # `gum spin` swallows the wrapped command's output as thoroughly as
  # `>/dev/null`, so package installs must go through run_bounded_install.
  run grep -nE 'run_spinner .*(brew install|apt-get install|dnf install|pacman -S|go install)' scripts/install.sh
  [ "$status" -ne 0 ]
}

# --- follow-up to #4232: sudo prompts and watchdog kill escalation -----------

# Replace the pass-through sudo stub from setup() with one that models the
# thing that actually breaks: an expired credential. Real sudo writes its
# prompt to stderr and reads the password from /dev/tty, and `-n` fails rather
# than prompting when nothing is cached.
stub_expired_sudo() {
  cat > "${STUB_BIN}/sudo" << STUB
#!/usr/bin/env bash
if [ "\$1" = "-n" ]; then
  # Nothing cached yet. Refuse without prompting, exactly as sudo -n does.
  [ -s "${TEST_DIR}/sudo_cached" ] && exit 0
  exit 1
fi
if [ "\$1" = "-v" ]; then
  printf 'PROMPT-VISIBLE: [sudo] password for tester: ' >&2
  printf 'refreshed\n' > "${TEST_DIR}/sudo_cached"
  printf 'v\n' >> "${TEST_DIR}/sudo_calls"
  exit 0
fi
if [ ! -s "${TEST_DIR}/sudo_cached" ]; then
  # The bounded invocation must never be the thing that prompts: at this point
  # it is inside a background process group with its output captured, so the
  # prompt is invisible and the read cannot reach the terminal.
  printf 'BOUNDED-PROMPT\n' >&2
  exit 1
fi
printf 'cmd\n' >> "${TEST_DIR}/sudo_calls"
exec "\$@"
STUB
  "$CHMOD" +x "${STUB_BIN}/sudo"
}

@test "an expired sudo credential is refreshed visibly, outside the capture" {
  # Reproduced before the fix, in a PTY with a 5s bound and a password typed one
  # second in: the typed text was echoed by the parent shell, sudo never
  # received it, and the prompt only surfaced at the end -- replayed out of the
  # captured output after the bound had already fired.
  #
  # A visible prompt on a *successful* install is the assertion that matters:
  # run_bounded_install prints its capture only on failure, so text that reaches
  # the caller on the success path can only have escaped the capture.
  hide_real_timeout
  stub_expired_sudo
  cat > "${STUB_BIN}/apt-get" << 'STUB'
#!/usr/bin/env bash
exit 0
STUB
  "$CHMOD" +x "${STUB_BIN}/apt-get"
  has_controlling_tty() { return 0; }
  NON_INTERACTIVE=false

  run run_bounded_install "Installing ffmpeg" sudo apt-get install -y -qq ffmpeg

  [ "$status" -eq 0 ]
  [[ "$output" == *"PROMPT-VISIBLE"* ]]
  # ...and the bounded invocation itself must not have been the one prompting.
  [[ "$output" != *"BOUNDED-PROMPT"* ]]
}

@test "the sudo refresh keys off the controlling terminal, not stdin" {
  # `curl … | bash` is the documented install path, and there fd 0 is the
  # script pipe for the whole run -- `[[ -t 0 ]]` is false even though the user
  # is sitting at a terminal. Gating the visible refresh on stdin therefore
  # skipped it in exactly the interactive case it exists for, and the bounded
  # `sudo` went on to hit the invisible prompt anyway.
  #
  # `has_controlling_tty` is the primitive the script already uses for this
  # (prompt_confirm_plain reads from /dev/tty for the same reason); stubbing it
  # is how a test harness -- which never has a controlling terminal -- can pin
  # the branch. stdin here is bats' pipe, i.e. the real curl|bash shape.
  hide_real_timeout
  stub_expired_sudo
  cat > "${STUB_BIN}/apt-get" << 'STUB'
#!/usr/bin/env bash
exit 0
STUB
  "$CHMOD" +x "${STUB_BIN}/apt-get"
  has_controlling_tty() { return 0; }
  NON_INTERACTIVE=false

  [ ! -t 0 ]

  run run_bounded_install "Installing ffmpeg" sudo apt-get install -y -qq ffmpeg

  [ "$status" -eq 0 ]
  [[ "$output" == *"PROMPT-VISIBLE"* ]]
  [[ "$output" != *"BOUNDED-PROMPT"* ]]
}

@test "a sudo timestamp that expires between installs is refreshed again" {
  # sudo's cached credential has its own timeout (5 minutes by default), and a
  # package install can outlast it. An in-process "already refreshed" flag
  # therefore goes stale: the next bounded install skipped even the
  # non-prompting `sudo -n -v` and prompted from inside the capture instead --
  # the same invisible hang, one install later.
  hide_real_timeout
  stub_expired_sudo
  cat > "${STUB_BIN}/apt-get" << 'STUB'
#!/usr/bin/env bash
exit 0
STUB
  "$CHMOD" +x "${STUB_BIN}/apt-get"
  has_controlling_tty() { return 0; }
  NON_INTERACTIVE=false

  run run_bounded_install "Installing first" sudo apt-get install -y -qq first
  [ "$status" -eq 0 ]
  [[ "$output" == *"PROMPT-VISIBLE"* ]]

  # The first install ran long enough for sudo's timestamp to expire.
  : > "${TEST_DIR}/sudo_cached"

  run run_bounded_install "Installing second" sudo apt-get install -y -qq second

  [ "$status" -eq 0 ]
  [[ "$output" == *"PROMPT-VISIBLE"* ]]
  [[ "$output" != *"BOUNDED-PROMPT"* ]]
}

@test "sudo embedded in a bash -c chain is refreshed too" {
  # _install_system_package builds `sudo apt-get update && sudo apt-get install`
  # and hands the whole chain to `bash -c`, so sudo is not argument one.
  hide_real_timeout
  stub_expired_sudo
  cat > "${STUB_BIN}/apt-get" << 'STUB'
#!/usr/bin/env bash
exit 0
STUB
  "$CHMOD" +x "${STUB_BIN}/apt-get"
  has_controlling_tty() { return 0; }
  NON_INTERACTIVE=false

  run run_bounded_install "Installing ffmpeg" bash -c "sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg"

  [ "$status" -eq 0 ]
  [[ "$output" == *"PROMPT-VISIBLE"* ]]
}

@test "an already-cached sudo credential is not re-prompted" {
  hide_real_timeout
  stub_expired_sudo
  printf 'already\n' > "${TEST_DIR}/sudo_cached"
  cat > "${STUB_BIN}/apt-get" << 'STUB'
#!/usr/bin/env bash
exit 0
STUB
  "$CHMOD" +x "${STUB_BIN}/apt-get"
  has_controlling_tty() { return 0; }
  NON_INTERACTIVE=false

  run run_bounded_install "Installing ffmpeg" sudo apt-get install -y -qq ffmpeg

  [ "$status" -eq 0 ]
  [[ "$output" != *"PROMPT-VISIBLE"* ]]
}

@test "a non-interactive session does not stop to prompt for sudo" {
  # CI runs with no terminal on stdin. Blocking there would trade the old
  # 45-minute stall for a new one.
  hide_real_timeout
  stub_expired_sudo
  cat > "${STUB_BIN}/apt-get" << 'STUB'
#!/usr/bin/env bash
exit 0
STUB
  "$CHMOD" +x "${STUB_BIN}/apt-get"
  has_controlling_tty() { return 1; }
  NON_INTERACTIVE=true

  run run_bounded_install "Installing ffmpeg" sudo apt-get install -y -qq ffmpeg

  [[ "$output" != *"PROMPT-VISIBLE"* ]]
  [ ! -s "${TEST_DIR}/sudo_cached" ]
}

@test "a command with no sudo in it never touches sudo" {
  hide_real_timeout
  stub_expired_sudo
  has_controlling_tty() { return 0; }
  NON_INTERACTIVE=false

  run run_bounded_install "Installing thing" /bin/echo hello

  [ "$status" -eq 0 ]
  [ ! -s "${TEST_DIR}/sudo_calls" ]
}

@test "the watchdog fallback does not return while a TERM-ignoring descendant lives" {
  # A watchdog that returns before the group is dead does not bound anything:
  # the installer reports the install aborted and moves on -- or exits -- while
  # the package manager is still running. Reproduced before the fix with a 1s
  # bound: run_bounded_install returned 124 after 1s and the survivor was still
  # alive, including after the parent script had exited entirely.
  #
  # No require_real_timeout: the fallback is pure bash, so this runs on
  # macos-latest too, which is the host where the bound used to be absent.
  hide_real_timeout
  export SURVIVOR_PID_FILE="${TEST_DIR}/survivor.pid"
  cat > "${STUB_BIN}/leaky-pm" << 'STUB'
#!/usr/bin/env bash
# A descendant that ignores TERM, as a package manager mid-transaction might.
bash -c 'trap "" TERM; echo $$ > "$SURVIVOR_PID_FILE"; sleep 120' &
# The direct child, by contrast, exits promptly on TERM -- which is what lets
# the parent's `wait` return with the group still populated.
trap 'exit 143' TERM
sleep 60 &
wait $!
STUB
  "$CHMOD" +x "${STUB_BIN}/leaky-pm"

  PACKAGE_INSTALL_TIMEOUT_SECONDS=1
  BOUNDED_KILL_GRACE_SECONDS=2
  run run_bounded_install "Installing ffmpeg" leaky-pm

  [ "$status" -eq 124 ]
  [ -s "${SURVIVOR_PID_FILE}" ]
  local survivor
  survivor="$(cat "${SURVIVOR_PID_FILE}")"
  run kill -0 "${survivor}"
  [ "$status" -ne 0 ]
}

@test "the coreutils path does not return while a TERM-ignoring descendant lives" {
  # GNU timeout waits only on its direct child. Its `-k` escalation is armed
  # inside the signal handler and dies with the process, so once that child is
  # reaped -- typically the `bash -c` wrapper, which honours TERM -- timeout
  # exits 124 immediately and the KILL is never delivered to the grandchild
  # that ignored TERM. (coreutils src/timeout.c: `while ((wait_result =
  # waitpid (monitored_pid, …)))` then `return status`; the `settimeout
  # (kill_after, false)` only ever runs from cleanup().) The group-wide TERM
  # does reach the grandchild; nothing follows it.
  #
  # That is the same defect the watchdog fallback fixes below, so both bounding
  # paths get the same guarantee: run_bounded_install does not return while a
  # member of the bounded group is still alive.
  require_real_timeout
  export SURVIVOR_PID_FILE="${TEST_DIR}/survivor.pid"
  cat > "${STUB_BIN}/leaky-pm" << 'STUB'
#!/usr/bin/env bash
bash -c 'trap "" TERM; echo $$ > "$SURVIVOR_PID_FILE"; sleep 120' &
trap 'exit 143' TERM
sleep 60 &
wait $!
STUB
  "$CHMOD" +x "${STUB_BIN}/leaky-pm"

  PACKAGE_INSTALL_TIMEOUT_SECONDS=1
  BOUNDED_KILL_GRACE_SECONDS=2
  run run_bounded_install "Installing ffmpeg" leaky-pm

  [ "$status" -eq 124 ] || [ "$status" -eq 137 ]
  [ -s "${SURVIVOR_PID_FILE}" ]
  local survivor
  survivor="$(cat "${SURVIVOR_PID_FILE}")"
  run kill -0 "${survivor}"
  [ "$status" -ne 0 ]
}

@test "the coreutils path does not pay the full kill grace when TERM is honoured" {
  # The escalation above must not turn every coreutils timeout into a full
  # grace-period wait; the common case is a command that dies on TERM at once.
  require_real_timeout
  cat > "${STUB_BIN}/stalling-pm" << 'STUB'
#!/usr/bin/env bash
sleep 60
STUB
  "$CHMOD" +x "${STUB_BIN}/stalling-pm"

  PACKAGE_INSTALL_TIMEOUT_SECONDS=1
  BOUNDED_KILL_GRACE_SECONDS=30
  local start=${SECONDS}
  run run_bounded_install "Installing ffmpeg" stalling-pm
  local elapsed=$((SECONDS - start))

  [ "$status" -ne 0 ]
  [ "${elapsed}" -lt 20 ]
}

@test "the watchdog does not pay the full kill grace when TERM is honoured" {
  # Waiting for the watcher must not mean waiting out the grace period on every
  # timeout -- the common case is a command that dies on TERM immediately.
  hide_real_timeout
  cat > "${STUB_BIN}/stalling-pm" << 'STUB'
#!/usr/bin/env bash
sleep 60
STUB
  "$CHMOD" +x "${STUB_BIN}/stalling-pm"

  PACKAGE_INSTALL_TIMEOUT_SECONDS=1
  BOUNDED_KILL_GRACE_SECONDS=30
  local start=${SECONDS}
  run run_bounded_install "Installing ffmpeg" stalling-pm
  local elapsed=$((SECONDS - start))

  [ "$status" -eq 124 ]
  [ "${elapsed}" -lt 20 ]
}

@test "the bounded prefix does not use --foreground" {
  # --foreground stops `timeout` putting the child in its own process group,
  # which is the only reason the `bash -c \"a && b\"` call sites are bounded at
  # all: without it the signal never reaches the grandchild. It is a tempting
  # but wrong fix for the sudo-prompt problem -- and it does not even solve it,
  # since the prompt is swallowed by the output capture either way.
  hide_real_timeout
  "$LN" -sf /bin/echo "${STUB_BIN}/timeout"

  resolve_bounded_cmd_prefix 42

  local arg
  # The `+` guard keeps an empty prefix from tripping `set -u` on bash 3.2.
  for arg in ${BOUNDED_CMD_PREFIX[@]+"${BOUNDED_CMD_PREFIX[@]}"}; do
    [ "${arg}" != "--foreground" ]
    [ "${arg}" != "-f" ]
  done
}

@test "no bounded path captures package manager output through a command substitution" {
  # Both paths must route output to a file. A `$(...)` capture leaves the caller
  # blocked on EOF for as long as any descendant retains the write end, which is
  # precisely the survivor case the kill escalation exists for.
  run grep -nE 'output=\$\(.*BOUNDED_CMD_PREFIX' scripts/install.sh
  [ "$status" -ne 0 ]
}

@test "the command-substitution guard actually matches the shape it forbids" {
  local fixture="${TEST_DIR}/reintroduced_capture.sh"
  printf '%s\n' '        output=$(${BOUNDED_CMD_PREFIX[@]+"${BOUNDED_CMD_PREFIX[@]}"} "$@" 2>&1) || status=$?' > "${fixture}"

  run grep -nE 'output=\$\(.*BOUNDED_CMD_PREFIX' "${fixture}"
  [ "$status" -eq 0 ]
}
