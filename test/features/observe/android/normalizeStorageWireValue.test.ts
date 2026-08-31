import { describe, expect, test } from "bun:test";
import {
  normalizeStorageWireValue,
  parseCtrlProxyJson,
} from "../../../../src/features/observe/android/AndroidCtrlProxyClient";

/**
 * Unit tests for the pure wire-value normalization used by the Android
 * `storage_changed` push handler. The CtrlProxy runner emits `value` as a raw JSON
 * fragment: a quoted string for STRING preferences, but a bare JSON number /
 * boolean / array for INT, LONG, FLOAT, BOOLEAN, and STRING_SET. `JSON.parse` on
 * the wire frame therefore yields a JS number/boolean/array for those types.
 * Forwarding that runtime value unchanged makes the desktop `storage_update` frame
 * fail kotlinx-serialization decoding (`StorageEventData.value` is `String?`), so
 * live updates silently drop for every non-string preference type (#4709 review).
 * These pin the string contract each desktop `parseKeyValue` case decodes back.
 */
describe("normalizeStorageWireValue (#4709)", () => {
  test("passes a STRING value through unchanged", () => {
    expect(normalizeStorageWireValue("dark")).toBe("dark");
  });

  test("re-encodes an INT/LONG value to its decimal string", () => {
    expect(normalizeStorageWireValue(42)).toBe("42");
  });

  test("preserves an unsafe legacy bare LONG before JSON number rounding", () => {
    const message = parseCtrlProxyJson<{ value: unknown }>(
      '{"type":"storage_changed","valueType":"LONG","value":9223372036854775807}',
    );

    expect(normalizeStorageWireValue(message.value)).toBe("9223372036854775807");
  });

  test("re-encodes a FLOAT value to its string form", () => {
    expect(normalizeStorageWireValue(3.5)).toBe("3.5");
  });

  test("re-encodes a BOOLEAN value to 'true'/'false'", () => {
    expect(normalizeStorageWireValue(true)).toBe("true");
    expect(normalizeStorageWireValue(false)).toBe("false");
  });

  test("re-encodes a STRING_SET array to a JSON-array string parseKeyValue can read", () => {
    // Desktop parseKeyValue's StringSet branch runs Json.parseToJsonElement(...).jsonArray, so the
    // wire value must be a JSON-array string, not a JS array whose decode would fail the frame.
    expect(normalizeStorageWireValue(["a", "b"])).toBe('["a","b"]');
  });

  test("maps null/undefined (deleted key / cleared file) to null", () => {
    expect(normalizeStorageWireValue(null)).toBeNull();
    expect(normalizeStorageWireValue(undefined)).toBeNull();
  });

  test("does not double-encode an already-string value", () => {
    // A STRING preference arrives already quoted on the wire, so JSON.parse yields the bare string;
    // it must not be re-quoted into '"already"'.
    expect(normalizeStorageWireValue('{"looks":"like json"}')).toBe('{"looks":"like json"}');
  });
});
