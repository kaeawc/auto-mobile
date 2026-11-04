import { describe, expect, test } from "bun:test";
import type { SkeletonElement, ViewHierarchyResult } from "../../../../src/models";
import {
  findProjectedTextRow,
  withProjectedTextFallback,
} from "../../../../src/features/observe/wait/WaitProjectedText";
import { buildConditionPredicate } from "../../../../src/features/observe/wait/WaitEvaluation";
import type { ConditionSelector } from "../../../../src/features/observe/ConditionPredicates";
import type { WaitForConditionKind } from "../../../../src/features/observe/wait/WaitForSchemas";
import { evaluateWaitForObservation } from "../../../../src/features/observe/wait/WaitPredicates";
import { ObserveElementsBuilder } from "../../../../src/features/observe/ObserveElementsBuilder";
import { ElementResolver } from "../../../../src/features/utility/ElementResolver";
import type { MatchMode } from "../../../../src/features/utility/ElementResolver";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import { createObserveResultForTest } from "../flatHierarchyBuilders";

const screenSize = { width: 400, height: 800 };

const row = (label: string, bounds: SkeletonElement["bounds"], sublabel?: string) => ({
  label,
  bounds,
  affordances: [],
  ...(sublabel === undefined ? {} : { sublabel }),
});

const loadedRow = row("Loaded 95 bytes", [120, 210, 281, 236]);

const hierarchyWith = (nodes: object[]): ViewHierarchyResult => ({
  hierarchy: {
    node: {
      $: { bounds: { left: 0, top: 0, right: 400, bottom: 800 } },
      node: nodes,
    },
  },
  screenWidth: 400,
  screenHeight: 800,
});

const loadButton = {
  $: {
    text: "Load quote",
    "resource-id": "load-quote",
    clickable: "true",
    bounds: { left: 20, top: 100, right: 380, bottom: 160 },
  },
};

describe("findProjectedTextRow", () => {
  test("matches a context row by contains when no row matches exactly", () => {
    const element = findProjectedTextRow(
      { text: "Loaded" },
      { screenSize, skeleton: [], context: [loadedRow] },
    );

    expect(element?.text).toBe("Loaded 95 bytes");
    expect(element?.bounds).toEqual({ left: 120, top: 210, right: 281, bottom: 236 });
  });

  test("searches skeleton rows too", () => {
    const tappable = { ...row("Retry", [0, 0, 100, 40]), affordances: ["tap" as const] };

    expect(
      findProjectedTextRow({ text: "retry" }, { screenSize, skeleton: [tappable] })?.text,
    ).toBe("Retry");
  });

  test("prefers an exact row over an earlier contains row", () => {
    const element = findProjectedTextRow(
      { text: "Loaded" },
      { screenSize, context: [loadedRow, row("Loaded", [0, 300, 100, 340])] },
    );

    expect(element?.bounds.top).toBe(300);
  });

  test("honours textMatch exact and regex", () => {
    const observation = { screenSize, context: [loadedRow] };

    expect(findProjectedTextRow({ text: "Loaded", textMatch: "exact" }, observation)).toBeNull();
    expect(
      findProjectedTextRow({ text: "^loaded \\d+ bytes$", textMatch: "regex" }, observation)?.text,
    ).toBe("Loaded 95 bytes");
  });

  test("matches sublabel text and textAny variants", () => {
    const observation = { screenSize, context: [row("Status", [0, 0, 200, 40], "Done, 3 items")] };

    expect(findProjectedTextRow({ textAny: ["Failed", "3 items"] }, observation)?.text).toBe(
      "Status",
    );
  });

  test("ignores rows with no visible part on screen", () => {
    const offscreen = row("Loaded 95 bytes", [500, 210, 600, 236]);

    expect(
      findProjectedTextRow({ text: "Loaded" }, { screenSize, context: [offscreen] }),
    ).toBeNull();
  });

  test("leaves compound, container and layer waits to the hierarchy search", () => {
    const observation = { screenSize, context: [loadedRow] };

    expect(findProjectedTextRow({ text: "Loaded", elementId: "status" }, observation)).toBeNull();
    expect(
      findProjectedTextRow({ text: "Loaded", container: { elementId: "list" } }, observation),
    ).toBeNull();
    expect(findProjectedTextRow({ text: "Loaded", layer: "app" }, observation)).toBeNull();
    expect(findProjectedTextRow({ elementId: "status" }, observation)).toBeNull();
    expect(
      findProjectedTextRow({ text: "Loaded", selectionStrategy: "unique" }, observation),
    ).toBeNull();
  });

  test("projects collected elements when the observation carries no rows", () => {
    const hierarchy = hierarchyWith([
      loadButton,
      { $: { text: "Loaded 95 bytes", bounds: { left: 120, top: 210, right: 281, bottom: 236 } } },
    ]);
    const elements = new ObserveElementsBuilder().build(hierarchy, "android");

    expect(findProjectedTextRow({ text: "Loaded" }, { screenSize, elements })?.text).toBe(
      "Loaded 95 bytes",
    );
  });
});

