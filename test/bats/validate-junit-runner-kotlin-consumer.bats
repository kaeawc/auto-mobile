#!/usr/bin/env bats

SCRIPT="scripts/android/validate-junit-runner-kotlin-consumer.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  export JUNIT_CONSUMER_ANDROID_DIR="${TEST_ROOT}/android"
  export JUNIT_CONSUMER_SCRATCH_DIR="${TEST_ROOT}/scratch"
  export JUNIT_CONSUMER_LOG_TAIL_LINES=7
  export FAKE_GRADLE_CALLS="${TEST_ROOT}/calls"
  export FAKE_GRADLE_LOG="${TEST_ROOT}/failure.log"
  export FAKE_GRADLE_FAIL_STEP=0
  mkdir -p "${JUNIT_CONSUMER_ANDROID_DIR}/gradle"
  printf 'GROUP=dev.example\nVERSION_NAME=1.2.3\n' > "${JUNIT_CONSUMER_ANDROID_DIR}/gradle.properties"
  printf 'build-kotlin-consumer = "2.2.21"\n' > "${JUNIT_CONSUMER_ANDROID_DIR}/gradle/libs.versions.toml"
  cat > "${JUNIT_CONSUMER_ANDROID_DIR}/gradlew" <<'GRADLE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_GRADLE_CALLS"
step=$(wc -l < "$FAKE_GRADLE_CALLS")
if [[ "$step" -eq "$FAKE_GRADLE_FAIL_STEP" ]]; then
  cat "$FAKE_GRADLE_LOG" >&2
  exit 23
fi
echo "BUILD SUCCESSFUL"
GRADLE
  chmod +x "${JUNIT_CONSUMER_ANDROID_DIR}/gradlew"
  {
    printf 'preamble\n* What went wrong:\nconsumer failure detail\n\n* Try:\nexcluded advice\n'
    for ((i = 1; i <= 500; i++)); do
      printf 'log-line-%s\n' "$i"
    done
  } > "$FAKE_GRADLE_LOG"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

@test "publish failure prints the first error block and tail, preserving exit code" {
  export FAKE_GRADLE_FAIL_STEP=1
  run bash "$SCRIPT"
  [ "$status" -eq 23 ]
  [[ "$output" == *"diagnostics from ${JUNIT_CONSUMER_SCRATCH_DIR}/logs/publish.log:"* ]]
  [[ "$output" == *"* What went wrong:"*"consumer failure detail"* ]]
  [[ "$output" == *"log-line-500"* ]]
  [[ "$output" != *"* Try:"* ]]
  [[ "$output" != *"excluded advice"* ]]
  [ "$(wc -l < "$FAKE_GRADLE_CALLS")" -eq 1 ]
}

@test "500-line log prints only the configured tail plus the error block and header" {
  export FAKE_GRADLE_FAIL_STEP=1
  run bash "$SCRIPT"
  [ "$status" -eq 23 ]
  [ "$(printf '%s\n' "$output" | wc -l)" -eq 11 ]
  [[ "$output" == *"log-line-494"* ]]
  [[ "$output" != *"log-line-493"* ]]
}

@test "success keeps the final success line without failure diagnostics" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$output" = "Kotlin 2.2.21 consumer compiled and tested against auto-mobile-junit-runner 1.2.3." ]
  [[ "$output" != *"diagnostics from"* ]]
  [ "$(wc -l < "$FAKE_GRADLE_CALLS")" -eq 3 ]
  for log_name in publish dependencyInsight test; do
    [ "$(cat "${JUNIT_CONSUMER_SCRATCH_DIR}/logs/${log_name}.log")" = "BUILD SUCCESSFUL" ]
  done
}

@test "third invocation test failure prints its tail" {
  export FAKE_GRADLE_FAIL_STEP=3
  run bash "$SCRIPT"
  [ "$status" -eq 23 ]
  [[ "$output" == *"diagnostics from ${JUNIT_CONSUMER_SCRATCH_DIR}/logs/test.log:"* ]]
  [[ "$output" == *"log-line-500"* ]]
  [ "$(wc -l < "$FAKE_GRADLE_CALLS")" -eq 3 ]
}

@test "dependencyInsight failure prints its diagnostics" {
  export FAKE_GRADLE_FAIL_STEP=2
  run bash "$SCRIPT"
  [ "$status" -eq 23 ]
  [[ "$output" == *"diagnostics from ${JUNIT_CONSUMER_SCRATCH_DIR}/logs/dependencyInsight.log:"* ]]
  [[ "$output" == *"consumer failure detail"* ]]
}

@test "first error block stops at a heading after a blank line" {
  export FAKE_GRADLE_FAIL_STEP=1
  printf '* What went wrong:\nfirst detail\n\n* Exception is:\nexcluded exception\n' > "$FAKE_GRADLE_LOG"
  for ((i = 1; i <= 20; i++)); do printf 'tail-%s\n' "$i" >> "$FAKE_GRADLE_LOG"; done
  run bash "$SCRIPT"
  [ "$status" -eq 23 ]
  [[ "$output" == *"first detail"* ]]
  [[ "$output" != *"excluded exception"* ]]
  [[ "$output" != *"* Exception is:"* ]]
}

@test "error block is capped at 40 lines and does not print a second block" {
  export FAKE_GRADLE_FAIL_STEP=1
  {
    printf '* What went wrong:\n'
    for ((i = 1; i <= 60; i++)); do printf 'detail-%s\n' "$i"; done
    printf '\n* Try:\n\n* What went wrong:\nsecond block\n'
    for ((i = 1; i <= 20; i++)); do printf 'tail-%s\n' "$i"; done
  } > "$FAKE_GRADLE_LOG"
  run bash "$SCRIPT"
  [ "$status" -eq 23 ]
  [ "$(printf '%s\n' "$output" | wc -l)" -eq 48 ]
  [[ "$output" == *"detail-39"* ]]
  [[ "$output" != *"detail-40"* ]]
  [[ "$output" != *"second block"* ]]
}

@test "tail defaults to 150 lines" {
  unset JUNIT_CONSUMER_LOG_TAIL_LINES
  export FAKE_GRADLE_FAIL_STEP=1
  run bash "$SCRIPT"
  [ "$status" -eq 23 ]
  [ "$(printf '%s\n' "$output" | wc -l)" -eq 154 ]
  [[ "$output" == *"log-line-351"* ]]
  [[ "$output" != *"log-line-350"* ]]
}

@test "invalid tail size is rejected before Gradle runs" {
  export JUNIT_CONSUMER_LOG_TAIL_LINES=invalid
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"JUNIT_CONSUMER_LOG_TAIL_LINES must be a positive integer"* ]]
  [ ! -e "$FAKE_GRADLE_CALLS" ]
}
