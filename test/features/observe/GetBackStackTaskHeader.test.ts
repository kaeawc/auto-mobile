import { describe, expect, test } from "bun:test";
import { GetBackStack } from "../../../src/features/observe/GetBackStack";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { BackStackInfo, BootedDevice } from "../../../src/models";

/**
 * The modern task-header line in `dumpsys activity activities` (issue #4223).
 *
 * SOURCE. The shape below was originally taken from AOSP source rather than a
 * capture: the 13 dumps under `test/features/observe/windowDumps/` are
 * `dumpsys window` output and contain no task headers at all (zero hits for
 * `Task{`, `Task id #` or `TaskRecord`). It is now corroborated by real
 * `dumpsys activity activities` captures committed under
 * `test/features/observe/activityActivitiesDumps/` (one per API level 24..36,
 * issue #4329) and exercised end-to-end by `GetBackStackRealCaptures.test.ts` --
 * the modern `A=<uid>:<pkg>` header this suite pins is observed verbatim in, for
 * example, the API 34 capture. The hand-authored fixtures here are retained for
 * the controlled degenerate rows a live capture cannot be driven to produce.
 * Every field asserted here is traceable to a specific AOSP append:
 *
 *   frameworks/base/services/core/java/com/android/server/wm/TaskFragment.java
 *     dumpInner():  pw.print(prefix); pw.print("* "); pw.println(toFullString());
 *
 *   frameworks/base/services/core/java/com/android/server/wm/Task.java
 *     toString():     "Task{" + hexIdentityHash + " #" + mTaskId
 *                     + " type=" + activityType
 *                     + (" A=" + affinity | " I=" + component | " aI=" + component)
 *                     + "}"
 *     toFullString(): drops the tail "}", then appends
 *                     " U=" + userId, optional " rootTaskId=" + id,
 *                     " visible=", " visibleRequested=", " mode=",
 *                     " translucent=", " sz=" + getChildCount(), "}"
 *
 * (android15-release branch; the same two methods exist unchanged back through
 * the Android 10 rename of `TaskRecord` to `Task`, which is exactly why the old
 * `/TaskRecord.*#(\d+)/` alternative stopped matching.)
 *
 * Two consequences the parser depends on:
 *
 *   1. `#<id>` is ALWAYS the second token, emitted by `toString()` immediately
 *      after the identity hash, before any optional field. Nothing after it is
 *      positionally stable -- `A=`/`I=`/`aI=` are mutually exclusive and
 *      `rootTaskId=` only appears for non-root tasks -- so only the `Task{<hash>
 *      #<id>` prefix is matched positionally; everything else is matched by key.
 *   2. The header is only ever printed with a leading `* ` by `dumpInner`, so
 *      the match is anchored on it. `Task{...}` also appears inline elsewhere in
 *      dumpsys output (e.g. inside `Activities=[...]`), and an unanchored match
 *      would invent tasks from those references.
 *
 * `TaskFragment{...}` must not be mistaken for a task: it is a different
 * `toString()` with no `#id`, and `Task\{` does not match `TaskFragment{`.
 *
 * WHERE THE AFFINITY COMES FROM (issue #4223, last checkbox). On modern output
 * `A=` inside the header is the ONLY source. The standalone `affinity=` line is
 * printed by `Task.dump(PrintWriter, String)`, which
 * `ActivityTaskManagerService.dumpActivitiesLocked` only reaches on the
 * `dumpsys activity <package> -a` path -- not on `dumpsys activity activities`.
 * The same goes for `realActivity=` (renamed `mActivityComponent=` there) and
 * `numActivities=`, which modern AOSP does not print at all; the header's `sz=`
 * is `getChildCount()`, i.e. child *containers*, which for a non-leaf task is a
 * count of child tasks and not of activities. So `sz=` is deliberately NOT read
 * as `numActivities`; the activity count is taken by counting the task's own
 * `Hist #N` lines, which is true for leaf and non-leaf tasks alike.
 *
 * The value of `A=` is uid-prefixed (`10164:com.example`) on Android 11+:
 * `ActivityRecord.computeTaskAffinity(affinity, uid)` prepends `uid + ":"`
 * (b/35954083). It is stored verbatim in `Task.affinity`, so the `affinity=`
 * line -- where it does appear -- carries the identical uid-prefixed string.
 * The parser therefore does no normalization: both paths yield the same value.
 */

const device: BootedDevice = { name: "test", platform: "android", deviceId: "test-device" };

async function parse(stdout: string): Promise<BackStackInfo> {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("dumpsys activity activities", { stdout, stderr: "" });
  return new GetBackStack(device, new FakeAdbClientFactory(adb)).execute();
}

// Field order and spelling per Task.toFullString(); see the header comment.
const MODERN_TWO_TASKS = `
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from top to bottom):
  * Task{d19dee2 #61 type=standard A=10164:com.example U=0 visible=true visibleRequested=true mode=fullscreen translucent=false sz=2}
    mBounds=Rect(0, 0 - 1080, 2400)
    isSleeping=false
    * Hist  #1: ActivityRecord{2b2ce0f u0 com.example/.DetailActivity t61}
        packageName=com.example processName=com.example
    * Hist  #0: ActivityRecord{7ff01aa u0 com.example/com.example.MainActivity t61}
        packageName=com.example processName=com.example
  * Task{9c31af0 #1 type=home I=com.android.launcher3/.Launcher U=0 visible=false visibleRequested=false mode=fullscreen translucent=true sz=1}
    isSleeping=false
    * Hist  #0: ActivityRecord{3177c30 u0 com.android.launcher3/.Launcher t1}

  topResumedActivity=ActivityRecord{2b2ce0f u0 com.example/.DetailActivity t61}
`;

