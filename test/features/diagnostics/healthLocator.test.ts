import { describe, expect, test } from "bun:test";
import path from "path";
import {
  buildHealthFilename,
  resolveHealthDir,
} from "../../../src/features/diagnostics/healthLocator";


describe("resolveHealthDir", () => {

  test("env var wins over home dir", () => {
    const result = resolveHealthDir({
      envValue: "/explicit/health",
      homeDir: "/home/user",
    });
    expect(result).toBe(path.resolve("/explicit/health"));
  });


  test("trims whitespace and ignores empty env var", () => {
    const result = resolveHealthDir({
      envValue: "   ",
      homeDir: "/home/user",
    });
    expect(result).toBe(path.join("/home/user", ".auto-mobile", "health"));
  });


  test("falls back to home dir when no env var is set", () => {
    const result = resolveHealthDir({
      envValue: undefined,
      homeDir: "/home/user",
    });
    expect(result).toBe(path.join("/home/user", ".auto-mobile", "health"));
  });
});


describe("buildHealthFilename", () => {

  test("encodes ISO timestamp and session uuid into a filesystem-safe filename", () => {
    const result = buildHealthFilename(
      "abc-123",
      new Date("2026-05-21T14:30:45.123Z"),
      "deadbeef"
    );
    expect(result).toBe("health-2026-05-21T14-30-45-123Z-abc-123.json");
  });


  test("strips unsafe characters from session id", () => {
    const result = buildHealthFilename(
      "foo/bar:baz",
      new Date("2026-05-21T00:00:00Z"),
      "deadbeef"
    );
    expect(result).not.toContain("/");
    expect(result).not.toContain(":");
    expect(result).toContain("foo_bar_baz");
  });


  test("uses adhoc-<random> suffix when sessionId is null", () => {
    const result = buildHealthFilename(
      null,
      new Date("2026-05-21T14:30:45.123Z"),
      "deadbeef"
    );
    expect(result).toBe("health-2026-05-21T14-30-45-123Z-adhoc-deadbeef.json");
  });


  test("filenames sort lexicographically by start time", () => {
    const earlier = buildHealthFilename(
      "s1",
      new Date("2026-05-21T10:00:00Z"),
      "aaaaaaaa"
    );
    const later = buildHealthFilename(
      "s1",
      new Date("2026-05-21T11:00:00Z"),
      "aaaaaaaa"
    );
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});
