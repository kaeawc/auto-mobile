#!/usr/bin/env bats

SCRIPT="scripts/check-simulator-tcc-sqlite-boundary.sh"
FIXTURE="src/utils/ios-cmdline-tools/SimulatorTccSqliteBoundaryFixture.ts"

teardown() {
  rm -f "$FIXTURE"
}

@test "allows SimulatorTccSqliteClient to own production sqlite3 execution" {
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no direct production sqlite3 invocations"* ]]
}

@test "rejects a direct argv-safe executor call outside the owner" {
  printf '%s\n' \
    'const executor = { executeCommand: async () => undefined };' \
    'executor.executeCommand("sqlite3", ["-json"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"SimulatorTccSqliteBoundaryFixture.ts"* ]]
}

@test "rejects a direct child_process sqlite invocation outside the owner" {
  printf '%s\n' \
    'import { execFile } from "node:child_process";' \
    'execFile("sqlite3", ["-json"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"SimulatorTccSqliteBoundaryFixture.ts"* ]]
}

@test "rejects command variables, aliases, paths, and Bun argv arrays" {
  printf '%s\n' \
    'import { execFile } from "node:child_process";' \
    'const sqlite = "/usr/bin/sqlite3";' \
    'const run = execFile;' \
    'run(sqlite, ["-json"]);' \
    'Bun.spawn(["sqlite3", "-json"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"SimulatorTccSqliteBoundaryFixture.ts"* ]]
}

@test "rejects template shell commands and shell wrappers" {
  {
    echo 'import { exec, execFile } from "node:child_process";'
    echo 'const db = "/tmp/TCC.db";'
    echo 'exec(`sqlite3 ${db} "SELECT 1"`);'
    echo 'execFile("/bin/sh", ["-c", `sqlite3 ${db} "SELECT 1"`]);'
  } > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"SimulatorTccSqliteBoundaryFixture.ts"* ]]
}
