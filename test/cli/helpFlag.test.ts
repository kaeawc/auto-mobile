import { describe, expect, test } from "bun:test";
import { hasGlobalHelpFlag, isCliHelpInvocation } from "../../src/cli/helpFlag";

describe("global help", () => {
  test("accepts long and short help flags before command boundaries", () => {
    expect(hasGlobalHelpFlag(["--help"])).toBe(true);
    expect(hasGlobalHelpFlag(["-h"])).toBe(true);
    expect(hasGlobalHelpFlag(["--debug", "--help"])).toBe(true);
  });
  test("preserves tool and daemon argument values", () => {
    expect(hasGlobalHelpFlag(["--cli", "sendKeys", "--commands", "--help"])).toBe(false);
    expect(hasGlobalHelpFlag(["--daemon", "status", "-h"])).toBe(false);
    expect(hasGlobalHelpFlag(["--boot-device", "--name", "-h"])).toBe(false);
  });
});

describe("isCliHelpInvocation", () => {
  test("usage-only --cli invocations skip device startup work without touching disk", () => {
    expect(isCliHelpInvocation(true, [])).toBe(true);
    expect(isCliHelpInvocation(true, ["help"])).toBe(true);
    expect(isCliHelpInvocation(true, ["help", "observe"])).toBe(true);
    expect(isCliHelpInvocation(true, ["--help"])).toBe(true);
    expect(isCliHelpInvocation(true, ["-h"])).toBe(true);
  });
  test("device-facing commands and non-CLI modes keep the prefetch", () => {
    expect(isCliHelpInvocation(true, ["observe"])).toBe(false);
    expect(isCliHelpInvocation(true, ["getAndroid", "--help"])).toBe(false);
    expect(isCliHelpInvocation(false, [])).toBe(false);
    expect(isCliHelpInvocation(false, ["help"])).toBe(false);
  });
});
