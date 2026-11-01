import { describe, expect, test } from "bun:test";
import { AwaitIdle } from "../../../src/features/observe/AwaitIdle";
import { RealSettleObserve } from "../../../src/features/observe/SettleObserve";
import { prototypeMotionActive } from "../../../src/features/observe/prototypeMotion";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { ViewHierarchyWindowInfo } from "../../../src/models/ViewHierarchyResult";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";

/**
 * The prototype window's `prototypeMotion: {active, loops}` (#15114): a fade or slide changes no
 * node, so the identical-tree stability checks must also wait for `active` to reach zero, ignore
 * `loops`, and stay bounded by their timeout.
 */

const prototypeWindow = (motion?: { active: number; loops: number }): ViewHierarchyWindowInfo => ({
  id: 7,
  prototypePlacement: "floating",
  ...(motion ? { prototypeMotion: motion } : {}),
});

const node = { "resource-id": "screen", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };

function obs(updatedAt: number, motion?: { active: number; loops: number }): ObserveResult {
  return {
    updatedAt,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId: "com.example", activityName: ".MainActivity", layoutSeqSum: 1 },
    viewHierarchy: {
      packageName: "com.example",
      hierarchy: { node },
      windows: [prototypeWindow(motion)],
      updatedAt,
    },
  } as ObserveResult;
}

describe("prototypeMotionActive", () => {
  test("sums active across windows and ignores loops", () => {
    expect(
      prototypeMotionActive({
        windows: [
          prototypeWindow({ active: 2, loops: 5 }),
          prototypeWindow({ active: 1, loops: 0 }),
        ],
      }),
    ).toBe(3);
    expect(prototypeMotionActive({ windows: [prototypeWindow({ active: 0, loops: 3 })] })).toBe(0);
  });

  test("absent, malformed and negative counts read as settled", () => {
    expect(prototypeMotionActive(undefined)).toBe(0);
    expect(prototypeMotionActive(null)).toBe(0);
    expect(prototypeMotionActive({})).toBe(0);
    expect(prototypeMotionActive({ windows: [prototypeWindow()] })).toBe(0);
    expect(prototypeMotionActive({ windows: [prototypeWindow({ active: -1, loops: 0 })] })).toBe(0);
    expect(
      prototypeMotionActive({ windows: [prototypeWindow({ active: Number.NaN, loops: 0 })] }),
    ).toBe(0);
  });
});

describe("RealSettleObserve with prototype motion", () => {
  test("identical trees do not settle until the motion count reaches zero", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    const settledFrame = obs(50, { active: 0, loops: 1 });
    fake.setObserveSequence([
      obs(10, { active: 2, loops: 0 }),
      obs(20, { active: 1, loops: 0 }),
      obs(30, { active: 1, loops: 0 }),
      obs(40, { active: 0, loops: 1 }),
      settledFrame,
    ]);

    const result = await new RealSettleObserve(fake, timer).execute({
      timeoutMs: 2500,
      pollMs: 10,
    });

    expect(result.settled).toBe(true);
    expect(result.polls).toBe(5);
    expect(result.observation).toBe(settledFrame);
  });

  test("a poll after a motion-active capture forces a fresh device extraction", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([
      obs(10, { active: 1, loops: 0 }),
      obs(20, { active: 0, loops: 0 }),
      obs(30, { active: 0, loops: 0 }),
    ]);

    await new RealSettleObserve(fake, timer).execute({ timeoutMs: 2500, pollMs: 10 });

    // A cached capture would keep reporting `active` after the animation ends, since ending changes
    // no node and fires no event.
    expect(fake.getExecuteOptions().map((o) => o.requireFreshExtraction ?? false)).toEqual([
      false,
      true,
      false,
    ]);
  });

  test("a prototype that never stops animating ends at the timeout, not settled", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence(
      Array.from({ length: 20 }, (_, i) => obs(10 + i, { active: 1, loops: 0 })),
    );

    const result = await new RealSettleObserve(fake, timer).execute({
      timeoutMs: 100,
      pollMs: 10,
    });

    expect(result.settled).toBe(false);
    expect(result.terminalReason).toBe("timeout");
  });

  test("an older APK without the field settles as before", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const fake = new FakeObserveScreen();
    fake.setObserveSequence([obs(10), obs(20)]);

    const result = await new RealSettleObserve(fake, timer).execute({
      timeoutMs: 2500,
      pollMs: 10,
    });

    expect(result.settled).toBe(true);
    expect(result.polls).toBe(2);
  });
});

describe("AwaitIdle quiet-tree stability with prototype motion", () => {
  const device = { deviceId: "motion", name: "motion", platform: "android" as const };
  const tree = (motion: { active: number; loops: number }) => ({
    fresh: true,
    hierarchy: { node: { $: { text: "same" } } },
    windows: [prototypeWindow(motion)],
  });

  test("two identical trees count only once the prototype reports no active motion", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const reader = new FakeViewHierarchy();
    reader.configureHierarchySequence([
      tree({ active: 1, loops: 0 }),
      tree({ active: 1, loops: 0 }),
      tree({ active: 0, loops: 2 }),
      tree({ active: 0, loops: 2 }),
    ]);
    const idle = new AwaitIdle(device, new FakeAdbClientFactory(new FakeAdbExecutor()), timer, {
      hierarchyReader: reader,
    });

    const result = await idle.waitForUiStability("com.android.systemui", 500);

    expect(result?.isStable).toBe(true);
    expect(reader.getCallCount()).toBe(4);
  });
});
