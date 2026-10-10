import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { loadJobSteps, loadJobs, loadWorkflow, stepNamed } from "../helpers/workflowSteps";

const OWNER = "github.event.pull_request.user.login == 'kaeawc'";
const SAME_REPO = "github.event.pull_request.head.repo.full_name == github.repository";
const POOLS_ENABLED = "vars.AUTOMOBILE_MAC_POOLS_ENABLED == 'true'";
const SMALL_LABEL = 'fromJSON(\'["self-hosted","automobile-mac"]\')';
const HEAVY_LABEL = 'fromJSON(\'["self-hosted","automobile-mac-heavy"]\')';
const ORIGINAL_SELF_HOSTED_JOBS = [
  "build-desktop-app",
  "installer-minimal",
  "swiftlint",
  "swift-code-coverage",
];
const SMALL_POOL_JOBS = ["ios-swift-packages", "ios-spm-root-package-build"];
const HEAVY_LANE_JOBS = ["ios-xcode-build", "ios-playground-tests", "prototype-simulator"];
const FALLBACK: Record<string, string> = {
  "ios-swift-packages": "matrix.config.runner",
  "ios-spm-root-package-build": "'macos-26'",
  "ios-xcode-build": "matrix.config.runner",
  "ios-playground-tests": "matrix.config.runner",
  "prototype-simulator": "'macos-26'",
};

