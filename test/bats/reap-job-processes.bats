#!/usr/bin/env bats

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/ci/reap-job-processes.sh"
  WORK="$(mktemp -d)"
  export REAP_GRACE_SECONDS=0
}

teardown() {
  [[ -n "${OWN_PID:-}" ]] && kill "${OWN_PID}" 2>/dev/null || true
  [[ -n "${OTHER_PID:-}" ]] && kill "${OTHER_PID}" 2>/dev/null || true
  rm -rf "${WORK}"
}

# A fake "daemon": a process whose command line contains --daemon-mode.
start_fake_daemon() {
  bash -c 'exec -a "node index.js --daemon-mode" sleep 300' >/dev/null 2>&1 &
  FAKE_PID=$!
}

@test "reaps the daemon recorded in the job pid file" {
  start_fake_daemon
  OWN_PID="${FAKE_PID}"
  mkdir -p "${WORK}/data/daemon-1"
  echo "${OWN_PID}" >"${WORK}/data/daemon-1/daemon.pid"
  sleep 0.2
  run "${SCRIPT}" "${WORK}" "${WORK}/data"
  [ "$status" -eq 0 ]
  [[ "$output" == *"${OWN_PID}"* ]]
  sleep 0.2
  run kill -0 "${OWN_PID}"
  [ "$status" -ne 0 ]
}

@test "leaves an unrelated daemon-mode process alone" {
  start_fake_daemon
  OTHER_PID="${FAKE_PID}"
  mkdir -p "${WORK}/data/daemon-1"
  sleep 0.2
  run "${SCRIPT}" "${WORK}" "${WORK}/data"
  [ "$status" -eq 0 ]
  [[ "$output" != *"${OTHER_PID}"* ]]
  kill -0 "${OTHER_PID}"
}

@test "does not reap a pid file entry that is not a daemon" {
  bash -c 'exec sleep 300' >/dev/null 2>&1 &
  OTHER_PID=$!
  mkdir -p "${WORK}/data/daemon-1"
  echo "${OTHER_PID}" >"${WORK}/data/daemon-1/daemon.pid"
  run "${SCRIPT}" "${WORK}" "${WORK}/data"
  [ "$status" -eq 0 ]
  kill -0 "${OTHER_PID}"
}

@test "requires a workspace directory" {
  run "${SCRIPT}"
  [ "$status" -eq 2 ]
}
