import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(import.meta.dir, "../..");
const driftCheckScript = join(repoRoot, "scripts/ios/xcodegen-drift-check.sh");
const workflowPath = join(repoRoot, ".github/workflows/pull_request.yml");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

function createTempRepo(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "auto-mobile-xcodegen-drift-"));
  tempDirs.push(tempDir);

  mkdirSync(join(tempDir, "scripts/ios"), { recursive: true });
  mkdirSync(join(tempDir, "ios/control-proxy/CtrlProxy.xcodeproj"), { recursive: true });
  mkdirSync(join(tempDir, "baseline"), { recursive: true });
  mkdirSync(join(tempDir, "bin"), { recursive: true });
  writeFileSync(
    join(tempDir, "ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj"),
    "committed project\n"
  );
  writeFileSync(join(tempDir, "baseline/project.pbxproj"), "committed project\n");
  cpSync(driftCheckScript, join(tempDir, "scripts/ios/xcodegen-drift-check.sh"));
  chmodSync(join(tempDir, "scripts/ios/xcodegen-drift-check.sh"), 0o755);
  writeFileSync(
    join(tempDir, "bin/git"),
    `#!/bin/bash
set -euo pipefail
project="\${FAKE_REPO_ROOT}/ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj"
baseline="\${FAKE_REPO_ROOT}/baseline/project.pbxproj"

if [[ "$1" == "diff" && "\${2:-}" == "--quiet" ]]; then
    cmp -s "\${baseline}" "\${project}"
    exit $?
fi

if [[ "$1" == "diff" ]]; then
    if cmp -s "\${baseline}" "\${project}"; then
        exit 0
    fi
    echo "diff --git a/ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj b/ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj"
    echo "-committed project"
    echo "+regenerated project"
    exit 0
fi

echo "unexpected git invocation: $*" >&2
exit 2
`
  );
  chmodSync(join(tempDir, "bin/git"), 0o755);

  return tempDir;
}

function writeFakeGenerator(repoDir: string, body: string): void {
  const generatorPath = join(repoDir, "scripts/ios/xcodegen-generate.sh");
  writeFileSync(generatorPath, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
  chmodSync(generatorPath, 0o755);
}

describe("xcodegen drift check", () => {
  test("script exists for CI and local validation", () => {
    expect(existsSync(driftCheckScript)).toBe(true);
  });

  test("fails when xcodegen generation changes the committed CtrlProxy project", () => {
    const repoDir = createTempRepo();
    writeFakeGenerator(
      repoDir,
      "printf 'regenerated project\\n' > ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj"
    );

    const result = spawnSync("bash", ["scripts/ios/xcodegen-drift-check.sh"], {
      cwd: repoDir,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_REPO_ROOT: repoDir,
        PATH: `${join(repoDir, "bin")}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("CtrlProxy.xcodeproj/project.pbxproj is out of date");
  });

  test("passes when xcodegen generation leaves the committed CtrlProxy project unchanged", () => {
    const repoDir = createTempRepo();
    writeFakeGenerator(repoDir, "true");

    const result = spawnSync("bash", ["scripts/ios/xcodegen-drift-check.sh"], {
      cwd: repoDir,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_REPO_ROOT: repoDir,
        PATH: `${join(repoDir, "bin")}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain("CtrlProxy.xcodeproj/project.pbxproj is in sync");
  });

  test("pull request workflow gates both Xcode project jobs on the drift check", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const xcodeBuildJob = workflow.indexOf("ios-xcode-build:");
    const xctestRunnerJob = workflow.indexOf("ios-xctest-runner-simulator-tests:");
    const xcodeBuildDriftCheck = workflow.indexOf("./scripts/ios/xcodegen-drift-check.sh", xcodeBuildJob);
    const xcodeBuild = workflow.indexOf("./scripts/ios/xcode-build.sh", xcodeBuildJob);
    const xctestRunnerDriftCheck = workflow.indexOf("./scripts/ios/xcodegen-drift-check.sh", xctestRunnerJob);
    const xctestRunnerBuild = workflow.indexOf("./scripts/ios/ctrl-proxy-build-for-testing.sh", xctestRunnerJob);

    expect(xcodeBuildJob).toBeGreaterThan(-1);
    expect(xctestRunnerJob).toBeGreaterThan(-1);
    expect(xcodeBuildDriftCheck).toBeGreaterThan(xcodeBuildJob);
    expect(xcodeBuildDriftCheck).toBeLessThan(xcodeBuild);
    expect(xctestRunnerDriftCheck).toBeGreaterThan(xctestRunnerJob);
    expect(xctestRunnerDriftCheck).toBeLessThan(xctestRunnerBuild);
  });
});
