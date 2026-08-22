import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  DaemonLauncher,
  type DaemonProcessSpawner,
} from "../../src/daemon/DaemonLauncher";
import { DAEMON_SHUTDOWN_TIMEOUT_MS } from "../../src/daemon/constants";
import { FakeTimer } from "../fakes/FakeTimer";

class FakeDaemonProcess extends EventEmitter {
  pid = 12345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly signals: NodeJS.Signals[] = [];
  exitOnSignal: NodeJS.Signals | undefined;
  emitExitImmediately = true;

  unref(): void {}

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.signals.push(signal);
    if (this.exitOnSignal === signal && this.emitExitImmediately) {
      this.emitExit(signal);
    }
    return true;
  }

  emitExit(signal: NodeJS.Signals): void {
    this.exitCode = 0;
    this.signalCode = signal;
    this.emit("exit", 0, signal);
  }
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

  test("terminates and observes a child that remains alive after readiness times out", async () => {
    const spawner = new FakeDaemonSpawner();
    spawner.process.exitOnSignal = "SIGTERM";
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const launcher = new DaemonLauncher({
      spawn: spawner.spawn.bind(spawner),
      timer,
    });
    const finalChecks: Array<number | undefined> = [];

    await expect(launcher.launchAndWait({
      command: "auto-mobile",
      args: ["--daemon-mode"],
      spawnOptions: {},
      timeoutMs: 100,
      waitForReady: async () => false,
      isReadyForLaunchedProcess: async pid => {
        finalChecks.push(pid);
        return false;
      },
      formatFailure: async summary => new Error(`formatted: ${summary}`),
    })).rejects.toThrow("formatted: Daemon failed to start within 100ms");

    expect(finalChecks).toEqual([12345]);
    expect(spawner.process.signals).toEqual(["SIGTERM"]);
    expect(spawner.process.exitCode).toBe(0);
  });

  test("does not release startup ownership until the timed-out child exits", async () => {
    const spawner = new FakeDaemonSpawner();
    spawner.process.exitOnSignal = "SIGTERM";
    spawner.process.emitExitImmediately = false;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const launcher = new DaemonLauncher({
      spawn: spawner.spawn.bind(spawner),
      timer,
    });
    let settled = false;
    const launch = launcher.launchAndWait({
      command: "auto-mobile",
      args: ["--daemon-mode"],
      spawnOptions: {},
      timeoutMs: 100,
      waitForReady: async () => false,
      formatFailure: async summary => new Error(summary),
    }).finally(() => {
      settled = true;
    });

    await new Promise<void>(resolve => setImmediate(resolve));
    expect(spawner.process.signals).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);

    spawner.process.emitExit("SIGTERM");
    await expect(launch).rejects.toThrow("Daemon failed to start within 100ms");
    expect(settled).toBe(true);
  });

  test("escalates to SIGKILL when the timed-out child ignores SIGTERM", async () => {
    const spawner = new FakeDaemonSpawner();
    spawner.process.exitOnSignal = "SIGKILL";
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const launcher = new DaemonLauncher({
      spawn: spawner.spawn.bind(spawner),
      timer,
    });

    await expect(launcher.launchAndWait({
      command: "auto-mobile",
      args: ["--daemon-mode"],
      spawnOptions: {},
      timeoutMs: 100,
      waitForReady: async () => false,
      formatFailure: async summary => new Error(summary),
    })).rejects.toThrow("Daemon failed to start within 100ms");

    expect(spawner.process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(spawner.process.exitCode).toBe(0);
  });

  test("bounds a stalled final readiness check before terminating the child", async () => {
    const spawner = new FakeDaemonSpawner();
    spawner.process.exitOnSignal = "SIGTERM";
    const timer = new FakeTimer();
    const launcher = new DaemonLauncher({
      spawn: spawner.spawn.bind(spawner),
      timer,
    });

    let finalTimeoutMs: number | undefined;
    let finalReadinessSignal: AbortSignal | undefined;
    const launch = launcher.launchAndWait({
      command: "auto-mobile",
      args: ["--daemon-mode"],
      spawnOptions: {},
      timeoutMs: 100,
      waitForReady: async () => false,
      isReadyForLaunchedProcess: async (_pid, timeoutMs, signal) => {
        finalTimeoutMs = timeoutMs;
        finalReadinessSignal = signal;
        return new Promise<boolean>(() => {});
      },
      formatFailure: async summary => new Error(summary),
    });

    await new Promise<void>(resolve => setImmediate(resolve));
    expect(spawner.process.signals).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(1);

    timer.advanceTime(DAEMON_SHUTDOWN_TIMEOUT_MS);
    await expect(launch).rejects.toThrow("Daemon failed to start within 100ms");

    expect(spawner.process.signals).toEqual(["SIGTERM"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(finalTimeoutMs).toBe(DAEMON_SHUTDOWN_TIMEOUT_MS);
    expect(finalReadinessSignal?.aborted).toBe(true);
  });

  test("escalates the detached POSIX process group to reap a package-runner child", async () => {
    const spawner = new FakeDaemonSpawner();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processGroupSignals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const launcher = new DaemonLauncher({
      spawn: spawner.spawn.bind(spawner),
      timer,
      platform: "linux",
      processGroupKiller: (pid, signal) => {
        processGroupSignals.push({ pid, signal });
        if (signal === "SIGKILL") {
          spawner.process.emitExit(signal);
        }
      },
    });

    await expect(launcher.launchAndWait({
      command: "bunx",
      args: ["-y", "@kaeawc/auto-mobile@1.2.3", "--daemon-mode"],
      spawnOptions: { detached: true },
      timeoutMs: 100,
      waitForReady: async () => false,
      formatFailure: async summary => new Error(summary),
    })).rejects.toThrow("Daemon failed to start within 100ms");

    expect(processGroupSignals).toEqual([
      { pid: 12345, signal: "SIGTERM" },
      { pid: 12345, signal: 0 },
      { pid: 12345, signal: "SIGKILL" },
    ]);
    expect(spawner.process.signals).toEqual([]);
  });

  test("keeps detached process-group escalation armed after its wrapper exits", async () => {
    const spawner = new FakeDaemonSpawner();
    const timer = new FakeTimer();
    const processGroupSignals: Array<NodeJS.Signals | 0> = [];
    let daemonStillAlive = true;
    const launcher = new DaemonLauncher({
      spawn: spawner.spawn.bind(spawner),
      timer,
      platform: "linux",
      processGroupKiller: (_pid, signal) => {
        processGroupSignals.push(signal);
        if (signal === 0 && !daemonStillAlive) {
          throw new Error("ESRCH");
        }
        if (signal === "SIGTERM") {
          // The package runner exits, but its daemon descendant ignores TERM.
          spawner.process.emitExit(signal);
        }
        if (signal === "SIGKILL") {
          daemonStillAlive = false;
        }
      },
    });
    let settled = false;
    const launch = launcher.launchAndWait({
      command: "bunx",
      args: ["-y", "@kaeawc/auto-mobile@1.2.3", "--daemon-mode"],
      spawnOptions: { detached: true },
      timeoutMs: 100,
      waitForReady: async () => false,
      formatFailure: async summary => new Error(summary),
    }).finally(() => {
      settled = true;
    });

    await new Promise<void>(resolve => setImmediate(resolve));
    expect(processGroupSignals).toEqual(["SIGTERM", 0]);
    expect(settled).toBe(false);

    timer.advanceTime(DAEMON_SHUTDOWN_TIMEOUT_MS);
    await expect(launch).rejects.toThrow("Daemon failed to start within 100ms");

    expect(processGroupSignals).toEqual(["SIGTERM", 0, 0, "SIGKILL"]);
    expect(spawner.process.signals).toEqual([]);
  });

  test("escalates the direct child when detached process-group signaling falls back", async () => {
    const spawner = new FakeDaemonSpawner();
    spawner.process.exitOnSignal = "SIGKILL";
    const timer = new FakeTimer();
    const processGroupSignals: Array<NodeJS.Signals | 0> = [];
    const launcher = new DaemonLauncher({
      spawn: spawner.spawn.bind(spawner),
      timer,
      platform: "linux",
      processGroupKiller: (_pid, signal) => {
        processGroupSignals.push(signal);
        throw new Error("ESRCH");
      },
    });

    const launch = launcher.launchAndWait({
      command: "bunx",
      args: ["-y", "@kaeawc/auto-mobile@1.2.3", "--daemon-mode"],
      spawnOptions: { detached: true },
      timeoutMs: 100,
      waitForReady: async () => false,
      formatFailure: async summary => new Error(summary),
    });

    await new Promise<void>(resolve => setImmediate(resolve));
    expect(spawner.process.signals).toEqual(["SIGTERM"]);

    timer.advanceTime(DAEMON_SHUTDOWN_TIMEOUT_MS);
    await expect(launch).rejects.toThrow("Daemon failed to start within 100ms");

    expect(processGroupSignals).toEqual(["SIGTERM", 0]);
    expect(spawner.process.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("keeps a launched child that becomes ready at the readiness deadline", async () => {
    const spawner = new FakeDaemonSpawner();
    const launcher = new DaemonLauncher({ spawn: spawner.spawn.bind(spawner) });
    const finalChecks: Array<number | undefined> = [];

    await launcher.launchAndWait({
      command: "auto-mobile",
      args: ["--daemon-mode"],
      spawnOptions: {},
      timeoutMs: 100,
      waitForReady: async () => false,
      isReadyForLaunchedProcess: async pid => {
        finalChecks.push(pid);
        return true;
      },
      formatFailure: async summary => new Error(summary),
    });

    expect(finalChecks).toEqual([12345]);
    expect(spawner.process.signals).toEqual([]);
  });

  test("keeps child error observation while the final readiness check is pending", async () => {
    const spawner = new FakeDaemonSpawner();
    const launcher = new DaemonLauncher({ spawn: spawner.spawn.bind(spawner) });

    await expect(launcher.launchAndWait({
      command: "auto-mobile",
      args: ["--daemon-mode"],
      spawnOptions: {},
      timeoutMs: 100,
      waitForReady: async () => false,
      isReadyForLaunchedProcess: async () => {
        await Promise.resolve();
        spawner.process.emit("error", new Error("late child error"));
        return false;
      },
      formatFailure: async summary => new Error(`formatted: ${summary}`),
    })).rejects.toThrow("formatted: Daemon subprocess failed to spawn: late child error");

    expect(spawner.process.signals).toEqual([]);
    expect(spawner.process.listenerCount("error")).toBe(0);
    expect(spawner.process.listenerCount("exit")).toBe(0);
  });
});
