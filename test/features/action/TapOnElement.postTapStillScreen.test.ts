import { describe, expect, spyOn, test } from "bun:test";
import { hierarchyFingerprint } from "../../../src/utils/hierarchyFingerprint";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { RealWaitForCondition } from "../../../src/features/observe/WaitForCondition";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeDeviceStateCollector } from "../../fakes/FakeDeviceStateCollector";
import { deviceLikeAndroidHierarchy } from "../../helpers/deviceLikeAndroidHierarchy";
import { createObserveScreenForTest } from "../observe/observeScreenTestBuilders";

async function harness(changeAt?: number, neverStable = false) {
  let started = 0;
  const h = await deviceLikeAndroidHierarchy((extraction) => {
    if (
      neverStable &&
      (changeAt === undefined || (extraction > 0 && h.timer.now() - started >= changeAt))
    ) {
      return `Frame ${extraction}`;
    }
    return extraction > 0 && changeAt !== undefined && h.timer.now() - started >= changeAt
      ? "C"
      : "B";
  });
  const screen = createObserveScreenForTest(
    h.device,
    new FakeAdbClientFactory(h.adb),
    {
      viewHierarchy: h.viewHierarchy,
      cacheStore: new FakeObserveCacheStore(h.timer),
      deviceStateCollector: new FakeDeviceStateCollector(false) as never,
    },
    h.timer,
  );
  const recomposition = spyOn(screen, "processRecomposition").mockResolvedValue(undefined);
  const current = await screen.execute({
    skipScreenshot: true,
    skipBackStack: true,
    skipAccessibilityAudit: true,
    skipPerformanceAudit: true,
    skipRecompositionTracking: true,
  });
  const previous = {
    ...current,
    viewHierarchy: {
      ...current.viewHierarchy!,
      hierarchy: { ...current.viewHierarchy!.hierarchy, node: { text: "A" } },
    },
  };
  started = h.timer.now();
  const tap = new TapOnElement(h.device, h.adb, {
    timer: h.timer,
    waitForCondition: new RealWaitForCondition(screen, h.timer),
  });
  return {
    ...h,
    tap,
    screen,
    current,
    previous,
    elapsed: () => h.timer.now() - started,
    restore: () => {
      recomposition.mockRestore();
      h.restore();
      resetObserveCacheStore();
      displayTransitions.reset(h.device.deviceId);
    },
  };
}

