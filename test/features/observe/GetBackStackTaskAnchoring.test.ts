import { describe, expect, test } from "bun:test";
import { GetBackStack } from "../../../src/features/observe/GetBackStack";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { BackStackInfo, BootedDevice } from "../../../src/models";

/**
 * Task-header anchoring and root-component derivation (issue #4263,
 * follow-up to the two P2 review findings on PR #4253).
 *
 * PROVENANCE. The 13 captures committed under
 * `test/features/observe/windowDumps/` are `dumpsys window windows` output.
 * They contain no `Task{`, no `TaskRecord`, no `Task id #`, no `Hist #N` and no
 * `A=`/`I=`/`aI=`/`realActivity=` tokens, so they cannot exercise any of this.
 *
 * LEGACY_REAL_CAPTURE below is trimmed verbatim from a real
 * `dumpsys activity activities` capture of an Android 9-era device -- the one
 * linked from the PR #4253 review comment
 * (gist.github.com/ganadist/0102b683fb8a873feee7f0568b9a0382). Two of its lines
 * match the old unanchored `/TaskRecord.*#(\d+)/` without being task headers:
 *
 *   1. `frontOfTask=false task=TaskRecord{...}`, printed by the ACTIVITY dump
 *      between two `Hist #N` rows.
 *   2. the `TaskRecord{...}` line repeated under
 *      `Running activities (most recent first):`.
 *
 * The genuine legacy headers are line-anchored: `Task id #N`, and the
 * `"    * " + task` line printed by `ActivityStack.dumpActivitiesLocked`.
 *
 * The MODERN fixtures are AOSP-shaped and are now VERIFIED against real
 * captures committed under `test/features/observe/activityActivitiesDumps/`
 * (one per API level 24..36, issue #4329), exercised by
 * `GetBackStackRealCaptures.test.ts`. What they pin here is only that the root
 * component falls back to the task's own `Hist #0` row, since `A=` carries
 * `Task.affinity` (uid-prefixed on Android 11+, app-declarable, possibly empty)
 * and is not a package name -- a fallback the real modern captures confirm
 * (e.g. API 34's `A=1000:com.android.settings` alongside a Hist #0 root).
 */

const device: BootedDevice = { name: "test", platform: "android", deviceId: "test-device" };

async function parse(stdout: string): Promise<BackStackInfo> {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("dumpsys activity activities", { stdout, stderr: "" });
  return new GetBackStack(device, new FakeAdbClientFactory(adb)).execute();
}

// Verbatim excerpt: one two-activity task, both hazard lines present.
const LEGACY_REAL_CAPTURE = `
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from top to bottom):

  Stack #436: type=standard mode=fullscreen
    Task id #14418
    mBounds=Rect(0, 0 - 0, 0)
    * TaskRecord{1d3813b #14418 A=com.facebook.katana U=0 StackId=436 sz=2}
      userId=0 effectiveUid=u0a161 mCallingUid=u0a161
      affinity=com.facebook.katana
      realActivity=com.facebook.katana/.activity.ImmersiveActivity
      numActivities=2
      * Hist #1: ActivityRecord{7c63edf u0 com.facebook.katana/.activity.FbMainTabActivity t14418}
          packageName=com.facebook.katana processName=com.facebook.katana
          frontOfTask=false task=TaskRecord{1d3813b #14418 A=com.facebook.katana U=0 StackId=436 sz=2}
          taskAffinity=com.facebook.katana
      * Hist #0: ActivityRecord{7f67c32 u0 com.facebook.katana/.activity.FbMainTabActivity t14418}
          packageName=com.facebook.katana processName=com.facebook.katana
          frontOfTask=true task=TaskRecord{1d3813b #14418 A=com.facebook.katana U=0 StackId=436 sz=2}
          taskAffinity=com.facebook.katana

    Running activities (most recent first):
      TaskRecord{1d3813b #14418 A=com.facebook.katana U=0 StackId=436 sz=2}
        Run #0: ActivityRecord{7c63edf u0 com.facebook.katana/.activity.FbMainTabActivity t14418}

    mResumedActivity: ActivityRecord{7c63edf u0 com.facebook.katana/.activity.FbMainTabActivity t14418}
`;

