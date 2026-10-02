#!/usr/bin/env bats

setup() {
  FIXTURE="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$FIXTURE/scripts/ci" "$FIXTURE/test/daemon" "$FIXTURE/test/setup"
  FIXTURE="$(cd "$FIXTURE" && pwd -P)"
  cp "$BATS_TEST_DIRNAME/../../scripts/ci/auto-advance-race-guard.sh" "$FIXTURE/scripts/ci/"
  SCRIPT="$FIXTURE/scripts/ci/auto-advance-race-guard.sh"
  ALLOWLIST="$FIXTURE/scripts/ci/auto-advance-race-allowlist.txt"
  printf '# fixture allowlist\n' > "$ALLOWLIST"
  export CALL_LOG="$BATS_TEST_TMPDIR/calls"
  export AUTOADV_BUN="$BATS_TEST_TMPDIR/bun"
  export FIXTURE
  cat > "$AUTOADV_BUN" << 'STUB'
#!/usr/bin/env bash
set -euo pipefail
# An overlapping process would encounter the same lock directory.
mkdir "$CALL_LOG.lock"
trap 'rmdir "$CALL_LOG.lock"' EXIT
[[ "$PWD" == "$FIXTURE" ]]
case "$TMPDIR/" in "$FIXTURE/"*) exit 99 ;; esac
[[ -d "$TMPDIR" ]]
printf '%s|%s|%s\n' "${AUTOADV_DELAY_MS-unset}" "$*" "$TMPDIR" >> "$CALL_LOG"
file="${!#}"
echo "stub output for $file"
case "$file" in
  *both.test.ts) exit 1 ;;
  *race.test.ts) [[ "${AUTOADV_DELAY_MS-unset}" == unset ]] ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "$AUTOADV_BUN"
}

fixture_test() {
  printf '%s\n' "${2:-enableAutoAdvance}" > "$FIXTURE/$1"
}

@test "discovery filters, sorts and honours commented allowlist entries" {
  fixture_test test/z.test.ts
  fixture_test test/a.test.ts
  fixture_test test/skip.test.ts
  fixture_test test/unrelated.test.ts 'no auto advance here'
  fixture_test test/socket.integration.test.ts
  fixture_test test/daemon/manager.test.ts
  printf 'enableAutoAdvance\n' > "$FIXTURE/test/ignored.ts"
  printf '\n# comment\n  test/skip.test.ts  # tracked by issue #123  \n\n' >> "$ALLOWLIST"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *$'Selected 2 file(s):\n  test/a.test.ts\n  test/z.test.ts'* ]]
  [[ "$output" == *'selected=2 passed=2 guard-only=0 fail-both=0 skipped-by-allowlist=1'* ]]
  [ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 2 ]
  [[ "$(cat "$CALL_LOG")" != *skip.test.ts* ]]
}

@test "empty discovery and fully allowlisted explicit selections exit 2" {
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *'Refusing empty test selection'* ]]
  fixture_test test/pass.test.ts
  printf 'test/pass.test.ts\n' >> "$ALLOWLIST"
  run bash "$SCRIPT" test/pass.test.ts
  [ "$status" -eq 2 ]
  [ ! -e "$CALL_LOG" ]
}

@test "passing guarded file exits 0 without a redundant baseline run" {
  fixture_test test/pass.test.ts
  run bash "$SCRIPT" test/pass.test.ts
  [ "$status" -eq 0 ]
  [[ "$output" == *'passed=1 guard-only=0 fail-both=0'* ]]
  [ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 1 ]
}

@test "guard-only failure retries once without preload or delay and prints guarded log" {
  fixture_test test/race.test.ts
  # The baseline must remove even an inherited delay setting.
  AUTOADV_DELAY_MS=999 run bash "$SCRIPT" test/race.test.ts
  [ "$status" -eq 1 ]
  [[ "$output" == *'GUARD-ONLY FAILURE: test/race.test.ts'* ]]
  [[ "$output" == *'stub output for test/race.test.ts'* ]]
  [[ "$output" == *'inject a fake'* ]]
  [ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 2 ]
  [[ "$(sed -n '1p' "$CALL_LOG")" == '10|test --preload ./test/setup/autoAdvanceRaceGuard.ts test/race.test.ts|'* ]]
  [[ "$(sed -n '2p' "$CALL_LOG")" == 'unset|test test/race.test.ts|'* ]]
}

@test "failure in both runs exits 3 and is not counted as a guard finding" {
  fixture_test test/both.test.ts
  run bash "$SCRIPT" test/both.test.ts
  [ "$status" -eq 3 ]
  [[ "$output" == *'WARNING: fails without guard too (not guard findings):'* ]]
  [[ "$output" == *'test/both.test.ts'* ]]
  [[ "$output" == *'guard-only=0 fail-both=1'* ]]
  [ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 2 ]
}

@test "files run serially one per process with temporary child storage outside repo" {
  fixture_test test/z.test.ts
  fixture_test test/a.test.ts
  mkdir "$FIXTURE/tmp"
  TMPDIR="$FIXTURE/tmp" RUNNER_TEMP="$FIXTURE/tmp" run bash "$SCRIPT" test/z.test.ts test/a.test.ts
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$CALL_LOG" | tr -d ' ')" -eq 2 ]
  [[ "$(sed -n '1p' "$CALL_LOG")" == '10|test --preload ./test/setup/autoAdvanceRaceGuard.ts test/a.test.ts|'* ]]
  [[ "$(sed -n '2p' "$CALL_LOG")" == '10|test --preload ./test/setup/autoAdvanceRaceGuard.ts test/z.test.ts|'* ]]
  temp_dir="$(cut -d '|' -f 3 "$CALL_LOG" | head -n 1)"
  [[ "$temp_dir" != "$FIXTURE"/* ]]
  [ ! -d "$temp_dir" ]
}

@test "mixed failures keep fail-both exit precedence and separate counts" {
  fixture_test test/race.test.ts
  fixture_test test/both.test.ts
  run bash "$SCRIPT" test/race.test.ts test/both.test.ts
  [ "$status" -eq 3 ]
  [[ "$output" == *'selected=2 passed=0 guard-only=1 fail-both=1'* ]]
}

@test "help documents exit codes without starting bun" {
  run bash "$SCRIPT" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *'3 fails without guard too'* ]]
  [ ! -e "$CALL_LOG" ]
}
