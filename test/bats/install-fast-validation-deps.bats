#!/usr/bin/env bats
# bats file_tags=integration
#
# Tests for scripts/ci/install-fast-validation-deps.sh
#
# The real script installs xmlstarlet, bats, and lychee over the network. These tests stub
# `sudo`, `apt-get`, and `git` on PATH and run a scratch copy with a fake lychee installer, and drive
# the timeout/retry logic that bounds the Fast Validation dependency-install
# hang class.

SCRIPT="scripts/ci/install-fast-validation-deps.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  # The installer invokes lychee by relative path, so a PATH stub cannot intercept
  # it. Run a copy of the script from a scratch repo-shaped directory instead.
  mkdir -p "${MOCK_BIN}/workspace/scripts/ci" "${MOCK_BIN}/workspace/scripts/lychee"
  cp "$SCRIPT" "${MOCK_BIN}/workspace/scripts/ci/install-fast-validation-deps.sh"
  # xmlstarlet goes through the shared bounded apt helper beside it (#17930).
  cp scripts/ci/install-apt-packages.sh "${MOCK_BIN}/workspace/scripts/ci/install-apt-packages.sh"
  SCRIPT="${MOCK_BIN}/workspace/scripts/ci/install-fast-validation-deps.sh"
  cat > "${MOCK_BIN}/workspace/scripts/lychee/install_lychee.sh" <<'STUB'
#!/usr/bin/env bash
calls=0
[ -f "$LYCHEE_STATE_FILE" ] && calls="$(cat "$LYCHEE_STATE_FILE")"
calls=$((calls + 1))
echo "$calls" > "$LYCHEE_STATE_FILE"
if [ "$calls" -le "${LYCHEE_FAIL_FIRST:-0}" ]; then
  echo "lychee transient failure $calls" >&2
  exit 1
fi
exit 0
STUB
  chmod +x "${MOCK_BIN}/workspace/scripts/lychee/install_lychee.sh"
  export LYCHEE_STATE_FILE="${MOCK_BIN}/lychee-calls"
  cd "${MOCK_BIN}/workspace"
  # A shared counter file lets a stub fail the first N invocations.
  export STATE_FILE="${MOCK_BIN}/apt-calls"
  # Keep the bats source-install branch out of the way: a stub `bats` on PATH
  # makes the script skip cloning bats-core.
  cat > "${MOCK_BIN}/bats" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "${MOCK_BIN}/bats"
  # `sudo` drops the sudo and execs the rest, but like real sudo it resets the
  # fallback overrides: they only survive when passed explicitly (via `env`).
  cat > "${MOCK_BIN}/sudo" <<'STUB'
#!/usr/bin/env bash
exec env -u FAST_VALIDATION_DEPS_FALLBACK_MIRROR -u FAST_VALIDATION_DEPS_UBUNTU_CODENAME \
  -u APT_INSTALL_FALLBACK_MIRROR -u APT_INSTALL_UBUNTU_CODENAME "$@"
STUB
  chmod +x "${MOCK_BIN}/sudo"
  # Deterministic timeout/sleep stubs: no wall-clock delay or process signaling.
  # MOCK_TIMEOUT_EXPIRE models GNU timeout's 124 result for the timeout test.
  cat > "${MOCK_BIN}/timeout" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-k" ]; then shift 2; fi
shift
if [ "${MOCK_TIMEOUT_EXPIRE:-0}" = 1 ]; then
  exit 124
fi
"$@"
STUB
  chmod +x "${MOCK_BIN}/timeout"
  cat > "${MOCK_BIN}/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "${MOCK_BIN}/sleep"
  export PATH="${MOCK_BIN}:${PATH}"
  # Fast, deterministic retries.
  export FAST_VALIDATION_DEPS_RETRY_BASE_DELAY_SECONDS=1
  # Hosts may have a real xmlstarlet; probe a name that cannot exist instead.
  export FAST_VALIDATION_DEPS_XMLSTARLET_COMMAND=xmlstarlet-not-installed-stub
  # python3 would skip the apt install too (#17930); exercise the apt path.
  export FAST_VALIDATION_DEPS_PYTHON_COMMAND=python3-not-installed-stub
  export FAST_VALIDATION_DEPS_UBUNTU_CODENAME=noble
  export FAST_VALIDATION_DEPS_FALLBACK_MIRROR=http://fallback.example.test/ubuntu
}

