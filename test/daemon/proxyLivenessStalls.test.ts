import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy, DaemonSessionStalledError } from "../../src/daemon/daemonMcpProxy";
import {
  DaemonClient,
  DaemonRequestNotDeliveredError,
  DaemonUnavailableError,
} from "../../src/daemon/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DAEMON_RESTART_HANDOFF_TIMEOUT_MS, DAEMON_VERSION } from "../../src/daemon/constants";
import { getStaticToolDefinitions } from "../../src/daemon/staticToolDefinitions";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import {
  LIVENESS_RECOVERY_ATTEMPTS,
  LivenessRecovery,
  runWithoutDaemonLifecycle,
  livenessRecoveryCallWaitMs,
  recoveryAttemptSlotMs,
  type LivenessHandover,
} from "../../src/daemon/proxyLivenessRecovery";
import {
  DAEMON_SESSION_SUSPECT_CODE,
  DAEMON_SESSION_NOT_FOUND_CODE,
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
} from "../../src/daemon/types";
import { declaresDeviceSessionSuspect } from "../../src/server/deviceSessionResult";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { SessionSuspectError } from "../../src/daemon/sessionManager";
import { SessionRecoveryAssignmentError } from "../../src/models/SessionRecoveryAssignmentError";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import type { Timer } from "../../src/utils/SystemTimer";

// #10053: the proxy's two structured liveness states, against the daemon's real heartbeat
// handler and session manager, with a scripted-unresponsive daemon socket. Everything runs on a
// fake timer; nothing sleeps.

// The daemon transport and persistence are pure promises in this harness.
// Drain their work after each timer event without yielding to a loaded host.
class LivenessTimer extends FakeTimer {
  override advanceTimeAsync(ms: number): Promise<void> {
    return super.advanceTimeAsync(ms, () => drainUntilQuiescent(this));
  }
}

const LEASE_MS = 10_000;
const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 2, idle: 0, assigned: 2, error: 0 }),
};
const OBSERVED = { content: [{ type: "text", text: JSON.stringify({ observed: true }) }] };
const DEVICES: Record<string, string> = {
  "android-session": "emulator-5554",
  "ios-session": "sim-1",
};

/** A fake timer whose clock a test can push ahead without firing timers: a stalled event loop. */
class StallableTimer implements Timer {
  private skewMs = 0;
  constructor(private readonly base: FakeTimer) {}
  /** Everything reading this clock (proxy and daemon) now sees `ms` more elapsed time. */
  stall(ms: number): void {
    this.skewMs += ms;
  }
  now(): number {
    return this.base.now() + this.skewMs;
  }
  sleep(ms: number): Promise<void> {
    return this.base.sleep(ms);
  }
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    return this.base.setTimeout(callback, ms);
  }
  clearTimeout(handle: NodeJS.Timeout): void {
    this.base.clearTimeout(handle);
  }
  setInterval(callback: () => void, ms: number): NodeJS.Timeout {
    return this.base.setInterval(callback, ms);
  }
  clearInterval(handle: NodeJS.Timeout): void {
    this.base.clearInterval(handle);
  }
}

function daemonStateFor(sessionManager: SessionManager): DaemonStateAccess {
  return {
    isInitialized: () => true,
    getSessionManager: () => sessionManager,
    getDevicePool: () => DEVICE_POOL,
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
}

function deviceStartResult(sessionUuid: string, deviceId: string) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ runtime: { deviceId, session: { sessionUuid } } }),
      },
    ],
  };
}