describe("evaluateWaitForObservation text over projected rows", () => {
  test("keeps the hierarchy's off-screen verdict over a hoisted row label", () => {
    const hierarchy = hierarchyWith([
      {
        $: { clickable: "true", bounds: { left: 0, top: 0, right: 400, bottom: 900 } },
        node: [{ $: { text: "Loaded", bounds: { left: 0, top: 850, right: 100, bottom: 890 } } }],
      },
    ]);
    const result = evaluateWaitForObservation(
      new ElementResolver(),
      { text: "Loaded" },
      createObserveResultForTest({
        screenSize,
        viewHierarchy: hierarchy,
        elements: new ObserveElementsBuilder().build(hierarchy, "android"),
      }),
      {
        devicePlatform: "android",
        displayInventory: "single",
        modes: new Map<string, MatchMode>(),
        iosMultiPanel: false,
      },
    );

    expect(result.matched).toBe(false);
  });

  const evaluate = (context?: SkeletonElement[]) =>
    evaluateWaitForObservation(
      new ElementResolver(),
      { text: "Loaded" },
      createObserveResultForTest({
        screenSize,
        viewHierarchy: hierarchyWith([loadButton]),
        skeleton: [],
        ...(context === undefined ? {} : { context }),
      }),
      {
        devicePlatform: "ios",
        displayInventory: "single",
        modes: new Map<string, MatchMode>(),
        iosMultiPanel: false,
      },
    );

  test("matches text reported only in context", () => {
    const result = evaluate([loadedRow]);

    expect(result.matched).toBe(true);
    expect(result.awaitedElement?.text).toBe("Loaded 95 bytes");
  });

  test("does not match when neither the hierarchy nor the rows carry the text", () => {
    expect(evaluate().matched).toBe(false);
  });
});

describe("withProjectedTextFallback (for: appear / textEquals)", () => {
  const observe = (nodes: object[], context: SkeletonElement[] = [loadedRow]) =>
    createObserveResultForTest({
      screenSize,
      viewHierarchy: hierarchyWith(nodes),
      skeleton: [],
      context,
    });

  const condition = (
    kind: WaitForConditionKind,
    selector: ConditionSelector,
    options?: { layer?: unknown },
  ) =>
    withProjectedTextFallback(
      kind,
      selector,
      buildConditionPredicate(new ElementResolver(), kind, selector),
      options,
    );

  test("appear matches text reported only in context", () => {
    const result = condition("appear", { text: "Loaded" })(observe([loadButton]));

    expect(result.matched).toBe(true);
    expect(result.matchedElement?.text).toBe("Loaded 95 bytes");
  });

  test("appear does not match when neither the hierarchy nor the rows carry the text", () => {
    expect(condition("appear", { text: "Loaded" })(observe([loadButton], [])).matched).toBe(false);
  });

  test("textEquals matches a row only on the exact, case-sensitive value", () => {
    const observation = observe([loadButton]);

    expect(condition("textEquals", { text: "Loaded 95 bytes" })(observation).matched).toBe(true);
    expect(condition("textEquals", { text: "Loaded" })(observation).matched).toBe(false);
    expect(condition("textEquals", { text: "loaded 95 bytes" })(observation).matched).toBe(false);
  });

  test("keeps the hierarchy's verdict when a hierarchy node carries the text", () => {
    const missed = () => ({ matched: false, candidates: [] });
    const statusNode = {
      $: { text: "Loaded 95 bytes", bounds: { left: 0, top: 850, right: 100, bottom: 890 } },
    };
    const observation = observe([statusNode]);

    expect(
      withProjectedTextFallback("appear", { text: "Loaded" }, missed)(observation).matched,
    ).toBe(false);
    expect(
      withProjectedTextFallback("textEquals", { text: "Loaded 95 bytes" }, missed)(observation)
        .matched,
    ).toBe(false);
  });

  test("an off-screen source differing only in whitespace keeps the hierarchy's verdict", () => {
    const hierarchy = hierarchyWith([
      {
        $: { clickable: "true", bounds: { left: 0, top: 0, right: 400, bottom: 900 } },
        node: [{ $: { text: "Loaded ", bounds: { left: 0, top: 850, right: 100, bottom: 890 } } }],
      },
    ]);
    const observation = createObserveResultForTest({
      screenSize,
      viewHierarchy: hierarchy,
      elements: new ObserveElementsBuilder().build(hierarchy, "android"),
    });

    expect(condition("textEquals", { text: "Loaded" })(observation).matched).toBe(false);
  });

  test("an exact text wait keeps the verdict of an off-screen source with repeated inner whitespace", () => {
    const hierarchy = hierarchyWith([
      {
        $: { clickable: "true", bounds: { left: 0, top: 0, right: 400, bottom: 900 } },
        node: [
          {
            $: {
              text: "Loaded  95 bytes",
              bounds: { left: 0, top: 850, right: 100, bottom: 890 },
            },
          },
        ],
      },
    ]);
    const observation = createObserveResultForTest({
      screenSize,
      viewHierarchy: hierarchy,
      elements: new ObserveElementsBuilder().build(hierarchy, "android"),
    });

    expect(
      findProjectedTextRow({ text: "Loaded  95 bytes", textMatch: "exact" }, observation),
    ).toBeNull();
  });

  test("clickable, disappear and scoped waits stay hierarchy-only", () => {
    const observation = observe([loadButton]);

    expect(condition("clickable", { text: "Loaded 95 bytes" })(observation).matched).toBe(false);
    expect(condition("disappear", { text: "Loaded" })(observation).matched).toBe(true);
    expect(condition("appear", { text: "Loaded", elementId: "status" })(observation).matched).toBe(
      false,
    );
    expect(
      condition("appear", { text: "Loaded", container: { elementId: "list" } })(observation)
        .matched,
    ).toBe(false);
    expect(
      condition("appear", { text: "Loaded", selectionStrategy: "unique" })(observation).matched,
    ).toBe(false);
    expect(condition("appear", { text: "Loaded" }, { layer: "app" })(observation).matched).toBe(
      false,
    );
  });

  test("does not fall back when the hierarchy is unavailable", () => {
    const observation = createObserveResultForTest({ screenSize, context: [loadedRow] });

    expect(condition("appear", { text: "Loaded" })(observation).matched).toBe(false);
  });
});

