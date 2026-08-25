#!/usr/bin/env bats
# bats file_tags=serial
# Writes a fixture into the real source tree and scans it, so this file cannot
# run concurrently with the rest of the suite. scripts/ci/run-bats.sh runs all
# serial-tagged files in a dedicated serial pass (scripts/ci/run-bats.sh);
# the tag is enforced by test/scripts/batsSerialTags.test.ts.

SCRIPT="scripts/check-sdkmanager-execution-boundary.sh"
FIXTURE="src/utils/SdkManagerBoundaryFixture.ts"

teardown() {
  rm -f "$FIXTURE"
}

@test "allows SdkManagerClient to own sdkmanager execution" {
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no direct production sdkmanager invocations"* ]]
}

@test "rejects a direct sdkmanager spawn outside the owner" {
  printf '%s\n' 'import { spawn } from "node:child_process"; spawn("sdkmanager", ["--list"]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"SdkManagerBoundaryFixture.ts"* ]]
}

@test "rejects an aliased sdkmanager binary passed to a child-process launcher" {
  printf '%s\n' 'import { execFile } from "node:child_process"; const binary = "sdkmanager"; execFile(binary, ["--list"]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"SdkManagerBoundaryFixture.ts"* ]]
}

@test "rejects sdkmanager reached across functions via a parameter (issue #4341)" {
  printf '%s\n' 'import { execFile } from "node:child_process"; function run(bin) { execFile(bin, args); } run("sdkmanager");' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"SdkManagerBoundaryFixture.ts"* ]]
}

@test "rejects a production-shaped resolve-then-spawn client (issue #4341)" {
  cat > "$FIXTURE" <<'EOF'
import { spawn } from "node:child_process";
class Tool {
  private resolveExecutable(location) { return join(location.path, "bin", "sdkmanager"); }
  private execute(path, args) { return spawn(path, args, {}); }
  async run(args) { const path = this.resolveExecutable(loc); return this.execute(path, args); }
}
EOF

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"SdkManagerBoundaryFixture.ts"* ]]
}

@test "rejects a Bun.\$ tagged-template sdkmanager execution (issue #4341)" {
  printf '%s\n' 'await Bun.$`sdkmanager --list`;' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"SdkManagerBoundaryFixture.ts"* ]]
}

@test "allows a different tool resolved through the same shape" {
  cat > "$FIXTURE" <<'EOF'
import { spawn } from "node:child_process";
class Tool {
  private resolveExecutable(location) { return join(location.path, "bin", "avdmanager"); }
  private execute(path, args) { return spawn(path, args, {}); }
  async run(args) { const path = this.resolveExecutable(loc); return this.execute(path, args); }
}
EOF

  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no direct production sdkmanager invocations"* ]]
}
