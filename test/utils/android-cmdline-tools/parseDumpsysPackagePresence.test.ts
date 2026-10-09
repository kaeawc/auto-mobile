import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDumpsysPackagePresence } from "../../../src/utils/android-cmdline-tools/parseDumpsysPackagePresence";

const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dir, "../../fixtures/android-dumpsys-package", `dumpsys-package-${name}.txt`),
    "utf8",
  );
const PLAYGROUND = "dev.jasonpearson.automobile.playground";

describe("parseDumpsysPackagePresence (captured API 36 dumps)", () => {
  test("installed user app", () => {
    expect(parseDumpsysPackagePresence(fixture("installed"), PLAYGROUND, 0)).toEqual({
      presence: "installed",
      hidden: false,
      suspended: false,
    });
  });

  test("hidden and suspended packages are still installed", () => {
    expect(parseDumpsysPackagePresence(fixture("hidden"), PLAYGROUND, 0)).toMatchObject({
      presence: "installed",
      hidden: true,
    });
    expect(parseDumpsysPackagePresence(fixture("suspended"), PLAYGROUND, 0)).toMatchObject({
      presence: "installed",
      suspended: true,
    });
  });

  test("package PackageManager does not know is absent", () => {
    expect(
      parseDumpsysPackagePresence(fixture("not-installed"), "com.example.not.installed", 0),
    ).toEqual({ presence: "absent" });
  });

  test("uninstalled for the user with retained data is absent", () => {
    expect(
      parseDumpsysPackagePresence(fixture("uninstalled-user0-keepdata"), PLAYGROUND, 0),
    ).toEqual({ presence: "absent" });
    expect(
      parseDumpsysPackagePresence(fixture("system-uninstalled-user0"), "com.android.egg", 0),
    ).toEqual({ presence: "absent" });
  });

  test("no state line for the requested user is unknown, not absent", () => {
    expect(parseDumpsysPackagePresence(fixture("installed"), PLAYGROUND, 10).presence).toBe(
      "unknown",
    );
  });

  test("empty or foreign output is unknown", () => {
    expect(parseDumpsysPackagePresence("", PLAYGROUND, 0).presence).toBe("unknown");
    expect(parseDumpsysPackagePresence(fixture("installed"), "other.pkg", 0).presence).toBe(
      "unknown",
    );
  });
});
