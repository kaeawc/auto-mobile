import { beforeEach, describe, expect, test } from "bun:test";
import { GetBackStack } from "../../../src/features/observe/GetBackStack";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ExecResult, BootedDevice } from "../../../src/models";

describe("GetBackStack", function () {
  let fakeAdb: FakeAdbExecutor;
  let fakeAdbFactory: FakeAdbClientFactory;
  let getBackStack: GetBackStack;
  let mockDevice: BootedDevice;

  beforeEach(function () {
    mockDevice = {
      name: "test",
      platform: "android",
      deviceId: "test-device",
    };

    // Create FakeAdbExecutor and configure it with pattern matching
    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("dumpsys activity activities", mockDumpsysOutput());

    // Wrap the configured fake in a factory
    fakeAdbFactory = new FakeAdbClientFactory(fakeAdb);

    getBackStack = new GetBackStack(mockDevice, fakeAdbFactory);
  });

  test("parses every activity with its task, package and index-derived task-root flag", async function () {
    const result = await getBackStack.execute();

    expect(result.source).toBe("adb");
    // Launcher task #1 (one Hist #0 row) then playground task #123 (Hist #2, #1, #0).
    // isTaskRoot is index-derived here (no rootOfTask= lines in this capture):
    // the "Hist #0" row of each task is the root, the others are not.
    expect(result.activities).toEqual([
      {
        name: "com.android.launcher3.Launcher",
        taskId: 1,
        taskAffinity: "com.android.launcher3",
        isTaskRoot: true,
      },
      {
        name: "dev.jasonpearson.automobile.playground.DetailActivity",
        taskId: 123,
        taskAffinity: "dev.jasonpearson.automobile.playground",
        isTaskRoot: false,
      },
      {
        name: "dev.jasonpearson.automobile.playground.ListActivity",
        taskId: 123,
        taskAffinity: "dev.jasonpearson.automobile.playground",
        isTaskRoot: false,
      },
      {
        name: "dev.jasonpearson.automobile.playground.MainActivity",
        taskId: 123,
        taskAffinity: "dev.jasonpearson.automobile.playground",
        isTaskRoot: true,
      },
    ]);
  });

  test("parses each task's id, package and activity count", async function () {
    const result = await getBackStack.execute();

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({
      id: 1,
      packageName: "com.android.launcher3",
      numActivities: 1,
    });
    expect(result.tasks[1]).toMatchObject({
      id: 123,
      packageName: "dev.jasonpearson.automobile.playground",
      numActivities: 3,
    });
  });

  test("computes depth as the poppable count of the current task", async function () {
    const result = await getBackStack.execute();

    // Current task 123 holds 3 activities, so 2 can still be popped.
    expect(result.currentTaskId).toBe(123);
    expect(result.depth).toBe(2);
  });

  test("identifies the resumed activity as the current activity", async function () {
    const result = await getBackStack.execute();

    expect(result.currentActivity).toEqual({
      name: "dev.jasonpearson.automobile.playground.DetailActivity",
      taskId: 123,
    });
  });

  test("should parse topResumedActivity with special characters", async function () {
    const stdout = `
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
  Task id #42
  affinity=com.example.app
  realActivity=com.example.app/.MainActivity
  numActivities=1
    * Hist #0: ActivityRecord{abc123 u0 com.example.app/.MainActivity t42}

  topResumedActivity=ActivityRecord{def456 u0 com.example.app/.MainActivity$Inner t42}
`;

    const testFakeAdb = new FakeAdbExecutor();
    testFakeAdb.setCommandResponse("dumpsys activity activities", { stdout, stderr: "" });
    const testFactory = new FakeAdbClientFactory(testFakeAdb);
    getBackStack = new GetBackStack(mockDevice, testFactory);

    const result = await getBackStack.execute();

    expect(result.currentActivity?.name).toBe("com.example.app.MainActivity$Inner");
    expect(result.currentActivity?.taskId).toBe(42);
  });

  test("stamps capturedAt from the injected clock", async function () {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_700_000_000_000);
    getBackStack = new GetBackStack(mockDevice, fakeAdbFactory, timer);

    const result = await getBackStack.execute();

    expect(result.capturedAt).toBe(1_700_000_000_000);
  });

  test("should handle empty back stack", async function () {
    // Mock empty output
    const emptyFakeAdb = new FakeAdbExecutor();
    emptyFakeAdb.setCommandResponse("dumpsys activity activities", { stdout: "", stderr: "" });
    const emptyFactory = new FakeAdbClientFactory(emptyFakeAdb);
    getBackStack = new GetBackStack(mockDevice, emptyFactory);

    const result = await getBackStack.execute();

    expect(result.depth).toBe(0);
    expect(result.activities).toHaveLength(0);
  });

  test("should handle errors gracefully", async function () {
    // Mock error by setting default response and letting the error handling work
    const errorFakeAdb = new FakeAdbExecutor();
    // Don't set any response - the error will come from the parsing logic
    const errorFactory = new FakeAdbClientFactory(errorFakeAdb);
    getBackStack = new GetBackStack(mockDevice, errorFactory);

    const result = await getBackStack.execute();

    expect(result).toBeDefined();
    // When command returns empty but succeeds, result won't have partial flag
    expect(result.depth).toBe(0);
  });
});

// Mock dumpsys activity activities output
function mockDumpsysOutput(): ExecResult {
  const stdout = `
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from top to bottom):

  Stack #0: type=home mode=fullscreen
  isSleeping=false

    Task id #1
    affinity=com.android.launcher3
    realActivity=com.android.launcher3/.Launcher
    numActivities=1
      * Hist #0: ActivityRecord{abc123 u0 com.android.launcher3/.Launcher t1}

  Stack #1: type=standard mode=fullscreen
  isSleeping=false

    Task id #123
    affinity=dev.jasonpearson.automobile.playground
    realActivity=dev.jasonpearson.automobile.playground/.MainActivity
    numActivities=3
      * Hist #2: ActivityRecord{def456 u0 dev.jasonpearson.automobile.playground/.DetailActivity t123}
      * Hist #1: ActivityRecord{ghi789 u0 dev.jasonpearson.automobile.playground/.ListActivity t123}
      * Hist #0: ActivityRecord{jkl012 u0 dev.jasonpearson.automobile.playground/.MainActivity t123}

  Running activities (most recent first):
    TaskRecord{task123 #123 A=dev.jasonpearson.automobile.playground U=0 StackId=1 sz=3}
    TaskRecord{task1 #1 A=com.android.launcher3 U=0 StackId=0 sz=1}

  mResumedActivity: ActivityRecord{def456 u0 dev.jasonpearson.automobile.playground/.DetailActivity t123}
  mFocusedActivity: ActivityRecord{def456 u0 dev.jasonpearson.automobile.playground/.DetailActivity t123}
`;

  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (str: string) => stdout.includes(str),
  };
}
