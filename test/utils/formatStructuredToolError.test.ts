import { describe, expect, test } from "bun:test";
import { formatStructuredToolError } from "../../src/utils/formatStructuredToolError";

describe("formatStructuredToolError", () => {
  test("renders a structured {code, message} error as 'code: message'", () => {
    expect(
      formatStructuredToolError({
        code: "device_already_stopped",
        message: "Emulator is not running",
      }),
    ).toBe("device_already_stopped: Emulator is not running");
  });

  test("returns a plain string error unchanged", () => {
    expect(formatStructuredToolError("boom")).toBe("boom");
  });

  test("falls back to message-only when code is absent", () => {
    expect(formatStructuredToolError({ message: "just a message" })).toBe("just a message");
  });

  test("returns undefined for a shapeless object so callers can pick their own fallback", () => {
    expect(formatStructuredToolError({ detail: 42 })).toBeUndefined();
  });

  test("returns undefined for null/undefined/non-string primitives", () => {
    expect(formatStructuredToolError(null)).toBeUndefined();
    expect(formatStructuredToolError(undefined)).toBeUndefined();
    expect(formatStructuredToolError(42)).toBeUndefined();
  });
});