describe("modern Task{...} header (#4223)", () => {
  test("parses the task id out of the Task{<hash> #id ...} header", async () => {
    const result = await parse(MODERN_TWO_TASKS);

    expect(result.tasks.map((t) => t.id)).toEqual([61, 1]);
  });

  test("reads the affinity from the header's A= token", async () => {
    const result = await parse(MODERN_TWO_TASKS);

    // Verbatim, uid prefix included -- this is exactly what Task.affinity holds.
    expect(result.tasks[0].affinity).toBe("10164:com.example");
  });

  test("reads the root component from I= when the task has no affinity", async () => {
    const result = await parse(MODERN_TWO_TASKS);

    expect(result.tasks[1].affinity).toBeUndefined();
    expect(result.tasks[1].rootActivity).toBe("com.android.launcher3/.Launcher");
    expect(result.tasks[1].packageName).toBe("com.android.launcher3");
  });

  test("counts the task's own Hist entries rather than trusting sz=", async () => {
    const result = await parse(MODERN_TWO_TASKS);

    expect(result.tasks.map((t) => t.numActivities)).toEqual([2, 1]);
  });

  test("carries the header affinity onto the task's activities", async () => {
    const result = await parse(MODERN_TWO_TASKS);

    expect(result.activities[0].taskAffinity).toBe("10164:com.example");
    expect(result.activities[2].taskAffinity).toBeUndefined();
  });

  test("uses aI= when only an affinity intent is available", async () => {
    const result = await parse(`
  * Task{aaa1111 #12 type=standard aI=com.example/.Alias U=0 visible=true mode=fullscreen sz=1}
    * Hist  #0: ActivityRecord{bbb u0 com.example/.MainActivity t12}
`);

    expect(result.tasks[0].id).toBe(12);
    expect(result.tasks[0].rootActivity).toBe("com.example/.Alias");
  });

  test("ignores a non-root TaskFragment{...} line", async () => {
    // TaskFragment.toString() carries no "#id"; it must not create a task.
    const result = await parse(`
  * Task{aaa1111 #12 type=standard A=10164:com.example U=0 visible=true mode=fullscreen sz=1}
    * TaskFragment{ccc2222 mode=fullscreen translucent=false sz=1}
      * Hist  #0: ActivityRecord{bbb u0 com.example/.MainActivity t12}
`);

    expect(result.tasks.map((t) => t.id)).toEqual([12]);
  });

  test("does not invent tasks from inline Task{...} references", async () => {
    // Only dumpInner's "* "-prefixed line is a header. An inline mention such as
    // the one below is a reference to a task dumped elsewhere.
    const result = await parse(`
  * Task{aaa1111 #12 type=standard A=10164:com.example U=0 visible=true mode=fullscreen sz=1}
    mLastPausedActivity: ActivityRecord{ddd u0 com.example/.Other t99}
    Activities=[ActivityRecord{bbb u0 com.example/.MainActivity t12}]
    mAdjacentTaskFragment=Task{eee3333 #77 type=standard A=10164:com.other U=0 visible=false mode=fullscreen sz=1}
      * Hist  #0: ActivityRecord{bbb u0 com.example/.MainActivity t12}
`);

    expect(result.tasks.map((t) => t.id)).toEqual([12]);
  });

  test("still parses the legacy Task id # and TaskRecord{} headers", async () => {
    const legacy = await parse(`
    Task id #7
    affinity=com.example
    realActivity=com.example/.MainActivity
    numActivities=3
      * Hist #0: ActivityRecord{aaa u0 com.example/.MainActivity t7}
`);
    expect(legacy.tasks.map((t) => t.id)).toEqual([7]);
    expect(legacy.tasks[0].affinity).toBe("com.example");
    // The explicit numActivities= line wins over the Hist count.
    expect(legacy.tasks[0].numActivities).toBe(3);

    const taskRecord = await parse(`
    TaskRecord{task123 #123 A=dev.example U=0 StackId=1 sz=3}
      * Hist #0: ActivityRecord{aaa u0 dev.example/.MainActivity t123}
`);
    expect(taskRecord.tasks.map((t) => t.id)).toEqual([123]);
  });
});

describe("#4222's claim that depth/currentTaskId are independent of the task header", () => {
  // PR #4222 asserted that depth and currentTaskId derive from activity lines
  // carrying their own tNN, and are therefore unaffected by parseTasks not
  // understanding the modern header. These two tests pin that claim so a future
  // change to the header parser cannot quietly start feeding depth.
  test("depth and currentTaskId are correct with a header the parser understands", async () => {
    const result = await parse(MODERN_TWO_TASKS);

    expect(result.currentTaskId).toBe(61);
    expect(result.depth).toBe(1);
  });

  test("depth and currentTaskId are identical with the header line removed", async () => {
    const withoutHeaders = MODERN_TWO_TASKS.split("\n")
      .filter((line) => !/^\s*\*\s*Task\{/.test(line))
      .join("\n");
    const result = await parse(withoutHeaders);

    expect(result.tasks).toEqual([]);
    expect(result.currentTaskId).toBe(61);
    expect(result.depth).toBe(1);
    expect(result.activities.map((a) => a.taskId)).toEqual([61, 61, 1]);
  });
});
