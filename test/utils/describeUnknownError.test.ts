import { describe, expect, test } from "bun:test";
import { describeUnknownError, errorMessage } from "../../src/utils/describeUnknownError";

describe("describeUnknownError", () => {
  test("formats Error with message and truncated stack", () => {
    const err = new Error("boom");
    const s = describeUnknownError(err);
    expect(s).toContain("Error");
    expect(s).toContain("boom");
  });

  test("empty object explains missing keys", () => {
    expect(describeUnknownError({})).toContain("no enumerable keys");
  });

  test("nested Error cause", () => {
    const inner = new Error("inner");
    const outer = new Error("outer", { cause: inner });
    const s = describeUnknownError(outer);
    expect(s).toContain("outer");
    expect(s).toContain("cause=");
    expect(s).toContain("inner");
  });

  test("preserves a custom Error subclass name", () => {
    expect(describeUnknownError(new TypeError("bad type"))).toContain("TypeError");
  });

  test("truncates the stack to the first three frames joined by an arrow", () => {
    const err = new Error("boom");
    err.stack = "L1\nL2\nL3\nL4\nL5";
    expect(describeUnknownError(err)).toBe("Error: boom | L1 ← L2 ← L3");
  });

  test("falls back to the name when the Error message is empty", () => {
    const err = new Error("");
    err.stack = "";
    expect(describeUnknownError(err)).toBe("Error");
  });

  test("stringifies null", () => {
    expect(describeUnknownError(null)).toBe("null");
  });

  test("stringifies undefined", () => {
    expect(describeUnknownError(undefined)).toBe("undefined");
  });

  test("JSON-serializes a plain object with keys", () => {
    expect(describeUnknownError({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  });

  test("serializes a non-empty array", () => {
    expect(describeUnknownError([1, 2])).toBe("[1,2]");
  });

  test("survives a circular object without throwing (crash guard)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeUnknownError(circular)).toBe("[object Object]");
  });

  test("stringifies a string primitive as itself", () => {
    expect(describeUnknownError("plain")).toBe("plain");
  });

  test("stringifies a number primitive", () => {
    expect(describeUnknownError(42)).toBe("42");
  });

  test("stringifies a boolean primitive", () => {
    expect(describeUnknownError(false)).toBe("false");
  });
});

describe("errorMessage", () => {
  test("returns an Error's message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  test("returns a subclass Error's message (message-only, no name)", () => {
    expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
  });

  test("returns a string primitive unchanged", () => {
    expect(errorMessage("plain")).toBe("plain");
  });

  test("stringifies a number", () => {
    expect(errorMessage(42)).toBe("42");
  });

  test("stringifies null", () => {
    expect(errorMessage(null)).toBe("null");
  });

  test("stringifies undefined", () => {
    expect(errorMessage(undefined)).toBe("undefined");
  });

  test("stringifies a plain object as [object Object]", () => {
    expect(errorMessage({ a: 1 })).toBe("[object Object]");
  });
});
