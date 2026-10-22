import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppLifecycle } from "../../../src/features/action/AppLifecycle";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const appId = "com.google.android.contacts";
const processCommand = "shell dumpsys activity processes";
const device: BootedDevice = { deviceId: "fake-android", name: "Fake", platform: "android" };
// A captured dumpsys activity dump whose Contacts ProcessRecord pid is 3220.
const running = readFileSync(
  join(import.meta.dir, "../observe/activityActivitiesDumps", "api36-home-settings-secondapp.log"),
  "utf8",
);
const notRunning = readFileSync(
  join(import.meta.dir, "../observe/activityActivitiesDumps", "single-display-phone.log"),
  "utf8",
);
const result = (stdout: string, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value) => stdout.includes(value),
});

function harness(dump = running, platform: BootedDevice["platform"] = "android") {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse(processCommand, result(dump));
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const action = new AppLifecycle(
    { ...device, platform },
    { adb, timer, cacheInvalidator: { retireAppProcess: () => {}, invalidate: () => {} } },
  );
  return { adb, action };
}

const trimCommands = (adb: FakeAdbExecutor) =>
  adb.getExecutedCommands().filter((command) => command.includes("send-trim-memory"));

describe("AppLifecycle trimMemory (#14090)", () => {
  test("sends the level to the running process for its user without killing it", async () => {
    const { adb, action } = harness();
    const response = await action.execute(appId, "trimMemory", { trimLevel: "COMPLETE" });

    expect(response).toMatchObject({
      success: true,
      action: "trimMemory",
      mechanism: "am-send-trim-memory",
      trimLevel: "COMPLETE",
      userId: 0,
      pidBefore: 3220,
    });
    expect(trimCommands(adb)).toEqual([`shell am send-trim-memory --user 0 '${appId}' COMPLETE`]);
    expect(adb.getExecutedCommands().some((command) => command.includes("am kill"))).toBe(false);
  });

  test("UI_HIDDEN is HIDDEN to the shell; the other levels keep their names", async () => {
    const { adb, action } = harness();
    await action.execute(appId, "trimMemory", { trimLevel: "UI_HIDDEN" });
    await action.execute(appId, "trimMemory", { trimLevel: "RUNNING_CRITICAL" });
    expect(trimCommands(adb).map((command) => command.split(" ").at(-1))).toEqual([
      "HIDDEN",
      "RUNNING_CRITICAL",
    ]);
  });

  test("a missing level is refused before any device command", async () => {
    const { adb, action } = harness();
    const response = await action.execute(appId, "trimMemory");
    expect(response).toMatchObject({ success: false, errorCode: "trim_level_required" });
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("a level on another action is refused before any device command", async () => {
    const { adb, action } = harness();
    const response = await action.execute(appId, "background", { trimLevel: "COMPLETE" });
    expect(response).toMatchObject({ success: false, errorCode: "trim_level_not_applicable" });
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("an app that is not running is a typed refusal", async () => {
    const { adb, action } = harness(notRunning);
    const response = await action.execute(appId, "trimMemory", { trimLevel: "COMPLETE" });
    expect(response).toMatchObject({ success: false, errorCode: "app_not_running" });
    expect(trimCommands(adb)).toEqual([]);
  });

  test("an invalid package name never reaches the shell", async () => {
    const { adb, action } = harness();
    const response = await action.execute("a; reboot", "trimMemory", { trimLevel: "COMPLETE" });
    expect(response).toMatchObject({ success: false, errorCode: "invalid_app_id" });
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("error output from am is a trim_failed result", async () => {
    const { adb, action } = harness();
    adb.setCommandResponse("send-trim-memory", result("", "Error: Unknown process"));
    const response = await action.execute(appId, "trimMemory", { trimLevel: "COMPLETE" });
    expect(response).toMatchObject({
      success: false,
      errorCode: "trim_failed",
      trimLevel: "COMPLETE",
    });
  });

  test("a thrown am command is a trim_failed result", async () => {
    const { adb, action } = harness();
    adb.setCommandError("send-trim-memory", new Error("adb: device offline"));
    const response = await action.execute(appId, "trimMemory", { trimLevel: "COMPLETE" });
    expect(response).toMatchObject({ success: false, errorCode: "trim_failed" });
    expect(response.error).toContain("device offline");
  });

  test("iOS is unsupported", async () => {
    const { action } = harness(running, "ios");
    const response = await action.execute(appId, "trimMemory", { trimLevel: "COMPLETE" });
    expect(response).toMatchObject({ success: false, supported: false, mechanism: "unsupported" });
  });
});
