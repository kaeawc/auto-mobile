import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { GetBackStack } from "../../../src/features/observe/GetBackStack";
import { parseTaskWindowing } from "../../../src/features/observe/TaskWindowing";
import type { BackStackInfo, BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Windowing fields of `dumpsys activity activities` (#14115): each task's `mode=` and bounds.
 * `android-windowing/` holds hand-reconstructed dumps of each mode (see its README);
 * `activityActivitiesDumps/` holds verbatim fullscreen captures, API 24-36.
 */

const WINDOWING_DIR = path.join(__dirname, "../../fixtures/android-windowing");
const CAPTURE_DIR = path.join(__dirname, "activityActivitiesDumps");
const APP = "dev.jasonpearson.automobile.playground";
const device: BootedDevice = { name: "test", platform: "android", deviceId: "emulator-5554" };

function read(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n");
}

async function backStackOf(stdout: string): Promise<BackStackInfo> {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("dumpsys activity activities", createExecResult(stdout, ""));
  return new GetBackStack(device, new FakeAdbClientFactory(adb), new FakeTimer()).execute();
}

async function appWindow(file: string, appId = APP) {
  const backStack = await backStackOf(read(WINDOWING_DIR, file));
  const task = backStack.tasks.find((candidate) => candidate.packageName === appId);
  return { id: task?.id, windowingMode: task?.windowingMode, bounds: task?.bounds };
}

describe("windowing fixtures report each mode and its bounds through the back stack", () => {
  test.each([
    ["dumpsys-activity-api30-freeform.txt", 14, "freeform", [120, 300, 960, 1500]],
    ["dumpsys-activity-api30-split-screen.txt", 14, "split-screen-primary", [0, 0, 1080, 1194]],
    ["dumpsys-activity-api34-split-screen.txt", 18, "multi-window", [0, 0, 1080, 1194]],
    ["dumpsys-activity-api34-pip.txt", 19, "pinned", [651, 1789, 1038, 2007]],
    ["dumpsys-activity-api34-freeform.txt", 23, "freeform", [120, 300, 960, 1500]],
    ["dumpsys-activity-api36-desktop.txt", 31, "freeform", [400, 220, 1960, 1300]],
  ] as const)("%s", async (file, id, windowingMode, [left, top, right, bottom]) => {
    expect(await appWindow(file)).toEqual({
      id,
      windowingMode,
      bounds: { left, top, right, bottom },
    });
  });

  test("split screen reports the partner on the other side", async () => {
    expect(
      await appWindow("dumpsys-activity-api30-split-screen.txt", "com.android.settings"),
    ).toEqual({
      id: 10,
      windowingMode: "split-screen-secondary",
      bounds: { left: 0, top: 1206, right: 1080, bottom: 2400 },
    });
    expect(
      await appWindow("dumpsys-activity-api34-split-screen.txt", "com.android.settings"),
    ).toEqual({
      id: 21,
      windowingMode: "multi-window",
      bounds: { left: 0, top: 1206, right: 1080, bottom: 2400 },
    });
  });

  test("a second freeform window keeps its own bounds", async () => {
    expect(await appWindow("dumpsys-activity-api36-desktop.txt", "com.android.settings")).toEqual({
      id: 32,
      windowingMode: "freeform",
      bounds: { left: 1200, top: 500, right: 2400, bottom: 1450 },
    });
  });
});

describe("parseTaskWindowing bounds sources", () => {
  test("without the Z-order section, a freeform task's own mBounds is used", () => {
    const withoutZOrder = read(WINDOWING_DIR, "dumpsys-activity-api34-freeform.txt").split(
      "ActivityTaskSupervisor state:",
    )[0];
    expect(parseTaskWindowing(withoutZOrder).get(23)).toEqual({
      windowingMode: "freeform",
      bounds: { left: 120, top: 300, right: 960, bottom: 1500 },
    });
  });

  test("without the Z-order section, a legacy split task inherits its stack's mBounds", () => {
    const withoutZOrder = read(WINDOWING_DIR, "dumpsys-activity-api30-split-screen.txt").split(
      "ActivityStackSupervisor state:",
    )[0];
    expect(parseTaskWindowing(withoutZOrder).get(10)?.bounds).toEqual({
      left: 0,
      top: 1206,
      right: 1080,
      bottom: 2400,
    });
  });

  test("an empty Rect(0, 0 - 0, 0) override falls through to the activity configuration", () => {
    const dump = [
      "Display #0 (activities from top to bottom):",
      "  * Task{fc22935 #11 type=standard A=10114:android.task.contacts U=0 visible=true mode=fullscreen translucent=false sz=1}",
      "    mBounds=Rect(0, 0 - 0, 0)",
      "    * Hist  #0: ActivityRecord{59ae8d1 u0 com.android.contacts/.activities.PeopleActivity t11}",
      "      CurrentConfiguration={1.0 winConfig={ mBounds=Rect(0, 0 - 320, 640) mAppBounds=Rect(0, 0 - 320, 640) mWindowingMode=fullscreen mActivityType=standard}}",
    ].join("\n");
    expect(parseTaskWindowing(dump).get(11)).toEqual({
      windowingMode: "fullscreen",
      bounds: { left: 0, top: 0, right: 320, bottom: 640 },
    });
  });

  test("a TaskFragment's bounds line is not taken as its task's", () => {
    const dump = [
      "ActivityTaskSupervisor state:",
      "      * Task{9de9b7 #9 type=standard A=1000:com.android.settings U=0 visible=true mode=fullscreen translucent=false sz=2}",
      "        * TaskFragment{13082f1 mode=multi-window organizerUid=1000 organizerProc=com.android.settings}",
      "          bounds=[0,0][540,640]",
    ].join("\n");
    expect(parseTaskWindowing(dump).get(9)).toEqual({ windowingMode: "fullscreen" });
  });
});

describe("verbatim captures", () => {
  const FULL = { left: 0, top: 0, right: 320, bottom: 640 };

  test.each(["api28", "api29", "api30", "api31", "api32", "api33", "api34", "api35", "api36"])(
    "%s: every app task with activities is fullscreen at display size",
    async (level) => {
      const backStack = await backStackOf(
        read(CAPTURE_DIR, `${level}-home-settings-secondapp.log`),
      );
      const appTasks = backStack.tasks.filter((task) => (task.numActivities ?? 0) > 0);
      expect(appTasks.length).toBeGreaterThan(0);
      for (const task of appTasks) {
        expect({ id: task.id, windowingMode: task.windowingMode, bounds: task.bounds }).toEqual({
          id: task.id,
          windowingMode: "fullscreen",
          bounds: FULL,
        });
      }
    },
  );

  test("api34 reports the empty split-screen stage tasks' own bounds", () => {
    const windowing = parseTaskWindowing(read(CAPTURE_DIR, "api34-home-settings-secondapp.log"));
    expect(windowing.get(4)).toEqual({
      windowingMode: "multi-window",
      bounds: { left: 0, top: 640, right: 320, bottom: 960 },
    });
  });

  test("api30 reports legacy split-screen root tasks", () => {
    const windowing = parseTaskWindowing(read(CAPTURE_DIR, "api30-home-settings-secondapp.log"));
    expect(windowing.get(4)).toEqual({
      windowingMode: "split-screen-primary",
      bounds: { left: 0, top: 0, right: 320, bottom: 327 },
    });
  });

  test("api24-27 print no windowing mode, so none is reported", async () => {
    const backStack = await backStackOf(read(CAPTURE_DIR, "api27-home-settings-secondapp.log"));
    expect(backStack.tasks.every((task) => task.windowingMode === undefined)).toBe(true);
  });
});
