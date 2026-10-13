#!/usr/bin/env bats
#
# Tests for scripts/ci/run-gradle-with-retry.sh

SCRIPT="scripts/ci/run-gradle-with-retry.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  LOG_DIR="${TEST_ROOT}/logs"
  COMMAND="${TEST_ROOT}/fake-gradle.sh"
  use_fake_sleep
}

# Shadow `sleep` through a fake-bin PATH entry, recording one line per requested
# delay instead of waiting for real. The wrapper calls `sleep` as a bare command,
# so PATH decides which one runs. Every retry case here would otherwise burn a
# real GRADLE_RETRY_DELAY_SECONDS proving a constant; the log is what the delay
# assertions read, which is the behaviour worth asserting anyway.
use_fake_sleep() {
  mkdir -p "${TEST_ROOT}/fakebin"
  SLEEP_LOG="${TEST_ROOT}/sleeps"
  : > "$SLEEP_LOG"
  cat > "${TEST_ROOT}/fakebin/sleep" <<'FAKE_SLEEP'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "${SLEEP_LOG}"
exit 0
FAKE_SLEEP
  chmod +x "${TEST_ROOT}/fakebin/sleep"
  PATH="${TEST_ROOT}/fakebin:${PATH}"
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
    SLEEP_LOG="$SLEEP_LOG" \
    bash "$SCRIPT" -- "$COMMAND" :playground:app:assembleDebug

  [ "$status" -eq 0 ]
  [[ "$output" == *"Running Gradle attempt 1/2"* ]]
  [[ "$output" != *"attempt 2/2"* ]]
  # A first-attempt success never reaches the backoff.
  [ ! -s "$SLEEP_LOG" ]
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
    SLEEP_LOG="$SLEEP_LOG" \
    FAKE_GRADLE_STATE="${TEST_ROOT}/state" FAKE_GRADLE_ARGS="${TEST_ROOT}/args" \
    bash "$SCRIPT" -- "$COMMAND" :playground:app:assembleDebug --stacktrace

  [ "$status" -eq 0 ]
  [[ "$output" == *"Retryable Maven/plugin repository failure detected."* ]]
  [[ "$output" == *"Running Gradle attempt 2/2"* ]]
  [ "$(tr '\n' ' ' < "$SLEEP_LOG")" = "1 " ]
  grep -q -- "--refresh-dependencies" "${TEST_ROOT}/args"
}

@test "does not retry deterministic compilation failures" {
  write_fake_gradle <<'SCRIPT'
#!/usr/bin/env bash
echo "e: AutoMobileAgent.kt:454:11 No parameter with name 'argsSerializer' found."
exit 1
SCRIPT

  run env GRADLE_RETRY_LOG_DIR="$LOG_DIR" GRADLE_RETRY_DELAY_SECONDS=1 \
    SLEEP_LOG="$SLEEP_LOG" \
    bash "$SCRIPT" -- "$COMMAND" :junit-runner:compileKotlin

  [ "$status" -eq 1 ]
  [[ "$output" == *"Failure did not match Maven/plugin repository retry patterns."* ]]
  [[ "$output" != *"attempt 2/2"* ]]
  # A non-retryable failure exits before the backoff too.
  [ ! -s "$SLEEP_LOG" ]
}

@test "retries a DNS host-resolution failure (UnknownHostException)" {
  # Detekt on main went red because Gradle could not resolve
  # data.services.jetbrains.com while resolving :ide-plugin:compileClasspath
  # (#6880). DNS trouble on a hosted runner is transient and rerun-curable, but
  # the signature matched none of the HTTP-shaped retry patterns, so the wrapper
  # gave up after the first attempt.
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
  echo "Could not determine the dependencies of task ':ide-plugin:compileJava'."
  echo "Caused by: java.io.UncheckedIOException: java.net.UnknownHostException: data.services.jetbrains.com"
  exit 1
fi

echo "BUILD SUCCESSFUL"
SCRIPT

  run env GRADLE_RETRY_LOG_DIR="$LOG_DIR" GRADLE_RETRY_DELAY_SECONDS=1 \
    SLEEP_LOG="$SLEEP_LOG" \
    FAKE_GRADLE_STATE="${TEST_ROOT}/state" \
    bash "$SCRIPT" -- "$COMMAND" :ide-plugin:detekt

  [ "$status" -eq 0 ]
  [[ "$output" == *"Running Gradle attempt 2/2"* ]]
  [ "$(tr '\n' ' ' < "$SLEEP_LOG")" = "1 " ]
}

@test "retries a glibc-worded name-resolution failure" {
  # The same class of failure, worded by whichever resolver surfaced it.
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
  echo "Caused by: java.net.SocketException: Temporary failure in name resolution"
  exit 1
fi

echo "BUILD SUCCESSFUL"
SCRIPT

  run env GRADLE_RETRY_LOG_DIR="$LOG_DIR" GRADLE_RETRY_DELAY_SECONDS=1 \
    SLEEP_LOG="$SLEEP_LOG" \
    FAKE_GRADLE_STATE="${TEST_ROOT}/state" \
    bash "$SCRIPT" -- "$COMMAND" :ide-plugin:detekt

  [ "$status" -eq 0 ]
  [[ "$output" == *"Running Gradle attempt 2/2"* ]]
  [ "$(tr '\n' ' ' < "$SLEEP_LOG")" = "1 " ]
}

