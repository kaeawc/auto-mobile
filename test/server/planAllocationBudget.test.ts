import { afterEach, describe, expect, test } from "bun:test";
import {
  registerLiveDeadline,
  unregisterLiveDeadline,
} from "../../src/daemon/liveDeadlineRegistry";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import {
  ALLOCATION_BUDGET_RESERVE_MS,
  boundAllocationTimeoutMs,
} from "../../src/server/planAllocationBudget";

// #10153: the allocation wait must never outlast the request that asked for it.
describe("boundAllocationTimeoutMs", () => {
  const LIVE_KEY = "plan-allocation-budget";

  afterEach(() => {
    unregisterLiveDeadline(LIVE_KEY);
  });

  test("keeps the requested timeout when the request has no known deadline", () => {
    expect(boundAllocationTimeoutMs(300_000, undefined, 1_000)).toBe(300_000);
    expect(boundAllocationTimeoutMs(300_000, {}, 1_000)).toBe(300_000);
  });

  test("bounds the wait by the anchored request deadline less the reserve", () => {
    const planRequest = { deadlineMs: 61_000 };
    expect(boundAllocationTimeoutMs(300_000, planRequest, 1_000)).toBe(
      60_000 - ALLOCATION_BUDGET_RESERVE_MS,
    );
  });

  test("derives the deadline from the start time and timeout when no anchored deadline exists", () => {
    const planRequest = { startTime: 1_000, timeoutMs: 120_000 };
    expect(boundAllocationTimeoutMs(300_000, planRequest, 11_000)).toBe(
      110_000 - ALLOCATION_BUDGET_RESERVE_MS,
    );
  });

  test("keeps a requested timeout that already fits inside the budget", () => {
    expect(boundAllocationTimeoutMs(6_000, { deadlineMs: 601_000 }, 1_000)).toBe(6_000);
  });

  test("prefers the live deadline, which progress can extend", () => {
    registerLiveDeadline(LIVE_KEY, new ProgressExtendableDeadline(0, 200_000));
    const planRequest = { deadlineMs: 20_000, liveDeadlineKey: LIVE_KEY };
    expect(boundAllocationTimeoutMs(300_000, planRequest, 10_000)).toBe(
      190_000 - ALLOCATION_BUDGET_RESERVE_MS,
    );
  });

  test("falls back to the anchored deadline once the live entry is gone", () => {
    const planRequest = { deadlineMs: 21_000, liveDeadlineKey: LIVE_KEY };
    expect(boundAllocationTimeoutMs(300_000, planRequest, 1_000)).toBe(
      20_000 - ALLOCATION_BUDGET_RESERVE_MS,
    );
  });

  test("never goes negative when the budget is spent", () => {
    expect(boundAllocationTimeoutMs(300_000, { deadlineMs: 2_000 }, 1_000)).toBe(0);
    expect(boundAllocationTimeoutMs(300_000, { deadlineMs: 500 }, 1_000)).toBe(0);
  });
});
