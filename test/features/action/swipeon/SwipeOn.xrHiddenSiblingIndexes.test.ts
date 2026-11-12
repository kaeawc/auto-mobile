import { expect, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { ElementResolver } from "../../../../src/features/utility/ElementResolver";
import type { ResolverSnapshot } from "../../../../src/features/utility/ElementResolverTypes";
import { recordObservationRead } from "../../../../src/features/observe/observationReadScope";
import type { ObserveResult, ViewHierarchyNode } from "../../../../src/models";
import { DEFAULT_VISION_CONFIG } from "../../../../src/vision";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeAndroidXrDetector } from "../../../fakes/FakeAndroidXrDetector";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { buildObserveResult } from "../../../helpers/observeFixture";
import { runBlockWithEnvelope } from "../../../helpers/observedInteractionStub";

const device = { name: "fake", platform: "android", deviceId: "fake-xr-hidden-sibling" } as const;

/** Real captures put `visible-to-user` on the node itself; the model leaves it untyped. */
function node(attributes: ViewHierarchyNode, visible: boolean): ViewHierarchyNode {
  return Object.assign(attributes, { "visible-to-user": visible });
}

/** A hidden sibling precedes a visible vertical list that nests a horizontal carousel (#18084). */
function observation(): ObserveResult {
  const scroller = "androidx.recyclerview.widget.RecyclerView";
  return buildObserveResult({
    updatedAt: 0,
    screenSize: { width: 1000, height: 2000 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: {
      packageName: "com.example.xr",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1000, bottom: 2000 },
          node: [
            node(
              {
                "resource-id": "com.android.systemui:id/hidden_chrome",
                bounds: { left: 0, top: 0, right: 1000, bottom: 100 },
              },
              false,
            ),
            node(
              {
                "resource-id": "com.example.xr:id/list",
                class: scroller,
                scrollable: true,
                bounds: { left: 0, top: 100, right: 1000, bottom: 2000 },
                node: [
                  node(
                    {
                      "resource-id": "com.example.xr:id/carousel",
                      class: scroller,
                      scrollable: true,
                      bounds: { left: 0, top: 200, right: 1000, bottom: 600 },
                      node: [
                        node(
                          {
                            text: "Card 1",
                            bounds: { left: 0, top: 200, right: 400, bottom: 600 },
                          },
                          true,
                        ),
                      ],
                    },
                    true,
                  ),
                ],
              },
              true,
            ),
          ],
        },
      },
    },
  });
}

class RecordingResolver extends ElementResolver {
  readonly scrollSnapshots: ResolverSnapshot[] = [];

  override resolve(...args: Parameters<ElementResolver["resolve"]>) {
    if (args[2].action === "scroll") {
      this.scrollSnapshots.push(args[0]);
    }
    return super.resolve(...args);
  }
}

function setup(xr: boolean) {
  const resolver = new RecordingResolver();
  const observed = observation();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const gesture = new FakeGestureExecutor();
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observed);
  const accessibilityDetector = new FakeAccessibilityDetector();
  accessibilityDetector.setDefaultResult(false, "unknown");
  const swipe = new SwipeOn(device, new FakeAdbClient(), {
    resolver,
    timer,
    observeScreen: observe,
    xrDetector: new FakeAndroidXrDetector(xr),
    executeGesture: gesture,
    accessibilityService: new FakeCtrlProxy(timer),
    accessibilityDetector,
    lastRenderedObservation: () => observed,
    visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
  });
  swipe.observedInteraction = runBlockWithEnvelope(() => recordObservationRead(observed), {
    observation: observed,
  });
  return { swipe, gesture, resolver };
}

for (const xr of [true, false]) {
  test(`scroll search after a hidden sibling keeps ancestry and scrolls the outer list (xr=${xr})`, async () => {
    const { swipe, gesture, resolver } = setup(xr);
    const result = await swipe.execute({
      direction: "up",
      lookFor: { text: "uncaptured item", maxSwipes: 1 },
    });
    expect(result.error).toContain("uncaptured item");
    expect(gesture.getSwipeCalls()).toHaveLength(1);
    const [swipeCall] = gesture.getSwipeCalls();
    // The swipe stays inside the outer list, not the carousel nested in it.
    expect(Math.min(swipeCall!.y1, swipeCall!.y2)).toBeGreaterThanOrEqual(100);
    expect(Math.max(swipeCall!.y1, swipeCall!.y2)).toBeGreaterThan(600);
    // Indexes keep addressing the full projection; XR filtering narrows only the searched list.
    expect(resolver.scrollSnapshots.length).toBeGreaterThan(0);
    for (const snapshot of resolver.scrollSnapshots) {
      expect(snapshot.nodes.map((node) => node.index)).toEqual(snapshot.nodes.map((_, i) => i));
      const searched = (snapshot.searchedNodes ?? snapshot.nodes).map(
        (node) => node.properties["resource-id"],
      );
      expect(searched.includes("com.android.systemui:id/hidden_chrome")).toBe(!xr);
    }
  });
}