teardown() {
  rm -rf "$MOCK_BIN"
  export PATH="$ORIG_PATH"
}

# Writes an `apt-get` stub that fails its first $1 invocations, then succeeds.
make_apt_get() {
  local fail_first="$1"
  cat > "${MOCK_BIN}/apt-get" <<STUB
#!/usr/bin/env bash
calls=0
[ -f "${STATE_FILE}" ] && calls="\$(cat "${STATE_FILE}")"
calls=\$((calls + 1))
echo "\$calls" > "${STATE_FILE}"
if [ "\$calls" -le "${fail_first}" ]; then
  echo "apt-get transient failure \$calls" >&2
  exit 100
fi
exit 0
STUB
  chmod +x "${MOCK_BIN}/apt-get"
}

@test "script is executable" {
  [ -x "$SCRIPT" ]
}

@test "script has bash shebang" {
  head -1 "$SCRIPT" | grep -q "bash"
}

@test "shellcheck passes" {
  if ! command -v shellcheck > /dev/null 2>&1; then
    skip "shellcheck not installed"
  fi
  run shellcheck "$SCRIPT"
  [ "$status" -eq 0 ]
}

@test "succeeds when all network commands succeed" {
  make_apt_get 0
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Fast Validation dependencies ready"* ]]
}

@test "retries a transiently-failing apt-get and then succeeds" {
  # First `apt-get update` call fails once, then succeeds; install then succeeds.
  make_apt_get 1
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"attempt 2/2"* ]]
  [[ "$output" == *"Fast Validation dependencies ready"* ]]
}

@test "runs the lychee installer once, since it owns its download backoff" {
  make_apt_get 0
  export LYCHEE_FAIL_FIRST=1
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"install lychee (timeout 150s"* ]]
  [[ "$output" == *"install lychee failed with exit 1"* ]]
  [ "$(cat "$LYCHEE_STATE_FILE")" -eq 1 ]
}

@test "bounds a hanging lychee install with its own timeout" {
  make_apt_get 0
  cat > "${MOCK_BIN}/timeout" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-k" ]; then shift 2; fi
seconds="$1"
shift
if [ "$seconds" = "${MOCK_TIMEOUT_EXPIRE_SECONDS:-}" ]; then
  exit 124
fi
"$@"
STUB
  run env MOCK_TIMEOUT_EXPIRE_SECONDS=7 FAST_VALIDATION_DEPS_LYCHEE_TIMEOUT_SECONDS=7 bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"install lychee timed out after 7s"* ]]
}

