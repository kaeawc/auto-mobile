import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  OWNER_DISCONNECT_GRACE_MS,
  OWNER_DISCONNECTED_RELEASE_REASON,
} from "../../src/daemon/ownerDisconnectRelease";
import { executionTracker } from "../../src/server/executionTracker";
import { LivenessScenario } from "../helpers/livenessScenarioHarness";

// #11381 items 5 and 6, on the liveness scenario harness: a real started Daemon (its own
// tool-call-end subscription, owner-disconnect port and veto, heartbeat monitor), the real stdio
// proxy and the real ToolRegistry device-call path. The session's last call in flight ends after
// its owner's connection closed and the disconnect grace ran out; the release that call deferred
// must be retried at that instant, for a device read exactly as for a control call.
//
// Whether a read should defer the owner-disconnect release at all is an open owner question
// (#11381 item 1), so no row asserts that the session is held while the read runs: only that the
// release is not left waiting past the read's end. Today the read does defer it, and without the
// end event the session would instead wait for the heartbeat monitor's next scan and be released
// as a heartbeat timeout.

let scenario: LivenessScenario | undefined;

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
  const calls = [
    { kind: "a device read", tool: "observe", read: true },
    { kind: "a control call", tool: "homeScreen", read: false },
  ];

  test.each(calls)(
    "$kind ending after the disconnect grace: the release it deferred is retried at once",
    async ({ tool, read }) => {
      const running = (scenario = await LivenessScenario.start());
      const session = await running.acquire();
      // The device command outlives its caller: it ends only when the scenario settles it.
      const call = running.startLongCall(session, tool, { wedged: true });
      await untilAtTheDevice(running);
      // The real ToolRegistry path classified the call: a read is not counted as a control call.
      expect(executionTracker.hasActiveSessionUuidExecutions(session)).toBe(true);
      expect(executionTracker.hasActiveSessionUuidExecutions(session, { excludeReads: true })).toBe(
        !read,
      );

      const closedAt = running.timer.now();
      await running.closeTransport();
      await running.idle(OWNER_DISCONNECT_GRACE_MS);
      const idleDeadline = running.daemon.manager.getSession(session)?.expiresAt;

      await call.settle();
      if (read) {
        // A read's end is reported so the release is retried, but it is not use of the session.
        expect(running.daemon.manager.getSession(session)?.expiresAt).toBe(idleDeadline);
      }
      await running.idle(0);

      // Released by the owner-disconnect release, in the instant the call ended: not at the
      // veto's bound, and not by the heartbeat monitor's later scan.
      expect(running.releases).toEqual([
        {
          at: closedAt + OWNER_DISCONNECT_GRACE_MS,
          sessionId: session,
          deviceId: running.deviceIds[0]!,
          reason: OWNER_DISCONNECTED_RELEASE_REASON,
        },
      ]);
      // The device is freed by the same release once its teardown has run, still in that instant.
      for (let turn = 0; turn < 20 && running.poolState().status !== "idle"; turn++) {
        await running.idle(0);
      }
      expect(running.timer.now()).toBe(closedAt + OWNER_DISCONNECT_GRACE_MS);
      expect(running.poolState()).toEqual({
        status: "idle",
        sessionId: null,
        autolockSessionId: undefined,
      });
    },
  );
});
