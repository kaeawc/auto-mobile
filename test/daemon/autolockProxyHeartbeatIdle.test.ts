import { afterEach, describe, expect, it } from "bun:test";
import {
  AUTOLOCK_WINDOW_MS,
  KEEPER_INTERVAL_MS,
  LivenessScenario,
  RELEASE_SLACK_MS,
} from "../helpers/livenessScenarioHarness";

// Autolock idle release with a heartbeating stdio proxy (#10658, umbrella #10655). The proxy's
// own keeper sends the heartbeats (the real DaemonMcpProxy at its production cadence, owner
// token and ownership claim), through the real daemon heartbeat handler, SessionManager,
// heartbeat monitor and DevicePool. The earlier version of this file called
// SessionManager.recordHeartbeat by hand, which hid the real cadence and never asserted why the
// device was released (#10667, #10705).

const IDLE_REASONS = ["cleanup-expired", "lazy-expiry"];

describe("autolock idle release with a heartbeating stdio proxy (#10658)", () => {
  let scenario: LivenessScenario;

  afterEach(async () => {
    await scenario.stop();
  });

  it("releases the device after the idle timeout although the proxy keeps heartbeating, as an idle expiry", async () => {
    scenario = await LivenessScenario.start({ autolock: true });
    const acquiredAt = scenario.timer.now();
    const session = await scenario.acquire();
    expect(scenario.poolState()).toMatchObject({ status: "busy", autolockSessionId: session });

    // Held side: just inside the window the keeper has been ticking all along and the session
    // is still held, so the later release cannot be a dead-owner reap.
    await scenario.idle(AUTOLOCK_WINDOW_MS - KEEPER_INTERVAL_MS);
    expect(scenario.isHeld(session)).toBe(true);
    expect(scenario.heartbeatsBySession.get(session)).toBeGreaterThan(
      AUTOLOCK_WINDOW_MS / KEEPER_INTERVAL_MS - 5,
    );

    // Released side: freed by the idle deadline, with no stale autolock owner left on the device.
    const releasedAt = await scenario.idleUntilReleased(session, 2 * RELEASE_SLACK_MS);
    expect(releasedAt).toBeGreaterThan(acquiredAt + AUTOLOCK_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(acquiredAt + AUTOLOCK_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
    expect(scenario.reaped).toEqual([]);
    expect(scenario.poolState()).toEqual({
      status: "idle",
      sessionId: null,
      autolockSessionId: undefined,
    });
  });

  it("a tool call resets the idle window while heartbeats continue", async () => {
    scenario = await LivenessScenario.start({ autolock: true });
    const session = await scenario.acquire();
    await scenario.idle(50_000);
    await scenario.toolCall(session);
    const usedAt = scenario.timer.now();
    await scenario.idle(50_000);

    // 100 s since acquisition but only 50 s since the last tool call.
    expect(scenario.isHeld(session)).toBe(true);
    expect(scenario.poolState().status).toBe("busy");

    const releasedAt = await scenario.idleUntilReleased(session, 2 * RELEASE_SLACK_MS);
    expect(releasedAt).toBeGreaterThan(usedAt + AUTOLOCK_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(usedAt + AUTOLOCK_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
  });

  it("leaves the pool unlocked when autolock is off", async () => {
    scenario = await LivenessScenario.start({ autolock: false });
    expect(scenario.poolState()).toEqual({
      status: "idle",
      sessionId: null,
      autolockSessionId: undefined,
    });
    const session = await scenario.acquire();
    expect(scenario.poolState()).toMatchObject({
      status: "busy",
      sessionId: session,
      autolockSessionId: undefined,
    });
  });
});
