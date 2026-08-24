import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadJobSteps } from "../helpers/workflowSteps";

const repoRoot = join(import.meta.dir, "../..");
const driftCheckScript = join(repoRoot, "scripts/ios/xcodegen-drift-check.sh");
const versionScript = join(repoRoot, "scripts/ios/xcodegen_version.sh");
const normalizeScript = join(repoRoot, "scripts/ios/pbxproj_normalize.sh");
const tempDirs: string[] = [];

// A minimal PBXProject `targets = (...)` block in two of the orders XcodeGen
// 2.46.0 alternates between for the same spec (issue #4080). Same members, same
// UUIDs, different order — a pure reorder that must NOT be reported as drift.
const declarationOrderProject = `// !$*UTF8*$!
	targets = (
		829FFB06AC273BEE7049A7F2 /* CtrlProxyApp */,
		E35F925D729B7056D4E4B501 /* ObjCExceptionCatcher */,
		61A21F82A43E4D436CD13CCD /* CtrlProxy */,
	);
`;
const alphabeticalOrderProject = `// !$*UTF8*$!
	targets = (
		61A21F82A43E4D436CD13CCD /* CtrlProxy */,
		829FFB06AC273BEE7049A7F2 /* CtrlProxyApp */,
		E35F925D729B7056D4E4B501 /* ObjCExceptionCatcher */,
	);
`;

// The drift check sources xcodegen_version.sh and gates on the pinned version
// before generating (issue #3975), so the sandbox must carry the real pin —
// read it from the version file rather than duplicating the literal, so a
// version bump keeps these fixtures in sync automatically.
const pinnedXcodegenVersion = (() => {
  const match = /^XCODEGEN_VERSION="([^"]+)"/m.exec(readFileSync(versionScript, "utf8"));
  if (!match) {
    throw new Error(`Could not parse XCODEGEN_VERSION from ${versionScript}`);
  }
  return match[1];
})();

