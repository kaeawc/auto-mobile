import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import { DaemonMcpProxy } from "../../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../../src/daemon/client";
import { DAEMON_VERSION } from "../../../src/daemon/constants";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../../src/daemon/types";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../../src/server/sessionReleaseBroadcast";
import { FakeDaemonManager } from "../../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";

// Hunt 2026-10-10 (proxy liveness). A proxy heartbeats every session it holds (#9335). Binding a
// result-minted session stops the keeper first and restarts it only once the new binding's first
// heartbeat is acknowledged. When that first heartbeat proves the NEW session gone (not-found, or a
// release notification landing during the round trip) the keeper is never restarted, although the
// previous binding was just moved into the held set: a healthy proxy stops heartbeating a live
// session and the daemon releases it ~10 s later.

const INTERVAL_MS = 1_000;
const TIMEOUT_MS = 4_000;
const ANDROID = "android-session";
const IOS = "ios-session";

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

function deviceStartResult(sessionUuid: string): {
  content: Array<{ type: string; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify({ runtime: { session: { sessionUuid } } }) }],
  };
}

describe("hunt: a held session keeps its heartbeats when the next binding dies at birth", () => {
  let timer: FakeTimer;
  let client: FakeDaemonClient;
  let mintedBy: Record<string, string>;
  let onIosClaim: (() => void) | undefined;
  let proxy: DaemonMcpProxy;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  function heartbeatsFor(sessionUuid: string): number {
    return client.callDaemonMethodCalls.filter(
      (call) => call.method === "daemon/heartbeat" && call.params.sessionId === sessionUuid,
    ).length;
  }

  async function acquire(tool: "getAndroid" | "getApple", sessionUuid: string): Promise<unknown> {
    mintedBy[tool] = sessionUuid;
    return proxy.callTool(tool, {});
  }

  beforeEach(() => {
    timer = new FakeTimer();
    mintedBy = {};
    onIosClaim = undefined;
    client = new FakeDaemonClient({
      toolResultFor: (name) => (mintedBy[name] ? deviceStartResult(mintedBy[name]) : undefined),
      onCallDaemonMethod: (method, params) => {
        if (method === "daemon/heartbeat" && params.sessionId === IOS) {
          onIosClaim?.();
        }
      },
    });
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
      heartbeatTimeoutMs: TIMEOUT_MS,
      heartbeatIntervalMs: INTERVAL_MS,
    });
  });

  afterEach(async () => {
    await proxy.close();
    isAvailableSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("control: the held session is heartbeated after a healthy second acquisition", async () => {
    await acquire("getAndroid", ANDROID);
    await acquire("getApple", IOS);
    const before = heartbeatsFor(ANDROID);

    await timer.advanceTimeAsync(3 * INTERVAL_MS);

    expect(heartbeatsFor(ANDROID) - before).toBe(3);
  });

  test("the new session's first heartbeat answers not-found: the held session is still heartbeated", async () => {
    await acquire("getAndroid", ANDROID);
    await timer.advanceTimeAsync(INTERVAL_MS);
    expect(heartbeatsFor(ANDROID)).toBeGreaterThan(1);

    // The daemon reaped the new session before its first heartbeat arrived (the #5637 race lost).
    onIosClaim = () => {
      throw Object.assign(new Error(`Session not found: ${IOS}`), {
        code: DAEMON_SESSION_NOT_FOUND_CODE,
      });
    };
    await acquire("getApple", IOS).catch(() => undefined);
    onIosClaim = undefined;
    const before = heartbeatsFor(ANDROID);

    // Three keeper ticks: most of the android session's 4 s owner lease.
    await timer.advanceTimeAsync(3 * INTERVAL_MS);

    expect(heartbeatsFor(ANDROID) - before).toBe(3);
  });

  test("the new session is released during its first heartbeat: the held session is still heartbeated", async () => {
    await acquire("getAndroid", ANDROID);
    await timer.advanceTimeAsync(INTERVAL_MS);

    onIosClaim = () => {
      onIosClaim = undefined;
      client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, IOS, "device-killed");
    };
    await acquire("getApple", IOS).catch(() => undefined);
    const before = heartbeatsFor(ANDROID);

    await timer.advanceTimeAsync(3 * INTERVAL_MS);

    expect(heartbeatsFor(ANDROID) - before).toBe(3);
    // The keeper interval itself must still be scheduled for the session this proxy holds.
    expect(timer.getPendingIntervalCount()).toBeGreaterThan(0);
  });
});
