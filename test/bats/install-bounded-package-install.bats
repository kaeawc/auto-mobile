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
