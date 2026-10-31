import { describe, expect, test } from "bun:test";
import { AwaitIdle } from "../../../src/features/observe/AwaitIdle";
import { Idle } from "../../../src/features/observe/Idle";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import type { ViewHierarchyRequestReader } from "../../../src/features/observe/interfaces/ViewHierarchy";
import type { ViewHierarchyReadRequest } from "../../../src/features/observe/hierarchyReadArgs";
import { validGfxinfoOutput, noFrameGfxinfoOutput } from "./gfxinfoFixtures";

const device = { deviceId: "quiet-tree", name: "quiet-tree", platform: "android" as const };
const tree = (text: string, fresh = true) => ({
  fresh,
  hierarchy: { node: { $: { text } } },
});

function setup(reader = new FakeViewHierarchy()) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbExecutor();
  const factory = new FakeAdbClientFactory(adb);
  const idle = new AwaitIdle(device, factory, timer, { hierarchyReader: reader });
  return { timer, adb, idle, reader, factory };
}

describe("Android stability signal regressions", () => {
  test("Settings uses real gfxinfo: 1 -> 7 reads, 68 -> 85 simulated ms", async () => {
    const { timer, adb, idle, reader } = setup();
    // Two polls without frames keep Settings non-idle through t=17; valid data follows.
    adb.setCommandResponseSequence("dumpsys gfxinfo 'com.android.settings'", [
      createExecResult("", ""), // reset
      createExecResult(noFrameGfxinfoOutput, ""),
      createExecResult(noFrameGfxinfoOutput, ""),
      createExecResult(validGfxinfoOutput, ""),
    ]);
    const result = await idle.waitForUiStability("com.android.settings", 500);
    expect(result?.isStable).toBe(true);
    expect(result?.stabilityWaitMs).toBe(85);
    const reads = adb.getExecutedCommands().filter((cmd) => !cmd.endsWith(" reset"));
    expect(reads).toHaveLength(7); // six polls plus final metrics; old shortcut only read final metrics
    expect(reader.getCallCount()).toBe(0);
    expect(timer.now()).toBe(85);
  });

  test.each(["com.android.launcher3", "com.android.systemui"])(
    "%s waits for two identical fresh trees: 0 -> 6 reads, 68 -> 85 ms",
    async (pkg) => {
      const { timer, idle, reader, adb } = setup();
      reader.configureHierarchySequence([
        tree("A"),
        tree("B"),
        tree("C"),
        tree("D"),
        tree("E"),
        tree("E"),
      ]);
      const result = await idle.waitForUiStability(pkg, 500);
      expect(result?.isStable).toBe(true);
      expect(result?.stabilityWaitMs).toBe(85);
      expect(reader.getCallCount()).toBe(6);
      expect(reader.getReadOptions()).toEqual(
        [500, 483, 466, 449, 432, 415].map((timeoutMs) => ({
          timeoutMs,
          requireFreshExtraction: true,
        })),
      );
      expect(adb.getExecutedCommands()).toEqual([`shell dumpsys gfxinfo '${pkg}' reset`]);
      expect(timer.now()).toBe(85);
    },
  );

  test("cached device timestamps force newer extractions and settle at 34 ms", async () => {
    const { timer, factory } = setup();
    const requests: (ViewHierarchyReadRequest | undefined)[] = [];
    let cached = { ...tree("launcher", false), updatedAt: 1000 };
    const reader: ViewHierarchyRequestReader = {
      getViewHierarchy: async (_query, request) => {
        requests.push(request);
        const floor = request?.minTimestamp ?? 0;
        if (floor > 0) {
          cached = { ...cached, fresh: true, updatedAt: floor + 16 };
        }
        return cached;
      },
    };
    const idle = new AwaitIdle(device, factory, timer, { hierarchyReader: reader });
    const result = await idle.waitForUiStability("com.android.launcher3", 500);
    expect(timer.now()).toBe(34);
    expect(result?.isStable).toBe(true);
    expect(result?.stabilityWaitMs).toBe(34);
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request?.minTimestamp)).toEqual([undefined, 1001, 1018]);
    expect(requests.every((request) => request?.requireFreshExtraction === true)).toBe(true);
  });

  test("identical cached reads cannot satisfy the check; falls back stable at 50 ms", async () => {
    const { timer, idle, reader } = setup();
    reader.configureHierarchy({ ...tree("cached", false), updatedAt: 1000 });
    const result = await idle.waitForUiStability("com.android.launcher3", 50);
    expect(result?.isStable).toBe(true);
    expect(reader.getCallCount()).toBe(3);
    expect(timer.now()).toBe(50);
  });

  test("a stale read between matching fresh trees breaks the consecutive pair", async () => {
    const { timer, idle, reader } = setup();
    reader.configureHierarchySequence([tree("A"), tree("A", false), tree("A"), tree("A")]);
    const result = await idle.waitForUiStability("com.android.launcher3", 100);
    expect(result?.isStable).toBe(true);
    expect(reader.getCallCount()).toBe(4);
    expect(timer.now()).toBe(51);
  });

  test("a cancelled optional tree read ends without throwing or leaving deadlines", async () => {
    const { timer, factory } = setup();
    const controller = new AbortController();
    const reader: ViewHierarchyRequestReader = {
      getViewHierarchy: async () => {
        controller.abort();
        return tree("A");
      },
    };
    const idle = new Idle(device, factory, timer, reader);
    const result = await idle.getUiStability(
      "com.android.launcher3",
      {
        missedVsync: null,
        slowUiThread: null,
        frameDeadlineMissed: null,
        totalFrames: null,
      },
      false,
      { timeoutMs: 50, signal: controller.signal },
    );
    expect(result.isStable).toBe(true);
    expect(timer.now()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("never-settling fresh tree falls back at the remaining bound, including reset time", async () => {
    const { timer, idle, reader } = setup();
    reader.configureHierarchySequence([tree("A"), tree("B"), tree("C")]);
    const state = await idle.initializeUiStabilityTracking("com.android.launcher3", 50);
    timer.advanceTime(10);
    const result = await idle.waitForUiStabilityWithState("com.android.launcher3", 50, state);
    expect(result?.isStable).toBe(true);
    expect(result?.stabilityWaitMs).toBe(50);
    expect(timer.now()).toBe(50);
    expect(reader.getCallCount()).toBe(3);
  });

  test("a hung reader is raced against the injected deadline and its I/O is aborted", async () => {
    const { timer, factory } = setup();
    let readSignal: AbortSignal | undefined;
    const reader: ViewHierarchyRequestReader = {
      getViewHierarchy: (_query, request) => {
        readSignal = request?.signal;
        return new Promise(() => {});
      },
    };
    const idle = new AwaitIdle(device, factory, timer, { hierarchyReader: reader });
    const result = await idle.waitForUiStability("com.android.launcher3", 50);
    expect(result?.isStable).toBe(true);
    expect(readSignal?.aborted).toBe(true);
    expect(timer.now()).toBe(50);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("an optional tree read error never throws and does not become evidence of quiet", async () => {
    const { timer, idle, reader } = setup();
    reader.setFailure(new Error("tree unavailable"));
    const result = await idle.waitForUiStability("com.android.launcher3", 50);
    expect(result?.isStable).toBe(true);
    expect(timer.now()).toBe(50);
  });

  test("direct Idle shortcut also requires two fresh reads", async () => {
    const { timer, factory, reader } = setup();
    reader.configureHierarchySequence([tree("A"), tree("B"), tree("B")]);
    const idle = new Idle(device, factory, timer, reader);
    const result = await idle.getUiStability(
      "com.android.launcher3",
      {
        missedVsync: null,
        slowUiThread: null,
        frameDeadlineMissed: null,
        totalFrames: null,
      },
      false,
      { timeoutMs: 50 },
    );
    expect(result.isStable).toBe(true);
    expect(reader.getCallCount()).toBe(3);
    expect(timer.now()).toBe(34);
  });
});
