import { describe, expect, test } from "bun:test";
import {
  resolveActionCall,
  deadlineRequest,
  isAbortSignal,
  resolveSignalCall,
  resolveActionCallWithPerf,
  resolveDeadlineActionCall,
  resolveTapAtCall,
} from "../../../src/features/action/ActionCall";

import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";

describe("resolveActionCall", () => {
  test("returns the call context unchanged", () => {
    const call = { signal: new AbortController().signal };
    expect(resolveActionCall(call)).toBe(call);
  });

  test("maps the deprecated positional progress and signal", () => {
    const progress = async () => {};
    const signal = new AbortController().signal;
    expect(resolveActionCall(progress, signal)).toEqual({ progress, signal });
    expect(resolveActionCall(undefined, signal)).toEqual({ progress: undefined, signal });
  });
});

describe("resolveActionCallWithPerf", () => {
  test("maps the deprecated positional progress, perf and signal", () => {
    const progress = async () => {};
    const perf = new NoOpPerformanceTracker();
    const signal = new AbortController().signal;
    expect(resolveActionCallWithPerf(progress, perf, signal)).toEqual({ progress, perf, signal });
  });

  test("returns the call context unchanged, carrying its own perf", () => {
    const call = { perf: new NoOpPerformanceTracker() };
    expect(resolveActionCallWithPerf(call)).toBe(call);
  });
});

describe("tap call resolvers", () => {
  test("tapAny maps the positional request deadline onto the call", () => {
    expect(resolveDeadlineActionCall(undefined, undefined, { requestDeadlineMs: 7 })).toEqual({
      progress: undefined,
      signal: undefined,
      deadlineMs: 7,
    });
  });

  test("tapAt maps the positional plan context onto the call", () => {
    const planContext = { step: 1 };
    expect(resolveTapAtCall(undefined, undefined, planContext).planContext).toBe(planContext);
    const call = { planContext };
    expect(resolveTapAtCall(call)).toBe(call);
  });

  test("deadlineRequest only builds the legacy carrier when a deadline exists", () => {
    expect(deadlineRequest(undefined)).toBeUndefined();
    expect(deadlineRequest(5)).toEqual({ requestDeadlineMs: 5 });
  });
});

describe("signal-only call resolution", () => {
  test("tells an AbortSignal from an ActionCall", () => {
    const signal = new AbortController().signal;
    expect(isAbortSignal(signal)).toBe(true);
    expect(isAbortSignal({ signal })).toBe(false);
    expect(isAbortSignal(undefined)).toBe(false);
  });

  test("wraps a bare signal and passes a call context through", () => {
    const signal = new AbortController().signal;
    expect(resolveSignalCall(signal)).toEqual({ signal });
    expect(resolveSignalCall(undefined)).toEqual({ signal: undefined });
    const call = { signal };
    expect(resolveSignalCall(call)).toBe(call);
  });
});
