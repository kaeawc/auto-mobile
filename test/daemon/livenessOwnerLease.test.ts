import { describe, expect, test } from "bun:test";
import {
  SUSPECT_GRACE_MS,
  effectiveLastHeartbeat,
  isLivenessOwnerLeaseLive,
  livenessLeaseState,
  sessionLeaseSnapshot,
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
