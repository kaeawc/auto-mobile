import { describe, expect, test } from "bun:test";
import {
  UNSETTLED_EXECUTION_DEADLINE_GRACE_MS,
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
    expect(unsettledExecutionVetoExpiresAt({ vetoedSince: 1_000 })).toBe(
      1_000 + MAX_CALLER_MCP_REQUEST_TIMEOUT_MS,
    );
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
    expect(veto.judge(session)).toEqual({ kind: "expired", vetoedMs: 1_000, bound: "ceiling" });

    veto.forget(session);
    expect(veto.judge(session)).toMatchObject({ kind: "kept", until: 2_000, firstKept: true });

    active = false;
    expect(veto.judge(session)).toEqual({ kind: "clear" });
  });

  test("is bounded by the vetoing executions' request deadline plus grace", () => {
    expect(unsettledExecutionVetoExpiresAt({ vetoedSince: 0, latestDeadlineMs: 60_000 })).toBe(
      60_000 + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS,
    );
    // An execution without a deadline keeps the fallback ceiling.
    expect(
      unsettledExecutionVetoExpiresAt({
        vetoedSince: 0,
        latestDeadlineMs: Number.POSITIVE_INFINITY,
      }),
    ).toBe(UNSETTLED_EXECUTION_VETO_CEILING_MS);
  });

  test("follows a deadline that progress extends", () => {
    const timer = new FakeTimer();
    let deadlineMs = 30_000;
    const veto = new UnsettledExecutionVeto(
      { hasActiveExecutions: () => true, latestExecutionDeadlineMs: () => deadlineMs },
      timer,
    );
    const session = { sessionId: "s" };
    const releaseAt = deadlineMs + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS;

    timer.setCurrentTime(releaseAt - 1);
    expect(veto.judge(session)).toMatchObject({ kind: "kept", until: releaseAt });
    deadlineMs = 90_000;
    timer.setCurrentTime(releaseAt);
    expect(veto.judge(session)).toMatchObject({ kind: "kept" });
    timer.setCurrentTime(deadlineMs + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS);
    expect(veto.judge(session)).toMatchObject({ kind: "expired", bound: "request-deadline" });
  });
});
