import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { DAEMON_CANCEL_REQUEST_METHOD } from "../../src/daemon/constants";
import type { DaemonRequest } from "../../src/daemon/types";
import { DeviceDataStreamSocketServer } from "../../src/daemon/deviceDataStreamSocketServer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { routedSessionUuidFromResult } from "../../src/server/routedSessionMeta";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { SESSION_RELEASE_PERSIST_TIMEOUT_MS } from "../../src/daemon/sessionManager";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import { decideOwnershipChange } from "../../src/daemon/streamSubscriptionPolicy";
import { LIVE_OWNER_HANDOFF_ALLOWANCE_MS } from "../../src/daemon/proxyLivenessRecovery";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { UNSETTLED_EXECUTION_VETO_CEILING_MS } from "../../src/daemon/unsettledExecutionVeto";
import { OWNER_DISCONNECT_GRACE_MS } from "../../src/daemon/ownerDisconnectRelease";
import { AppearanceSyncScheduler } from "../../src/daemon/AppearanceSyncScheduler";
import type { AppearanceConfig } from "../../src/models";
import {
  AUTOLOCK_WINDOW_MS,
  IDLE_WINDOW_MS,
  KEEPER_INTERVAL_MS,
  LivenessScenario,
  NO_HEARTBEAT_BUDGET_MS,
  OWNER_TOKEN,
  PEER_DAEMON_PID,
  RELEASE_SLACK_MS,
  SCENARIO_DAEMON_PID,
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
// A `cli-idle` session is reaped by the heartbeat monitor on its own idle clock.
const CLI_IDLE_REASONS = [...IDLE_REASONS, "cli-idle-timeout"];
// Emulator serials: tool calls run the real session setup, which probes a non-emulator serial
// for keep-awake over adb.
const DEVICE_A = "emulator-5554";
const DEVICE_B = "emulator-5556";

let scenario: LivenessScenario;

/** One event-loop turn for real socket I/O to settle (a 2 ms sleep cost ~2 ms per poll spin). */
function realIoTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// The first scenario pays for module-level one-time costs (database template, Daemon module graph);
// beforeAll is outside the per-test budget, and the first row would otherwise sit at ~70 ms of 100.
// Run one full acquire -> tool call -> idle release cycle too: the first acquire alone pays ~14 ms
// of one-time module work (session setup, tool dispatch, release path) that would otherwise land
// in whichever row runs first.
beforeAll(async () => {
  const warm = await LivenessScenario.start();
  const session = await warm.acquire();
  await warm.toolCall(session);
  await warm.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS);
  await warm.stop();
});

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
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const a = await scenario.acquire(DEVICE_A);
    const aLastUsedAt = scenario.timer.now();
    await scenario.idle(30_000);
    const b = await scenario.acquire(DEVICE_B);

    // Held side: B keeps being used, so it outlives A's window; A is still held until then.
    await scenario.idle(70_000);
    await scenario.toolCall(b);
    expectHeld(a, DEVICE_A);
    expectHeld(b, DEVICE_B);

    // Released side: A, never used again, goes at its own deadline while B stays.
    const releasedAt = await scenario.idleUntilReleased(a, IDLE_WINDOW_MS);
    expect(releasedAt).toBeGreaterThan(aLastUsedAt + IDLE_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(aLastUsedAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expectFreed(DEVICE_A);
    expectHeld(b, DEVICE_B);
  });

  test("a long-running call in flight past the window keeps the session; it is freed one window after the call settles", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    await scenario.idle(IDLE_WINDOW_MS / 2);
    const call = scenario.startLongCall(session);

    // Held side: the window that began at acquisition ends with the call open. The call runs
    // 110 s, inside its own 120 s request deadline.
    expect(await scenario.idleWhileHeld(session, IDLE_WINDOW_MS + 50_000, 10_000)).toBe(undefined);
    expectHeld(session);
    expect(call.failure()).toBeUndefined();

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

describe("the daemon's idle instant outranks the proxy's own idle clock (#10823)", () => {
  test("a call the proxy never saw restarts the daemon's window: the session outlives the proxy's own window, then the daemon's window frees it", async () => {
    scenario = await LivenessScenario.start();
    const acquiredAt = scenario.timer.now();
    const session = await scenario.acquire();

    // A call on the proxy's own daemon connection that bypasses the proxy (another path on the
    // same host, e.g. a tool call replayed by the host): the daemon sees use, the proxy does not.
    await scenario.idle(IDLE_WINDOW_MS - 20_000);
    // A control call: no read counts as use (#10964).
    await scenario.daemonToolCallWith(
      { sessionUuid: session },
      "homeScreen",
      scenario.proxyConnection,
    );
    const usedAt = scenario.timer.now();

    // Held side: past the proxy's own window (it last saw use at acquisition) the proxy keeps
    // heartbeating, because the daemon's heartbeat acks report the later idle instant.
    expect(scenario.timer.now() - acquiredAt).toBeLessThan(IDLE_WINDOW_MS);
    expect(await scenario.idleWhileHeld(session, usedAt + IDLE_WINDOW_MS - 15_000, 5_000)).toBe(
      undefined,
    );
    expect(scenario.timer.now() - acquiredAt).toBeGreaterThan(IDLE_WINDOW_MS);
    expectHeld(session);

    // Released side: the daemon's window, counted from the unseen call, still frees it.
    const releasedAt = await scenario.idleUntilReleased(session, 15_000 + RELEASE_SLACK_MS);
    expect(releasedAt).toBeGreaterThan(usedAt + IDLE_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(usedAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
    // The probe above may itself have been the lazy expiry; let the pool's unbind settle.
    await scenario.idle(1_000);
    expectFreed();
  });

  // #10972 part 1 (#11442 h2): the keeper evicts a held session before the tick's heartbeats, so
  // at the reported instant it still reads the ack from one interval earlier. A call the daemon
  // admitted in between (inside its grace) moved the instant: the passed instant is not evidence,
  // only a heartbeat answered at or after it is.
  for (const beforeInstantMs of [KEEPER_INTERVAL_MS - 100, 500]) {
    test(`a held session used ${beforeInstantMs} ms before its reported idle instant is not dropped on the stale report: it stays heartbeated and is freed as idle one window after that call`, async () => {
      scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
      const a = await scenario.acquire(DEVICE_A);
      await scenario.idle(30_000);
      // B becomes the latest binding; A is now held behind it.
      const b = await scenario.acquire(DEVICE_B);
      const reportedInstant = (
        (await scenario.daemonMethod("daemon/sessionInfo", { sessionId: a })) as {
          result: { idleReleaseAt: number };
        }
      ).result.idleReleaseAt;

      // The agent keeps driving B; A is used once, inside the last keeper interval before its
      // instant, by a call the proxy never saw: no ack before the instant can report the restart.
      await scenario.idle(60_000);
      await scenario.toolCall(b);
      await scenario.idle(reportedInstant - beforeInstantMs - scenario.timer.now());
      await scenario.daemonToolCallWith({ sessionUuid: a }, "homeScreen", scenario.proxyConnection);
      const usedAt = scenario.timer.now();
      expect(reportedInstant - usedAt).toBeLessThan(KEEPER_INTERVAL_MS);
      const beatsBeforeInstant = scenario.heartbeatsBySession.get(a) ?? 0;

      // Held side: the proxy heartbeats A through the stale instant and the whole new window, so
      // the daemon never sees a silent owner.
      const heldUntil = usedAt + IDLE_WINDOW_MS - 15_000;
      for (let at = usedAt + 30_000; at < heldUntil; at += 30_000) {
        expect(await scenario.idleWhileHeld(a, at, 5_000)).toBe(undefined);
        await scenario.toolCall(b);
      }
      expect(await scenario.idleWhileHeld(a, heldUntil, 5_000)).toBe(undefined);
      expectHeld(a, DEVICE_A);
      expect(scenario.reaped).toEqual([]);
      expect(scenario.heartbeatsBySession.get(a) ?? 0).toBeGreaterThanOrEqual(
        beatsBeforeInstant + (heldUntil - reportedInstant) / KEEPER_INTERVAL_MS,
      );

      // Released side: the daemon's window, counted from that call, frees A as an idle expiry.
      const releasedAt = await scenario.idleUntilReleased(a, 15_000 + RELEASE_SLACK_MS);
      expect(releasedAt).toBeGreaterThan(usedAt + IDLE_WINDOW_MS);
      expect(releasedAt).toBeLessThanOrEqual(usedAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
      expect(IDLE_REASONS).toContain(scenario.releaseOf(a)?.reason!);
      expect(scenario.reaped).toEqual([]);
      await scenario.idle(1_000);
      expectFreed(DEVICE_A);
      expectHeld(b, DEVICE_B);
    });
  }
});

describe("daemon release wiring (#10975)", () => {
  test("an idle expiry stops the recordings the session owns on its device", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();

    // Held side: nothing is stopped while the session is held and used.
    await scenario.idle(30_000);
    await scenario.toolCall(session);
    expect(scenario.sessionRecordingStops).toEqual([]);

    // Released side: the window ends, the release stops the recording on the freed device.
    expect(
      await scenario.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS),
    ).toBeDefined();
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
    expect(scenario.sessionRecordingStops).toEqual([{ sessionId: session, deviceId: DEVICE_A }]);
    expectFreed();
  });

  test("a silent owner's release stops the recordings the session owns on its device", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    await scenario.idle(30_000);
    expect(scenario.sessionRecordingStops).toEqual([]);

    scenario.dropHeartbeats = true;
    expect(
      await scenario.idleUntilReleased(session, NO_HEARTBEAT_BUDGET_MS + RELEASE_SLACK_MS),
    ).toBeDefined();
    expect(scenario.sessionRecordingStops).toEqual([{ sessionId: session, deviceId: DEVICE_A }]);
    expectFreed();
  });

  test("a late terminal release of an idle-released session leaves its successor's pin and hold alone (#10825)", async () => {
    scenario = await LivenessScenario.start();
    const first = await scenario.acquire();
    const captured = scenario.daemon.manager.getSession(first)!;
    expect(
      await scenario.idleUntilReleased(first, IDLE_WINDOW_MS + RELEASE_SLACK_MS),
    ).toBeDefined();
    await scenario.idle(1_000);

    // The device passes to a new owner, who pins it.
    const second = await scenario.acquire();
    expect(second).not.toBe(first);
    DeviceSessionManager.getInstance().setExplicitDevicePin({
      deviceId: DEVICE_A,
      name: DEVICE_A,
      platform: "android",
    });

    try {
      // Held side: a killDevice-style terminal release of the FIRST session arrives late.
      await scenario.daemon.manager.releaseSessionIfOwned(
        first,
        captured,
        DEVICE_A,
        "device-killed",
      );
      expect(DeviceSessionManager.getInstance().getExplicitDevicePin()?.deviceId).toBe(DEVICE_A);
      expectHeld(second);

      // Released side: the successor's own idle release does clear its pin.
      expect(
        await scenario.idleUntilReleased(second, IDLE_WINDOW_MS + RELEASE_SLACK_MS),
      ).toBeDefined();
      expect(DeviceSessionManager.getInstance().getExplicitDevicePin()).toBeUndefined();
    } finally {
      DeviceSessionManager.getInstance().clearExplicitDevicePin(DEVICE_A);
    }
  });

  // One scenario of two halves, split so each half carries its own simulated minutes (the held half
  // 6 of them, the release half 40): together they were ~30 ms locally, ~100 ms on a loaded runner.
  test("a call that never settles holds the session past the idle window, answering the caller with a timeout and aborting nothing (#10820)", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    // The device command is wedged: it outlives its request deadline and every signal to stop.
    const call = scenario.startLongCall(session, undefined, { wedged: true });

    // Held side: the caller is answered with a timeout at the request deadline, but the call is
    // still in flight on the device, so the session is kept and the daemon aborts nothing.
    expect(await scenario.idleWhileHeld(session, 3 * IDLE_WINDOW_MS, 60_000)).toBe(undefined);
    expectHeld(session);
    expect(String(call.failure())).toContain("timed out");
    expect(scenario.abortedCalls).toEqual([]);
    await call.settle();
  });

  test("when the veto ceiling lets the expiry through, the never-settling call is aborted and the device freed (#10820)", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    const startedAt = scenario.timer.now();
    const call = scenario.startLongCall(session, undefined, { wedged: true });

    // Held until the ceiling; past it the expiry overrides the veto and aborts what it overrode.
    const releasedAt = await scenario.idleWhileHeld(
      session,
      startedAt + UNSETTLED_EXECUTION_VETO_CEILING_MS + 2 * IDLE_WINDOW_MS,
      300_000,
    );
    expect(releasedAt).toBeDefined();
    expect(scenario.abortedCalls).toEqual([session]);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
    expectFreed();
    await call.settle();
  });
});

