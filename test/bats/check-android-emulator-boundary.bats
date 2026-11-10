#!/usr/bin/env bats
# bats file_tags=serial
# Writes fixtures into the real source tree and scans it, so this file cannot
# run concurrently with the rest of the suite. scripts/ci/run-bats.sh runs all
# serial-tagged files in a dedicated serial pass (scripts/ci/run-bats.sh);
# the tag is enforced by test/scripts/batsSerialTags.test.ts.
#
# A full-tree scan parses every file under src/ (~1s on CI), and this file runs
# in the serial pass, so it scans twice instead of once per case (#17778):
# setup_file scans the clean tree, then writes one uniquely named fixture per
# case and scans again. The scanner reports every violating file, so each test
# asserts only whether its own fixture was flagged.

SCRIPT="scripts/check-android-emulator-boundary.ts"
FIXTURE_PREFIX="EmulatorBoundaryFixture"
FIXTURE_SLUGS=(
  CommentOnly DirectSpawn PathVariable UnrelatedAlias ProcessExecutorShell
  HostProcessExecutorSpawn ShadowedHostExecutor ShadowedProcessExecutor
  RawChildProcessSpawn UntypedSpawnReceiver ExecSync ExecFileSync SpawnSync
  NamespaceExecSync AliasedExecFileSync AliasedNamespaceExecSync
  CommonJsNamespace ImportEqualsNamespace RegExpExec
)

write_fixture() {
  local fixture="src/utils/${FIXTURE_PREFIX}$1.ts"
  shift
  printf '%s\n' "$@" > "$fixture"
}

remove_fixtures() {
  local slug fixture
  for slug in "${FIXTURE_SLUGS[@]}"; do
    fixture="src/utils/${FIXTURE_PREFIX}${slug}.ts"
    rm -f "$fixture"
  done
}

scan_into() {
  local name="$1" scan_status=0
  bun "$SCRIPT" > "$BATS_FILE_TMPDIR/$name.out" 2>&1 || scan_status=$?
  printf '%s\n' "$scan_status" > "$BATS_FILE_TMPDIR/$name.status"
}

setup_file() {
  remove_fixtures
  scan_into clean

  # Regression: the scope pre-filter tested the RAW source for /emulator/i, so
  # prose alone pulled a file in. A doc comment on the iOS SimCtlClient that
  # merely referenced the Android emulator path was enough to flag that file's
  # long-standing, legitimate spawn() in defaultSpawnProcess. The pre-filter must
  # reflect what a file DOES, not what it talks about.
  write_fixture CommentOnly \
    '/** Mirrors the readiness proof the Android emulator path performs. */' \
    'import { spawn } from "child_process";' \
    'export const run = () => spawn("xcrun", ["simctl", "list"]);' \
    '// emulator mentioned in a line comment too'
  write_fixture DirectSpawn 'spawn("emulator", ["-list-avds"]);'
  write_fixture PathVariable 'spawn(emulatorPath, ["-avd", avdName]);'
  write_fixture UnrelatedAlias 'const executable = "emulator"; spawn(executable, ["-avd", avdName]);'
  write_fixture ProcessExecutorShell 'const processExecutor: ProcessExecutor = {} as ProcessExecutor; processExecutor.exec("emulator -avd Pixel");'
  write_fixture HostProcessExecutorSpawn 'const executor: HostProcessExecutor = {} as HostProcessExecutor; executor.spawn("emulator", ["-avd", "Pixel"]);'
  write_fixture ShadowedHostExecutor \
    'const executor: HostProcessExecutor = adbHostProcessExecutor;' \
    'function unrelated() {' \
    '  const executor = getSomeUnrelatedThing();' \
    '  executor.spawn("emulator", ["-avd", "Pixel"]);' \
    '}'
  write_fixture ShadowedProcessExecutor \
    'const executor: ProcessExecutor = {} as ProcessExecutor;' \
    'function unrelated() {' \
    '  const executor = getSomeUnrelatedThing();' \
    '  executor.exec("emulator -avd Pixel");' \
    '}'
  write_fixture RawChildProcessSpawn 'import * as childProcess from "node:child_process"; childProcess.spawn("emulator", ["-avd", "Pixel"]);'
  write_fixture UntypedSpawnReceiver 'const executor = {} as HostProcessExecutor; executor.spawn("emulator", ["-avd", "Pixel"]);'
  write_fixture ExecSync 'import { execSync } from "node:child_process"; execSync("emulator -avd Pixel");'
  write_fixture ExecFileSync 'import { execFileSync } from "node:child_process"; execFileSync("emulator", ["-avd", "Pixel"]);'
  write_fixture SpawnSync 'import { spawnSync } from "node:child_process"; spawnSync("emulator", ["-avd", "Pixel"]);'
  write_fixture NamespaceExecSync 'import * as childProcess from "node:child_process"; childProcess.execSync("emulator -avd Pixel");'
  write_fixture AliasedExecFileSync 'import { execFileSync } from "node:child_process"; const launch = execFileSync; launch("emulator", ["-avd", "Pixel"]);'
  write_fixture AliasedNamespaceExecSync 'import * as childProcess from "node:child_process"; const launch = childProcess.execSync; launch("emulator -avd Pixel");'
  write_fixture CommonJsNamespace 'const childProcess = require("node:child_process"); childProcess.execSync("emulator -avd Pixel");'
  write_fixture ImportEqualsNamespace 'import childProcess = require("node:child_process"); childProcess.execSync("emulator -avd Pixel");'
  write_fixture RegExpExec 'const match = /emulator/.exec(deviceId);'

  scan_into fixtures
  remove_fixtures
}

