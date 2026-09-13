import { describe, expect, test } from "bun:test";
import { hasGlobalHelpFlag } from "../../src/cli/helpFlag";

describe("global help", () => {
  test("accepts long and short help flags before command boundaries", () => {
    expect(hasGlobalHelpFlag(["--help"])).toBe(true);
    expect(hasGlobalHelpFlag(["-h"])).toBe(true);
    expect(hasGlobalHelpFlag(["--debug", "--help"])).toBe(true);
  });
  test("preserves tool and daemon argument values", () => {
    expect(hasGlobalHelpFlag(["--cli", "inputText", "--text", "--help"])).toBe(false);
    expect(hasGlobalHelpFlag(["--daemon", "status", "-h"])).toBe(false);
    expect(hasGlobalHelpFlag(["--boot-device", "--name", "-h"])).toBe(false);
  });
});
