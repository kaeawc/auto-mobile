#!/usr/bin/env bats
#
# Tests for scripts/ci/run-gradle-with-retry.sh

SCRIPT="scripts/ci/run-gradle-with-retry.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  LOG_DIR="${TEST_ROOT}/logs"
  COMMAND="${TEST_ROOT}/fake-gradle.sh"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

write_fake_gradle() {
  cat > "$COMMAND"
  chmod +x "$COMMAND"
}

@test "passes without retry when Gradle succeeds" {
  write_fake_gradle <<'SCRIPT'
#!/usr/bin/env bash
echo "BUILD SUCCESSFUL"
SCRIPT

  run env GRADLE_RETRY_LOG_DIR="$LOG_DIR" GRADLE_RETRY_DELAY_SECONDS=1 \
    bash "$SCRIPT" -- "$COMMAND" :playground:app:assembleDebug

  [ "$status" -eq 0 ]
  [[ "$output" == *"Running Gradle attempt 1/2"* ]]
  [[ "$output" != *"attempt 2/2"* ]]
}

@test "retries Maven plugin resolution failure with refreshed dependencies" {
  write_fake_gradle <<'SCRIPT'
#!/usr/bin/env bash
if [[ "${1:-}" == "--stop" ]]; then
  exit 0
fi

state_file="${FAKE_GRADLE_STATE}"
attempt="$(cat "$state_file" 2>/dev/null || echo 0)"
attempt=$((attempt + 1))
echo "$attempt" > "$state_file"

if [[ "$attempt" -eq 1 ]]; then
  echo "Plugin [id: 'com.vanniktech.maven.publish', version: '0.36.0', apply: false] was not found"
  echo "could not resolve plugin artifact"
  exit 1
fi

printf '%s\n' "$*" > "${FAKE_GRADLE_ARGS}"
echo "BUILD SUCCESSFUL"
SCRIPT

  run env GRADLE_RETRY_LOG_DIR="$LOG_DIR" GRADLE_RETRY_DELAY_SECONDS=1 \
    FAKE_GRADLE_STATE="${TEST_ROOT}/state" FAKE_GRADLE_ARGS="${TEST_ROOT}/args" \
    bash "$SCRIPT" -- "$COMMAND" :playground:app:assembleDebug --stacktrace

  [ "$status" -eq 0 ]
  [[ "$output" == *"Retryable Maven/plugin repository failure detected."* ]]
  [[ "$output" == *"Running Gradle attempt 2/2"* ]]
  grep -q -- "--refresh-dependencies" "${TEST_ROOT}/args"
}

@test "does not retry deterministic compilation failures" {
  write_fake_gradle <<'SCRIPT'
#!/usr/bin/env bash
echo "e: AutoMobileAgent.kt:454:11 No parameter with name 'argsSerializer' found."
exit 1
SCRIPT

  run env GRADLE_RETRY_LOG_DIR="$LOG_DIR" GRADLE_RETRY_DELAY_SECONDS=1 \
    bash "$SCRIPT" -- "$COMMAND" :junit-runner:compileKotlin

  [ "$status" -eq 1 ]
  [[ "$output" == *"Failure did not match Maven/plugin repository retry patterns."* ]]
  [[ "$output" != *"attempt 2/2"* ]]
}
