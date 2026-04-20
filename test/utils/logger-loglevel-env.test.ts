import { describe, expect, test } from "bun:test";
import { LogLevel, parseAutomobileLogLevel } from "../../src/utils/logger";

describe("parseAutomobileLogLevel", () => {
  test("returns null for unset or blank", () => {
    expect(parseAutomobileLogLevel(undefined)).toBeNull();
    expect(parseAutomobileLogLevel("")).toBeNull();
    expect(parseAutomobileLogLevel("   ")).toBeNull();
  });

  test("parses known levels case-insensitively", () => {
    expect(parseAutomobileLogLevel("DEBUG")).toBe(LogLevel.DEBUG);
    expect(parseAutomobileLogLevel("Info")).toBe(LogLevel.INFO);
    expect(parseAutomobileLogLevel("warn")).toBe(LogLevel.WARN);
    expect(parseAutomobileLogLevel("warning")).toBe(LogLevel.WARN);
    expect(parseAutomobileLogLevel("ERROR")).toBe(LogLevel.ERROR);
    expect(parseAutomobileLogLevel("none")).toBe(LogLevel.NONE);
    expect(parseAutomobileLogLevel("silent")).toBe(LogLevel.NONE);
  });

  test("returns null for garbage", () => {
    expect(parseAutomobileLogLevel("verbose")).toBeNull();
    expect(parseAutomobileLogLevel("infoo")).toBeNull();
  });
});
