import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { z } from "zod/v4";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import {
  DAEMON_HEARTBEAT_METHOD,
  HEARTBEAT_SESSION_LIVENESS_POLICY,
  INTERNAL_EXECUTION_ID_PARAM,
} from "../../src/daemon/constants";
import type { DevicePool } from "../../src/daemon/devicePool";
import { OWNER_DISCONNECT_GRACE_MS } from "../../src/daemon/ownerDisconnectRelease";
import type { SessionManager } from "../../src/daemon/sessionManager";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import type { BootedDevice } from "../../src/models";
import { executionTracker } from "../../src/server/executionTracker";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { logger } from "../../src/utils/logger";
import type { Timer } from "../../src/utils/SystemTimer";
import { AdmittingAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeFeatureFlagApplier } from "../fakes/FakeFeatureFlagApplier";
import { FakeFeatureFlagRepository } from "../fakes/FakeFeatureFlagRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";

/**
 * H10 reproduction: an execution that was cancelled but never settles vetoes every
 * automatic release path for its session, with no ceiling, and the one-shot
 * owner-disconnect release (#10503/#10504) is consumed by that veto and never re-armed.
 *
 * Real production code driven here:
 * - `Daemon` constructor wiring: `SessionManager.setActiveSessionExecutionChecker`
 *   and the pool's `ownerDisconnect.release` port both call the private
 *   `Daemon.hasActiveSessionExecution` (daemon.ts:645-653, 712-714, 2511-2525).
 * - `Daemon.startHeartbeatMonitor` -> real `SessionHeartbeatMonitor` whose reap is
 *   the daemon's own `cancelAndReleaseSession` (daemon.ts:2440-2449).
 * - `DevicePool.bindOrReuseDeviceSession` with an owning MCP connection, then
 *   `DevicePool.releaseMcpSessionBindings` (the socket-close hook,
 *   socketServer.ts:1499/2670) -> real `OwnerDisconnectRelease` (ownerDisconnectRelease.ts).
 * - `handleDaemonRequest` for `daemon/heartbeat` (the owner's liveness claim and
 *   keeper tick) and `daemon/activeSessions` (the field diagnostic).
 * - `createMcpServer`'s real `tools/call` wrapper (server/index.ts:1253-1297,
 *   1700-1705) registering the execution in the real `executionTracker` singleton,
 *   and the MCP SDK's `notifications/cancelled` path aborting the handler signal.
 * - `SessionManager`'s own 5-min cleanup sweep and `isSessionExpired`, on the FakeTimer.
 *
 * Faked: the clock (FakeTimer), session persistence (FakeDeviceSessionRepository),
 * installed-apps store, pool discovery (FakeDeviceManager), the Unix-socket hop (an
 * in-memory MCP transport; the socket close is emulated with the exact two calls
 * `UnixSocketServer.releaseSocketSession` makes: abort the forwarded request and
 * `releaseMcpSessionBindings`), and the hung stage itself: a test tool whose
 * handler ignores its AbortSignal and only settles when the test says so.
 */

const DEVICE: BootedDevice = {
  name: "Pixel_8_API_35",
  platform: "android",
  deviceId: "emulator-5554",
};
const OWNER_SESSION = "agent-session-uuid";
const OWNER_CONNECTION = "agent-proxy-socket";
const OWNER_LIVENESS_TOKEN = "agent-proxy-liveness-token";
const OTHER_CONNECTION = "studio-socket";
const HUNG_TOOL = "__h10_abort_ignoring_device_call__";
const MONITOR_INTERVAL_MS = 10_000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const REFUSAL = "already assigned to another session";