describe("legacy inline TaskRecord{...} references are not task headers (#4263)", () => {
  test("produces exactly one task, not one per inline reference", async () => {
    const result = await parse(LEGACY_REAL_CAPTURE);

    expect(result.tasks.map((t) => t.id)).toEqual([14418]);
  });

  test("keeps taskAffinity on every activity in the task", async () => {
    // The inline `task=TaskRecord{...}` sits between Hist #1 and Hist #0. Read
    // as a header it reset the affinity to undefined, so Hist #0 lost it.
    const result = await parse(LEGACY_REAL_CAPTURE);

    expect(result.activities.map((a) => a.taskAffinity)).toEqual([
      "com.facebook.katana",
      "com.facebook.katana",
    ]);
  });

  test("the Running activities repeat does not blank the parsed task", async () => {
    const result = await parse(LEGACY_REAL_CAPTURE);

    expect(result.tasks[0]).toMatchObject({
      id: 14418,
      affinity: "com.facebook.katana",
      packageName: "com.facebook.katana",
      rootActivity: "com.facebook.katana/.activity.ImmersiveActivity",
      numActivities: 2,
    });
  });

  test("counts the task's Hist rows once, not once per spurious header", async () => {
    const result = await parse(LEGACY_REAL_CAPTURE);

    expect(result.activities).toHaveLength(2);
    expect(result.depth).toBe(1);
  });

  test("reads the id after the identity hash, not the last #number on the line", async () => {
    // `TaskRecord.*#(\\d+)` was greedy, so a later "#N" token won the capture.
    const result = await parse(`
    * TaskRecord{1d3813b #14418 A=com.example U=0 StackId=436 sz=2} mLastFrame=#99
      * Hist #0: ActivityRecord{aaa u0 com.example/.MainActivity t14418}
`);

    expect(result.tasks.map((t) => t.id)).toEqual([14418]);
  });

  test("a legacy TaskRecord header carries its own A= affinity", async () => {
    // No standalone `affinity=` line: the header token is the only source.
    const result = await parse(`
    * TaskRecord{1d3813b #14418 A=com.facebook.katana U=0 StackId=436 sz=2}
      * Hist #0: ActivityRecord{aaa u0 com.facebook.katana/.Main t14418}
`);

    expect(result.tasks[0].affinity).toBe("com.facebook.katana");
    expect(result.activities[0].taskAffinity).toBe("com.facebook.katana");
  });

  test("a legacy TaskRecord header carries its own I= component", async () => {
    const result = await parse(`
    * TaskRecord{a2dcbca #14243 I=com.google.android.apps.nexuslauncher/.NexusLauncherActivity U=0 StackId=0 sz=1}
      * Hist #0: ActivityRecord{8f236c u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t14243}
`);

    expect(result.tasks[0].rootActivity).toBe(
      "com.google.android.apps.nexuslauncher/.NexusLauncherActivity",
    );
    expect(result.tasks[0].packageName).toBe("com.google.android.apps.nexuslauncher");
  });
});

describe("modern A= tasks source their root component from Hist #0 (#4263)", () => {
  const MODERN_AFFINITY_TASK = `
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from top to bottom):
  * Task{d19dee2 #61 type=standard A=10164:com.example U=0 visible=true mode=fullscreen sz=2}
    * Hist  #1: ActivityRecord{2b2ce0f u0 com.example/.DetailActivity t61}
        packageName=com.example processName=com.example
    * Hist  #0: ActivityRecord{7ff01aa u0 com.example/com.example.MainActivity t61}
        packageName=com.example processName=com.example
`;

  test("packageName and rootActivity come from the Hist #0 row", async () => {
    const result = await parse(MODERN_AFFINITY_TASK);

    expect(result.tasks[0].packageName).toBe("com.example");
    expect(result.tasks[0].rootActivity).toBe("com.example/com.example.MainActivity");
  });

  test("affinity is still the verbatim, uid-prefixed A= value", async () => {
    // A= is Task.affinity, NOT a package name: it keeps the uid prefix, and an
    // app can declare any string. It is never used to derive packageName.
    const result = await parse(MODERN_AFFINITY_TASK);

    expect(result.tasks[0].affinity).toBe("10164:com.example");
  });

  test("Hist #0 does not override an I= header component", async () => {
    // I= is the task's own intent component and outranks the printed root
    // activity, which may be an origActivity/alias target.
    const result = await parse(`
  * Task{9c31af0 #1 type=home I=com.android.launcher3/.Launcher U=0 mode=fullscreen sz=1}
    * Hist  #0: ActivityRecord{3177c30 u0 com.android.launcher3/.OtherEntry t1}
`);

    expect(result.tasks[0].rootActivity).toBe("com.android.launcher3/.Launcher");
    expect(result.tasks[0].packageName).toBe("com.android.launcher3");
  });

  test("Hist #0 does not override a legacy realActivity= line", async () => {
    // The real capture's task 14414 has origActivity=InitActivity as Hist #0
    // while realActivity= is MainActivity; realActivity is the correct root.
    const result = await parse(`
    Task id #14414
    * TaskRecord{b957b35 #14414 A=com.google.android.apps.inbox U=0 StackId=432 sz=1}
      realActivity=com.google.android.apps.inbox/com.google.android.apps.bigtop.activities.MainActivity
      * Hist #0: ActivityRecord{9f42109 u0 com.google.android.apps.inbox/com.google.android.apps.bigtop.activities.InitActivity t14414}
`);

    expect(result.tasks[0].rootActivity).toBe(
      "com.google.android.apps.inbox/com.google.android.apps.bigtop.activities.MainActivity",
    );
  });

  test("a task with no printed Hist #0 leaves packageName/rootActivity undefined", async () => {
    // Nothing on the modern path identifies the package otherwise: A= is an
    // affinity string, not a package. Undefined is the honest answer.
    const result = await parse(`
  * Task{d19dee2 #61 type=standard A=10164:com.example U=0 mode=fullscreen sz=1}
    * Hist  #3: ActivityRecord{2b2ce0f u0 com.example/.DetailActivity t61}
`);

    expect(result.tasks[0].id).toBe(61);
    expect(result.tasks[0].packageName).toBeUndefined();
    expect(result.tasks[0].rootActivity).toBeUndefined();
  });
});

