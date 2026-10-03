import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppLifecycle } from "../../../src/features/action/AppLifecycle";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { ForegroundAppReadResult } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const appId = "com.google.android.contacts";
const device: BootedDevice = { deviceId: "fake-android", name: "Fake", platform: "android" };
const processCommand = "shell dumpsys activity processes";
const killCommand = `shell am kill --user 0 '${appId}'`;
const capture = (name: string) =>
  readFileSync(join(import.meta.dir, "../observe/activityActivitiesDumps", name), "utf8");
const before = capture("api36-home-settings-secondapp.log");
const gone = capture("single-display-phone.log");
const result = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value) => stdout.includes(value),
});
const foreground: ForegroundAppReadResult = {
  state: "known",
  app: { packageName: appId, userId: 0 },
};
const background: ForegroundAppReadResult = { state: "known", app: null };
const unreadable: ForegroundAppReadResult = { state: "unreadable", error: "device offline" };

class ParsingFakeAdbExecutor extends FakeAdbExecutor {
  // Use the production checked reader over the fake's recorded command responses.
  override getForegroundAppChecked = AdbClient.prototype.getForegroundAppChecked;
}

function harness(reads: ForegroundAppReadResult[], adb = new FakeAdbExecutor()) {
  adb.setCommandResponseSequence(processCommand, [result(before), result(gone)]);
  adb.setForegroundAppCheckedSequence(reads);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let homeCalls = 0;
  let invalidations = 0;
  let mutations = 0;
  const action = new AppLifecycle(device, {
    adb,
    timer,
    home: {
      execute: async () => {
        homeCalls++;
      },
    },
    cacheInvalidator: {
      invalidate: () => {
        invalidations++;
      },
    },
  });
  return {
    adb,
    action,
    options: {
      onMutation: () => {
        mutations++;
      },
    },
    counts: () => ({ homeCalls, invalidations, mutations }),
  };
}

describe("AppLifecycle checked foreground reads", () => {
  for (const output of ["", "unparsable output"]) {
    test(`real reader refuses am kill for ${output ? "unparseable" : "empty"} dumpsys output`, async () => {
      const adb = new ParsingFakeAdbExecutor();
      adb.setCommandResponse("shell dumpsys activity activities", result(output));
      const h = harness([], adb);
      expect(await h.action.execute(appId, "killBackgrounded", h.options)).toMatchObject({
        success: false,
        errorCode: "background_not_verified",
      });
      expect(adb.getExecutedCommands().some((command) => command.includes("am kill"))).toBe(false);
      expect(h.counts()).toEqual({ homeCalls: 0, invalidations: 0, mutations: 0 });
    });

    test(`real reader reports indeterminate background for ${output ? "unparseable" : "empty"} dumpsys output`, async () => {
      const adb = new ParsingFakeAdbExecutor();
      adb.setCommandResponse("shell dumpsys activity activities", result(output));
      const h = harness([], adb);
      const response = await h.action.execute(appId, "background", h.options);
      expect(response).toMatchObject({ success: false, errorCode: "background_not_verified" });
      expect(response.error).toContain("indeterminate");
      expect(h.counts()).toEqual({ homeCalls: 1, invalidations: 1, mutations: 1 });
    });
  }

  test("unreadable post-Home state reports an indeterminate outcome", async () => {
    const h = harness([foreground, unreadable]);
    const response = await h.action.execute(appId, "background", h.options);
    expect(response).toMatchObject({ success: false, errorCode: "background_not_verified" });
    expect(response.error).toContain("Background outcome is indeterminate");
    expect(response.error).toContain("Home was pressed");
    expect(response.error).toContain("device offline");
    expect(response.error).toContain("Do not retry automatically.");
    expect(h.counts()).toEqual({ homeCalls: 1, invalidations: 1, mutations: 1 });
  });

  test("still foreground after Home retains the existing failure", async () => {
    const h = harness([foreground, foreground]);
    expect(await h.action.execute(appId, "background")).toMatchObject({
      success: false,
      errorCode: "background_not_verified",
      error: `${appId} is still foreground; background could not be verified`,
    });
  });

  test("verified not-foreground after Home succeeds", async () => {
    const h = harness([foreground, background]);
    expect(await h.action.execute(appId, "background")).toMatchObject({ success: true, pid: 3220 });
  });

  for (const after of [foreground, background, unreadable]) {
    test(`unreadable pre-Home state presses Home then uses ${after.state === "known" ? (after.app ? "foreground" : "not-foreground") : "unreadable"} post-read`, async () => {
      const h = harness([unreadable, after]);
      const response = await h.action.execute(appId, "background", h.options);
      expect(response.success).toBe(after.state === "known" && after.app === null);
      if (!response.success) {
        expect(response.errorCode).toBe("background_not_verified");
      }
      expect(h.counts()).toEqual({ homeCalls: 1, invalidations: 1, mutations: 1 });
    });
  }

  test("unreadable verification without Home does not claim Home was pressed", async () => {
    const h = harness([background, unreadable]);
    const response = await h.action.execute(appId, "background", h.options);
    expect(response).toMatchObject({ success: false, errorCode: "background_not_verified" });
    expect(response.error).toContain("indeterminate");
    expect(response.error).not.toContain("Home was pressed");
    expect(h.counts()).toEqual({ homeCalls: 0, invalidations: 0, mutations: 0 });
  });

  test("kill after background refuses an unreadable state without issuing am kill", async () => {
    const h = harness([foreground, background, unreadable]);
    // Keep the process running for the subsequent kill request.
    h.adb.setCommandResponseSequence(processCommand, [result(before)]);
    expect((await h.action.execute(appId, "background")).success).toBe(true);
    expect(await h.action.execute(appId, "killBackgrounded", h.options)).toMatchObject({
      success: false,
      errorCode: "background_not_verified",
    });
    expect(h.adb.getExecutedCommands()).not.toContain(killCommand);
    expect(h.counts().mutations).toBe(0);
  });

  test("known not-foreground permits kill and verifies reclamation", async () => {
    const h = harness([background]);
    expect(await h.action.execute(appId, "killBackgrounded")).toMatchObject({
      success: true,
      processReclaimed: true,
    });
    expect(h.adb.getExecutedCommands()).toContain(killCommand);
  });

  for (const action of ["background", "killBackgrounded"] as const) {
    test(`abort during ${action} foreground read propagates`, async () => {
      const controller = new AbortController();
      const reason = new Error("request cancelled");
      class AbortingAdb extends FakeAdbExecutor {
        override async getForegroundAppChecked(): Promise<ForegroundAppReadResult> {
          controller.abort(reason);
          return unreadable;
        }
      }
      const h = harness([], new AbortingAdb());
      await expect(
        h.action.execute(appId, action, {
          ...h.options,
          signal: controller.signal,
        }),
      ).rejects.toThrow(reason);
      expect(h.counts()).toEqual({ homeCalls: 0, invalidations: 0, mutations: 0 });
      expect(h.adb.getExecutedCommands()).not.toContain(killCommand);
    });
  }
});
