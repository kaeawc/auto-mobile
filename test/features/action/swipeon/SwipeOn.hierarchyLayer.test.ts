import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { ObserveResult, SwipeOnOptions } from "../../../../src/models";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";
import type { AdbClient } from "../../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeAwaitIdle } from "../../../fakes/FakeAwaitIdle";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWindow } from "../../../fakes/FakeWindow";
import {
  RELABELLED_CAPTURE,
  capturedFloatingCoverHierarchy,
  capturedPrototypeHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../../../helpers/prototypeWindowCapture";

// Device capture: a floating prototype window 170 [525,1565][1011,1723] (node `coverBox`) over
// the Playground Tap screen, whose scrollable `tap_screen_content` spans [0,652][1080,2064]. See
// test/fixtures/android-overlay-window/README.txt.
const PROTOTYPE_BOUNDS = { left: 525, top: 1565, right: 1011, bottom: 1723 };

function deviceObservation(
  hierarchy: ViewHierarchyResult,
  screenSize: ObserveResult["screenSize"],
): ObserveResult {
  return { ...observationOf(hierarchy), timestamp: 0, freshness: { isFresh: true }, screenSize };
}

/** The prototype captures are 1080x2400; the relabelled Recents capture keeps its own size. */
function harness(
  hierarchy: ViewHierarchyResult = capturedFloatingCoverHierarchy(),
  screenSize: ObserveResult["screenSize"] = { width: 1080, height: 2400 },
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const ctrl = new FakeCtrlProxy(timer);
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
    ctrl as unknown as AndroidCtrlProxyClient,
  );
  const gesture = new FakeGestureExecutor();
  const observe = new FakeObserveScreen();
  const observation = deviceObservation(hierarchy, screenSize);
  observe.setObserveResult(() => observation);
  const action = new SwipeOn(
    { name: "fake", platform: "android", deviceId: "layer-swipe" },
    new FakeAdbClient() as unknown as AdbClient,
    {
      timer,
      observeScreen: observe,
      executeGesture: gesture,
      accessibilityDetector: new FakeAccessibilityDetector(),
    },
  );
  action.awaitIdle = new FakeAwaitIdle() as unknown as typeof action.awaitIdle;
  action.window = new FakeWindow() as unknown as typeof action.window;
  return { action, gesture };
}

const insidePrototype = (point: { x: number; y: number }) =>
  point.x >= PROTOTYPE_BOUNDS.left &&
  point.x < PROTOTYPE_BOUNDS.right &&
  point.y >= PROTOTYPE_BOUNDS.top &&
  point.y < PROTOTYPE_BOUNDS.bottom;

const swipe = (options: SwipeOnOptions): SwipeOnOptions => options;

afterEach(() => mock.restore());