describe("Android post-tap wait with the real CtrlProxy cache (#9618)", () => {
  test.each([
    { name: "already still", elapsed: 1040, reads: 7 },
    { name: "350ms transition", changeAt: 350, elapsed: 1550, reads: 10 },
    { name: "800ms late transition", changeAt: 800, elapsed: 1890, reads: 12 },
    { name: "never stable", neverStable: true, elapsed: 2500, reads: 15 },
    {
      name: "initially unchanged, never stable",
      unchanged: true,
      neverStable: true,
      elapsed: 2520,
      reads: 16,
    },
    { name: "no change", unchanged: true, elapsed: 2500, reads: 15 },
    {
      name: "initially unchanged, 350ms effect",
      unchanged: true,
      changeAt: 350,
      elapsed: 1550,
      reads: 10,
    },
    {
      name: "initially unchanged, 800ms effect",
      unchanged: true,
      changeAt: 800,
      elapsed: 1890,
      reads: 12,
    },
    {
      name: "initially unchanged, 1500ms effect",
      unchanged: true,
      changeAt: 1500,
      elapsed: 2690,
      reads: 17,
    },
    {
      name: "initially unchanged, 2300ms effect",
      unchanged: true,
      changeAt: 2300,
      elapsed: 3540,
      reads: 22,
    },
    {
      name: "late effect never stable",
      unchanged: true,
      changeAt: 2300,
      neverStable: true,
      elapsed: 4900,
      reads: 30,
    },
  ])("$name", async (scenario) => {
    const h = await harness(scenario.changeAt, scenario.neverStable);
    try {
      const result = await h.tap.deriveTapEffectAfterPostTapObservation(
        scenario.unchanged ? h.current : h.previous,
        h.current,
      );
      expect(result.effect?.screenChanged).toBe(
        !scenario.unchanged || scenario.changeAt !== undefined || scenario.neverStable === true,
      );
      if (scenario.changeAt !== undefined && !scenario.neverStable) {
        expect(JSON.stringify(result.observation.viewHierarchy?.hierarchy)).toContain('"C"');
      }
      expect({ elapsed: h.elapsed(), reads: h.extractions() }).toEqual({
        elapsed: scenario.elapsed,
        reads: scenario.reads,
      });
      if (scenario.neverStable) {
        expect(h.elapsed()).toBeLessThanOrEqual(5000);
      }
      // The entering observation is cached. Every subsequent sample must be an extraction.
      expect(h.reads.slice(1).every((read) => read.fresh === true)).toBe(true);
    } finally {
      h.restore();
    }
  });

  test("retryIfNoChange dispatches exactly one tap for a 1500ms effect with real wait verification", async () => {
    const h = await harness(1500);
    const dispatch = spyOn(h.tap, "executeAndroidTap").mockResolvedValue(undefined);
    let verified: Awaited<ReturnType<TapOnElement["deriveTapEffectAfterPostTapObservation"]>>;
    try {
      const element = { text: "B", bounds: { left: 0, top: 100, right: 200, bottom: 160 } };
      await h.tap.executeAndroidTap("tap", 100, 130, 0, element, undefined);
      // The existing retry seam refreshes its evidence before deciding whether
      // to dispatch again. Supply the real post-tap waiter, not a scripted verdict.
      await h.tap.retryTapIfNoChange(
        hierarchyFingerprint(h.current.viewHierarchy ?? null),
        { x: 100, y: 130 },
        "tap",
        0,
        element,
        {
          action: "tap",
          text: "B",
          retryIfNoChange: true,
          verification: {
            refresh: async () => {
              verified = await h.tap.deriveTapEffectAfterPostTapObservation(h.current, h.current);
              return verified.observation.viewHierarchy ?? null;
            },
          },
        },
        false,
        h.current.screenSize,
      );
      expect(verified!.effect?.screenChanged).toBe(true);
      expect(JSON.stringify(verified!.observation.viewHierarchy?.hierarchy)).toContain('"C"');
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      dispatch.mockRestore();
      h.restore();
    }
  });

  test.each(["activeWindow", "screenIdentity"] as const)(
    "%s changes are authoritative on the first fresh poll",
    async (basis) => {
      const h = await harness(0);
      const initial =
        basis === "activeWindow"
          ? {
              ...h.current,
              activeWindow: { appId: "app", activityName: "Source", layoutSeqSum: 1 },
            }
          : {
              ...h.current,
              screenIdentity: {
                platform: "android" as const,
                source: "heuristic" as const,
                confidence: "high" as const,
                key: "source",
                components: {},
              },
            };
      const execute = h.screen.execute.bind(h.screen);
      const capture = spyOn(h.screen, "execute").mockImplementation(async (options) => {
        const observation = await execute(options);
        return basis === "activeWindow"
          ? {
              ...observation,
              activeWindow: { appId: "app", activityName: "Destination", layoutSeqSum: 2 },
            }
          : { ...observation, screenIdentity: { ...initial.screenIdentity!, key: "destination" } };
      });
      try {
        const result = await h.tap.deriveTapEffectAfterPostTapObservation(initial, initial);
        expect(result.effect).toEqual({ screenChanged: true, basis: `${basis} changed` });
        expect({ elapsed: h.elapsed(), reads: h.extractions() }).toEqual({ elapsed: 20, reads: 1 });
      } finally {
        capture.mockRestore();
        h.restore();
      }
    },
  );

  test("the continuation preserves a trusted change when all subsequent polls are rootless", async () => {
    const h = await harness(2300, true);
    const execute = h.screen.execute.bind(h.screen);
    const capture = spyOn(h.screen, "execute").mockImplementation(async (options) => {
      const observation = await execute(options);
      return h.extractions() >= 16 ? { ...observation, viewHierarchy: undefined } : observation;
    });
    try {
      const result = await h.tap.deriveTapEffectAfterPostTapObservation(h.current, h.current);
      expect(result.effect?.screenChanged).toBe(true);
      expect(JSON.stringify(result.observation.viewHierarchy?.hierarchy)).toContain('"Frame 15"');
      expect({ elapsed: h.elapsed(), reads: h.extractions() }).toEqual({
        elapsed: 4900,
        reads: 30,
      });
    } finally {
      capture.mockRestore();
      h.restore();
    }
  });

  test("aborts after the second fresh device read, before evaluating or polling again", async () => {
    const h = await harness();
    const controller = new AbortController();
    const read = h.viewHierarchy.getViewHierarchy.bind(h.viewHierarchy);
    const capture = spyOn(h.viewHierarchy, "getViewHierarchy").mockImplementation(
      async (...args) => {
        const result = await read(...args);
        if (h.extractions() === 2) {
          controller.abort();
        }
        return result;
      },
    );
    try {
      await expect(
        h.tap.deriveTapEffectAfterPostTapObservation(h.previous, h.current, controller.signal),
      ).rejects.toThrow("Operation cancelled");
      expect({ elapsed: h.elapsed(), reads: h.extractions() }).toEqual({ elapsed: 190, reads: 2 });
    } finally {
      capture.mockRestore();
      h.restore();
    }
  });

  test("an initially unchanged tap preserves its delayed change when the device sleeps mid-settle", async () => {
    const h = await harness(350);
    const execute = h.screen.execute.bind(h.screen);
    const capture = spyOn(h.screen, "execute").mockImplementation(async (options) => {
      const observation = await execute(options);
      return h.extractions() === 6
        ? {
            ...observation,
            viewHierarchy: undefined,
            wakefulness: "Asleep",
            wakefulnessSource: "adb",
          }
        : observation;
    });
    try {
      const result = await h.tap.deriveTapEffectAfterPostTapObservation(h.current, h.current);
      expect(result.effect).toEqual({ screenChanged: true, basis: "viewHierarchy changed" });
      expect(result.observation.wakefulness).toBe("Asleep");
      expect({ elapsed: h.elapsed(), reads: h.extractions() }).toEqual({ elapsed: 870, reads: 6 });
    } finally {
      capture.mockRestore();
      h.restore();
    }
  });
});