@test "default retry budget fits the documented 15-minute step timeout" {
  # Worst case = each retrying operation x (MAX_ATTEMPTS x (CMD_TIMEOUT + KILL_GRACE) + delays)
  # + the single lychee install (LYCHEE_TIMEOUT + KILL_GRACE).
  # Guard the arithmetic so a future default bump cannot silently exceed the
  # workflow step's timeout-minutes backstop.
  local cmd_timeout kill_grace attempts base_delay
  cmd_timeout=$(grep -oE 'CMD_TIMEOUT_SECONDS:-[0-9]+' "$SCRIPT" | grep -oE '[0-9]+$')
  kill_grace=$(grep -oE 'KILL_GRACE_SECONDS:-[0-9]+' "$SCRIPT" | grep -oE '[0-9]+$')
  attempts=$(grep -oE 'MAX_ATTEMPTS:-[0-9]+' "$SCRIPT" | grep -oE '[0-9]+$')
  base_delay=$(grep -oE 'RETRY_BASE_DELAY_SECONDS:-[0-9]+' "$SCRIPT" | grep -oE '[0-9]+$')
  local delays=0 delay="$base_delay" i
  for ((i = 1; i < attempts; i++)); do
    delays=$((delays + delay))
    delay=$((delay * 2))
  done
  local operation_count step_timeout_minutes
  operation_count=$(grep -cE '^[[:space:]]*(run_capture_status )?(run|try)_with_retry "[^$]' "$SCRIPT")
  step_timeout_minutes=$(grep -oE 'timeout-minutes: [0-9]+' "$SCRIPT" | head -1 | grep -oE '[0-9]+$')
  # bats clone + bats install here, plus the apt helper's update, install and
  # fallback, each handed CMD_TIMEOUT_SECONDS.
  [ "$operation_count" -eq 2 ]
  local helper_timeouts
  helper_timeouts=$(grep -cE '^[[:space:]]*APT_INSTALL_(UPDATE_|FALLBACK_)?TIMEOUT_SECONDS="\$CMD_TIMEOUT_SECONDS"' "$SCRIPT")
  [ "$helper_timeouts" -eq 3 ]
  operation_count=$((operation_count + helper_timeouts))
  # The lychee install runs once under its own timeout (#17641).
  local lychee_timeout
  lychee_timeout=$(grep -oE 'LYCHEE_TIMEOUT_SECONDS:-[0-9]+' "$SCRIPT" | grep -oE '[0-9]+$')
  local worst_case=$((operation_count * (attempts * (cmd_timeout + kill_grace) + delays) + lychee_timeout + kill_grace))
  echo "worst_case=${worst_case}s"
  [ "$worst_case" -le "$((step_timeout_minutes * 60))" ]
}

@test "a partial clone left by a killed attempt is cleaned before the retry" {
  # Force the source-install branch: drop the `bats` stub and restrict PATH so
  # the host's real bats (typically /usr/local or homebrew) is not found, while
  # our git/sudo/timeout stubs still win.
  rm "${MOCK_BIN}/bats"
  make_apt_get 0
  local clone_dir="${MOCK_BIN}/bats-clone"
  export CLONE_STATE="${MOCK_BIN}/git-calls"
  # First clone "dies mid-transfer": leaves a non-empty target and fails.
  # Second clone must see a CLEAN target (proving per-attempt cleanup) — it
  # fails loudly like real git if the directory still exists.
  local pinned_commit
  pinned_commit="$(sed -n 's/^BATS_CORE_COMMIT="\(.*\)"$/\1/p' "$SCRIPT")"
  cat > "${MOCK_BIN}/git" <<STUB
#!/usr/bin/env bash
# The post-clone pin check: report the pinned commit.
if [ "\$1" = "-C" ]; then
  echo "${pinned_commit}"
  exit 0
fi
target="\${!#}"
calls=0
[ -f "${CLONE_STATE}" ] && calls="\$(cat "${CLONE_STATE}")"
calls=\$((calls + 1))
echo "\$calls" > "${CLONE_STATE}"
if [ "\$calls" -eq 1 ]; then
  mkdir -p "\$target"
  echo partial > "\$target/partial-object"
  exit 1
fi
if [ -e "\$target" ]; then
  echo "fatal: destination path '\$target' already exists and is not an empty directory." >&2
  exit 128
fi
mkdir -p "\$target"
printf '#!/usr/bin/env bash\nexit 0\n' > "\$target/install.sh"
chmod +x "\$target/install.sh"
exit 0
STUB
  chmod +x "${MOCK_BIN}/git"
  run env PATH="${MOCK_BIN}:/usr/bin:/bin" \
    FAST_VALIDATION_DEPS_BATS_CLONE_DIR="$clone_dir" \
    bash "$SCRIPT"
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"attempt 2/2"* ]]
  [[ "$output" == *"Fast Validation dependencies ready"* ]]
}

