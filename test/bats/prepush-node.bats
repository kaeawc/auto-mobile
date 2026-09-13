#!/usr/bin/env bats

SCRIPT="scripts/prepush-node.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  COMMAND_LOG="${MOCK_BIN}/commands.log"
  export COMMAND_LOG

  cat > "${MOCK_BIN}/git" <<'SCRIPT'
#!/bin/bash
printf 'git %s\n' "$*" >> "$COMMAND_LOG"
if [[ "$1" == "merge-base" ]]; then
  exit "${MOCK_MERGE_BASE_STATUS:-0}"
fi
SCRIPT
  chmod +x "${MOCK_BIN}/git"

  cat > "${MOCK_BIN}/bun" <<'SCRIPT'
#!/bin/bash
printf 'bun %s\n' "$*" >> "$COMMAND_LOG"
SCRIPT
  chmod +x "${MOCK_BIN}/bun"

  cat > "${MOCK_BIN}/bash" <<'SCRIPT'
#!/bin/bash
printf 'bash %s\n' "$*" >> "$COMMAND_LOG"
SCRIPT
  chmod +x "${MOCK_BIN}/bash"
}

teardown() {
  rm -rf "$MOCK_BIN"
}

@test "runs Node gates in fail-fast order" {
  run env PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(cat "$COMMAND_LOG")" = $'git fetch --quiet origin main\ngit merge-base --is-ancestor origin/main HEAD\nbun run format:check\nbun run typecheck\nbun run lint\nbun test test/lint/\nbash scripts/test-ts.sh unit\nbash scripts/validate-bun-test-timings.sh' ]
  [[ "$output" == *"Node pre-push validation passed"* ]]
}

@test "changed mode uses the existing changed-test lane" {
  run env PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT" --changed

  [ "$status" -eq 0 ]
  grep -Fx 'bash scripts/test-ts.sh changed' "$COMMAND_LOG"
  grep -Fx 'bash scripts/validate-bun-test-timings.sh' "$COMMAND_LOG"
}

@test "stale base stops before local gates" {
  run env MOCK_MERGE_BASE_STATUS=1 PATH="${MOCK_BIN}:${PATH}" /bin/bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"does not contain origin/main"* ]]
  [ "$(cat "$COMMAND_LOG")" = $'git fetch --quiet origin main\ngit merge-base --is-ancestor origin/main HEAD' ]
}
