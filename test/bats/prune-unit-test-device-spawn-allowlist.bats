#!/usr/bin/env bats
# bats file_tags=serial
# Creates repo-relative unit fixtures; serialize against tree-scanning gates.

setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  fixture_dir="$(mktemp -d test/.tmp-spawn-guard-fixture-XXXXXX)"
  fixture="$fixture_dir/example.test.ts"
  printf '%s\n' 'import { test } from "bun:test";' 'test("blocked", () => { Bun.spawnSync(["adb", "devices"]); });' > "$fixture"
  printf '%s\n' "$fixture" > "$BATS_TEST_TMPDIR/files.txt"
  export AUTOMOBILE_SPAWN_GUARD_ALLOWLIST="$BATS_TEST_TMPDIR/allowlist.txt"
  printf '# fixture allow-list\n%s\n' "$fixture" > "$AUTOMOBILE_SPAWN_GUARD_ALLOWLIST"
  export AUTOMOBILE_SPAWN_GUARD_TEST_RUNNER="$BATS_TEST_TMPDIR/runner"
  export RUNNER_CALLS="$BATS_TEST_TMPDIR/calls"
  export RUNNER_MODE=hit
  cat > "$AUTOMOBILE_SPAWN_GUARD_TEST_RUNNER" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RUNNER_CALLS"
if [[ "$RUNNER_MODE" == hit ]]; then
  printf '%s\tadb\t["adb","devices"]\n' "$1" >> "$AUTOMOBILE_SPAWN_GUARD_CENSUS_FILE"
  exit 1
fi
[[ "$RUNNER_MODE" == clean ]] && exit 0
exit 1
STUB
  chmod +x "$AUTOMOBILE_SPAWN_GUARD_TEST_RUNNER"
  script="${PRUNE_SCRIPT_UNDER_TEST:-scripts/prune-unit-test-device-spawn-allowlist.sh}"
}

teardown() {
  rm -rf "$fixture_dir"
}

run_census() {
  run bash "$script" --repeat 1 --file-list "$BATS_TEST_TMPDIR/files.txt" \
    --batch-log-dir "$BATS_TEST_TMPDIR/batches" "$@"
}

@test "failed batch retries, retains a recorded spawner, and prints reports" {
  run_census
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$RUNNER_CALLS" | tr -d ' ')" -eq 2 ]
  [[ "$output" == *"pass-1-single: 1 files, exit 1"* ]]
  [[ "$output" == *"Per-file/tool spawn counts"* ]]
  [ "$(cat "$BATS_TEST_TMPDIR"/batches/run.*/spawners.txt)" = "$fixture" ]
}

@test "clean listed file is shrinkable and check mode exits one" {
  export RUNNER_MODE=clean
  run_census
  [ "$status" -eq 1 ]
  [[ "$output" == *"Run with --update"* ]]
  [ "$(cat "$BATS_TEST_TMPDIR"/batches/run.*/shrinkable.txt)" = "$fixture" ]
}

@test "failed batch without recorded hits retries and exits uncertain" {
  export RUNNER_MODE=uncertain
  run_census --update
  [ "$status" -eq 2 ]
  [ "$(wc -l < "$RUNNER_CALLS" | tr -d ' ')" -eq 2 ]
  [[ "$output" == *"Per-file/tool spawn counts"* ]]
  [[ "$output" == *"Census incomplete"* ]]
  [ "$(cat "$BATS_TEST_TMPDIR"/batches/run.*/uncertain.txt)" = "$fixture" ]
  [ "$(tail -n 1 "$AUTOMOBILE_SPAWN_GUARD_ALLOWLIST")" = "$fixture" ]
}

@test "update retains failing recorded spawners and preserves unscanned entries" {
  printf '%s\n' 'test/unscanned.test.ts' >> "$AUTOMOBILE_SPAWN_GUARD_ALLOWLIST"
  run_census --update
  [ "$status" -eq 0 ]
  [[ "$output" == *"Updated allow-list: 2 entries"* ]]
  [ "$(sed -n '2p' "$AUTOMOBILE_SPAWN_GUARD_ALLOWLIST")" = "$fixture" ]
  [ "$(tail -n 1 "$AUTOMOBILE_SPAWN_GUARD_ALLOWLIST")" = 'test/unscanned.test.ts' ]
}

@test "update removes clean entries on a temporary allow-list" {
  export RUNNER_MODE=clean
  run_census --update
  [ "$status" -eq 0 ]
  [ "$(cat "$AUTOMOBILE_SPAWN_GUARD_ALLOWLIST")" = '# fixture allow-list' ]
}

@test "real single-fixture Bun census records and blocks the launch" {
  # Bun's filter discovery skips hidden dirs; explicitly select the tiny fixture.
  cat > "$AUTOMOBILE_SPAWN_GUARD_TEST_RUNNER" <<'RUNNER'
#!/usr/bin/env bash
exec bun test --isolate --timeout 20000 "./$1"
RUNNER
  export AUTOMOBILE_LOG_DIR="$BATS_TEST_TMPDIR/logs"
  export AUTOMOBILE_DATA_DIR="$BATS_TEST_TMPDIR/data"
  run_census
  [ "$status" -eq 0 ]
  [[ "$output" == *"pass-1-single: 1 files, exit 1"* ]]
  [ "$(cat "$BATS_TEST_TMPDIR"/batches/run.*/spawners.txt)" = "$fixture" ]
  [[ "$(cat "$BATS_TEST_TMPDIR"/batches/run.*/records.tsv)" == *$'\tadb\t'* ]]
  [[ "$(cat "$BATS_TEST_TMPDIR"/batches/run.*/*.log)" == *"unit-test census blocked launch"* ]]
}