teardown_file() {
  remove_fixtures
}

assert_flagged() {
  [ "$(cat "$BATS_FILE_TMPDIR/fixtures.status")" -eq 1 ]
  grep -qF "${FIXTURE_PREFIX}$1.ts" "$BATS_FILE_TMPDIR/fixtures.out"
}

assert_allowed() {
  [ -s "$BATS_FILE_TMPDIR/fixtures.out" ]
  ! grep -qF "${FIXTURE_PREFIX}$1.ts" "$BATS_FILE_TMPDIR/fixtures.out"
}

@test "allows AndroidEmulatorClient to own the emulator process boundary" {
  [ "$(cat "$BATS_FILE_TMPDIR/clean.status")" -eq 0 ]
  grep -qF "no direct production emulator invocations" "$BATS_FILE_TMPDIR/clean.out"
}

@test "the fixture scan reports only the rejected fixtures" {
  # Every flagged location belongs to a fixture this file wrote, so the clean
  # tree contributes nothing and each allow case below is a real pass.
  run cat "$BATS_FILE_TMPDIR/fixtures.out"
  [ "${lines[0]}" = "error: Android emulator execution must use AndroidEmulatorClient:" ]
  [ "${#lines[@]}" -gt 1 ]
  local location
  for location in "${lines[@]:1}"; do
    [[ "$location" == "utils/${FIXTURE_PREFIX}"* ]]
  done
}

@test "a comment mentioning the emulator does not opt a file into the rule" {
  assert_allowed CommentOnly
}

@test "rejects a direct production emulator spawn outside the owner" {
  assert_flagged DirectSpawn
}

@test "rejects a direct production emulator spawn through a path variable" {
  assert_flagged PathVariable
}

@test "rejects a direct production emulator spawn through an unrelated alias" {
  assert_flagged UnrelatedAlias
}

@test "rejects a shell-based ProcessExecutor emulator launch" {
  assert_flagged ProcessExecutorShell
}

@test "allows HostProcessExecutor spawn in an emulator-related file" {
  assert_allowed HostProcessExecutorSpawn
}

@test "rejects spawn on an untyped function-local shadow of a HostProcessExecutor" {
  assert_flagged ShadowedHostExecutor
}

@test "allows exec on an untyped function-local shadow of a ProcessExecutor" {
  assert_allowed ShadowedProcessExecutor
}

@test "rejects raw child_process spawn in an emulator-related file" {
  assert_flagged RawChildProcessSpawn
}

@test "rejects untyped spawn receivers in an emulator-related file" {
  assert_flagged UntypedSpawnReceiver
}

@test "rejects a synchronous child_process exec emulator launch" {
  assert_flagged ExecSync
}

@test "rejects a synchronous child_process execFile emulator launch" {
  assert_flagged ExecFileSync
}

@test "rejects a synchronous child_process spawn emulator launch" {
  assert_flagged SpawnSync
}

@test "rejects a synchronous child_process namespace emulator launch" {
  assert_flagged NamespaceExecSync
}

@test "rejects a local alias of a synchronous child_process function" {
  assert_flagged AliasedExecFileSync
}

@test "rejects a local alias of a synchronous child_process namespace method" {
  assert_flagged AliasedNamespaceExecSync
}

@test "rejects a CommonJS child_process namespace launch" {
  assert_flagged CommonJsNamespace
}

@test "rejects an import-equals child_process namespace launch" {
  assert_flagged ImportEqualsNamespace
}

@test "allows unrelated RegExp exec calls in an emulator-related file" {
  assert_allowed RegExpExec
}
