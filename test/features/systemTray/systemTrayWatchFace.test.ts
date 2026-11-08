import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { ActionableError } from "../../../src/models";
import { SystemTray } from "../../../src/features/systemTray/SystemTray";
import {
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
} from "../../../src/features/systemTray/systemTrayHelpers";
import { isWatchAppList } from "../../../src/features/systemTray/helpers/watchHierarchy";
import { watchAwaySurface } from "../../../src/features/systemTray/helpers/watchFace";
import { observeResultFromFixture } from "../../helpers/observeFixture";
import topCapture from "../../fixtures/wear/systemtray/ctrlproxy-stream-top.json";
import launcherCapture from "../../fixtures/wear/systemtray/ctrlproxy-alert-shy-over-launcher.json";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

const capture = (raw: unknown, label: string): ObserveResult =>
  observeResultFromFixture(
    { updatedAt: 0, systemInsets: { top: 0, right: 0, bottom: 0, left: 0 }, ...(raw as object) },
    label,
  );
// Captured with CtrlProxy on a Wear OS 7 round emulator (API 37, 454x454): the open stream.
const stream = capture(topCapture, "stream-top");
// Captured with CtrlProxy on a Wear OS 7 round emulator (API 37, 384x384): the app list
// (AllAppsLauncherActivity, `appsList`) with a collapsed heads-up strip over its bottom edge.
const appList = capture(launcherCapture, "alert-shy-over-launcher");
// A fake watch face, not a captured hierarchy.
const face: ObserveResult = {
  ...stream,
  viewHierarchy: { hierarchy: { node: { $: { bounds: "[0,0][454,454]" } } } },
};
// A fake third-party app in front, not a captured hierarchy.
const APP = "com.example.weather";
const app: ObserveResult = {
  ...face,
  viewHierarchy: { packageName: APP, hierarchy: { node: { $: { bounds: "[0,0][454,454]" } } } },
  activeWindow: { appId: APP, activityName: `${APP}.MainActivity`, layoutSeqSum: 0 },
};

const BACK = "shell input keyevent 4";
const HOME = "shell input keyevent KEYCODE_HOME";
const isSwipe = (command: string) => command.startsWith("shell input swipe");
const watch: BootedDevice = {
  deviceId: "fake-watch",
  name: "watch",
  platform: "android",
  formFactor: "watch",
};

afterEach(resetSystemTrayDependencies);

/** `screen` maps the commands sent so far to what the watch shows. */
function setup(screen: (commands: string[]) => ObserveResult) {
  const adb = new FakeAdbExecutor();
  const observer = new FakeObserveScreen();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  observer.setObserveResult(() => screen(adb.getExecutedCommands()));
  setSystemTrayDependencies({
    adbFactory: () => adb,
    observeScreenFactory: () => observer,
    timer,
    appLabelResolver: async (_device, appId) => appId,
    appInventoryFactory: () => ({
      executeDetailedResult: async () => ({
        successful: true,
        apps: {
          profiles: {},
          system: [
            { packageName: "com.android.shell", userIds: [0], foreground: false, recent: false },
          ],
        },
      }),
    }),
  });
  return { adb, tray: new SystemTray(watch) };
}

/** Starts on `start`; `leaveWith` returns it to the face, where the open swipe shows the stream. */
const screens =
  (start: ObserveResult, leaveWith: string[]) =>
  (commands: string[]): ObserveResult => {
    if (commands.some(isSwipe)) {
      return commands.lastIndexOf(BACK) > commands.findIndex(isSwipe) ? face : stream;
    }
    return leaveWith.some((key) => commands.includes(key)) ? face : start;
  };

describe("watch surfaces the open swipe does nothing on", () => {
  test("recognises the captured app list, and not the stream or the watch face", () => {
    expect(isWatchAppList(appList.viewHierarchy)).toBe(true);
    expect(isWatchAppList(stream.viewHierarchy)).toBe(false);
    expect(watchAwaySurface(appList)).toBe("app list");
    expect(watchAwaySurface(stream)).toBeUndefined();
    expect(watchAwaySurface(face)).toBeUndefined();
  });

  test("recognises the app list from the focused launcher activity alone", () => {
    const focused: ObserveResult = {
      ...face,
      activeWindow: {
        appId: "com.google.android.clockwork.sysui",
        activityName:
          "com.google.android.clockwork.sysui.experiences.launcher.AllAppsLauncherActivity",
        layoutSeqSum: 0,
      },
    };
    expect(watchAwaySurface(focused)).toBe("app list");
  });

  test("treats an app as away only when its hierarchy and focus agree", () => {
    expect(watchAwaySurface(app)).toBe("app");
    expect(watchAwaySurface({ ...app, viewHierarchy: face.viewHierarchy })).toBeUndefined();
  });
});

describe("open returns to the watch face first", () => {
  test("closes the app list with Back before the open swipe", async () => {
    const { tray, adb } = setup(screens(appList, [BACK]));
    const result = await tray.execute({ action: "open", awaitTimeout: 500 });
    expect(result.payload).toMatchObject({ success: true, opened: true });
    const commands = adb.getExecutedCommands();
    expect(commands.filter((command) => command === BACK)).toHaveLength(1);
    expect(commands).not.toContain(HOME);
    expect(commands.indexOf(BACK)).toBeLessThan(commands.findIndex(isSwipe));
  });

  test("falls back to Home when Back leaves the app list up", async () => {
    const { tray, adb } = setup(screens(appList, [HOME]));
    const result = await tray.execute({ action: "open", awaitTimeout: 500 });
    expect(result.payload).toMatchObject({ success: true, opened: true });
    const commands = adb.getExecutedCommands();
    expect(commands.slice(0, 2)).toEqual([BACK, HOME]);
    expect(commands.filter(isSwipe)).toHaveLength(1);
  });

  test("leaves an app with Home", async () => {
    const { tray, adb } = setup(screens(app, [HOME]));
    const result = await tray.execute({ action: "open", awaitTimeout: 500 });
    expect(result.payload).toMatchObject({ success: true, opened: true });
    const commands = adb.getExecutedCommands();
    expect(commands[0]).toBe(HOME);
    expect(commands).not.toContain(BACK);
  });

  test("reports a watch stuck away from the face without sending the open swipe", async () => {
    const { tray, adb } = setup(() => appList);
    const error = await tray.execute({ action: "open", awaitTimeout: 500 }).catch((e) => e);
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("Could not return to the watch face from the app list");
    const commands = adb.getExecutedCommands();
    expect(commands.some(isSwipe)).toBe(false);
    expect(commands).toEqual([BACK, HOME, HOME]);
  });

  test("presses nothing on the watch face", async () => {
    const { tray, adb } = setup(screens(face, []));
    const result = await tray.execute({ action: "open", awaitTimeout: 500 });
    expect(result.payload).toMatchObject({ success: true, opened: true });
    const commands = adb.getExecutedCommands();
    expect(commands).not.toContain(BACK);
    expect(commands).not.toContain(HOME);
  });

  test("list from the app list reaches the stream and leaves the watch face behind", async () => {
    const { tray, adb } = setup(screens(appList, [BACK]));
    const result = await tray.execute({
      action: "list",
      notification: { appId: "com.android.shell" },
      awaitTimeout: 500,
    });
    expect(result.isError).toBe(false);
    const commands = adb.getExecutedCommands();
    expect(commands[0]).toBe(BACK);
    expect(commands.some(isSwipe)).toBe(true);
    expect(commands).not.toContain(HOME);
  });
});
