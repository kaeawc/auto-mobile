import { describe, expect, test } from "bun:test";
import { returnsRawHierarchyUnfiltered } from "../../../src/features/action/tapHierarchyRead";
import { LONG_PRESS_HARD_MAX_MS } from "../../../src/features/action/tapAtGesture";
import { AdbCommandTimeoutError } from "../../../src/utils/android-cmdline-tools/AdbClient";
import {
  assertLongPressWithinHardMax,
  containerSelectorError,
  failedTapResult,
  resolveSearchUntilDuration,
  throwIfLongPressInterrupted,
} from "../../../src/features/action/tapSharedHelpers";

const bounds = { defaultMs: 1500, minMs: 100, maxMs: 12000 };

describe("tapSharedHelpers", () => {
  test("search duration defaults, rounds and enforces bounds", () => {
    expect(resolveSearchUntilDuration(undefined, bounds)).toBe(1500);
    expect(resolveSearchUntilDuration(250.4, bounds)).toBe(250);
    expect(() => resolveSearchUntilDuration(50, bounds)).toThrow("at least 100ms");
    expect(() => resolveSearchUntilDuration(13000, bounds)).toThrow("at most 12000ms");
    expect(() => resolveSearchUntilDuration(Number.NaN, bounds)).toThrow("must be a number");
  });

  test("long press interruption is reported only for abort/timeout errors", () => {
    expect(() => throwIfLongPressInterrupted(new Error("boom"), 500)).not.toThrow();
    expect(() => throwIfLongPressInterrupted(new Error("boom"), 500, AbortSignal.abort())).toThrow(
      "Android long press interrupted",
    );
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(() => throwIfLongPressInterrupted(abort, 500)).toThrow("up to 500 ms");
    expect(() =>
      throwIfLongPressInterrupted(Object.create(AdbCommandTimeoutError.prototype), 500),
    ).toThrow("Wait 500 ms");
  });
});

describe("tapSharedHelpers (#11832 remainder)", () => {
  test("container selector needs exactly one of elementId or text", () => {
    expect(containerSelectorError(undefined, "tapOn")).toBeNull();
    expect(containerSelectorError({ text: "a" }, "tapOn")).toBeNull();
    expect(containerSelectorError({ elementId: "i", text: "a" }, "tapAny")).toBe(
      "tapAny container must specify exactly one of elementId or text",
    );
    expect(containerSelectorError({}, "tapOn")).toBe(
      "tapOn container must specify exactly one of elementId or text",
    );
  });

  test("longPress hard max rejects only durations above the ceiling", () => {
    expect(() => assertLongPressWithinHardMax(undefined)).not.toThrow();
    expect(() => assertLongPressWithinHardMax(LONG_PRESS_HARD_MAX_MS)).not.toThrow();
    expect(() => assertLongPressWithinHardMax(LONG_PRESS_HARD_MAX_MS + 1)).toThrow(
      `maximum is ${LONG_PRESS_HARD_MAX_MS} ms; requested ${LONG_PRESS_HARD_MAX_MS + 1} ms`,
    );
  });

  test("failed result carries an empty origin element", () => {
    expect(failedTapResult("tap", "boom")).toEqual({
      success: false,
      action: "tap",
      error: "boom",
      element: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
    });
  });

  test("raw hierarchy passes through when raw search is off or the tree is an error", () => {
    const ok = { hierarchy: { node: {} } } as never;
    const errored = { hierarchy: { error: "no a11y" } } as never;
    expect(returnsRawHierarchyUnfiltered(false, ok)).toBe(true);
    expect(returnsRawHierarchyUnfiltered(true, errored)).toBe(true);
    expect(returnsRawHierarchyUnfiltered(true, ok)).toBe(false);
  });
});