describe("swipeOn layer (#9305)", () => {
  test('"app" excludes prototype nodes from container resolution', async () => {
    const { action, gesture } = harness();
    const result = await action.execute(
      swipe({ direction: "up", container: { elementId: "coverBox" }, layer: "app" }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Element not found with provided elementId 'coverBox'");
    expect(gesture.getSwipeCalls()).toEqual([]);
  });

  test('"app" swipes an app container whose start point is outside the prototype', async () => {
    const { action, gesture } = harness();
    const result = await action.execute(
      swipe({ direction: "up", container: { elementId: "tap_screen_content" }, layer: "app" }),
    );

    expect(result.error).toBeUndefined();
    const [call] = gesture.getSwipeCalls();
    expect(insidePrototype({ x: call.x1, y: call.y1 })).toBe(false);
  });

  test('"app" auto-targets the app scrollable, not a prototype node', async () => {
    const { action, gesture } = harness();
    const result = await action.execute(swipe({ direction: "up", layer: "app" }));

    expect(result.error).toBeUndefined();
    expect(result.element?.bounds).toEqual({ left: 0, top: 652, right: 1080, bottom: 2064 });
    expect(gesture.getSwipeCalls()).toHaveLength(1);
  });

  test('"app" refuses a screen swipe before dispatch when a full-screen prototype covers its start', async () => {
    const { action, gesture } = harness(capturedPrototypeHierarchy({ fullScreen: true }), {
      width: RELABELLED_CAPTURE.screen.right,
      height: RELABELLED_CAPTURE.screen.bottom,
    });
    const result = await action.execute(
      swipe({ direction: "up", autoTarget: false, layer: "app" }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot swipe at");
    expect(result.error).toContain("an AutoMobile prototype window covers that point");
    expect(gesture.getSwipeCalls()).toEqual([]);
  });

  test('"prototype" refuses a screen swipe that starts outside the prototype window', async () => {
    const { action, gesture } = harness();
    const result = await action.execute(swipe({ direction: "up", layer: "prototype" }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("no AutoMobile prototype window covers that point");
    expect(gesture.getSwipeCalls()).toEqual([]);
  });

  test('"prototype" with no prototype showing is an actionable error', async () => {
    const { action, gesture } = harness(capturedTwoWindowHierarchy(), {
      width: RELABELLED_CAPTURE.screen.right,
      height: RELABELLED_CAPTURE.screen.bottom,
    });
    const result = await action.execute(swipe({ direction: "up", layer: "prototype" }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("no AutoMobile prototype is showing");
    expect(gesture.getSwipeCalls()).toEqual([]);
  });

  test('lookFor with "prototype" finds the prototype node without swiping', async () => {
    const { action, gesture } = harness();
    const result = await action.execute(
      swipe({ direction: "up", lookFor: { elementId: "coverBox" }, layer: "prototype" }),
    );

    expect(result).toMatchObject({ success: true, found: true, scrollIterations: 0 });
    expect(gesture.getSwipeCalls()).toEqual([]);
  });

  test('lookFor with "app" never matches the prototype node and scrolls the app container', async () => {
    const { action, gesture } = harness();
    const result = await action.execute(
      swipe({ direction: "up", lookFor: { elementId: "coverBox", maxSwipes: 1 }, layer: "app" }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('element with id "coverBox" not found after scrolling');
    const [call] = gesture.getSwipeCalls();
    expect(insidePrototype({ x: call.x1, y: call.y1 })).toBe(false);
  });

  test("lookFor without layer keeps today's behaviour: the prototype node is found", async () => {
    const { action, gesture } = harness();
    const result = await action.execute(
      swipe({ direction: "up", lookFor: { elementId: "coverBox", maxSwipes: 1 } }),
    );

    expect(result).toMatchObject({ success: true, found: true, scrollIterations: 0 });
    expect(gesture.getSwipeCalls()).toEqual([]);
  });

  for (const layer of [undefined, "prototype"] as const) {
    test(`swipes across a container inside the prototype with layer ${layer ?? "unset"} (#10752)`, async () => {
      const { action, gesture } = harness();
      const result = await action.execute(
        swipe({
          direction: "left",
          container: { elementId: "coverBox" },
          ...(layer ? { layer } : {}),
        }),
      );

      expect(result.error).toBeUndefined();
      expect(result.warning ?? "").not.toContain("Swipe area reduced");
      const [call] = gesture.getSwipeCalls();
      expect(insidePrototype({ x: call.x1, y: call.y1 })).toBe(true);
      expect(insidePrototype({ x: call.x2, y: call.y2 })).toBe(true);
      // The app buttons under the prototype used to leave a 7 px safe width.
      expect(call.x1 - call.x2).toBeGreaterThan(200);
    });
  }

  test("layer with display is refused before any dispatch", async () => {
    const { action, gesture } = harness();
    const result = await action.execute(
      swipe({ direction: "up", display: "default", layer: "app" }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("layer is not supported with `display`");
    expect(gesture.getSwipeCalls()).toEqual([]);
  });
});