@test "falls back to the alternate mirror when the default install keeps failing" {
  # Call 1 = update ok, calls 2-3 = default install fails twice, then the
  # fallback's update + install succeed. Log every invocation's args.
  cat > "${MOCK_BIN}/apt-get" <<STUB
#!/usr/bin/env bash
calls=0
[ -f "${STATE_FILE}" ] && calls="\$(cat "${STATE_FILE}")"
calls=\$((calls + 1))
echo "\$calls" > "${STATE_FILE}"
echo "\$*" >> "${MOCK_BIN}/apt-args"
if [ "\$calls" -eq 2 ] || [ "\$calls" -eq 3 ]; then exit 100; fi
if [ "\$1" = "update" ] && [ "\$calls" -gt 1 ]; then
  # \$2 is "-o"; \$3 is Dir::Etc::sourcelist=<throwaway list>.
  grep -q "fallback.example.test/ubuntu noble main universe" -- "\${3#*=}" < /dev/null 2>/dev/null || exit 99
fi
exit 0
STUB
  chmod +x "${MOCK_BIN}/apt-get"
  run bash "$SCRIPT"
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"falling back to http://fallback.example.test/ubuntu"* ]]
  [[ "$output" == *"Installed xmlstarlet from http://fallback.example.test/ubuntu"* ]]
  [[ "$output" == *"Fast Validation dependencies ready"* ]]
  [ "$(cat "$STATE_FILE")" -eq 5 ]
}

@test "falls back to the alternate mirror when the default apt-get update keeps failing" {
  # The #17930 outage: the default mirror's index fetch exits 100 on every
  # attempt. Calls 1-2 = default update fails, then the fallback's update +
  # install (calls 3-4) succeed; the default install is never attempted.
  cat > "${MOCK_BIN}/apt-get" <<STUB
#!/usr/bin/env bash
calls=0
[ -f "${STATE_FILE}" ] && calls="\$(cat "${STATE_FILE}")"
calls=\$((calls + 1))
echo "\$calls" > "${STATE_FILE}"
echo "\$*" >> "${MOCK_BIN}/apt-args"
if [ "\$calls" -le 2 ]; then exit 100; fi
exit 0
STUB
  chmod +x "${MOCK_BIN}/apt-get"
  run bash "$SCRIPT"
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"apt-get update failed after 2 attempts"* ]]
  [[ "$output" == *"Installed xmlstarlet from http://fallback.example.test/ubuntu"* ]]
  [[ "$output" == *"Fast Validation dependencies ready"* ]]
  [ "$(cat "$STATE_FILE")" -eq 4 ]
  grep -q 'Dir::Etc::sourcelist=' "${MOCK_BIN}/apt-args"
}

@test "fails loudly when the fallback mirror also fails" {
  # The initial `apt-get update` succeeds; every later apt-get call fails.
  cat > "${MOCK_BIN}/apt-get" <<'STUB'
#!/usr/bin/env bash
[ "$1" = "update" ] && [ ! -f "$STATE_FILE" ] && { echo 1 > "$STATE_FILE"; exit 0; }
exit 100
STUB
  chmod +x "${MOCK_BIN}/apt-get"
  run env FAST_VALIDATION_DEPS_MAX_ATTEMPTS=1 bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"from http://fallback.example.test/ubuntu failed after 1 attempts"* ]]
  [[ "$output" == *"could not install xmlstarlet"*"both failed or stalled"* ]]
}

@test "skips apt-get entirely when xmlstarlet is already on PATH" {
  make_apt_get 99
  printf '#!/usr/bin/env bash\nexit 0\n' > "${MOCK_BIN}/xmlstarlet"
  chmod +x "${MOCK_BIN}/xmlstarlet"
  run env FAST_VALIDATION_DEPS_XMLSTARLET_COMMAND=xmlstarlet bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"xmlstarlet already on PATH"* ]]
  [ ! -f "$STATE_FILE" ]
}

