import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../../src/cli";

// The CLI ran every value through JSON.parse, so a numeric-looking string
// argument arrived as a number and string-typed params rejected it (#4241).
// Coercion must follow the tool's declared zod type, not the token's shape.

describe("parseCliArgs schema-aware coercion (#4241)", () => {
  test("keeps a numeric-looking value as a string for a string-typed param", () => {
    const { params } = parseCliArgs(["inputText", "--platform", "android", "--text", "12345"]);

    expect(params.text).toBe("12345");
    expect(typeof params.text).toBe("string");
  });

  test("keeps an all-digit phone number as a string", () => {
    const { params } = parseCliArgs([
      "sendSms", "--platform", "android", "--phoneNumber", "5551234567", "--message", "hi"
    ]);

    expect(params.phoneNumber).toBe("5551234567");
    expect(typeof params.phoneNumber).toBe("string");
  });

  test("still coerces a number-typed param to a number", () => {
    const { params } = parseCliArgs([
      "videoRecording", "--platform", "android", "--action", "start", "--maxDuration", "240"
    ]);

    expect(params.maxDuration).toBe(240);
    expect(typeof params.maxDuration).toBe("number");
  });

  test("still coerces a boolean-typed param to a boolean", () => {
    const { params } = parseCliArgs(["observe", "--platform", "android", "--raw", "true"]);

    expect(params.raw).toBe(true);
    expect(typeof params.raw).toBe("boolean");
  });

  test("still parses an object-typed param as JSON", () => {
    const { params } = parseCliArgs([
      "tapOn", "--platform", "android", "--selector", '{"text":"Settings"}'
    ]);

    expect(params.selector).toEqual({ text: "Settings" });
  });

  test("a nested string value inside an object param stays a string", () => {
    const { params } = parseCliArgs([
      "tapOn", "--platform", "android", "--selector", '{"text":"12345"}'
    ]);

    expect(params.selector).toEqual({ text: "12345" });
  });

  test("falls back to best-effort parsing for an unknown tool", () => {
    const { params } = parseCliArgs(["noSuchTool", "--count", "5"]);

    expect(params.count).toBe(5);
  });

  test("falls back to best-effort parsing for an undeclared param", () => {
    const { params } = parseCliArgs(["observe", "--platform", "android", "--notARealParam", "5"]);

    expect(params.notARealParam).toBe(5);
  });

  test("bare flags with no value remain true", () => {
    const { params } = parseCliArgs(["observe", "--platform", "android", "--raw"]);

    expect(params.raw).toBe(true);
  });
});
