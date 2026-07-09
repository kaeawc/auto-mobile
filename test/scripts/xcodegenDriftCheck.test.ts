import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(import.meta.dir, "../..");
const driftCheckScript = join(repoRoot, "scripts/ios/xcodegen-drift-check.sh");
const workflowPath = join(repoRoot, ".github/workflows/pull_request.yml");
const tempDirs: string[] = [];

function expectExitStatus(result: ReturnType<typeof spawnSync>, expectedStatus: number): void {
  if (result.status !== expectedStatus) {
    throw new Error(`Expected exit ${expectedStatus}, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

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
    join(tempDir, "scripts/ios/xcodegen-generate.sh"),
    `#!/bin/bash
set -euo pipefail

case "\${FAKE_REPO_WIDE_GENERATOR_BEHAVIOR:-fail}" in
    unchanged)
        ;;
    modify)
        printf 'regenerated project\\n' > ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj
        ;;
    fail)
        echo 'repo-wide xcodegen-generate.sh should not be called' >&2
        exit 2
        ;;
    *)
        echo "unexpected repo-wide generator behavior: \${FAKE_REPO_WIDE_GENERATOR_BEHAVIOR}" >&2
        exit 2
        ;;
esac
`
  );
  chmodSync(join(tempDir, "scripts/ios/xcodegen-generate.sh"), 0o755);
  writeFileSync(
    join(tempDir, "bin/xcodegen"),
    `#!/bin/bash
set -euo pipefail

if [[ "$*" != "generate" ]]; then
    echo "unexpected xcodegen invocation: $*" >&2
    exit 2
fi

expected_cwd="$(cd "\${FAKE_REPO_ROOT}/ios/control-proxy" && pwd -P)"
if [[ "$(pwd -P)" != "\${expected_cwd}" ]]; then
    echo "xcodegen ran outside CtrlProxy project: $(pwd -P)" >&2
    exit 2
fi

case "\${FAKE_XCODEGEN_BEHAVIOR:-unchanged}" in
    unchanged)
        ;;
    modify)
        printf 'regenerated project\\n' > CtrlProxy.xcodeproj/project.pbxproj
        ;;
    recreate)
        rm -f CtrlProxy.xcodeproj/project.pbxproj
        printf 'committed project\\n' > CtrlProxy.xcodeproj/project.pbxproj
        ;;
    *)
        echo "unexpected fake xcodegen behavior: \${FAKE_XCODEGEN_BEHAVIOR}" >&2
        exit 2
        ;;
esac
`
  );
  chmodSync(join(tempDir, "bin/xcodegen"), 0o755);
  writeFileSync(
    join(tempDir, "bin/git"),
    `#!/bin/bash
set -euo pipefail
project="\${FAKE_REPO_ROOT}/ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj"
baseline="\${FAKE_REPO_ROOT}/baseline/project.pbxproj"
tracked_path="ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj"

if [[ "$1" == "status" && "\${2:-}" == "--porcelain" && "\${3:-}" == "--" && "\${4:-}" == "\${tracked_path}" ]]; then
    if [[ -n "\${FAKE_GIT_STATUS_OUTPUT:-}" ]]; then
        printf "%s" "\${FAKE_GIT_STATUS_OUTPUT}"
    elif cmp -s "\${baseline}" "\${project}"; then
        exit 0
    else
        printf " M %s\\n" "\${tracked_path}"
    fi
    exit 0
fi

if [[ "$1" == "status" && "\${2:-}" == "--short" && "\${3:-}" == "--" && "\${4:-}" == "\${tracked_path}" ]]; then
    if [[ -n "\${FAKE_GIT_STATUS_OUTPUT:-}" ]]; then
        printf "%s" "\${FAKE_GIT_STATUS_OUTPUT}"
    elif ! cmp -s "\${baseline}" "\${project}"; then
        printf " M %s\\n" "\${tracked_path}"
    fi
    exit 0
fi

if [[ "$1" == "diff" && "\${2:-}" == "--" && "\${3:-}" == "\${tracked_path}" ]]; then
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

