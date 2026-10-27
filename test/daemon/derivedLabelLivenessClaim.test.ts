import { describe, expect, test } from "bun:test";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { asPlanAllocation } from "../helpers/planLabelAllocation";

// #11602: liveness claims on a derived label session through the daemon's heartbeat ingress, as
// a proxy sends them. The decision itself is tabled in livenessClaimDecision.test.ts; these are
// the sequences that broke while it was ordered by hand.

const BASE = "sess-a";
const LABEL = `${BASE}:B`;
const A = "token-a";
const C = "token-c";

interface Daemon {
  timer: FakeTimer;
  manager: SessionManager;
  /** A heartbeat for `sessionId`, claiming liveness ownership or as a plain tick. */
  beat(sessionId: string, token: string, how: "claim" | "tick"): Promise<Answer>;
}

interface Answer {
  success: boolean;
  code: string | null;
  hold: unknown;
}

async function daemon(): Promise<Daemon> {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  manager.stopCleanupTimer();
  await manager.createSession(BASE, "emulator-5554", "android");
  await asPlanAllocation(manager, BASE, [LABEL], () =>
    manager.createSession(LABEL, "emulator-5556", "android"),
  );
  manager.setDeviceLabels(BASE, buildDeviceLabelMap(["A", "B"], BASE));
  const state = {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      releaseDevice: async () => {},
      getStats: () => ({ total: 2, idle: 0, assigned: 2, error: 0 }),
    }),
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(timer),
  };
  return {
    timer,
    manager,
    beat: async (sessionId, token, how) => {
      const answer = await handleDaemonRequest(
        {
          id: "heartbeat",
          type: "daemon_request",
          method: "daemon/heartbeat",
          params: {
            sessionId,
            livenessOwnerToken: token,
            ...(how === "claim" ? { claimLivenessOwnership: true } : {}),
          },
        },
        state,
      );
      return {
        success: answer.success,
        code: answer.code ?? null,
        hold: answer.details?.livenessOwnerHold ?? manager.getOwnerLeaseHold(sessionId) ?? null,
      };
    },
  };
}

describe("liveness claims on a derived label session through the heartbeat ingress", () => {
  test("the label's owner re-claims its label after another token takes the ownerless base", async () => {
    const d = await daemon();
    expect((await d.beat(LABEL, A, "claim")).success).toBe(true);
    expect((await d.beat(BASE, C, "claim")).success).toBe(true);
    expect((await d.beat(LABEL, A, "tick")).success).toBe(true);

    // The proxy re-claims in normal operation; its own label is never "owned by another".
    for (let round = 0; round < 3; round++) {
      d.timer.advanceTime(2_000);
      expect((await d.beat(BASE, C, "tick")).success).toBe(true);
      expect(await d.beat(LABEL, A, "claim")).toMatchObject({ success: true, code: null });
    }

    expect(d.manager.hasLivenessOwnership(LABEL, A)).toBe(true);
    expect(d.manager.hasLivenessOwnership(BASE, C)).toBe(true);
  });

  test("a refusal for the base's owner reports the base's live hold, not the label's lapsed one", async () => {
    const d = await daemon();
    await d.beat(BASE, A, "claim");
    await d.beat(LABEL, A, "claim");
    // The owner heartbeats only the base from here on, so the label's own lease lapses.
    for (let elapsed = 0; elapsed < 12_000; elapsed += 2_000) {
      d.timer.advanceTime(2_000);
      expect((await d.beat(BASE, A, "tick")).success).toBe(true);
    }

    const refused = await d.beat(LABEL, C, "claim");

    expect(refused).toMatchObject({ success: false, code: "liveness_owner_conflict" });
    expect(d.manager.getOwnerLeaseHold(LABEL)).toEqual(d.manager.getOwnerLeaseHold(BASE));
    expect(d.manager.getOwnerLeaseHold(LABEL)).toMatchObject({ state: "live" });
    expect(d.manager.hasLivenessOwnership(LABEL, A)).toBe(true);
  });

  test("a refusal for the label's own owner reports that owner's hold", async () => {
    const d = await daemon();
    await d.beat(LABEL, A, "claim");
    d.timer.advanceTime(1_000);
    await d.beat(BASE, C, "claim");

    expect((await d.beat(LABEL, "token-x", "claim")).code).toBe("liveness_owner_conflict");

    expect(d.manager.getOwnerLeaseHold(LABEL)).toMatchObject({ state: "live", remainingMs: 3_000 });
  });

  test("the owner holding the base takes its label back from another token", async () => {
    const d = await daemon();
    await d.beat(LABEL, C, "claim");
    await d.beat(BASE, A, "claim");

    expect((await d.beat(LABEL, A, "claim")).success).toBe(true);

    expect(d.manager.hasLivenessOwnership(LABEL, A)).toBe(true);
    expect((await d.beat(LABEL, C, "claim")).success).toBe(false);
  });

  test("a claim through a label records nothing on the base", async () => {
    const d = await daemon();

    expect((await d.beat(LABEL, C, "claim")).success).toBe(true);

    expect(d.manager.getSession(BASE)?.livenessOwnerToken).toBeUndefined();
    expect(d.manager.getSession(BASE)?.hasReceivedHeartbeat).toBe(false);
  });

  test("a session that is no label is claimed, refused and re-claimed as before", async () => {
    const d = await daemon();
    expect((await d.beat(BASE, A, "claim")).success).toBe(true);
    expect((await d.beat(BASE, C, "claim")).code).toBe("liveness_owner_conflict");
    expect((await d.beat(BASE, A, "claim")).success).toBe(true);

    d.timer.advanceTime(8_001);

    expect((await d.beat(BASE, C, "claim")).success).toBe(true);
    expect((await d.beat(BASE, A, "claim")).success).toBe(false);
  });
});