function expectExitStatus(result: ReturnType<typeof spawnSync>, expectedStatus: number): void {
  if (result.status !== expectedStatus) {
    throw new Error(
      `Expected exit ${expectedStatus}, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function fakeToolEnvironment(
  repoDir: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ...process.env,
    // xcodegen_version.sh prepends $HOME/.local/bin to PATH. Keep HOME owned
    // by this fixture so a host XcodeGen binary cannot eclipse bin/xcodegen.
    HOME: join(repoDir, "home"),
    FAKE_REPO_ROOT: repoDir,
    ...overrides,
    PATH: `${join(repoDir, "bin")}:${process.env.PATH ?? ""}`,
  };
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
  writeFileSync(join(tempDir, "ios/control-proxy/project.yml"), "name: CtrlProxy\n");
  writeFileSync(
    join(tempDir, "ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj"),
    "committed project\n",
  );
  writeFileSync(join(tempDir, "baseline/project.pbxproj"), "committed project\n");
  cpSync(driftCheckScript, join(tempDir, "scripts/ios/xcodegen-drift-check.sh"));
  chmodSync(join(tempDir, "scripts/ios/xcodegen-drift-check.sh"), 0o755);
  // The drift check sources this for the pin and the require_pinned gate.
  cpSync(versionScript, join(tempDir, "scripts/ios/xcodegen_version.sh"));
  // ...and this for the #4080 target-array order normalization.
  cpSync(normalizeScript, join(tempDir, "scripts/ios/pbxproj_normalize.sh"));
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
`,
  );
  chmodSync(join(tempDir, "scripts/ios/xcodegen-generate.sh"), 0o755);
  writeFileSync(
    join(tempDir, "bin/xcodegen"),
    `#!/bin/bash
set -euo pipefail

if [[ "$*" == "--version" ]]; then
    echo "Version: \${FAKE_XCODEGEN_VERSION:-${pinnedXcodegenVersion}}"
    exit 0
fi

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
    reorder)
        # Emit the committed project with only the PBXProject targets array
        # reordered — the #4080 nondeterminism the drift check must tolerate.
        printf '%s' "\${FAKE_REORDERED_PROJECT}" > CtrlProxy.xcodeproj/project.pbxproj
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
`,
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

# \`git show HEAD:<path>\` returns the committed bytes (modeled by baseline). An
# untracked (??) path is absent from HEAD, so show must fail like real git.
if [[ "$1" == "show" && "\${2:-}" == "HEAD:\${tracked_path}" ]]; then
    if [[ "\${FAKE_GIT_STATUS_OUTPUT:-}" == "??"* ]]; then
        echo "fatal: path '\${tracked_path}' does not exist in 'HEAD'" >&2
        exit 128
    fi
    cat "\${baseline}"
    exit 0
fi

# \`git checkout -- <path>\` restores the committed bytes (baseline) into the tree.
if [[ "$1" == "checkout" && "\${2:-}" == "--" && "\${3:-}" == "\${tracked_path}" ]]; then
    cp "\${baseline}" "\${project}"
    exit 0
fi

echo "unexpected git invocation: $*" >&2
exit 2
`,
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
      env: fakeToolEnvironment(repoDir, {
        FAKE_XCODEGEN_BEHAVIOR: "modify",
      }),
    });

    expectExitStatus(result, 1);
    expect(result.stdout + result.stderr).toContain("XcodeGen project files are out of date");
  }, 15_000);

  test("ctrl-proxy scope fails when the regenerated CtrlProxy project is untracked after deletion", () => {
    const repoDir = createTempRepo();

    const result = spawnSync("bash", ["scripts/ios/xcodegen-drift-check.sh", "--ctrl-proxy"], {
      cwd: repoDir,
      encoding: "utf8",
      env: fakeToolEnvironment(repoDir, {
        FAKE_XCODEGEN_BEHAVIOR: "recreate",
        FAKE_GIT_STATUS_OUTPUT: "?? ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj\n",
      }),
    });

    expectExitStatus(result, 1);
    expect(result.stdout + result.stderr).toContain("XcodeGen project files are out of date");
    expect(result.stdout + result.stderr).toContain(
      "?? ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj",
    );
  }, 15_000);

  test("ctrl-proxy scope refuses to generate with a skewed XcodeGen version", () => {
    // Regression guard for #3975: generating with a version other than the pin
    // produces an ordering-only diff that reads as a stale project file. The
    // gate must fail BEFORE writing, naming both versions.
    const repoDir = createTempRepo();

    const result = spawnSync("bash", ["scripts/ios/xcodegen-drift-check.sh", "--ctrl-proxy"], {
      cwd: repoDir,
      encoding: "utf8",
      env: fakeToolEnvironment(repoDir, {
        FAKE_XCODEGEN_VERSION: "2.45.4",
        FAKE_XCODEGEN_BEHAVIOR: "modify",
      }),
    });

    expectExitStatus(result, 1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("version mismatch");
    expect(output).toContain("2.45.4");
    expect(output).toContain(pinnedXcodegenVersion);
    // It must not have run the generator, so the project stays untouched.
    expect(
      readFileSync(join(repoDir, "ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj"), "utf8"),
    ).toBe("committed project\n");
  });

  test("ctrl-proxy scope passes when xcodegen generation leaves the committed CtrlProxy project unchanged", () => {
    const repoDir = createTempRepo();

    const result = spawnSync("bash", ["scripts/ios/xcodegen-drift-check.sh", "--ctrl-proxy"], {
      cwd: repoDir,
      encoding: "utf8",
      env: fakeToolEnvironment(repoDir),
    });

    expectExitStatus(result, 0);
    expect(result.stdout + result.stderr).toContain("XcodeGen project files are in sync");
  });

  test("ctrl-proxy scope passes when only the PBXProject target order changed (#4080)", () => {
    // XcodeGen 2.46.0 emits the targets array in one of two environment-dependent
    // orders for the same spec + pinned version. A pure reorder is not drift, so
    // the check must normalize it away and pass — not fail like a stale project.
    const repoDir = createTempRepo();
    const projectPath = join(repoDir, "ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj");
    // Commit the declaration order; the fake generator emits the alphabetical one.
    writeFileSync(projectPath, declarationOrderProject);
    writeFileSync(join(repoDir, "baseline/project.pbxproj"), declarationOrderProject);

    const result = spawnSync("bash", ["scripts/ios/xcodegen-drift-check.sh", "--ctrl-proxy"], {
      cwd: repoDir,
      encoding: "utf8",
      env: fakeToolEnvironment(repoDir, {
        FAKE_XCODEGEN_BEHAVIOR: "reorder",
        FAKE_REORDERED_PROJECT: alphabeticalOrderProject,
      }),
    });

    expectExitStatus(result, 0);
    expect(result.stdout + result.stderr).toContain("target-array order normalized");
    // The benign reorder must be restored to the committed bytes, not left dirty.
    expect(readFileSync(projectPath, "utf8")).toBe(declarationOrderProject);
  });

  test("all scope uses the repo-wide generator for wider iOS build gates", () => {
    const repoDir = createTempRepo();

    const result = spawnSync("bash", ["scripts/ios/xcodegen-drift-check.sh", "--all"], {
      cwd: repoDir,
      encoding: "utf8",
      env: fakeToolEnvironment(repoDir, {
        FAKE_REPO_WIDE_GENERATOR_BEHAVIOR: "modify",
      }),
    });

    expectExitStatus(result, 1);
    expect(result.stdout + result.stderr).toContain("Run scripts/ios/xcodegen-generate.sh");
  }, 15_000);

  test("all scope fails when repo-wide generation fails", () => {
    const repoDir = createTempRepo();

    const result = spawnSync("bash", ["scripts/ios/xcodegen-drift-check.sh", "--all"], {
      cwd: repoDir,
      encoding: "utf8",
      env: fakeToolEnvironment(repoDir),
    });

    expectExitStatus(result, 2);
    expect(result.stdout + result.stderr).toContain(
      "repo-wide xcodegen-generate.sh should not be called",
    );
  });

  test("pull request workflow gates both Xcode project jobs on the drift check", () => {
    const xcodeBuildSteps = loadJobSteps(".github/workflows/pull_request.yml", "ios-xcode-build");
    const xctestRunnerSteps = loadJobSteps(
      ".github/workflows/pull_request.yml",
      "ios-xctest-runner-simulator-tests",
    );
    const indexOfRun = (steps: typeof xcodeBuildSteps, command: string) =>
      steps.findIndex((step) => step.run?.includes(command));

    const xcodeBuildDriftCheck = indexOfRun(
      xcodeBuildSteps,
      "./scripts/ios/xcodegen-drift-check.sh --all",
    );
    const xcodeBuild = indexOfRun(xcodeBuildSteps, "./scripts/ios/xcode-build.sh");
    const xctestRunnerDriftCheck = indexOfRun(
      xctestRunnerSteps,
      "./scripts/ios/xcodegen-drift-check.sh --ctrl-proxy",
    );
    const xctestRunnerBuild = indexOfRun(
      xctestRunnerSteps,
      "./scripts/ios/ctrl-proxy-build-for-testing.sh",
    );

    expect(xcodeBuildSteps.length).toBeGreaterThan(0);
    expect(xctestRunnerSteps.length).toBeGreaterThan(0);
    expect(xcodeBuildDriftCheck).toBeGreaterThanOrEqual(0);
    expect(xcodeBuildDriftCheck).toBeLessThan(xcodeBuild);
    expect(xctestRunnerDriftCheck).toBeGreaterThanOrEqual(0);
    expect(xctestRunnerDriftCheck).toBeLessThan(xctestRunnerBuild);
  });
});