describe("a stream subscriber on a held device (#10840)", () => {
  // A video/WebRTC owner subscription re-authorizes on every session release broadcast and is
  // ended with `session_ended` once its session no longer exists (decideOwnershipChange).
  const subscriberDecision = (sessionId: string) =>
    decideOwnershipChange({
      kind: "owner",
      authEnabled: true,
      sessionExists: scenario.isHeld(sessionId),
      ownsDevice: scenario.poolState().sessionId === sessionId,
    });

  test("the subscription is kept while the session is used; the idle release broadcasts once and ends it with session_ended", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();

    // Held side: used across two windows, so nothing is broadcast and the subscriber is kept.
    for (let call = 0; call < 4; call++) {
      await scenario.idle(IDLE_WINDOW_MS / 2);
      await scenario.toolCall(session);
      expect(subscriberDecision(session)).toEqual({ action: "keep" });
    }
    expect(scenario.releaseBroadcasts).toEqual([]);

    // Released side: the idle release is the broadcast that re-authorizes the subscriber.
    const lastCallAt = scenario.timer.now();
    const releasedAt = await scenario.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(releasedAt).toBeGreaterThan(lastCallAt + IDLE_WINDOW_MS);
    expect(scenario.releaseBroadcasts).toEqual([
      {
        at: releasedAt!,
        sessionId: session,
        reason: expect.stringMatching(/^(cleanup-expired|lazy-expiry)$/),
      },
    ]);
    expect(subscriberDecision(session)).toEqual({ action: "end", reason: "session_ended" });
    expectFreed();
  });
});

