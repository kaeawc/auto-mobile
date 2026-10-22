#!/usr/bin/env bats
#
# Contract tests for the iOS WHEP lane's job-scoped daemon reaper (#14826). The
# "daemons" are sleep processes renamed with `exec -a`, so no real daemon runs.

SCRIPT="scripts/webrtc/reap-job-daemons.sh"

setup() {
  TEST_DIR="$(mktemp -d)"
  ARTIFACTS="${TEST_DIR}/artifacts"
  mkdir -p "${ARTIFACTS}"
  PIDS=()
}

teardown() {
  for pid in "${PIDS[@]}"; do
    kill -KILL "${pid}" 2>/dev/null || true
  done
  rm -rf "${TEST_DIR}"
}

# Starts a background process whose command line reads like `$1`, and records its PID.
start_process() {
  bash -c "exec -a '$1' sleep 30" &
  STARTED_PID=$!
  PIDS+=("${STARTED_PID}")
}

write_pid_file() {
  mkdir -p "${ARTIFACTS}/$1"
  printf '{"pid":%s,"socketPath":"/tmp/x.sock","port":3000,"startedAt":1}\n' "$2" \
    > "${ARTIFACTS}/$1/daemon.pid"
}

wait_gone() {
  for _ in $(seq 1 50); do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

@test "script is executable" {
  [ -x "${SCRIPT}" ]
}

@test "rejects a missing directory argument or an unknown signal" {
  run bash "${SCRIPT}"
  [ "${status}" -eq 2 ]
  [[ "${output}" == *"usage:"* ]]
  run bash "${SCRIPT}" "${ARTIFACTS}" HUP
  [ "${status}" -eq 2 ]
}

@test "a missing artifact directory reaps nothing" {
  run bash "${SCRIPT}" "${TEST_DIR}/missing"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"No job daemons to reap"* ]]
}

@test "signals only the daemon whose PID file is in the artifact directory" {
  start_process "bun dist/src/index.js --daemon-mode"
  job_daemon="${STARTED_PID}"
  write_pid_file daemon-abc "${job_daemon}"
  start_process "bun dist/src/index.js --daemon-mode"
  resident_daemon="${STARTED_PID}"

  run bash "${SCRIPT}" "${ARTIFACTS}" TERM

  [ "${status}" -eq 0 ]
  [[ "${output}" == *"Sent SIGTERM to job daemon ${job_daemon}"* ]]
  [[ "${output}" == *"Reaped 1 job daemon(s) with SIGTERM."* ]]
  wait_gone "${job_daemon}"
  kill -0 "${resident_daemon}"
}

@test "a PID file naming a process that is no longer a daemon is skipped" {
  start_process "sleep-not-a-daemon"
  write_pid_file daemon-recycled "${STARTED_PID}"

  run bash "${SCRIPT}" "${ARTIFACTS}" KILL

  [ "${status}" -eq 0 ]
  [[ "${output}" == *"Reaped 0 job daemon(s) with SIGKILL."* ]]
  kill -0 "${STARTED_PID}"
}

@test "a malformed PID file warns and the rest still reap" {
  mkdir -p "${ARTIFACTS}/daemon-bad"
  printf 'not json\n' > "${ARTIFACTS}/daemon-bad/daemon.pid"
  start_process "bun dist/src/index.js --daemon-mode"
  write_pid_file daemon-good "${STARTED_PID}"

  run bash "${SCRIPT}" "${ARTIFACTS}" KILL

  [ "${status}" -eq 0 ]
  [[ "${output}" == *"records no daemon pid"* ]]
  [[ "${output}" == *"Reaped 1 job daemon(s) with SIGKILL."* ]]
  wait_gone "${STARTED_PID}"
}
