import { describe, expect, test } from "bun:test";
import { ActionableError, toActionableError } from "../../src/models/ActionableError";

describe("toActionableError", () => {
  test("prefixes context and extracts message from an Error", () => {
    const cause = new Error("boom");
    const result = toActionableError(cause, "Failed to start recording");

    expect(result).toBeInstanceOf(ActionableError);
    expect(result.message).toBe("Failed to start recording: boom");
    expect(result.cause).toBe(cause);
  });

  test("stringifies non-Error values", () => {
    const result = toActionableError("plain string failure", "Context");

    expect(result.message).toBe("Context: plain string failure");
  });

  test("handles null and undefined", () => {
    expect(toActionableError(null, "Context").message).toBe("Context: null");
    expect(toActionableError(undefined, "Context").message).toBe("Context: undefined");
  });

  test("returns the same ActionableError unchanged when already actionable", () => {
    const original = new ActionableError("already actionable");
    const result = toActionableError(original, "Context");

    expect(result).toBe(original);
  });
});
