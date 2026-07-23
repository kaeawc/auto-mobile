#!/usr/bin/env bats

SCRIPT="scripts/codex-automation-thread-report.sh"

setup() {
  ABS="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  CODEX_FIXTURE="$(mktemp -d)"
  mkdir -p "$CODEX_FIXTURE/sessions" "$CODEX_FIXTURE/archived_sessions"
}

teardown() {
  rm -rf "$CODEX_FIXTURE"
}

@test "reports first and last runs by timestamp across live and archived sessions" {
  printf '%s\n' \
    '{"timestamp":"2026-07-23T12:00:00Z","payload":{"content":[{"text":"Automation: Test automation"}]}}' \
    > "$CODEX_FIXTURE/sessions/newer.jsonl"
  printf '%s\n' \
    '{"timestamp":"2026-07-22T12:00:00Z","payload":{"content":[{"text":"Automation: Test automation"}]}}' \
    > "$CODEX_FIXTURE/archived_sessions/older.jsonl"

  run "$ABS" --codex-home "$CODEX_FIXTURE" --title "Test automation"

  [ "$status" -eq 0 ]
  [[ "$output" == *"First observed run: 2026-07-22T12:00:00Z"* ]]
  [[ "$output" == *"Last observed run: 2026-07-23T12:00:00Z"* ]]
}

@test "reports a creation call whose JSON arguments contain ordinary whitespace" {
  printf '%s\n' \
    '{"timestamp":"2026-07-23T12:00:00Z","payload":{"type":"function_call","name":"automation_update","arguments":"{\"mode\": \"create\", \"name\": \"Test automation\"}"}}' \
    > "$CODEX_FIXTURE/sessions/creation.jsonl"

  run "$ABS" --codex-home "$CODEX_FIXTURE" --title "Test automation"

  [ "$status" -eq 0 ]
  [[ "$output" == *"\`Test automation\`: 1 create call(s)"* ]]
}

@test "ignores a creation call whose arguments are not a JSON object" {
  printf '%s\n' \
    '{"timestamp":"2026-07-23T12:00:00Z","payload":{"type":"function_call","name":"automation_update","arguments":"[]"}}' \
    > "$CODEX_FIXTURE/sessions/invalid-creation.jsonl"

  run "$ABS" --codex-home "$CODEX_FIXTURE" --title "Test automation"

  [ "$status" -eq 0 ]
  [[ "$output" == *"\`Test automation\`: no creation event found"* ]]
}
