import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  OWNER_DISCONNECT_GRACE_MS,
  OWNER_DISCONNECTED_RELEASE_REASON,
} from "../../src/daemon/ownerDisconnectRelease";
import { executionTracker } from "../../src/server/executionTracker";
import { LivenessScenario } from "../helpers/livenessScenarioHarness";

// #11381: through the real Daemon and device-tool path, control calls defer owner-disconnect
// release and re-arm it at their end. A wedged device read is cut at the disconnect grace instead,
// with its execution still in flight; settling it afterward never credits use or releases again.

let scenario: LivenessScenario | undefined;
let longCall: ReturnType<LivenessScenario["startLongCall"]> | undefined;

// The first scenario pays for module-level one-time costs, outside the per-test budget.
beforeAll(async () => {
  const warm = await LivenessScenario.start();
  const session = await warm.acquire();
  await warm.toolCall(session);
  await warm.toolCall(session, "observe");
  await warm.closeTransport();
  await warm.idleUntilReleased(session, 2 * OWNER_DISCONNECT_GRACE_MS);
  await warm.stop();
});

afterEach(async () => {
  await longCall?.settle();
  longCall = undefined;
  await scenario?.stop();
  scenario = undefined;
});

/** Let the forwarded call reach the device boundary, without any virtual time passing. */
async function untilAtTheDevice(running: LivenessScenario): Promise<void> {
  for (let turn = 0; turn < 100 && running.driven.length === 0; turn++) {
    await running.idle(0);
  }
  expect(running.driven).toHaveLength(1);
}

describe("the owner's connection closes with the session's last call in flight (#11381)", () => {
  test("a control call ending after the disconnect grace retries the deferred release at once", async () => {
    const running = (scenario = await LivenessScenario.start());
    const session = await running.acquire();
    const call = (longCall = running.startLongCall(session, "homeScreen", { wedged: true }));
    await untilAtTheDevice(running);
    expect(executionTracker.hasActiveSessionUuidExecutions(session, { excludeReads: true })).toBe(
      true,
    );
    const closedAt = running.timer.now();
    await running.closeTransport();
    await running.idle(OWNER_DISCONNECT_GRACE_MS);
    expect(running.releases).toEqual([]);
    expect(running.poolState().sessionId).toBe(session);

    await call.settle();
    await running.idle(0);
    for (let turn = 0; turn < 20 && running.poolState().status !== "idle"; turn++) {
      await running.idle(0);
    }
    expectReleased(running, session, closedAt);
  });

  test("a wedged device read is released at the disconnect grace before it settles", async () => {
    const running = (scenario = await LivenessScenario.start());
    const session = await running.acquire();
    const held = running.daemon.manager.getSession(session)!;
    const idleDeadline = held.expiresAt;
    const call = (longCall = running.startLongCall(session, "observe", { wedged: true }));
    await untilAtTheDevice(running);
    expect(executionTracker.hasActiveSessionUuidExecutions(session)).toBe(true);
    expect(executionTracker.hasActiveSessionUuidExecutions(session, { excludeReads: true })).toBe(
      false,
    );
    const closedAt = running.timer.now();
    expect(held.lastOwnerHeartbeat ?? closedAt).toBe(closedAt);
    await running.closeTransport();
    await running.idle(OWNER_DISCONNECT_GRACE_MS);
    expect(executionTracker.hasActiveSessionUuidExecutions(session)).toBe(true);
    for (let turn = 0; turn < 20 && running.poolState().status !== "idle"; turn++) {
      await running.idle(0);
    }
    expectReleased(running, session, closedAt);

    await call.settle();
    await running.idle(0);
    expect(held.expiresAt).toBe(idleDeadline);
    expect(running.daemon.manager.getSession(session)).toBeNull();
    expectReleased(running, session, closedAt);
  });

  function expectReleased(running: LivenessScenario, session: string, closedAt: number): void {
    expect(running.releases).toEqual([
      {
        at: closedAt + OWNER_DISCONNECT_GRACE_MS,
        sessionId: session,
        deviceId: running.deviceIds[0]!,
        reason: OWNER_DISCONNECTED_RELEASE_REASON,
      },
    ]);
    expect(running.timer.now()).toBe(closedAt + OWNER_DISCONNECT_GRACE_MS);
    expect(running.poolState()).toEqual({
      status: "idle",
      sessionId: null,
      autolockSessionId: undefined,
    });
  }
});
