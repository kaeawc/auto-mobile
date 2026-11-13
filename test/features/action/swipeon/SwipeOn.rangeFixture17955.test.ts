import type { ObserveResult } from "../../../../src/models/ObserveResult";
import { expect, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { rangeValueChange } from "../../../../src/features/action/rangeValueChange";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import { FeatureFlagService } from "../../../../src/features/featureFlags/FeatureFlagService";
import { tapEffectSchema } from "../../../../src/server/toolOutputSchemas/observationMetadata";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeFeatureFlagApplier } from "../../../fakes/FakeFeatureFlagApplier";
import { FakeFeatureFlagRepository } from "../../../fakes/FakeFeatureFlagRepository";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeScrollableElementsQuery } from "../../../fakes/FakeElementTraitQueries";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { runBlockWithEnvelope } from "../../../helpers/observedInteractionStub";
import { composeControlShapesObservation } from "../../../helpers/composeControlShapesFixture17955";

const sliderId = "readout_less_slider";
const valueChange = {
  before: { current: 0.5, min: 0, max: 1 },
  after: { current: 0.8, min: 0, max: 1 },
};

function target() {
  return new SearchableHierarchy()
    .project(composeControlShapesObservation().viewHierarchy!)
    .find((entry) => entry.nativeId === sliderId)!.element!;
}

async function swipe(capture: "before" | "after") {
  const before = composeControlShapesObservation();
  const after = composeControlShapesObservation(capture);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const gestures = new FakeGestureExecutor();
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(before);
  const action = new SwipeOn(
    { platform: "android", deviceId: "fake-range", name: "Fake" },
    new FakeAdbClient(),
    {
      timer,
      executeGesture: gestures,
      observeScreen,
      scrollables: new FakeScrollableElementsQuery(),
      accessibilityDetector: new FakeAccessibilityDetector(),
      sdkRouteSource: { receivedAtMs: () => undefined, awaitRouteAfter: async () => undefined },
      featureFlags: new FeatureFlagService(
        new FakeFeatureFlagRepository(),
        new FakeFeatureFlagApplier(),
      ),
    },
  );
  action.observedInteraction = runBlockWithEnvelope(before, { observation: after });
  const result = await action.execute({ container: { elementId: sliderId }, direction: "right" });
  expect(gestures.getSwipeCalls()).toHaveLength(1);
  expect(result.success).toBe(true);
  return result;
}

test("swipeOn reports the captured slider changing from 0.5 to 0.8", async () => {
  const result = await swipe("after");
  expect(result.element?.["range-info"]).toBe("current:0.5,min:0.0,max:1.0");
  expect(result.effect).toEqual({
    screenChanged: true,
    basis: "viewHierarchy changed",
    value: valueChange,
  });
  expect(tapEffectSchema.safeParse(result.effect).success).toBe(true);
});

test("an unchanged slider omits effect.value", async () => {
  const result = await swipe("before");
  expect(result.effect?.screenChanged).toBe(false);
  expect(result.effect).not.toHaveProperty("value");
});

test("range matching ignores other ids and refuses missing or invalid numeric state", () => {
  const element = target();
  const after = composeControlShapesObservation("after");
  expect(rangeValueChange(element, after)).toEqual(valueChange);
  expect(
    rangeValueChange({ ...element, "resource-id": "other", "view-id": "other" }, after),
  ).toBeUndefined();
  expect(
    rangeValueChange({ ...element, "range-info": "current:NaN,min:0,max:1" }, after),
  ).toBeUndefined();
  expect(rangeValueChange({ ...element, "range-info": undefined }, after)).toBeUndefined();
  expect(rangeValueChange(element, undefined)).toBeUndefined();
  expect(rangeValueChange(undefined, after)).toBeUndefined();
});

test("duplicate ids use the target bounds and conflicting tree copies omit value", () => {
  const element = target();
  const after = composeControlShapesObservation("after");
  const entries = new SearchableHierarchy()
    .project(after.viewHierarchy!)
    .filter((entry) => entry.nativeId === sliderId);
  Object.assign(entries[0].source, { "range-info": "current:0.9,min:0,max:1" });
  expect(rangeValueChange(element, after)).toBeUndefined();
  const other = {
    ...element,
    "range-info": "current:0.2,min:0,max:1",
    bounds: { left: 0, top: 0, right: 50, bottom: 30 },
  };
  const observation: ObserveResult = {
    ...after,
    viewHierarchy: {
      hierarchy: {
        node: {
          node: [{ $: { ...element, "range-info": "current:0.8,min:0,max:1" } }, { $: other }],
        },
      },
    },
  };
  expect(rangeValueChange(element, observation)).toEqual(valueChange);
});
