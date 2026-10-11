import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  buildDeviceLabelMap,
  releaseDeviceLabelSessions,
} from "../../src/server/deviceLabelMapping";
import { serverConfig } from "../../src/utils/ServerConfig";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import {
  IDLE_WINDOW_MS,
  LivenessScenario,
  NO_HEARTBEAT_BUDGET_MS,
  OWNER_TOKEN,
  RELEASE_SLACK_MS,
  SCAN_MS,
} from "../helpers/livenessScenarioHarness";
import { forbidHostCommands } from "../helpers/hostCommandGuard";
import { asPlanAllocation } from "../helpers/planLabelAllocation";
import {
  DEVICE_A,
  DEVICE_B,
  DISCONNECT_POLL_MS,
  armedTimers,
  inventory,
  mcpVerdict,
  persistedRow,
  releasesOf,
  sessionInfo,
  socketVerdict,
  startDisconnectMonitor,
} from "../helpers/timerInteractionRig";

// Lifecycle timer interactions: cross-layer baselines.
//
// Four independent timers can end or keep a device session: T1 the heartbeat lease, T2 the idle
// window, T3 the device disconnect monitor (absent misses, transitional budget) and T4 the
// in-flight control-call veto, plus restart recovery and plan auto-release. Each test drives one
// combination over the real daemon (LivenessScenario) with the daemon's real disconnect monitor
// started over the scenario's fake discovery, and asserts the session's end on every wire: the MCP
// result, the daemon socket's tool-call refusal, `daemon/sessionInfo`, the persisted row, the
// release notifications, the pool entry and the `daemon/availableDevices` inventory.
//
// The transitional platform state is adb `offline` (the harness is Android-only); the
// monitor holds simctl `Booting`/`Shutting Down` under the same budget.

const IDLE_REASONS = ["cleanup-expired", "lazy-expiry"];
const DEVICE_C = "emulator-5558";
const TERMINAL = { code: "session_ownership_lost", nextAction: "acquire_new_session" };
/** Microtask turns that let a whole acquisition or re-bind chain finish. */
const QUIET_TURNS = 400;

let scenario: LivenessScenario;

// Fake-only: no scenario here, the warm-up included, may launch a host or adb command.
forbidHostCommands();

beforeAll(async () => {
  const warm = await LivenessScenario.start();
  const session = await warm.acquire();
  await warm.toolCall(session);
  await warm.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS);
  await warm.stop();
});

afterEach(async () => {
  serverConfig.setPlanExecutionActive(false);
  await scenario.stop();
});

/** The session ended once, terminally, for `reasons`, and every wire names the same reason. */
async function expectEndedEverywhere(sessionId: string, reasons: readonly string[]) {
  const released = releasesOf(scenario, sessionId);
  expect(released.map((release) => release.sessionId)).toEqual([sessionId]);
  const reason = released[0]!.reason;
  expect(reasons).toContain(reason);
  expect(await socketVerdict(scenario, sessionId)).toEqual({ ...TERMINAL, reason });
  // The proxy raises its typed binding error, which proxyServer shapes as session_ownership_lost.
  expect(await mcpVerdict(scenario, sessionId)).toEqual({
    code: "DaemonBoundSessionExpiredError",
    reason,
  });
  expect(await sessionInfo(scenario, sessionId)).toMatchObject({
    code: "daemon_session_not_found",
    releaseReason: reason,
  });
  expect(await persistedRow(scenario, sessionId)).toMatchObject({ status: "expired", reason });
  expect(scenario.releaseBroadcasts.filter((push) => push.sessionId === sessionId)).toHaveLength(1);
  return released[0]!;
}

/**
 * Advance `ms` a second at a time with the event loop fully drained in between. A re-bind is one
 * long promise chain with no timer in it: under a coarse step the fake clock runs seconds ahead
 * of it, which no real event loop does (microtasks drain before the next timer fires). Stops as
 * soon as `done` holds, so the scenario is not ticked past the answer it waits for.
 */
