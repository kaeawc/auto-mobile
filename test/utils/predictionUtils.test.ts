import { describe, expect, test } from "bun:test";
import { normalizeToolArgs } from "../../src/utils/predictionUtils";

describe("predictionUtils", () => {
  test("normalizes tool args with stable nested key ordering", () => {
    const first = normalizeToolArgs({
      z: 1,
      nested: { beta: true, alpha: false },
      a: 2,
    });
    const second = normalizeToolArgs({
      a: 2,
      nested: { alpha: false, beta: true },
      z: 1,
    });

    expect(first).toBe(second);
    expect(first).toBe('{"a":2,"nested":{"alpha":false,"beta":true},"z":1}');
  });

  test("strips deviceId so per-device calls share one prediction key", () => {
    const a = normalizeToolArgs({ deviceId: "emulator-5554", text: "hi" });
    const b = normalizeToolArgs({ deviceId: "emulator-5556", text: "hi" });
    expect(a).toBe(b);
    expect(a).toBe('{"text":"hi"}');
  });

  test("strips sessionUuid so per-session calls share one prediction key", () => {
    const a = normalizeToolArgs({ sessionUuid: "aaaa", text: "hi" });
    const b = normalizeToolArgs({ sessionUuid: "bbbb", text: "hi" });
    expect(a).toBe(b);
    expect(a).toBe('{"text":"hi"}');
  });

  test("strips both deviceId and sessionUuid while keeping other args", () => {
    expect(normalizeToolArgs({ deviceId: "d", sessionUuid: "s", x: 1 })).toBe('{"x":1}');
  });

  test("returns an empty string for empty args", () => {
    expect(normalizeToolArgs({})).toBe("");
  });

  test("returns an empty string for null args", () => {
    expect(normalizeToolArgs(null)).toBe("");
  });

  test("returns an empty string for undefined args", () => {
    expect(normalizeToolArgs(undefined)).toBe("");
  });

  test("collapses to an empty object when only strip-keys are present", () => {
    expect(normalizeToolArgs({ deviceId: "d" })).toBe("{}");
  });

  test("preserves keys whose names merely resemble the strip-keys", () => {
    expect(normalizeToolArgs({ device: "a", session: "b", x: 1 })).toBe(
      '{"device":"a","session":"b","x":1}',
    );
  });

  test("produces different keys for genuinely different tool args", () => {
    expect(normalizeToolArgs({ text: "hi" })).not.toBe(normalizeToolArgs({ text: "bye" }));
  });

  test("is independent of input key order", () => {
    expect(normalizeToolArgs({ a: 1, b: 2 })).toBe(normalizeToolArgs({ b: 2, a: 1 }));
  });

  test("keeps deviceId-only differences from splitting history when other args match", () => {
    const first = normalizeToolArgs({ deviceId: "d1", sessionUuid: "s1", action: "tap", x: 5 });
    const second = normalizeToolArgs({ deviceId: "d2", sessionUuid: "s2", action: "tap", x: 5 });
    expect(first).toBe(second);
    expect(first).toBe('{"action":"tap","x":5}');
  });
});
