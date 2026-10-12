import { describe, expect, test } from "bun:test";
import {
  SUSPECT_GRACE_MS,
  effectiveLastHeartbeat,
  isLivenessOwnerLeaseLive,
  livenessLeaseState,
  sessionLeaseSnapshot,
  ownerLeaseHeartbeat,
  sessionOwnerLeaseSnapshot,
  sessionJudgedLeaseSnapshot,
  judgedLeaseHeartbeat,
  judgesOwnerHeartbeats,
  ownerLeaseLiveAt,
  type LeaseSession,
  suspectGraceMsFor,
  type LivenessOwnerLeaseSnapshot,
} from "../../src/daemon/livenessOwnerLease";

const heartbeatSnapshot = (overrides: Partial<LivenessOwnerLeaseSnapshot>) =>
  ({
    now: 1_000,
    lastHeartbeat: 1_000,
    heartbeatTimeoutMs: 10_000,
    livenessPolicy: "heartbeat",
    ...overrides,
  }) satisfies LivenessOwnerLeaseSnapshot;

describe("isLivenessOwnerLeaseLive", () => {
  test("is live through the last millisecond of the heartbeat timeout", () => {
    expect(isLivenessOwnerLeaseLive(heartbeatSnapshot({ now: 1_000 }))).toBe(true);
    expect(isLivenessOwnerLeaseLive(heartbeatSnapshot({ now: 11_000 }))).toBe(true);
  });

  test("expires one millisecond past the heartbeat timeout, matching the reaper", () => {
    expect(isLivenessOwnerLeaseLive(heartbeatSnapshot({ now: 11_001 }))).toBe(false);
  });

  test("never holds a lease for a one-shot CLI owner", () => {
    expect(isLivenessOwnerLeaseLive(heartbeatSnapshot({ livenessPolicy: "cli-idle" }))).toBe(false);
  });
});

describe("suspect grace window (#10051)", () => {
  const withGrace = (overrides: Partial<LivenessOwnerLeaseSnapshot>) =>
    heartbeatSnapshot({ graceMs: SUSPECT_GRACE_MS, ...overrides });

  // The lease ends at t=11_000 (1_000 + 10_000) and the grace at 11_000 + SUSPECT_GRACE_MS.
  const graceEnd = 11_000 + SUSPECT_GRACE_MS;

  test("reports the time left in the lease, then in the grace window", () => {
    expect(livenessLeaseState(withGrace({ now: 4_000 }))).toEqual({
      phase: "live",
      remainingMs: 7_000,
    });
    expect(livenessLeaseState(withGrace({ now: 11_001 }))).toEqual({
      phase: "suspect",
      remainingMs: SUSPECT_GRACE_MS - 1,
    });
    expect(livenessLeaseState(withGrace({ now: graceEnd }))).toEqual({
      phase: "suspect",
      remainingMs: 0,
    });
    expect(livenessLeaseState(withGrace({ now: graceEnd + 1 }))).toEqual({
      phase: "lapsed",
      remainingMs: 0,
    });
  });

  test("still holds the owner's claim while suspect and releases it one millisecond after", () => {
    expect(isLivenessOwnerLeaseLive(withGrace({ now: 11_001 }))).toBe(true);
    expect(isLivenessOwnerLeaseLive(withGrace({ now: graceEnd }))).toBe(true);
    expect(isLivenessOwnerLeaseLive(withGrace({ now: graceEnd + 1 }))).toBe(false);
  });

  test("a snapshot without a grace window has no suspect phase", () => {
    expect(livenessLeaseState(heartbeatSnapshot({ now: 11_001 })).phase).toBe("lapsed");
  });

  test("never holds a lease for a one-shot CLI owner, grace or not", () => {
    expect(isLivenessOwnerLeaseLive(withGrace({ livenessPolicy: "cli-idle", now: 1_000 }))).toBe(
      false,
    );
  });

  test("grants grace only to an owned heartbeat session that has heartbeated", () => {
    const owned = {
      livenessPolicy: "heartbeat",
      hasReceivedHeartbeat: true,
      ownership: "owned",
    } as const;
    expect(suspectGraceMsFor(owned)).toBe(SUSPECT_GRACE_MS);
    expect(suspectGraceMsFor({ ...owned, hasReceivedHeartbeat: false })).toBe(0);
    expect(suspectGraceMsFor({ ...owned, ownership: "awaiting-owner" })).toBe(0);
    expect(suspectGraceMsFor({ ...owned, livenessPolicy: "cli-idle" })).toBe(0);
  });

  test("judges the lease from the daemon's resume point after its own stall", () => {
    const session = {
      lastHeartbeat: 1_000,
      stallForgivenAt: 50_000,
      heartbeatTimeoutMs: 10_000,
      livenessPolicy: "heartbeat",
      hasReceivedHeartbeat: true,
      ownership: "owned",
    } as const;

    expect(effectiveLastHeartbeat(session)).toBe(50_000);
    expect(livenessLeaseState(sessionLeaseSnapshot(session, 55_000)).phase).toBe("live");
    // A heartbeat after the resume point wins over the forgiveness floor.
    expect(effectiveLastHeartbeat({ ...session, lastHeartbeat: 52_000 })).toBe(52_000);
  });
});

