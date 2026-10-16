import { describe, expect, test } from "bun:test";
import {
  resolveActionCall,
  resolveActionCallWithPerf,
  resolveRotateCall,
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

describe("resolveRotateCall", () => {
  test("maps the positional rotate tail including the orientation lock and display", () => {
    const progress = async () => {};
    const signal = new AbortController().signal;
    expect(resolveRotateCall(progress, true, signal, 4)).toEqual({
      progress,
      lockOrientation: true,
      signal,
      display: 4,
    });
  });

  test("returns the rotate call context unchanged", () => {
    const call = { lockOrientation: false, display: 2 };
    expect(resolveRotateCall(call)).toBe(call);
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