@test "skips apt-get when python3 can validate the XML instead (#17930)" {
  make_apt_get 99
  printf '#!/usr/bin/env bash\nexit 0\n' > "${MOCK_BIN}/python3"
  chmod +x "${MOCK_BIN}/python3"
  run env FAST_VALIDATION_DEPS_PYTHON_COMMAND=python3 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"python3 on PATH validates XML; skipping the xmlstarlet apt install"* ]]
  [ ! -f "$STATE_FILE" ]
}

@test "fails loudly after exhausting retries" {
  # apt-get fails more times than MAX_ATTEMPTS allows.
  make_apt_get 99
  run env FAST_VALIDATION_DEPS_MAX_ATTEMPTS=2 bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"failed after 2 attempts"* ]]
}

@test "bounds a hanging command with the per-command timeout" {
  # The timeout stub deterministically reports an expired command, with no wait.
  cat > "${MOCK_BIN}/apt-get" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "${MOCK_BIN}/apt-get"
  run env MOCK_TIMEOUT_EXPIRE=1 FAST_VALIDATION_DEPS_CMD_TIMEOUT_SECONDS=1 \
    FAST_VALIDATION_DEPS_KILL_GRACE_SECONDS=1 \
    FAST_VALIDATION_DEPS_MAX_ATTEMPTS=1 \
    bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"timed out after 1s"* ]]
}

@test "rejects a non-positive-integer tunable" {
  make_apt_get 0
  run env FAST_VALIDATION_DEPS_MAX_ATTEMPTS=0 bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"must be a positive integer"* ]]
}

@test "a bats-core clone that does not match the pinned commit is not installed" {
  rm "${MOCK_BIN}/bats"
  make_apt_get 0
  local clone_dir="${MOCK_BIN}/bats-clone"
  local sudo_log="${MOCK_BIN}/sudo-calls"
  cat > "${MOCK_BIN}/git" <<STUB
#!/usr/bin/env bash
if [ "\$1" = "-C" ]; then
  echo 0000000000000000000000000000000000000000
  exit 0
fi
target="\${!#}"
mkdir -p "\$target"
printf '#!/usr/bin/env bash\nexit 0\n' > "\$target/install.sh"
chmod +x "\$target/install.sh"
STUB
  chmod +x "${MOCK_BIN}/git"
  cat > "${MOCK_BIN}/sudo" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "${sudo_log}"
exec "\$@"
STUB
  chmod +x "${MOCK_BIN}/sudo"
  run env PATH="${MOCK_BIN}:/usr/bin:/bin" \
    FAST_VALIDATION_DEPS_BATS_CLONE_DIR="$clone_dir" \
    bash "$SCRIPT"
  echo "$output"
  [ "$status" -ne 0 ]
  [[ "$output" == *"expected"* ]]
  ! grep -q 'install.sh' "${sudo_log}" 2>/dev/null
}

@test "every bats-core install pins the same tag and verifies the same commit" {
  local tag commit
  tag="$(sed -n 's/^BATS_CORE_TAG="\(.*\)"$/\1/p' "$SCRIPT")"
  commit="$(sed -n 's/^BATS_CORE_COMMIT="\(.*\)"$/\1/p' "$SCRIPT")"
  [ -n "$tag" ]
  [ -n "$commit" ]
  local repo_root="${BATS_TEST_DIRNAME}/../.."
  for workflow in "${repo_root}/.github/workflows/merge.yml" "${repo_root}/.github/workflows/pull_request.yml"; do
    clones="$(grep -c 'bats-core.git /tmp/bats-core' "$workflow")"
    pinned="$(grep -c -- "--branch ${tag} https://github.com/bats-core/bats-core.git" "$workflow")"
    verified="$(grep -c "rev-parse HEAD)\" = \"${commit}\"" "$workflow")"
    [ "$clones" -eq "$pinned" ]
    [ "$clones" -eq "$verified" ]
  done
}
