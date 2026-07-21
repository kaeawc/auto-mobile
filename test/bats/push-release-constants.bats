#!/usr/bin/env bats
#
# Tests for scripts/push-release-constants.sh.
#
# The nightly checksum update pushes straight to main instead of opening a PR
# (which burned an external code review on a generated constant bump and could
# wedge auto-merge behind cancelled check runs — PR #4090). Like the badge push
# it must never rebase, so a concurrent push can never leave a conflicted tree.

SCRIPT="scripts/push-release-constants.sh"
WORKFLOW=".github/workflows/nightly.yml"

setup() {
  TEST_ROOT="$(mktemp -d)"
  BIN_DIR="${TEST_ROOT}/bin"
  mkdir -p "$BIN_DIR"
  GIT_LOG="${TEST_ROOT}/git.log"
  GIT_STATE="${TEST_ROOT}/push.state"

  # Fake `git` shadowing the real one; other coreutils stay real.
  cat > "${BIN_DIR}/git" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "${FAKE_GIT_LOG}"
case "$1" in
  diff)  exit "${FAKE_GIT_DIFF_RC:-1}" ;;  # `git diff --quiet`
  push)
    state="${FAKE_GIT_STATE}"
    n="$(cat "$state" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" > "$state"
    [ "${FAKE_GIT_PUSH_ALWAYS_FAIL:-0}" = "1" ] && exit 1
    [ "$n" -le "${FAKE_GIT_PUSH_FAIL_UNTIL:-0}" ] && exit 1
    exit 0 ;;
  *) exit 0 ;;
esac
FAKE
  chmod +x "${BIN_DIR}/git"

  # Fake constants generator: the fake `git diff` decides whether a change
  # exists, so this only needs to succeed.
  GENERATE_SCRIPT="${TEST_ROOT}/fake-generate.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$GENERATE_SCRIPT"
  chmod +x "$GENERATE_SCRIPT"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

run_push() {
  run env PATH="${BIN_DIR}:${PATH}" \
    FAKE_GIT_LOG="$GIT_LOG" FAKE_GIT_STATE="$GIT_STATE" \
    RELEASE_CONSTANTS_GENERATE_SCRIPT="$GENERATE_SCRIPT" \
    RELEASE_CONSTANTS_COMMIT_MESSAGE="chore: update CtrlProxy APK SHA256" \
    RELEASE_CONSTANTS_RETRY_SLEEP=0 "$@" \
    bash "$SCRIPT"
}

@test "pushes on the first attempt when the constants changed" {
  run_push FAKE_GIT_DIFF_RC=1
  [ "$status" -eq 0 ]
  [[ "$output" == *"Pushed release constants update to main"* ]]
  grep -q "reset --hard origin/main" "$GIT_LOG"
  grep -q "push origin HEAD:main" "$GIT_LOG"
  ! grep -q "rebase" "$GIT_LOG"
}

@test "no-op (no push) when constants already match main" {
  run_push FAKE_GIT_DIFF_RC=0
  [ "$status" -eq 0 ]
  [[ "$output" == *"already up to date"* ]]
  ! grep -q "push origin" "$GIT_LOG"
}

@test "stages tracked edits only, never the downloaded artifacts" {
  # `git add -A` would sweep in untracked build artifacts left in the work tree.
  run_push FAKE_GIT_DIFF_RC=1
  [ "$status" -eq 0 ]
  grep -q "add -u" "$GIT_LOG"
  ! grep -q "add -A" "$GIT_LOG"
}

@test "refuses to run without a commit message" {
  run env PATH="${BIN_DIR}:${PATH}" \
    FAKE_GIT_LOG="$GIT_LOG" FAKE_GIT_STATE="$GIT_STATE" \
    RELEASE_CONSTANTS_GENERATE_SCRIPT="$GENERATE_SCRIPT" \
    bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"RELEASE_CONSTANTS_COMMIT_MESSAGE must be set"* ]]
  [ ! -s "$GIT_LOG" ]
}

@test "retries after losing a race, then succeeds — without rebasing" {
  run_push FAKE_GIT_DIFF_RC=1 FAKE_GIT_PUSH_FAIL_UNTIL=1
  [ "$status" -eq 0 ]
  [[ "$output" == *"lost a race"* ]]
  [[ "$output" == *"Pushed release constants update to main"* ]]
  # Two push attempts, each preceded by a fresh reset (no lingering rebase state).
  [ "$(grep -c 'push origin HEAD:main' "$GIT_LOG")" -eq 2 ]
  [ "$(grep -c 'reset --hard origin/main' "$GIT_LOG")" -eq 2 ]
  ! grep -q "rebase" "$GIT_LOG"
}

@test "fails cleanly after exhausting all attempts" {
  run_push FAKE_GIT_DIFF_RC=1 FAKE_GIT_PUSH_ALWAYS_FAIL=1
  [ "$status" -eq 1 ]
  [[ "$output" == *"Failed to push release constants update to main after 3 attempts"* ]]
  [ "$(grep -c 'push origin HEAD:main' "$GIT_LOG")" -eq 3 ]
  ! grep -q "rebase" "$GIT_LOG"
}

@test "nightly.yml pushes to main instead of opening a checksum PR" {
  grep -q "bash scripts/push-release-constants.sh" "$WORKFLOW"
  # The admin token + full history are what let the push bypass green-main.
  grep -q "token: \${{ secrets.AUTO_MOBILE_PR_TOKEN }}" "$WORKFLOW"
  grep -q "fetch-depth: 0" "$WORKFLOW"
  # The PR path must not come back: it spent an external code review on a
  # generated constant bump and wedged behind cancelled check runs (PR #4090).
  ! grep -q "peter-evans/create-pull-request" "$WORKFLOW"
  ! grep -q "gh pr merge" "$WORKFLOW"
  ! grep -q "auto-update/nightly-sha256" "$WORKFLOW"
}
