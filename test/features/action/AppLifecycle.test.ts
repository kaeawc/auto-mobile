import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppLifecycle, type AppLifecycleHome } from "../../../src/features/action/AppLifecycle";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const appId = "com.google.android.contacts";
const processCommand = "shell dumpsys activity processes";
const killCommand = `shell am kill --user 0 '${appId}'`;
const device: BootedDevice = { deviceId: "fake-android", name: "Fake", platform: "android" };
const capture = (name: string) =>
  readFileSync(join(import.meta.dir, "../observe/activityActivitiesDumps", name), "utf8");
// These are captured dumpsys activity activities dumps whose ProcessRecord tokens
// the existing reader parses (including duplicates). API 36 Contacts: 3220, Settings:
// 1309, launcher: 1333; API 35 Contacts: 3259, Settings: 1124, launcher: 1245.
// single-display-phone has no ProcessRecord tokens. Captured dumpsys activity
// processes before/after am kill are still owed from a device.
const before = capture("api36-home-settings-secondapp.log");
const restarted = capture("api35-home-settings-secondapp.log");
const gone = capture("single-display-phone.log");
const result = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value) => stdout.includes(value),
});

class LifecycleAdb extends FakeAdbExecutor {
  afterKill?: () => void;
  override async executeCommand(...args: Parameters<FakeAdbExecutor["executeCommand"]>) {
    const output = await super.executeCommand(...args);
    if (args[0].startsWith("shell am kill")) {
      this.afterKill?.();
    }
    return output;
  }
}
class FakeHome implements AppLifecycleHome {
  calls = 0;
  signal?: AbortSignal;
  constructor(private readonly onHome: () => void) {}
  async execute(signal?: AbortSignal): Promise<void> {
    this.calls++;
    this.signal = signal;
    this.onHome();
  }
}
function harness(after = gone) {
  const adb = new LifecycleAdb();
  adb.setCommandResponseSequence(processCommand, [result(before), result(after)]);
  adb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const home = new FakeHome(() => adb.setForegroundApp({ packageName: "launcher", userId: 0 }));
  const invalidated: BootedDevice[] = [];
  const action = new AppLifecycle(device, {
    adb,
    timer,
    home,
    cacheInvalidator: {
      invalidate: (value) => {
        invalidated.push(value);
      },
    },
  });
  return { adb, timer, home, invalidated, action };
}

