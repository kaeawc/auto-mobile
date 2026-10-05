import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { ActionableError, type ObserveResult } from "../../../src/models";
import type { AwaitIdle } from "../../../src/features/observe/AwaitIdle";
import type { Window } from "../../../src/features/observe/Window";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

describe("BaseVisualChange cached freshness", () => {
  let instance: BaseVisualChange;
  let observe: FakeObserveScreen;
  let timer: FakeTimer;

  const observation = (freshness?: ObserveResult["freshness"]): ObserveResult => ({
    timestamp: 1000,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { hierarchy: {} },
    freshness,
  });

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    observe = new FakeObserveScreen();
    instance = new BaseVisualChange(
      { name: "cached-freshness", platform: "ios", deviceId: "cached-freshness" },
      new FakeAdbExecutor(),
      timer,
      () => undefined,
      { renderedDisplayGeneration: () => undefined },
    );
    instance.observeScreen = observe;
    instance.awaitIdle = new FakeAwaitIdle() as unknown as AwaitIdle;
    instance.window = new FakeWindow() as unknown as Window;
  });

  afterEach(() => timer.reset());

  const negativeVerdicts: NonNullable<ObserveResult["freshness"]>[] = [
    { isFresh: false, ageMs: 6000, category: "cache_age" },
    { isFresh: false, verified: false, category: "cache_age" },
    { isFresh: false, category: "unavailable" },
  ];

  for (const freshness of negativeVerdicts) {
    test(`refetches once before dispatch for ${JSON.stringify(freshness)}`, async () => {
      const cached = observation(freshness);
      const fresh = observation({ isFresh: true, verified: true });
      observe.setObserveSequence([cached, fresh]);
      const perf = new NoOpPerformanceTracker();
      const signal = new AbortController().signal;
      const queryOptions = { text: "General" };
      let dispatched = 0;

      await instance.observedInteraction(
        async (received) => {
          dispatched++;
          expect(received).toBe(fresh);
          expect(observe.getExecuteOptions()).toEqual([
            { freshness: "fresh", timeoutMs: 2000, display: undefined, queryOptions, perf, signal },
          ]);
          return { success: true };
        },
        { changeExpected: false, queryOptions, perf, signal },
      );

      expect(dispatched).toBe(1);
      // The second execute is the independent post-action observation.
      expect(observe.getExecuteCallCount()).toBe(2);
    });
  }

  for (const freshness of [{ isFresh: true }, undefined]) {
    test(`reuses cached observation with freshness ${JSON.stringify(freshness)}`, async () => {
      const cached = observation(freshness);
      observe.setObserveResult(cached);
      await instance.observedInteraction(
        async (received) => {
          expect(received).toBe(cached);
          expect(observe.getExecuteCallCount()).toBe(0);
          return { success: true };
        },
        { changeExpected: false },
      );
      expect(observe.getExecuteCallCount()).toBe(1);
    });
  }

  for (const failure of ["throws", "missing hierarchy", "errored hierarchy"]) {
    test(`failed stale refetch ${failure} stops dispatch without fallback`, async () => {
      const cached = observation({ isFresh: false });
      const unavailable = observation();
      unavailable.viewHierarchy =
        failure === "errored hierarchy" ? { hierarchy: { error: "capture failed" } } : null;
      observe.setObserveSequence([cached, unavailable]);
      if (failure === "throws") {
        observe.setFailureMode("execute", new Error("capture failed"));
      }
      let dispatched = 0;
      const result = instance.observedInteraction(
        async () => {
          dispatched++;
          return { success: true };
        },
        { changeExpected: false },
      );

      await expect(result).rejects.toBeInstanceOf(ActionableError);
      await expect(result).rejects.toThrow("Cannot perform action without view hierarchy");
      expect(dispatched).toBe(0);
      expect(observe.getExecuteOptions().map((options) => options.freshness)).toEqual(["fresh"]);
    });
  }

  test("refetches an unsettled launch observation before resolving coordinates", async () => {
    const cached = { ...observation({ isFresh: true }), settled: false };
    const fresh = { ...observation({ isFresh: true, verified: true }), settled: true };
    observe.setObserveSequence([cached, fresh]);
    let dispatched = 0;
    await instance.observedInteraction(
      async (received) => {
        dispatched++;
        expect(received).toBe(fresh);
        expect(observe.getExecuteCallCount()).toBe(1);
        return { success: true };
      },
      { changeExpected: false },
    );
    expect(dispatched).toBe(1);
  });

  test("a still-stale fresh read stops dispatch with the freshness warning", async () => {
    const stale = observation({
      isFresh: false,
      category: "window_identity",
      warning: "Wrong foreground app",
    });
    observe.setObserveResult(stale);
    let dispatched = 0;
    const result = instance.observedInteraction(
      async () => {
        dispatched++;
        return { success: true };
      },
      { changeExpected: false },
    );
    await expect(result).rejects.toThrow("Wrong foreground app");
    expect(dispatched).toBe(0);
    expect(observe.getExecuteCallCount()).toBe(1);
    expect(stale.freshness?.isFresh).toBe(false);
  });

  test("hardware navigation can recover a stale window without resolving coordinates", async () => {
    const stale = observation({ isFresh: false, warning: "Wrong foreground app" });
    observe.setObserveResult(stale);
    let dispatched = 0;
    const result = await instance.observedInteraction(
      async () => {
        dispatched++;
        return { success: true };
      },
      { changeExpected: false, usesObservationForResolution: false },
    );
    expect(dispatched).toBe(1);
    expect(result.observation.freshness?.isFresh).toBe(false);
    expect(result.observation.freshness?.warning).toContain("Wrong foreground app");
  });

  test("supplied previous observation bypasses cache even when stale", async () => {
    const supplied = observation({ isFresh: false });
    observe.setObserveResult(observation({ isFresh: true }));
    await instance.observedInteraction(
      async (received) => {
        expect(received).toBe(supplied);
        expect(observe.getGetMostRecentCachedObserveResultCallCount()).toBe(0);
        expect(observe.getExecuteCallCount()).toBe(0);
        return { success: true };
      },
      { changeExpected: false, previousObservation: supplied },
    );
  });

  test("skipPreviousObserve bypasses cache and pre-action execute", async () => {
    observe.setObserveResult(observation({ isFresh: true }));
    await instance.observedInteraction(
      async () => {
        expect(observe.getGetMostRecentCachedObserveResultCallCount()).toBe(0);
        expect(observe.getExecuteCallCount()).toBe(0);
        return { success: true };
      },
      { changeExpected: false, skipPreviousObserve: true },
    );
  });

  test("internal caller fence still refetches unspecified freshness", async () => {
    const fresh = observation({ isFresh: true });
    observe.setObserveSequence([observation(), fresh]);
    await instance.observedInteraction(
      async (received) => {
        expect(received).toBe(fresh);
        expect(observe.getExecuteOptions().map((options) => options.freshness)).toEqual(["fresh"]);
        return { success: true };
      },
      { changeExpected: false, skipCallerDisplayFence: true },
    );
  });
});