describe("xcodegen drift check", () => {
  test("script exists for CI and local validation", () => {
    expect(existsSync(driftCheckScript)).toBe(true);
  });

  test("ctrl-proxy scope fails when xcodegen generation changes the committed CtrlProxy project", () => {
    const repoDir = createTempRepo();

    const result = spawnSync("bash", ["scripts/ios/xcodegen-drift-check.sh", "--ctrl-proxy"], {
      cwd: repoDir,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_REPO_ROOT: repoDir,
        FAKE_XCODEGEN_BEHAVIOR: "modify",
        PATH: `${join(repoDir, "bin")}:${process.env.PATH ?? ""}`,
      },
    });

    expectExitStatus(result, 1);
    expect(result.stdout + result.stderr).toContain("XcodeGen project files are out of date");
  });

  test("ctrl-proxy scope fails when the regenerated CtrlProxy project is untracked after deletion", () => {
    const repoDir = createTempRepo();

    const result = spawnSync("bash", ["scripts/ios/xcodegen-drift-check.sh", "--ctrl-proxy"], {
      cwd: repoDir,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_REPO_ROOT: repoDir,
        FAKE_XCODEGEN_BEHAVIOR: "recreate",
        FAKE_GIT_STATUS_OUTPUT: "?? ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj\n",
        PATH: `${join(repoDir, "bin")}:${process.env.PATH ?? ""}`,
      },
    });

    expectExitStatus(result, 1);
    expect(result.stdout + result.stderr).toContain("XcodeGen project files are out of date");
    expect(result.stdout + result.stderr).toContain("?? ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj");
  });

  test("ctrl-proxy scope passes when xcodegen generation leaves the committed CtrlProxy project unchanged", () => {
    const repoDir = createTempRepo();

    const result = spawnSync("bash", ["scripts/ios/xcodegen-drift-check.sh", "--ctrl-proxy"], {
      cwd: repoDir,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_REPO_ROOT: repoDir,
        PATH: `${join(repoDir, "bin")}:${process.env.PATH ?? ""}`,
      },
    });

    expectExitStatus(result, 0);
    expect(result.stdout + result.stderr).toContain("XcodeGen project files are in sync");
  });

  test("all scope uses the repo-wide generator for wider iOS build gates", () => {
    const repoDir = createTempRepo();

    const result = spawnSync("bash", ["scripts/ios/xcodegen-drift-check.sh", "--all"], {
      cwd: repoDir,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_REPO_ROOT: repoDir,
        FAKE_REPO_WIDE_GENERATOR_BEHAVIOR: "modify",
        PATH: `${join(repoDir, "bin")}:${process.env.PATH ?? ""}`,
      },
    });

    expectExitStatus(result, 1);
    expect(result.stdout + result.stderr).toContain("Run scripts/ios/xcodegen-generate.sh");
  });

  test("all scope fails when repo-wide generation fails", () => {
    const repoDir = createTempRepo();

    const result = spawnSync("bash", ["scripts/ios/xcodegen-drift-check.sh", "--all"], {
      cwd: repoDir,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_REPO_ROOT: repoDir,
        PATH: `${join(repoDir, "bin")}:${process.env.PATH ?? ""}`,
      },
    });

    expectExitStatus(result, 2);
    expect(result.stdout + result.stderr).toContain("repo-wide xcodegen-generate.sh should not be called");
  });

  test("pull request workflow gates both Xcode project jobs on the drift check", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const xcodeBuildJob = workflow.indexOf("ios-xcode-build:");
    const xctestRunnerJob = workflow.indexOf("ios-xctest-runner-simulator-tests:");
    const xcodeBuildDriftCheck = workflow.indexOf("./scripts/ios/xcodegen-drift-check.sh --all", xcodeBuildJob);
    const xcodeBuild = workflow.indexOf("./scripts/ios/xcode-build.sh", xcodeBuildJob);
    const xctestRunnerDriftCheck = workflow.indexOf("./scripts/ios/xcodegen-drift-check.sh --ctrl-proxy", xctestRunnerJob);
    const xctestRunnerBuild = workflow.indexOf("./scripts/ios/ctrl-proxy-build-for-testing.sh", xctestRunnerJob);

    expect(xcodeBuildJob).toBeGreaterThan(-1);
    expect(xctestRunnerJob).toBeGreaterThan(-1);
    expect(xcodeBuildDriftCheck).toBeGreaterThan(xcodeBuildJob);
    expect(xcodeBuildDriftCheck).toBeLessThan(xcodeBuild);
    expect(xctestRunnerDriftCheck).toBeGreaterThan(xctestRunnerJob);
    expect(xctestRunnerDriftCheck).toBeLessThan(xctestRunnerBuild);
  });
});
