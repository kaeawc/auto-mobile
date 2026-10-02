import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { ObserveResult } from "../../../../src/models";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeElementFinder } from "../../../fakes/FakeElementFinder";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../../fakes/FakeTimer";

describe("SwipeOn cached freshness for scrollable discovery", () => {
  let observe: FakeObserveScreen;
  let finder: FakeElementFinder;
  let swipe: SwipeOn;
  let restoreClient: ReturnType<typeof spyOn>;

  const observation = (isFresh?: boolean): ObserveResult => ({
    timestamp: 1000,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { hierarchy: {} },
    freshness: isFresh === undefined ? undefined : { isFresh },
  });

  beforeEach(() => {
    restoreClient = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      new FakeCtrlProxy() as unknown as AndroidCtrlProxyClient,
    );
    observe = new FakeObserveScreen();
    finder = new FakeElementFinder();
    swipe = new SwipeOn(
      { name: "swipe-freshness", platform: "android", deviceId: "swipe-freshness" },
      null,
      {
        observeScreen: observe,
        finder,
        timer: new FakeTimer(),
        executeGesture: new FakeGestureExecutor(),
      },
    );
    // Stop at the action boundary: discovery uses the real getScrollableContext,
    // while gesture dispatch and post-action observation are outside this test.
    spyOn(swipe, "observedInteraction").mockResolvedValue({ success: true });
  });

  afterEach(() => restoreClient.mockRestore());

  for (const isFresh of [false, true, undefined]) {
    test(`scrollable selection uses the correct hierarchy when isFresh=${isFresh}`, async () => {
      const cached = observation(isFresh);
      const fresh = observation(true);
      observe.setObserveSequence([cached, fresh]);
      const find = spyOn(finder, "findScrollableElements");

      const result = await swipe.execute({ direction: "up" });

      expect(result.success).toBe(true);
      expect(find).toHaveBeenCalledTimes(1);
      expect(find.mock.calls[0][0]).toBe(
        isFresh === false ? fresh.viewHierarchy : cached.viewHierarchy,
      );
      expect(observe.getExecuteOptions().map((options) => options.freshness)).toEqual(
        isFresh === false ? ["fresh"] : [],
      );
    });
  }

  for (const error of [false, true]) {
    test(`unavailable stale refetch selects screen swipe (hierarchy error=${error})`, async () => {
      const fresh = observation(true);
      fresh.viewHierarchy = error ? { hierarchy: { error: "unavailable" } } : null;
      observe.setObserveSequence([observation(false), fresh]);
      const find = spyOn(finder, "findScrollableElements");

      const result = await swipe.execute({ direction: "up" });

      expect(result.success).toBe(true);
      expect(find).not.toHaveBeenCalled();
      expect(observe.getExecuteOptions().map((options) => options.freshness)).toEqual(["fresh"]);
    });
  }
});