async function settleBetweenSteps(ms: number, done: () => boolean): Promise<void> {
  for (let elapsed = 0; elapsed < ms && !done(); elapsed += 1_000) {
    await drainMicrotasks(QUIET_TURNS);
    if (!done()) {
      await scenario.idle(1_000);
    }
  }
  await drainMicrotasks(QUIET_TURNS);
}

function expectFreed(deviceId: string): void {
  expect(scenario.poolState(deviceId)).toMatchObject({ status: "idle", sessionId: null });
}

describe("cell 1: the idle window alone, and against the heartbeat lease (T2, T2 x T1)", () => {
  test("acquire, control call, 2 min idle with heartbeats continuing: released terminal at the reported idleReleaseAt", async () => {
    // Literals, so a changed production window fails here and not only by shifting every deadline.
    expect({ IDLE_WINDOW_MS, NO_HEARTBEAT_BUDGET_MS }).toEqual({
      IDLE_WINDOW_MS: 120_000,
      NO_HEARTBEAT_BUDGET_MS: 10_000,
    });
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const [, intervalsBefore] = armedTimers(scenario);
    const session = await scenario.acquire();
    await scenario.toolCall(session);
    const lastCallAt = scenario.timer.now();

    // One deadline on both frames that report it.
    const info = await sessionInfo(scenario, session);
    const ack = await scenario.daemonMethod(
      "daemon/heartbeat",
      { sessionId: session, reportIdleRelease: true, livenessOwnerToken: OWNER_TOKEN },
      scenario.proxyConnection,
    );
    expect(info.idleReleaseAt).toBe(lastCallAt + IDLE_WINDOW_MS);
    expect((ack.result as { idleReleaseAt: number }).idleReleaseAt).toBe(info.idleReleaseAt);

    await scenario.idle(IDLE_WINDOW_MS);
    expect(scenario.isHeld(session)).toBe(true);
    await scenario.idle(SCAN_MS);
    const release = await expectEndedEverywhere(session, IDLE_REASONS);
    expect(release.at).toBeGreaterThan(lastCallAt + IDLE_WINDOW_MS);
    expect(release.at).toBeLessThanOrEqual(lastCallAt + IDLE_WINDOW_MS + SCAN_MS);
    expectFreed(DEVICE_A);
    expect(await inventory(scenario)).toMatchObject({ available: 2, assigned: 0 });
    // The owner's keeper is gone with its session; only the daemon's own intervals remain.
    expect(armedTimers(scenario)[1]).toBe(intervalsBefore);
  });

  test.each([
    // The lease plus grace runs out before the idle deadline: the heartbeat loss wins.
    [108_000, ["heartbeat-timeout"]],
    // The idle deadline passes inside the suspect grace: the idle release wins.
    [115_000, IDLE_REASONS],
  ] as const)(
    "owner heartbeats stop at %i ms: one reason, the same on every daemon wire",
    async (stopAt, reasons) => {
      scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
      const session = await scenario.acquire();
      await scenario.toolCall(session);
      await scenario.idle(stopAt);
      scenario.dropHeartbeats = true;
      await scenario.idle(IDLE_WINDOW_MS + SCAN_MS - stopAt);

      const released = releasesOf(scenario, session);
      expect(released).toHaveLength(1);
      expect(reasons).toContain(released[0]!.reason);
      const reason = released[0]!.reason;
      expect(await socketVerdict(scenario, session)).toEqual({ ...TERMINAL, reason });
      expect(await sessionInfo(scenario, session)).toMatchObject({ releaseReason: reason });
      expect(await persistedRow(scenario, session)).toMatchObject({ status: "expired", reason });
      expectFreed(DEVICE_A);
    },
  );
});

