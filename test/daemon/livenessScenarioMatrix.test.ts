import { afterEach, describe, expect, test } from "bun:test";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { OWNER_DISCONNECT_GRACE_MS } from "../../src/daemon/ownerDisconnectRelease";
import {
  AUTOLOCK_WINDOW_MS,
  IDLE_WINDOW_MS,
  KEEPER_INTERVAL_MS,
  LivenessScenario,
  NO_HEARTBEAT_BUDGET_MS,
  OWNER_TOKEN,
  RELEASE_SLACK_MS,
  SCAN_MS,
} from "../helpers/livenessScenarioHarness";

// The two-sided liveness scenario matrix (#10667, umbrella #10655). Every row asserts BOTH
// sides on the same scenario, driven by the real producers (the stdio proxy's own keeper, tool
// calls through the proxy, tokenless desktop heartbeats) on a FakeTimer:
//
//   held      the device stays with its session for as long as the policy says
//   released  and is freed, with the right reason, within the policy's bound afterwards
//
// The windows are the owner decisions of 2026-10-08 (src/daemon/sessionLivenessWindows.ts):
// ~10 s after the owner's last heartbeat, 2 min after the END of the last tool call while
// heartbeats keep arriving, and a call in flight is never released. Each row names the issue
// whose fix flips it.

const IDLE_REASONS = ["cleanup-expired", "lazy-expiry"];

let scenario: LivenessScenario;

afterEach(async () => {
  await scenario.stop();
});

/** Held and bound to its pool entry, with the owner-liveness heartbeats still arriving. */
function expectHeld(sessionId: string, deviceId?: string): void {
  expect(scenario.isHeld(sessionId)).toBe(true);
  expect(scenario.poolState(deviceId)).toMatchObject({ status: "busy", sessionId });
}

/** Released: the pool entry is idle and unowned, with no stale autolock owner. */
function expectFreed(deviceId?: string): void {
  expect(scenario.poolState(deviceId)).toEqual({
    status: "idle",
    sessionId: null,
    autolockSessionId: undefined,
  });
}

