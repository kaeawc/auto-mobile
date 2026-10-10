import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { DAEMON_CANCEL_REQUEST_METHOD } from "../../src/daemon/constants";
import type { DaemonRequest } from "../../src/daemon/types";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { DeviceDataStreamSocketServer } from "../../src/daemon/deviceDataStreamSocketServer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { routedSessionUuidFromResult } from "../../src/server/routedSessionMeta";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  TerminalSessionError,
} from "../../src/daemon/sessionManager";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import { decideOwnershipChange } from "../../src/daemon/streamSubscriptionPolicy";
import { LIVE_OWNER_HANDOFF_ALLOWANCE_MS } from "../../src/daemon/proxyLivenessRecovery";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { UNSETTLED_EXECUTION_VETO_CEILING_MS } from "../../src/daemon/unsettledExecutionVeto";
import { OWNER_DISCONNECT_GRACE_MS } from "../../src/daemon/ownerDisconnectRelease";
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
  TERMINAL_RELEASE_JOURNAL_PATH,
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

// The first scenario pays for module-level one-time costs (database template, Daemon module graph);
// beforeAll is outside the per-test budget, and the first row would otherwise sit at ~70 ms of 100.
beforeAll(async () => {
  await (await LivenessScenario.start()).stop();
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

  test("a call that never settles holds the session past the idle window; when the veto ceiling lets the expiry through, the call is aborted and the device freed (#10820)", async () => {
    scenario = await LivenessScenario.start();
    const session = await scenario.acquire();
    const call = scenario.startLongCall(session);

    // Held side: in flight past the idle window the call is never aborted.
    expect(await scenario.idleWhileHeld(session, 3 * IDLE_WINDOW_MS, 60_000)).toBe(undefined);
    expectHeld(session);
    expect(scenario.abortedCalls).toEqual([]);

    // Released side: past the ceiling the expiry overrides it and aborts what it overrode.
    const releasedAt = await scenario.idleWhileHeld(
      session,
      scenario.timer.now() + UNSETTLED_EXECUTION_VETO_CEILING_MS + 2 * IDLE_WINDOW_MS,
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
    for (let step = 0; step < 4; step++) {
      await scenario.idle(AUTOLOCK_WINDOW_MS);
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
    const retry = () =>
      scenario.daemonToolCallWith({ deviceId: DEVICE_A, sessionUuid: ide }, "setActiveDevice");

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
  const refusal = await scenario.toolCall(session).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(String(refusal)).toContain("identity-recovery-owned-by-other-daemon");
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
      terminalReleaseJournal: true,
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
    expect(scenario.journalFiles.files.get(TERMINAL_RELEASE_JOURNAL_PATH)).toContain(released);
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
    expect(refusal).toBeInstanceOf(TerminalSessionError);
    expect(scenario.isHeld(released)).toBe(false);
    expectFreed(DEVICE_A);
    expect((await scenario.repository.getSession(released))?.status).not.toBe("active");
    expect(scenario.journalFiles.files.has(TERMINAL_RELEASE_JOURNAL_PATH)).toBe(false);

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
      await new Promise<void>((resolve) => defaultTimer.setTimeout(resolve, 2));
    }
  }

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
        await new Promise<void>((resolve) => defaultTimer.setTimeout(resolve, 2));
        await scenario.idle(250);
        if (scenario.daemon.pool.resolveAutolockSessionForMcpSession(connection) === undefined) {
          break;
        }
      }
      expect(scenario.daemon.pool.resolveAutolockSessionForMcpSession(connection)).toBeUndefined();
      expect(scenario.timer.now() - diedAt).toBeLessThanOrEqual(2_000);
      let releasedAt: number | undefined;
      for (let spins = 0; releasedAt === undefined && spins < 100; spins++) {
        await new Promise<void>((resolve) => defaultTimer.setTimeout(resolve, 2));
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
