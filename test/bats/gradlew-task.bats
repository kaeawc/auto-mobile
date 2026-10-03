#!/usr/bin/env bats

setup() {
  bats_require_minimum_version 1.5.0
  TEST_ROOT="$(mktemp -d)"
  TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
  mkdir -p "$TEST_ROOT/scripts/android" "$TEST_ROOT/android"
  SCRIPT="$TEST_ROOT/scripts/android/gradlew_task.sh"
  cp scripts/android/gradlew_task.sh "$SCRIPT"
  cat > "$TEST_ROOT/android/gradlew" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$(pwd -P)" "$@" > ../invocation
echo 'fake gradle stdout'
echo 'fake gradle stderr' >&2
exit "${FAKE_GRADLE_EXIT:-0}"
EOF
  chmod +x "$TEST_ROOT/android/gradlew"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

@test "no arguments prints usage on stderr without invoking Gradle" {
  run --separate-stderr "$SCRIPT"
  [ "$status" -eq 2 ]
  [ -z "$output" ]
  [[ "$stderr" == "Usage: scripts/android/gradlew_task.sh <gradle-task-or-flag>..."* ]]
  [ ! -e "$TEST_ROOT/invocation" ]
}

@test "help prints usage on stdout without invoking Gradle" {
  for flag in --help -h; do
    run --separate-stderr "$SCRIPT" "$flag"
    [ "$status" -eq 0 ]
    [[ "$output" == "Usage: scripts/android/gradlew_task.sh <gradle-task-or-flag>..."* ]]
    [ -z "$stderr" ]
    [ ! -e "$TEST_ROOT/invocation" ]
  done
}

@test "missing Gradle wrapper reports an error" {
  rm "$TEST_ROOT/android/gradlew"
  run --separate-stderr "$SCRIPT" help
  [ "$status" -eq 2 ]
  [[ "$stderr" == "error: "*"android/gradlew is missing or not executable" ]]
  [ ! -e "$TEST_ROOT/invocation" ]
}

@test "non-executable Gradle wrapper reports an error" {
  chmod -x "$TEST_ROOT/android/gradlew"
  run --separate-stderr "$SCRIPT" help
  [ "$status" -eq 2 ]
  [[ "$stderr" == "error: "*"android/gradlew is missing or not executable" ]]
  [ ! -e "$TEST_ROOT/invocation" ]
}

@test "runs from android with exact ordered arguments from another cwd" {
  cd /
  run --separate-stderr "$SCRIPT" :junit-runner:test --tests '*Foo Bar*' --stacktrace
  [ "$status" -eq 0 ]
  expected="$(printf '%s\n' "$(cd "$TEST_ROOT/android" && pwd -P)" \
    :junit-runner:test --tests '*Foo Bar*' --stacktrace)"
  [ "$(cat "$TEST_ROOT/invocation")" = "$expected" ]
}

@test "saves combined output under scratch and prints the log path twice" {
  run --separate-stderr "$SCRIPT" help
  [ "$status" -eq 0 ]
  logs=("$TEST_ROOT"/scratch/gradlew-*.log)
  [ "${#logs[@]}" -eq 1 ]
  [ -f "${logs[0]}" ]
  [ "$(cat "${logs[0]}")" = $'fake gradle stdout\nfake gradle stderr' ]
  [ "$output" = $'fake gradle stdout\nfake gradle stderr' ]
  [ "$stderr" = "$(printf 'gradlew log: %s\ngradlew log: %s' "${logs[0]}" "${logs[0]}")" ]
}

@test "propagates Gradle failure and still saves output and prints the log path twice" {
  run --separate-stderr env FAKE_GRADLE_EXIT=3 "$SCRIPT" help
  [ "$status" -eq 3 ]
  logs=("$TEST_ROOT"/scratch/gradlew-*.log)
  [ "${#logs[@]}" -eq 1 ]
  [ -f "${logs[0]}" ]
  [ "$(cat "${logs[0]}")" = $'fake gradle stdout\nfake gradle stderr' ]
  [ "$stderr" = "$(printf 'gradlew log: %s\ngradlew log: %s' "${logs[0]}" "${logs[0]}")" ]
}
