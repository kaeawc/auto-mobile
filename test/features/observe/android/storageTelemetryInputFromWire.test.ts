import { describe, expect, test } from "bun:test";
import { storageTelemetryInputFromWire } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";

/**
 * Unit tests for the pure wire → telemetry mapping used by the Android
 * `storage_changed` push handler. These pin the #3000 contract: a runner-supplied
 * `previousValue` is threaded through so the repository skips its per-insert
 * previous-value lookup, while legacy runners that omit it fall through to the
 * auto-lookup (field must be absent, not an explicit undefined/null).
 */
describe("storageTelemetryInputFromWire (Android #3000)", () => {
  const base = { type: "storage_changed" as const };

  test("maps the core wire fields with defaults", () => {
    const input = storageTelemetryInputFromWire(
      {
        ...base,
        packageName: "com.example",
        fileName: "prefs.xml",
        key: "theme",
        value: "dark",
        valueType: "STRING",
        changeType: "modify",
      },
      1234,
    );
    expect(input).toEqual({
      timestamp: 1234,
      applicationId: "com.example",
      fileName: "prefs.xml",
      key: "theme",
      value: "dark",
      valueType: "STRING",
      changeType: "modify",
    });
  });

  test("threads a runner-supplied previousValue through", () => {
    const input = storageTelemetryInputFromWire(
      {
        ...base,
        fileName: "prefs.xml",
        key: "theme",
        value: "dark",
        previousValue: "light",
      },
      1000,
    );
    expect(input.previousValue).toBe("light");
  });

  test("honors an explicit previousValue: null verbatim (skips lookup)", () => {
    const input = storageTelemetryInputFromWire(
      {
        ...base,
        fileName: "prefs.xml",
        key: "theme",
        value: "dark",
        previousValue: null,
      },
      1000,
    );
    expect(input).toHaveProperty("previousValue", null);
  });

  test("omits previousValue entirely when the runner does not emit it (auto-lookup)", () => {
    const input = storageTelemetryInputFromWire(
      {
        ...base,
        fileName: "prefs.xml",
        key: "theme",
        value: "dark",
      },
      1000,
    );
    // Field must be absent so the repository's `!== undefined` guard triggers the
    // auto-lookup for legacy runners.
    expect("previousValue" in input).toBe(false);
    expect(input.previousValue).toBeUndefined();
  });

  test("defaults packageName/fileName/valueType/changeType/key/value for sparse messages", () => {
    const input = storageTelemetryInputFromWire({ ...base }, 42);
    expect(input).toEqual({
      timestamp: 42,
      applicationId: null,
      fileName: "",
      key: null,
      value: null,
      valueType: "STRING",
      changeType: "modify",
    });
  });
});
