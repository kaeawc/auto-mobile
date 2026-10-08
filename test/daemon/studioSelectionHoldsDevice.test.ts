import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, drainUntilQuiescent } from "../helpers/fakeTimerStepping";

/*
 * Hypothesis H5 ("studio selection is allocation"), daemon side.
 *
 * The IDE tool window auto-selects the first booted device with no click
 * (android/desktop-core/.../AutoMobileContent.kt:1032-1036), turns that
 * selection into a session binding (:840-858), and rememberDesktopDaemonSession
 * re-sends setActiveDevice on EVERY loop pass until it is acknowledged
 * (DesktopDaemonSessionComposition.kt:122-133). A refusal is decoded to
 * SetActiveDeviceResult(success=false) rather than thrown (McpDaemonClient.kt:274-288,
 * AutoMobileClient.kt:520-533), so the loop keeps knocking every 2 s
 * (HEARTBEAT_INTERVAL_MS, DesktopDaemonSessionComposition.kt:28, :163).
 *
 * This suite replays that exact frame sequence against the REAL daemon pieces —
 * handleDaemonRequest (daemon/registerSession, daemon/heartbeat,
 * daemon/releaseSession), the real setActiveDevice tool handler, the real
 * SessionManager/DevicePool/ObserverSessionRegistry, and the real
 * SessionHeartbeatMonitor reaper on a FakeTimer — and shows:
 *   1. while an agent owns D, every studio bind is refused (no hold yet);
 *   2. within ONE 2 s loop pass of the agent's session ending, the studio's
 *      retry binds D to the studio's own UUID;
 *   3. the studio's tokenless 2 s heartbeat then keeps D assigned for hours
 *      with zero tool calls, past every idle sweep; and
 *   4. the next agent's request for D is refused.
 *
 * Frames are built exactly as the Kotlin client builds them; each builder cites
 * its Kotlin source. The Kotlin loop itself is driven for real in
 * android/desktop-core/src/test/.../daemon/StudioSelectionGrabsReleasedDeviceTest.kt.
 */

const DEVICE = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
// DesktopDaemonSession.create mints UUID.randomUUID() (DesktopDaemonSession.kt:64);
// daemon/registerSession validates it as a UUID (daemonRequestHandlers.ts registerSessionParams).
const STUDIO = "5d1f0c7e-4a43-4f7a-9d0e-3c0a2b9f6a11";
const AGENT = "agent-session-1";
const NEXT_AGENT = "agent-session-2";
const AGENT_OWNER_TOKEN = "agent-proxy-owner-token";
const STUDIO_LOOP_MS = 2_000; // DesktopDaemonSessionComposition.kt:28
const ONE_HOUR_MS = 60 * 60 * 1_000; // two of SessionManager's 30-minute idle windows

let frameSeq = 0;
function frame(method: string, params: Record<string, unknown>) {
  return { id: `f-${++frameSeq}`, type: "mcp_request" as const, method, params };
}

/** Real setActiveDevice tool handler; CtrlProxy resume is the only stubbed dependency. */
const setActiveDeviceTool = createSetActiveDeviceHandler({ resumeCtrlProxy: async () => {} });

/**
 * `tools/call setActiveDevice` exactly as McpDaemonClient sends it: the tool args
 * (McpDaemonClient.kt:274-282) plus the client's own `sessionUuid` and owned-session
 * list injected by callTool (McpDaemonClient.kt:764-788). A thrown tool error is
 * shaped by the real shapeToolCallError, as src/server/index.ts:1696-1699 does, and
 * relayed inside a success:true socket envelope (socketServer.ts:2017-2022). The
 * Kotlin decode treats `isError` as SetActiveDeviceResult(success=false)
 * (AutoMobileClient.kt:529-531, McpDaemonClient.kt:283-287).
 */