describe("cell 2: a held device in a transitional platform state (T3 x T1)", () => {
  test("50 s transitional while the owner heartbeats: held throughout and listed as held", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const listing = startDisconnectMonitor(scenario);
    const session = await scenario.acquire();
    await scenario.toolCall(session);

    listing.set(DEVICE_A, "offline");
    await scenario.idle(50_000);
    expect(scenario.isHeld(session)).toBe(true);
    expect(scenario.poolState(DEVICE_A)).toMatchObject({ status: "busy", sessionId: session });
    expect(await inventory(scenario)).toMatchObject({ total: 2, assigned: 1, available: 1 });
    expect(releasesOf(scenario, session)).toEqual([]);

    listing.set(DEVICE_A, "device");
    await scenario.idle(2 * DISCONNECT_POLL_MS);
    expect(listing.episodes()).toEqual([]);
    expect(await mcpVerdict(scenario, session)).toEqual({ ok: true });
  });

  test("the owner stops heartbeating at 20 s: released as heartbeat-timeout inside the budget, and the device is lendable once it is back", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const listing = startDisconnectMonitor(scenario);
    const session = await scenario.acquire();
    await scenario.toolCall(session);

    listing.set(DEVICE_A, "offline");
    await scenario.idle(20_000);
    scenario.dropHeartbeats = true;
    await scenario.idle(NO_HEARTBEAT_BUDGET_MS + SCAN_MS);

    // The transitional budget (60 s) does not hold a session whose owner is gone.
    const released = releasesOf(scenario, session);
    expect(released.map((release) => release.reason)).toEqual(["heartbeat-timeout"]);
    expect(released[0]!.at).toBeLessThanOrEqual(20_000 + NO_HEARTBEAT_BUDGET_MS + SCAN_MS);
    // Not early either: the 4 s lease and the 4 s suspect grace both run out first.
    expect(released[0]!.at).toBeGreaterThanOrEqual(20_000 + 4_000 + 4_000);
    expect(await socketVerdict(scenario, session)).toEqual({
      ...TERMINAL,
      reason: "heartbeat-timeout",
    });
    expect(await persistedRow(scenario, session)).toMatchObject({
      status: "expired",
      reason: "heartbeat-timeout",
    });

    // The device finishes its transition: idle, counted and unreserved.
    listing.set(DEVICE_A, "device");
    await scenario.idle(2 * DISCONNECT_POLL_MS);
    expectFreed(DEVICE_A);
    expect(listing.episodes()).toEqual([]);
    expect(await inventory(scenario)).toMatchObject({ total: 2, available: 2, assigned: 0 });
    expect(await scenario.acquireTokenless(DEVICE_A)).toBeString();
  });
});

