import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuxiliarySocketHeldError } from "../../../src/daemon/AuxiliarySocketHeldError";
import { DaemonLaunch, type DaemonLaunchHost } from "../../../src/daemon/manager/DaemonLaunch";
import { DaemonLauncher, type DaemonLaunchRequest } from "../../../src/daemon/DaemonLauncher";
import { FakeDaemonProcess } from "../../fakes/FakeDaemonProcess";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { DAEMON_LAUNCH_NONCE_ENV } from "../../../src/daemon/wire/constants";
import { describe, expect, test } from "bun:test";
import {
  DaemonReadiness,
  type DaemonReadinessHost,
} from "../../../src/daemon/manager/DaemonReadiness";
import type { DaemonClientLike } from "../../../src/daemon/client/client";
import type { DaemonStatus } from "../../../src/daemon/types";
import { FakeTimer } from "../../fakes/FakeTimer";

class IdentityClient implements DaemonClientLike {
  closed = 0;
  signal?: AbortSignal;
  response: unknown = {
    pid: 200,
    startedAt: 20,
    processGenerationToken: "linux:new",
    version: "test",
  };
  async connect() {}
  async close() {
    this.closed++;
  }
  async callTool(): Promise<unknown> {
    throw new Error("unused");
  }
  async readResource(): Promise<unknown> {
    throw new Error("unused");
  }
  async callDaemonMethod(
    method: string,
    _params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    expect(method).toBe("ide/status");
    this.signal = options?.signal;
    return this.response;
  }
}

function harness() {
  const timer = new FakeTimer();
  const client = new IdentityClient();
  let status: DaemonStatus = {
    running: true,
    pid: 200,
    startedAt: 20,
    processGenerationToken: "linux:new",
  };
  const host: DaemonReadinessHost = {
    timer,
    socketPath: "fake.sock",
    pidFilePath: "fake.pid",
    platform: "linux",
    socketPathObservable: () => true,
    remainingTime: (deadline) => Math.max(0, deadline - timer.now()),
    sleepUnlessAborted: (ms) => timer.sleep(ms),
    verifyDaemonConnection: async () => true,
    isIsolatedSocketNamespace: () => true,
    peerSocketReachability: { probe: async () => "answered" },
    findNamespaceDaemonProcessRecords: async () => [],
    createClient: (options) => {
      expect(options?.clientIdentity).toBeNull();
      return client;
    },
    lifecycleStatus: async () => status,
  };
  return {
    readiness: new DaemonReadiness(host),
    host,
    client,
    timer,
    setStatus: (value: DaemonStatus) => {
      status = value;
    },
  };
}

