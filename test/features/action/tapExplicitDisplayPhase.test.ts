import { describe, expect, test } from "bun:test";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { KeyboardOcclusionError } from "../../../src/models/KeyboardOcclusionError";
import { DispatchedObservationError } from "../../../src/models/DispatchedObservationError";
import { StaleDisplayError } from "../../../src/features/observe/StaleDisplayError";
import {
  completedDisplayFailure,
  didCompleteDisplayGesture,
  rethrowKeyboardOcclusion,
} from "../../../src/features/action/tapExplicitDisplayPhase";

describe("tapExplicitDisplayPhase helpers", () => {
  test("didCompleteDisplayGesture needs an explicit display and a real gesture", () => {
    expect(didCompleteDisplayGesture({ success: true }, "external")).toBe(true);
    expect(didCompleteDisplayGesture({ success: true }, undefined)).toBe(false);
    expect(didCompleteDisplayGesture({ success: true, wasAlreadyFocused: true }, "e")).toBe(false);
    expect(didCompleteDisplayGesture({ success: false }, "e")).toBe(false);
  });

  test("completedDisplayFailure wraps a stale display only after dispatch", () => {
    const stale = new StaleDisplayError({ observedGeneration: 1, currentGeneration: 2 });
    expect(completedDisplayFailure(stale, true)).toBeInstanceOf(DispatchedObservationError);
    expect(completedDisplayFailure(stale, false)).toBe(stale);
    const other = new Error("x");
    expect(completedDisplayFailure(other, true)).toBe(other);
  });

  test("rethrowKeyboardOcclusion only rethrows for opted-in android focus", () => {
    const error = new KeyboardOcclusionError("covered");
    expect(() =>
      rethrowKeyboardOcclusion(new FakeTapStrategy("android"), error, "focus", {
        throwOnKeyboardOcclusion: true,
      }),
    ).toThrow(error);
    expect(() =>
      rethrowKeyboardOcclusion(new FakeTapStrategy("android"), error, "focus"),
    ).not.toThrow();
    expect(() =>
      rethrowKeyboardOcclusion(new FakeTapStrategy("ios"), error, "focus", {
        throwOnKeyboardOcclusion: true,
      }),
    ).not.toThrow();
    expect(() =>
      rethrowKeyboardOcclusion(new FakeTapStrategy("android"), error, "tap", {
        throwOnKeyboardOcclusion: true,
      }),
    ).not.toThrow();
  });
});
