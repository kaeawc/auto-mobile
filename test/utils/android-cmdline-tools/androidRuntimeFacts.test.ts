import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  parseAndroidRuntimeFacts,
  readAndroidRuntimeFacts,
  withRuntimeFacts,
} from "../../../src/utils/android-cmdline-tools/androidRuntimeFacts";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";

const fixture = (path: string): string =>
  readFileSync(new URL(`../../fixtures/${path}.txt`, import.meta.url), "utf8");

describe("parseAndroidRuntimeFacts", () => {
  test("reads API level, canonical release and physical display", () => {
    expect(
      parseAndroidRuntimeFacts({
        sdk: "24\n",
        release: "7.0\n",
        size: fixture("android-display-geometry/wm-size-override"),
        density: fixture("android-display-config/density-physical-420"),
      }),
    ).toEqual({
      apiLevel: 24,
      osVersion: "7.0",
      screenWidth: 1080,
      screenHeight: 2400,
      screenDensity: 420,
    });
  });

  test("falls back to the raw release for an API level outside the table", () => {
    expect(
      parseAndroidRuntimeFacts({ sdk: "999\n", release: "Baklava\n", size: "", density: "" }),
    ).toEqual({ apiLevel: 999, osVersion: "Baklava" });
  });

  test("unreadable output yields no facts", () => {
    expect(parseAndroidRuntimeFacts({ sdk: "", release: "", size: "", density: "" })).toEqual({});
  });
});

describe("readAndroidRuntimeFacts", () => {
  test("a failed read leaves only that fact unset", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult("shell getprop ro.build.version.sdk", "24\n");
    adb.setCommandResult("shell getprop ro.build.version.release", "7.0\n");
    adb.setCommandResult("shell wm size", fixture("android-display-geometry/wm-size-physical"));
    adb.setCommandError("shell wm density", new Error("device offline"));

    expect(await readAndroidRuntimeFacts(adb, { timeoutMs: 1_000 })).toEqual({
      apiLevel: 24,
      osVersion: "7.0",
      screenWidth: 1080,
      screenHeight: 2400,
    });
  });
});

describe("withRuntimeFacts", () => {
  test("values already on the device win", () => {
    expect(
      withRuntimeFacts(
        { deviceId: "emulator-5554", name: "a", platform: "android", apiLevel: 35 },
        { apiLevel: 24, screenDensity: 420 },
      ),
    ).toEqual({
      deviceId: "emulator-5554",
      name: "a",
      platform: "android",
      apiLevel: 35,
      screenDensity: 420,
    });
  });
});
