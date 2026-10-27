import { describe, expect, test } from "bun:test";
import { AndroidLaunchActivity } from "../../../src/features/action/AndroidLaunchActivity";
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
  test("starts the component with extras in one am start, without fallbacks", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "am start",
      createExecResult(
        "Starting: Intent { cmp=com.example.app/.DebugActivity (has extras) }\n",
        "",
      ),
    );

    const result = await launcher(adb).performLaunch(APP, undefined, 10, perf(), undefined, {
      component: ".DebugActivity",
      extras: [{ key: "screen", type: "string", value: "settings" }],
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
      .performLaunch(APP, undefined, 0, perf(), undefined, { component: ".Secret" })
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
      launcher(adb).performLaunch(APP, undefined, 0, perf(), undefined, {
        component: "com.android.settings/.Settings",
      }),
    ).rejects.toBeInstanceOf(AndroidLaunchIntentError);
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});
