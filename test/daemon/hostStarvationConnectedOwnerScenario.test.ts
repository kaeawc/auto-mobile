import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { judgedLeaseHeartbeat } from "../../src/daemon/livenessOwnerLease";
import { KEEPER_INTERVAL_MS, LivenessScenario, SCAN_MS } from "../helpers/livenessScenarioHarness";

let scenario: LivenessScenario | undefined;
beforeAll(async () => {
  const warm = await LivenessScenario.start();
  const id = await warm.acquire();
  warm.dropHeartbeats = true;
  await warm.idle(10_000);
  expect(warm.releaseOf(id)).toBeDefined();
  await warm.stop();
});
afterEach(async () => {
  await scenario?.stop();
  scenario = undefined;
});

async function silentOwner(keeperOffset = false) {
  scenario = await LivenessScenario.start();
  // Offset acquisition from daemon scans so the recovering proxy keeper arrives before reaping.
  if (keeperOffset) {
    await scenario.idle(1_000);
  }
  const id = await scenario.acquire();
  scenario.dropHeartbeats = true;
  await scenario.idle(keeperOffset ? 5_000 : 6_000);
  expect(scenario.daemon.manager.getSessionLeaseState(id)?.phase).toBe("suspect");
  return { s: scenario, id, session: scenario.daemon.manager.getSession(id)! };
}

async function stalledScan(s: LivenessScenario, lostMs: number) {
  // Advance the scheduled scan interval without running it, then make that tick X ms late.
  s.lateTicks(SCAN_MS);
  s.lateTicks(lostMs);
  await s.idle(0);
}

describe("host starvation with a connected silent proxy (#11992)", () => {
  test("12 s, 15 s and 18 s stalls are held when an owner heartbeat resets the budget between them", async () => {
    const { s, id, session } = await silentOwner(true);
    for (const lostMs of [12_000, 15_000, 18_000]) {
      const before = judgedLeaseHeartbeat(session);
      // Each: pre-gap silence 5 s + scan 2 s + X - X credit = 7 s < 8 s; keeper runs before reap.
      await stalledScan(s, lostMs);
      expect(judgedLeaseHeartbeat(session) - before).toBe(lostMs);
      expect(s.isHeld(id)).toBe(true);
      expect(s.releaseOf(id)).toBeUndefined();
      s.dropHeartbeats = false;
      await s.idle(KEEPER_INTERVAL_MS);
      expect(s.daemon.manager.getSessionLeaseState(id)?.phase).toBe("live");
      s.dropHeartbeats = true;
      if (lostMs !== 18_000) {
        await s.idle(lostMs === 12_000 ? 4_000 : 5_000);
      }
    }
    expect(s.reaped).toEqual([]);
  });

  test("without an arriving heartbeat the sequence releases on the second scan with 3 s unspent", async () => {
    const { s, id, session } = await silentOwner();
    await stalledScan(s, 12_000);
    // 6 + 2 + 12 - 12 = 8 s: held.
    expect(session.stallForgivenAt).toBe(session.lastOwnerHeartbeat! + 12_000);
    expect(s.isHeld(id)).toBe(true);
    await stalledScan(s, 15_000);
    // 6 + 2 + 12 + 2 + 15 - 27 = 10 s > 8 s: released, with 3 s unspent.
    expect(session.stallForgivenAt).toBe(session.lastOwnerHeartbeat! + 27_000);
    expect(s.isHeld(id)).toBe(false);
    const release = s.releaseOf(id);
    await stalledScan(s, 18_000);
    // If retained: 6 + 3*2 + 12 + 15 + 18 - 30 = 27 s > 8 s; already released, no resurrection.
    expect(s.releaseOf(id)).toEqual(release);
    expect(release?.reason).toBe("heartbeat-timeout");
  });

  for (const lostMs of [78_000, 40_000, 37_000, 35_000]) {
    test(`a ${lostMs} ms stall credits 30 s and releases its silent connected owner`, async () => {
      const { s, id, session } = await silentOwner();
      await stalledScan(s, lostMs);
      // 6 + 2 + X - 30 = 56 / 18 / 15 / 13 s respectively; each exceeds lease + grace (8 s).
      expect(session.stallForgivenAt).toBe(session.lastOwnerHeartbeat! + 30_000);
      expect(s.isHeld(id)).toBe(false);
      expect(s.releaseOf(id)?.reason).toBe("heartbeat-timeout");
    });
  }

  test("a transport closed before the gap is still released", async () => {
    const { s, id, session } = await silentOwner();
    await s.closeTransport();
    await stalledScan(s, 12_000);
    expect(session.stallForgivenAt).toBeUndefined();
    expect(s.isHeld(id)).toBe(false);
    expect(s.releaseOf(id)?.reason).toMatch(/^(heartbeat-timeout|owner-disconnect)/);
  });
});