describe("cell 3: a device-restart handoff whose device stays away (T3 x restart recovery)", () => {
  const HANDOFF_REASON = `device-restart:Pixel_${DEVICE_A}`;

  /** A held device absent for three whole sweeps: its session is handed off recoverably. */
  async function handOff() {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const listing = startDisconnectMonitor(scenario);
    const session = await scenario.acquire();
    await scenario.toolCall(session);
    listing.set(DEVICE_A, "absent");
    await scenario.idle(3 * DISCONNECT_POLL_MS);
    expect(releasesOf(scenario, session)).toEqual([]);
    await scenario.idle(DISCONNECT_POLL_MS);
    expect(releasesOf(scenario, session).map((release) => release.reason)).toEqual([
      HANDOFF_REASON,
    ]);
    return { listing, session };
  }

  /** The owner names the handed-off session; the answer is read without awaiting it. */
  function ownerNames(session: string): () => unknown {
    let verdict: unknown = "pending";
    void mcpVerdict(scenario, session).then((answer) => {
      verdict = answer;
    });
    return () => verdict;
  }

  test("three absent sweeps hand the session off once, recoverably, and nobody holds the device", async () => {
    const { session } = await handOff();

    expect(await persistedRow(scenario, session)).toMatchObject({
      status: "released",
      reason: HANDOFF_REASON,
    });
    expect(scenario.poolState(DEVICE_A)).toMatchObject({ status: "missing", sessionId: null });
    expect(scenario.daemon.manager.getAllSessions()).toEqual([]);
    // Later sweeps announce nothing more.
    await scenario.idle(2 * DISCONNECT_POLL_MS);
    expect(releasesOf(scenario, session)).toHaveLength(1);
  });

  test("the device is transitional for 45 s after the handoff: the owner's call waits and re-binds when it is back", async () => {
    const { listing, session } = await handOff();

    // The owner names the session while the device is still restarting: neither refused nor bound.
    listing.set(DEVICE_A, "offline");
    const verdict = ownerNames(session);
    await scenario.idle(45_000);
    expect(verdict()).toBe("pending");
    expect(scenario.poolState(DEVICE_A).sessionId).toBeNull();

    listing.set(DEVICE_A, "device");
    const backAt = scenario.timer.now();
    await settleBetweenSteps(20_000, () => verdict() !== "pending");
    expect(verdict()).toEqual({ ok: true });
    expect(scenario.timer.now() - backAt).toBeLessThanOrEqual(20_000);
    expect(scenario.poolState(DEVICE_A)).toMatchObject({ status: "busy", sessionId: session });
    expect(await persistedRow(scenario, session)).toMatchObject({ status: "active", reason: null });
    expect(releasesOf(scenario, session)).toHaveLength(1);
  });
});

describe("cell 4: a control call across the idle deadline (T2 x T4)", () => {
  test("a call from 1:59 that runs 30 s is not cut, a second call queues behind it, and the idle window restarts at their end", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const session = await scenario.acquire();
    await scenario.toolCall(session);
    await scenario.idle(IDLE_WINDOW_MS - 1_000);

    const call = scenario.startLongCall(session);
    await scenario.idle(11_000);
    expect(scenario.isHeld(session)).toBe(true);
    // A second control call at 2:10: its body is free to finish, but it waits for the first.
    const gates = Reflect.get(scenario, "gates") as Map<string, unknown>;
    const gate = gates.get(session);
    gates.delete(session);
    let second: unknown = "pending";
    void mcpVerdict(scenario, session).then((answer) => {
      second = answer;
    });
    gates.set(session, gate);
    await scenario.idle(19_000);
    expect(second).toBe("pending");
    expect(releasesOf(scenario, session)).toEqual([]);
    expect(scenario.abortedCalls).toEqual([]);

    await call.settle();
    const endedAt = scenario.timer.now();
    await drainMicrotasks(QUIET_TURNS);
    expect(call.failure()).toBeUndefined();
    expect(second).toEqual({ ok: true });
    expect((await sessionInfo(scenario, session)).idleReleaseAt).toBe(endedAt + IDLE_WINDOW_MS);

    await scenario.idle(IDLE_WINDOW_MS - 1);
    expect(scenario.isHeld(session)).toBe(true);
    await scenario.idle(SCAN_MS);
    const release = await expectEndedEverywhere(session, IDLE_REASONS);
    expect(release.at).toBeLessThanOrEqual(endedAt + IDLE_WINDOW_MS + SCAN_MS);
    expectFreed(DEVICE_A);
  });
});

describe("cell 5: the idle deadline passes while the device is transitional (T2 x T3)", () => {
  test("released as idle at 2:00 while offline; the device is idle and listed once it is back", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const listing = startDisconnectMonitor(scenario);
    const session = await scenario.acquire();
    await scenario.toolCall(session);
    await scenario.idle(90_000);

    listing.set(DEVICE_A, "offline");
    await scenario.idle(IDLE_WINDOW_MS + SCAN_MS - 90_000);
    const release = await expectEndedEverywhere(session, IDLE_REASONS);
    expect(release.at).toBeLessThanOrEqual(IDLE_WINDOW_MS + SCAN_MS);
    // Unheld and still offline: not counted as lendable.
    expect(await inventory(scenario)).toMatchObject({ total: 1, available: 1, assigned: 0 });

    listing.set(DEVICE_A, "device");
    await scenario.idle(140_000 + DISCONNECT_POLL_MS - scenario.timer.now());
    expect(listing.episodes()).toEqual([]);
    expectFreed(DEVICE_A);
    expect(await inventory(scenario)).toMatchObject({ total: 2, available: 2, assigned: 0 });
    expect(releasesOf(scenario, session)).toHaveLength(1);
  });
});

