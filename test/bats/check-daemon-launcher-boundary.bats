#!/usr/bin/env bats
# bats file_tags=serial
# Writes a fixture into the real source tree and scans it, so this file cannot
# run concurrently with the rest of the suite. scripts/ci/run-bats.sh runs all
# serial-tagged files in a dedicated serial pass (scripts/ci/run-bats.sh);
# the tag is enforced by test/scripts/batsSerialTags.test.ts.

SCRIPT="scripts/check-daemon-launcher-boundary.sh"
FIXTURE="src/daemon/DaemonLauncherBoundaryFixture.ts"

teardown() {
  rm -f "$FIXTURE"
}

@test "allows DaemonLauncher to own daemon execution" {
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no direct production daemon invocations"* ]]
}

@test "rejects a direct daemon spawn outside the owner" {
  printf '%s\n' \
    'import { spawn } from "node:child_process";' \
    'spawn("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
}

@test "rejects a shell daemon command outside the owner" {
  printf '%s\n' \
    'import { execSync } from "node:child_process";' \
    'execSync("bunx @kaeawc/auto-mobile --daemon-mode");' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
}

@test "rejects a direct file execution outside the owner" {
  printf '%s\n' \
    'import { execFileSync } from "node:child_process";' \
    'execFileSync("ps", ["-p", "42", "-o", "lstart="]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
}

@test "rejects CommonJS and aliased child-process execution outside the owner" {
  printf '%s\n' \
    'const { spawn } = require("node:child_process");' \
    'const launch = spawn;' \
    'launch(command, daemonArgs);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
}

@test "rejects import-equals child-process execution outside the owner" {
  printf '%s\n' \
    'import childProcess = require("node:child_process");' \
    'childProcess.execSync(command);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
}

@test "rejects a default child-process import outside the owner" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'childProcess.execFileSync("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
}

@test "rejects a computed child-process executor outside the owner" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'childProcess["execFileSync"]("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
}

@test "rejects transparently wrapped computed child-process executors outside the owner" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'childProcess[("execFileSync")]("auto-mobile", ["--daemon-mode"]);' \
    'childProcess["execFileSync" as const]("auto-mobile", ["--daemon-mode"]);' \
    'childProcess[("execFileSync")!]("auto-mobile", ["--daemon-mode"]);' \
    'childProcess[("execFileSync" satisfies string)]("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
  [[ "$(grep -c "DaemonLauncherBoundaryFixture.ts" <<< "$output")" -eq 4 ]]
}

@test "rejects transparently wrapped child-process member accesses outside the owner" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'const launch = (childProcess.execFileSync);' \
    'launch("auto-mobile", ["--daemon-mode"]);' \
    'const computedLaunch = (childProcess["execFileSync"]);' \
    'computedLaunch("auto-mobile", ["--daemon-mode"]);' \
    '(childProcess.execFileSync)("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
  [[ "$output" == *'launch("auto-mobile", ["--daemon-mode"])'* ]]
  [[ "$output" == *'computedLaunch("auto-mobile", ["--daemon-mode"])'* ]]
  [[ "$output" == *'(childProcess.execFileSync)("auto-mobile", ["--daemon-mode"])'* ]]
  [[ "$(grep -c "DaemonLauncherBoundaryFixture.ts" <<< "$output")" -eq 3 ]]
}

@test "rejects transparent wrappers around namespace aliases, members, and callees" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'const namespaceAlias = (childProcess) as typeof childProcess;' \
    'namespaceAlias.execFileSync("auto-mobile", ["--daemon-mode"]);' \
    'const { execFileSync: destructured } = (childProcess)!;' \
    'destructured("auto-mobile", ["--daemon-mode"]);' \
    '((childProcess.execFileSync) as typeof childProcess.execFileSync)("auto-mobile", ["--daemon-mode"]);' \
    '(childProcess.execFileSync!)("auto-mobile", ["--daemon-mode"]);' \
    '(childProcess.execFileSync satisfies typeof childProcess.execFileSync)("auto-mobile", ["--daemon-mode"]);' \
    '((childProcess) as typeof childProcess).execFileSync("auto-mobile", ["--daemon-mode"]);' \
    '(childProcess!).execFileSync("auto-mobile", ["--daemon-mode"]);' \
    '(childProcess satisfies typeof childProcess).execFileSync("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$(grep -c "DaemonLauncherBoundaryFixture.ts" <<< "$output")" -eq 8 ]]
}

@test "rejects a namespace alias of a default child-process import" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'const launcher = childProcess;' \
    'launcher.execFileSync("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
}

@test "allows a local binding that shadows a default child-process import" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'function inspect(childProcess: { execFileSync(): void }) {' \
    '  (childProcess.execFileSync)();' \
    '  (childProcess!).execFileSync();' \
    '  childProcess[("execFileSync" as const)]();' \
    '}' \
    'inspect({ execFileSync() {} });' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no direct production daemon invocations"* ]]
}

