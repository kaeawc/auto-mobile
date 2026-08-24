import { describe, expect, test } from "bun:test";
import { GetBackStack } from "../../../src/features/observe/GetBackStack";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { BackStackInfo, BootedDevice } from "../../../src/models";

/**
 * Back-stack semantics pinned by this suite (issue #4197).
 *
 * Wire format. `dumpsys activity activities` prints activities using AOSP's
 * `ActivityRecord.toString()`, which puts the user id and the component INSIDE
 * the braces:
 *
 *     * Hist  #0: ActivityRecord{2b2ce0f u0 com.example/.MainActivity t61}
 *
 * The shape the parser used to expect (`ActivityRecord{...} u0
 * com.example/.MainActivity`, component after the closing brace) is not emitted
 * by any Android version, which is why `parseActivities` returned an empty
 * array against real output.
 *
 * Where the TASK ID goes, however, is version-dependent. The captures committed
 * under `test/features/observe/windowDumps/` disagree:
 *
 *     API 30-32, 34-36  ActivityRecord{6f2ed08 u0 com.android.settings/.Settings t6}
 *     API 33            ActivityRecord{a9cf40f u0 com.android.settings/.Settings} t8}
 *
 * API 33 closes the component with its own brace and trails the task id after
 * it. Both shapes are pinned below; the component must never come back with a
 * "}" glued to it.
 *
 * Ordering and the task root. Activities are printed top-of-stack first, and
 * the `Hist #N` index is the position within the task counting UP from the
 * root: `Hist #0` is the task root, the highest `Hist #N` is the currently
 * visible activity. The root is therefore the LAST entry in printed order, not
 * the first. `isTaskRoot` is derived from the `Hist` index rather than from an
 * array position so it stays correct regardless of how the list is ordered.
 *
 * Depth. `depth` counts how many entries can be popped from the current task,
 * i.e. (activities in the current task) - 1. A single-activity task has depth 0.
 *
 * Task id. Each activity line carries its own `tNN`, so the activity's task id
 * is read from the activity itself and only falls back to the enclosing task
 * header when the line omits it. That keeps activity parsing correct even when
 * the task-header line is printed in a format the task parser does not know.
 */

const device: BootedDevice = { name: "test", platform: "android", deviceId: "test-device" };

async function parse(stdout: string): Promise<BackStackInfo> {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("dumpsys activity activities", { stdout, stderr: "" });
  return new GetBackStack(device, new FakeAdbClientFactory(adb)).execute();
}

// Legacy-style block: "Task id #N" headers, single-space "Hist #N:".
const LEGACY_MULTI_TASK = `
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from top to bottom):

  Stack #0: type=home mode=fullscreen
    Task id #1
    affinity=com.android.launcher3
    realActivity=com.android.launcher3/.Launcher
    numActivities=1
      * Hist #0: ActivityRecord{abc123 u0 com.android.launcher3/.Launcher t1}

  Stack #1: type=standard mode=fullscreen
    Task id #123
    affinity=dev.jasonpearson.automobile.playground
    realActivity=dev.jasonpearson.automobile.playground/.MainActivity
    numActivities=3
      * Hist #2: ActivityRecord{def456 u0 dev.jasonpearson.automobile.playground/.DetailActivity t123}
      * Hist #1: ActivityRecord{ghi789 u0 dev.jasonpearson.automobile.playground/.ListActivity t123}
      * Hist #0: ActivityRecord{jkl012 u0 dev.jasonpearson.automobile.playground/.MainActivity t123}

  mResumedActivity: ActivityRecord{def456 u0 dev.jasonpearson.automobile.playground/.DetailActivity t123}
`;

// Modern-style block: two spaces after "Hist", task header printed as
// "Task{<hash> #id ...}". Only activity-derived facts are asserted for this
// fixture; the task-header form is tracked separately.
const MODERN_SINGLE_TASK = `
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from top to bottom):
  * Task{d19dee2 #61 type=standard A=10164:com.example U=0 visible=true mode=fullscreen sz=2}
    mBounds=Rect(0, 0 - 1080, 2400)
    isSleeping=false
    * Hist  #1: ActivityRecord{2b2ce0f u0 com.example/.DetailActivity t61}
        packageName=com.example processName=com.example
    * Hist  #0: ActivityRecord{7ff01aa u0 com.example/com.example.MainActivity t61}
        packageName=com.example processName=com.example

  topResumedActivity=ActivityRecord{2b2ce0f u0 com.example/.DetailActivity t61}
`;

