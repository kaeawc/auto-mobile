/**
 * H4 reproduction, daemon side: the desktop app keeps its per-run session UUID bound to the
 * device it was last focused on, and its unconditional 2 s heartbeat keeps that binding alive
 * for as long as the app stays open — after the user has closed the focused column. An agent's
 * exact-device request is refused with "already assigned", while the desktop shows no binding.
 *
 * The test replays the exact wire frames the Kotlin desktop client sends, through the REAL
 * daemon handlers:
 *
 *  1. Startup with nothing focused — `daemon/registerSession {sessionId: D, clientName}`
 *     (DesktopDaemonSessionComposition.kt:128-129 -> DesktopSessionRegistration.kt:15-19 ->
 *     DesktopDaemonSession.kt:17-23 -> McpDaemonClient.kt:832-840).
 *  2. Focus a pane — `tools/call setActiveDevice {deviceId, platform, sessionUuid: D,
 *     __autoMobileOwnedSessionUuids: [D]}` (DesktopDaemonSessionComposition.kt:130-133 ->
 *     McpDaemonClient.kt:274-282, sessionUuid appended at :766-772, owned-UUID list seeded with D
 *     at :106-107 and appended at :776-787). The socket server first runs
 *     `restoreOwnedDeviceSessionsForMcpSession` (socketServer.ts:1934-1935, :2630-2645), then
 *     strips the owned list and injects `__mcpSessionId` (socketServer.ts:6976-6996), and the
 *     one-request socket closes afterwards (McpDaemonClient.kt:1036 opens a socket per request ->
 *     socketServer.ts:1499 `releaseMcpSessionBindings`).
 *  3. Every 2 s — `daemon/heartbeat {sessionId: D}`, tokenless, no livenessPolicy
 *     (DesktopDaemonSessionComposition.kt:162-165 -> DesktopSessionRegistration.kt:26-28 ->
 *     McpDaemonClient.kt:855-863), dispatched out-of-band to `handleDaemonRequest`
 *     (socketServer.ts:1876-1882).
 *  4. Unfocus (binding.value = null) — NO frame: the effect restarts, `ensureRegistered()` is a
 *     no-op because `deviceBound()` already set ready=true (DesktopSessionRegistration.kt:15-24),
 *     and the loop keeps sending frame 3 (DesktopDaemonSessionComposition.kt:123-176). Release
 *     happens only on composition dispose (DesktopDaemonSessionComposition.kt:91-105).
 *
 * The client half is pinned by
 * android/desktop-core/src/test/kotlin/.../daemon/DesktopDaemonSessionUnfocusHoldTest.kt.
 *
 * REAL: DaemonState (the object the socket server hands to handleDaemonRequest,
 * socketServer.ts:974), handleDaemonRequest (registerSession + heartbeat handlers),
 * createSetActiveDeviceHandler, DevicePool (bind, owned-session restore, socket-close
 * bookkeeping, owner-disconnect release), SessionManager (heartbeat, idle expiry, release),
 * ObserverSessionRegistry, SessionHeartbeatMonitor (driven by tick() at its 10 s production
 * cadence), releaseSessionAndDevice (the monitor's production reap helper, daemon.ts:3458).
 * FAKE: FakeTimer, FakeDeviceSessionPersistence, FakeDbWriteBarrier, FakeDeviceUtils (adb
 * discovery), the setActiveDevice `resumeCtrlProxy` dependency (no CtrlProxy), and the socket
 * server's per-request calls (restore / close) which are invoked by hand in the order cited above.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { DaemonRequest } from "../../src/daemon/types";
import type { BootedDevice } from "../../src/models";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

/** The desktop's per-run UUID (DesktopDaemonSession.kt:63-67 mints one per app run). */
const DESKTOP = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const PIXEL: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const FOLD: BootedDevice = { deviceId: "emulator-5556", name: "Fold", platform: "android" };
/** DesktopDaemonSessionComposition.kt:28. */
const DESKTOP_HEARTBEAT_INTERVAL_MS = 2_000;
/** SessionHeartbeatMonitor's production scan interval (DEFAULT_CHECK_INTERVAL_MS). */
const MONITOR_INTERVAL_MS = 10_000;
/** SessionManager.SESSION_TIMEOUT_MS: the idle expiry a heartbeat re-stamps. */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

