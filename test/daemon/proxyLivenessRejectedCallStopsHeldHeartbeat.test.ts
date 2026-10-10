import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

// Hunt 2026-10-10 (proxy liveness). After the latest binding is released the proxy keeps
// heartbeating the other sessions it holds (#9335), and a call naming one of them is routed to it
// (#10692). When such a call is admitted and then REJECTED by the daemon (a thrown tool error, not
// an `isError` result), refreshReplayLeaseAfterAdmittedFailure moves the surviving session out of
// the held set into the latest binding while the terminal fence of the released session stays in
// place. A fenced latest binding is not heartbeated, so the keeper silently stops heartbeating a
// live session the proxy still holds; the daemon releases it ~10 s later.

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

describe("a rejected call on a surviving held session must not stop its heartbeats", () => {
  let timer: FakeTimer;
  let client: FakeDaemonClient;
  let mintedBy: Record<string, string>;
  let rejectTapOn: boolean;
  let proxy: DaemonMcpProxy;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  function heartbeatsFor(sessionUuid: string): number {
    return client.callDaemonMethodCalls.filter(
      (call) => call.method === "daemon/heartbeat" && call.params.sessionId === sessionUuid,
    ).length;
  }

  async function heartbeatsOverThreeTicks(sessionUuid: string): Promise<number> {
    // Let a heartbeat the previous call dispatched settle, so it does not coalesce with a tick.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const before = heartbeatsFor(sessionUuid);
    await timer.advanceTimeAsync(3 * INTERVAL_MS);
    return heartbeatsFor(sessionUuid) - before;
  }

  /** Android acquired first, iOS second (the latest binding), then iOS is released. */
  async function holdAndroidAfterIosRelease(): Promise<void> {
    mintedBy.getAndroid = ANDROID;
    await proxy.callTool("getAndroid", {});
    mintedBy.getApple = IOS;
    await proxy.callTool("getApple", {});
    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, IOS, "device-killed");
  }

  beforeEach(() => {
    timer = new FakeTimer();
    mintedBy = {};
    rejectTapOn = false;
    client = new FakeDaemonClient({
      toolResultFor: (name) => (mintedBy[name] ? deviceStartResult(mintedBy[name]) : undefined),
      onCallTool: (name) => {
        if (name === "tapOn" && rejectTapOn) {
          // The daemon admitted the call on the live session and its handler rejected it.
          throw new Error("Element not found: text 'Continue'");
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

  test("control: a successful call on the surviving session keeps it heartbeated", async () => {
    await holdAndroidAfterIosRelease();
    expect(await heartbeatsOverThreeTicks(ANDROID)).toBe(3);

    await proxy.callTool("tapOn", { sessionUuid: ANDROID, text: "Continue" });

    expect(await heartbeatsOverThreeTicks(ANDROID)).toBe(3);
  });

  test("a call the daemon admits and then rejects keeps the surviving session heartbeated", async () => {
    await holdAndroidAfterIosRelease();
    expect(await heartbeatsOverThreeTicks(ANDROID)).toBe(3);

    rejectTapOn = true;
    await expect(
      proxy.callTool("tapOn", { sessionUuid: ANDROID, text: "Continue" }),
    ).rejects.toThrow("Element not found");

    // Nothing released the android session: the proxy still holds it and must keep its lease.
    expect(await heartbeatsOverThreeTicks(ANDROID)).toBe(3);
  });
});