describe("GetBackStack real-output parsing (#4197)", () => {
  test("parses every activity out of a real-format multi-task dump", async () => {
    const result = await parse(LEGACY_MULTI_TASK);

    expect(result.activities.map((a) => a.name)).toEqual([
      "com.android.launcher3.Launcher",
      "dev.jasonpearson.automobile.playground.DetailActivity",
      "dev.jasonpearson.automobile.playground.ListActivity",
      "dev.jasonpearson.automobile.playground.MainActivity",
    ]);
  });

  test("reads each activity's task id from its own tNN suffix", async () => {
    const result = await parse(LEGACY_MULTI_TASK);

    expect(result.activities.map((a) => a.taskId)).toEqual([1, 123, 123, 123]);
  });

  test("marks Hist #0 as the task root, not the topmost activity", async () => {
    const result = await parse(LEGACY_MULTI_TASK);

    const roots = result.activities.filter((a) => a.isTaskRoot).map((a) => a.name);
    expect(roots).toEqual([
      "com.android.launcher3.Launcher",
      "dev.jasonpearson.automobile.playground.MainActivity",
    ]);
    // The topmost (resumed) activity is explicitly NOT the root.
    expect(result.activities.find((a) => a.name.endsWith(".DetailActivity"))?.isTaskRoot).toBe(
      false,
    );
  });

  test("computes depth as poppable entries in the current task", async () => {
    const result = await parse(LEGACY_MULTI_TASK);

    expect(result.currentTaskId).toBe(123);
    expect(result.depth).toBe(2);
  });

  test("parses the modern two-space Hist form and its task id", async () => {
    const result = await parse(MODERN_SINGLE_TASK);

    expect(result.activities.map((a) => a.name)).toEqual([
      "com.example.DetailActivity",
      "com.example.MainActivity",
    ]);
    expect(result.activities.map((a) => a.taskId)).toEqual([61, 61]);
    expect(result.activities.map((a) => a.isTaskRoot)).toEqual([false, true]);
    expect(result.depth).toBe(1);
  });

  test("carries the enclosing task affinity onto its activities", async () => {
    const result = await parse(LEGACY_MULTI_TASK);

    expect(result.activities[0].taskAffinity).toBe("com.android.launcher3");
    expect(result.activities[3].taskAffinity).toBe("dev.jasonpearson.automobile.playground");
  });

  describe("degenerate input", () => {
    test("no tasks at all", async () => {
      const result = await parse("ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)\n");

      expect(result.activities).toEqual([]);
      expect(result.tasks).toEqual([]);
      expect(result.depth).toBe(0);
    });

    test("a task with no activities", async () => {
      const result = await parse(`
    Task id #7
    affinity=com.example
    realActivity=com.example/.MainActivity
    numActivities=0
`);

      expect(result.activities).toEqual([]);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe(7);
      expect(result.depth).toBe(0);
    });

    test("a malformed activity line mid-block does not drop its neighbours", async () => {
      const result = await parse(`
    Task id #9
    affinity=com.example
      * Hist #2: ActivityRecord{aaa u0 com.example/.TopActivity t9}
      * Hist #1: ActivityRecord{bbb u0 com.example
      * Hist #0: ActivityRecord{ccc u0 com.example/.MainActivity t9}

  mResumedActivity: ActivityRecord{aaa u0 com.example/.TopActivity t9}
`);

      expect(result.activities.map((a) => a.name)).toEqual([
        "com.example.TopActivity",
        "com.example.MainActivity",
      ]);
      expect(result.depth).toBe(1);
    });

    test("a finishing activity (' f}') is still parsed", async () => {
      const result = await parse(`
    Task id #5
    affinity=com.example
      * Hist #1: ActivityRecord{aaa u0 com.example/.TopActivity t5 f}
      * Hist #0: ActivityRecord{bbb u0 com.example/.MainActivity t5}
`);

      expect(result.activities.map((a) => a.name)).toEqual([
        "com.example.TopActivity",
        "com.example.MainActivity",
      ]);
      expect(result.activities.map((a) => a.taskId)).toEqual([5, 5]);
    });

    test("API 33 shape ('...}' then ' tNN}') parses the component and its own task id", async () => {
      // The two ActivityRecord strings below are copied verbatim from the
      // committed API 33 capture, test/features/observe/windowDumps/
      // api33-settings-window-dump.log:289 and :318. Unlike every other API
      // level captured in that directory, API 33 closes the component with a
      // brace and prints the task id after it. The enclosing task header is
      // deliberately a task id the activities do NOT belong to, so a component
      // ending in "}" or a task id silently falling back to the header both
      // fail here.
      const result = await parse(`
    Task id #99
    affinity=com.android.settings
      * Hist  #1: ActivityRecord{a9cf40f u0 com.android.settings/.Settings} t8}
      * Hist  #0: ActivityRecord{3177c30 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity} t7}
`);

      expect(result.activities.map((a) => a.name)).toEqual([
        "com.android.settings.Settings",
        "com.google.android.apps.nexuslauncher.NexusLauncherActivity",
      ]);
      expect(result.activities.map((a) => a.taskId)).toEqual([8, 7]);
      expect(result.activities.map((a) => a.isTaskRoot)).toEqual([false, true]);
    });

    test("an activity with no task ('t??') falls back to the enclosing task", async () => {
      const result = await parse(`
    Task id #5
    affinity=com.example
      * Hist #0: ActivityRecord{aaa u0 com.example/.MainActivity t??}
`);

      expect(result.activities).toHaveLength(1);
      expect(result.activities[0].taskId).toBe(5);
    });

    test("an activity line without a tNN suffix falls back to the enclosing task", async () => {
      const result = await parse(`
    Task id #5
    affinity=com.example
      * Hist #0: ActivityRecord{aaa u0 com.example/.MainActivity}
`);

      expect(result.activities).toHaveLength(1);
      expect(result.activities[0].taskId).toBe(5);
      expect(result.activities[0].isTaskRoot).toBe(true);
    });
  });

  // `rootOfTask=` is printed inside each ActivityRecord block from API 30 on and
  // is the authoritative task-root answer; the Hist-index heuristic disagrees
  // with it in both directions on real devices (issue #4340). These fixtures are
  // contrived -- a real task has exactly one root -- to pin the parser mechanics
  // in isolation: override in both directions, and no bleed across records.
  describe("rootOfTask overrides the Hist-index heuristic (#4340)", () => {
    test("an explicit rootOfTask= wins over the index in both directions", async () => {
      const result = await parse(`
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from top to bottom):
  * Task{d19dee2 #61 type=standard A=10164:com.example U=0 visible=true mode=fullscreen sz=2}
    * Hist  #1: ActivityRecord{2b2ce0f u0 com.example/.DetailActivity t61}
        packageName=com.example processName=com.example
        rootOfTask=true task=Task{d19dee2 #61 type=standard A=10164:com.example}
    * Hist  #0: ActivityRecord{7ff01aa u0 com.example/.MainActivity t61}
        packageName=com.example processName=com.example
        rootOfTask=false task=Task{d19dee2 #61 type=standard A=10164:com.example}
`);

      expect(result.activities.map((a) => a.isTaskRoot)).toEqual([true, false]);
    });

    test("a rootOfTask value never bleeds into the following record", async () => {
      // The second record prints no rootOfTask= line, so it must fall back to
      // its own Hist index (#0 -> true), not inherit the previous record's
      // `false`.
      const result = await parse(`
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from top to bottom):
  * Task{d19dee2 #61 type=standard A=10164:com.example U=0 visible=true mode=fullscreen sz=2}
    * Hist  #1: ActivityRecord{2b2ce0f u0 com.example/.DetailActivity t61}
        packageName=com.example processName=com.example
        rootOfTask=false task=Task{d19dee2 #61 type=standard A=10164:com.example}
    * Hist  #0: ActivityRecord{7ff01aa u0 com.example/.MainActivity t61}
        packageName=com.example processName=com.example
`);

      expect(result.activities.map((a) => a.isTaskRoot)).toEqual([false, true]);
    });

    test("an unrecognized Hist row closes the previous record's block", async () => {
      // The second Hist row is missing its closing brace, so parseHistRow
      // rejects it -- but it still starts a new record, so the rootOfTask=
      // printed in ITS block must not land on the previous activity.
      const result = await parse(`
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from top to bottom):
  * Task{d19dee2 #61 type=standard A=10164:com.example U=0 visible=true mode=fullscreen sz=2}
    * Hist  #0: ActivityRecord{7ff01aa u0 com.example/.MainActivity t61}
        packageName=com.example processName=com.example
    * Hist  #1: ActivityRecord{2b2ce0f u0 com.example/.DetailActivity
        packageName=com.example processName=com.example
        rootOfTask=false task=Task{d19dee2 #61 type=standard A=10164:com.example}
`);

      // Only the well-formed row parses, and it keeps its own index-derived
      // value rather than absorbing the rejected record's rootOfTask=false.
      expect(result.activities).toHaveLength(1);
      expect(result.activities[0].name).toBe("com.example.MainActivity");
      expect(result.activities[0].isTaskRoot).toBe(true);
    });
  });
});
