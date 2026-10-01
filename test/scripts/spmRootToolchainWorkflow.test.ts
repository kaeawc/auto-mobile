import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { loadJobSteps, loadJobs, stepNamed } from "../helpers/workflowSteps";

describe("root SPM toolchain floor workflow", () => {
  test("keeps every pull-request job off the self-hosted runner", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    const prohibitedRunners = ["self-hosted", "automobile-mac"];
    const selfHostedJobs = Object.entries(jobs)
      .filter(([, job]) =>
        prohibitedRunners.some((runner) => JSON.stringify(job["runs-on"] ?? "").includes(runner)),
      )
      .map(([name]) => name);

    expect(selfHostedJobs).toEqual([]);
  });

  test("runs swiftlint on hosted macos-26", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    const runsOn = jobs["swiftlint"]?.["runs-on"];

    expect(runsOn).toBe("macos-26");
    expect(JSON.stringify(runsOn)).not.toContain("self-hosted");
    expect(JSON.stringify(runsOn)).not.toContain("automobile-mac");
  });

  test("runs both installer-minimal legs on their hosted matrix runners", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    const runsOn = jobs["installer-minimal"]?.["runs-on"];

    expect(runsOn).toBe("${{ matrix.os }}");
    expect(JSON.stringify(runsOn)).not.toContain("self-hosted");
    expect(JSON.stringify(runsOn)).not.toContain("automobile-mac");
  });

  test("isolates installer side effects on the runner", () => {
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