describe("Hist #0 root component defers to rootOfTask=true (#4359)", () => {
  // Mirrors api34 task #9: two `Hist #0` rows in different TaskFragments. The
  // first says rootOfTask=false, the second rootOfTask=true. The first-`Hist #0`
  // heuristic named the activity the dump itself calls NOT the root.
  const TWO_HIST0_ROWS = `
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
  * Task{9de9b7 #9 type=standard A=1000:com.android.settings U=0 mode=fullscreen sz=2}
    * TaskFragment{aaa mode=fullscreen}
      * Hist  #0: ActivityRecord{459683c u0 com.android.settings/.Settings$WifiSettingsActivity t9}
          packageName=com.android.settings processName=com.android.settings
          rootOfTask=false task=Task{9de9b7 #9 type=standard A=1000:com.android.settings}
    * TaskFragment{bbb mode=fullscreen}
      * Hist  #0: ActivityRecord{5059d6b u0 com.android.settings/.homepage.DeepLinkHomepageActivity t9}
          packageName=com.android.settings processName=com.android.settings
          rootOfTask=true task=Task{9de9b7 #9 type=standard A=1000:com.android.settings}
`;

  test("rootActivity is the rootOfTask=true row, not the first Hist #0", async () => {
    const result = await parse(TWO_HIST0_ROWS);

    expect(result.tasks[0].rootActivity).toBe(
      "com.android.settings/.homepage.DeepLinkHomepageActivity",
    );
    expect(result.tasks[0].packageName).toBe("com.android.settings");
  });

  test("API <= 29: with no rootOfTask= printed, the first Hist #0 still wins", async () => {
    // The authoritative field is absent pre-API-30, so the index heuristic
    // remains the only source and its behavior must not change.
    const result = await parse(`
    Task id #14418
    * TaskRecord{1d3813b #14418 A=com.example U=0 StackId=436 sz=2}
      * Hist #0: ActivityRecord{aaa u0 com.example/.FirstActivity t14418}
          frontOfTask=true task=TaskRecord{1d3813b #14418}
      * Hist #0: ActivityRecord{bbb u0 com.example/.SecondActivity t14418}
          frontOfTask=false task=TaskRecord{1d3813b #14418}
`);

    expect(result.tasks[0].rootActivity).toBe("com.example/.FirstActivity");
  });

  test("rootOfTask=true does NOT populate a task that prints no Hist #0", async () => {
    // Narrowed to overriding an existing Hist #0-derived value: a task whose
    // only rootOfTask=true row is a Hist #N (N>0) with no Hist #0 stays
    // undefined, exactly as before #4359. rootActivity must not appear where it
    // was absent.
    const result = await parse(`
  * Task{d19dee2 #61 type=standard A=10164:com.example U=0 mode=fullscreen sz=1}
    * Hist  #1: ActivityRecord{2b2ce0f u0 com.example/.RootActivity t61}
        packageName=com.example processName=com.example
        rootOfTask=true task=Task{d19dee2 #61 type=standard A=10164:com.example}
`);

    expect(result.tasks[0].id).toBe(61);
    expect(result.tasks[0].rootActivity).toBeUndefined();
    expect(result.tasks[0].packageName).toBeUndefined();
  });

  test("rootOfTask=true does not override an I= header component", async () => {
    // The header's own intent component still outranks the Hist-derived root,
    // just as the first-Hist #0 path did.
    const result = await parse(`
  * Task{9c31af0 #1 type=home I=com.android.launcher3/.Launcher U=0 mode=fullscreen sz=1}
    * Hist  #0: ActivityRecord{3177c30 u0 com.android.launcher3/.OtherEntry t1}
        rootOfTask=true task=Task{9c31af0 #1 type=home I=com.android.launcher3/.Launcher}
`);

    expect(result.tasks[0].rootActivity).toBe("com.android.launcher3/.Launcher");
    expect(result.tasks[0].packageName).toBe("com.android.launcher3");
  });
});
