import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { loadJobSteps, loadJobs, stepNamed } from "../helpers/workflowSteps";

describe("root SPM toolchain floor workflow", () => {
  // The documented SwiftLint exception and the macOS-only installer-minimal matrix
  // leg route kaeawc-authored PRs to the self-hosted runner. Every other PR job
  // stays on a GitHub-hosted runner.
  const SELF_HOSTED_PR_EXCEPTIONS = new Set(["swiftlint", "installer-minimal"]);

  test("keeps every non-excepted pull-request job off the self-hosted runner", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    const prohibitedRunners = ["self-hosted", "automobile-mac"];
    const selfHostedJobs = Object.entries(jobs)
      .filter(
        ([name, job]) =>
          !SELF_HOSTED_PR_EXCEPTIONS.has(name) &&
          prohibitedRunners.some((runner) => JSON.stringify(job["runs-on"] ?? "").includes(runner)),
      )
      .map(([name]) => name);

    expect(selfHostedJobs).toEqual([]);
  });

  test("routes swiftlint to the self-hosted runner behind the kaeawc author guard", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    const runsOn = JSON.stringify(jobs["swiftlint"]?.["runs-on"] ?? "");

    expect(runsOn).toContain("automobile-mac");
    expect(runsOn).toContain("github.event.pull_request.user.login == 'kaeawc'");
    // Fallback to a GitHub-hosted runner for every other author.
    expect(runsOn).toContain("macos-26");
  });

  test("routes only kaeawc's macOS installer-minimal leg to the self-hosted runner", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    const runsOn = JSON.stringify(jobs["installer-minimal"]?.["runs-on"] ?? "");

    expect(runsOn).toContain("matrix.os == 'macos-latest'");
    expect(runsOn).toContain("github.event.pull_request.user.login == 'kaeawc'");
    expect(runsOn).toContain("automobile-mac");
    expect(runsOn).toContain("|| matrix.os");
  });

  test("isolates installer side effects on the persistent runner", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    const steps = loadJobSteps(".github/workflows/pull_request.yml", "installer-minimal");
    const fixture = stepNamed(steps, "Confirm clean installer fixture");
    const cleanup = stepNamed(steps, "Remove generated project MCP configuration");

    expect(jobs["installer-minimal"]?.env?.AUTOMOBILE_SKIP_STALE_DAEMON_MIGRATION).toBe("true");
    expect(fixture?.run).toContain('test ! -e "$config"');
    expect(cleanup?.run).toContain(".codex/config.toml .cursor/mcp.json .vscode/mcp.json");
    expect(cleanup?.run).toContain('rm -f -- "$config"');
    expect(cleanup?.run).not.toContain("uninstall.sh");
  });

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
        const steps = loadJobSteps(".github/workflows/pull_request.yml", "installer-minimal");
        const prepare = stepNamed(steps, "Confirm clean installer fixture")!.run!;
        const cleanup = stepNamed(steps, "Remove generated project MCP configuration")!.run!;
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
          if (target) expect(existsSync(join(root, target))).toBe(false);
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

    expect(selectXcode?.if).toBeUndefined();
    expect(selectXcode?.uses).toBe("maxim-lobanov/setup-xcode@v1");
    expect(selectXcode?.with?.["xcode-version"]).toBe("${{ matrix.config.xcode }}");
  });

  test("selects Xcode 26.5 on every runner before building the root package", () => {
    const steps = loadJobSteps(".github/workflows/pull_request.yml", "ios-spm-root-package-build");
    const selectXcode = stepNamed(steps, "Select Xcode 26.5");

    expect(steps.length).toBeGreaterThan(0);
    expect(selectXcode).toBeDefined();
    expect(selectXcode?.if).toBeUndefined();
    expect(selectXcode?.uses).toBe("maxim-lobanov/setup-xcode@v1");
    expect(selectXcode?.with?.["xcode-version"]).toBe("26.5");
    expect(steps.indexOf(selectXcode!)).toBeLessThan(
      steps.findIndex((step) => step.name === "Build root Package.swift"),
    );
  });
});