describe("cell 6: the daemon stalls near the idle deadline (T1 forgiveness x T2)", () => {
  test("a 40 s stall at 1:50 moves the lease and the idle deadline together; scan, admission and idleReleaseAt agree afterwards", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const session = await scenario.acquire();
    await scenario.toolCall(session);
    await scenario.idle(110_000);

    scenario.lateTicks(40_000);
    await scenario.idle(1);
    expect(scenario.isHeld(session)).toBe(true);
    const info = await sessionInfo(scenario, session);
    // Forgiven by the scan's lateness: the stall less the one scan interval already scheduled.
    const deadline = IDLE_WINDOW_MS + 40_000 - SCAN_MS;
    expect(info).toMatchObject({ idleReleaseAt: deadline, expiresAt: deadline });
    expect(info.liveness).toMatchObject({ state: "live" });

    await scenario.idle(deadline - scenario.timer.now());
    expect(scenario.isHeld(session)).toBe(true);
    await scenario.idle(SCAN_MS);
    const release = await expectEndedEverywhere(session, IDLE_REASONS);
    expect(release.at).toBeGreaterThan(deadline);
    expect(release.at).toBeLessThanOrEqual(deadline + SCAN_MS);
  });
});

describe("cell 7: a plan ends while a label's device is transitional (plan auto-release x T3)", () => {
  test("the label session is released once as plan-auto-release, the base stays, and no release follows for the label's device", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B, DEVICE_C] });
    const listing = startDisconnectMonitor(scenario);
    const base = await scenario.acquire();
    await scenario.toolCall(base);
    const label = `${base}:B`;
    const { manager, pool } = scenario.daemon;
    // The plan run: a control call in flight on the base keeps its label sessions.
    const plan = scenario.startLongCall(base);
    manager.setDeviceLabels(base, buildDeviceLabelMap(["A", "B"], base));
    await asPlanAllocation(manager, base, [label], () =>
      pool.bindOrReuseDeviceSession(label, DEVICE_B, "android"),
    );
    serverConfig.setPlanExecutionActive(true);
    await scenario.idle(DISCONNECT_POLL_MS);
    listing.set(DEVICE_B, "offline");
    await scenario.idle(3 * DISCONNECT_POLL_MS);
    expect(scenario.poolState(DEVICE_B)).toMatchObject({ status: "busy", sessionId: label });

    serverConfig.setPlanExecutionActive(false);
    expect(await releaseDeviceLabelSessions(base, undefined)).toEqual([label]);
    await plan.settle();
    expect(scenario.releases).toEqual([
      expect.objectContaining({ sessionId: label, reason: "plan-auto-release" }),
    ]);
    expect(scenario.isHeld(base)).toBe(true);
    expectFreed(DEVICE_B);

    // Past the 60 s budget the unheld device is dropped from the pool, with no second release.
    await scenario.idle(70_000);
    expect(scenario.releases).toHaveLength(1);
    expect(listing.episodes()).toEqual([]);
    expect(await persistedRow(scenario, label)).toMatchObject({
      status: "released",
      reason: "plan-auto-release",
    });
    expect(scenario.poolState(DEVICE_A)).toMatchObject({ status: "busy", sessionId: base });
    expect(await mcpVerdict(scenario, base)).toEqual({ ok: true });
  });
});