@test "rejects a destructured executor from a default child-process import" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'const { execFileSync: launch } = childProcess;' \
    'launch("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"DaemonLauncherBoundaryFixture.ts"* ]]
}

@test "rejects static computed destructured executor keys" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'const { "execFileSync": stringLaunch } = childProcess;' \
    'stringLaunch("auto-mobile", ["--daemon-mode"]);' \
    'const { [("execFileSync" as const)]: computedLaunch } = childProcess;' \
    'computedLaunch("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$(grep -c "DaemonLauncherBoundaryFixture.ts" <<< "$output")" -eq 2 ]]
}

@test "rejects static constant computed executor keys" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'const executor = "execFileSync" as const;' \
    'childProcess[executor]("auto-mobile", ["--daemon-mode"]);' \
    'const executorAlias = executor;' \
    'childProcess[executorAlias]("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$(grep -c "DaemonLauncherBoundaryFixture.ts" <<< "$output")" -eq 2 ]]
}

@test "rejects unambiguous post-declaration executor assignments" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'let launch;' \
    'launch = childProcess["execFileSync"];' \
    'launch("auto-mobile", ["--daemon-mode"]);' \
    'let destructured;' \
    '({ [("execFileSync" as const)]: destructured } = childProcess);' \
    'destructured("auto-mobile", ["--daemon-mode"]);' \
    'let parenthesizedLaunch;' \
    '(parenthesizedLaunch) = childProcess["execFileSync"];' \
    'parenthesizedLaunch("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$(grep -c "DaemonLauncherBoundaryFixture.ts" <<< "$output")" -eq 3 ]]
}

@test "allows dynamic keys and reassigned or shadowed aliases" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'let dynamicKey = "execFileSync";' \
    'childProcess[dynamicKey]("auto-mobile", ["--daemon-mode"]);' \
    'let launch;' \
    'launch = childProcess["execFileSync"];' \
    'launch = () => {};' \
    'launch();' \
    'let initializedLaunch = childProcess["execFileSync"];' \
    'initializedLaunch = () => {};' \
    'initializedLaunch();' \
    'let logicalLaunch = childProcess["execFileSync"];' \
    'logicalLaunch &&= () => {};' \
    'logicalLaunch();' \
    'let forOfLaunch = childProcess["execFileSync"];' \
    'for (forOfLaunch of [() => {}]) {}' \
    'forOfLaunch();' \
    'let forInLaunch = childProcess["execFileSync"];' \
    'for (forInLaunch in { safeLaunch: true }) {}' \
    'forInLaunch();' \
    'let incrementedLaunch = childProcess["execFileSync"];' \
    'incrementedLaunch++;' \
    'incrementedLaunch();' \
    'let namespaceAlias = childProcess;' \
    'namespaceAlias = {} as typeof childProcess;' \
    'namespaceAlias["execFileSync"]();' \
    'let { execFileSync: destructuredLaunch } = childProcess;' \
    'destructuredLaunch = () => {};' \
    'destructuredLaunch();' \
    'function inspect(childProcess: { execFileSync(): void }) {' \
    '  const executor = "execFileSync" as const;' \
    '  childProcess[executor]();' \
    '}' \
    'inspect({ execFileSync() {} });' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no direct production daemon invocations"* ]]
}

@test "rejects unreassigned mutable executor and namespace aliases" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'let launch = childProcess["execFileSync"];' \
    'launch("auto-mobile", ["--daemon-mode"]);' \
    'var namespaceAlias = childProcess;' \
    'namespaceAlias.spawn("auto-mobile", ["--daemon-mode"]);' \
    'let { execFileSync: destructuredLaunch } = childProcess;' \
    'destructuredLaunch("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$(grep -c "DaemonLauncherBoundaryFixture.ts" <<< "$output")" -eq 3 ]]
}

@test "rejects deterministic logical aliases and object-rest namespaces" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'let nullishLaunch;' \
    'nullishLaunch ??= childProcess["execFileSync"];' \
    'nullishLaunch("auto-mobile", ["--daemon-mode"]);' \
    'let fallbackLaunch;' \
    'fallbackLaunch ||= childProcess["execFileSync"];' \
    'fallbackLaunch("auto-mobile", ["--daemon-mode"]);' \
    'const { ...commonJsChildProcess } = require("node:child_process");' \
    'commonJsChildProcess.execFileSync("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$(grep -c "DaemonLauncherBoundaryFixture.ts" <<< "$output")" -eq 3 ]]
}

