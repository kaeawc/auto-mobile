import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { NodeCryptoService } from "../../../src/utils/crypto";
import type { TapOnCall } from "../../../src/features/action/ActionCall";
import { SetUIState } from "../../../src/features/action/SetUIState";
import {
  FakeFieldTypeDetector,
  FakeObserveScreenForSetUIState,
} from "../../fakes/FakeSetUIStateDependencies";
import { runBlockWithEnvelope } from "../../helpers/observedInteractionStub";
import { hierarchyFingerprint } from "../../../src/utils/hierarchyFingerprint";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { RealWaitForCondition } from "../../../src/features/observe/WaitForCondition";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
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
    tapStrategy: new FakeTapStrategy(),
    accessibilityDetector: new FakeAccessibilityDetector(),
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

/** Real tap/observe/settle flow with only device I/O and optional enrichment faked. */
async function tapExecutionHarness(changeAt?: number) {
  const h = await harness(changeAt);
  const execute = h.screen.execute.bind(h.screen);
  const captures = spyOn(h.screen, "execute").mockImplementation((options) =>
    execute({
      ...options,
      skipScreenshot: true,
      skipAccessibilityAudit: true,
      skipPerformanceAudit: true,
      skipRecompositionTracking: true,
    }),
  );
  h.tap.observeScreen = h.screen;
  h.tap.awaitIdle = new FakeAwaitIdle();
  h.tap.window = new FakeWindow();
  h.tap.testHooks.setTerminalScreenshotCapture(async () => {});
  h.tap.testHooks.setDeferredPredictionRecorder(async () => {});
  const refresh = spyOn(h.tap, "refreshViewHierarchy").mockResolvedValue(h.current.viewHierarchy!);
  const dispatch = spyOn(h.tap, "executeAndroidTap").mockResolvedValue(undefined);
  return {
    ...h,
    dispatch,
    restore: () => {
      dispatch.mockRestore();
      refresh.mockRestore();
      captures.mockRestore();
      h.restore();
    },
  };
}

