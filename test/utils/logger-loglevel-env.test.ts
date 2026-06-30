import { describe, expect, test } from "bun:test";
import { LogLevel, parseAutomobileLogLevel, resolveProcessLogPrefix } from "../../src/utils/logger";

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

describe("resolveProcessLogPrefix", () => {
  test("uses stable daemon prefix in daemon mode", () => {
    expect(resolveProcessLogPrefix(["auto-mobile", "--daemon-mode"], 123)).toBe("daemon");
  });

  test("uses pid-scoped stdio prefix outside daemon mode", () => {
    expect(resolveProcessLogPrefix(["auto-mobile"], 123)).toBe("stdio-123");
  });
});
