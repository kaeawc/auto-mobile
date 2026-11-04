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

/** An ObserveResult on a 400x800 screen whose root holds `rows`. */
function screenWith(rows: object[]): ObserveResult {
  return {
    updatedAt: 1,
    screenSize: { width: 400, height: 800 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: {
      hierarchy: { node: { bounds: { left: 0, top: 0, right: 400, bottom: 800 }, node: rows } },
    },
  } as ObserveResult;
}

/** A clickable row with `text` whose single child carries `childText` at `childTop`. */
function rowWithChild(
  text: string,
  [top, bottom]: [number, number],
  childText: string,
  childTop: number,
): object {
  return {
    text,
    clickable: "true",
    bounds: { left: 0, top, right: 400, bottom },
    node: [
      { text: childText, bounds: { left: 0, top: childTop, right: 100, bottom: childTop + 40 } },
    ],
  };
}

describe("hoisted-label waits judge every match the resolver found (#17007)", () => {
  test("a second, fully visible composite label still satisfies the wait", () => {
    const observation = screenWith([
      rowWithChild(" Alarm", [700, 900], "7:00", 850),
      rowWithChild(" Alarm", [0, 300], "7:00", 20),
    ]);
    const resolver = new ElementResolver();

    const evaluation = appear(resolver, { text: "7:00 Alarm" })(observation);
    expect(evaluation.matched).toBe(true);
    expect(evaluation.matchedElement?.bounds).toEqual({ left: 0, top: 0, right: 400, bottom: 300 });
    expect(disappear(resolver, { text: "7:00 Alarm" })(observation).matched).toBe(false);
  });

  test("text the row carries itself matches with the resolver's whitespace and regex rules", () => {
    const observation = screenWith([rowWithChild("Alarm   Clock", [0, 900], "7:00", 850)]);
    const resolver = new ElementResolver();

    expect(appear(resolver, { text: "Alarm Clock" })(observation).matched).toBe(true);
    expect(appear(resolver, { text: "alarm clock", match: "exact" })(observation).matched).toBe(
      true,
    );
    expect(
      appear(resolver, { text: "^Alarm\\s+Clock$", match: "regex" })(observation).matched,
    ).toBe(true);
    expect(disappear(resolver, { text: "Alarm Clock" })(observation).matched).toBe(false);
  });
});

describe("only descendants that contribute the matched text are judged (#17007)", () => {
  const observation = screenWith([
    {
      text: " Alarm",
      clickable: "true",
      bounds: { left: 0, top: 0, right: 400, bottom: 900 },
      node: [
        { text: "7:00", bounds: { left: 0, top: 20, right: 100, bottom: 60 } },
        { text: "Edit", bounds: { left: 0, top: 850, right: 100, bottom: 890 } },
      ],
    },
  ]);

  test("an off-screen sublabel child does not reject a label folded from visible children", () => {
    const resolver = new ElementResolver();

    expect(appear(resolver, { text: "7:00 Alarm" })(observation).matched).toBe(true);
    expect(disappear(resolver, { text: "7:00 Alarm" })(observation).matched).toBe(false);
  });
});

describe("visible equivalents of hoisted text still match (#17007)", () => {
  test("the row's trimmed own text matches a regex while a hoisted child is off screen", () => {
    const resolver = new ElementResolver();

    expect(appear(resolver, { text: "^Alarm$", match: "regex" })(offScreen).matched).toBe(true);
    expect(disappear(resolver, { text: "^Alarm$", match: "regex" })(offScreen).matched).toBe(false);
  });

  test("a visible duplicate of an off-screen label part supplies the composed label", () => {
    const observation = screenWith([
      {
        text: " Alarm",
        clickable: "true",
        bounds: { left: 0, top: 0, right: 400, bottom: 900 },
        node: [
          { text: "7:00", bounds: { left: 0, top: 20, right: 100, bottom: 60 } },
          { text: "7:00", bounds: { left: 0, top: 850, right: 100, bottom: 890 } },
        ],
      },
    ]);
    const resolver = new ElementResolver();

    expect(appear(resolver, { text: "7:00 Alarm" })(observation).matched).toBe(true);
    expect(disappear(resolver, { text: "7:00 Alarm" })(observation).matched).toBe(false);
  });
});