describe("AppLifecycle", () => {
  test("background uses Home only for the target foreground user and returns its pid", async () => {
    const h = harness(before);
    h.adb.setForegroundApp({ packageName: appId, userId: 0 });
    const controller = new AbortController();
    let mutations = 0;
    const response = await h.action.execute(appId, "background", {
      signal: controller.signal,
      onMutation: () => {
        mutations++;
      },
    });
    expect(response).toMatchObject({
      success: true,
      supported: true,
      mechanism: "home",
      pid: 3220,
      userId: 0,
    });
    expect(response).not.toHaveProperty("observation");
    expect(h.home.calls).toBe(1);
    expect(h.home.signal).toBe(controller.signal);
    expect(mutations).toBe(1);
    expect(h.invalidated).toEqual([device]);
  });
  test("already backgrounded does not press Home or invalidate", async () => {
    const h = harness(before);
    expect(await h.action.execute(appId, "background")).toMatchObject({ success: true, pid: 3220 });
    expect(h.home.calls).toBe(0);
    expect(h.invalidated).toEqual([]);
  });
  test("same package in another user does not press Home", async () => {
    const h = harness(before);
    h.adb.setForegroundApp({ packageName: appId, userId: 10 });
    expect((await h.action.execute(appId, "background")).success).toBe(true);
    expect(h.home.calls).toBe(0);
  });
  test("background still foreground is a typed verification failure", async () => {
    const h = harness(before);
    h.adb.setForegroundApp({ packageName: appId, userId: 0 });
    const home = new FakeHome(() => {});
    const action = new AppLifecycle(device, {
      adb: h.adb,
      timer: h.timer,
      home,
      cacheInvalidator: { invalidate: () => {} },
    });
    expect(await action.execute(appId, "background")).toMatchObject({
      success: false,
      errorCode: "background_not_verified",
    });
    expect(home.calls).toBe(1);
  });
  test("old pid gone establishes reclaim with one kill through the executor", async () => {
    const h = harness();
    const controller = new AbortController();
    expect(
      await h.action.execute(appId, "killBackgrounded", { signal: controller.signal }),
    ).toMatchObject({
      success: true,
      supported: true,
      action: "killBackgrounded",
      platform: "android",
      appId,
      mechanism: "am-kill",
      userId: 0,
      pidBefore: 3220,
      pidAfter: null,
      processReclaimed: true,
    });
    expect(h.adb.getCommandCalls().filter((call) => call.command === killCommand)).toEqual([
      expect.objectContaining({
        command: killCommand,
        timeoutMs: 5000,
        noRetry: true,
        signal: controller.signal,
      }),
    ]);
    expect(h.invalidated).toEqual([device]);
  });
  test("system restart with a new main pid still establishes reclaim", async () => {
    expect(await harness(restarted).action.execute(appId, "killBackgrounded")).toMatchObject({
      success: true,
      pidBefore: 3220,
      pidAfter: 3259,
      processReclaimed: true,
    });
  });
  test("stdout claiming success cannot establish reclaim; polling is bounded in fake time", async () => {
    const h = harness(before);
    h.adb.setCommandResponse(killCommand, result("Success: process killed"));
    const response = await h.action.execute(appId, "killBackgrounded");
    expect(response).toMatchObject({ success: true, processReclaimed: false, pidAfter: 3220 });
    expect(response.error).toBeUndefined();
    expect(response.message).toContain("not reclaimed");
    expect(h.timer.now()).toBe(5000);
    expect(h.timer.getSleepHistory()).toEqual(Array(20).fill(250));
    expect(h.adb.getExecutedCommands().filter((cmd) => cmd === processCommand)).toHaveLength(22);
  });
  test("foreground refusal never dispatches kill and directs caller to background", async () => {
    const h = harness();
    h.adb.setForegroundApp({ packageName: appId, userId: 0 });
    const response = await h.action.execute(appId, "killBackgrounded");
    expect(response).toMatchObject({
      success: false,
      errorCode: "app_in_foreground",
      pidBefore: 3220,
    });
    expect(response.error).toContain("background");
    expect(h.adb.getExecutedCommands()).not.toContain(killCommand);
    expect(h.invalidated).toEqual([]);
  });
  for (const action of ["background", "killBackgrounded"] as const) {
    test(`${action} refuses a nonrunning package`, async () => {
      const h = harness();
      h.adb.setCommandResponseSequence(processCommand, [result(gone)]);
      expect(await h.action.execute(appId, action)).toMatchObject({
        success: false,
        errorCode: "app_not_running",
      });
      expect(h.adb.getExecutedCommands()).not.toContain(killCommand);
      expect(h.home.calls).toBe(0);
    });
    test(`${action} validates Android package syntax before commands`, async () => {
      const h = harness();
      expect(await h.action.execute("bad;pkg", action)).toMatchObject({
        success: false,
        errorCode: "invalid_app_id",
      });
      expect(h.adb.getExecutedCommands()).toEqual([]);
    });
    for (const deviceId of ["AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "00008110-001A2B3C4D5E6F70"]) {
      test(`iOS ${deviceId} ${action} is unsupported without commands`, async () => {
        const h = harness();
        const ios = new AppLifecycle(
          { ...device, platform: "ios", deviceId },
          {
            adb: h.adb,
            timer: h.timer,
            home: h.home,
            cacheInvalidator: { invalidate: () => {} },
          },
        );
        expect(await ios.execute(appId, action)).toMatchObject({
          success: false,
          supported: false,
          mechanism: "unsupported",
        });
        expect(h.adb.getExecutedCommands()).toEqual([]);
        expect(h.home.calls).toBe(0);
      });
    }
  }
  test("work profile is derived from a capture, not itself captured", async () => {
    const h = harness();
    const profile = before.replaceAll(`${appId}/u0a150`, `${appId}/u10a150`);
    expect(profile).not.toBe(before);
    h.adb.setCommandResponseSequence(processCommand, [result(profile), result(gone)]);
    expect(await h.action.execute(appId, "killBackgrounded")).toMatchObject({
      userId: 10,
      processReclaimed: true,
    });
    expect(h.adb.getExecutedCommands()).toContain(`shell am kill --user 10 '${appId}'`);
  });
  test("multiple users with no foreground identity refuse ambiguous targeting", async () => {
    const h = harness();
    const profile = before.replaceAll(`${appId}/u0a150`, `${appId}/u10a150`);
    h.adb.setCommandResponseSequence(processCommand, [result(`${before}\n${profile}`)]);
    expect(await h.action.execute(appId, "killBackgrounded")).toMatchObject({
      success: false,
      errorCode: "ambiguous_user",
    });
    expect(h.adb.getExecutedCommands()).not.toContain(killCommand);
  });
  test("null foreground is treated as not foreground", async () => {
    const h = harness();
    h.adb.setForegroundApp(null);
    expect((await h.action.execute(appId, "killBackgrounded")).processReclaimed).toBe(true);
  });
  test("thrown kill command logs and returns kill_failed, still invalidating", async () => {
    const h = harness();
    h.adb.setCommandError(killCommand, new Error("permission denied"));
    const response = await h.action.execute(appId, "killBackgrounded");
    expect(response).toMatchObject({
      success: false,
      errorCode: "kill_failed",
      error: "permission denied",
      pidBefore: 3220,
    });
    expect(response.processReclaimed).toBeUndefined();
    expect(h.invalidated).toEqual([device]);
  });
  test("poll failures never establish reclaim from a missing read", async () => {
    const h = harness();
    h.adb.afterKill = () => h.adb.setCommandError(processCommand, new Error("read failed"));
    const response = await h.action.execute(appId, "killBackgrounded");
    expect(response).toMatchObject({ success: true, processReclaimed: false, pidAfter: 3220 });
    expect(response.message).toContain("could not be verified");
    expect(h.timer.now()).toBe(5000);
  });
  test("a transient failed poll can recover with later pid evidence", async () => {
    const h = harness();
    // A narrow subclass models one read failure without new process-table data.
    let reads = 0;
    class OnceFailingAdb extends FakeAdbExecutor {
      override async executeCommand(...args: Parameters<FakeAdbExecutor["executeCommand"]>) {
        if (args[0] === processCommand && ++reads === 2) {
          throw new Error("read failed");
        }
        return super.executeCommand(...args);
      }
    }
    const adb = new OnceFailingAdb();
    adb.setCommandResponseSequence(processCommand, [result(before), result(gone)]);
    const action = new AppLifecycle(device, {
      adb,
      timer: h.timer,
      home: h.home,
      cacheInvalidator: { invalidate: () => {} },
    });
    expect((await action.execute(appId, "killBackgrounded")).processReclaimed).toBe(true);
    expect(h.timer.getSleepHistory()).toEqual([250]);
  });
  test("already aborted signal throws before any command", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.action.execute(appId, "killBackgrounded", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });
  test("abort during polling rejects immediately while fake sleep is pending", async () => {
    const h = harness(before);
    const timer = new FakeTimer();
    const action = new AppLifecycle(device, {
      adb: h.adb,
      timer,
      home: h.home,
      cacheInvalidator: { invalidate: () => {} },
    });
    const controller = new AbortController();
    const pending = action.execute(appId, "killBackgrounded", { signal: controller.signal });
    for (let turn = 0; turn < 100 && timer.getPendingSleepCount() === 0; turn++) {
      await Promise.resolve();
    }
    expect(timer.getPendingSleepCount()).toBe(1);
    controller.abort();
    await expect(pending).rejects.toThrow();
    timer.resolveAll();
    expect(h.invalidated).toEqual([]);
  });
});