describe("after an idle release", () => {
  test("the agent's next call naming the released session is refused and the device stays idle (#10839)", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    await scenario.toolCall(session);
    expect(
      await scenario.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS),
    ).toBeDefined();
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
    expectFreed();
    const refusal = (call: Promise<unknown>) =>
      call.then(
        () => undefined,
        (error: unknown) => error,
      );

    // The agent's own proxy refuses it, and so does the daemon for a caller with no proxy in front
    // (--cli, desktop, JUnit), before and after a restart, when only the persisted row remembers
    // the release. Nothing rebinds the device.
    expect(await refusal(scenario.toolCall(session))).toBeInstanceOf(Error);
    expect(await refusal(scenario.daemonToolCall(session))).toBeInstanceOf(Error);
    expectFreed();
    await scenario.daemonRestart();
    expect(await refusal(scenario.daemonToolCall(session))).toBeInstanceOf(Error);
    expect(scenario.isHeld(session)).toBe(false);
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

  test("a long call past the 60 s window survives a concurrent routing lookup; freed one window after it settles (#10956)", async () => {
    scenario = await LivenessScenario.start({ autolock: true });
    const session = await scenario.acquire();
    const call = scenario.startLongCall(session);

    // Held side: past the window with the call open, another request on the same connection
    // resolves its autolock routing (no execution metadata). It must not release the session.
    // The call runs 110 s: past the 60 s window, inside its own 120 s request deadline.
    for (const wait of [AUTOLOCK_WINDOW_MS + 10_000, 40_000]) {
      await scenario.idle(wait);
      expect(
        scenario.daemon.pool.resolveAutolockSessionForMcpSession(scenario.proxyConnection),
      ).toBe(session);
      expectHeld(session);
    }
    expect(scenario.releaseOf(session)).toBeUndefined();

    // Released side: the window runs from the END of the call.
    await call.settle();
    const settledAt = scenario.timer.now();
    const releasedAt = await scenario.idleUntilReleased(
      session,
      AUTOLOCK_WINDOW_MS + RELEASE_SLACK_MS,
    );
    expect(releasedAt).toBeGreaterThan(settledAt + AUTOLOCK_WINDOW_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
    expectFreed();
  });

  test("a silent owner (proxy dead, connection never closed) is freed in about 10 s, not after the 60 s window (#10729)", async () => {
    scenario = await LivenessScenario.start({ autolock: true });
    const session = await scenario.acquire();
    await scenario.idle(20_000);
    await scenario.toolCall(session);
    expectHeld(session);

    const silentSince = scenario.timer.now();
    scenario.dropHeartbeats = true;
    const releasedAt = await scenario.idleUntilReleased(session, 2 * NO_HEARTBEAT_BUDGET_MS);
    expect(releasedAt).toBeLessThanOrEqual(silentSince + NO_HEARTBEAT_BUDGET_MS);
    expect(scenario.releaseOf(session)?.reason).toBe("heartbeat-timeout");
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

  test("focused with tokenless heartbeats but no input: held until the idle window, then freed as idle (#10839)", async () => {
    scenario = await LivenessScenario.start();
    const acquiredAt = scenario.timer.now();
    const session = await scenario.acquireTokenless();
    const focus = scenario.startTokenlessHeartbeats(session);

    // Held side: the heartbeats prove the client is alive, so nothing frees it early.
    expect(await scenario.idleWhileHeld(session, acquiredAt + IDLE_WINDOW_MS - 10_000)).toBe(
      undefined,
    );
    expectHeld(session);

    // Released side: watching is not use, so a tokenless heartbeat never restarts the idle window.
    const releasedAt = await scenario.idleUntilReleased(session, 2 * RELEASE_SLACK_MS);
    focus.stop();
    expect(releasedAt).toBeDefined();
    expect(releasedAt!).toBeLessThanOrEqual(acquiredAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
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

      // Host sleep counts toward the idle window whatever its length (#10699); sleep past the
      // window plus grace so the session is due on wake.
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

      // The window lapsed in the sleep: freed on wake, never held "per timer". Sleep never lapses
      // the heartbeat lease (no owner on a sleeping host can heartbeat), so the release is idle
      // expiry, not a heartbeat timeout (#10699).
      expect(releasedAt).toBeDefined();
      expect(releasedAt! - sleptAt).toBeLessThanOrEqual(
        IDLE_WINDOW_MS + SUSPECT_GRACE_MS + 2 * SCAN_MS + RELEASE_SLACK_MS,
      );
      expect(["lazy-expiry", "cleanup-expired"]).toContain(scenario.releaseOf(session)?.reason);
      expectFreed();
    });
  }
});

describe("desktop actor driven from the checked-in wire fixtures (#10669)", () => {
  test("a watch-only desktop's recorded frames hold nothing for ten minutes, and the daemon answers as recorded", async () => {
    scenario = await LivenessScenario.start();

    const replay = await scenario.replayDesktopFixture("watching-allocates-nothing");

    expect(replay.skipped).toEqual([]);
    expect(replay.mismatches).toEqual([]);
    expect(scenario.poolState()).toEqual({
      status: "idle",
      sessionId: null,
      autolockSessionId: undefined,
    });
    expect(scenario.releases).toEqual([]);
  });

  test("a desktop that registers and heartbeats without a click starts holding no device", async () => {
    scenario = await LivenessScenario.start();

    const replay = await scenario.replayDesktopFixture("no-click-start");

    expect(replay.skipped).toEqual([]);
    expect(replay.mismatches).toEqual([]);
    expect(scenario.releases).toEqual([]);
  });
});

describe("daemon event-loop stall: the ticks arrive late (#10662)", () => {
  // Far past the 10 s heartbeat lease and its suspect grace, well inside the idle window.
  const STALL_MS = SUSPECT_GRACE_MS + 20_000;

  test("a stall past the lease keeps a live owner's session: the lost time is the daemon's", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    await scenario.idle(5_000);
    await scenario.toolCall(session);

    scenario.lateTicks(STALL_MS);
    await scenario.idle(SCAN_MS + KEEPER_INTERVAL_MS);

    expectHeld(session);
    expect(scenario.releases).toEqual([]);
  });

  test("an owner that is really gone is still freed after the stall, by heartbeat timeout", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    await scenario.idle(5_000);
    await scenario.toolCall(session);
    await scenario.closeTransport();

    scenario.lateTicks(STALL_MS);
    const releasedAt = await scenario.idleUntilReleased(session, 3 * RELEASE_SLACK_MS);

    expect(releasedAt).toBeDefined();
    expect(scenario.releaseOf(session)?.reason).toMatch(/heartbeat-timeout|owner-disconnect/);
    expectFreed();
  });
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
    // The owner keeps using the session so the idle window never ends this scenario.
    await scenario.toolCall(session);

    // Released side: the daemon reports the live owner's hold with each refusal (the harness now
    // carries ack payloads like the real client), so the challenger waits out the handoff
    // allowance and then gives up claiming; its heartbeats for the session stop.
    await scenario.idle(LIVE_OWNER_HANDOFF_ALLOWANCE_MS + 2 * KEEPER_INTERVAL_MS);
    await scenario.toolCall(session);
    const before = scenario.heartbeatsByToken.get("challenger-owner") ?? 0;
    expect(before).toBeGreaterThan(0);
    await scenario.idle(60_000);
    expect(scenario.heartbeatsByToken.get("challenger-owner") ?? 0).toBe(before);
    expect(scenario.daemon.manager.getSession(session)?.livenessOwnerToken).toBe(OWNER_TOKEN);
    await challenger.close();
  });
});

describe("selector-routed calls (#10821)", () => {
  test("a provisionDevice session driven only by deviceId beside a second session stays held; it is freed one window after its last call", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const provisioned = await scenario.provision(DEVICE_A);
    const other = await scenario.acquire(DEVICE_B);

    // Held side: A is used every minute through its device id for four idle windows. The proxy
    // must credit those calls to the provisioned session, or it stops heartbeating it.
    const callEvery = 60_000;
    for (let call = 0; call < (4 * IDLE_WINDOW_MS) / callEvery; call++) {
      await scenario.idle(callEvery);
      await scenario.selectorCall(DEVICE_A);
    }
    expectHeld(provisioned, DEVICE_A);
    expect(scenario.reaped).toEqual([]);
    expect(scenario.driven.filter((run) => run.deviceId === DEVICE_A).length).toBeGreaterThan(0);
    // The session nobody names goes at its own idle deadline, not A's.
    expect(scenario.isHeld(other)).toBe(false);
    expectFreed(DEVICE_B);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(other)?.reason!);

    // Released side: the last selector call's window then frees A as idle, not as a lost owner.
    const lastCallAt = scenario.timer.now();
    const releasedAt = await scenario.idleUntilReleased(
      provisioned,
      IDLE_WINDOW_MS + RELEASE_SLACK_MS,
    );
    expect(releasedAt).toBeGreaterThan(lastCallAt + IDLE_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(lastCallAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(provisioned)?.reason!);
    expect(scenario.reaped).toEqual([]);
    expectFreed(DEVICE_A);
  });
});

