import { describe, expect, test } from "bun:test";
import {
  UNSETTLED_EXECUTION_VETO_CEILING_MS,
  UnsettledExecutionVeto,
  isReleaseVetoedByExecutions,
  unsettledExecutionVetoExpiresAt,
} from "../../src/daemon/unsettledExecutionVeto";
import { MAX_CALLER_MCP_REQUEST_TIMEOUT_MS } from "../../src/daemon/mcpRequestTimeout";
import { FakeTimer } from "../fakes/FakeTimer";

// #10712: the heartbeat monitor and the owner-disconnect release judge the unsettled-execution
// veto through one shared policy, so their bounds cannot drift apart.

describe("unsettled-execution veto policy (#10712)", () => {
  test("falls back to the caller timeout cap", () => {
    expect(UNSETTLED_EXECUTION_VETO_CEILING_MS).toBe(MAX_CALLER_MCP_REQUEST_TIMEOUT_MS);
    expect(unsettledExecutionVetoExpiresAt(1_000)).toBe(1_000 + MAX_CALLER_MCP_REQUEST_TIMEOUT_MS);
  });

  test("never vetoes once nothing is in flight", () => {
    expect(
      isReleaseVetoedByExecutions({ hasActiveExecutions: false, vetoedSince: 0, now: 0 }),
    ).toBe(false);
  });

  test("vetoes up to, but not at, its bound", () => {
    const input = { hasActiveExecutions: true, vetoedSince: 0, ceilingMs: 1_000 };
    expect(isReleaseVetoedByExecutions({ ...input, now: 999 })).toBe(true);
    expect(isReleaseVetoedByExecutions({ ...input, now: 1_000 })).toBe(false);
  });

  test("tracks each session incarnation's window and restarts it when forgotten", () => {
    const timer = new FakeTimer();
    let active = true;
    const veto = new UnsettledExecutionVeto(() => active, timer, 1_000);
    const session = { sessionId: "s" };

    expect(veto.judge(session)).toEqual({ kind: "kept", until: 1_000, firstKept: true });
    timer.advanceTime(999);
    expect(veto.judge(session)).toEqual({ kind: "kept", until: 1_000, firstKept: false });
    // A re-created session object is a new incarnation with its own window.
    expect(veto.judge({ sessionId: "s" })).toMatchObject({ kind: "kept", until: 1_999 });
    timer.advanceTime(1);
    expect(veto.judge(session)).toEqual({ kind: "expired", vetoedMs: 1_000, boundMs: 1_000 });

    veto.forget(session);
    expect(veto.judge(session)).toMatchObject({ kind: "kept", until: 2_000, firstKept: true });

    active = false;
    expect(veto.judge(session)).toEqual({ kind: "clear" });
  });
});
