import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GetBackStack } from "../../../src/features/observe/GetBackStack";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { parseResumedActivityForDisplay } from "../../../src/utils/android-cmdline-tools/parseResumedActivity";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import type { BootedDevice, ExecResult } from "../../../src/models";

const device: BootedDevice = { deviceId: "foldable", name: "Foldable", platform: "android" };
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "activityActivitiesDumps", name), "utf8");
const filteredForegroundOutput = (output: string): string =>
  output
    .split(/\r?\n/)
    .filter((line) =>
      /^[^\s]|^\s*(topResumedActivity|mResumedActivity|ResumedActivity|Resumed|mFocusedActivity)\s*[:=]/.test(
        line,
      ),
    )
    .join("\n");

describe("display-scoped resumed activity", () => {
  test("selects display 0 even when display 2 is listed first and owns focus", async () => {
    const output = fixture("multi-display-foldable.log");
    expect(parseResumedActivityForDisplay(output, 0).activity?.activityName).toBe(
      "com.google.android.gms.auth.uiflows.minutemaid.MinuteMaidActivity",
    );
    expect(parseResumedActivityForDisplay(output, 2).activity?.activityName).toBe(
      "com.android.settings.Settings",
    );
    expect(parseResumedActivityForDisplay(filteredForegroundOutput(output), 0)).toEqual(
      parseResumedActivityForDisplay(output, 0),
    );
    expect(parseResumedActivityForDisplay(filteredForegroundOutput(output), 2)).toEqual(
      parseResumedActivityForDisplay(output, 2),
    );

    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("dumpsys activity activities", { stdout: output, stderr: "" });
    const backStack = await new GetBackStack(device, new FakeAdbClientFactory(adb)).execute();
    expect(backStack.displayCount).toBe(2);
    expect(backStack.currentActivity).toEqual({
      name: "com.google.android.gms.auth.uiflows.minutemaid.MinuteMaidActivity",
      taskId: 10,
    });
  });

  test("keeps the single-display phone activity", async () => {
    const output = fixture("single-display-phone.log");
    const selected = parseResumedActivityForDisplay(output);
    expect(selected.displayCount).toBe(1);
    expect(selected.activity).toMatchObject({
      packageName: "com.android.contacts",
      activityName: "com.android.contacts.activities.PeopleActivity",
      taskId: 8,
    });
    expect(parseResumedActivityForDisplay(filteredForegroundOutput(output))).toEqual(selected);

    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("dumpsys activity activities", { stdout: output, stderr: "" });
    const backStack = await new GetBackStack(device, new FakeAdbClientFactory(adb)).execute();
    expect(backStack.currentActivity?.name).toBe("com.android.contacts.activities.PeopleActivity");
  });

  test("does not borrow another display's activity when the observed display has none", () => {
    const output =
      fixture("multi-display-foldable.log").replace(
        /Display #0 \(activities from top to bottom\):[\s\S]*?ActivityTaskSupervisor state:/,
        "Display #0 (activities from top to bottom):\n\nActivityTaskSupervisor state:",
      ) + "\n  ResumedActivity: ActivityRecord{ext u0 com.android.settings/.Settings t22}\n";
    expect(parseResumedActivityForDisplay(output).activity).toBeUndefined();
    expect(
      parseResumedActivityForDisplay(filteredForegroundOutput(output)).activity,
    ).toBeUndefined();
  });

  test("legacy foreground output cannot identify a non-default display", () => {
    const output = filteredForegroundOutput(fixture("single-display-phone.log")).replace(
      /^Display #.*\n/gm,
      "",
    );
    expect(parseResumedActivityForDisplay(output).activity?.packageName).toBe(
      "com.android.contacts",
    );
    expect(parseResumedActivityForDisplay(output, 2).activity).toBeUndefined();
  });

  test("foreground identity uses the same display-scoped activity", async () => {
    const output = filteredForegroundOutput(fixture("multi-display-foldable.log"));
    const client = new (class extends AdbClient {
      override async executeCommand(command: string): Promise<ExecResult> {
        expect(command).toBe(
          "shell dumpsys activity activities | grep -E '^[^[:space:]]|^[[:space:]]*(topResumedActivity|mResumedActivity|ResumedActivity|Resumed|mFocusedActivity)[[:space:]]*[:=]'",
        );
        return {
          stdout: output,
          stderr: "",
          toString: () => output,
          trim: () => output.trim(),
          includes: (value: string) => output.includes(value),
        };
      }
    })(device);

    expect(await client.getForegroundApp()).toEqual({
      packageName: "com.google.android.gms",
      userId: 0,
      activityName: "com.google.android.gms.auth.uiflows.minutemaid.MinuteMaidActivity",
      displayCount: 2,
    });
    expect(await client.getForegroundApp(undefined, { displayId: 2 })).toEqual({
      packageName: "com.android.settings",
      userId: 0,
      activityName: "com.android.settings.Settings",
      displayCount: 2,
    });
    expect(await client.getForegroundApp(undefined, { displayId: 3 })).toBeNull();
  });

  test("observe pairs the default-display hierarchy with its resumed activity", async () => {
    const output = fixture("multi-display-foldable.log");
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("dumpsys activity activities", { stdout: output, stderr: "" });
    adb.setForegroundApp({ packageName: "com.google.android.gms", userId: 0 });
    const factory = new FakeAdbClientFactory(adb);
    const timer = new FakeTimer();
    timer.setCurrentTime(1_700_000_000_000);
    const hierarchy = new FakeViewHierarchy();
    hierarchy.configureHierarchy({
      updatedAt: timer.now(),
      receivedAt: timer.now(),
      fresh: true,
      screenWidth: 2256,
      screenHeight: 2504,
      packageName: "com.google.android.gms",
      foregroundActivity: "com.android.settings/.Settings",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 2256, bottom: 2504 },
          node: [{ text: "Sign in", bounds: { left: 0, top: 0, right: 100, bottom: 50 } }],
        },
      },
    });
    const screen = new RealObserveScreen(
      device,
      factory,
      {
        viewHierarchy: hierarchy,
        backStack: new GetBackStack(device, factory, timer),
        cacheStore: new FakeObserveCacheStore(timer),
      },
      timer,
    );

    const result = await screen.execute({
      skipScreenshot: true,
      skipAccessibilityAudit: true,
      skipPerformanceAudit: true,
    });
    expect(result.activeWindow).toMatchObject({
      appId: "com.google.android.gms",
      activityName: "com.google.android.gms.auth.uiflows.minutemaid.MinuteMaidActivity",
    });
    expect(result.screenSize).toMatchObject({ width: 2256, height: 2504 });
    expect(result.viewHierarchy?.hierarchy.node?.node?.[0]?.text).toBe("Sign in");
  });

  test("observe also corrects activeWindow when back-stack collection is skipped", async () => {
    const output = fixture("multi-display-foldable.log");
    const parsed = parseResumedActivityForDisplay(output);
    const adb = new (class extends FakeAdbExecutor {
      override async getForegroundApp() {
        return parsed.activity
          ? {
              packageName: parsed.activity.packageName,
              userId: parsed.activity.userId,
              activityName: parsed.activity.activityName,
              displayCount: parsed.displayCount,
            }
          : null;
      }
    })();
    const timer = new FakeTimer();
    timer.setCurrentTime(1_700_000_000_000);
    const hierarchy = new FakeViewHierarchy();
    hierarchy.configureHierarchy({
      updatedAt: timer.now(),
      receivedAt: timer.now(),
      fresh: true,
      screenWidth: 2256,
      screenHeight: 2504,
      packageName: "com.google.android.gms",
      foregroundActivity: "com.android.settings/.Settings",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 2256, bottom: 2504 },
          node: [{ text: "Sign in", bounds: { left: 0, top: 0, right: 100, bottom: 50 } }],
        },
      },
    });
    const screen = new RealObserveScreen(
      device,
      new FakeAdbClientFactory(adb),
      { viewHierarchy: hierarchy, cacheStore: new FakeObserveCacheStore(timer) },
      timer,
    );

    const result = await screen.execute({
      skipScreenshot: true,
      skipBackStack: true,
      skipAccessibilityAudit: true,
      skipPerformanceAudit: true,
    });
    expect(result.activeWindow).toMatchObject({
      appId: "com.google.android.gms",
      activityName: "com.google.android.gms.auth.uiflows.minutemaid.MinuteMaidActivity",
    });
  });
});
