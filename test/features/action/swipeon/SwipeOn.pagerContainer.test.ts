import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  HierarchyDelegateContext,
} from "../../../../src/features/observe/android/types";
import type { ObserveResult, SwipeOnOptions } from "../../../../src/models";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";
import type { AdbClient } from "../../../../src/utils/android-cmdline-tools/AdbClient";
import launcherHome from "../../../fixtures/android-launcher/launcher-home-emulator-5602.json";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeAwaitIdle } from "../../../fakes/FakeAwaitIdle";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWindow } from "../../../fakes/FakeWindow";
import {
  capturedFloatingCoverHierarchy,
  observationOf,
} from "../../../helpers/prototypeWindowCapture";

// A page inside a pager (#10752). The captured Pixel launcher home has the `smartspace_card_pager`
// ViewPager (horizontal, no scrollable flag) whose page is `base_template_card_with_date`, inside
// the scrollable `workspace`. Swiping with the page as the container must act on the pager.

const PAGER = "com.google.android.apps.nexuslauncher:id/smartspace_card_pager";
const PAGE = "com.google.android.apps.nexuslauncher:id/base_template_card_with_date";
const WORKSPACE = "com.google.android.apps.nexuslauncher:id/workspace";
const SCREEN = { width: 2076, height: 2152 };

function launcherHierarchy(): ViewHierarchyResult {
  return new CtrlProxyHierarchy({
    timer: new FakeTimer(),
  } as HierarchyDelegateContext).convertToViewHierarchyResult(
    JSON.parse(launcherHome.rawViewHierarchy.json) as AccessibilityHierarchy,
  );
}

function harness(
  viewHierarchy: ViewHierarchyResult = launcherHierarchy(),
  screenSize: ObserveResult["screenSize"] = SCREEN,
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
    new FakeCtrlProxy(timer) as unknown as AndroidCtrlProxyClient,
  );
  const observation: ObserveResult = {
    ...observationOf(viewHierarchy),
    timestamp: 0,
    freshness: { isFresh: true },
    screenSize,
  };
  const observe = new FakeObserveScreen();
  observe.setObserveResult(() => observation);
  const gesture = new FakeGestureExecutor();
  const action = new SwipeOn(
    { name: "fake", platform: "android", deviceId: "pager-swipe" },
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

const swipe = (options: SwipeOnOptions): SwipeOnOptions => options;

afterEach(() => mock.restore());

describe("swipeOn container that is a pager page (#10752)", () => {
  test("a horizontal swipe on the page resolves to the pager ancestor", async () => {
    const { action, gesture } = harness();
    const result = await action.execute(
      swipe({ direction: "left", container: { elementId: PAGE }, autoTarget: false }),
    );

    expect(result.error).toBeUndefined();
    expect(result.element?.["resource-id"]).toBe(PAGER);
    expect(gesture.getSwipeCalls()).toHaveLength(1);
  });

  test("naming the pager itself is unchanged", async () => {
    const { action } = harness();
    const result = await action.execute(
      swipe({ direction: "left", container: { elementId: PAGER }, autoTarget: false }),
    );

    expect(result.error).toBeUndefined();
    expect(result.element?.["resource-id"]).toBe(PAGER);
  });

  test("a direction the pager cannot scroll resolves to the next scrollable ancestor", async () => {
    const { action } = harness();
    const result = await action.execute(
      swipe({ direction: "up", container: { elementId: PAGE }, autoTarget: false }),
    );

    expect(result.error).toBeUndefined();
    expect(result.element?.["resource-id"]).toBe(WORKSPACE);
  });

  test("a plain container promotes to its scrollable ancestor", async () => {
    const { action } = harness();
    const result = await action.execute(
      swipe({
        direction: "left",
        container: {
          elementId: "com.google.android.apps.nexuslauncher:id/search_container_workspace",
        },
        autoTarget: false,
      }),
    );

    expect(result.element?.["resource-id"]).toBe(WORKSPACE);
  });

  test("a container with no scrollable ancestor keeps its own bounds", async () => {
    // The captured floating prototype's `coverBox` has no scrollable ancestor in its window.
    const { action } = harness(capturedFloatingCoverHierarchy(), { width: 1080, height: 2400 });
    const result = await action.execute(
      swipe({ direction: "left", container: { elementId: "coverBox" }, autoTarget: false }),
    );

    expect(result.error).toBeUndefined();
    expect(result.element?.["resource-id"]).toBe("coverBox");
  });
});