describe("H4: desktop session stays bound to the last-focused device after unfocus", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let pool: DevicePool;
  let monitor: SessionHeartbeatMonitor;
  let reaped: string[];
  let socketSeq: number;
  const setActiveDevice = createSetActiveDeviceHandler({ resumeCtrlProxy: async () => {} });

  const frame = (method: string, params: Record<string, unknown>) =>
    handleDaemonRequest(
      { id: `${method}-${timer.now()}`, type: "mcp_request", method, params } as DaemonRequest,
      DaemonState.getInstance(),
    );
  /** One desktop `tools/call setActiveDevice`, on its own short-lived socket. */
  const desktopSetActiveDevice = async (sessionUuid: string, device: BootedDevice) => {
    const socket = `socket-${++socketSeq}`;
    await pool.restoreOwnedDeviceSessionsForMcpSession([sessionUuid], socket);
    try {
      return await setActiveDevice({
        deviceId: device.deviceId,
        platform: "android",
        sessionUuid,
        __mcpSessionId: socket,
      });
    } finally {
      pool.releaseMcpSessionBindings(socket);
    }
  };
  /** Advance by one heartbeat interval; heartbeat each listed session; monitor at its cadence. */
  const heartbeatTick = async (...heartbeating: string[]) => {
    timer.advanceTime(DESKTOP_HEARTBEAT_INTERVAL_MS);
    for (const sessionId of heartbeating) {
      expect(await frame("daemon/heartbeat", { sessionId })).toEqual({
        success: true,
        result: { sessionId },
      });
    }
    if (timer.now() % MONITOR_INTERVAL_MS === 0) {
      await monitor.tick();
    }
  };

  beforeEach(async () => {
    timer = new FakeTimer();
    sessions = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices("android", [PIXEL, FOLD]);
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "h4-daemon", { timer, deviceManager: utils }),
    );
    await pool.initializeWithDevices([PIXEL, FOLD]);
    DaemonState.getInstance().initialize(
      sessions,
      pool,
      new DeviceSessionRegistry(),
      new ObserverSessionRegistry(timer, 10_000),
    );
    reaped = [];
    socketSeq = 0;
    monitor = new SessionHeartbeatMonitor(
      sessions,
      () => false,
      async (sessionId, reason) => {
        reaped.push(`${sessionId}:${reason}`);
        const assigned = sessions.getSession(sessionId)?.assignedDevice ?? null;
        await releaseSessionAndDevice(sessions, pool, assigned, sessionId, reason);
      },
      timer,
    );

    // Frame 1: the app starts on the home grid (no focused pane).
    expect(
      await frame("daemon/registerSession", {
        sessionId: DESKTOP,
        clientName: "AutoMobile Desktop",
      }),
    ).toMatchObject({ success: true, result: { accepted: true } });
    await heartbeatTick(DESKTOP);
    // Frame 2: the user focuses a pane on the Pixel.
    await desktopSetActiveDevice(DESKTOP, PIXEL);
    expect(pool.getDevice(PIXEL.deviceId)).toMatchObject({ status: "busy", sessionId: DESKTOP });
    expect(DaemonState.getInstance().getObserverSessionRegistry()?.list()).toEqual([]);
    for (let i = 0; i < 3; i++) {
      await heartbeatTick(DESKTOP);
    }
  });

  afterEach(async () => {
    await monitor.stop();
    sessions.stopCleanupTimer();
    DaemonState.getInstance().reset();
  });

  test("unfocused desktop keeps heartbeating its UUID and holds the Pixel past the idle expiry", async () => {
    // Unfocus: the desktop sends no frame; only frame 3 continues. 65 virtual minutes, which
    // exceeds the 30-minute idle expiry, the 10 s heartbeat timeout and the 10 s owner-disconnect grace.
    const unfocusedAt = timer.now();
    while (timer.now() - unfocusedAt < 65 * 60 * 1000) {
      await heartbeatTick(DESKTOP);
    }

    // CURRENT behaviour (H4): nothing ever reaps or releases the desktop session.
    expect(reaped).toEqual([]);
    expect(sessions.getSession(DESKTOP)?.assignedDevice).toBe(PIXEL.deviceId);
    expect(sessions.getSession(DESKTOP)!.expiresAt).toBeGreaterThan(
      unfocusedAt + SESSION_IDLE_TIMEOUT_MS,
    );
    expect(pool.getDevice(PIXEL.deviceId)).toMatchObject({ status: "busy", sessionId: DESKTOP });
    // An agent that asks for the Pixel by id is refused for the desktop's invisible hold.
    await expect(desktopSetActiveDevice(AGENT, PIXEL)).rejects.toThrow(
      `Device '${PIXEL.deviceId}' is already assigned to session ${DESKTOP}`,
    );

    // AFTER A FIX (the client sends a NON-terminal unbind on a null target and keeps heartbeating
    // only as an observer), this test should assert:
    //   expect(pool.getDevice(PIXEL.deviceId)).toMatchObject({ status: "idle", sessionId: null });
    //   expect(sessions.getSession(DESKTOP)).toBeNull();
    //   expect(registry.list().map((entry) => entry.sessionId)).toEqual([DESKTOP]);
    //   await expect(desktopSetActiveDevice(AGENT, PIXEL)).resolves.toBeDefined();
    // and a later refocus by DESKTOP on a free device must still bind. A plain
    // `daemon/releaseSession` is NOT that fix: it makes DESKTOP terminal, so the next
    // setActiveDevice fails with "was released and cannot be reused".
  });

  test("control: if heartbeats stop on unfocus (pre-#8911 early return) the Pixel is freed", async () => {
    // Old composition returned from the effect on a null target, so frame 3 stopped.
    for (let i = 0; i < 15; i++) {
      await heartbeatTick();
    }

    expect(reaped).toEqual([`${DESKTOP}:heartbeat-timeout`]);
    expect(sessions.getSession(DESKTOP)).toBeNull();
    expect(pool.getDevice(PIXEL.deviceId)).toMatchObject({ status: "idle", sessionId: null });
    await expect(desktopSetActiveDevice(AGENT, PIXEL)).resolves.toBeDefined();
    expect(pool.getDevice(PIXEL.deviceId)).toMatchObject({ status: "busy", sessionId: AGENT });
  });

  test("sub-case: focusing a device another session owns is refused, yet the Pixel stays held", async () => {
    // An agent owns the Fold and keeps its own session alive.
    await desktopSetActiveDevice(AGENT, FOLD);
    await heartbeatTick(DESKTOP, AGENT);

    // The user focuses the Fold. The bind is refused; the desktop turns the isError result into
    // SetActiveDeviceResult(success = false) (AutoMobileClient.kt:529-531, McpDaemonClient.kt:283-287),
    // still calls deviceBound() and heartbeats (DesktopDaemonSessionComposition.kt:131-133,162-165),
    // then re-sends the bind each tick because bindingAcknowledged stays false.
    for (let i = 0; i < 150; i++) {
      await expect(desktopSetActiveDevice(DESKTOP, FOLD)).rejects.toThrow(
        `Device '${FOLD.deviceId}' is already assigned to session ${AGENT}`,
      );
      await heartbeatTick(DESKTOP, AGENT);
    }

    // CURRENT behaviour: five minutes later the desktop still holds the Pixel it is not showing.
    expect(reaped).toEqual([]);
    expect(pool.getDevice(PIXEL.deviceId)).toMatchObject({ status: "busy", sessionId: DESKTOP });
    expect(pool.getDevice(FOLD.deviceId)).toMatchObject({ status: "busy", sessionId: AGENT });
    // AFTER A FIX: a refused focus change must not keep the previous device bound, i.e.
    //   expect(pool.getDevice(PIXEL.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  });
});
