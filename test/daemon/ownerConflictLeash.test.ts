import { describe, expect, test } from "bun:test";
import { daemonResponseError } from "../../src/daemon/client";
import {
  LIVE_OWNER_HANDOFF_ALLOWANCE_MS,
  advanceOwnerConflictLeash,
  type OwnerConflictLeash,
} from "../../src/daemon/proxyLivenessRecovery";
import { livenessOwnerHold } from "../../src/daemon/livenessOwnerLease";
import { DAEMON_LIVENESS_OWNER_CONFLICT_CODE } from "../../src/daemon/types";

// #10701: the challenger's leash follows the daemon's report of the owner's hold.

const FALLBACK_MS = 10_000;
const TICK_MS = 2_000;

/** Feed one refusal per tick; `holdRemainingAt(t)` is what the daemon reports at time t. */
function run(
  ticks: number,
  holdRemainingAt: ((now: number) => number) | undefined,
): { exhaustedAt: number | undefined; leash: OwnerConflictLeash | undefined } {
  let leash: OwnerConflictLeash | undefined;
  for (let tick = 0; tick < ticks; tick++) {
    const now = tick * TICK_MS;
    const next = advanceOwnerConflictLeash(
      leash,
      now,
      holdRemainingAt ? { holdRemainingMs: holdRemainingAt(now) } : undefined,
      FALLBACK_MS,
    );
    leash = next.leash;
    if (next.exhausted) {
      return { exhaustedAt: now, leash };
    }
  }
  return { exhaustedAt: undefined, leash };
}

describe("advanceOwnerConflictLeash", () => {
  test("an owner that stopped is waited out however long the daemon's hold, never given up on", () => {
    // A 30 s lease plus grace the owner last renewed at t=0: the reported end never moves.
    const result = run(30, (now) => Math.max(0, 34_000 - now));
    expect(result.exhaustedAt).toBeUndefined();
    expect(result.leash).toEqual({ since: 0, holdEndsAt: 34_000 });
  });

  test("an owner that keeps renewing is given up on once the handoff allowance has passed", () => {
    const result = run(LIVE_OWNER_HANDOFF_ALLOWANCE_MS / TICK_MS + 5, () => 8_000);
    expect(result.exhaustedAt).toBe(LIVE_OWNER_HANDOFF_ALLOWANCE_MS);
  });

  test("an owner that renews for a while and then stops is never given up on", () => {
    const stopsAt = 20_000;
    const result = run(60, (now) => (now < stopsAt ? 8_000 : Math.max(0, stopsAt + 8_000 - now)));
    expect(result.exhaustedAt).toBeUndefined();
  });

  test("request latency jitter in the reported end is not taken for a renewal", () => {
    const result = run(60, (now) => 34_000 - now + (now % 4_000 === 0 ? 300 : -300));
    expect(result.exhaustedAt).toBeUndefined();
  });

  test("without a report (an older daemon) the fallback leash runs from the first refusal", () => {
    expect(run(20, undefined).exhaustedAt).toBe(FALLBACK_MS);
  });
});

describe("the conflict refusal carries the owner's hold to the challenger", () => {
  test("livenessOwnerHold reports the time left in the lease and in the whole hold", () => {
    const snapshot = {
      lastHeartbeat: 1_000,
      heartbeatTimeoutMs: 30_000,
      livenessPolicy: "heartbeat" as const,
      graceMs: 4_000,
    };
    expect(livenessOwnerHold({ ...snapshot, now: 11_000 })).toEqual({
      state: "live",
      remainingMs: 20_000,
      holdRemainingMs: 24_000,
    });
    expect(livenessOwnerHold({ ...snapshot, now: 33_000 })).toEqual({
      state: "suspect",
      remainingMs: 2_000,
      holdRemainingMs: 2_000,
    });
    expect(livenessOwnerHold({ ...snapshot, now: 40_000 })).toEqual({
      state: "lapsed",
      remainingMs: 0,
      holdRemainingMs: 0,
    });
  });

  test("the socket client attaches a well-formed hold to the conflict error, and only to it", () => {
    const liveness = { state: "live", remainingMs: 3_000, holdRemainingMs: 7_000 };
    const conflict = daemonResponseError({
      id: "1",
      type: "mcp_response",
      success: false,
      error: "owned by another liveness owner",
      code: DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
      result: { liveness },
    });
    expect(conflict).toMatchObject({
      code: DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
      livenessOwnerHold: liveness,
    });

    const malformed = daemonResponseError({
      id: "2",
      type: "mcp_response",
      success: false,
      error: "owned by another liveness owner",
      code: DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
      result: { liveness: { state: "live", remainingMs: -1, holdRemainingMs: "soon" } },
    });
    expect(malformed).not.toHaveProperty("livenessOwnerHold");

    const otherCode = daemonResponseError({
      id: "3",
      type: "mcp_response",
      success: false,
      error: "not found",
      code: "daemon_session_not_found",
      result: { liveness },
    });
    expect(otherCode).not.toHaveProperty("livenessOwnerHold");
  });
});