describe("the daemon echoes the session a call used (#10974)", () => {
  test("a holder's deviceId control call echoes its session; a read of the same device echoes none", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A] });
    const session = await scenario.acquire(DEVICE_A);

    const control = await scenario.daemonToolCallWith(
      { deviceId: DEVICE_A, orientation: "portrait" },
      "rotate",
      scenario.proxyConnection,
    );
    const read = await scenario.daemonToolCallWith(
      { deviceId: DEVICE_A },
      "observe",
      scenario.proxyConnection,
    );

    expect(routedSessionUuidFromResult(control)).toBe(session);
    expect(routedSessionUuidFromResult(read)).toBeUndefined();
  });
});

describe("host appearance sync follows the session that holds the device (#8361, #10976)", () => {
  const DEVICE_C = "emulator-5558";
  const config = (defaultMode: "light" | "dark"): AppearanceConfig => ({
    syncWithHost: true,
    defaultMode,
    applyOnConnect: true,
  });

  // #11442 o2: both target sources must name only held devices, each with its holder's session.
  // The scheduler's own source is what a sync runs on until the daemon scopes it at startup.
  for (const source of ["the running daemon's scope", "the scheduler's own targets"] as const) {
    test(`two sessions with different configs and a free device, from ${source}: a tick applies each config to its holder's device only, and a freed device is left alone`, async () => {
      scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B, DEVICE_C] });
      const a = await scenario.acquire(DEVICE_A);
      const b = await scenario.acquire(DEVICE_B);
      // The global config would turn any device it reached dark.
      const configs = new Map<string | undefined, AppearanceConfig>([
        [a, config("light")],
        [b, config("dark")],
      ]);
      const applied: string[] = [];
      const scheduler = new AppearanceSyncScheduler(scenario.timer, {
        isEnabled: () => true,
        getConfig: async (sessionKey) => configs.get(sessionKey) ?? config("dark"),
        resolveMode: async (resolved) => (resolved?.defaultMode === "dark" ? "dark" : "light"),
        apply: async (device, mode) => {
          applied.push(`${device.deviceId}:${mode}`);
        },
        ...(source === "the running daemon's scope"
          ? { getTargets: () => scenario.appearanceSyncTargets() }
          : {}),
      });

      // Held side: each held device gets its own session's mode; the free device gets nothing.
      await scheduler.trigger();
      expect(applied.toSorted()).toEqual([`${DEVICE_A}:light`, `${DEVICE_B}:dark`]);

      // Released side: once A's session idles out, no tick re-themes its device from the global
      // config, while B's session still decides for B.
      for (let step = 0; step < 6 && scenario.isHeld(a); step++) {
        await scenario.idle(30_000);
        await scenario.toolCall(b);
      }
      await scenario.idle(1_000);
      expectFreed(DEVICE_A);
      expectHeld(b, DEVICE_B);
      configs.set(b, config("light"));
      applied.length = 0;
      await scheduler.trigger();
      expect(applied).toEqual([`${DEVICE_B}:light`]);
      await scheduler.stop();
    });
  }
});

describe("reads are not activity (#10964)", () => {
  test("a session whose owner only observes by deviceId is freed one idle window after acquisition", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A] });
    const acquiredAt = scenario.timer.now();
    const provisioned = await scenario.provision(DEVICE_A);

    // Held side: observing every 30 s inside the first window neither refreshes nor loses it.
    for (let elapsed = 30_000; elapsed < IDLE_WINDOW_MS; elapsed += 30_000) {
      await scenario.idle(30_000);
      await scenario.selectorCall(DEVICE_A, "observe", {});
    }
    expectHeld(provisioned, DEVICE_A);

    // Released side: the window ran from acquisition, not from the last observe.
    const lastObserveAt = scenario.timer.now();
    const releasedAt = await scenario.idleUntilReleased(
      provisioned,
      IDLE_WINDOW_MS + RELEASE_SLACK_MS,
    );
    expect(releasedAt).toBeDefined();
    expect(releasedAt!).toBeLessThanOrEqual(acquiredAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(releasedAt!).toBeLessThan(lastObserveAt + IDLE_WINDOW_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(provisioned)?.reason!);
    expectFreed(DEVICE_A);
  });
});

const rejection = (call: Promise<unknown>) =>
  call.then(
    () => undefined,
    (error: unknown) => error as Error,
  );

