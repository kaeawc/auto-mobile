import { describe, expect, test } from "bun:test";
import { resolveActionCall, resolveRotateCall } from "../../../src/features/action/ActionCall";

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