@test "preserves static object-rest exclusions through namespace aliases" {
  printf '%s\n' \
    'const { execFileSync, ...withoutExecutor } = require("node:child_process");' \
    'withoutExecutor.execFileSync?.("auto-mobile", ["--daemon-mode"]);' \
    'withoutExecutor.spawn("auto-mobile", ["--daemon-mode"]);' \
    'const copiedWithoutExecutor = withoutExecutor;' \
    'copiedWithoutExecutor.execFileSync?.("auto-mobile", ["--daemon-mode"]);' \
    'copiedWithoutExecutor.spawn("auto-mobile", ["--daemon-mode"]);' \
    'const { execFileSync: excludedExecutor, spawn: remainingExecutor } = withoutExecutor;' \
    'excludedExecutor?.("auto-mobile", ["--daemon-mode"]);' \
    'remainingExecutor("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$(grep -c "DaemonLauncherBoundaryFixture.ts" <<< "$output")" -eq 3 ]]
  [[ "$output" == *'withoutExecutor.spawn'* ]]
  [[ "$output" == *'copiedWithoutExecutor.spawn'* ]]
  [[ "$output" == *'remainingExecutor('* ]]
}

@test "leaves object rest with dynamic exclusions unknown" {
  printf '%s\n' \
    'declare const excludedKey: string;' \
    'const { [excludedKey]: omitted, ...unknownChildProcess } = require("node:child_process");' \
    'unknownChildProcess.execFileSync("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no direct production daemon invocations"* ]]
}

@test "tracks eager aliases through later assignments without applying them retroactively" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'declare const safeLaunch: (command: string, args: string[]) => void;' \
    'declare const mayReassign: boolean;' \
    'let initialized = childProcess.execFileSync;' \
    'initialized("auto-mobile", ["--daemon-mode"]);' \
    'initialized = safeLaunch;' \
    'initialized("auto-mobile", ["--daemon-mode"]);' \
    'let assignedLater: typeof childProcess.execFileSync | undefined;' \
    'assignedLater?.("auto-mobile", ["--daemon-mode"]);' \
    'assignedLater = childProcess.execFileSync;' \
    'assignedLater("auto-mobile", ["--daemon-mode"]);' \
    'let conditionallyReassigned = childProcess.execFileSync;' \
    'conditionallyReassigned("auto-mobile", ["--daemon-mode"]);' \
    'if (mayReassign) conditionallyReassigned = safeLaunch;' \
    'conditionallyReassigned("auto-mobile", ["--daemon-mode"]);' \
    'let preservedByOr = childProcess.execFileSync;' \
    'preservedByOr ||= safeLaunch;' \
    'preservedByOr("auto-mobile", ["--daemon-mode"]);' \
    'let preservedByNullish = childProcess.execFileSync;' \
    'preservedByNullish ??= safeLaunch;' \
    'preservedByNullish("auto-mobile", ["--daemon-mode"]);' \
    'let replacedByAnd = childProcess.execFileSync;' \
    'replacedByAnd &&= safeLaunch;' \
    'replacedByAnd("auto-mobile", ["--daemon-mode"]);' \
    'let deferredAfterReassignment = childProcess.execFileSync;' \
    'function invokeAfterReassignment() { deferredAfterReassignment("auto-mobile", ["--daemon-mode"]); }' \
    'deferredAfterReassignment = safeLaunch;' \
    'invokeAfterReassignment();' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$(grep -c "DaemonLauncherBoundaryFixture.ts" <<< "$output")" -eq 5 ]]
  [[ "$output" == *'initialized("auto-mobile"'* ]]
  [[ "$output" == *'assignedLater("auto-mobile"'* ]]
  [[ "$output" == *'conditionallyReassigned("auto-mobile"'* ]]
  [[ "$output" == *'preservedByOr("auto-mobile"'* ]]
  [[ "$output" == *'preservedByNullish("auto-mobile"'* ]]
}

@test "tracks object-rest assignment targets and static exclusions" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'let extracted;' \
    'let remaining;' \
    '({ execFileSync: extracted, ...remaining } = childProcess);' \
    'extracted("auto-mobile", ["--daemon-mode"]);' \
    'remaining.execFileSync?.("auto-mobile", ["--daemon-mode"]);' \
    'remaining.spawn("auto-mobile", ["--daemon-mode"]);' \
    'const { spawn } = remaining;' \
    'spawn("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$(grep -c "DaemonLauncherBoundaryFixture.ts" <<< "$output")" -eq 3 ]]
  [[ "$output" == *'extracted("auto-mobile"'* ]]
  [[ "$output" == *'remaining.spawn("auto-mobile"'* ]]
  [[ "$output" == *'spawn("auto-mobile"'* ]]
}

@test "leaves object-rest assignments with dynamic exclusions unknown" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'declare const excludedKey: string;' \
    'let remaining;' \
    '({ [excludedKey]: omitted, ...remaining } = childProcess);' \
    'remaining.spawn("auto-mobile", ["--daemon-mode"]);' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no direct production daemon invocations"* ]]
}

@test "rejects transitive executor aliases declared after their function body" {
  printf '%s\n' \
    'import childProcess from "node:child_process";' \
    'function invoke() {' \
    '  launch("auto-mobile", ["--daemon-mode"]);' \
    '}' \
    'const launch = executorAlias;' \
    'const executorAlias = namespaceAlias["execFileSync"];' \
    'const namespaceAlias = childProcess;' \
    'invoke();' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *'launch("auto-mobile", ["--daemon-mode"])'* ]]
}
