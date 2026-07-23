import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  DaemonLauncher,
  type DaemonProcessSpawner,
} from "../../src/daemon/DaemonLauncher";

class FakeDaemonProcess extends EventEmitter {
  unref(): void {}
}

class FakeDaemonSpawner implements DaemonProcessSpawner {
  readonly calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  readonly process = new FakeDaemonProcess();

  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess {
    this.calls.push({ command, args, options });
    return this.process as ChildProcess;
  }
}

describe("DaemonLauncher", () => {
  test("uses POSIX PATH semantics for an injected Linux platform", () => {
    const launcher = new DaemonLauncher({
      entryScript: null,
      version: "1.2.3",
      environment: { PATH: "/tools:/other" },
      platform: "linux",
      executableExists: path => path === "/tools/bunx",
    });

    expect(launcher.resolveCommand()).toEqual({
      command: "/tools/bunx",
      args: ["-y", "@kaeawc/auto-mobile@1.2.3", "--daemon-mode"],
    });
  });

  test("falls back to the Bun executable when bunx is unavailable", () => {
    const launcher = new DaemonLauncher({
      entryScript: null,
      version: "1.2.3",
      environment: { PATH: "/tools" },
      platform: "linux",
      executableExists: () => false,
      processExecPath: "/tools/bun",
    });

    expect(launcher.resolveCommand()).toEqual({
      command: "/tools/bun",
      args: ["x", "-y", "@kaeawc/auto-mobile@1.2.3", "--daemon-mode"],
    });
  });

  test("prefers the current entry script over a package runner", () => {
    const launcher = new DaemonLauncher({
      entryScript: "/workspace/dist/src/index.js",
      version: "1.2.3",
      environment: { PATH: "/tools" },
      platform: "linux",
      executableExists: () => true,
      processExecPath: "/runtime/node",
    });

    expect(launcher.resolveCommand()).toEqual({
      command: "/runtime/node",
      args: ["/workspace/dist/src/index.js", "--daemon-mode"],
    });
  });

  test("uses only executable PATHEXT entries when resolving bunx on Windows", () => {
    const launcher = new DaemonLauncher({
      entryScript: null,
      version: "1.2.3",
      environment: { Path: "C:\\Tools", PATHEXT: ".CMD;.EXE" },
      platform: "win32",
      executableExists: path => path === "C:\\Tools\\bunx.EXE",
    });

    expect(launcher.resolveCommand().command).toBe("C:\\Tools\\bunx.EXE");
  });

  test("spawns without a shell and cleans up startup listeners after readiness", async () => {
    const spawner = new FakeDaemonSpawner();
    const launcher = new DaemonLauncher({ spawn: spawner.spawn.bind(spawner) });
    let aborted = false;

    await launcher.launchAndWait({
      command: "auto-mobile",
      args: ["--daemon-mode", "--host", "host with spaces"],
      spawnOptions: { env: { FEATURE: "enabled" } },
      timeoutMs: 100,
      waitForReady: async (_timeoutMs, signal) => {
        aborted = signal.aborted;
        return true;
      },
      formatFailure: async summary => new Error(summary),
    });

    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]).toMatchObject({
      command: "auto-mobile",
      args: ["--daemon-mode", "--host", "host with spaces"],
      options: { shell: false, env: { FEATURE: "enabled" } },
    });
    expect(aborted).toBe(false);
    expect(spawner.process.listenerCount("error")).toBe(0);
    expect(spawner.process.listenerCount("exit")).toBe(0);
  });

  test("aborts readiness and returns the formatted child startup error", async () => {
    const spawner = new FakeDaemonSpawner();
    const launcher = new DaemonLauncher({ spawn: spawner.spawn.bind(spawner) });
    let readinessSignal: AbortSignal | undefined;

    const launch = launcher.launchAndWait({
      command: "auto-mobile",
      args: ["--daemon-mode"],
      spawnOptions: {},
      timeoutMs: 100,
      waitForReady: async (_timeoutMs, signal) => {
        readinessSignal = signal;
        return new Promise<boolean>(() => {});
      },
      formatFailure: async summary => new Error(`formatted: ${summary}`),
    });
    spawner.process.emit("error", new Error("ENOENT"));

    await expect(launch).rejects.toThrow("formatted: Daemon subprocess failed to spawn: ENOENT");
    expect(readinessSignal?.aborted).toBe(true);
    expect(spawner.process.listenerCount("error")).toBe(0);
    expect(spawner.process.listenerCount("exit")).toBe(0);
  });
});
