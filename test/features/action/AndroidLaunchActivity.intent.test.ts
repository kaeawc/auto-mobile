import { describe, expect, test, spyOn } from "bun:test";
import { AndroidLaunchActivity } from "../../../src/features/action/AndroidLaunchActivity";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { AndroidLaunchIntentError } from "../../../src/features/action/androidLaunchIntent";
import { createExecResult } from "../../../src/utils/execResult";
import { DefaultPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const APP = "com.example.app";

function launcher(adb: FakeAdbExecutor) {
  return new AndroidLaunchActivity({
    device: { deviceId: "emulator-5554", platform: "android", name: "Pixel" },
    adb,
    failFastWhenPackageRemoved: async () => {},
  });
}

const perf = () => new DefaultPerformanceTracker(new FakeTimer());

describe("Android explicit intent launch (#14080)", () => {
  test("secondary-user fallbacks keep the same user and skip untargetable monkey", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell am start --user 10 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER",
      createExecResult("Error: no launcher", ""),
    );
    adb.setCommandResponse("query-activities", createExecResult(`${APP}/.MainActivity`, ""));
    adb.setCommandResponse("shell am start --user 10 -n", createExecResult("Starting: Intent", ""));
    const ctrlProxy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      throw new Error("CtrlProxy unavailable in this fake-only fallback test");
    });
    try {
      const result = await launcher(adb).performLaunch(APP, undefined, 10, perf());
      expect(result).toMatchObject({ success: true, userId: 10 });
      const commands = adb.getExecutedCommands();
      expect(commands.some((command) => command.startsWith("shell monkey"))).toBe(false);
      expect(commands.filter((command) => command.startsWith("shell am start"))).toEqual([
        `shell am start --user 10 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER '${APP}'`,
        `shell am start --user 10 -n '${APP}/.MainActivity'`,
      ]);
    } finally {
      ctrlProxy.mockRestore();
    }
  });

  test("starts the component with extras in one am start, without fallbacks", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "am start",
      createExecResult(
        "Starting: Intent { cmp=com.example.app/.DebugActivity (has extras) }\n",
        "",
      ),
    );

    const result = await launcher(adb).performLaunch(APP, undefined, 10, perf(), {
      intent: {
        component: ".DebugActivity",
        extras: [{ key: "screen", type: "string", value: "settings" }],
      },
    });

    expect(result).toEqual({
      success: true,
      packageName: APP,
      activityName: `${APP}/.DebugActivity`,
      userId: 10,
    });
    expect(adb.getExecutedCommands()).toEqual([
      `shell am start --user 10 --es 'screen' 'settings' -n '${APP}/.DebugActivity'`,
    ]);
  });

  test("a non-exported activity is a typed activity_not_exported failure", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "am start",
      createExecResult(
        "Starting: Intent { cmp=com.example.app/.Secret }\n",
        "java.lang.SecurityException: Permission Denial: starting Intent { cmp=com.example.app/.Secret } from null (pid=1, uid=2000) not exported from uid 10123\n",
      ),
    );

    const thrown = await launcher(adb)
      .performLaunch(APP, undefined, 0, perf(), { intent: { component: ".Secret" } })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(AndroidLaunchIntentError);
    expect((thrown as AndroidLaunchIntentError).code).toBe("activity_not_exported");
    // No monkey or launcher fallback opens a different screen after a refusal.
    expect(adb.getExecutedCommands()).toHaveLength(1);
  });

  test("a component in another package is refused before any adb command", async () => {
    const adb = new FakeAdbExecutor();
    await expect(
      launcher(adb).performLaunch(APP, undefined, 0, perf(), {
        intent: { component: "com.android.settings/.Settings" },
      }),
    ).rejects.toBeInstanceOf(AndroidLaunchIntentError);
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});

describe("Android launcher discovery categories", () => {
  test("a LAUNCHER component keeps the existing launch path without a Leanback probe", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("resolve-activity", createExecResult(`${APP}/.PhoneHome`, ""));
    adb.setCommandResponse("am start", createExecResult("Starting: Intent", ""));
    expect(await launcher(adb).performLaunch(APP, undefined, 0, perf())).toEqual({
      success: true,
      packageName: APP,
      activityName: "intent_launch",
      userId: 0,
    });
    expect(adb.getExecutedCommands()).toEqual([
      `shell cmd package resolve-activity --brief --user 0 -c android.intent.category.LAUNCHER '${APP}'`,
      `shell am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n '${APP}/.PhoneHome'`,
    ]);
  });

  test("discovers a Leanback component when resolve-activity is unavailable", async () => {
    const app = "com.android.tv.settings";
    const adb = new FakeAdbExecutor();
    adb.setDefaultResponse(createExecResult("Error: Activity does not exist", ""));
    adb.setCommandError("resolve-activity", new Error("Unknown command: resolve-activity"));
    adb.setCommandResponse(
      "-a android.intent.action.MAIN -c android.intent.category.LAUNCHER",
      createExecResult("Error: no launcher", ""),
    );
    adb.setCommandResponse(
      "query-activities --brief --user 10 -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER",
      createExecResult(`${app}/.MainSettings`, ""),
    );
    adb.setCommandResponse(
      `shell am start --user 10 -n '${app}/.MainSettings'`,
      createExecResult("Starting: Intent", ""),
    );
    const ctrlProxy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      throw new Error("CtrlProxy unavailable in fake discovery test");
    });
    try {
      const result = await launcher(adb).performLaunch(app, undefined, 10, perf());
      expect(result).toEqual({
        success: true,
        packageName: app,
        activityName: ".MainSettings",
        userId: 10,
      });
      expect(adb.getExecutedCommands()).toContain(
        `shell am start --user 10 -n '${app}/.MainSettings'`,
      );
      expect(adb.getExecutedCommands().some((command) => command.includes("pm dump"))).toBe(false);
    } finally {
      ctrlProxy.mockRestore();
    }
  });
});
