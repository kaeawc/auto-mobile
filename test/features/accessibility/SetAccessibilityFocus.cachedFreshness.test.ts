import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SetAccessibilityFocus } from "../../../src/features/accessibility/SetAccessibilityFocus";
import { ActionableError, type ObserveResult } from "../../../src/models";
import { FakeAccessibilityFocusService } from "../../fakes/FakeAccessibilityFocusService";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("SetAccessibilityFocus cached freshness", () => {
  let observe: FakeObserveScreen;
  let service: FakeAccessibilityFocusService;
  let timer: FakeTimer;
  let feature: SetAccessibilityFocus;
  let serviceRequests: number;

  const observation = (
    resourceId: string,
    freshness?: ObserveResult["freshness"],
  ): ObserveResult => ({
    timestamp: timer.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            text: "Settings",
            "resource-id": resourceId,
            bounds: { left: 0, top: 0, right: 200, bottom: 60 },
          },
        },
      },
    },
    freshness,
  });

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    observe = new FakeObserveScreen();
    service = new FakeAccessibilityFocusService();
    serviceRequests = 0;
    feature = new SetAccessibilityFocus(
      { name: "focus-freshness", platform: "android", deviceId: "focus-freshness" },
      {
        observeScreen: observe,
        timer,
        serviceFactory: () => {
          serviceRequests++;
          return service;
        },
      },
    );
  });

  afterEach(() => timer.reset());

  for (const action of ["set", "clear"] as const) {
    const negativeVerdicts: NonNullable<ObserveResult["freshness"]>[] = [
      { isFresh: false, ageMs: 6000, category: "cache_age" },
      { isFresh: false, verified: false, category: "cache_age" },
      { isFresh: false, category: "unavailable" },
    ];

    for (const freshness of negativeVerdicts) {
      test(`${action} refetches once before dispatch for ${JSON.stringify(freshness)}`, async () => {
        const cached = observation("com.example:id/cached", freshness);
        timer.advanceTime(6000);
        const fresh = observation("com.example:id/fresh", { isFresh: true, verified: true });
        observe.setObserveSequence([cached, fresh]);

        const result = await feature.execute({ action, text: "Settings" });

        expect(result.success).toBe(true);
        expect(service.calls).toEqual([{ method: action, resourceId: "com.example:id/fresh" }]);
        expect(observe.getExecuteOptions()).toEqual([{ freshness: "fresh" }]);
        expect(observe.getGetMostRecentCachedObserveResultCallCount()).toBe(1);
      });
    }

    for (const freshness of [{ isFresh: true }, undefined]) {
      test(`${action} reuses cache with freshness ${JSON.stringify(freshness)}`, async () => {
        observe.setObserveResult(observation("com.example:id/cached", freshness));

        const result = await feature.execute({ action, text: "Settings" });

        expect(result.success).toBe(true);
        expect(service.calls).toEqual([{ method: action, resourceId: "com.example:id/cached" }]);
        expect(observe.getExecuteCallCount()).toBe(0);
      });
    }

    for (const failure of ["throws", "missing hierarchy", "errored hierarchy"]) {
      test(`${action} failed stale refetch ${failure} stops dispatch without fallback`, async () => {
        const cached = observation("com.example:id/cached", { isFresh: false });
        const unavailable = observation("com.example:id/fresh", { isFresh: true });
        unavailable.viewHierarchy =
          failure === "errored hierarchy" ? { hierarchy: { error: "capture failed" } } : null;
        observe.setObserveSequence([cached, unavailable]);
        if (failure === "throws") {
          observe.setFailureMode("execute", new Error("capture failed"));
        }

        const result = feature.execute({ action, text: "Settings" });

        await expect(result).rejects.toBeInstanceOf(ActionableError);
        await expect(result).rejects.toThrow(
          "Unable to observe screen to resolve accessibility focus target.",
        );
        expect(service.calls).toEqual([]);
        expect(serviceRequests).toBe(0);
        expect(observe.getExecuteOptions()).toEqual([{ freshness: "fresh" }]);
      });
    }
  }

  for (const error of [false, true]) {
    test(`preserves missing/errored cache fallback (hierarchy error=${error})`, async () => {
      const cached = observation("com.example:id/cached", { isFresh: false });
      cached.viewHierarchy = error ? { hierarchy: { error: "cache unavailable" } } : null;
      observe.setObserveSequence([cached, observation("com.example:id/fresh", { isFresh: true })]);

      await feature.execute({ text: "Settings" });

      expect(service.calls).toEqual([{ method: "set", resourceId: "com.example:id/fresh" }]);
      expect(observe.getExecuteOptions()).toEqual([{}]);
    });
  }
});