describe("root SPM toolchain floor workflow", () => {
  test("permits only the listed PR jobs on the self-hosted runners", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    const prohibitedRunners = ["self-hosted", "automobile-mac"];
    const selfHostedJobs = Object.entries(jobs)
      .filter(([, job]) =>
        prohibitedRunners.some((runner) => JSON.stringify(job["runs-on"] ?? "").includes(runner)),
      )
      .map(([name]) => name);

    expect(selfHostedJobs.sort()).toEqual(
      [
        ...ORIGINAL_SELF_HOSTED_JOBS,
        ...SMALL_POOL_JOBS,
        ...HEAVY_LANE_JOBS,
        // Namespace macOS first; heavy lane only as its documented fallback (#11012).
        "ios-device-webrtc",
      ].sort(),
    );
  });

  test("routes only owner-authored same-repository PRs to the Mac", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    for (const name of [...ORIGINAL_SELF_HOSTED_JOBS, ...SMALL_POOL_JOBS, ...HEAVY_LANE_JOBS]) {
      const runsOn = jobs[name]?.["runs-on"];
      expect(runsOn).toContain(OWNER);
      expect(runsOn).toContain(SAME_REPO);
    }
    for (const name of ORIGINAL_SELF_HOSTED_JOBS) {
      expect(jobs[name]?.["runs-on"]).toContain(SMALL_LABEL);
    }
    expect(jobs["build-desktop-app"]?.["runs-on"]).toContain("matrix.os == 'macos-latest'");
    expect(jobs["build-desktop-app"]?.["runs-on"]).toContain("|| matrix.os");
    expect(jobs["installer-minimal"]?.["runs-on"]).toContain("matrix.os == 'macos-latest'");
    expect(jobs["installer-minimal"]?.["runs-on"]).toContain("|| matrix.os");
    for (const name of ["swiftlint", "swift-code-coverage"]) {
      expect(jobs[name]?.["runs-on"]).toContain("|| 'macos-26'");
    }
  });

  test("splits the moved iOS jobs into the small pool and the single heavy lane (#11011)", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    const heavy = Object.entries(jobs)
      .filter(([, job]) => JSON.stringify(job["runs-on"] ?? "").includes("automobile-mac-heavy"))
      .map(([name]) => name);
    expect(heavy.sort()).toEqual([...HEAVY_LANE_JOBS, "ios-device-webrtc"].sort());
    for (const name of [...SMALL_POOL_JOBS, ...HEAVY_LANE_JOBS]) {
      const runsOn = String(jobs[name]?.["runs-on"]);
      const label = HEAVY_LANE_JOBS.includes(name) ? HEAVY_LABEL : SMALL_LABEL;
      // The rollout switch keeps jobs off pools that are not registered yet.
      expect(runsOn).toBe(
        `\${{ (${OWNER} && ${SAME_REPO} && ${POOLS_ENABLED}) && ${label} || ${FALLBACK[name]} }}`,
      );
    }
    for (const name of HEAVY_LANE_JOBS) {
      // One heavy runner process: a hung job must not hold the lane for long.
      expect(jobs[name]?.["timeout-minutes"]).toBeLessThanOrEqual(30);
    }
    const xcodeBuild = loadJobSteps(".github/workflows/pull_request.yml", "ios-xcode-build");
    // The PR-time XcodeGen drift gate (#10939) runs on the heavy lane.
    expect(stepNamed(xcodeBuild, "Check XcodeGen Project Drift")?.run).toBe(
      "./scripts/ios/xcodegen-drift-check.sh --all",
    );
  });

  test("never imports signing certificates on the self-hosted Mac", () => {
    const env = loadJobs(".github/workflows/pull_request.yml")["ios-swift-packages"]?.env;
    for (const key of ["IOS_SIGNING_ENABLED", "MACOS_SIGNING_ENABLED"]) {
      expect(String(env?.[key])).toContain(`!(${OWNER} && ${SAME_REPO} && ${POOLS_ENABLED})`);
    }
  });

  test("moved iOS jobs isolate their home and select Xcode per runner kind", () => {
    for (const name of [...SMALL_POOL_JOBS, ...HEAVY_LANE_JOBS]) {
      const steps = loadJobSteps(".github/workflows/pull_request.yml", name);
      const checkout = stepNamed(steps, "Git Checkout");
      const isolate = steps.find((step) => step.name?.startsWith("Isolate self-hosted"));
      const cleanup = steps.find((step) => step.name?.startsWith("Remove isolated"));
      expect(isolate?.if, name).toBe("runner.environment == 'self-hosted'");
      expect(isolate?.run).toContain('echo "HOME=');
      expect(steps.indexOf(isolate!)).toBeLessThan(steps.indexOf(checkout!));
      expect(checkout?.with?.clean).toBe(true);
      expect(cleanup?.if).toBe("always() && runner.environment == 'self-hosted'");
      expect(steps.indexOf(cleanup!)).toBe(steps.length - 1);
      const hosted = steps.find((step) => step.uses === "maxim-lobanov/setup-xcode@v1");
      const selfHosted = steps.find((step) => step.name?.startsWith("Select self-hosted Xcode"));
      expect(hosted?.if, name).toBe("runner.environment == 'github-hosted'");
      expect(selfHosted?.if).toBe("runner.environment == 'self-hosted'");
      expect(selfHosted?.run).toContain("bash scripts/ci/select-self-hosted-xcode.sh");
      expect(steps.indexOf(checkout!)).toBeLessThan(steps.indexOf(selfHosted!));
    }
  });

  test("preserves all four rendered check names and matrix values", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    expect(jobs["installer-minimal"]?.name).toBe("Installer Minimal (${{ matrix.os }})");
    expect(jobs["installer-minimal"]?.strategy?.matrix?.os).toEqual([
      "ubuntu-latest",
      "macos-latest",
    ]);
    expect(jobs["build-desktop-app"]?.name).toBe("Build Desktop App (${{ matrix.os }})");
    expect(jobs["build-desktop-app"]?.strategy?.matrix?.os).toEqual([
      "ubuntu-latest",
      "macos-latest",
      "windows-latest",
    ]);
    expect(jobs["swiftlint"]?.name).toBe("SwiftLint");
    expect(jobs["swift-code-coverage"]?.name).toBe("Swift Code Coverage");
  });

  test("pre-checkout run steps work without a checked-out directory", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    for (const jobId of [
      "build-desktop-app",
      "installer-minimal",
      "swiftlint",
      "swift-code-coverage",
    ]) {
      const job = jobs[jobId];
      const steps = job?.steps ?? [];
      const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkoutIndex).toBeGreaterThanOrEqual(0);
      for (const step of steps.slice(0, checkoutIndex)) {
        if (step.run !== undefined && job?.defaults?.run?.["working-directory"] !== undefined) {
          expect(step["working-directory"]).toBe(".");
        }
      }
    }
  });

  test("isolates the three self-hosted jobs and gates hosted toolchain setup", () => {
    for (const name of ["build-desktop-app", "swiftlint", "swift-code-coverage"]) {
      const steps = loadJobSteps(".github/workflows/pull_request.yml", name);
      const checkout = stepNamed(steps, "Git Checkout");
      expect(checkout?.uses).toBe("actions/checkout@v6");
      expect(checkout?.with?.clean ?? true).toBe(true);
      const isolate = steps.find((step) => step.name?.startsWith("Isolate self-hosted"));
      const cleanup = steps.find(
        (step) =>
          step.name?.startsWith("Remove isolated") || step.name?.startsWith("Stop isolated"),
      );
      expect(isolate?.if).toBe("runner.environment == 'self-hosted'");
      expect(isolate?.run).toContain("$RUNNER_TEMP/");
      expect(isolate?.run).toContain('echo "HOME=');
      expect(isolate?.run).toContain('echo "TMPDIR=');
      expect(isolate?.run).toContain('echo "XDG_CONFIG_HOME=');
      expect(isolate?.run).toContain('echo "XDG_DATA_HOME=');
      expect(steps.indexOf(isolate!)).toBeLessThan(steps.indexOf(checkout!));
      expect(cleanup?.if).toContain("always()");
      expect(cleanup?.run).toContain("rm -rf --");
    }
    const coverage = loadJobSteps(".github/workflows/pull_request.yml", "swift-code-coverage");
    expect(stepNamed(coverage, "Select Xcode 26.5")?.if).toBe(
      "runner.environment == 'github-hosted'",
    );
    const lint = loadJobSteps(".github/workflows/pull_request.yml", "swiftlint");
    expect(
      stepNamed(lint, "Run SwiftLint (fail on error-severity rules)")?.env
        ?.INSTALL_SWIFTLINT_WHEN_MISSING,
    ).toContain("runner.environment == 'github-hosted'");
    const desktop = loadJobSteps(".github/workflows/pull_request.yml", "build-desktop-app");
    const gradleStep = desktop.find((step) => step.uses === "./.github/actions/gradle-task-run");
    expect(gradleStep?.with?.["gradle-home-directory"]).toContain("runner.temp");
    expect(gradleStep?.with?.["gradle-flags"]).toContain(
      "runner.environment == 'self-hosted' && '[\"-Dorg.gradle.java.installations.auto-download=false\"]' || '[]'",
    );
    const selectJdk = stepNamed(desktop, "Select JDK 21");
    const isolateDesktop = stepNamed(desktop, "Isolate self-hosted desktop build");
    expect(stepNamed(desktop, "Require ambient JDK 21")).toBeUndefined();
    expect(selectJdk?.if).toBe("runner.environment == 'self-hosted'");
    expect(desktop.indexOf(selectJdk!)).toBeLessThan(desktop.indexOf(isolateDesktop!));
    expect(selectJdk?.run).toContain("/usr/libexec/java_home -v 21");
    expect(selectJdk?.run).toContain('[[ -z "$jdk_home" ]]');
    expect(selectJdk?.run).toContain("::error::");
    expect(selectJdk?.run).toContain('javac_version=$("$jdk_home/bin/javac" -version 2>&1)');
    expect(selectJdk?.run).toContain("grep -Eq '^javac 21([.]|$)' <<<\"$javac_version\"");
    expect(selectJdk?.run).toContain('echo "JAVA_HOME=$jdk_home" >> "$GITHUB_ENV"');
    expect(selectJdk?.run).toContain('echo "$jdk_home/bin" >> "$GITHUB_PATH"');
    expect(stepNamed(desktop, "Isolate self-hosted desktop build")?.run).toContain(
      "GRADLE_STATE_DIR=",
    );
    expect(stepNamed(desktop, "Isolate self-hosted desktop build")?.run).toContain(
      "GRADLE_RETRY_LOG_DIR=",
    );
    const desktopIsolate = stepNamed(desktop, "Isolate self-hosted desktop build")?.run ?? "";
    expect(stepNamed(desktop, "Isolate self-hosted desktop build")?.["working-directory"]).toBe(
      ".",
    );
    expect(desktopIsolate).toContain(
      'sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"',
    );
    expect(desktopIsolate.indexOf("sdk_root=")).toBeLessThan(desktopIsolate.indexOf('echo "HOME='));
    expect(desktopIsolate).toContain('[[ ! -d "$sdk_root" ]]');
    expect(desktopIsolate).toContain('echo "ANDROID_HOME=$sdk_root"');
    expect(desktopIsolate).toContain('echo "ANDROID_SDK_ROOT=$sdk_root"');
    expect(desktopIsolate).toContain('echo "GRADLE_USER_HOME=$isolated_home/gradle"');
    expect(desktopIsolate).toContain('echo "JAVA_TOOL_OPTIONS=-Duser.home=$isolated_home"');
    const desktopCleanup = stepNamed(
      desktop,
      "Stop isolated Gradle daemon and remove desktop home",
    );
    expect(desktopCleanup?.["working-directory"]).toBe(".");
    expect(desktopCleanup?.run).toContain("if ! (cd android && ./gradlew --stop); then");
    expect(desktopCleanup?.run).toContain("::warning::Failed to stop");
    expect(desktopCleanup?.run?.indexOf("cd android && ./gradlew --stop")).toBeLessThan(
      desktopCleanup?.run?.indexOf("rm -rf --") ?? 0,
    );
    expect(desktopCleanup?.run).toContain(
      'rm -rf -- "$RUNNER_TEMP/desktop-home-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"',
    );
  });

  test("cancels superseded PR runs at workflow scope", () => {
    const concurrency = loadWorkflow(".github/workflows/pull_request.yml").concurrency;
    expect(concurrency?.group).toBe(
      "pull-request-${{ github.event.pull_request.number || github.ref }}",
    );
    expect(concurrency?.["cancel-in-progress"]).toBe(true);
  });

  test("isolates installer side effects on the runner", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    const steps = loadJobSteps(".github/workflows/pull_request.yml", "installer-minimal");
    const fixture = stepNamed(steps, "Confirm clean installer fixture");
    const cleanup = stepNamed(steps, "Remove generated project MCP configuration");
    const isolate = stepNamed(steps, "Isolate self-hosted installer home");
    const homeCleanup = stepNamed(steps, "Remove isolated installer home");

    expect(jobs["installer-minimal"]?.env?.AUTOMOBILE_SKIP_STALE_DAEMON_MIGRATION).toBe("true");
    expect(stepNamed(steps, "Git Checkout")?.with?.clean).toBe(true);
    expect(isolate?.if).toContain("runner.environment == 'self-hosted'");
    expect(steps.indexOf(isolate!)).toBeLessThan(steps.indexOf(stepNamed(steps, "Git Checkout")!));
    expect(steps.indexOf(isolate!)).toBeLessThan(steps.indexOf(fixture!));
    for (const variable of [
      "HOME",
      "TMPDIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "CFFIXED_USER_HOME",
    ]) {
      expect(isolate?.run).toContain(`echo "${variable}=$isolated_home`);
    }
    expect(isolate?.run).toContain("$RUNNER_TEMP/installer-home-");
    expect(homeCleanup?.if).toBe("always() && runner.environment == 'self-hosted'");
    expect(homeCleanup?.run).toContain('rm -rf -- "$RUNNER_TEMP/installer-home-');
    expect(fixture?.run).toContain('test ! -e "$config"');
    expect(cleanup?.run).toContain(".codex/config.toml .cursor/mcp.json .vscode/mcp.json");
    expect(cleanup?.run).toContain('rm -f -- "$config"');
    expect(cleanup?.run).not.toContain("uninstall.sh");
  });

  // Parse the workflow once at load; each case below then only pays for its bash spawns.
  const installerSteps = loadJobSteps(".github/workflows/pull_request.yml", "installer-minimal");
  const prepareScript = stepNamed(installerSteps, "Confirm clean installer fixture")!.run!;
  const cleanupScript = stepNamed(
    installerSteps,
    "Remove generated project MCP configuration",
  )!.run!;

  for (const target of [
    ".mcp.json",
    ".codex/config.toml",
    ".cursor/mcp.json",
    ".vscode/mcp.json",
    null,
  ]) {
    test.skipIf(process.platform === "win32")(
      `cleanup preserves unrelated files for ${target ?? "no client"}`,
      () => {
        const prepare = prepareScript;
        const cleanup = cleanupScript;
        const root = mkdtempSync(join(tmpdir(), "installer-cleanup-"));
        try {
          const env = { ...process.env, GITHUB_ENV: join(root, "result") };
          writeFileSync(join(root, "unrelated"), "preserve");
          expect(spawnSync("bash", ["-e", "-c", prepare], { cwd: root, env }).status).toBe(0);
          if (target) {
            mkdirSync(dirname(join(root, target)), { recursive: true });
            writeFileSync(join(root, target), "generated fixture");
            expect(spawnSync("bash", ["-e", "-c", prepare], { cwd: root, env }).status).not.toBe(0);
          }
          expect(spawnSync("bash", ["-e", "-c", cleanup], { cwd: root, env }).status).toBe(0);
          if (target) {
            expect(existsSync(join(root, target))).toBe(false);
          }
          expect(existsSync(join(root, "unrelated"))).toBe(true);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  }

  test.skipIf(process.platform === "win32")("fixture rejects symlinked client directories", () => {
    const prepare = stepNamed(
      loadJobSteps(".github/workflows/pull_request.yml", "installer-minimal"),
      "Confirm clean installer fixture",
    )!.run!;
    const root = mkdtempSync(join(tmpdir(), "installer-symlink-"));
    try {
      mkdirSync(join(root, "outside"));
      symlinkSync(join(root, "outside"), join(root, ".codex"), "dir");
      expect(spawnSync("bash", ["-e", "-c", prepare], { cwd: root }).status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pins the Swift package matrix to its configured Xcode floor", () => {
    const steps = loadJobSteps(".github/workflows/pull_request.yml", "ios-swift-packages");
    const selectXcode = stepNamed(steps, "Select Xcode ${{ matrix.config.xcode }}");
    const selfHosted = stepNamed(steps, "Select self-hosted Xcode ${{ matrix.config.xcode }}");

    expect(selectXcode?.if).toBe("runner.environment == 'github-hosted'");
    expect(selectXcode?.uses).toBe("maxim-lobanov/setup-xcode@v1");
    expect(selectXcode?.with?.["xcode-version"]).toBe("${{ matrix.config.xcode }}");
    expect(selfHosted?.run).toBe(
      'bash scripts/ci/select-self-hosted-xcode.sh "${{ matrix.config.xcode }}"',
    );
  });

  test("selects Xcode 26.5 on every runner before building the root package", () => {
    const steps = loadJobSteps(".github/workflows/pull_request.yml", "ios-spm-root-package-build");
    const selectXcode = stepNamed(steps, "Select Xcode 26.5");
    const selfHosted = stepNamed(steps, "Select self-hosted Xcode 26.5");
    const build = steps.findIndex((step) => step.name === "Build root Package.swift");

    expect(steps.length).toBeGreaterThan(0);
    expect(selectXcode?.if).toBe("runner.environment == 'github-hosted'");
    expect(selectXcode?.uses).toBe("maxim-lobanov/setup-xcode@v1");
    expect(selectXcode?.with?.["xcode-version"]).toBe("26.5");
    expect(selfHosted?.run).toBe('bash scripts/ci/select-self-hosted-xcode.sh "26.5"');
    expect(steps.indexOf(selectXcode!)).toBeLessThan(build);
    expect(steps.indexOf(selfHosted!)).toBeLessThan(build);
  });
});
