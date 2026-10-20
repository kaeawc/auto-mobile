import { describe, expect, test } from "bun:test";
import {
  DaemonReadiness,
  type DaemonReadinessHost,
} from "../../../src/daemon/manager/DaemonReadiness";
import type { DaemonClientLike } from "../../../src/daemon/client";
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
    peerSocketReachability: { isReachable: async () => true },
    findNamespaceDaemonProcessRecords: async () => [],
    createClient: (options) => {
      expect(options?.clientIdentity).toBeNull();
      return client;
    },
    lifecycleStatus: async () => status,
  };
  return {
    readiness: new DaemonReadiness(host),
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
    const pending = readiness.waitForReady(
      1000,
      new AbortController().signal,
      undefined,
      undefined,
      { pid: 200 },
    );
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
