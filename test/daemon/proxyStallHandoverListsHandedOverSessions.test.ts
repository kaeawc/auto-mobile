import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy, DaemonSessionStalledError } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import type { LivenessHandover } from "../../src/daemon/proxyLivenessRecovery";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/daemon/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent, settleByFakeEvents } from "../helpers/fakeTimerStepping";

// Stdio proxy session bookkeeping (#12047): one connection holds an Android and an iOS session and both
// are handed over in ONE `daemon_stalled` handover. The harness does what the handover says and
// resumes the Android session by naming it. The iOS binding is still handed over, and the answer
// about it must name the sessions that are still unreachable. It repeats the original handover
// instead, so it also lists the Android session the proxy has just resumed and is heartbeating
// again as one that "could not be reached" and has to be resumed by UUID after a daemon restart.

const LEASE_MS = 10_000;
const INTERVAL_MS = 2_000;
const ANDROID = { sessionUuid: "android-session", deviceId: "emulator-5554", platform: "android" };
const IOS = { sessionUuid: "ios-session", deviceId: "sim-1", platform: "ios" };

class LivenessTimer extends FakeTimer {
  override advanceTimeAsync(ms: number): Promise<void> {
    return super.advanceTimeAsync(ms, () => drainUntilQuiescent(this));
  }
}

function deviceStartResult(session: typeof ANDROID) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          platform: session.platform,
          runtime: { deviceId: session.deviceId, session: { sessionUuid: session.sessionUuid } },
        }),
      },
    ],
  };
}

