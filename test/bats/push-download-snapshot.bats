#!/usr/bin/env bats
#
# Tests for scripts/metrics/push-download-snapshot.sh (issue #3590 class).
#
# The script must push a regenerated release-download snapshot to main without
# ever using a rebase, so a concurrent push can never leave a conflicted tree
# that cascades into "Pulling is not possible because you have unmerged files".

SCRIPT="scripts/metrics/push-download-snapshot.sh"
WORKFLOW=".github/workflows/release-downloads-metrics.yml"

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
  diff)  exit "${FAKE_GIT_DIFF_RC:-1}" ;;  # `git diff --quiet -- <data_file>`
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

  # Fake `bun` (the collector): the fake `git diff` decides whether a change
  # exists, so this only needs to succeed. It records a `bun-collect` marker in
  # the SAME ordered log the fake `git` writes to, so a test can prove the
  # collector runs AFTER `git reset` (on fresh main) on every attempt.
  cat > "${BIN_DIR}/bun" <<'FAKE'
#!/usr/bin/env bash
echo "bun-collect" >> "${FAKE_GIT_LOG}"
exit 0
FAKE
  chmod +x "${BIN_DIR}/bun"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

run_push() {
  run env PATH="${BIN_DIR}:${PATH}" \
    FAKE_GIT_LOG="$GIT_LOG" FAKE_GIT_STATE="$GIT_STATE" \
    SNAPSHOT_RETRY_SLEEP=0 "$@" \
    bash "$SCRIPT"
}

# Collapse the command log to just the ordered fetch/reset/collect markers, one
# token per line, so a test can assert the exact per-attempt regeneration order.
# The collector (`bun-collect`) MUST land after `reset` on every attempt.
order_tokens() {
  awk '
    /fetch origin main/          { print "fetch"; next }
    /reset --hard origin\/main/  { print "reset"; next }
    /bun-collect/                { print "collect" }
  ' "$GIT_LOG" | tr "\n" " "
}

@test "pushes on the first attempt when the snapshot changed" {
  run_push FAKE_GIT_DIFF_RC=1
  [ "$status" -eq 0 ]
  [[ "$output" == *"Pushed download snapshot to main"* ]]
  grep -q "reset --hard origin/main" "$GIT_LOG"
  grep -q "push origin HEAD:main" "$GIT_LOG"
  ! grep -q "rebase" "$GIT_LOG"
}

@test "no-op (no push) when the snapshot already matches main" {
  run_push FAKE_GIT_DIFF_RC=0
  [ "$status" -eq 0 ]
  [[ "$output" == *"already up to date"* ]]
  ! grep -q "push origin" "$GIT_LOG"
}

@test "regenerates the snapshot after resetting to fresh main" {
  # The collector (bun) must run on top of the reset, not once before. Assert the
  # exact per-attempt order fetch -> reset -> collect: this FAILS if the collector
  # were moved before the reset (order would be fetch collect reset) or skipped
  # entirely (the trailing "collect" token would be absent).
  run_push FAKE_GIT_DIFF_RC=1
  [ "$status" -eq 0 ]
  grep -q "fetch origin main" "$GIT_LOG"
  grep -q "reset --hard origin/main" "$GIT_LOG"
  [ "$(order_tokens)" = "fetch reset collect " ]
}

@test "retries after losing a race, then succeeds — without rebasing" {
  run_push FAKE_GIT_DIFF_RC=1 FAKE_GIT_PUSH_FAIL_UNTIL=1
  [ "$status" -eq 0 ]
  [[ "$output" == *"lost a race"* ]]
  [[ "$output" == *"Pushed download snapshot to main"* ]]
  # Two push attempts, each preceded by a fresh reset (no lingering rebase state).
  [ "$(grep -c 'push origin HEAD:main' "$GIT_LOG")" -eq 2 ]
  [ "$(grep -c 'reset --hard origin/main' "$GIT_LOG")" -eq 2 ]
  ! grep -q "rebase" "$GIT_LOG"
  # The collector must regenerate on fresh main for EACH attempt (never skipped
  # on the retry): fetch -> reset -> collect repeated once per attempt.
  [ "$(order_tokens)" = "fetch reset collect fetch reset collect " ]
}

@test "fails cleanly after exhausting all attempts" {
  run_push FAKE_GIT_DIFF_RC=1 FAKE_GIT_PUSH_ALWAYS_FAIL=1
  [ "$status" -eq 1 ]
  [[ "$output" == *"Failed to push download snapshot to main after 5 attempts"* ]]
  [ "$(grep -c 'push origin HEAD:main' "$GIT_LOG")" -eq 5 ]
  ! grep -q "rebase" "$GIT_LOG"
}

wiring_requires_yq() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo "yq is required in CI to verify workflow wiring" >&2
    return 1
  fi
  skip "yq not installed"
}

@test "workflow calls the script and drops the fragile rebase loop" {
  # Regression guard for the wiring. Parse the YAML with yq (the repo's canonical
  # workflow parser, see release-workflow-wiring.bats) and assert against the
  # STRUCTURE — the concurrency group + the snapshot job's step run scripts —
  # rather than grepping raw text a comment or another job could satisfy.
  wiring_requires_yq

  run yq -r '.concurrency.group' "$WORKFLOW"
  [ "$status" -eq 0 ]
  [[ "$output" == "release-download-metrics" ]]

  run yq -r '.concurrency."cancel-in-progress"' "$WORKFLOW"
  [[ "$output" == "false" ]]

  # The snapshot job's step run scripts, joined; the script must be invoked here
  # and the fragile rebase loop must not reappear.
  local runs
  runs="$(yq -r '.jobs.snapshot.steps[] | (.run // "")' "$WORKFLOW")"
  [[ "$runs" == *"bash scripts/metrics/push-download-snapshot.sh"* ]]
  [[ "$runs" != *"git pull --rebase origin main"* ]]
}