describe("projected rows with a composite hoisted label (#16987)", () => {
  // A visible alarm row whose own text is the template remainder " Alarm" and whose
  // time child is hoisted into its label; the child sits below the 800px screen.
  const alarmHierarchy = (timeTop: number) =>
    hierarchyWith([
      {
        $: {
          text: " Alarm",
          clickable: "true",
          bounds: { left: 0, top: 0, right: 400, bottom: 900 },
        },
        node: [
          {
            $: {
              text: "7:00",
              bounds: { left: 0, top: timeTop, right: 100, bottom: timeTop + 40 },
            },
          },
        ],
      },
    ]);

  const observationFor = (timeTop: number) => {
    const viewHierarchy = alarmHierarchy(timeTop);
    const elements = new ObserveElementsBuilder().build(viewHierarchy, "android");
    if (!elements) {
      throw new Error("the alarm fixture should yield observe elements");
    }
    const { skeleton, context } = projectSkeleton(elements, screenSize);
    return { screenSize, viewHierarchy, elements, skeleton, context };
  };

  const settings = {
    devicePlatform: "android" as const,
    displayInventory: "single" as const,
    modes: new Map<string, MatchMode>(),
    iosMultiPanel: false,
  };

  test("the projection hoists both sources into one visible row label", () => {
    expect(observationFor(850).skeleton.map((entry) => entry.label)).toEqual(["7:00 Alarm"]);
  });

  test("skips a row whose hoisted label includes an off-screen source", () => {
    const observation = observationFor(850);

    expect(findProjectedTextRow({ text: "7:00 Alarm" }, observation)).toBeNull();
    expect(
      findProjectedTextRow({ text: "7:00 Alarm", textMatch: "exact" }, observation),
    ).toBeNull();
    expect(
      findProjectedTextRow({ text: "^7:00 alarm$", textMatch: "regex" }, observation),
    ).toBeNull();
  });

  test("skips it when the rows are projected from elements during the wait", () => {
    const { viewHierarchy, elements } = observationFor(850);

    expect(
      findProjectedTextRow({ text: "7:00 Alarm" }, { screenSize, viewHierarchy, elements }),
    ).toBeNull();
  });

  test("plain and textEquals waits do not match the partly off-screen row", () => {
    const observation = createObserveResultForTest(observationFor(850));

    expect(
      evaluateWaitForObservation(
        new ElementResolver(),
        { text: "7:00 Alarm" },
        observation,
        settings,
      ).matched,
    ).toBe(false);
    expect(
      evaluateWaitForObservation(
        new ElementResolver(),
        { text: "7:00 Alarm", textMatch: "exact" },
        observation,
        settings,
      ).matched,
    ).toBe(false);
  });

  test("for: appear and textEquals conditions do not match the partly off-screen row", () => {
    const missed = () => ({ matched: false, candidates: [] });
    const offScreen = createObserveResultForTest(observationFor(850));
    const onScreen = createObserveResultForTest(observationFor(700));

    for (const kind of ["appear", "textEquals"] as const) {
      const predicate = withProjectedTextFallback(kind, { text: "7:00 Alarm" }, missed);
      expect(predicate(offScreen).matched).toBe(false);
      expect(predicate(onScreen).matched).toBe(true);
    }
  });

  test("still matches the composite row when every source is on screen", () => {
    const observation = observationFor(700);

    expect(findProjectedTextRow({ text: "7:00 Alarm" }, observation)?.text).toBe("7:00 Alarm");
    expect(
      evaluateWaitForObservation(
        new ElementResolver(),
        { text: "7:00 Alarm" },
        createObserveResultForTest(observation),
        settings,
      ).matched,
    ).toBe(true);
  });
});