describe("Android post-tap wait with the real CtrlProxy cache (#9618)", () => {
  describe.each([
    { name: "no visible effect", changeAt: undefined, oldHashes: 38 },
    { name: "in-place change", changeAt: 350, oldHashes: 30 },
  ])("tap.execute fingerprint budget: $name", (scenario) => {
    let measurement: {
      hashes: number;
      dispatches: number;
      screenChanged: boolean | undefined;
    };

    beforeAll(async () => {
      // Build a measured scenario fixture once for the outcome and budget
      // assertions. Real CtrlProxy conversion/observe/settle work stays intact.
      const hash = spyOn(NodeCryptoService, "generateCacheKey");
      const h = await tapExecutionHarness(scenario.changeAt);
      try {
        const result = await h.tap.execute({ action: "tap", text: "B", retryIfNoChange: false });
        measurement = {
          hashes: hash.mock.calls.length,
          dispatches: h.dispatch.mock.calls.length,
          screenChanged: result.effect?.screenChanged,
        };
        console.info(
          `[tap.execute fingerprint budget] ${scenario.name}: ${measurement.hashes} hashes`,
        );
      } finally {
        h.restore();
        hash.mockRestore();
      }
    });

    test("dispatches once and preserves the expected effect", () => {
      expect(measurement.dispatches).toBe(1);
      expect(measurement.screenChanged).toBe(scenario.changeAt !== undefined);
    });

    test("uses at most half the original hashes", () => {
      expect(measurement.hashes).toBeLessThanOrEqual(Math.floor(scenario.oldHashes / 2));
    });
  });

  const scenarios = [
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
  ];

  test.each(scenarios)("$name", async (scenario) => {
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

  test.each(scenarios)("$name without effect settling", async (scenario) => {
    const h = await harness(scenario.changeAt, scenario.neverStable);
    try {
      const result = await h.tap.deriveTapEffectAfterPostTapObservation(
        scenario.unchanged ? h.current : h.previous,
        h.current,
        undefined,
        { settlePostTapEffect: false },
      );
      expect({ elapsed: h.elapsed(), reads: h.extractions() }).toEqual({ elapsed: 0, reads: 0 });
      expect(result.observation).toBe(h.current);
      expect(result.effect?.screenChanged).toBe(!scenario.unchanged);
    } finally {
      h.restore();
    }
  });

  test.each([undefined, false] as const)(
    "execute forwards settling policy %s after dispatch and retry verification",
    async (settlePostTapEffect) => {
      const h = await harness();
      const strategy = new FakeTapStrategy();
      strategy.retryTapIfNoChange = true;
      const tap = new TapOnElement(h.device, h.adb, {
        timer: h.timer,
        tapStrategy: strategy,
        waitForCondition: new RealWaitForCondition(h.screen, h.timer),
        selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
      });
      tap.observedInteraction = runBlockWithEnvelope(h.current, { observation: h.current });
      tap.refreshViewHierarchy = async () => h.current.viewHierarchy ?? null;
      tap.testHooks.setTerminalScreenshotCapture(async () => {});
      tap.testHooks.setDeferredPredictionRecorder(async () => {});
      const dispatch = spyOn(tap, "executeAndroidTap").mockResolvedValue(undefined);
      const retry = spyOn(tap, "retryTapIfNoChange").mockResolvedValue(undefined);
      try {
        const result = await tap.execute(
          { text: "B", action: "tap", retryIfNoChange: true },
          { settlePostTapEffect },
        );
        expect(result.success).toBe(true);
        expect(result.observation).toBeDefined();
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(retry).toHaveBeenCalledTimes(1);
        expect(retry.mock.calls[0]?.[4].options.retryIfNoChange).toBe(true);
        expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(
          retry.mock.invocationCallOrder[0]!,
        );
        expect({ elapsed: h.elapsed(), reads: h.extractions() }).toEqual(
          settlePostTapEffect === false ? { elapsed: 0, reads: 0 } : { elapsed: 2500, reads: 15 },
        );
      } finally {
        dispatch.mockRestore();
        retry.mockRestore();
        h.restore();
      }
    },
  );

  test.each([false, true])(
    "three-field setUIState with real effect polling, emulate old caller: %s",
    async (emulateOldCaller) => {
      const h = await harness();
      const observe = new FakeObserveScreenForSetUIState();
      const detector = new FakeFieldTypeDetector();
      const fields = ["first", "second", "third"];
      observe.setViewHierarchy({
        hierarchy: {
          node: {
            node: fields.map((id, index) => ({
              $: {
                "resource-id": id,
                class: "android.widget.EditText",
                text: "",
                editable: true,
                bounds: { left: 0, top: index * 60, right: 100, bottom: index * 60 + 50 },
              },
            })),
          },
        },
      });
      let focused = "";
      const calls: TapOnCall[] = [];
      const setUIState = new SetUIState(h.device, null, {
        timer: h.timer,
        observeScreen: observe,
        fieldTypeDetector: detector,
        tapOnElement: {
          execute: async (options, call) => {
            focused = options.elementId ?? "";
            calls.push(call ?? {});
            // Charge the real CtrlProxy-backed settler, rather than a scripted delay.
            const postTap = await h.tap.deriveTapEffectAfterPostTapObservation(
              h.previous,
              h.current,
              call?.signal,
              emulateOldCaller ? {} : call,
            );
            return { success: true, focusVerified: true, observation: postTap.observation };
          },
        },
        clearText: { execute: async () => ({ success: true }) },
        inputText: {
          execute: async (text) => {
            detector.setTextValue(focused, text);
            return { success: true, text };
          },
        },
      });
      try {
        const result = await setUIState.execute({
          fields: fields.map((id) => ({
            selector: { elementId: id },
            value: `value for ${id}`,
          })),
        });
        expect(result.success).toBe(true);
        expect(result.fields.every((field) => field.verified)).toBe(true);
        expect(calls).toHaveLength(3);
        expect({ elapsed: h.elapsed(), reads: h.extractions() }).toEqual(
          emulateOldCaller ? { elapsed: 3 * 1040, reads: 3 * 7 } : { elapsed: 0, reads: 0 },
        );
        expect(calls.every((call) => call.settlePostTapEffect === false)).toBe(true);
      } finally {
        h.restore();
      }
    },
  );

  test("retryIfNoChange dispatches exactly one tap for a 1500ms effect with real wait verification", async () => {
    const h = await harness(1500);
    const dispatch = spyOn(h.tap, "executeAndroidTap").mockResolvedValue(undefined);
    let verified: Awaited<ReturnType<TapOnElement["deriveTapEffectAfterPostTapObservation"]>>;
    try {
      const element = { text: "B", bounds: { left: 0, top: 100, right: 200, bottom: 160 } };
      await h.tap.executeAndroidTap("tap", { x: 100, y: 130 }, 0, element, {});
      // The existing retry seam refreshes its evidence before deciding whether
      // to dispatch again. Supply the real post-tap waiter, not a scripted verdict.
      await h.tap.retryTapIfNoChange(
        hierarchyFingerprint(h.current.viewHierarchy ?? null),
        { x: 100, y: 130 },
        "tap",
        0,
        {
          tapElement: element,
          options: {
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
          isTalkBackEnabled: false,
          screenSize: h.current.screenSize,
        },
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
