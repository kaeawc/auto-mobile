import { describe, expect, test } from "bun:test";
import { AdbCommandTimeoutError } from "../../../src/utils/android-cmdline-tools/AdbClient";
import {
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