async function sendSetActiveDevice(sessionUuid: string): Promise<{
  success: boolean;
  text: string;
}> {
  const args = {
    deviceId: DEVICE.deviceId,
    platform: DEVICE.platform,
    sessionUuid,
    __autoMobileOwnedSessionUuids: [sessionUuid],
  };
  try {
    const result = await setActiveDeviceTool(args);
    return { success: true, text: result.content[0]!.text as string };
  } catch (error) {
    const shaped = shapeToolCallError(error, { toolName: "setActiveDevice", source: "MCP" });
    expect((shaped as { isError?: boolean }).isError).toBe(true);
    return { success: false, text: shaped.content[0]!.text as string };
  }
}

/**
 * The Kotlin loop, one frame at a time (DesktopDaemonSessionComposition.kt:108-176):
 *   target == null -> ensureRegistered()           (:128-129, registerSession once)
 *   !bindingAcknowledged -> setActiveDevice(target) (:130-133), then deviceBound()
 *   delay(2 s); heartbeat                           (:162-165)
 *   heartbeat failure -> bindingAcknowledged=false  (:171-175)
 * A changed binding restarts the effect unbound (:108-111, :122).
 */
class StudioLoopWire {
  bindingAcknowledged = false;
  private registered = false; // DesktopSessionRegistration.ready
  private target: string | null = null;
  readonly log: Array<{ at: number; frame: string; ok: boolean }> = [];

  constructor(
    private readonly sessionUuid: string,
    private readonly timer: FakeTimer,
    private readonly advance: (ms: number) => Promise<void>,
  ) {}

  /** binding.value changed (AutoMobileContent.kt:858 SideEffect). */
  setBinding(deviceId: string | null): void {
    this.target = deviceId;
    this.bindingAcknowledged = false;
  }

  /** One pass of the while-loop at DesktopDaemonSessionComposition.kt:123. */
  async pass(): Promise<void> {
    try {
      if (this.target === null) {
        if (!this.registered) {
          // DesktopSessionRegistration.kt:15-19 -> McpDaemonClient.registerSession (:832-840),
          // clientName from DesktopDaemonSession.kt:19.
          const response = await handleDaemonRequest(
            frame("daemon/registerSession", {
              sessionId: this.sessionUuid,
              clientName: "AutoMobile Desktop",
            }),
            DaemonState.getInstance(),
          );
          this.log.push({ at: this.timer.now(), frame: "registerSession", ok: response.success });
          if (!response.success) {
            throw new Error(response.error); // ensureSuccess, McpDaemonClient.kt:1117-1118
          }
          this.registered = true;
        }
      } else if (!this.bindingAcknowledged) {
        const bind = await sendSetActiveDevice(this.sessionUuid);
        this.log.push({ at: this.timer.now(), frame: "setActiveDevice", ok: bind.success });
        this.bindingAcknowledged = bind.success;
        this.registered = true; // session.deviceBound(), DesktopSessionRegistration.kt:22-24
      }
    } catch {
      await this.advance(STUDIO_LOOP_MS); // :147-150
      return;
    }
    await this.advance(STUDIO_LOOP_MS); // :163
    // McpDaemonClient.heartbeatSession (:855-863): `{ sessionId }` only — no owner
    // token, no livenessPolicy. Answered out-of-band by socketServer.ts:1876-1882.
    const heartbeat = await handleDaemonRequest(
      frame("daemon/heartbeat", { sessionId: this.sessionUuid }),
      DaemonState.getInstance(),
    );
    this.log.push({ at: this.timer.now(), frame: "heartbeat", ok: heartbeat.success });
    if (!heartbeat.success) {
      this.registered = false; // DesktopSessionRegistration.kt:27
      this.bindingAcknowledged = false; // :171-175
    }
  }

  count(name: string, ok?: boolean): number {
    return this.log.filter((entry) => entry.frame === name && (ok === undefined || entry.ok === ok))
      .length;
  }
}

