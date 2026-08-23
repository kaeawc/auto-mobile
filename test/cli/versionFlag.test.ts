import { describe, expect, test } from "bun:test";
import { getGlobalVersionOutput, hasGlobalVersionFlag } from "../../src/cli/versionFlag";

describe("version flag", () => {
  for (const flag of ["--version", "-v"] as const) {
    test(`${flag} returns the package version for fast-path output`, () => {
      expect(getGlobalVersionOutput([flag], "1.2.3")).toBe("1.2.3");
    });
  }

  test("ignores version-like values after the CLI argument boundary", () => {
    expect(hasGlobalVersionFlag(["--cli", "inputText", "--text", "-v"])).toBe(false);
    expect(hasGlobalVersionFlag(["--debug", "--cli", "inputText", "--text", "--version"])).toBe(
      false,
    );
    expect(hasGlobalVersionFlag(["--version", "--cli", "doctor"])).toBe(true);
    expect(hasGlobalVersionFlag(["-v", "--cli", "doctor"])).toBe(true);
  });

  test("ignores version-like values after the daemon command boundary", () => {
    expect(hasGlobalVersionFlag(["--daemon", "status", "-v"])).toBe(false);
    expect(hasGlobalVersionFlag(["--debug", "--daemon", "status", "--version"])).toBe(false);
    expect(hasGlobalVersionFlag(["--version", "--daemon", "status"])).toBe(true);
    expect(hasGlobalVersionFlag(["-v", "--daemon", "status"])).toBe(true);
  });
});
