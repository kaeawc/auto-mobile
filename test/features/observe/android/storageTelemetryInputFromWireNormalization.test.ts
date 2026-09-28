import { describe, expect, test } from "bun:test";
import {
  normalizeStorageWireValue,
  storageTelemetryInputFromWire,
} from "../../../../src/features/observe/android/AndroidCtrlProxyClient";

describe("storageTelemetryInputFromWire normalization", () => {
  const base = { type: "storage_changed" as const };

  test.each([
    ["INT", 42],
    ["LONG", 42],
    ["FLOAT", 3.5],
    ["BOOLEAN", true],
    ["BOOLEAN", false],
    ["STRING_SET", ["a", "b"]],
  ] as const)("uses the normalized %s value", (valueType, rawValue) => {
    const expected = normalizeStorageWireValue(rawValue, valueType);
    const input = storageTelemetryInputFromWire({ ...base, valueType, value: rawValue }, 1234);

    expect(input?.value).toBe(expected);
  });

  test("rejects an unsafe legacy bare LONG", () => {
    expect(
      storageTelemetryInputFromWire(
        {
          ...base,
          valueType: "LONG",
          value: 9_223_372_036_854_775_807,
        },
        1234,
      ),
    ).toBeUndefined();
  });
});
