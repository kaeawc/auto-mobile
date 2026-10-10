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
  # Fake build-brief lives in its own dir so tests opt in by prepending it to PATH.
  mkdir -p "$TEST_ROOT/bin"
  cat > "$TEST_ROOT/bin/build-brief" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$(pwd -P)" "$@" > "$TEST_ROOT/bb-invocation"
printf '%s\n' "${BUILD_BRIEF_LOG_DIR:-}" > "$TEST_ROOT/bb-logdir"
echo 'fake build-brief summary'
exit "${FAKE_BB_EXIT:-0}"
EOF
  chmod +x "$TEST_ROOT/bin/build-brief"
  export TEST_ROOT
  unset CI
  # A real build-brief on the developer's PATH must not leak into the plain-mode
  # tests, so opt out by default; build-brief tests clear it via BB_ENV.
  export AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF=1
  BB_PATH="$TEST_ROOT/bin:$PATH"
  # PATH containing only the coreutils the script needs, never build-brief.
  mkdir -p "$TEST_ROOT/minbin"
  for tool in bash dirname mkdir date tee; do
    ln -s "$(command -v "$tool")" "$TEST_ROOT/minbin/$tool"
  done
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

@test "build-brief is used when present, with -- and identical arguments from android/" {
  cd /
  run --separate-stderr env -u AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF PATH="$BB_PATH" "$SCRIPT" :junit-runner:test --tests '*Foo Bar*' --stacktrace
  [ "$status" -eq 0 ]
  [ "$output" = "fake build-brief summary" ]
  expected="$(printf '%s\n' "$(cd "$TEST_ROOT/android" && pwd -P)" -- \
    :junit-runner:test --tests '*Foo Bar*' --stacktrace)"
  [ "$(cat "$TEST_ROOT/bb-invocation")" = "$expected" ]
  [ ! -e "$TEST_ROOT/invocation" ]
}

@test "build-brief mode routes raw logs to scratch and does not tee a duplicate log" {
  run --separate-stderr env -u AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF PATH="$BB_PATH" "$SCRIPT" help
  [ "$status" -eq 0 ]
  [ "$(cat "$TEST_ROOT/bb-logdir")" = "$TEST_ROOT/scratch" ]
  logs=("$TEST_ROOT"/scratch/gradlew-*.log)
  [ ! -e "${logs[0]}" ]
  [ -z "$stderr" ]
}

@test "build-brief mode passes through failure exit code and prints the log location" {
  run --separate-stderr env -u AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF PATH="$BB_PATH" FAKE_BB_EXIT=7 "$SCRIPT" help
  [ "$status" -eq 7 ]
  [[ "$stderr" == *"exit 7"*"$TEST_ROOT/scratch"* ]]
}

@test "build-brief is not used under CI" {
  for v in true 1; do
    rm -f "$TEST_ROOT/bb-invocation" "$TEST_ROOT/invocation"
    run --separate-stderr env -u AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF PATH="$BB_PATH" CI=$v "$SCRIPT" help
    [ "$status" -eq 0 ]
    [ ! -e "$TEST_ROOT/bb-invocation" ]
    [ -e "$TEST_ROOT/invocation" ]
  done
}

@test "empty CI does not disable build-brief" {
  run --separate-stderr env -u AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF PATH="$BB_PATH" CI= "$SCRIPT" help
  [ "$status" -eq 0 ]
  [ -e "$TEST_ROOT/bb-invocation" ]
}

@test "build-brief is not used when opted out" {
  run --separate-stderr env -u AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF PATH="$BB_PATH" AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF=1 "$SCRIPT" help
  [ "$status" -eq 0 ]
  [ ! -e "$TEST_ROOT/bb-invocation" ]
  [ -e "$TEST_ROOT/invocation" ]
}

@test "empty opt-out variable does not opt out" {
  run --separate-stderr env -u AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF PATH="$BB_PATH" AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF= "$SCRIPT" help
  [ "$status" -eq 0 ]
  [ -e "$TEST_ROOT/bb-invocation" ]
}

@test "falls back to plain gradlew when build-brief is absent" {
  run --separate-stderr env -u AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF PATH="$TEST_ROOT/minbin" "$SCRIPT" help
  [ "$status" -eq 0 ]
  [ -e "$TEST_ROOT/invocation" ]
  [ ! -e "$TEST_ROOT/bb-invocation" ]
}
