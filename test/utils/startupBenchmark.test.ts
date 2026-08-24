import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import {
  isStartupBenchmarkEnabled,
  StartupBenchmark,
  type StartupBenchmarkFileSystem,
} from "../../src/utils/startupBenchmark";

describe("StartupBenchmark checkpoints", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("persists active startup phases until daemon readiness completes", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-benchmark-"));
    tempDirs.push(dir);
    const outputPath = join(dir, "startup.json");
    let now = 100;
    const benchmark = new StartupBenchmark(true, {
      outputPath,
      label: "installer-development",
      now: () => now,
    });

    benchmark.mark("processEntry");
    benchmark.startPhase("androidCtrlProxyPrefetch");

    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      type: "startup-checkpoint",
      state: "in_progress",
      label: "installer-development",
      marks: { processEntry: 100 },
      phases: {},
      activePhases: ["androidCtrlProxyPrefetch"],
    });

    now = 375;
    benchmark.endPhase("androidCtrlProxyPrefetch");
    benchmark.emit("daemon", { listenerBound: true });

    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      type: "daemon",
      state: "ready",
      phases: { androidCtrlProxyPrefetch: 275 },
      activePhases: [],
      meta: { listenerBound: true },
    });
  });

  test("persists module loading as the active phase before imports complete", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-benchmark-"));
    tempDirs.push(dir);
    const outputPath = join(dir, "startup.json");
    const benchmark = new StartupBenchmark(true, { outputPath });

    benchmark.mark("processEntry");
    benchmark.startPhase("moduleImports");

    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      type: "startup-checkpoint",
      state: "in_progress",
      marks: { processEntry: expect.any(Number) },
      phases: {},
      activePhases: ["moduleImports"],
    });
  });

  test("preserves the ready report when a background phase settles after readiness", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-benchmark-"));
    tempDirs.push(dir);
    const outputPath = join(dir, "startup.json");
    let now = 100;
    const benchmark = new StartupBenchmark(true, {
      outputPath,
      now: () => now,
    });

    benchmark.startPhase("iosCtrlProxyPrefetch");
    benchmark.emit("daemon", { daemonSocketListenerBound: true });

    now = 325;
    benchmark.endPhase("iosCtrlProxyPrefetch");

    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      type: "daemon",
      state: "ready",
      phases: { iosCtrlProxyPrefetch: 225 },
      activePhases: [],
      meta: { daemonSocketListenerBound: true },
    });
  });

  test("atomically replaces checkpoint files", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-benchmark-"));
    tempDirs.push(dir);
    const outputPath = join(dir, "startup.json");
    const renameCalls: Array<[string, string]> = [];
    const fileSystem: StartupBenchmarkFileSystem = {
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      writeFileSync: fs.writeFileSync,
      renameSync: (from, to) => {
        renameCalls.push([from.toString(), to.toString()]);
        fs.renameSync(from, to);
      },
    };

    new StartupBenchmark(true, { outputPath, fileSystem }).mark("processEntry");

    expect(renameCalls).toEqual([[`${outputPath}.${process.pid}.tmp`, outputPath]]);
  });

  test("resolves relative output paths from the daemon launch working directory", () => {
    const launchCwd = mkdtempSync(join(tmpdir(), "startup-benchmark-launch-cwd-"));
    tempDirs.push(launchCwd);
    const originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    const fileSystem: StartupBenchmarkFileSystem = {
      existsSync: () => true,
      mkdirSync: () => undefined,
      writeFileSync: (filePath) => {
        writes.push(filePath.toString());
      },
      renameSync: (from, to) => {
        renames.push([from.toString(), to.toString()]);
      },
    };

    process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;
    try {
      new StartupBenchmark(true, {
        outputPath: join("ci-logs", "installer-daemon-startup.json"),
        fileSystem,
      }).mark("processEntry");

      const outputPath = join(launchCwd, "ci-logs", "installer-daemon-startup.json");
      expect(writes).toEqual([`${outputPath}.${process.pid}.tmp`]);
      expect(renames).toEqual([[`${outputPath}.${process.pid}.tmp`, outputPath]]);
    } finally {
      if (originalLaunchCwd === undefined) {
        delete process.env[DAEMON_LAUNCH_CWD_ENV];
      } else {
        process.env[DAEMON_LAUNCH_CWD_ENV] = originalLaunchCwd;
      }
    }
  });

  test("keeps a failed phase active in its checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-benchmark-"));
    tempDirs.push(dir);
    const outputPath = join(dir, "startup.json");
    const benchmark = new StartupBenchmark(true, { outputPath });
    const failure = new Error("database unavailable");

    await expect(
      benchmark.runPhase("databasePreflight", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      type: "startup-checkpoint",
      state: "in_progress",
      phases: {},
      activePhases: ["databasePreflight"],
    });
  });
});

describe("isStartupBenchmarkEnabled", () => {
  test("limits environment-driven reports to the detached daemon process", () => {
    const environment = { AUTOMOBILE_STARTUP_BENCHMARK: "1" };

    expect(isStartupBenchmarkEnabled(["bun", "index.ts", "--daemon-mode"], environment)).toBe(true);
    expect(isStartupBenchmarkEnabled(["auto-mobile", "--daemon", "start"], environment)).toBe(
      false,
    );
    expect(isStartupBenchmarkEnabled(["auto-mobile", "--daemon", "health"], environment)).toBe(
      false,
    );
  });

  test("keeps the explicit benchmark flag available outside daemon mode", () => {
    expect(isStartupBenchmarkEnabled(["bun", "index.ts", "--startup-benchmark"], {})).toBe(true);
  });
});