describe("H10: an unsettled execution vetoes every automatic release of its session", () => {
  let timer: FakeTimer;
  let repository: FakeDeviceSessionRepository;
  let daemon: Daemon;
  let sessionManager: SessionManager;
  let devicePool: DevicePool;
  let fixture: McpTestFixture;
  let restoreServer: () => void;
  let infoSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let releaseReasons: string[];
  let handlerGate: PromiseWithResolvers<void>;
  let handlerStarted: PromiseWithResolvers<void>;
  let handlerSignal: AbortSignal | undefined;
  let handlerExecutionId: string | undefined;
  let clientCall: AbortController;
  let callOutcome: Promise<unknown>;
  let baselineExecutions: number;
  let previousTrackerTimer: Timer;

  const bind = (sessionId: string, mcpSessionId: string) =>
    devicePool.bindOrReuseDeviceSession(
      sessionId,
      DEVICE.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      mcpSessionId,
    );

  const daemonRequest = (method: string, params: Record<string, unknown>) =>
    handleDaemonRequest(
      { id: `${method}-${timer.now()}`, type: "daemon_request", method, params },
      DaemonState.getInstance(),
    );

  /** The proxy's own heartbeat params (daemonMcpProxy.ts:4055-4077). */
  const ownerHeartbeat = (claimLivenessOwnership: boolean) =>
    daemonRequest(DAEMON_HEARTBEAT_METHOD, {
      sessionId: OWNER_SESSION,
      livenessPolicy: HEARTBEAT_SESSION_LIVENESS_POLICY,
      livenessOwnerToken: OWNER_LIVENESS_TOKEN,
      ...(claimLivenessOwnership ? { claimLivenessOwnership: true } : {}),
    });

  const ownerDisconnectRelease = () => devicePool["ownerDisconnectRelease"];
  const infoLines = (fragment: string) =>
    infoSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((line: string) => line.includes(fragment));
  /** daemon.ts:649-651, logged when the owner-disconnect release is vetoed. */
  const keptLogLines = () =>
    infoLines(`Kept session ${OWNER_SESSION} after its owner disconnected`);

  /** Step fake time one monitor interval at a time so no tick ever looks like a daemon stall. */
  const holdFor = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += MONITOR_INTERVAL_MS) {
      await timer.advanceTimeAsync(MONITOR_INTERVAL_MS, () => drainMicrotasks(4));
    }
  };

  /**
   * The agent (owner) issues one device call through the daemon's MCP server. The
   * daemon's socket forward injects `__mcpSessionId` (socketServer.ts:6952-6970)
   * and the proxy injects its bound `sessionUuid`.
   */
  const startHungCall = async () => {
    clientCall = new AbortController();
    callOutcome = fixture.client
      .request(
        {
          method: "tools/call",
          params: {
            name: HUNG_TOOL,
            arguments: { sessionUuid: OWNER_SESSION, __mcpSessionId: OWNER_CONNECTION },
          },
        },
        z.any(),
        { signal: clientCall.signal },
      )
      .then(
        (result) => result,
        (error: unknown) => error,
      );
    await handlerStarted.promise;
  };

  /** Exactly what UnixSocketServer.releaseSocketSession does on close (socketServer.ts:1484-1499). */
  const ownerSocketCloses = async () => {
    clientCall.abort(new Error("Daemon MCP client disconnected"));
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);
    await drainUntil(() => handlerSignal?.aborted === true, {
      description: "the MCP cancellation to reach the hung handler's signal",
    });
  };

  let previousFeatureFlags: FeatureFlagService | null;
  let previousAppearanceSync: string | undefined;

  beforeAll(async () => {
    // createMcpServer initializes the FeatureFlagService singleton; back it with a
    // fake so no test path resolves the real file-backed DB (#3067).
    previousFeatureFlags = FeatureFlagService["instance"];
    FeatureFlagService["instance"] = new FeatureFlagService(
      new FakeFeatureFlagRepository(),
      new FakeFeatureFlagApplier(),
    );
    // Pay one-time costs (MCP server module load and first construction ~130 ms, first
    // Daemon, first tools/call) outside the timed tests by running the scenario once.
    await setUpScenario();
    try {
      await startHungCall();
    } finally {
      await tearDownScenario();
    }
  });

  afterAll(() => {
    FeatureFlagService["instance"] = previousFeatureFlags;
  });

  async function setUpScenario(): Promise<void> {
    resetDbWriteBarrier();
    restoreServer = installHermeticServerFixture();
    infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    handlerGate = Promise.withResolvers<void>();
    handlerStarted = Promise.withResolvers<void>();
    handlerSignal = undefined;
    handlerExecutionId = undefined;
    callOutcome = Promise.resolve();
    // A device stage that ignores its AbortSignal: it binds the serial to an adb client
    // the way every Android stage does (the real AdmittingAdbClientFactory: pool
    // admission gate + ambient execution binding), then never observes cancellation
    // and settles only when the test opens the gate.
    const deviceStageAdb = new AdmittingAdbClientFactory(new FakeAdbClientFactory());
    ToolRegistry.register(
      HUNG_TOOL,
      "H10 probe: a device call whose stage ignores abort",
      z.object({}),
      async (args: Record<string, unknown>, _progress?: unknown, signal?: AbortSignal) => {
        handlerSignal = signal;
        handlerExecutionId = args[INTERNAL_EXECUTION_ID_PARAM] as string | undefined;
        deviceStageAdb.create(DEVICE);
        handlerStarted.resolve();
        await handlerGate.promise;
        return { content: [{ type: "text" as const, text: "finally settled" }] };
      },
    );

    // Passive appearance sync on session creation reads the DB; it is unrelated to H10.
    previousAppearanceSync = process.env.AUTOMOBILE_APPEARANCE_SYNC;
    process.env.AUTOMOBILE_APPEARANCE_SYNC = "0";
    timer = new FakeTimer();
    // One clock, as in production: the process-wide tracker stamps execution start
    // times that SessionManager compares against session deadlines (sessionManager.ts:5913-5921).
    previousTrackerTimer = executionTracker["timer"];
    executionTracker["timer"] = timer;
    repository = new FakeDeviceSessionRepository();
    daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, repository);
    sessionManager = daemon.getSessionManager();
    devicePool = daemon.getDevicePool();
    const deviceManager = new FakeDeviceManager();
    deviceManager.bootedDevices = [DEVICE];
    Object.assign(devicePool, { deviceManager });
    releaseReasons = [];
    sessionManager.onSessionRelease((_sessionId, _deviceId, reason) => {
      releaseReasons.push(reason);
    });
    await devicePool.initializeWithDevices([DEVICE]);
    await devicePool.reconcileDiscoveryObservation([DEVICE], "test:initial");
    daemon["startHeartbeatMonitor"]();

    fixture = new McpTestFixture({
      daemonMode: true,
      sessionContext: { sessionId: "daemon-loopback-transport" },
    });
    await fixture.setup();
    baselineExecutions = executionTracker.getActiveExecutionCount();

    // The agent acquires the device on its own socket and its proxy claims liveness.
    await bind(OWNER_SESSION, OWNER_CONNECTION);
    expect((await ownerHeartbeat(true)).success).toBe(true);
    timer.advanceTime(2_000);
    expect((await ownerHeartbeat(false)).success).toBe(true);
    timer.advanceTime(1_000);
  }

  async function tearDownScenario(): Promise<void> {
    handlerGate.resolve();
    await drainMicrotasks(50);
    if (handlerExecutionId) {
      // Belt and braces: never leak an execution into the process-wide tracker.
      executionTracker.endExecution(handlerExecutionId);
    }
    await callOutcome;
    await daemon["heartbeatMonitor"]?.stop();
    sessionManager.stopCleanupTimer();
    await fixture.teardown();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    if (previousAppearanceSync === undefined) {
      delete process.env.AUTOMOBILE_APPEARANCE_SYNC;
    } else {
      process.env.AUTOMOBILE_APPEARANCE_SYNC = previousAppearanceSync;
    }
    executionTracker["timer"] = previousTrackerTimer;
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    restoreServer();
    resetDbWriteBarrier();
  }

  beforeEach(setUpScenario);
  afterEach(tearDownScenario);

  test("a cancelled-but-unsettled call holds the departed owner's device for hours", async () => {
    await startHungCall();
    expect(executionTracker.hasActiveSessionUuidExecutions(OWNER_SESSION)).toBe(true);
    expect(executionTracker.getActiveDeviceExecutionCount(DEVICE.deviceId)).toBe(1);

    // The agent quits: its socket closes, the forward is aborted and the SDK cancels
    // the request, so the handler's signal is aborted -- but the handler never settles.
    await ownerSocketCloses();
    expect(ownerDisconnectRelease().isPending(OWNER_SESSION)).toBe(true);
    // Only the SDK request half of the handler's combined signal aborted; the tracker's
    // own controller did not, so nothing tracker-side knows this call's client is gone.
    const tracked = executionTracker["executions"].get(handlerExecutionId ?? "");
    expect(tracked?.abortController.signal.aborted).toBe(false);

    // The 10 s owner-disconnect release fires once and is vetoed by the execution.
    await holdFor(OWNER_DISCONNECT_GRACE_MS);
    expect(keptLogLines()).toHaveLength(1);
    expect(ownerDisconnectRelease().isPending(OWNER_SESSION)).toBe(false);

    // Two hours: past the 10 s lease + 10 s suspect grace, the 30 min idle expiry,
    // 24 SessionManager cleanup sweeps and 720 heartbeat-monitor ticks.
    await holdFor(TWO_HOURS_MS);

    // CURRENT (buggy) behavior: nothing released the session or the device.
    expect(handlerSignal?.aborted).toBe(true);
    expect(sessionManager.getSession(OWNER_SESSION)).not.toBeNull();
    expect(sessionManager.getAssignedDevices().has(DEVICE.deviceId)).toBe(true);
    expect(devicePool.getDevice(DEVICE.deviceId)?.sessionId).toBe(OWNER_SESSION);
    expect(releaseReasons).toEqual([]);
    expect(repository.released).toEqual([]);
    expect(keptLogLines()).toHaveLength(1);
    // The call is still bound to the device (this also keeps the device's CtrlProxy
    // lease busy: deviceLeaseActivity.ts:95-101).
    expect(executionTracker.getActiveDeviceExecutionCount(DEVICE.deviceId)).toBe(1);
    // Any other client (e.g. the studio) is locked out of the device.
    await expect(bind("studio-session", OTHER_CONNECTION)).rejects.toThrow(REFUSAL);
    // The field diagnostic the hypothesis asks users for: activeExecutions > 0 while idle.
    const active = await daemonRequest("daemon/activeSessions", {});
    expect(active.result).toMatchObject({
      activeSessions: 1,
      activeExecutions: baselineExecutions + 1,
    });

    // AFTER A FIX: a cancelled execution stops vetoing release after a bounded settle
    // grace (e.g. request deadline + SUSPECT_GRACE_MS), so by now:
    //   expect(sessionManager.getSession(OWNER_SESSION)).toBeNull();
    //   expect(devicePool.getDevice(DEVICE.deviceId)?.sessionId).toBeNull();
    //   expect(releaseReasons).toEqual(["owner-disconnected"]);
    //   await expect(bind("studio-session", OTHER_CONNECTION)).resolves.toBe("studio-session");
  });

  test("the vetoed owner-disconnect release is never re-armed; the hold ends only when the call settles", async () => {
    await startHungCall();
    await ownerSocketCloses();
    await holdFor(OWNER_DISCONNECT_GRACE_MS + TWO_HOURS_MS);
    expect(sessionManager.getSession(OWNER_SESSION)).not.toBeNull();

    // The hung stage finally returns: the real tools/call finally ends the execution.
    handlerGate.resolve();
    await drainUntil(() => !executionTracker.hasActiveSessionUuidExecutions(OWNER_SESSION), {
      description: "the settled handler's finally to end its execution",
    });
    await callOutcome;

    // CURRENT behavior: draining the veto does not re-arm the one-shot release.
    // (`hasSession` reads the raw map; `getSession` would itself lazily expire it.)
    expect(ownerDisconnectRelease().isPending(OWNER_SESSION)).toBe(false);
    expect(sessionManager.hasSession(OWNER_SESSION)).toBe(true);
    expect(releaseReasons).toEqual([]);

    // The very next monitor tick's expiry sweep (cleanupExpiredSessions, now that the
    // veto has lifted) frees it on its long-lapsed lease instead: the hold lasted
    // exactly as long as the hung call.
    await holdFor(MONITOR_INTERVAL_MS);
    await drainUntil(() => devicePool.getDevice(DEVICE.deviceId)?.sessionId === null, {
      description: "the heartbeat monitor to free the device",
    });
    expect(sessionManager.getSession(OWNER_SESSION)).toBeNull();
    expect(infoLines(`Cleaning up 1 expired sessions: ${OWNER_SESSION}`)).toHaveLength(1);
    expect(releaseReasons).toEqual(["heartbeat-timeout"]);
    expect(keptLogLines()).toHaveLength(1);

    // AFTER A FIX: the owner-disconnect release is retried once executions drain (or the
    // veto is bounded), so it -- not the lease reaper two hours later -- frees the device:
    //   expect(releaseReasons).toEqual(["owner-disconnected"]);
    // and the device is idle long before the hung call settles (see the first test).
  });
});