describe("a daemon_stalled answer names only the sessions still handed over", () => {
  let timer: LivenessTimer;
  let proxy: DaemonMcpProxy;
  let clients: FakeDaemonClient[];
  let handovers: LivenessHandover[];
  /** Sessions whose heartbeats the daemon does not answer. */
  let silentSessions: Set<string>;
  let heartbeats: Array<{ sessionId: string; at: number }>;
  let spies: Array<ReturnType<typeof spyOn>>;

  beforeEach(() => {
    timer = new LivenessTimer();
    clients = [];
    handovers = [];
    heartbeats = [];
    silentSessions = new Set();
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    spies = [
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    proxy = new DaemonMcpProxy({
      clientFactory: () => {
        const client = new FakeDaemonClient({
          toolResultFor: (name) =>
            name === "getAndroid"
              ? deviceStartResult(ANDROID)
              : name === "getApple"
                ? deviceStartResult(IOS)
                : { content: [{ type: "text", text: "ok" }] },
          onCallDaemonMethod: (method, params) => {
            if (method !== "daemon/heartbeat") {
              return undefined;
            }
            heartbeats.push({ sessionId: params.sessionId, at: timer.now() });
            // No daemon instance in the ack: nothing is probed, the harness resumes by name.
            return silentSessions.has(params.sessionId) ? new Promise<never>(() => {}) : undefined;
          },
        });
        clients.push(client);
        return client;
      },
      daemonManager,
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(["proxy-token"]),
      heartbeatTimeoutMs: LEASE_MS,
      heartbeatIntervalMs: INTERVAL_MS,
    });
    proxy.onLivenessHandover((handover) => handovers.push(handover));
  });

  afterEach(async () => {
    await proxy.close();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  async function settle<T>(pending: Promise<T>): Promise<T> {
    let done = false;
    const tracked = pending.finally(() => {
      done = true;
    });
    tracked.catch(() => {});
    for (let elapsed = 0; elapsed < 20_000 && !done; elapsed += 250) {
      await timer.advanceTimeAsync(250);
    }
    return tracked;
  }

  test("after one of two handed-over sessions is resumed, the other's answer no longer lists it", async () => {
    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getApple", {});
    await timer.advanceTimeAsync(INTERVAL_MS);

    silentSessions = new Set([ANDROID.sessionUuid, IOS.sessionUuid]);
    for (let elapsed = 0; elapsed < 60_000 && handovers.length === 0; elapsed += 250) {
      await timer.advanceTimeAsync(250);
    }
    expect(handovers).toHaveLength(1);
    expect(handovers[0]!.code).toBe("daemon_stalled");
    expect(handovers[0]!.sessions.map((session) => session.sessionUuid).sort()).toEqual([
      ANDROID.sessionUuid,
      IOS.sessionUuid,
    ]);

    // The daemon answers for Android again; the harness resumes it by naming it, as told.
    silentSessions = new Set([IOS.sessionUuid]);
    const resumed = await settle(proxy.callTool("observe", { sessionUuid: ANDROID.sessionUuid }));
    expect((resumed as { isError?: boolean }).isError).toBeFalsy();
    // Android is held and heartbeated again.
    heartbeats = [];
    await timer.advanceTimeAsync(INTERVAL_MS * 2);
    expect(heartbeats.some((beat) => beat.sessionId === ANDROID.sessionUuid)).toBe(true);

    // A sessionless call reaches the iOS binding, which is still handed over.
    const answer = await settle(proxy.callTool("tapOn", { text: "OK" })).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(answer).toBeInstanceOf(DaemonSessionStalledError);
    const payload = (answer as DaemonSessionStalledError).toPayload();
    expect(payload.error.code).toBe("daemon_stalled");
    expect(payload.error.sessions.map((session) => session.sessionUuid)).toEqual([IOS.sessionUuid]);
    expect(payload.error.message).not.toContain(ANDROID.sessionUuid);
  });

  test("after one of two handed-over sessions is reported lost, the other's answer no longer lists it", async () => {
    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getApple", {});
    await timer.advanceTimeAsync(INTERVAL_MS);

    silentSessions = new Set([ANDROID.sessionUuid, IOS.sessionUuid]);
    for (let elapsed = 0; elapsed < 60_000 && handovers.length === 0; elapsed += 250) {
      await timer.advanceTimeAsync(250);
    }
    expect(handovers).toHaveLength(1);
    expect(handovers[0]!.code).toBe("daemon_stalled");
    expect(handovers[0]!.sessions.map((session) => session.sessionUuid).sort()).toEqual([
      ANDROID.sessionUuid,
      IOS.sessionUuid,
    ]);

    // A definitive daemon release ends Android's handover and reports its loss separately.
    clients
      .at(-1)!
      .emitNotification(
        SESSION_RELEASED_NOTIFICATION_METHOD,
        ANDROID.sessionUuid,
        "cleanup-expired",
      );
    expect(handovers[1]?.code).toBe("proxy_stalled");
    expect(handovers[1]?.sessions.map((session) => session.sessionUuid)).toEqual([
      ANDROID.sessionUuid,
    ]);
    await expect(
      settle(proxy.callTool("observe", { sessionUuid: ANDROID.sessionUuid })),
    ).rejects.toMatchObject({
      sessionUuid: ANDROID.sessionUuid,
      handover: { code: "proxy_stalled" },
    });

    // The latest binding remains the handed-over iOS session.
    const answer = await settle(proxy.callTool("tapOn", { text: "OK" })).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(answer).toBeInstanceOf(DaemonSessionStalledError);
    const payload = (answer as DaemonSessionStalledError).toPayload();
    expect(payload.error.code).toBe("daemon_stalled");
    expect(payload.error.sessions.map((session) => session.sessionUuid)).toEqual([IOS.sessionUuid]);
    expect(payload.error.message).not.toContain(ANDROID.sessionUuid);
    // Listeners retain the complete original handover, plus the separate single-session loss.
    expect(handovers[0]!.sessions).toHaveLength(2);
    expect(payload.error.lastAcknowledgedHeartbeatAt).toBe(
      handovers[0]!.sessions.find((session) => session.sessionUuid === IOS.sessionUuid)!
        .lastAcknowledgedHeartbeatAt,
    );
  });

  test.each([
    { name: "single-session", includeIos: false },
    { name: "two-session", includeIos: true },
  ])(
    "$name release during a pending resume still names the answered session",
    async ({ includeIos }) => {
      await proxy.callTool("getAndroid", {});
      if (includeIos) {
        await proxy.callTool("getApple", {});
      }
      await timer.advanceTimeAsync(INTERVAL_MS);

      const handedOver = new Promise<LivenessHandover>((resolve) => {
        proxy.onLivenessHandover(resolve);
      });
      silentSessions = new Set([ANDROID.sessionUuid, IOS.sessionUuid]);
      await settleByFakeEvents(timer, handedOver, { description: "daemon-stalled handover" });
      expect(handovers).toHaveLength(1);
      expect(handovers[0]!.code).toBe("daemon_stalled");
      const expectedSessions = includeIos
        ? [ANDROID.sessionUuid, IOS.sessionUuid]
        : [ANDROID.sessionUuid];
      expect(handovers[0]!.sessions.map((session) => session.sessionUuid).sort()).toEqual(
        expectedSessions,
      );

      heartbeats = [];
      const pending = proxy.callTool("observe", { sessionUuid: ANDROID.sessionUuid }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await drainUntilQuiescent(timer);
      // The silent daemon has received the resume heartbeat, but its deadline has not elapsed.
      expect(heartbeats.map((beat) => beat.sessionId)).toEqual([ANDROID.sessionUuid]);
      clients
        .at(-1)!
        .emitNotification(
          SESSION_RELEASED_NOTIFICATION_METHOD,
          ANDROID.sessionUuid,
          "cleanup-expired",
        );
      expect(handovers[1]?.code).toBe("proxy_stalled");

      const answer = await settleByFakeEvents(timer, pending, {
        description: "released session's pending resume",
      });
      expect(answer).toBeInstanceOf(DaemonSessionStalledError);
      const payload = (answer as DaemonSessionStalledError).toPayload();
      expect(payload.error.code).toBe("daemon_stalled");
      expect(payload.error.sessions.map((session) => session.sessionUuid).sort()).toEqual(
        expectedSessions,
      );
      expect(payload.error.message).toContain(ANDROID.sessionUuid);
      expect(typeof payload.error.lastAcknowledgedHeartbeatAt).toBe("number");
      expect(Number.isFinite(payload.error.lastAcknowledgedHeartbeatAt)).toBe(true);
      expect(payload.error.lastAcknowledgedHeartbeatAt).toBe(
        Math.max(...payload.error.sessions.map((session) => session.lastAcknowledgedHeartbeatAt)),
      );
      // Narrowing the answer preserves the listener snapshot and the separate pending loss.
      expect(handovers[0]!.sessions.map((session) => session.sessionUuid).sort()).toEqual(
        expectedSessions,
      );
      await expect(
        settleByFakeEvents(timer, proxy.callTool("observe", { sessionUuid: ANDROID.sessionUuid }), {
          description: "separate pending session loss",
        }),
      ).rejects.toMatchObject({
        sessionUuid: ANDROID.sessionUuid,
        handover: { code: "proxy_stalled" },
      });
    },
  );
});
