#!/usr/bin/env bats
#
# Tests for scripts/validate-no-datetime-now-literal.sh

SCRIPT="scripts/validate-no-datetime-now-literal.sh"

@test "passes when no string-literal SQL time-expression defaults exist" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No string-literal SQL time-expression defaults found in migrations."* ]]
}

@test "fails on a string-literal datetime('now') default" {
  local tmp="src/db/migrations/__datetime_now_guard_fixture__.ts"
  printf '.addColumn("created_at", "text", col => col.notNull().defaultTo("datetime(%s)"))\n' "'now'" > "$tmp"
  run bash "$SCRIPT"
  rm -f "$tmp"
  [ "$status" -ne 0 ]
  [[ "$output" == *"SQL time-expression passed as a string literal"* ]]
}

@test "fails on a string-literal CURRENT_TIMESTAMP default" {
  local tmp="src/db/migrations/__current_timestamp_guard_fixture__.ts"
  printf '.addColumn("created_at", "text", col => col.notNull().defaultTo("CURRENT_TIMESTAMP"))\n' > "$tmp"
  run bash "$SCRIPT"
  rm -f "$tmp"
  [ "$status" -ne 0 ]
  [[ "$output" == *"SQL time-expression passed as a string literal"* ]]
}

@test "does not flag legitimate value defaults" {
  local tmp="src/db/migrations/__value_default_guard_fixture__.ts"
  {
    printf '.addColumn("config_json", "text", col => col.notNull().defaultTo("{}"))\n'
    printf '.addColumn("status", "text", col => col.notNull().defaultTo("success"))\n'
    printf '.addColumn("note", "text", col => col.notNull().defaultTo(""))\n'
    printf '.addColumn("created_at", "text", col => col.notNull().defaultTo(sql`(datetime(%s))`))\n' "'now'"
  } > "$tmp"
  run bash "$SCRIPT"
  rm -f "$tmp"
  [ "$status" -eq 0 ]
}
