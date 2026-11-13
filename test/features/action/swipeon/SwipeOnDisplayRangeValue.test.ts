import { afterEach, expect, mock, test } from "bun:test";
import type { ObserveResult } from "../../../../src/models";
import { harness } from "./displaySwipeHarness";
import { composeControlShapesObservation } from "../../../helpers/composeControlShapesFixture17955";

afterEach(() => mock.restore());

const sliderId = "readout_less_slider";

/** The captured Compose slider at 0.5, then at 0.8 (or unchanged) once a swipe lands. */
function sliderOnDisplay(observation: ObserveResult, capture: "before" | "after"): ObserveResult {
  return {
    ...composeControlShapesObservation(capture),
    display: observation.display,
    insets: observation.insets,
    freshness: observation.freshness,
  };
}

async function displaySwipe(afterSwipe: "before" | "after") {
  const h = harness({
    observationFor: ({ swipes, observation }) =>
      sliderOnDisplay(observation, swipes > 0 ? afterSwipe : "before"),
  });
  const result = await h.action.execute({
    direction: "right",
    display: "external",
    container: { elementId: sliderId },
  });
  expect(h.legs()).toHaveLength(1);
  expect(result.success).toBe(true);
  return result;
}

test("swipeOn with display reports the captured slider changing from 0.5 to 0.8", async () => {
  const result = await displaySwipe("after");
  expect(result.targetType).toBe("element");
  expect(result.element?.["range-info"]).toBe("current:0.5,min:0.0,max:1.0");
  expect(result.effect?.value).toEqual({
    before: { current: 0.5, min: 0, max: 1 },
    after: { current: 0.8, min: 0, max: 1 },
  });
});

test("swipeOn with display omits effect.value when the slider did not move", async () => {
  const result = await displaySwipe("before");
  expect(result.element?.["range-info"]).toBe("current:0.5,min:0.0,max:1.0");
  expect(result.effect).not.toHaveProperty("value");
});