describe("another session names a device the agent holds", () => {
  test("every foreign call is refused and never drives the device; the holder keeps it, and the refusals do not extend its idle window (#10698)", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const holder = await scenario.acquire(DEVICE_A);
    const intruder = await scenario.acquireTokenless(DEVICE_B);
    const intruderBeats = scenario.startTokenlessHeartbeats(intruder);
    await scenario.toolCall(holder);
    const lastCallAt = scenario.timer.now();

    // Held side: a foreign session (its own device does not match) and a sessionless caller (the ownership refusal) are refused again and again over most
    // of the window; the holder is untouched and still drives its own device.
    const driven = () => scenario.driven.filter((run) => run.deviceId === DEVICE_A).length;
    const drivenBefore = driven();
    const readinessBefore = scenario.readinessTouches;
    for (let attempt = 0; attempt < 8; attempt++) {
      await scenario.idle(10_000);
      const foreign = await rejection(
        scenario.daemonToolCallWith(
          { sessionUuid: intruder, deviceId: DEVICE_A, orientation: "landscape" },
          "rotate",
        ),
      );
      expect(foreign).toBeInstanceOf(Error);
      const sessionless = await rejection(
        scenario.daemonToolCallWith({ deviceId: DEVICE_A, orientation: "landscape" }, "rotate"),
      );
      expect(sessionless?.message).toContain("held by another session");
    }
    // Refused calls never touched the device: the refusal comes before readiness (#10828).
    expect(scenario.readinessTouches).toBe(readinessBefore);
    expect(driven()).toBe(drivenBefore);
    expectHeld(holder, DEVICE_A);
    expectHeld(intruder, DEVICE_B);

    // Released side: refused calls are not use, so the holder is freed one window after ITS last
    // call, and the intruder's own device is untouched by the whole exchange.
    const releasedAt = await scenario.idleUntilReleased(holder, IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    intruderBeats.stop();
    expect(releasedAt).toBeGreaterThan(lastCallAt + IDLE_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(lastCallAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(holder)?.reason!);
    expectFreed(DEVICE_A);
  });
});

describe("a sessionless watcher reads a device the agent holds (#10830)", () => {
  test("every read succeeds on the read-only path, never drives or readies the device, and does not extend the holder's idle window", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const holder = await scenario.acquire(DEVICE_A);
    await scenario.toolCall(holder);
    const lastCallAt = scenario.timer.now();
    const drivenBefore = scenario.driven.length;
    const readinessBefore = scenario.readinessTouches;

    // Held side: the watcher observes the held device again and again over most of the window.
    for (let attempt = 0; attempt < 8; attempt++) {
      await scenario.idle(10_000);
      expect(
        await rejection(scenario.daemonToolCallWith({ deviceId: DEVICE_A, display: "all" })),
      ).toBeUndefined();
      expectHeld(holder, DEVICE_A);
    }
    // Watching is the observer capture, not the control path: no tool body reached the device,
    // nothing was readied, and each read resolved the device from the booted list.
    expect(scenario.watched.reads).toEqual(Array(8).fill(DEVICE_A));
    expect(scenario.watched.resolutions).toBe(8);
    expect(scenario.driven.length).toBe(drivenBefore);
    expect(scenario.readinessTouches).toBe(readinessBefore);

    // Released side: watching is not use, so the holder is freed one window after ITS last call.
    const releasedAt = await scenario.idleUntilReleased(holder, IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(releasedAt).toBeGreaterThan(lastCallAt + IDLE_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(lastCallAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(holder)?.reason!);
    expectFreed(DEVICE_A);
  });
});

describe("IDE retries setActiveDevice after a refusal (#10660)", () => {
  test("refused for as long as the agent holds the device, without costing the agent its window or the IDE its own device; granted once the agent's session is freed", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const agent = await scenario.acquire(DEVICE_A);
    const ide = await scenario.acquireTokenless(DEVICE_B);
    const ideBeats = scenario.startTokenlessHeartbeats(ide);
    await scenario.toolCall(agent);
    const lastCallAt = scenario.timer.now();
    // The IDE retries on the connection that acquired its session: any other is refused (#11344).
    const retry = () =>
      scenario.daemonToolCallWith(
        { deviceId: DEVICE_A, sessionUuid: ide },
        "setActiveDevice",
        "desktop-connection",
      );

    // Held side: the IDE keeps retrying; every attempt is refused and the agent keeps the device.
    for (let attempt = 0; attempt < 8; attempt++) {
      await scenario.idle(10_000);
      const refused = await rejection(retry());
      expect(refused?.message ?? "").toContain(`already assigned to session ${agent}`);
      expectHeld(agent, DEVICE_A);
      expectHeld(ide, DEVICE_B);
    }
    // The IDE uses its own device once, so its own idle window outlasts the agent's: an idle
    // release is terminal (#11258), and an idle-released IDE session could not be moved.
    expect(await rejection(scenario.daemonToolCall(ide))).toBeUndefined();

    // Released side: the refusals were not the agent's use, so its window ends on schedule; the
    // next retry then succeeds and moves the IDE's session onto the freed device.
    const releasedAt = await scenario.idleUntilReleased(agent, IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(releasedAt).toBeLessThanOrEqual(lastCallAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(agent)?.reason!);
    expect(await rejection(retry())).toBeUndefined();
    ideBeats.stop();
    expectHeld(ide, DEVICE_A);
    expectFreed(DEVICE_B);
  });
});

describe("a --cli session held by a `--daemon heartbeat` keeper", () => {
  test("tool calls inside the window and keeper ticks hold it; keeper ticks alone never extend the idle window", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquireTokenless();
    const keeper = scenario.startCliKeeper(session);

    // Held side: a --cli call every 90 s (its own process, no proxy) keeps it across five windows.
    for (let call = 0; call < 5; call++) {
      expect(await scenario.idleWhileHeld(session, scenario.timer.now() + 90_000, 30_000)).toBe(
        undefined,
      );
      await scenario.daemonToolCall(session);
    }
    expectHeld(session);
    expect(scenario.daemon.manager.getSession(session)?.livenessPolicy).toBe("cli-idle");
    const lastCallAt = scenario.timer.now();

    // Released side: the keeper keeps ticking, but watching is not use: one window after the last
    // call the session is freed as idle, not as a lost owner.
    const releasedAt = await scenario.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    keeper.stop();
    expect(releasedAt).toBeGreaterThan(lastCallAt + IDLE_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(lastCallAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(CLI_IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
    expectFreed();
  });

  test("a keeper that stops mid-window does not free it early, because a one-shot process cannot beat every 10 s; the window frees it", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquireTokenless();
    const keeper = scenario.startCliKeeper(session);
    await scenario.daemonToolCall(session);
    const lastCallAt = scenario.timer.now();
    await scenario.idle(20_000);
    keeper.stop();

    // Held side: with no keeper and no proxy, a cli-idle session waits out the idle window.
    expect(await scenario.idleWhileHeld(session, lastCallAt + IDLE_WINDOW_MS - 10_000)).toBe(
      undefined,
    );
    expectHeld(session);

    // Released side.
    const releasedAt = await scenario.idleUntilReleased(session, 2 * RELEASE_SLACK_MS);
    expect(releasedAt).toBeLessThanOrEqual(lastCallAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expectFreed();
  });
});

describe("a JUnit runner: 1 s HTTP heartbeats plus socket tool calls", () => {
  test("a test run that calls tools through the window stays held; when the run ends the session is freed within the no-heartbeat budget", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquireTokenless();
    const beats = scenario.startJunitHeartbeats(session);

    // Held side: a tool call every 100 s for five minutes.
    for (let call = 0; call < 3; call++) {
      expect(await scenario.idleWhileHeld(session, scenario.timer.now() + 100_000, 20_000)).toBe(
        undefined,
      );
      await scenario.daemonToolCall(session);
    }
    expectHeld(session);

    // Released side: the run ends (the process exits, so the beats stop with it).
    beats.stop();
    const endedAt = scenario.timer.now();
    const releasedAt = await scenario.idleUntilReleased(session, 2 * NO_HEARTBEAT_BUDGET_MS);
    expect(releasedAt).toBeLessThanOrEqual(endedAt + NO_HEARTBEAT_BUDGET_MS);
    expectFreed();
  });

  test("a run that heartbeats but stops calling tools is freed one window after its last call, though its beats never stop", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquireTokenless();
    const beats = scenario.startJunitHeartbeats(session);
    await scenario.daemonToolCall(session);
    const lastCallAt = scenario.timer.now();

    expect(await scenario.idleWhileHeld(session, lastCallAt + IDLE_WINDOW_MS - 10_000)).toBe(
      undefined,
    );
    expectHeld(session);

    const releasedAt = await scenario.idleUntilReleased(session, 2 * RELEASE_SLACK_MS);
    beats.stop();
    expect(releasedAt).toBeGreaterThan(lastCallAt + IDLE_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(lastCallAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
    expectFreed();
  });
});

describe("the activity write fails under a heartbeating owner (#11079, #11085)", () => {
  test("a rejecting activity repository never releases a live owner; once the owner falls silent it is freed in about 10 s", async () => {
    scenario = await LivenessScenario.start();
    const writes = spyOn(scenario.repository, "recordActivity").mockRejectedValue(
      new Error("SQLITE_FULL: database or disk is full"),
    );
    const session = await scenario.acquire();

    // Held side: every beat's activity write fails, yet the lease stays acknowledged for as long
    // as the owner beats (several lease + grace windows).
    expect(await scenario.idleWhileHeld(session, scenario.timer.now() + 60_000, 5_000)).toBe(
      undefined,
    );
    expectHeld(session);
    expect(writes).toHaveBeenCalled();
    expect(scenario.reaped).toEqual([]);

    // Released side: the failing database does not keep a silent owner either.
    const silentSince = scenario.timer.now();
    scenario.dropHeartbeats = true;
    const releasedAt = await scenario.idleUntilReleased(session, 2 * NO_HEARTBEAT_BUDGET_MS);
    expect(releasedAt).toBeLessThanOrEqual(silentSince + NO_HEARTBEAT_BUDGET_MS);
    expect(scenario.releaseOf(session)?.reason).toBe("heartbeat-timeout");
    expectFreed();
  });
});

/** The observation stream server listening on the process-wide observer-release broadcaster. */
class ObservationStreamForScenario extends DeviceDataStreamSocketServer {
  constructor(timer: LivenessScenario["timer"]) {
    super("/fake/path/matrix.sock", timer, { authorize: () => {} });
  }

  start(): void {
    (this as unknown as { server: unknown }).server = { listening: true };
    (this as unknown as { onServerStarted(): void }).onServerStarted();
  }

  stopListening(): void {
    (this as unknown as { onServerClosing(): void }).onServerClosing();
    (this as unknown as { server: unknown }).server = null;
  }

  async viewerSubscribes(socket: FakeSocket, sessionUuid: string): Promise<void> {
    await (this as unknown as { processLine(s: Socket, line: string): Promise<void> }).processLine(
      socket as unknown as Socket,
      JSON.stringify({ command: "subscribe", sessionUuid }),
    );
  }
}

describe("a viewer stream follows its observer registration (#11076, #11084)", () => {
  const OBSERVER = "d0000000-0000-4000-8000-000000000011";
  const DESKTOP_BEAT_MS = 2_000;
  // The stream's keepalive pings are not what is asserted on.
  const errorFrames = (socket: FakeSocket) =>
    socket.getWrittenMessages().filter((message) => message.type === "error");

  test("an observer that heartbeats keeps its observation stream; one that stops has it ended with session_ended", async () => {
    scenario = await LivenessScenario.start();
    const stream = new ObservationStreamForScenario(scenario.timer);
    stream.start();
    try {
      const registered = await scenario.daemonMethod("daemon/registerSession", {
        sessionId: OBSERVER,
        clientName: "AutoMobile Desktop",
      });
      expect(registered.success).toBe(true);
      const viewer = new FakeSocket();
      await stream.viewerSubscribes(viewer, OBSERVER);
      expect(stream.getSubscriberCount()).toBe(1);
      viewer.resetWrittenData();

      // Held side: well past the registration's own timeout, the beats keep the stream.
      for (let beat = 0; beat < 15; beat++) {
        await scenario.idle(DESKTOP_BEAT_MS);
        await scenario.daemonMethod("daemon/heartbeat", { sessionId: OBSERVER });
      }
      expect(stream.getSubscriberCount()).toBe(1);
      expect(errorFrames(viewer)).toEqual([]);

      // Released side: the registration expires on the daemon's clock with no lookup at all, and
      // the stream ends with the terminal frame.
      const silentSince = scenario.timer.now();
      await scenario.idle(NO_HEARTBEAT_BUDGET_MS + 2 * SCAN_MS);
      expect(scenario.timer.now() - silentSince).toBeLessThanOrEqual(
        NO_HEARTBEAT_BUDGET_MS + 2 * SCAN_MS,
      );
      expect(errorFrames(viewer)).toEqual([
        {
          type: "error",
          success: false,
          code: "SESSION_ENDED",
          error: "Observation stream ended: session_ended",
        },
      ]);
      expect(stream.getSubscriberCount()).toBe(0);
    } finally {
      stream.stopListening();
    }
  });
});

/** The resuming proxy's next beat and call are told the session is over, and why. */
async function expectEndedByPeer(session: string, drivenBefore: number): Promise<void> {
  const beat = await scenario.daemonMethod("daemon/heartbeat", { sessionId: session });
  expect(beat).toMatchObject({
    success: false,
    code: "daemon_session_not_found",
    releaseReason: "identity-recovery-owned-by-other-daemon",
  });
  // The daemon's death dropped the proxy's connection. Its keeper reconnects on its next ticks,
  // and a call made meanwhile is answered once the proxy has learned what became of the session.
  await scenario.idle(KEEPER_INTERVAL_MS);
  const answered = scenario.toolCall(session).then(
    () => undefined,
    (error: unknown) => error,
  );
  await scenario.idle(2 * KEEPER_INTERVAL_MS);
  expect(String(await answered)).toContain("identity-recovery-owned-by-other-daemon");
  // Neither daemon drives the device twice: the peer keeps its claim and this daemon holds nothing.
  expect(scenario.deviceClaims.get(DEVICE_A)).toBe(PEER_DAEMON_PID);
  expectFreed();
  expect(scenario.driven).toHaveLength(drivenBefore);
}

describe("restart recovery onto a device a peer daemon took (#11076, #11084)", () => {
  test("a device only this daemon claims is recovered and kept; one a peer took ends the session, and the resuming proxy is told it was owned by another daemon", async () => {
    scenario = await LivenessScenario.start({ sharedDeviceClaims: true });
    const session = await scenario.acquire();
    expect(scenario.deviceClaims.get(DEVICE_A)).toBe(SCENARIO_DAEMON_PID);
    await scenario.idle(20_000);

    // Held side: nobody took the device while the daemon was down, so recovery rebinds it.
    await scenario.daemonRestart();
    await scenario.idle(NO_HEARTBEAT_BUDGET_MS * 2);
    expectHeld(session);
    await scenario.toolCall(session);
    expect(scenario.releaseOf(session)).toBeUndefined();

    // Released side: the daemon goes down again and a peer claims the device before it is back.
    const drivenBefore = scenario.driven.length;
    scenario.deviceClaims.set(DEVICE_A, PEER_DAEMON_PID);
    await scenario.daemonRestart();
    expect(scenario.isHeld(session)).toBe(false);
    await expectEndedByPeer(session, drivenBefore);
  });

  test("a peer that claims in the instant between the ownership check and this daemon's claim also ends the session", async () => {
    scenario = await LivenessScenario.start({ sharedDeviceClaims: true });
    const session = await scenario.acquire();
    await scenario.idle(20_000);

    const drivenBefore = scenario.driven.length;
    scenario.deviceClaims.delete(DEVICE_A);
    scenario.beforeDeviceClaim = (deviceId) => scenario.deviceClaims.set(deviceId, PEER_DAEMON_PID);
    await scenario.daemonRestart();
    scenario.beforeDeviceClaim = undefined;

    expect(scenario.isHeld(session)).toBe(false);
    await expectEndedByPeer(session, drivenBefore);
  });
});

describe("a crash after a terminal release intent (#10959, #11067, #11082)", () => {
  test("a release whose database write never landed is still refused after the restart, while the live session beside it is recovered", async () => {
    scenario = await LivenessScenario.start({
      devices: [DEVICE_A, DEVICE_B],
    });
    const released = await scenario.acquire(DEVICE_A);
    await scenario.idle(60_000);
    const live = await scenario.acquire(DEVICE_B);

    // The writer is wedged: the agent's explicit release of the first session decides and
    // journals its intent, but its row write is parked for good.
    const parkedWrites = spyOn(scenario.repository, "markReleased").mockImplementation(
      () => new Promise<never>(() => {}),
    );
    const release = scenario.daemonMethod("daemon/releaseSession", { sessionId: released });
    await scenario.idle(SESSION_RELEASE_PERSIST_TIMEOUT_MS + SCAN_MS);
    await release;
    expect(parkedWrites).toHaveBeenCalled();
    expect(scenario.journaledIntents()).toContain(released);
    expect((await scenario.repository.getSession(released))?.status).toBe("active");
    expect(scenario.isHeld(live)).toBe(true);

    // The daemon dies here; the wedged write dies with it.
    parkedWrites.mockRestore();
    await scenario.daemonRestart();

    // Released side: the first session's UUID is refused, though its row still says active.
    const beat = await scenario.daemonMethod("daemon/heartbeat", { sessionId: released });
    expect(beat).toMatchObject({ success: false, code: "daemon_session_not_found" });
    const refusal = await scenario.toolCall(released).then(
      () => undefined,
      (error: unknown) => error,
    );
    // What the agent is told: the terminal refusal, over the wire (not the daemon's own error class).
    expect(String(refusal)).toContain("session_ownership_lost");
    expect(String(refusal)).toContain("acquire_new_session");
    expect(scenario.isHeld(released)).toBe(false);
    expectFreed(DEVICE_A);
    expect((await scenario.repository.getSession(released))?.status).not.toBe("active");
    expect(scenario.journaledIntents()).not.toContain(released);

    // Held side: the session that had no intent is rehydrated and reclaimed by its live owner.
    await scenario.idle(NO_HEARTBEAT_BUDGET_MS * 2);
    expectHeld(live, DEVICE_B);
  });
});

describe("a client cancels and dies in the same tick (#11058, #11066)", () => {
  /** A real Unix socket server over the scenario's real daemon state, with a recording forward. */
  async function serveOverRealSocket(
    forwarded: Array<{ tool: string; connection: string; settle(): void }>,
  ) {
    const socketPath = join(tmpdir(), `matrix-same-tick-${randomUUID()}.sock`);
    const server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      scenario.daemon.state as never,
      scenario.timer,
    );
    server.mcpClientFactory = async () => ({
      listTools: async () => ({ tools: [] }),
      callTool: async (
        params: { name: string; arguments?: Record<string, unknown> },
        _schema: unknown,
      ) => {
        const connection = String(params.arguments?.__mcpSessionId);
        if (params.name === "getAndroid") {
          await scenario.daemonToolCallWith({ deviceId: DEVICE_A }, "getAndroid", connection);
          forwarded.push({ tool: params.name, connection, settle: () => {} });
          return { content: [{ type: "text", text: "{}" }] };
        }
        // A wedged device command that outlives its cancel.
        return await new Promise((resolve) => {
          forwarded.push({ tool: params.name, connection, settle: () => resolve({ content: [] }) });
        });
      },
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      close: async () => {},
    });
    await server.start();
    return { server, socketPath };
  }

  async function until(predicate: () => boolean, what: string): Promise<void> {
    for (let spins = 0; !predicate(); spins++) {
      if (spins > 500) {
        throw new Error(`Timed out waiting for ${what}`);
      }
      await realIoTurn();
    }
  }

  // The first acquisition through a real socket server pays ~12 ms of one-time setup (socket
  // listen, request framing, first forwarded tool call); beforeAll is outside the per-test budget.
  beforeAll(async () => {
    scenario = await LivenessScenario.start({ autolock: true });
    const forwarded: Array<{ tool: string; connection: string; settle(): void }> = [];
    const { server, socketPath } = await serveOverRealSocket(forwarded);
    try {
      const socket = new Socket();
      await new Promise<void>((resolve) => socket.connect(socketPath, resolve));
      socket.on("data", () => {});
      socket.on("error", () => {});
      const warmUp: DaemonRequest = {
        id: "warm",
        type: "mcp_request",
        method: "tools/call",
        params: { name: "getAndroid", arguments: { deviceId: DEVICE_A } },
      };
      socket.write(JSON.stringify(warmUp) + "\n");
      await until(() => forwarded.length === 1, "the warm-up acquisition to be forwarded");
      socket.destroy();
    } finally {
      await server.close();
      await scenario.stop();
    }
  });

  test("the connection's bindings are dropped within a second of the death, not kept until daemon stop; the silent owner's session is then freed within about 10 s", async () => {
    scenario = await LivenessScenario.start({ autolock: true });
    const forwarded: Array<{ tool: string; connection: string; settle(): void }> = [];
    const { server, socketPath } = await serveOverRealSocket(forwarded);
    try {
      const socket = new Socket();
      await new Promise<void>((resolve) => socket.connect(socketPath, resolve));
      socket.on("data", () => {});
      socket.on("error", () => {});
      const send = (request: DaemonRequest) => socket.write(JSON.stringify(request) + "\n");
      const toolCall = (id: string, name: string): DaemonRequest => ({
        id,
        type: "mcp_request",
        method: "tools/call",
        params: { name, arguments: { deviceId: DEVICE_A } },
      });

      send(toolCall("acquire", "getAndroid"));
      await until(() => forwarded.length === 1, "the acquisition to be forwarded");
      const [session] = scenario.daemon.manager.getAllSessions().map((held) => held.sessionId);
      expect(session).toBeDefined();
      send(toolCall("wedged", "homeScreen"));
      await until(() => forwarded.length === 2, "the wedged call to be forwarded");
      expectHeld(session!);
      // Held side: while the client lives its connection routes to the session it acquired.
      const connection = forwarded[0]!.connection;
      expect(scenario.daemon.pool.resolveAutolockSessionForMcpSession(connection)).toBe(session);

      // The SDK's timeout cancels the call and the client exits in the same tick.
      const diedAt = scenario.timer.now();
      send({
        id: "cancel-wedged",
        type: "daemon_request",
        method: DAEMON_CANCEL_REQUEST_METHOD,
        params: { requestId: "wedged" },
      });
      socket.destroy();

      // Real socket I/O settles on the real clock; the daemon's own timers run on the fake one.
      // Released side: the socket closes (peer-end flush grace, 1 s) and the pool drops the
      // connection's bindings.
      for (let spins = 0; spins < 200; spins++) {
        await realIoTurn();
        await scenario.idle(250);
        if (scenario.daemon.pool.resolveAutolockSessionForMcpSession(connection) === undefined) {
          break;
        }
      }
      expect(scenario.daemon.pool.resolveAutolockSessionForMcpSession(connection)).toBeUndefined();
      expect(scenario.timer.now() - diedAt).toBeLessThanOrEqual(2_000);
      let releasedAt: number | undefined;
      for (let spins = 0; releasedAt === undefined && spins < 100; spins++) {
        await realIoTurn();
        await scenario.idle(1_000);
        releasedAt = scenario.isHeld(session!) ? undefined : scenario.timer.now();
      }
      expect(releasedAt).toBeDefined();
      expect(releasedAt! - diedAt).toBeLessThanOrEqual(NO_HEARTBEAT_BUDGET_MS + 2_000);
      await scenario.idle(KEEPER_INTERVAL_MS);
      expectFreed();
    } finally {
      for (const call of forwarded) {
        call.settle();
      }
      await server.close();
    }
  });
});

describe("behaviours only narrow tests protected (#11444, #10655)", () => {
  test("a read through the proxy after an idle release succeeds without a session, and binds nothing (#10971)", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    expect(
      await scenario.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS),
    ).toBeDefined();
    expectFreed();

    // The agent's control call learns of the release and is told to reacquire: terminal, every time.
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await rejection(scenario.selectorCall(DEVICE_A)))?.message).toContain("getAndroid");
    }
    const drivenBefore = scenario.driven.length;

    // From then on its reads go through with no session, and none of them binds the device.
    for (let attempt = 0; attempt < 3; attempt++) {
      await scenario.idle(10_000);
      expect(await rejection(scenario.selectorCall(DEVICE_A, "observe", {}))).toBeUndefined();
      expectFreed();
    }
    expect(scenario.driven.slice(drivenBefore).map((run) => run.sessionUuid)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(scenario.isHeld(session)).toBe(false);
    expectFreed();
  });

  test("a daemon stall followed by a late ack inside the recovery budget recovers the session instead of handing it over (#10973)", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    await scenario.idle(2_000);

    // Held side: the first heartbeat in the blackout is accepted 6 s late and every recovery
    // attempt meanwhile goes unanswered; the late ack cancels the handover.
    scenario.daemonStall = { lateAckDelayMs: 6_000 };
    await scenario.idle(SUSPECT_GRACE_MS + 2 * SCAN_MS);
    scenario.daemonStall = undefined;
    await scenario.idle(KEEPER_INTERVAL_MS * 2);
    expectHeld(session);
    expect(await rejection(scenario.toolCall(session))).toBeUndefined();
    expect(scenario.releases).toEqual([]);

    // Released side: the recovered session is an ordinary one again and idles out on schedule.
    expect(
      await scenario.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS),
    ).toBeDefined();
    expect(IDLE_REASONS).toContain(scenario.releaseOf(session)?.reason!);
    expectFreed();
  });

  test("a daemon stall with no ack inside the budget hands the session over: the call is told the daemon stalled (#10973)", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    await scenario.idle(2_000);

    scenario.daemonStall = {};
    await scenario.idle(SUSPECT_GRACE_MS + 2 * SCAN_MS + KEEPER_INTERVAL_MS);
    scenario.daemonStall = undefined;

    const refused = await rejection(scenario.toolCall(session));
    expect(refused).toBeInstanceOf(Error);
    expect(refused?.message ?? "").toContain("daemon stalled and stopped acknowledging heartbeats");
    expect(scenario.isHeld(session)).toBe(false);
    expectFreed();
  });

  test("a refused call naming no deviceId touches no readiness and never drives the device (#10828)", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A] });
    const holder = await scenario.acquire(DEVICE_A);
    const readinessBefore = scenario.readinessTouches;
    const drivenBefore = scenario.driven.length;

    // Refused side: the only device is held, so a caller with no session and no deviceId is refused.
    for (let attempt = 0; attempt < 3; attempt++) {
      await scenario.idle(10_000);
      const refused = await rejection(
        scenario.daemonToolCallWith({ orientation: "landscape" }, "rotate"),
      );
      expect(refused?.message ?? "").toContain("held by another session");
    }
    expect(scenario.readinessTouches).toBe(readinessBefore);
    expect(scenario.driven.length).toBe(drivenBefore);

    // Allowed side: the holder names its session and drives the device.
    expect(
      await rejection(
        scenario.daemonToolCallWith({ sessionUuid: holder, orientation: "landscape" }, "rotate"),
      ),
    ).toBeUndefined();
    expect(scenario.driven.length).toBe(drivenBefore + 1);
    expectHeld(holder, DEVICE_A);
  });

  test("a non-owner's ide/setKeyValue is refused and never reaches the device; the owner's is applied (#11178)", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const holder = await scenario.acquire(DEVICE_A);
    const intruder = await scenario.acquireTokenless(DEVICE_B);
    const setKeyValue = (sessionUuid?: string) =>
      scenario.socketFrame("ide/setKeyValue", {
        platform: "android",
        deviceId: DEVICE_A,
        appId: "com.example",
        fileName: "prefs",
        key: "k",
        value: "v",
        type: "STRING",
        ...(sessionUuid ? { sessionUuid } : {}),
      });
    await scenario.toolCall(holder);
    const lastCallAt = scenario.timer.now();

    // Refused side: a sessionless client and another session, again and again.
    for (let attempt = 0; attempt < 2; attempt++) {
      await scenario.idle(10_000);
      for (const caller of [undefined, intruder]) {
        expect(await setKeyValue(caller)).toMatchObject({
          success: false,
          code: "device_owned_by_other_session",
        });
      }
    }
    expect(scenario.ctrlProxyWrites).toEqual([]);
    expectHeld(holder, DEVICE_A);

    // Allowed side: the holder's own frame reaches the device, and is a tracked control call
    // (#11515): the holder's window runs from it.
    expect(await setKeyValue(holder)).toMatchObject({ success: true });
    expect(scenario.ctrlProxyWrites).toEqual(["setPreference"]);
    const ownerFrameAt = scenario.timer.now();
    expect(ownerFrameAt).toBeGreaterThan(lastCallAt);

    // Refusals were not use: nothing but the holder's own frame moved its window.
    const releasedAt = await scenario.idleUntilReleased(holder, IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(releasedAt).toBeGreaterThan(ownerFrameAt + IDLE_WINDOW_MS);
    expect(releasedAt).toBeLessThanOrEqual(ownerFrameAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expectFreed(DEVICE_A);
  });

  test("a non-owner's write SQL on a held device is refused before readiness; the owner's write runs (#10966, #10830)", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const holder = await scenario.acquire(DEVICE_A);
    const intruder = await scenario.acquireTokenless(DEVICE_B);
    const sql = (query: string, sessionUuid?: string) =>
      scenario.daemonToolCallWith(
        {
          deviceId: DEVICE_A,
          appId: "com.example",
          databasePath: "app.db",
          query,
          ...(sessionUuid ? { sessionUuid } : {}),
        },
        "sqlQuery",
      );
    const readinessBefore = scenario.readinessTouches;
    const drivenBefore = scenario.driven.length;

    for (const query of [
      "INSERT INTO t VALUES (1)",
      "SELECT 1; DELETE FROM t",
      "WITH x AS (SELECT 1) DELETE FROM t",
      "PRAGMA writable_schema = 1",
    ]) {
      for (const caller of [undefined, intruder]) {
        const refused = await rejection(sql(query, caller));
        expect(refused?.message ?? "").toContain("held by another session");
      }
    }
    expect(scenario.readinessTouches).toBe(readinessBefore);
    expect(scenario.driven.length).toBe(drivenBefore);

    // Allowed side: the holder's write is its own control and reaches the device boundary.
    expect(await rejection(sql("INSERT INTO t VALUES (1)", holder))).toBeUndefined();
    expect(scenario.driven.slice(drivenBefore).map((run) => run.sessionUuid)).toEqual([holder]);
    expectHeld(holder, DEVICE_A);
  });

  test("a non-holder's appearance set does not touch the device; the holder's applies to its own device only (#10976)", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const holder = await scenario.acquire(DEVICE_A);
    const intruder = await scenario.acquireTokenless(DEVICE_B);

    // Refused side: another session's set is applied to the devices IT owns, never to the holder's.
    const foreign = await scenario.appearanceSet(intruder, "dark");
    expect(foreign.response.success).toBe(true);
    expect(foreign.applied).toEqual([`${DEVICE_B}:dark`]);
    const sessionless = await scenario.appearanceSet(undefined, "dark");
    expect(sessionless.response).toMatchObject({ success: false });
    expect(sessionless.applied).toEqual([]);

    // Allowed side: the holder's own set reaches its device and no other.
    const own = await scenario.appearanceSet(holder, "dark");
    expect(own.response.success).toBe(true);
    expect(own.applied).toEqual([`${DEVICE_A}:dark`]);
  });

  test("an idle release while a recording finalize hangs frees the device at the cap, and the recording is marked incomplete (#10957)", async () => {
    scenario = await LivenessScenario.start();
    scenario.recordingStopHangs = true;
    const session = await scenario.acquire();
    expect(
      await scenario.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS),
    ).toBeDefined();
    expect(scenario.incompleteRecordings).toEqual([]);

    // Held side: inside the cap the wedged stop is not cut and nothing is marked.
    await scenario.idle(60_000);
    expect(scenario.incompleteRecordings).toEqual([]);

    // Released side: past the cap plus the mark grace the recording is incomplete and the device free.
    await scenario.idle(60_000 + 6_000);
    expect(scenario.incompleteRecordings).toEqual([`recording-of-${session}`]);
    expectFreed();
    expect(await rejection(scenario.acquire())).toBeUndefined();
  });
});
