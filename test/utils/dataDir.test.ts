import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { resolveAutoMobileBaseDir, getTempDir, TEMP_SUBDIRS } from "../../src/utils/tempDir";

describe("resolveAutoMobileBaseDir", () => {
  const home = "/home/tester";

  test("prefers AUTOMOBILE_DATA_DIR override, resolved to absolute", () => {
    expect(resolveAutoMobileBaseDir({ AUTOMOBILE_DATA_DIR: "/srv/automobile" }, home))
      .toBe(path.resolve("/srv/automobile"));
  });

  test("honors AUTO_MOBILE_DATA_DIR alias", () => {
    expect(resolveAutoMobileBaseDir({ AUTO_MOBILE_DATA_DIR: "/srv/alias" }, home))
      .toBe(path.resolve("/srv/alias"));
  });

  test("AUTOMOBILE_DATA_DIR wins over the alias", () => {
    expect(
      resolveAutoMobileBaseDir(
        { AUTOMOBILE_DATA_DIR: "/primary", AUTO_MOBILE_DATA_DIR: "/alias" },
        home
      )
    ).toBe(path.resolve("/primary"));
  });

  test("resolves a relative override against cwd", () => {
    const resolved = resolveAutoMobileBaseDir({ AUTOMOBILE_DATA_DIR: "rel/data" }, home);
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(path.join("rel", "data"))).toBe(true);
  });

  test("ignores a blank override and uses the stable home default", () => {
    expect(resolveAutoMobileBaseDir({ AUTOMOBILE_DATA_DIR: "   " }, home))
      .toBe(path.join(home, ".auto-mobile"));
  });

  test("defaults to ~/.auto-mobile, never under os.tmpdir()", () => {
    const base = resolveAutoMobileBaseDir({}, home);
    expect(base).toBe(path.join(home, ".auto-mobile"));
    expect(base.startsWith(os.tmpdir())).toBe(false);
  });

  test("falls back to os.tmpdir()/auto-mobile only when no home dir is available", () => {
    expect(resolveAutoMobileBaseDir({}, ""))
      .toBe(path.join(os.tmpdir(), "auto-mobile"));
  });

  test("does not derive the base from TMPDIR/TMP/TEMP env vars", () => {
    const base = resolveAutoMobileBaseDir(
      { TMPDIR: "/ephemeral/bunx-123", TMP: "/ephemeral/bunx-123", TEMP: "/ephemeral/bunx-123" },
      home
    );
    expect(base).toBe(path.join(home, ".auto-mobile"));
  });
});

describe("getTempDir", () => {
  test("derives every subdirectory from the resolved stable base", () => {
    const logs = getTempDir(TEMP_SUBDIRS.LOGS);
    const base = resolveAutoMobileBaseDir();
    expect(logs).toBe(path.join(base, TEMP_SUBDIRS.LOGS));
  });
});
