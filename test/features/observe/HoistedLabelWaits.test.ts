import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import { appear, disappear, textEquals } from "../../../src/features/observe/ConditionPredicates";
import { buildConditionPredicate } from "../../../src/features/observe/wait/WaitEvaluation";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";

/**
 * A tappable " Alarm" row on a 400x800 screen whose "7:00" child is hoisted into the
 * row's label ("7:00 Alarm"). The child is placed at `timeTop`; at 850 it is entirely
 * below the screen while the row itself is partly visible (#17007).
 */
function alarmObservation(timeTop: number): ObserveResult {
  return {
    updatedAt: 1,
    screenSize: { width: 400, height: 800 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: {
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 400, bottom: 800 },
          node: [
            {
              text: " Alarm",
              clickable: "true",
              bounds: { left: 0, top: 0, right: 400, bottom: 900 },
              node: [
                {
                  text: "7:00",
                  bounds: { left: 0, top: timeTop, right: 100, bottom: timeTop + 40 },
                },
              ],
            },
          ],
        },
      },
    },
  } as ObserveResult;
}

const offScreen = alarmObservation(850);
const onScreen = alarmObservation(700);

describe("hierarchy waits on a hoisted label with an off-screen source (#17007)", () => {
  test("for: appear does not match the composite label while a source is off screen", () => {
    const predicate = buildConditionPredicate(new ElementResolver(), "appear", {
      text: "7:00 Alarm",
    });

    expect(predicate(offScreen).matched).toBe(false);
  });

  test("appear agrees with textEquals on the partly off-screen row", () => {
    const resolver = new ElementResolver();
    const selector = { text: "7:00 Alarm" };

    expect(appear(resolver, selector)(offScreen).matched).toBe(
      textEquals(resolver, selector, "7:00 Alarm")(offScreen).matched,
    );
  });

  test("appear refuses it for every match mode", () => {
    const resolver = new ElementResolver();

    for (const match of ["contains", "exact"] as const) {
      expect(appear(resolver, { text: "7:00 Alarm", match })(offScreen).matched).toBe(false);
    }
    expect(appear(resolver, { text: "^7:00 alarm$", match: "regex" })(offScreen).matched).toBe(
      false,
    );
  });

  test("disappear treats the partly off-screen composite label as gone", () => {
    const predicate = disappear(new ElementResolver(), { text: "7:00 Alarm" });

    expect(predicate(offScreen).matched).toBe(true);
    expect(predicate(onScreen).matched).toBe(false);
  });

  test("appear still matches the composite label when every source is on screen", () => {
    const evaluation = appear(new ElementResolver(), { text: "7:00 Alarm" })(onScreen);

    expect(evaluation.matched).toBe(true);
    expect(evaluation.matchedElement?.text).toBe(" Alarm");
  });

  test("appear still matches text the visible row carries itself", () => {
    expect(appear(new ElementResolver(), { text: "Alarm" })(offScreen).matched).toBe(true);
  });
});