@test "retries a dependency-resolution failure phrased for a single configuration" {
  # "Could not resolve all dependencies for configuration" is the wording in
  # the #6880 log; the wrapper only knew "Could not resolve all files for
  # configuration".
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
  echo "Could not resolve all dependencies for configuration ':ide-plugin:compileClasspath'."
  exit 1
fi

echo "BUILD SUCCESSFUL"
SCRIPT

  run env GRADLE_RETRY_LOG_DIR="$LOG_DIR" GRADLE_RETRY_DELAY_SECONDS=1 \
    SLEEP_LOG="$SLEEP_LOG" \
    FAKE_GRADLE_STATE="${TEST_ROOT}/state" \
    bash "$SCRIPT" -- "$COMMAND" :ide-plugin:detekt

  [ "$status" -eq 0 ]
  [[ "$output" == *"Running Gradle attempt 2/2"* ]]
  [ "$(tr '\n' ' ' < "$SLEEP_LOG")" = "1 " ]
}

write_missing_artifact_gradle() {
  write_fake_gradle <<'SCRIPT'
#!/usr/bin/env bash
if [[ "${1:-}" == "--stop" ]]; then
  exit 0
fi
if [[ ! -e "$FAKE_GRADLE_STATE" ]]; then
  touch "$FAKE_GRADLE_STATE"
  cat "$FAKE_GRADLE_FIXTURE"
  exit 1
fi
printf '%s\n' "$*" > "$FAKE_GRADLE_ARGS"
echo "BUILD SUCCESSFUL"
SCRIPT
}

@test "missing pinned artifact retries with 45s propagation delay and refreshed dependencies" {
  write_missing_artifact_gradle
  run env GRADLE_RETRY_LOG_DIR="$LOG_DIR" SLEEP_LOG="$SLEEP_LOG" \
    FAKE_GRADLE_STATE="${TEST_ROOT}/state" FAKE_GRADLE_ARGS="${TEST_ROOT}/args" \
    FAKE_GRADLE_FIXTURE="test/fixtures/gradle-retry/missing-pinned-artifact.log" \
    bash "$SCRIPT" -- "$COMMAND" :junit-runner:compileKotlin
  [ "$status" -eq 0 ]
  [[ "$output" == *"Retryable missing-artifact (repository propagation) failure detected."* ]]
  [[ "$output" == *"Running Gradle attempt 2/2"* ]]
  [ "$(cat "$SLEEP_LOG")" = "45" ]
  grep -q -- '--refresh-dependencies' "${TEST_ROOT}/args"
}

@test "custom missing artifact delay is honored" {
  write_missing_artifact_gradle
  run env GRADLE_RETRY_LOG_DIR="$LOG_DIR" SLEEP_LOG="$SLEEP_LOG" \
    GRADLE_RETRY_MISSING_ARTIFACT_DELAY_SECONDS=75 \
    FAKE_GRADLE_STATE="${TEST_ROOT}/state" FAKE_GRADLE_ARGS="${TEST_ROOT}/args" \
    FAKE_GRADLE_FIXTURE="test/fixtures/gradle-retry/missing-pinned-artifact.log" \
    bash "$SCRIPT" -- "$COMMAND" :junit-runner:compileKotlin
  [ "$status" -eq 0 ]
  [ "$(cat "$SLEEP_LOG")" = "75" ]
}

@test "invalid missing artifact delay is rejected" {
  write_fake_gradle <<'SCRIPT'
#!/usr/bin/env bash
echo "BUILD SUCCESSFUL"
SCRIPT
  for invalid in 0 -1 1.5 invalid; do
    run env GRADLE_RETRY_LOG_DIR="$LOG_DIR" SLEEP_LOG="$SLEEP_LOG" \
      GRADLE_RETRY_MISSING_ARTIFACT_DELAY_SECONDS="$invalid" \
      bash "$SCRIPT" -- "$COMMAND" test
    [ "$status" -eq 1 ]
    [[ "$output" == *"GRADLE_RETRY_MISSING_ARTIFACT_DELAY_SECONDS must be a positive integer"* ]]
    [[ "$output" != *"Running Gradle attempt"* ]]
  done
}

@test "bare missing coordinate retries without a wrapping resolution error" {
  printf 'Could not find org.jetbrains.kotlin:kotlin-gradle-plugins-bom:2.4.10.\n' > "${TEST_ROOT}/bare.log"
  write_missing_artifact_gradle
  run env GRADLE_RETRY_LOG_DIR="$LOG_DIR" SLEEP_LOG="$SLEEP_LOG" \
    FAKE_GRADLE_STATE="${TEST_ROOT}/state" FAKE_GRADLE_ARGS="${TEST_ROOT}/args" \
    FAKE_GRADLE_FIXTURE="${TEST_ROOT}/bare.log" \
    bash "$SCRIPT" -- "$COMMAND" test
  [ "$status" -eq 0 ]
  [ "$(cat "$SLEEP_LOG")" = "45" ]
}

@test "compile errors, test failures, missing methods and missing any version are not retried" {
  write_fake_gradle <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$FAKE_GRADLE_ERROR"
exit 1
SCRIPT
  for failure in \
    'e: file:///x/Foo.kt:3:5 Unresolved reference: bar' \
    'error: cannot find symbol' \
    'Test failed' \
    'Could not find method foo()' \
    'Could not find any version that matches example:artifact:+'; do
    run env GRADLE_RETRY_LOG_DIR="$LOG_DIR" SLEEP_LOG="$SLEEP_LOG" \
      FAKE_GRADLE_ERROR="$failure" bash "$SCRIPT" -- "$COMMAND" test
    [ "$status" -eq 1 ]
    [[ "$output" == *"Failure did not match Maven/plugin repository retry patterns."* ]]
    [[ "$output" != *"attempt 2/2"* ]]
    [ ! -s "$SLEEP_LOG" ]
  done
}
