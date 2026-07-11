#!/usr/bin/env bats
#
# Tests for scripts/push-readme-badges.sh (issue #3590).
#
# The script must push a regenerated README badge to main without ever using a
# rebase, so a concurrent badge push can never leave a conflicted tree that
# cascades into "Pulling is not possible because you have unmerged files".

SCRIPT="scripts/push-readme-badges.sh"
WORKFLOW=".github/workflows/merge.yml"

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
  diff)  exit "${FAKE_GIT_DIFF_RC:-1}" ;;  # `git diff --quiet README.md`
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

  # Fake badge updater: the fake `git diff` decides whether a change exists, so
  # this only needs to succeed.
  UPDATE_SCRIPT="${TEST_ROOT}/fake-update.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$UPDATE_SCRIPT"
  chmod +x "$UPDATE_SCRIPT"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

run_push() {
  run env PATH="${BIN_DIR}:${PATH}" \
    FAKE_GIT_LOG="$GIT_LOG" FAKE_GIT_STATE="$GIT_STATE" \
    BADGE_UPDATE_SCRIPT="$UPDATE_SCRIPT" BADGE_RETRY_SLEEP=0 "$@" \
    bash "$SCRIPT"
}

@test "pushes on the first attempt when the badge changed" {
  run_push FAKE_GIT_DIFF_RC=1
  [ "$status" -eq 0 ]
  [[ "$output" == *"Pushed badge update to main"* ]]
  grep -q "reset --hard origin/main" "$GIT_LOG"
  grep -q "push origin HEAD:main" "$GIT_LOG"
  ! grep -q "rebase" "$GIT_LOG"
}

@test "no-op (no push) when badge counts already match main" {
  run_push FAKE_GIT_DIFF_RC=0
  [ "$status" -eq 0 ]
  [[ "$output" == *"already up to date"* ]]
  ! grep -q "push origin" "$GIT_LOG"
}

@test "retries after losing a race, then succeeds — without rebasing" {
  run_push FAKE_GIT_DIFF_RC=1 FAKE_GIT_PUSH_FAIL_UNTIL=1
  [ "$status" -eq 0 ]
  [[ "$output" == *"lost a race"* ]]
  [[ "$output" == *"Pushed badge update to main"* ]]
  # Two push attempts, each preceded by a fresh reset (no lingering rebase state).
  [ "$(grep -c 'push origin HEAD:main' "$GIT_LOG")" -eq 2 ]
  [ "$(grep -c 'reset --hard origin/main' "$GIT_LOG")" -eq 2 ]
  ! grep -q "rebase" "$GIT_LOG"
}

@test "fails cleanly after exhausting all attempts" {
  run_push FAKE_GIT_DIFF_RC=1 FAKE_GIT_PUSH_ALWAYS_FAIL=1
  [ "$status" -eq 1 ]
  [[ "$output" == *"Failed to push badge update to main after 3 attempts"* ]]
  [ "$(grep -c 'push origin HEAD:main' "$GIT_LOG")" -eq 3 ]
  ! grep -q "rebase" "$GIT_LOG"
}

@test "merge.yml serializes the badge job and calls the script" {
  # Regression guard for the wiring: concurrency group + script invocation.
  grep -q "group: update-readme-badges" "$WORKFLOW"
  grep -q "cancel-in-progress: false" "$WORKFLOW"
  grep -q "bash scripts/push-readme-badges.sh" "$WORKFLOW"
  # The fragile rebase-and-push loop must not come back.
  ! grep -q "git pull --rebase origin main" "$WORKFLOW"
}