describe("launched daemon identity readiness", () => {
  test.each([
    { pid: 100, startedAt: 10, processGenerationToken: "linux:old" },
    { pid: 200, startedAt: 20, processGenerationToken: "linux:old" },
    { pid: 200, startedAt: 10, processGenerationToken: "linux:new" },
    { pid: 200, startedAt: 20 },
  ])("rejects an answering predecessor or wrong generation: %j", async (identity) => {
    const { readiness, client } = harness();
    client.response = { ...identity, version: "test" };
    expect(await readiness.isLaunchedProcessReady(200, 1000, new AbortController().signal)).toBe(
      false,
    );
    expect(client.closed).toBe(1);
  });

  test("accepts the matching child identity", async () => {
    const { readiness, client, timer } = harness();
    expect(await readiness.isLaunchedProcessReady(200, 1000, new AbortController().signal)).toBe(
      true,
    );
    expect(client.closed).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a connected responder that never answers exhausts only the readiness budget", async () => {
    const { readiness, client, timer } = harness();
    client.response = new Promise<never>(() => {});
    const pending = readiness.isLaunchedProcessReady(200, 100, new AbortController().signal);
    for (let turn = 0; turn < 20; turn++) {
      await Promise.resolve();
    }
    timer.advanceTime(100);
    expect(await pending).toBe(false);
    expect(client.signal?.aborted).toBe(true);
    expect(client.closed).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("keeps polling past the predecessor until the child answers", async () => {
    const { readiness, client, timer } = harness();
    client.response = { pid: 100, startedAt: 10, version: "old" };
    const pending = readiness.waitForReady(1000, {
      signal: new AbortController().signal,
      launchedProcess: { pid: 200 },
    });
    for (let turn = 0; turn < 30; turn++) {
      await Promise.resolve();
    }
    expect(client.closed).toBe(1);
    client.response = {
      pid: 200,
      startedAt: 20,
      processGenerationToken: "linux:new",
      version: "test",
    };
    timer.advanceTime(100);
    expect(await pending).toBe(true);
    expect(client.closed).toBe(2);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("uses the startup timestamp when the platform has no OS generation token", async () => {
    const { readiness, client, setStatus } = harness();
    setStatus({ running: true, pid: 200, startedAt: 20 });
    client.response = { pid: 200, startedAt: 20, version: "test" };
    expect(await readiness.isLaunchedProcessReady(200, 1000, new AbortController().signal)).toBe(
      true,
    );
  });
});

function launchHost(launcher: DaemonLauncher, h: ReturnType<typeof harness>): DaemonLaunchHost {
  const ids = new FakeIdGenerator(["launch-uuid"]);
  return {
    ...h.host,
    launcher,
    fallbackLauncher: launcher,
    seams: {
      nextLaunchNonce: () => ids.next(),
      currentBuildId: () => "test",
      portFreeProbe: async () => true,
      exitRecordFileSystem: {
        readFileSync: () => "",
        writeFileSync: () => {},
        rmSync: () => {},
      },
      launchLogFileSystem: { openSync: () => 1, closeSync: () => {} },
      launchWorkingDirectory: () => "/fake",
    },
    throwIfRecoveryCancelled: () => {},
    waitForReady: (...args) => h.readiness.waitForReady(...args),
    isLaunchedProcessReady: (...args) => h.readiness.isLaunchedProcessReady(...args),
    createDaemonExitFailure: async () => new Error("unused"),
    withDaemonOptions: (command) => command,
    extractionCleaner: { removeExtractionForEntryScript: async () => false },
    describeError: String,
    lockFilePath: "fake.lock",
    launchCommandResolver: undefined,
    getLockHolderStartupLogPath: async () => null,
  };
}

describe("package-runner launch identity", () => {
  test("client launch failure includes the holder line from the captured startup log", async () => {
    const h = harness();
    const launcher = new DaemonLauncher({
      timer: h.timer,
      environment: {},
      entryScript: "/fake/index.ts",
    });
    const refusal = new AuxiliarySocketHeldError("/fake/appearance.sock", "appearance", {
      holderPid: 741,
      holderVersion: "0.0.old",
      holderVerified: true,
    });
    const directory = mkdtempSync(join(tmpdir(), "aux-launch-log-"));
    const logPath = join(directory, "launch.log");
    try {
      writeFileSync(logPath, `${refusal.message}\n`);
      const launch = new DaemonLaunch(launchHost(launcher, h));
      const failure = await launch.createDaemonExitFailure(1, null, logPath);
      expect(failure.message).toContain("exit code 1");
      expect(failure.message).toContain(refusal.message);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([false, true])(
    "onSpawn hands PID 300 to readiness (package runner: %s)",
    async (packageRunner) => {
      const h = harness();
      const signal = new AbortController().signal;
      let accepted: boolean | undefined;
      let finalProbe: boolean | undefined;
      let childNonce: string | undefined;
      class CapturingLauncher extends DaemonLauncher {
        override async launchAndWait(request: DaemonLaunchRequest): Promise<void> {
          const child = new FakeDaemonProcess();
          child.pid = 300;
          request.onSpawn?.(child);
          childNonce = request.spawnOptions.env?.[DAEMON_LAUNCH_NONCE_ENV];
          const identity = {
            pid: packageRunner ? 400 : 300,
            startedAt: 20,
            processGenerationToken: "linux:new",
            launchNonce: childNonce,
          };
          h.setStatus({ running: true, ...identity });
          h.client.response = { version: "test", ...identity };
          // Repro: the observation-only wait accepts the daemon at PID 400.
          expect(await h.readiness.waitForReady(1000)).toBe(true);
          const pending = request.waitForReady(1000, signal);
          for (let turn = 0; turn < 40; turn++) {
            await Promise.resolve();
          }
          // Bounds the regression where onSpawn's PID is no longer handed off.
          h.timer.advanceTime(1000);
          accepted = await pending;
          finalProbe = await request.isReadyForLaunchedProcess?.(300, 1000, signal);
        }
      }
      const launcher = new CapturingLauncher({
        timer: h.timer,
        entryScript: packageRunner ? null : "/fake/index.ts",
        processExecPath: "/fake/bun",
        environment: {},
        version: "1.2.3",
        executableExists: () => false,
      });
      const host = launchHost(launcher, h);
      const launch = new DaemonLaunch(host);
      await launch.launchWithExtractionRetry(
        {
          options: {},
          childEnv: { [DAEMON_LAUNCH_NONCE_ENV]: "inherited-stale-nonce" },
          logSink: "file",
          capturesLaunchOutput: true,
          logFd: 1,
          logPath: "/fake/launch.log",
        },
        launch.withDaemonOptions(launcher.resolveCommand(), {}),
        1000,
        undefined,
      );
      expect(accepted).toBe(true);
      expect(finalProbe).toBe(true);
      expect(childNonce).toBe(packageRunner ? "launch-uuid" : undefined);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test.each([
    { pid: 400, startedAt: 20, processGenerationToken: "linux:new", launchNonce: "other" },
    { pid: 400, startedAt: 20, processGenerationToken: "linux:old", launchNonce: "launch" },
    { pid: 400, startedAt: 10, processGenerationToken: "linux:new", launchNonce: "launch" },
    { pid: 500, startedAt: 20, processGenerationToken: "linux:new", launchNonce: "launch" },
  ])("rejects a wrapper responder with mismatched identity: %j", async (responder) => {
    const h = harness();
    h.setStatus({
      running: true,
      pid: 400,
      startedAt: 20,
      processGenerationToken: "linux:new",
      launchNonce: "launch",
    });
    h.client.response = { version: "test", ...responder };
    expect(
      await h.readiness.isLaunchedProcessReady(300, 1000, new AbortController().signal, "launch"),
    ).toBe(false);
  });

  test("an unrelated PID record cannot borrow the launch nonce from the responder", async () => {
    const h = harness();
    h.setStatus({ running: true, pid: 400, startedAt: 20, launchNonce: "other" });
    expect(
      await h.readiness.isLaunchedProcessReady(300, 1000, new AbortController().signal, "launch"),
    ).toBe(false);
    expect(h.client.closed).toBe(0);
  });

  test("direct launches reject PID 400 when the spawned child was PID 300", async () => {
    const h = harness();
    h.setStatus({ running: true, pid: 400, startedAt: 20, processGenerationToken: "linux:new" });
    expect(await h.readiness.isLaunchedProcessReady(300, 1000, new AbortController().signal)).toBe(
      false,
    );
  });
});