describe("mint-bound claim-only lease start", () => {
  const mint = {
    lastHeartbeat: 9_000,
    livenessOwnerBoundAt: 0,
    livenessOwnerToken: "minter",
    heartbeatTimeoutMs: 4_000,
    livenessPolicy: "heartbeat",
    hasReceivedHeartbeat: false,
    ownership: "owned",
  } satisfies LeaseSession;

  test("owner heartbeat ignores mint at zero and uses owner proof with the later stall floor", () => {
    expect(ownerLeaseHeartbeat(mint)).toBe(9_000);
    expect(ownerLeaseHeartbeat({ ...mint, lastOwnerHeartbeat: 2_000 })).toBe(2_000);
    expect(ownerLeaseHeartbeat({ ...mint, lastOwnerHeartbeat: 0 })).toBe(0);
    expect(ownerLeaseHeartbeat({ ...mint, stallForgivenAt: 10_000 })).toBe(10_000);
    expect(
      ownerLeaseHeartbeat({ ...mint, lastOwnerHeartbeat: 12_000, stallForgivenAt: 10_000 }),
    ).toBe(12_000);
    const withoutMint = { ...mint, livenessOwnerBoundAt: undefined };
    expect(ownerLeaseHeartbeat(withoutMint)).toBe(9_000);
  });

  test("rolled-back heartbeating claimant keeps every non-claim judgement on the activity clock", () => {
    const rolledBack = { ...mint, hasReceivedHeartbeat: true, lastHeartbeat: 12_000 };
    for (const stallForgivenAt of [undefined, 13_000]) {
      const session = { ...rolledBack, stallForgivenAt };
      const withoutMint = { ...session, livenessOwnerBoundAt: undefined };
      const expectedHeartbeat = stallForgivenAt ?? 12_000;
      expect(judgesOwnerHeartbeats(session)).toBe(true);
      expect(ownerLeaseHeartbeat(session)).toBe(expectedHeartbeat);
      expect(judgedLeaseHeartbeat(session)).toBe(expectedHeartbeat);
      expect(sessionLeaseSnapshot(session, 12_000)).toEqual(
        sessionLeaseSnapshot(withoutMint, 12_000),
      );
      expect(sessionJudgedLeaseSnapshot(session, 12_000)).toEqual(
        sessionJudgedLeaseSnapshot(withoutMint, 12_000),
      );
      expect(ownerLeaseLiveAt(session, 12_000)).toBe(ownerLeaseLiveAt(withoutMint, 12_000));
      expect(sessionOwnerLeaseSnapshot(session, 12_000).lastHeartbeat).toBe(0);
    }
  });

  test("mint claim snapshot ignores an activity-derived stall floor", () => {
    expect(sessionOwnerLeaseSnapshot({ ...mint, stallForgivenAt: 19_000 }, 20_000)).toEqual(
      sessionOwnerLeaseSnapshot(mint, 20_000),
    );
    expect(
      sessionOwnerLeaseSnapshot({ ...mint, livenessOwnerToken: undefined }, 20_000).lastHeartbeat,
    ).toBe(9_000);
  });

  test("claim-only mint grace ends at the same strict lease-plus-grace boundary", () => {
    expect(sessionOwnerLeaseSnapshot(mint, 8_000)).toEqual({
      now: 8_000,
      lastHeartbeat: 0,
      heartbeatTimeoutMs: 4_000,
      livenessPolicy: "heartbeat",
      graceMs: SUSPECT_GRACE_MS,
    });
    expect(livenessLeaseState(sessionOwnerLeaseSnapshot(mint, 8_000)).phase).toBe("suspect");
    expect(livenessLeaseState(sessionOwnerLeaseSnapshot(mint, 8_001)).phase).toBe("lapsed");
  });

  test("mint grace requires an owner token, a mint start, an owned session and owner-lease policy", () => {
    expect(sessionOwnerLeaseSnapshot({ ...mint, livenessOwnerToken: undefined }, 0).graceMs).toBe(
      0,
    );
    expect(sessionOwnerLeaseSnapshot({ ...mint, livenessOwnerBoundAt: undefined }, 0).graceMs).toBe(
      0,
    );
    expect(sessionOwnerLeaseSnapshot({ ...mint, ownership: "awaiting-owner" }, 0).graceMs).toBe(0);
    expect(sessionOwnerLeaseSnapshot({ ...mint, livenessPolicy: "cli-idle" }, 0).graceMs).toBe(0);
    expect(
      sessionOwnerLeaseSnapshot({ ...mint, livenessPolicy: "managed-execution" }, 0).graceMs,
    ).toBe(SUSPECT_GRACE_MS);
    expect(sessionOwnerLeaseSnapshot({ ...mint, lastOwnerHeartbeat: 2_000 }, 0).graceMs).toBe(0);
    expect(
      sessionOwnerLeaseSnapshot(
        { ...mint, lastOwnerHeartbeat: 2_000, hasReceivedHeartbeat: true },
        0,
      ).graceMs,
    ).toBe(SUSPECT_GRACE_MS);
  });

  test("mint start changes no reaper, suspect, raw-heartbeat or stall-eligibility judgement", () => {
    const unbound = { ...mint, livenessOwnerToken: undefined, livenessOwnerBoundAt: undefined };
    expect(suspectGraceMsFor(mint)).toBe(0);
    expect(judgesOwnerHeartbeats(mint)).toBe(false);
    expect(effectiveLastHeartbeat(mint)).toBe(9_000);
    expect(judgedLeaseHeartbeat(mint)).toBe(judgedLeaseHeartbeat(unbound));
    expect(sessionLeaseSnapshot(mint, 12_000)).toEqual(sessionLeaseSnapshot(unbound, 12_000));
    expect(sessionJudgedLeaseSnapshot(mint, 12_000)).toEqual(
      sessionJudgedLeaseSnapshot(unbound, 12_000),
    );
    expect(ownerLeaseLiveAt(mint, 12_000)).toBe(ownerLeaseLiveAt(unbound, 12_000));
    expect(ownerLeaseLiveAt(mint, 13_001)).toBe(false);
  });

  test("owner proof ignores a newer mint start in every existing owner-heartbeat reader", () => {
    const proved = {
      ...mint,
      livenessOwnerBoundAt: 20_000,
      lastOwnerHeartbeat: 2_000,
      hasReceivedHeartbeat: true,
    };
    const withoutMint = { ...proved, livenessOwnerBoundAt: undefined };
    expect(ownerLeaseHeartbeat(proved)).toBe(2_000);
    expect(judgedLeaseHeartbeat(proved)).toBe(judgedLeaseHeartbeat(withoutMint));
    expect(sessionOwnerLeaseSnapshot(proved, 12_000)).toEqual(
      sessionOwnerLeaseSnapshot(withoutMint, 12_000),
    );
    expect(sessionJudgedLeaseSnapshot(proved, 12_000)).toEqual(
      sessionJudgedLeaseSnapshot(withoutMint, 12_000),
    );
  });
});
