import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppLifecycle, describeTrimFailure } from "../../../src/features/action/AppLifecycle";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { wrapCommandError } from "../../../src/utils/CommandError";
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

// What `am send-trim-memory COMPLETE` prints for a foreground app on API 37 (#16481): the reason
// first, then a stack long enough that a 300-character tail excerpt holds only frames.
const foregroundRefusalStderr = [
  "Exception occurred while executing 'send-trim-memory':",
  "java.lang.IllegalArgumentException: Unable to set a background trim level on a foreground process",
  ...Array.from(
    { length: 12 },
    (_, i) => `\tat com.android.server.am.ActivityManagerService.frame${i}(ActivityManagerService.java:${i})`,
  ),
  "\tat android.app.IActivityManager$Stub.onTransact(IActivityManager.java:2959)",
].join("\n");

function wrappedAdbFailure(stderr: string): Error {
  const raw = Object.assign(new Error(`Command failed: adb shell am send-trim-memory\n${stderr}`), {
    code: 255,
    stderr,
  });
  return wrapCommandError(raw, { command: "adb", args: ["shell", "am", "send-trim-memory"] });
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

  test("a background level refused for a foreground app names the cause and the fix (#16481)", async () => {
    const { adb, action } = harness();
    const thrown = wrappedAdbFailure(foregroundRefusalStderr);
    expect(thrown.message).not.toContain("foreground process");
    adb.setCommandError("send-trim-memory", thrown);
    const response = await action.execute(appId, "trimMemory", { trimLevel: "COMPLETE" });
    expect(response).toMatchObject({ success: false, errorCode: "trim_failed" });
    expect(response.error).toContain("Android refused COMPLETE");
    expect(response.error).toContain(
      "java.lang.IllegalArgumentException: Unable to set a background trim level on a foreground process",
    );
    expect(response.error).toContain("RUNNING_");
    expect(response.error).toContain("action background");
    expect(response.error).not.toContain("onTransact");
  });

  test("another thrown exception reports its sentence rather than the stack tail", async () => {
    const { adb, action } = harness();
    const stderr = foregroundRefusalStderr.replace(
      "Unable to set a background trim level on a foreground process",
      "Unknown level option: SOMETHING",
    );
    adb.setCommandError("send-trim-memory", wrappedAdbFailure(stderr));
    const response = await action.execute(appId, "trimMemory", { trimLevel: "BACKGROUND" });
    expect(response.error).toBe(
      `am send-trim-memory BACKGROUND failed for ${appId}: java.lang.IllegalArgumentException: Unknown level option: SOMETHING`,
    );
  });

  test("printed refusal output is described the same way", () => {
    expect(
      describeTrimFailure(foregroundRefusalStderr, appId, "MODERATE", "fallback"),
    ).toStartWith(`Android refused MODERATE for ${appId} because it is in the foreground`);
    expect(describeTrimFailure("no exception here", appId, "COMPLETE", "fallback")).toBe(
      "fallback",
    );
  });

  test("iOS is unsupported", async () => {
    const { action } = harness(running, "ios");
    const response = await action.execute(appId, "trimMemory", { trimLevel: "COMPLETE" });
    expect(response).toMatchObject({ success: false, supported: false, mechanism: "unsupported" });
  });
});