describe("proxy liveness stalls (#10053)", () => {
  let baseTimer: FakeTimer;
  let timer: StallableTimer;
  let sessionManager: SessionManager;
  let daemonManager: FakeDaemonManager;
  /** Heartbeats the scripted daemon swallows before it answers again; Infinity = never. */
  let hangHeartbeats: number;
  /** The scripted daemon swallows every heartbeat before this proxy-clock time (a slow wake-up). */
  let hangUntil: number;
  /** Sessions whose heartbeats the scripted daemon never answers. */
  let hangSessions: Set<string>;
  /** How many more `observe` calls the daemon refuses with its suspect-session error. */
  let suspectObserveRefusals: number;
  /** Every `observe` the scripted daemon received, across reconnects. */
  let observeCalls: number;
  /** `observe` calls for this session never answer: a tool call in flight on the shared socket. */
  let hangObserveFor: string | undefined;
  /** Daemon connections the proxy opened: one more for every time it replaced its socket. */
  let clientsCreated: number;
  let androidAcquisitionSession: string;
  let latestClient: FakeDaemonClient;
  let heartbeatsSeen: number;
  let handovers: LivenessHandover[];
  let infoSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  const proxies: DaemonMcpProxy[] = [];

  function daemonBackedClient(): FakeDaemonClient {
    return new FakeDaemonClient({
      daemonMethodResults: new Map<string, unknown>([
        ["tools/list", { tools: [{ name: "getAndroid", inputSchema: { type: "object" } }] }],
        ["resources/list", { resources: [{ uri: "automobile:devices/booted", name: "booted" }] }],
        ["resources/list-templates", { resourceTemplates: [] }],
      ]),
      toolResultFor: (name, params) =>
        name === "getAndroid"
          ? deviceStartResult(androidAcquisitionSession, DEVICES["android-session"])
          : name === "getApple"
            ? deviceStartResult("ios-session", DEVICES["ios-session"])
            : name === "observe"
              ? observeResult(params.sessionUuid)
              : undefined,
      onCallTool: async (name, params) => {
        if (name === "observe") {
          observeCalls += 1;
        }
        if (name === "observe" && params.sessionUuid === hangObserveFor) {
          await new Promise<void>(() => {});
        }
      },
      onCallDaemonMethod: async (method, params) => {
        if (method !== "daemon/heartbeat") {
          return;
        }
        heartbeatsSeen += 1;
        if (hangSessions.has(params.sessionId)) {
          return new Promise<void>(() => {});
        }
        if (timer.now() < hangUntil) {
          return new Promise<void>(() => {});
        }
        if (hangHeartbeats > 0) {
          hangHeartbeats -= 1;
          return new Promise<void>(() => {});
        }
        const response = await handleDaemonRequest(
          { id: "request-1", type: "daemon_request", method, params },
          daemonStateFor(sessionManager),
        );
        if (!response.success) {
          throw Object.assign(new Error(response.error), { code: response.code });
        }
      },
    });
  }

  function shapeSuspectResult(sessionUuid = "android-session") {
    return shapeToolCallError(new SessionSuspectError(sessionUuid, 8_000), {
      toolName: "observe",
      source: "ProxyServer",
    });
  }

  function observeResult(sessionUuid: unknown) {
    if (suspectObserveRefusals > 0) {
      suspectObserveRefusals -= 1;
      return shapeSuspectResult(String(sessionUuid));
    }
    return OBSERVED;
  }

  function createProxy(
    intervalMs: number,
    autoStartDaemon = false,
    initialSessionUuid?: string,
  ): DaemonMcpProxy {
    const proxy = new DaemonMcpProxy({
      clientFactory: () => {
        clientsCreated += 1;
        latestClient = daemonBackedClient();
        return latestClient;
      },
      daemonManager,
      autoStartDaemon,
      initialSessionUuid,
      timer,
      idGenerator: new FakeIdGenerator(["proxy-token"]),
      heartbeatTimeoutMs: LEASE_MS,
      heartbeatIntervalMs: intervalMs,
    });
    proxy.onLivenessHandover((handover) => handovers.push(handover));
    proxies.push(proxy);
    return proxy;
  }

  async function acquire(proxy: DaemonMcpProxy, tool: "getAndroid" | "getApple"): Promise<void> {
    await proxy.callTool(tool, {});
  }

  /** Advance in small steps until a handover lands; returns how long that took. */
  async function advanceUntilHandover(limitMs = 40_000): Promise<number> {
    const startedAt = timer.now();
    for (let elapsed = 0; elapsed < limitMs && handovers.length === 0; elapsed += 250) {
      await baseTimer.advanceTimeAsync(250);
    }
    return timer.now() - startedAt;
  }

  beforeEach(async () => {
    baseTimer = new LivenessTimer();
    timer = new StallableTimer(baseTimer);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const start = daemonManager.start.bind(daemonManager);
    spyOn(daemonManager, "start").mockImplementation(async (options) => {
      const result = await start(options);
      daemonManager.statusResult = { ...daemonManager.statusResult, running: true };
      return result;
    });
    hangHeartbeats = 0;
    hangSessions = new Set();
    hangUntil = 0;
    hangObserveFor = undefined;
    clientsCreated = 0;
    androidAcquisitionSession = "android-session";
    suspectObserveRefusals = 0;
    observeCalls = 0;
    heartbeatsSeen = 0;
    handovers = [];
    for (const [sessionId, deviceId] of Object.entries(DEVICES)) {
      await sessionManager.createSession(
        sessionId,
        deviceId,
        sessionId.startsWith("ios") ? "ios" : "android",
        60_000,
        LEASE_MS,
      );
    }
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) {
      await proxy.close();
    }
    isAvailableSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    sessionManager.stopCleanupTimer();
  });

  describe("daemon_stalled", () => {
    test.each([2_000, 5_000])(
      "an unresponsive daemon yields daemon_stalled after exactly three failed attempts at a %i ms cadence",
      async (intervalMs) => {
        const proxy = createProxy(intervalMs);
        await acquire(proxy, "getAndroid");
        const lastAck = timer.now();
        hangHeartbeats = Number.POSITIVE_INFINITY;
        heartbeatsSeen = 0;

        const elapsedMs = await advanceUntilHandover();

        expect(handovers).toHaveLength(1);
        const [handover] = handovers;
        expect(handover.code).toBe("daemon_stalled");
        expect(handover.attempts).toBe(LIVENESS_RECOVERY_ATTEMPTS);
        // The periodic heartbeat that went unanswered plus exactly three recovery attempts.
        expect(heartbeatsSeen).toBe(1 + LIVENESS_RECOVERY_ATTEMPTS);
        // All of it fits inside the lease plus the suspect grace window.
        expect(elapsedMs).toBeLessThan(LEASE_MS + SUSPECT_GRACE_MS);
        expect(handover.sessions).toEqual([
          {
            sessionUuid: "android-session",
            deviceId: "emulator-5554",
            lastAcknowledgedHeartbeatAt: lastAck,
          },
        ]);
        expect(handover.lastAcknowledgedHeartbeatAt).toBe(lastAck);
        expect(handover.action).toBe("restart_daemon_then_resume_by_session_uuid");
        // The proxy never touched daemon lifecycle.
        expect(daemonManager.startCallCount).toBe(0);
        expect(daemonManager.restartCallCount).toBe(0);
        expect(daemonManager.recoverControlStateCallCount).toBe(0);
      },
    );

    test("the next tool call for the session returns the structured error, and so does a sessionless one", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      hangHeartbeats = Number.POSITIVE_INFINITY;
      await advanceUntilHandover();

      const error = await proxy.callTool("observe", { sessionUuid: "android-session" }).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      expect(error).toBeInstanceOf(DaemonSessionStalledError);
      const stalled = error as DaemonSessionStalledError;
      expect(stalled.toPayload().error).toMatchObject({
        code: "daemon_stalled",
        attempts: 3,
        sessions: [{ sessionUuid: "android-session", deviceId: "emulator-5554" }],
        recovery: { action: "restart_daemon_then_resume_by_session_uuid" },
      });

      // The sessionless call reaches the same fenced binding and gets the same error.
      await expect(proxy.callTool("observe", {})).rejects.toMatchObject({
        reason: "daemon_stalled",
        handover: { code: "daemon_stalled" },
      });
    });

    test("an idle harness is told through the handover listener without making a call", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      hangHeartbeats = Number.POSITIVE_INFINITY;
      await advanceUntilHandover();

      expect(handovers).toHaveLength(1);
      expect(handovers[0].sessions.map((session) => session.sessionUuid)).toEqual([
        "android-session",
      ]);
    });

    test.each([1, 2, 3])(
      "a daemon that answers recovery attempt %i leaves the session usable with nothing surfaced",
      async (answersAtAttempt) => {
        const proxy = createProxy(2_000);
        await acquire(proxy, "getAndroid");
        // The periodic heartbeat plus the attempts before the answering one all go unanswered.
        hangHeartbeats = answersAtAttempt;
        heartbeatsSeen = 0;

        await baseTimer.advanceTimeAsync(LEASE_MS + SUSPECT_GRACE_MS);

        expect(handovers).toEqual([]);
        await expect(
          proxy.callTool("observe", { sessionUuid: "android-session" }),
        ).resolves.toBeDefined();
        expect(sessionManager.getSession("android-session")).toBeTruthy();
        expect(
          infoSpy.mock.calls.some(([message]) =>
            String(message).includes(`Recovered daemon_stalled for session android-session`),
          ),
        ).toBe(true);
      },
    );

    test("recovery never starts or restarts the daemon even when auto-start is on and the daemon is down", async () => {
      const proxy = createProxy(2_000, true);
      await acquire(proxy, "getAndroid");
      hangHeartbeats = Number.POSITIVE_INFINITY;
      // Reconnect attempts see no daemon at all.
      isAvailableSpy.mockResolvedValue(false);
      const refused = spyOn(DaemonClient, "isAvailable").mockResolvedValue(false);

      try {
        const baselineStarts = daemonManager.startCallCount;
        await advanceUntilHandover();

        expect(handovers).toHaveLength(1);
        expect(daemonManager.startCallCount).toBe(baselineStarts);
        expect(daemonManager.restartCallCount).toBe(0);
      } finally {
        refused.mockRestore();
      }
    });

    test("a held session that stalls is reported when it is named, while the latest binding keeps working", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      await acquire(proxy, "getApple");
      // android-session is now held and ios-session is the latest binding. Only the held one loses
      // its acknowledgements.
      hangSessions.add("android-session");
      await advanceUntilHandover();

      expect(handovers).toHaveLength(1);
      expect(handovers[0].sessions).toEqual([
        expect.objectContaining({ sessionUuid: "android-session", deviceId: "emulator-5554" }),
      ]);
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).rejects.toBeInstanceOf(DaemonSessionStalledError);
      // The latest binding was never affected: it is neither fenced nor handed over.
      await expect(proxy.callTool("observe", {})).resolves.toBeDefined();
      await expect(
        proxy.callTool("observe", { sessionUuid: "ios-session" }),
      ).resolves.toBeDefined();
    });

    test("after the handover, naming the session again resumes it by UUID", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      hangHeartbeats = Number.POSITIVE_INFINITY;
      await advanceUntilHandover();
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).rejects.toBeInstanceOf(DaemonSessionStalledError);

      // The harness restarted the daemon (the scripted daemon answers again) and names the session.
      hangHeartbeats = 0;
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).resolves.toBeDefined();
      handovers.length = 0;
      await baseTimer.advanceTimeAsync(LEASE_MS * 3);
      expect(handovers).toEqual([]);
      expect(sessionManager.getSession("android-session")).toBeTruthy();
      expect(sessionManager.getSessionLeaseState("android-session")?.phase).toBe("live");
    });
  });

  describe("lifecycle isolation", () => {
    const calls: Array<[string, (proxy: DaemonMcpProxy) => Promise<unknown>]> = [
      ["named tool", (proxy) => proxy.callTool("observe", { sessionUuid: "android-session" })],
      ["resource read", (proxy) => proxy.readResource("automobile:devices/booted")],
      ["tool output read", (proxy) => proxy.readResource("automobile:tool-output/test")],
    ];

    for (const phase of ["recovering", "handed over"] as const) {
      for (const available of [false, true]) {
        test.each(calls)(
          `%s while ${phase}, available=${available}, never manages lifecycle`,
          async (_name, call) => {
            const proxy = createProxy(2_000, true);
            await acquire(proxy, "getAndroid");
            hangHeartbeats = Number.POSITIVE_INFINITY;
            if (phase === "handed over") {
              await advanceUntilHandover();
              // Deliver once so the named-tool case exercises the second call too.
              await expect(
                proxy.callTool("observe", { sessionUuid: "android-session" }),
              ).rejects.toBeInstanceOf(DaemonSessionStalledError);
            } else {
              await baseTimer.advanceTimeAsync(6_000);
            }
            latestClient.emitConnectionClosed();
            isAvailableSpy.mockResolvedValue(available);
            if (!available) {
              daemonManager.statusResult = { ...daemonManager.statusResult, running: false };
            }
            if (available) {
              daemonManager.statusResults = [
                { ...daemonManager.statusResult, version: "0.0.1" },
                daemonManager.statusResult,
              ];
            }
            let settled = false;
            let error: unknown;
            void call(proxy).then(
              () => {
                settled = true;
              },
              (rejected: unknown) => {
                error = rejected;
                settled = true;
              },
            );
            for (let elapsed = 0; elapsed < 40_000 && !settled; elapsed += 250) {
              await baseTimer.advanceTimeAsync(250);
            }
            expect(settled).toBe(true);
            if (_name === "tool output read" && phase === "recovering" && available) {
              expect(error).toBeUndefined();
            } else {
              expect(error).toBeInstanceOf(DaemonSessionStalledError);
            }
            if (error instanceof DaemonSessionStalledError) {
              expect(error.toPayload().error).toMatchObject({
                code: "daemon_stalled",
                attempts: 3,
              });
            }
            expect(daemonManager.startCallCount).toBe(0);
            expect(daemonManager.restartCallCount).toBe(0);
            expect(daemonManager.recoverControlStateCallCount).toBe(0);
          },
        );
      }
    }

    test.each(["recovering", "handed over"] as const)(
      "discovery while %s serves cold lists without managing lifecycle or awaiting recovery",
      async (phase) => {
        const proxy = createProxy(2_000, true);
        await acquire(proxy, "getAndroid");
        hangHeartbeats = Number.POSITIVE_INFINITY;
        if (phase === "handed over") {
          await advanceUntilHandover();
        } else {
          await baseTimer.advanceTimeAsync(6_000);
        }
        latestClient.emitConnectionClosed();
        isAvailableSpy.mockResolvedValue(false);
        daemonManager.statusResult = { ...daemonManager.statusResult, running: false };
        const discoveries = [
          () => proxy.listTools(),
          () => proxy.listResources(),
          () => proxy.listResourceTemplates(),
          () => proxy.listAdvertisedTools(),
          () => proxy.listAdvertisedResources(),
          () => proxy.listAdvertisedResourceTemplates(),
        ];
        for (const discover of discoveries) {
          expect(Array.isArray(await discover())).toBe(true);
        }
        expect(await proxy.listTools()).toEqual(getStaticToolDefinitions());
        expect(await proxy.listResources()).toEqual([]);
        expect(await proxy.listResourceTemplates()).toEqual([]);
        expect(handovers).toHaveLength(phase === "handed over" ? 1 : 0);
        expect(daemonManager.startCallCount).toBe(0);
        expect(daemonManager.restartCallCount).toBe(0);
        expect(daemonManager.recoverControlStateCallCount).toBe(0);
      },
    );

    test("discovery preserves cached lists during recovery without dispatching list RPCs", async () => {
      const proxy = createProxy(2_000, true);
      await acquire(proxy, "getAndroid");
      const tools = await proxy.listTools();
      const resources = await proxy.listResources();
      const templates = await proxy.listResourceTemplates();
      hangHeartbeats = Number.POSITIVE_INFINITY;
      await baseTimer.advanceTimeAsync(6_000);
      const callsBefore = latestClient.callDaemonMethodCalls.length;
      expect(await proxy.listTools()).toEqual(tools);
      expect(await proxy.listAdvertisedTools()).toEqual(tools);
      expect(await proxy.listResources()).toEqual(resources);
      expect(await proxy.listAdvertisedResources()).toEqual(resources);
      expect(await proxy.listResourceTemplates()).toEqual(templates);
      expect(await proxy.listAdvertisedResourceTemplates()).toEqual(templates);
      expect(latestClient.callDaemonMethodCalls).toHaveLength(callsBefore);
      expect(handovers).toEqual([]);
      expect(daemonManager.startCallCount).toBe(0);
      expect(daemonManager.restartCallCount).toBe(0);
    });

    test.each([false, true])(
      "uncached discovery after handover, available=%s, cannot reconcile or start a daemon",
      async (available) => {
        const proxy = createProxy(2_000, true);
        await acquire(proxy, "getAndroid");
        hangHeartbeats = Number.POSITIVE_INFINITY;
        await advanceUntilHandover();
        latestClient.emitConnectionClosed();
        isAvailableSpy.mockResolvedValue(available);
        daemonManager.statusResult = {
          ...daemonManager.statusResult,
          running: available,
          version: "0.0.1",
        };
        await baseTimer.advanceTimeAsync(DAEMON_RESTART_HANDOFF_TIMEOUT_MS + 250);
        const tools = await proxy.listTools();
        const resources = await proxy.listResources();
        const templates = await proxy.listResourceTemplates();
        expect(tools).toEqual(
          available
            ? [{ name: "getAndroid", inputSchema: { type: "object" } }]
            : getStaticToolDefinitions(),
        );
        expect(resources).toEqual(
          available ? [{ uri: "automobile:devices/booted", name: "booted" }] : [],
        );
        expect(templates).toEqual([]);
        expect(daemonManager.startCallCount).toBe(0);
        expect(daemonManager.restartCallCount).toBe(0);
        expect(daemonManager.recoverControlStateCallCount).toBe(0);
        await expect(proxy.readResource("automobile:devices/booted")).rejects.toMatchObject({
          reason: "daemon_stalled",
        });
        await expect(
          proxy.callTool("observe", { sessionUuid: "android-session" }),
        ).rejects.toMatchObject({
          reason: "daemon_stalled",
        });
      },
    );

    test("a no-lifecycle operation cannot join an in-flight lifecycle-capable connect", async () => {
      const proxy = createProxy(2_000, true);
      let finishProbe: (available: boolean) => void = () => {};
      isAvailableSpy.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            finishProbe = resolve;
          }),
      );
      const ordinary = proxy.ensureConnected();
      const recovery = runWithoutDaemonLifecycle(() => proxy.ensureConnected());
      let recoverySettled = false;
      void recovery.then(
        () => {
          recoverySettled = true;
        },
        () => {
          recoverySettled = true;
        },
      );
      await baseTimer.advanceTimeAsync(1);
      await drainUntilQuiescent(baseTimer);
      const settledBeforeProbe = recoverySettled;
      daemonManager.statusResult = { ...daemonManager.statusResult, running: false };
      finishProbe(false);
      await ordinary;
      await recovery.catch(() => {});
      expect(settledBeforeProbe).toBe(true);
      expect(daemonManager.startCallCount).toBe(1);
    });

    test("recovery completes without joining a lifecycle-capable pending connect", async () => {
      const proxy = createProxy(2_000, true, "android-session");
      let finishProbe: (available: boolean) => void = () => {};
      isAvailableSpy.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            finishProbe = resolve;
          }),
      );
      const ordinary = proxy.ensureConnected().catch((error: unknown) => error);
      const recovery = Reflect.get(proxy, "livenessRecovery");
      if (!(recovery instanceof LivenessRecovery)) {
        throw new Error("Proxy liveness recovery seam is missing");
      }
      const slotMs = recoveryAttemptSlotMs({
        leaseMs: LEASE_MS,
        lastAckAt: timer.now(),
        now: timer.now(),
        requestTimeoutMs: 4_000,
      });
      recovery.begin("android-session", "daemon_stalled");
      expect(await proxy.listTools()).toEqual(getStaticToolDefinitions());
      expect(await proxy.listResources()).toEqual([]);
      expect(await proxy.listResourceTemplates()).toEqual([]);
      expect(await proxy.listAdvertisedTools()).toEqual(getStaticToolDefinitions());
      expect(await proxy.listAdvertisedResources()).toEqual([]);
      expect(await proxy.listAdvertisedResourceTemplates()).toEqual([]);
      const elapsedMs = await advanceUntilHandover();
      const handedOverBeforeProbe = handovers.length;
      finishProbe(false);
      await ordinary;
      expect(handedOverBeforeProbe).toBe(1);
      expect(elapsedMs).toBeLessThan(3 * slotMs);
      expect(handovers[0]).toMatchObject({ code: "daemon_stalled", attempts: 3 });
      expect(daemonManager.startCallCount).toBe(0);
      expect(daemonManager.restartCallCount).toBe(0);
    });

    test.each([false, true])(
      "a proxy holding healthy sessions=%s still auto-starts",
      async (holdsSessions) => {
        const proxy = createProxy(2_000, true, holdsSessions ? "android-session" : undefined);
        isAvailableSpy.mockResolvedValue(false);
        daemonManager.statusResult = { ...daemonManager.statusResult, running: false };
        await proxy.ensureConnected();
        expect(daemonManager.startCallCount).toBe(1);
        expect(daemonManager.restartCallCount).toBe(0);
      },
    );
  });

  describe("proxy_stalled", () => {
    test("a tick delayed past the lease but inside the grace window restores the same UUID", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");

      timer.stall(LEASE_MS + 3_000);
      expect(sessionManager.getSessionLeaseState("android-session")?.phase).toBe("suspect");
      await baseTimer.advanceTimeAsync(2_000);
      await baseTimer.advanceTimeAsync(2_000);

      expect(handovers).toEqual([]);
      expect(sessionManager.getSession("android-session")?.sessionId).toBe("android-session");
      expect(sessionManager.getSessionLeaseState("android-session")?.phase).toBe("live");
      expect(
        infoSpy.mock.calls.some(([message]) =>
          String(message).includes(
            "Recovered proxy_stalled for session android-session after 1 attempt(s); the daemon held it as suspect and kept the same UUID",
          ),
        ),
      ).toBe(true);
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).resolves.toBeDefined();
    });

    test("a tick delayed past lease plus grace produces proxy_stalled naming the lost sessions and devices", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      await acquire(proxy, "getApple");
      const lastAck = timer.now();

      timer.stall(LEASE_MS + SUSPECT_GRACE_MS + 5_000);
      // The daemon released both sessions while the proxy could not heartbeat.
      await sessionManager.releaseSession("android-session", "heartbeat-timeout");
      await sessionManager.releaseSession("ios-session", "heartbeat-timeout");
      await baseTimer.advanceTimeAsync(2_000);
      await baseTimer.advanceTimeAsync(2_000);

      expect(handovers).toHaveLength(1);
      const [handover] = handovers;
      expect(handover.code).toBe("proxy_stalled");
      expect(handover.action).toBe("reacquire_lost_sessions");
      expect(
        handover.sessions
          .map((session) => [session.sessionUuid, session.deviceId])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ["android-session", "emulator-5554"],
        ["ios-session", "sim-1"],
      ]);
      expect(handover.sessions.every((s) => s.lastAcknowledgedHeartbeatAt === lastAck)).toBe(true);
      expect(daemonManager.restartCallCount).toBe(0);

      const error = await proxy.callTool("observe", { sessionUuid: "android-session" }).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      expect(error).toBeInstanceOf(DaemonSessionStalledError);
      expect((error as DaemonSessionStalledError).toPayload().error).toMatchObject({
        code: "proxy_stalled",
        recovery: { action: "reacquire_lost_sessions" },
      });
    });

    test("unreachable daemon retains handover across repeated tool and resource reads", async () => {
      const proxy = createProxy(2_000, true);
      await acquire(proxy, "getAndroid");
      hangHeartbeats = Number.POSITIVE_INFINITY;
      await advanceUntilHandover();
      expect(handovers[0]?.code).toBe("daemon_stalled");
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).rejects.toBeInstanceOf(DaemonSessionStalledError);
      latestClient.emitConnectionClosed();
      isAvailableSpy.mockResolvedValue(false);
      const namedCall = proxy
        .callTool("observe", { sessionUuid: "android-session" })
        .catch((error: unknown) => error);
      for (let step = 0; step < 24; step += 1) {
        await baseTimer.advanceTimeAsync(250);
      }
      expect(await namedCall).toMatchObject({ handover: { code: "daemon_stalled" } });
      await expect(proxy.readResource("automobile:devices/booted")).rejects.toMatchObject({
        handover: { code: "daemon_stalled" },
      });
      await expect(proxy.listAdvertisedTools()).resolves.toBeArray();
      expect(daemonManager.startCallCount).toBe(0);
      expect(daemonManager.restartCallCount).toBe(0);
    });

    test("a tick that is merely slow, not late by more than the lease, starts no recovery", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");

      timer.stall(LEASE_MS - 2_500);
      await baseTimer.advanceTimeAsync(2_000);
      await baseTimer.advanceTimeAsync(2_000);

      expect(handovers).toEqual([]);
      expect(
        warnSpy.mock.calls.some(([message]) => String(message).includes("tick fired more than")),
      ).toBe(false);
    });
  });

  describe("delta findings F1-F6", () => {
    function recoveryOf(proxy: DaemonMcpProxy): LivenessRecovery {
      const recovery = Reflect.get(proxy, "livenessRecovery");
      if (!(recovery instanceof LivenessRecovery)) {
        throw new Error("Missing liveness recovery seam");
      }
      return recovery;
    }

    function handoverCount(proxy: DaemonMcpProxy): number {
      const map = Reflect.get(proxy, "stallHandovers");
      if (!(map instanceof Map)) {
        throw new Error("Missing handover seam");
      }
      return map.size;
    }

    async function stallAndroid(proxy: DaemonMcpProxy): Promise<void> {
      hangSessions.add("android-session");
      await advanceUntilHandover();
      hangSessions.clear();
    }

    test("F1 ack removes the handover entry", async () => {
      const proxy = createProxy(2_000, true);
      await acquire(proxy, "getAndroid");
      await stallAndroid(proxy);
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).rejects.toBeInstanceOf(DaemonSessionStalledError);
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).resolves.toBeDefined();
      expect(handoverCount(proxy)).toBe(0);
    });

    test.each(["not-found", "notification", "foreign-token", "foreign-conflict"])(
      "F1 definitive %s ends a non-latest handover and delivers loss exactly once",
      async (answer) => {
        const proxy = createProxy(2_000, true);
        await acquire(proxy, "getAndroid");
        await acquire(proxy, "getApple");
        await stallAndroid(proxy);
        if (answer === "not-found") {
          await expect(
            proxy.callTool("observe", { sessionUuid: "android-session" }),
          ).rejects.toMatchObject({ reason: "daemon_stalled" });
          await sessionManager.releaseSession("android-session", "heartbeat-timeout");
          const result = await handleDaemonRequest(
            {
              id: "typed-missing",
              type: "daemon_request",
              method: "daemon/heartbeat",
              params: { sessionId: "android-session" },
            },
            daemonStateFor(sessionManager),
          );
          expect(result.code).toBe(DAEMON_SESSION_NOT_FOUND_CODE);
        } else if (answer === "notification") {
          latestClient.emitNotification(
            SESSION_RELEASED_NOTIFICATION_METHOD,
            "android-session",
            "heartbeat-timeout",
          );
          latestClient.emitNotification(
            SESSION_RELEASED_NOTIFICATION_METHOD,
            "android-session",
            "heartbeat-timeout",
          );
          expect(handoverCount(proxy)).toBe(0);
        } else {
          await expect(
            proxy.callTool("observe", { sessionUuid: "android-session" }),
          ).rejects.toMatchObject({ reason: "daemon_stalled" });
          timer.stall(2_000);
          expect(
            await sessionManager.claimLivenessOwnership("android-session", "other-owner"),
          ).toBe("claimed");
          if (answer === "foreign-conflict") {
            // A rehydrated daemon can reject the old token without its processed-claim history.
            spyOn(latestClient, "callDaemonMethod").mockRejectedValueOnce(
              Object.assign(new Error("Typed refusal without session-loss prose"), {
                code: DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
              }),
            );
          }
        }
        await expect(
          proxy.callTool("observe", { sessionUuid: "android-session" }),
        ).rejects.toMatchObject({
          reason: "proxy_stalled",
          handover: {
            action: "reacquire_lost_sessions",
            sessions: [{ sessionUuid: "android-session", deviceId: "emulator-5554" }],
          },
        });
        expect(handoverCount(proxy)).toBe(0);
        await expect(
          proxy.callTool("observe", { sessionUuid: "android-session" }),
        ).resolves.toBeDefined();
        await expect(proxy.callTool("observe", {})).resolves.toBeDefined();
        await expect(proxy.readResource("automobile:tool-output/kept")).resolves.toBeDefined();
        expect(await proxy.listAdvertisedResources()).toEqual([
          { uri: "automobile:devices/booted", name: "booted" },
        ]);
        expect(await proxy.listAdvertisedResourceTemplates()).toEqual([]);
        expect(await proxy.listAdvertisedTools()).toBeArray();
        if (answer === "foreign-token" || answer === "foreign-conflict") {
          expect(sessionManager.getSession("android-session")?.livenessOwnerToken).toBe(
            "other-owner",
          );
        }
      },
    );

    test.each(["notification", "not-found"])(
      "F1 only-session %s lifts the fence, delivers once, and allows getAndroid auto-start",
      async (answer) => {
        const proxy = createProxy(2_000, true);
        await acquire(proxy, "getAndroid");
        await stallAndroid(proxy);
        await sessionManager.releaseSession("android-session", "heartbeat-timeout");
        if (answer === "notification") {
          latestClient.emitNotification(
            SESSION_RELEASED_NOTIFICATION_METHOD,
            "android-session",
            "heartbeat-timeout",
          );
          expect(handoverCount(proxy)).toBe(0);
          await expect(proxy.callTool("listDevices", {})).resolves.toBeDefined();
        } else {
          await expect(
            proxy.callTool("observe", { sessionUuid: "android-session" }),
          ).rejects.toMatchObject({ reason: "daemon_stalled" });
        }
        await expect(
          proxy.callTool("observe", { sessionUuid: "android-session" }),
        ).rejects.toMatchObject({ reason: "proxy_stalled" });
        await expect(
          proxy.callTool("observe", { sessionUuid: "android-session" }),
        ).rejects.toMatchObject({
          reason: answer === "notification" ? "heartbeat-timeout" : "session-not-found",
        });
        expect(handoverCount(proxy)).toBe(0);
        latestClient.emitConnectionClosed();
        isAvailableSpy.mockResolvedValue(false);
        daemonManager.statusResult = { ...daemonManager.statusResult, running: false };
        androidAcquisitionSession = "fresh-android-session";
        await sessionManager.createSession(
          androidAcquisitionSession,
          DEVICES["android-session"],
          "android",
          60_000,
          LEASE_MS,
        );
        const acquisition = acquire(proxy, "getAndroid");
        await drainUntilQuiescent(baseTimer);
        await baseTimer.advanceTimeAsync(DAEMON_RESTART_HANDOFF_TIMEOUT_MS + 250);
        await acquisition;
        expect(daemonManager.startCallCount).toBe(1);
        await expect(proxy.readResource("automobile:devices/booted")).resolves.toBeDefined();
        expect(await proxy.listAdvertisedResources()).toHaveLength(1);
      },
    );

    test("F1 proxy_stalled loss is delivered once and getAndroid can auto-start", async () => {
      const proxy = createProxy(2_000, true);
      await acquire(proxy, "getAndroid");
      timer.stall(LEASE_MS + SUSPECT_GRACE_MS + 5_000);
      await sessionManager.releaseSession("android-session", "heartbeat-timeout");
      await baseTimer.advanceTimeAsync(4_000);
      expect(handoverCount(proxy)).toBe(0);
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).rejects.toMatchObject({ reason: "proxy_stalled" });
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).rejects.toMatchObject({ reason: "session-not-found" });
      expect(handoverCount(proxy)).toBe(0);
      androidAcquisitionSession = "fresh-android-session";
      await sessionManager.createSession(
        androidAcquisitionSession,
        DEVICES["android-session"],
        "android",
        60_000,
        LEASE_MS,
      );
      latestClient.emitConnectionClosed();
      isAvailableSpy.mockResolvedValue(false);
      daemonManager.statusResult = { ...daemonManager.statusResult, running: false };
      const acquisition = acquire(proxy, "getAndroid");
      await drainUntilQuiescent(baseTimer);
      await baseTimer.advanceTimeAsync(DAEMON_RESTART_HANDOFF_TIMEOUT_MS + 250);
      await acquisition;
      expect(daemonManager.startCallCount).toBe(1);
      await expect(proxy.callTool("observe", {})).resolves.toBeDefined();
    });

    test("F1 unreachable resume retains its entry and no-start fence", async () => {
      const proxy = createProxy(2_000, true);
      await acquire(proxy, "getAndroid");
      await stallAndroid(proxy);
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).rejects.toMatchObject({ reason: "daemon_stalled" });
      latestClient.emitConnectionClosed();
      isAvailableSpy.mockResolvedValue(false);
      const resume = proxy
        .callTool("observe", { sessionUuid: "android-session" })
        .catch((error: unknown) => error);
      await drainUntilQuiescent(baseTimer);
      for (let step = 0; step < 100; step += 1) {
        await baseTimer.advanceTimeAsync(250);
      }
      expect(await resume).toBeInstanceOf(DaemonSessionStalledError);
      expect(handoverCount(proxy)).toBe(1);
      latestClient.emitConnectionClosed();
      await expect(proxy.readResource("automobile:tool-output/fenced")).rejects.toMatchObject({
        reason: "daemon_stalled",
      });
      expect(daemonManager.startCallCount).toBe(0);
      expect(daemonManager.restartCallCount).toBe(0);
    });

    test("F3 connected healthy binding and tool-output reads survive an unrelated handover", async () => {
      const proxy = createProxy(2_000, true);
      await acquire(proxy, "getAndroid");
      await acquire(proxy, "getApple");
      await stallAndroid(proxy);
      await expect(
        proxy.readResource("automobile:device-session/ios-session/screenshot"),
      ).resolves.toBeDefined();
      await expect(proxy.readResource("automobile:tool-output/saved")).resolves.toBeDefined();
      await expect(
        proxy.readResource("automobile:device-session/android-session/screenshot"),
      ).rejects.toMatchObject({ reason: "daemon_stalled" });
      latestClient.emitConnectionClosed();
      await expect(proxy.readResource("automobile:tool-output/saved")).rejects.toMatchObject({
        reason: "daemon_stalled",
      });
      expect(daemonManager.startCallCount).toBe(0);
    });

    test.each([true, false])(
      "F2 settled connect releases recovery and gives joiners structured failures, reachable=%s",
      async (reachable) => {
        const proxy = createProxy(2_000, true, "android-session");
        const probe = Promise.withResolvers<boolean>();
        isAvailableSpy.mockImplementationOnce(() => probe.promise);
        const originator = proxy.ensureConnected().catch((error: unknown) => error);
        const joiner = proxy.ensureConnected().catch((error: unknown) => error);
        recoveryOf(proxy).begin("android-session", "daemon_stalled");
        isAvailableSpy.mockResolvedValue(reachable);
        probe.reject(new DaemonUnavailableError("Failed lifecycle connect"));
        await baseTimer.advanceTimeAsync(20_000);
        if (reachable) {
          expect(await originator).toBeUndefined();
          expect(await joiner).toBeUndefined();
          expect(handovers).toEqual([]);
          expect(heartbeatsSeen).toBeGreaterThan(0);
        } else {
          expect(await originator).toBeInstanceOf(DaemonSessionStalledError);
          expect(await joiner).toBeInstanceOf(DaemonSessionStalledError);
        }
        expect(daemonManager.startCallCount).toBe(0);
        expect(daemonManager.restartCallCount).toBe(0);
      },
    );

    test.each(["tool", "resource"])(
      "F6 aborted %s wait preserves shared recovery",
      async (kind) => {
        const proxy = createProxy(2_000);
        await acquire(proxy, "getAndroid");
        hangHeartbeats = 1;
        recoveryOf(proxy).begin("android-session", "daemon_stalled");
        const controller = new AbortController();
        const reason = new Error("Caller cancelled recovery wait");
        const cancelled = (
          kind === "tool"
            ? proxy.callTool(
                "observe",
                { sessionUuid: "android-session" },
                undefined,
                undefined,
                controller.signal,
              )
            : proxy.readResource("automobile:devices/booted", { signal: controller.signal })
        ).catch((error: unknown) => error);
        const sibling = proxy.callTool("observe", { sessionUuid: "android-session" });
        controller.abort(reason);
        await baseTimer.advanceTimeAsync(1);
        expect(await cancelled).toBe(reason);
        expect(recoveryOf(proxy).isRecovering("android-session")).toBe(true);
        await baseTimer.advanceTimeAsync(10_000);
        await expect(sibling).resolves.toBeDefined();
        expect(handovers).toEqual([]);
      },
    );
  });

  describe("review fixes (PR 10115)", () => {
    /** A private map on the proxy, read without a type assertion. */
    function trackedBy(proxy: DaemonMcpProxy, field: string): Map<string, unknown> {
      const value = Reflect.get(proxy, field);
      if (!(value instanceof Map)) {
        throw new Error(`${field} is not a Map`);
      }
      return value;
    }

    test("F3: a proxy displaced while stalled is handed over as lost, with its session fenced", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");

      timer.stall(LEASE_MS + SUSPECT_GRACE_MS + 5_000);
      expect(sessionManager.getSessionLeaseState("android-session")?.phase).toBe("lapsed");
      // Before the monitor reaps the lapsed session, another harness's proxy claims it.
      expect(await sessionManager.claimLivenessOwnership("android-session", "other-token")).toBe(
        "claimed",
      );
      await baseTimer.advanceTimeAsync(2_000);
      await baseTimer.advanceTimeAsync(2_000);

      expect(handovers).toHaveLength(1);
      expect(handovers[0]).toMatchObject({
        code: "proxy_stalled",
        attempts: 1,
        action: "reacquire_lost_sessions",
        sessions: [{ sessionUuid: "android-session", deviceId: "emulator-5554" }],
      });
      expect(
        infoSpy.mock.calls.some(([message]) => String(message).includes("Recovered proxy_stalled")),
      ).toBe(false);
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).rejects.toBeInstanceOf(DaemonSessionStalledError);
      // The other owner is untouched.
      expect(sessionManager.getSession("android-session")?.livenessOwnerToken).toBe("other-token");
    });

    test("F4: after a long proxy stall, a daemon that is slow to answer still restores the session", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      timer.stall(55_000);
      // The daemon woke with the proxy and needs a few seconds before it answers heartbeats.
      hangUntil = timer.now() + 2_000 + 5_000;

      await baseTimer.advanceTimeAsync(2_000);
      await baseTimer.advanceTimeAsync(4_000);
      await baseTimer.advanceTimeAsync(4_000);

      expect(handovers).toEqual([]);
      expect(
        infoSpy.mock.calls.some(([message]) =>
          String(message).includes("Recovered proxy_stalled for session android-session"),
        ),
      ).toBe(true);
    });

    test("F4: after a proxy stall, a daemon that never answers is reported as daemon_stalled, not as released sessions", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      timer.stall(55_000);
      hangHeartbeats = Number.POSITIVE_INFINITY;

      await advanceUntilHandover();

      expect(handovers).toHaveLength(1);
      expect(handovers[0]).toMatchObject({
        code: "daemon_stalled",
        attempts: LIVENESS_RECOVERY_ATTEMPTS,
        action: "restart_daemon_then_resume_by_session_uuid",
        sessions: [{ sessionUuid: "android-session" }],
      });
    });

    test("F6: a held session the daemon does not know is dropped once, without resetting the shared socket", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      await acquire(proxy, "getApple");
      // android-session is held, ios-session is the latest binding. The daemon loses the held one
      // without any release notification reaching this proxy.
      await sessionManager.releaseSession("android-session", "heartbeat-timeout");
      const clientsBefore = clientsCreated;
      heartbeatsSeen = 0;

      await baseTimer.advanceTimeAsync(2_000);
      expect(heartbeatsSeen).toBe(2);
      await baseTimer.advanceTimeAsync(2_000);
      await baseTimer.advanceTimeAsync(2_000);

      // After the single not-found answer only the latest binding is heartbeated, and the one
      // socket every other session and tool call uses was never replaced.
      expect(heartbeatsSeen).toBe(2 + 2);
      expect(clientsCreated).toBe(clientsBefore);
      expect(handovers).toEqual([]);
      // F11: nothing is kept per session for what the proxy no longer holds.
      expect(trackedBy(proxy, "livenessAcks").has("android-session")).toBe(false);
      expect(trackedBy(proxy, "sessionDeviceIds").has("android-session")).toBe(false);
      expect(trackedBy(proxy, "livenessAcks").has("ios-session")).toBe(true);
    });

    test("F6: recovery does not replace the socket beneath a tool call in flight", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      await acquire(proxy, "getApple");
      hangSessions.add("android-session");
      hangObserveFor = "ios-session";
      void proxy.callTool("observe", { sessionUuid: "ios-session" }).catch(() => {});
      const clientsBefore = clientsCreated;

      await advanceUntilHandover();

      expect(handovers).toHaveLength(1);
      expect(handovers[0].sessions.map((session) => session.sessionUuid)).toEqual([
        "android-session",
      ]);
      expect(clientsCreated).toBe(clientsBefore);
    });

    test("F6: two sessions recovering together replace the socket once, not once each", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      await acquire(proxy, "getApple");
      hangSessions.add("android-session");
      hangSessions.add("ios-session");
      const clientsBefore = clientsCreated;

      await advanceUntilHandover();

      expect(handovers).toHaveLength(1);
      expect(handovers[0].sessions).toHaveLength(2);
      expect(clientsCreated - clientsBefore).toBe(1);
    });

    test("F11: a handed-over session keeps what resuming it needs, and drops its acknowledgement", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      hangHeartbeats = Number.POSITIVE_INFINITY;
      await advanceUntilHandover();

      // The session stays resumable by UUID: its device and the pending handover are kept.
      expect(trackedBy(proxy, "sessionDeviceIds").get("android-session")).toBe("emulator-5554");
      expect(trackedBy(proxy, "stallHandovers").has("android-session")).toBe(true);
      expect(trackedBy(proxy, "livenessAcks").has("android-session")).toBe(false);
    });
  });

  describe("suspect refusal from the daemon", () => {
    test("a tool result naming the suspect code is recognised and starts an immediate re-heartbeat", async () => {
      const result = shapeSuspectResult();
      expect(declaresDeviceSessionSuspect(result)).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toMatchObject({
        code: DAEMON_SESSION_SUSPECT_CODE,
        sessionUuid: "android-session",
        remainingMs: 8_000,
      });
      // Ordinary tool failures and prose stay unrecognised.
      expect(
        declaresDeviceSessionSuspect({
          isError: true,
          content: [{ type: "text", text: "Error: boom" }],
        }),
      ).toBe(false);
      expect(declaresDeviceSessionSuspect({ content: [{ type: "text", text: "{}" }] })).toBe(false);
    });

    /** Let microtasks and the fake daemon's immediate answers run without advancing time. */
    async function drain(): Promise<void> {
      for (let turn = 0; turn < 10; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    /** Advance the fake clock in small steps until `pending` settles; returns the elapsed time. */
    async function advanceUntilSettled(pending: Promise<unknown>, limitMs = 40_000) {
      let settled = false;
      void pending.then(
        () => (settled = true),
        () => (settled = true),
      );
      const startedAt = timer.now();
      await drain();
      for (let elapsed = 0; elapsed < limitMs && !settled; elapsed += 250) {
        await baseTimer.advanceTimeAsync(250);
        await drain();
      }
      return timer.now() - startedAt;
    }

    test("a call refused as suspect is retried once after the session is restored; the harness never sees the refusal", async () => {
      const proxy = createProxy(5_000);
      await acquire(proxy, "getAndroid");
      heartbeatsSeen = 0;
      suspectObserveRefusals = 1;

      const result = await proxy.callTool("observe", { sessionUuid: "android-session" });

      expect(result).toEqual(OBSERVED);
      expect(observeCalls).toBe(2);
      expect(heartbeatsSeen).toBeGreaterThanOrEqual(1);
      expect(
        infoSpy.mock.calls.some(([message]) =>
          String(message).includes(
            "Recovered daemon_stalled for session android-session after 1 attempt(s)",
          ),
        ),
      ).toBe(true);
      expect(handovers).toEqual([]);
    });

    test("a sessionless call routed to the bound session is retried the same way", async () => {
      const proxy = createProxy(5_000);
      await acquire(proxy, "getAndroid");
      suspectObserveRefusals = 1;

      await expect(proxy.callTool("observe", {})).resolves.toEqual(OBSERVED);
      expect(observeCalls).toBe(2);
    });

    test("recovery that hands the session over surfaces the handover instead of the refusal", async () => {
      const proxy = createProxy(5_000);
      await acquire(proxy, "getAndroid");
      // Another liveness owner took the session while it was suspect: the daemon answers the
      // recovery heartbeat that this proxy's token was superseded.
      spyOn(latestClient, "callDaemonMethod").mockRejectedValueOnce(
        Object.assign(new Error("Another owner holds this session"), {
          code: DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
        }),
      );
      suspectObserveRefusals = 1;

      const call = proxy.callTool("observe", { sessionUuid: "android-session" });
      await advanceUntilSettled(call);

      await expect(call).rejects.toBeInstanceOf(DaemonSessionStalledError);
      await expect(call).rejects.toMatchObject({
        reason: "proxy_stalled",
        handover: { code: "proxy_stalled", action: "reacquire_lost_sessions" },
      });
      // The retry was answered by the proxy's own record; the daemon saw only the refused call.
      expect(observeCalls).toBe(1);
    });

    test("aborting while recovery runs rejects with the abort and never retries", async () => {
      const proxy = createProxy(5_000);
      await acquire(proxy, "getAndroid");
      hangSessions.add("android-session");
      suspectObserveRefusals = 1;
      const controller = new AbortController();
      const cancelled = new Error("cancelled by client");

      const call = proxy.callTool(
        "observe",
        { sessionUuid: "android-session" },
        undefined,
        undefined,
        controller.signal,
      );
      await drain();
      expect(observeCalls).toBe(1);
      controller.abort(cancelled);

      await expect(call).rejects.toBe(cancelled);
      await baseTimer.advanceTimeAsync(20_000);
      expect(observeCalls).toBe(1);
    });

    test("recovery still running when the reserved window plus one heartbeat timeout ends returns the refusal", async () => {
      const proxy = createProxy(5_000);
      await acquire(proxy, "getAndroid");
      hangSessions.add("android-session");
      suspectObserveRefusals = 1;

      const call = proxy.callTool("observe", { sessionUuid: "android-session" });
      const elapsedMs = await advanceUntilSettled(call);
      const result = await call;

      expect(declaresDeviceSessionSuspect(result)).toBe(true);
      expect(observeCalls).toBe(1);
      // 8 s left in the window plus the 5 s heartbeat request timeout (lease 10 s, interval 5 s).
      expect(elapsedMs).toBeGreaterThanOrEqual(13_000);
      expect(elapsedMs).toBeLessThan(13_000 + 500);
    });

    test("a refusal for a session this proxy does not hold is returned unchanged and not retried", async () => {
      const proxy = createProxy(5_000);
      await acquire(proxy, "getAndroid");
      heartbeatsSeen = 0;
      suspectObserveRefusals = 1;

      const result = await proxy.callTool("observe", { sessionUuid: "ios-session" });
      await drain();

      expect(declaresDeviceSessionSuspect(result)).toBe(true);
      expect(observeCalls).toBe(1);
      expect(heartbeatsSeen).toBe(0);
    });

    test("the proxy re-heartbeats at once a session the daemon refuses as suspect and retries only once", async () => {
      const proxy = createProxy(5_000);
      await acquire(proxy, "getAndroid");
      heartbeatsSeen = 0;
      suspectObserveRefusals = Number.POSITIVE_INFINITY;

      const result = await proxy.callTool("observe", { sessionUuid: "android-session" });
      await drain();

      // A second refusal reaches the harness unchanged: exactly one retry, never a loop.
      expect(result.isError).toBe(true);
      expect(declaresDeviceSessionSuspect(result)).toBe(true);
      expect(observeCalls).toBe(2);
      expect(heartbeatsSeen).toBeGreaterThanOrEqual(1);
      expect(
        infoSpy.mock.calls.some(([message]) =>
          String(message).includes(
            "Recovered daemon_stalled for session android-session after 1 attempt(s)",
          ),
        ),
      ).toBe(true);
      expect(handovers).toEqual([]);
    });
  });

  describe("session_recovery_pending on one stdio connection (#10508)", () => {
    /** The fault-injection lease from the device repro: recovery would spread over an hour. */
    const LONG_LEASE_MS = 3_600_000;
    /** The device is gone: the daemon answers device tools with session_recovery_pending. */
    let devicePending: boolean;
    /** The daemon drops the socket under the next device tool call before it is dispatched. */
    let droppedSocketCalls: number;
    /** Heartbeats wait for their socket's close to be noticed instead of answering. */
    let parkHeartbeats: boolean;
    /** Parked heartbeats fail once a reconnect probes the daemon: the old socket's close lands late. */
    const parked = new Set<(error: Error) => void>();
    let tapCalls: number;

    function pendingResult(sessionUuid: string) {
      return shapeToolCallError(
        new SessionRecoveryAssignmentError({
          sessionUuid,
          platform: "android",
          deviceId: "emulator-5554",
          stableDeviceId: "emulator-5554",
          recoveryWindowRemainingMs: 167_000,
        }),
        { toolName: "observe", source: "ProxyServer" },
      );
    }

    function deviceToolResult(name: string, params: Record<string, any>) {
      if (name === "tapOn") {
        tapCalls += 1;
      }
      if (droppedSocketCalls > 0) {
        droppedSocketCalls -= 1;
        throw new DaemonRequestNotDeliveredError("Socket connection closed");
      }
      return devicePending ? pendingResult(String(params.sessionUuid)) : OBSERVED;
    }

    function stdioDaemonClient(): FakeDaemonClient {
      const client = daemonBackedClient();
      const callTool = client.callTool.bind(client);
      spyOn(client, "callTool").mockImplementation(async (name, params, ...rest) =>
        name === "tapOn" || name === "observe"
          ? deviceToolResult(name, params)
          : callTool(name, params, ...rest),
      );
      const callDaemonMethod = client.callDaemonMethod.bind(client);
      spyOn(client, "callDaemonMethod").mockImplementation(async (method, params) => {
        if (method === "daemon/heartbeat" && parkHeartbeats) {
          await new Promise<never>((_resolve, reject) => parked.add(reject));
        }
        return callDaemonMethod(method, params);
      });
      return client;
    }

    function stdioProxy(): DaemonMcpProxy {
      const proxy = new DaemonMcpProxy({
        clientFactory: () => {
          clientsCreated += 1;
          latestClient = stdioDaemonClient();
          return latestClient;
        },
        daemonManager,
        autoStartDaemon: false,
        timer,
        idGenerator: new FakeIdGenerator(["proxy-token"]),
        heartbeatTimeoutMs: LONG_LEASE_MS,
        heartbeatIntervalMs: 2_000,
      });
      proxy.onLivenessHandover((handover) => handovers.push(handover));
      proxies.push(proxy);
      return proxy;
    }

    async function drain(): Promise<void> {
      for (let turn = 0; turn < 10; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    /** Advance the fake clock until `pending` settles; returns the elapsed time, or -1. */
    async function advanceUntilSettled(pending: Promise<unknown>, limitMs = 60_000) {
      let settled = false;
      void pending.then(
        () => (settled = true),
        () => (settled = true),
      );
      const startedAt = timer.now();
      await drain();
      for (let elapsed = 0; elapsed < limitMs && !settled; elapsed += 1_000) {
        await baseTimer.advanceTimeAsync(1_000);
        await drain();
      }
      return settled ? timer.now() - startedAt : -1;
    }

    function errorCode(result: any): unknown {
      return JSON.parse(result.content[0].text).error?.code;
    }

    function warned(fragment: string): boolean {
      return warnSpy.mock.calls.some(([message]) => String(message).includes(fragment));
    }

    /** The emulator returns: the daemon resumes the same session and answers device tools. */
    async function deviceReturns(): Promise<void> {
      devicePending = false;
      parkHeartbeats = false;
      hangSessions.clear();
      await sessionManager.createSession(
        "android-session",
        "emulator-5554",
        "android",
        60_000,
        LONG_LEASE_MS,
      );
    }

    beforeEach(() => {
      isAvailableSpy.mockImplementation(async () => {
        for (const reject of parked) {
          reject(new DaemonUnavailableError("Socket connection closed"));
        }
        parked.clear();
        return true;
      });
      devicePending = false;
      droppedSocketCalls = 0;
      parkHeartbeats = false;
      tapCalls = 0;
    });

    test("a heartbeat that meets the call's reconnect starts no recovery, so the next call is forwarded", async () => {
      const proxy = stdioProxy();
      await acquire(proxy, "getAndroid");
      // The emulator is killed: the daemon drops the live session into its recovery window.
      devicePending = true;
      await sessionManager.releaseSession("android-session", "device-lost");
      // A heartbeat is in flight when the socket drops under the call. The call reconnects first,
      // and the heartbeat's retry then meets that reconnect, which may manage the daemon's
      // lifecycle and so cannot be joined by observation-only liveness work.
      parkHeartbeats = true;
      await baseTimer.advanceTimeAsync(2_000);
      parkHeartbeats = false;
      droppedSocketCalls = 1;

      const observed = proxy.callTool("observe", {});
      expect(await advanceUntilSettled(observed)).toBeGreaterThanOrEqual(0);
      expect(errorCode(await observed)).toBe("session_recovery_pending");
      expect(warned("Daemon session is stale")).toBe(true);
      expect(warned("starting recovery")).toBe(false);

      const tap = proxy.callTool("tapOn", {});
      expect(await advanceUntilSettled(tap)).toBe(0);
      expect(errorCode(await tap)).toBe("session_recovery_pending");
      expect(tapCalls).toBe(1);

      await deviceReturns();
      await expect(proxy.callTool("observe", {})).resolves.toEqual(OBSERVED);
      expect(handovers).toEqual([]);
    });

    test("a call during recovery is forwarded within the bound and the connection works after the device returns", async () => {
      const proxy = stdioProxy();
      await acquire(proxy, "getAndroid");
      devicePending = true;
      // The daemon stops acknowledging: recovery starts, and with this lease its next attempt is
      // about twenty minutes away.
      hangSessions.add("android-session");
      await baseTimer.advanceTimeAsync(8_000);
      expect(warned("starting recovery")).toBe(true);

      const tap = proxy.callTool("tapOn", {});
      const elapsedMs = await advanceUntilSettled(tap);
      const boundMs = livenessRecoveryCallWaitMs(LONG_LEASE_MS, 4_000);
      expect(boundMs).toBe(24_000);
      expect(elapsedMs).toBeGreaterThanOrEqual(boundMs - 1_000);
      expect(elapsedMs).toBeLessThanOrEqual(boundMs + 1_000);
      expect(errorCode(await tap)).toBe("session_recovery_pending");
      expect(tapCalls).toBe(1);

      await deviceReturns();
      const observe = proxy.callTool("observe", {});
      expect(await advanceUntilSettled(observe)).toBeLessThanOrEqual(boundMs + 1_000);
      await expect(observe).resolves.toEqual(OBSERVED);
    });

    test("the bound never exceeds the liveness budget recovery itself fits in", () => {
      expect(livenessRecoveryCallWaitMs(LEASE_MS, 4_000)).toBe(LEASE_MS + SUSPECT_GRACE_MS);
      expect(livenessRecoveryCallWaitMs(LONG_LEASE_MS, 4_000)).toBe(
        LIVENESS_RECOVERY_ATTEMPTS * 2 * 4_000,
      );
    });
  });
});
