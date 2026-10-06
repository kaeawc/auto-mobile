import { describe, expect, test } from "bun:test";
import {
  isLivenessOwnerLeaseLive,
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
