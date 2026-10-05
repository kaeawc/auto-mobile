import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window, parseActiveWindowModern } from "../../../src/features/observe/Window";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { ExecResult } from "../../../src/models";

const popup = readFileSync(
  join(import.meta.dir, "windowDumps/active-window-with-popup.log"),
  "utf8",
);
const modern = readFileSync(
  join(import.meta.dir, "windowDumps/api31-settings-window-dump.log"),
  "utf8",
);
const exec = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (text) => stdout.includes(text),
});

function setup() {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  const window = new Window(
    { deviceId: "characterization", name: "Test", platform: "android" },
    new FakeAdbClientFactory(adb),
    timer,
    { NODE_ENV: "test" },
  );
  return { adb, timer, window };
}

describe("Window captured-fixture characterization", () => {
  test("preserves popup identity and modern identity from captured dumps", () => {
    expect(parseActiveWindowModern(popup)).toEqual({
      appId: "dev.jasonpearson.automobile.playground",
      activityName: "dev.jasonpearson.android.appshell.MainTabActivity",
    });
    expect(parseActiveWindowModern(modern)).toEqual({
      appId: "com.android.settings",
      activityName: "com.android.settings.Settings",
    });
  });

  test("assigns memory cache before writing it and returns the same object on the next read", async () => {
    const { adb, window } = setup();
    adb.setDefaultResponse(exec(popup));
    let writes = 0;
    window["writeCacheToDisk"] = async (result) => {
      writes++;
      expect(await window.getCachedActiveWindow()).toBe(result);
    };
    const result = await window.getActive(true);
    expect(await window.getActive()).toBe(result);
    expect(writes).toBe(1);
    expect(adb.getExecutedCommands()).toEqual(['shell "dumpsys window windows"']);
  });

  test("read-only refresh and transport failures preserve the previous memory cache", async () => {
    const { adb, window } = setup();
    const cached = { appId: "cached", activityName: "Main", layoutSeqSum: 2 };
    await window.setCachedActiveWindow(cached);
    adb.setDefaultResponse(exec(popup));
    expect((await window.getActive(true, undefined, { cacheResult: false })).appId).toBe(
      "dev.jasonpearson.automobile.playground",
    );
    expect(await window.getCachedActiveWindow()).toBe(cached);
    adb.setDefaultError(new Error("transport unavailable"));
    expect(await window.getActive(true)).toEqual({ appId: "", activityName: "", layoutSeqSum: 0 });
    expect(await window.getCachedActiveWindow()).toBe(cached);
  });

  test("reads disk cache before any device commands and skips it on refresh", async () => {
    const { adb, window } = setup();
    const cached = { appId: "cached", activityName: "Main", layoutSeqSum: 2 };
    let reads = 0;
    window["readCacheFromDisk"] = async () => {
      reads++;
      return cached;
    };
    expect(await window.getActive()).toBe(cached);
    expect(adb.getExecutedCommands()).toEqual([]);
    adb.setDefaultResponse(exec(modern));
    expect((await window.getActive(true)).appId).toBe("com.android.settings");
    expect(reads).toBe(1);
  });
});