describe("live stdio proxy", () => {
  test("tool calls inside the window hold the device the whole time; the last call's window then frees it as idle (#10656)", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();

    // Held side: a call every 110 s keeps the session across five idle windows.
    const callEvery = IDLE_WINDOW_MS - 10_000;
    for (let call = 0; call < 5; call++) {
      expect(await scenario.idleWhileHeld(session, scenario.timer.now() + callEvery, 30_000)).toBe(
        undefined,
      );
      expectHeld(session);
      await scenario.toolCall(session);
    }
    const lastCallAt = scenario.timer.now();

    // Released side: only the last call's own window frees it, and as an idle expiry.
    const releasedAt = await scenario.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(releasedAt).toBeGreaterThan(lastCallAt + IDLE_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(lastCallAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
    expect(scenario.reaped).toEqual([]);
    expectFreed();
  });

  test("no tool call after acquiring: held until the idle window, freed as idle shortly after it although heartbeats never stop (#10656)", async () => {
    scenario = await LivenessScenario.start();
    const acquiredAt = scenario.timer.now();
    const session = await scenario.acquire();

    expect(await scenario.idleWhileHeld(session, acquiredAt + IDLE_WINDOW_MS - 10_000)).toBe(
      undefined,
    );
    expectHeld(session);
    // Liveness is proven the whole time: the owner lease is current.
    expect(scenario.daemon.manager.getSession(session)!.lastOwnerHeartbeat).toBeGreaterThan(
      scenario.timer.now() - NO_HEARTBEAT_BUDGET_MS,
    );

    const releasedAt = await scenario.idleUntilReleased(session, 2 * RELEASE_SLACK_MS);
    expect(releasedAt).toBeGreaterThan(acquiredAt + IDLE_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(acquiredAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
    expectFreed();
  });

  test("moving from device A to B: B is held while used; A is freed after its own idle window (#10657)", async () => {
    scenario = await LivenessScenario.start({ devices: ["device-a", "device-b"] });
    const a = await scenario.acquire("device-a");
    const aLastUsedAt = scenario.timer.now();
    await scenario.idle(30_000);
    const b = await scenario.acquire("device-b");

    // Held side: B keeps being used, so it outlives A's window; A is still held until then.
    await scenario.idle(70_000);
    await scenario.toolCall(b);
    expectHeld(a, "device-a");
    expectHeld(b, "device-b");

    // Released side: A, never used again, goes at its own deadline while B stays.
    const releasedAt = await scenario.idleUntilReleased(a, IDLE_WINDOW_MS);
    expect(releasedAt).toBeGreaterThan(aLastUsedAt + IDLE_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(aLastUsedAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expectFreed("device-a");
    expectHeld(b, "device-b");
  });

  test("a long-running call in flight past the window keeps the session; it is freed one window after the call settles", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    const call = scenario.startLongCall(session);

    // Held side: three windows with the call open, heartbeating or not.
    expect(await scenario.idleWhileHeld(session, 3 * IDLE_WINDOW_MS, 60_000)).toBe(undefined);
    expectHeld(session);

    await call.settle();
    const settledAt = scenario.timer.now();
    expectHeld(session);
    expect(await scenario.idleWhileHeld(session, settledAt + IDLE_WINDOW_MS - 10_000)).toBe(
      undefined,
    );

    // Released side: the window runs from the END of the call.
    const releasedAt = await scenario.idleUntilReleased(session, 2 * RELEASE_SLACK_MS);
    expect(releasedAt).toBeGreaterThan(settledAt + IDLE_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(settledAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
    expectFreed();
  });
});

describe("autolock with a live proxy", () => {
  test("held while used; freed 60 s after the last call with no stale autolock owner (#10658)", async () => {
    scenario = await LivenessScenario.start({ autolock: true });
    const session = await scenario.acquire();
    expect(scenario.poolState().autolockSessionId).toBe(session);

    // Held side: a call every 40 s keeps the 60 s window open past 2 minutes.
    for (let call = 0; call < 3; call++) {
      await scenario.idle(40_000);
      expectHeld(session);
      await scenario.toolCall(session);
    }
    const lastCallAt = scenario.timer.now();

    // Released side: 60 s after the last call, not the 2 min default.
    const releasedAt = await scenario.idleUntilReleased(
      session,
      AUTOLOCK_WINDOW_MS + RELEASE_SLACK_MS,
    );
    expect(releasedAt).toBeGreaterThan(lastCallAt + AUTOLOCK_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(lastCallAt + AUTOLOCK_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
    expectFreed();
  });
});

describe("owner exits or goes silent", () => {
  test("proxy exits (stdin EOF): held through the disconnect grace, freed by the owner-disconnect window", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    await scenario.idle(30_000);
    expectHeld(session);

    const exitedAt = scenario.timer.now();
    await scenario.closeTransport();
    // Held side: a proxy whose socket merely dropped is not cut off before the lease runs out.
    await scenario.idle(KEEPER_INTERVAL_MS);
    expectHeld(session);

    // Released side.
    const releasedAt = await scenario.idleUntilReleased(session, OWNER_DISCONNECT_GRACE_MS);
    expect(releasedAt).toBeLessThanOrEqual(exitedAt + NO_HEARTBEAT_BUDGET_MS);
    expect(releasedAt).toBeGreaterThan(exitedAt);
    expectFreed();
  });

  test("heartbeats lost on the wire: a gap shorter than lease + grace is forgiven; a silent owner is freed in about 10 s", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    await scenario.idle(20_000);

    // Held side: one late or lost beat (6 s of silence) never releases the session.
    scenario.dropHeartbeats = true;
    await scenario.idle(6_000);
    scenario.dropHeartbeats = false;
    await scenario.idle(30_000);
    expectHeld(session);
    expect(scenario.reaped).toEqual([]);

    // Released side: silence for good frees the session within the 10 s budget.
    const silentSince = scenario.timer.now();
    scenario.dropHeartbeats = true;
    const releasedAt = await scenario.idleUntilReleased(session, 2 * NO_HEARTBEAT_BUDGET_MS);
    expect(releasedAt).toBeLessThanOrEqual(silentSince + NO_HEARTBEAT_BUDGET_MS);
    expect(scenario.releaseOf(session)?.reason).toBe("heartbeat-timeout");
    expectFreed();
  });

  test("a call in flight is not released for missing heartbeats; the silent owner is freed within 10 s of the call settling", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    const call = scenario.startLongCall(session);
    scenario.dropHeartbeats = true;

    // Held side: well past the 10 s no-heartbeat budget, the in-flight call holds it.
    expect(await scenario.idleWhileHeld(session, 3 * NO_HEARTBEAT_BUDGET_MS, 5_000)).toBe(
      undefined,
    );
    expectHeld(session);

    // Released side: once the call has settled nothing protects a silent owner.
    await call.settle();
    const settledAt = scenario.timer.now();
    const releasedAt = await scenario.idleUntilReleased(session, 2 * NO_HEARTBEAT_BUDGET_MS);
    expect(releasedAt).toBeLessThanOrEqual(settledAt + NO_HEARTBEAT_BUDGET_MS);
    expectFreed();
  });
});

describe("desktop / IDE tokenless client", () => {
  test("heartbeating holds the session while focused; unfocusing (heartbeats stop) frees it promptly (#10659)", async () => {
    scenario = await LivenessScenario.start();
    // The desktop acquires over its own connection and holds the session with tokenless beats.
    const session = await scenario.acquireTokenless();
    const focus = scenario.startTokenlessHeartbeats(session);

    // Held side: the heartbeats alone keep the owner lease alive far past the 10 s budget.
    expect(await scenario.idleWhileHeld(session, 60_000, 10_000)).toBe(undefined);
    expectHeld(session);

    focus.stop();
    const unfocusedAt = scenario.timer.now();
    const releasedAt = await scenario.idleUntilReleased(session, 2 * NO_HEARTBEAT_BUDGET_MS);
    expect(releasedAt).toBeLessThanOrEqual(unfocusedAt + NO_HEARTBEAT_BUDGET_MS);
    expectFreed();
  });

  test("an IDE that is open but idle never allocates, and cannot grab a device the agent just released (#10660)", async () => {
    scenario = await LivenessScenario.start();
    // Held side (of the pool): nothing is allocated for a client that only heartbeats.
    const ide = scenario.startTokenlessHeartbeats("ide-tool-window-session");
    await scenario.idle(60_000);
    expectFreed();

    // The agent acquires and releases; the IDE keeps retrying its stale session id.
    const session = await scenario.acquire();
    const reply = await scenario.daemonMethod("daemon/releaseSession", { sessionId: session });
    expect(reply.success).toBe(true);
    expectFreed();
    await scenario.idle(60_000);
    ide.stop();
    expectFreed();
    expect(scenario.daemon.manager.getAllSessions()).toEqual([]);
  });
});

describe("daemon restart", () => {
  test("a live holder reclaims its rehydrated session; the same session is then freed by idle", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    await scenario.idle(20_000);

    await scenario.daemonRestart();
    const restartedAt = scenario.timer.now();
    expect(scenario.daemon.manager.getSession(session)?.ownership).toBe("awaiting-owner");

    // Held side: the still-running proxy heartbeats the new process and takes it back.
    await scenario.idle(NO_HEARTBEAT_BUDGET_MS * 2);
    expect(scenario.daemon.manager.getSession(session)?.ownership).toBe("owned");
    expectHeld(session);
    expect(scenario.reaped).toEqual([]);

    // Released side: reclaimed is not forever; the idle window still frees it.
    const releasedAt = await scenario.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(releasedAt).toBeLessThanOrEqual(restartedAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expectFreed();
  });

  test("a dead holder is held through the owner window, then freed by the rehydration owner timeout", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    await scenario.idle(20_000);
    await scenario.proxy.close();

    await scenario.daemonRestart();
    const restartedAt = scenario.timer.now();
    // Held side: the owner gets lease + grace to come back.
    await scenario.idle(4_000);
    expectHeld(session);

    const releasedAt = await scenario.idleUntilReleased(session, 2 * NO_HEARTBEAT_BUDGET_MS);
    expect(releasedAt).toBeLessThanOrEqual(restartedAt + NO_HEARTBEAT_BUDGET_MS);
    expect(scenario.releaseOf(session)?.reason).toBe("rehydration-owner-timeout");
    expectFreed();
  });
});

describe("host sleep longer than the idle window (#10661)", () => {
  /** Which producer acts first on wake; the verdict must not depend on it. */
  const WAKE_ORDERS = [
    "monitor scan first",
    "owner heartbeat first",
    "cleanup sweep first",
  ] as const;

  test("a sleep inside the window after a recent call keeps the session", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    await scenario.idle(30_000);
    await scenario.toolCall(session);

    scenario.hostSleep(60_000);
    await scenario.idle(KEEPER_INTERVAL_MS * 2);
    expectHeld(session);
    expect(scenario.releases).toEqual([]);
  });

  for (const order of WAKE_ORDERS) {
    test(`a sleep past the window frees the session whichever timer wakes first (${order})`, async () => {
      scenario = await LivenessScenario.start();
      const session = await scenario.acquire();
      await scenario.idle(30_000);
      await scenario.toolCall(session);
      expectHeld(session);

      // A stall shorter than window + suspect grace is forgiven as a daemon hiccup (#10051); the
      // monitor measures it from its previous scan, so sleep one scan interval beyond that.
      const sleptAt = scenario.timer.now();
      scenario.hostSleep(IDLE_WINDOW_MS + SUSPECT_GRACE_MS + 2 * SCAN_MS);
      if (order === "owner heartbeat first") {
        await scenario.daemonMethod("daemon/heartbeat", {
          sessionId: session,
          livenessOwnerToken: OWNER_TOKEN,
        });
      } else if (order === "cleanup sweep first") {
        scenario.daemon.manager.cleanupExpiredSessions();
      }
      const releasedAt = await scenario.idleUntilReleased(session, 2 * RELEASE_SLACK_MS);

      // The window and the lease both lapsed in the sleep: freed on wake, never held "per timer".
      expect(releasedAt).toBeDefined();
      expect(releasedAt! - sleptAt).toBeLessThanOrEqual(
        IDLE_WINDOW_MS + SUSPECT_GRACE_MS + 2 * SCAN_MS + RELEASE_SLACK_MS,
      );
      expect(scenario.releaseOf(session)?.reason).toBe("heartbeat-timeout");
      expectFreed();
    });
  }
});

describe("second proxy names a session another proxy owns", () => {
  test("the owner keeps the session and its token; the challenger stops claiming after the leash (#10664)", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    const challenger = scenario.addProxy({
      token: "challenger-owner",
      initialSessionUuid: session,
    });

    // Held side: with both proxies heartbeating, the first owner keeps ownership.
    await scenario.idle(30_000);
    await challenger.callTool("observe", { sessionUuid: session }).catch(() => undefined);
    await scenario.idle(30_000);
    expect(scenario.daemon.manager.getSession(session)?.livenessOwnerToken).toBe(OWNER_TOKEN);
    expectHeld(session);

    // Released side: the challenger gives up claiming; its heartbeats for the session stop.
    const before = scenario.heartbeatsByToken.get("challenger-owner") ?? 0;
    expect(before).toBeGreaterThan(0);
    await scenario.idle(60_000);
    expect(scenario.heartbeatsByToken.get("challenger-owner") ?? 0).toBe(before);
    expect(scenario.daemon.manager.getSession(session)?.livenessOwnerToken).toBe(OWNER_TOKEN);
    await challenger.close();
  });
});