describe("H5: IDE studio selection becomes an allocation that outlives the agent", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let pool: DevicePool;
  let monitor: SessionHeartbeatMonitor;
  let studio: StudioLoopWire;
  const reaped: Array<{ sessionId: string; reason: string; at: number }> = [];
  const silenced: Array<ReturnType<typeof spyOn>> = [];

  /** Step fake time, draining only microtasks so the reaper's async sweep settles. */
  const advance = (ms: number) => timer.advanceTimeAsync(ms, () => drainMicrotasks(40));

  /** The agent's MCP proxy keeper frame (daemonMcpProxy.ts:4055-4077). */
  async function agentHeartbeat(claim: boolean): Promise<void> {
    const response = await handleDaemonRequest(
      frame("daemon/heartbeat", {
        sessionId: AGENT,
        livenessPolicy: "heartbeat",
        livenessOwnerToken: AGENT_OWNER_TOKEN,
        ...(claim ? { claimLivenessOwnership: true } : {}),
      }),
      DaemonState.getInstance(),
    );
    expect(response.success).toBe(true);
  }

  beforeEach(async () => {
    reaped.length = 0;
    silenced.push(
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    );
    timer = new FakeTimer();
    manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices("android", [DEVICE]);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "h5-daemon", { timer, deviceManager: utils }),
    );
    await pool.initializeWithDevices([DEVICE]);
    DaemonState.getInstance().initialize(
      manager,
      pool,
      new DeviceSessionRegistry(),
      new ObserverSessionRegistry(timer),
    );
    // The daemon's reaper, wired as daemon.ts:2441-2448 wires it (cancelAndReleaseSession
    // -> releaseSessionAndDevice, daemon.ts:3434-3464), with default 10 s interval/timeouts.
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        reaped.push({ sessionId, reason, at: timer.now() });
        const deviceId = manager.getSession(sessionId)?.assignedDevice ?? null;
        await releaseSessionAndDevice(manager, pool, deviceId, sessionId, reason);
      },
      timer,
    );
    monitor.start();

    // Agent (external MCP stdio proxy) owns D: real pool allocation, then the
    // proxy's first claiming heartbeat.
    await expect(pool.assignDeviceToSession(AGENT, "android")).resolves.toBe(DEVICE.deviceId);
    await agentHeartbeat(true);
    studio = new StudioLoopWire(STUDIO, timer, advance);
  });

  afterEach(async () => {
    await monitor.stop();
    manager.stopCleanupTimer();
    DaemonState.getInstance().reset();
    for (const spy of silenced.splice(0)) {
      spy.mockRestore();
    }
  });

  test("IDE auto-selection re-grabs D within one loop pass of the agent's release and holds it for an hour", async () => {
    // IDE opens: binding is null until the booted-devices read resolves, so the
    // loop registers an observer identity first (:128-129).
    studio.setBinding(null);
    await studio.pass();
    expect(studio.count("registerSession", true)).toBe(1);

    // AutoMobileContent.kt:1032-1036 auto-selects the first booted device — no click.
    studio.setBinding(DEVICE.deviceId);

    // 30 s while the agent drives D: every pass re-sends setActiveDevice and is refused.
    for (let pass = 0; pass < 15; pass++) {
      await studio.pass();
      await agentHeartbeat(false);
    }
    expect(studio.count("setActiveDevice", false)).toBe(15);
    expect(studio.count("setActiveDevice", true)).toBe(0);
    // The refusal is the real daemon's owner check, relayed as a tool error.
    expect((await sendSetActiveDevice(STUDIO)).text).toContain(
      `already assigned to session ${AGENT}`,
    );
    // Observer heartbeats (1 from the registration pass + 15) keep succeeding, so
    // nothing on the client side backs off.
    expect(studio.count("heartbeat", true)).toBe(16);
    expect(studio.count("heartbeat", false)).toBe(0);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "busy", sessionId: AGENT });

    // The agent finishes and releases its session (daemon/releaseSession frame).
    const released = await handleDaemonRequest(
      frame("daemon/releaseSession", { sessionId: AGENT }),
      DaemonState.getInstance(),
    );
    expect(released.success).toBe(true);
    await drainUntilQuiescent(timer);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
    const releasedAt = timer.now();

    // The very next studio pass binds D to the studio's own UUID.
    await studio.pass();
    const bind = studio.log.find((entry) => entry.frame === "setActiveDevice" && entry.ok);
    expect(bind).toBeDefined();
    expect(bind!.at - releasedAt).toBeLessThanOrEqual(STUDIO_LOOP_MS);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "busy", sessionId: STUDIO });

    // An hour of nothing but the studio's tokenless 2 s heartbeat.
    const setActiveDeviceFramesBeforeHold = studio.count("setActiveDevice");
    const holdStart = timer.now();
    while (timer.now() - holdStart < ONE_HOUR_MS) {
      await studio.pass();
    }
    expect(studio.count("setActiveDevice")).toBe(setActiveDeviceFramesBeforeHold);
    expect(studio.count("heartbeat", false)).toBe(0);

    // CURRENT (bug/gap) behavior: D is still assigned to the studio session that
    // never ran a tool, past two 30-minute idle windows and every reaper sweep.
    const held = manager.getSession(STUDIO);
    expect(held).not.toBeNull();
    expect(held!.assignedDevice).toBe(DEVICE.deviceId);
    expect(held!.livenessOwnerToken).toBeUndefined(); // tokenless desktop heartbeat
    expect(timer.now() - held!.createdAt).toBeGreaterThanOrEqual(ONE_HOUR_MS);
    expect(held!.expiresAt).toBeGreaterThan(timer.now()); // idle expiry renewed by heartbeat
    expect(reaped).toEqual([]);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "busy", sessionId: STUDIO });
    expect(pool.getStats().idle).toBe(0);

    // The next agent asks for D and is refused.
    const nextAgent = await sendSetActiveDevice(NEXT_AGENT);
    expect(nextAgent.success).toBe(false);
    expect(nextAgent.text).toContain(`already assigned to session ${STUDIO}`);

    // AFTER A FIX (no auto-reservation from a focused/auto-selected view, e.g. an
    // observer grant instead of setActiveDevice, or no grab-back retry on refusal):
    //   expect(manager.getSession(STUDIO)?.assignedDevice).toBeUndefined();
    //   expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "idle", sessionId: null });
    //   expect((await sendSetActiveDevice(NEXT_AGENT)).success).toBe(true);
  });

  test("an agent whose proxy dies is reaped, then the studio's retry takes D for good", async () => {
    studio.setBinding(DEVICE.deviceId); // desktop pane focused on D (or IDE auto-select)
    for (let pass = 0; pass < 3; pass++) {
      await studio.pass();
      await agentHeartbeat(false);
    }
    expect(studio.count("setActiveDevice", false)).toBe(3);
    // No observer registration here, so the refused studio UUID has no session
    // and its heartbeat fails "Session not found" — which only re-arms the bind.
    expect(studio.count("heartbeat", false)).toBe(3);

    // Agent's proxy exits: its heartbeats stop. Keep the studio loop running.
    let passes = 0;
    while (pool.getDevice(DEVICE.deviceId)?.sessionId !== STUDIO && passes++ < 30) {
      await studio.pass();
    }
    expect(reaped).toMatchObject([{ sessionId: AGENT, reason: "heartbeat-timeout" }]);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "busy", sessionId: STUDIO });
    const bind = studio.log.find((entry) => entry.frame === "setActiveDevice" && entry.ok)!;
    expect(bind.at - reaped[0]!.at).toBeLessThanOrEqual(STUDIO_LOOP_MS);

    // One more hour: held throughout, no further binds, no reap of the studio.
    const binds = studio.count("setActiveDevice");
    const start = timer.now();
    while (timer.now() - start < ONE_HOUR_MS) {
      await studio.pass();
    }
    expect(studio.count("setActiveDevice")).toBe(binds);
    expect(reaped.map((entry) => entry.sessionId)).toEqual([AGENT]);
    expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "busy", sessionId: STUDIO });
    expect((await sendSetActiveDevice(NEXT_AGENT)).success).toBe(false);
    // AFTER A FIX: the device should be idle (or bound to NEXT_AGENT) here, not STUDIO.
  });
});
