#!/usr/bin/env bats
# Bun expands its template literals; the shell must preserve them verbatim.
# shellcheck disable=SC2016

setup_file() {
  local repo
  repo="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  # Build the sample from the TypeScript unit-test builder, never a maintained JSON fixture.
  AUTOMOBILE_DATA_DIR="${BATS_FILE_TMPDIR}/data" \
    AUTOMOBILE_LOG_DIR="${BATS_FILE_TMPDIR}/logs" \
    AUTOMOBILE_APPEARANCE_SYNC=0 BROKER_TEST_REPO="${repo}" \
    bun -e 'const { brokerBatchInput } = await import(`${process.env.BROKER_TEST_REPO}/test/scripts/manualTestPrivateDaemonFixture.ts`); console.log(JSON.stringify(brokerBatchInput()));' \
    > "${BATS_FILE_TMPDIR}/broker-batch.json"
}

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/manual-test/private-daemon.ts"
  BATCH="${BATS_TEST_TMPDIR}/batch"
  INPUT="${BATS_FILE_TMPDIR}/broker-batch.json"
  export AUTOMOBILE_DATA_DIR="${BATS_TEST_TMPDIR}/data"
  export AUTOMOBILE_LOG_DIR="${BATS_TEST_TMPDIR}/logs"
  export AUTOMOBILE_APPEARANCE_SYNC=0
}

plan() {
  bun "${SCRIPT}" init --batch-dir "${BATCH}" --count 2 --base-port 3160 \
    --broker-batch "${INPUT}" --dry-run "$@"
}

@test "broker dry run plans files and modes without creating a batch" {
  run plan
  [ "${status}" -eq 0 ]
  [ ! -e "${BATCH}" ]
  PLAN="${output}" bun -e '
    const plan = JSON.parse(process.env.PLAN);
    if (!plan.dryRun) throw new Error("missing dry-run marker");
    for (const name of ["host-config.json", "clients.json"]) {
      const file = plan.files.find(f => f.path.endsWith(`/broker/${name}`));
      if (!file || file.mode !== "0600") throw new Error(`missing private ${name}`);
    }
    const manifest = JSON.parse(plan.files.find(f => f.path.endsWith("/batch.json")).content);
    if (manifest.broker.daemon !== 1 || manifest.broker.hostConfig !== "broker/host-config.json") throw new Error("wrong broker manifest");
    if (plan.directories.some(d => d.mode !== "0700")) throw new Error("insecure directory");
  '
}

@test "broker environment belongs only to daemon 1 and clients remain scrubbed" {
  AUTOMOBILE_SESSION_BROKER_CONFIG=/inherited/broker AUTOMOBILE_SESSION_CONFIG=/inherited/session run plan
  [ "${status}" -eq 0 ]
  PLAN="${output}" bun -e '
    const plan = JSON.parse(process.env.PLAN);
    for (const row of plan.daemonEnvironments) {
      const config = row.env.AUTOMOBILE_SESSION_BROKER_CONFIG;
      if (row.daemon === 1 ? !config?.endsWith("/broker/host-config.json") : config !== undefined) throw new Error("broker env escaped daemon 1");
      if (row.env.AUTOMOBILE_SESSION_CONFIG !== undefined) throw new Error("inherited session config");
    }
    for (const row of plan.clientEnvironments) {
      if (row.env.AUTOMOBILE_SESSION_BROKER_CONFIG !== undefined || row.env.AUTOMOBILE_SESSION_CONFIG !== undefined) throw new Error("client env contains broker/session config");
    }
    for (const file of plan.files.filter(f => f.path.endsWith("/env.sh"))) {
      if (file.content.includes("export AUTOMOBILE_SESSION_BROKER_CONFIG")) throw new Error("broker env in wrapper source");
      if (!file.content.includes("unset AUTOMOBILE_SESSION_CONFIG")) throw new Error("session env not scrubbed");
    }
  '
  [ ! -e "${BATCH}" ]
}

@test "over-cap input and a max-devices flag above hard ceiling are rejected" {
  BROKER_INPUT="${INPUT}" bun -e '
    const input = await Bun.file(process.env.BROKER_INPUT).json();
    input.limits.totalDeviceCap = 5;
    console.log(JSON.stringify(input));
  ' > "${BATS_TEST_TMPDIR}/over-cap.json"
  INPUT="${BATS_TEST_TMPDIR}/over-cap.json"
  run plan --max-devices 4
  [ "${status}" -eq 2 ]
  [[ "${output}" == *totalDeviceCap* ]]
  [ ! -e "${BATCH}" ]
  run plan --max-devices 5
  [ "${status}" -eq 2 ]
  [[ "${output}" == *'hard ceiling of 4'* ]]
  [ ! -e "${BATCH}" ]
}

@test "init explicitly rejects broker and session env assignments" {
  local key
  for key in AUTOMOBILE_SESSION_BROKER_CONFIG AUTOMOBILE_SESSION_CONFIG; do
    run plan --env "${key}=/foreign"
    [ "${status}" -eq 2 ]
    [[ "${output}" == *"${key}"*'harness owns'* ]]
    run plan --daemon-env "2:${key}=/foreign"
    [ "${status}" -eq 2 ]
    [[ "${output}" == *"${key}"*'harness owns'* ]]
  done
  [ ! -e "${BATCH}" ]
}

@test "broker wrappers target the orchestrator and bind to daemon 1" {
  run plan
  [ "${status}" -eq 0 ]
  PLAN="${output}" bun -e '
    const plan = JSON.parse(process.env.PLAN);
    for (const index of [1, 2]) {
      const file = plan.files.find(f => f.path.endsWith(`/bin/broker${index}`));
      if (!file || file.mode !== "0755") throw new Error("missing executable broker wrapper");
      if (!file.content.includes("--daemon 1 -- bun") || !file.content.includes("/scripts/manual-test/broker-batch.ts")) throw new Error("wrong wrapper target");
      if (!file.content.includes("\"$@\"")) throw new Error("lost wrapper argv");
    }
  '
  [ ! -e "${BATCH}" ]
}

@test "broker-batch help works under Bun without a daemon or batch" {
  unset MT_BATCH
  run bun "${BATS_TEST_DIRNAME}/../../scripts/manual-test/broker-batch.ts" --help
  [ "${status}" -eq 0 ]
  [[ "${output}" == *'broker<N> up'* ]]
  [[ "${output}" == *'status | down | report'* ]]
  [ ! -e "${BATCH}" ]
}

@test "broker-scenario list and help need no daemon or batch" {
  unset MT_BATCH
  local scenario="${BATS_TEST_DIRNAME}/../../scripts/manual-test/broker-scenario.ts"
  run bun "${scenario}" list
  [ "${status}" -eq 0 ]
  [[ "${output}" == *'capacity-refusal-and-replay'* ]]
  [[ "${output}" == *'cross-client-isolation'* ]]
  [[ "${output}" == *'fake'* ]]
  run bun "${scenario}" --help
  [ "${status}" -eq 0 ]
  [[ "${output}" == *'run <name>'* ]]
  [[ "${output}" == *'--dry-run'* ]]
  [[ "${output}" == *'--device'* ]]
  [ ! -e "${BATCH}" ]
}
