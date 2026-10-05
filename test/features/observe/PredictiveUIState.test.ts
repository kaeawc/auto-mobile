import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { PredictiveUIState } from "../../../src/features/observe/PredictiveUIState";
import { PredictionHistoryRepository } from "../../../src/db/predictionHistoryRepository";
import type { Element, ObserveResult } from "../../../src/models";
import type { NavigationEdge } from "../../../src/features/navigation/NavigationGraphManager";
import { FakeElementParser } from "../../fakes/FakeElementParser";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

type Interactable = Parameters<PredictiveUIState["buildTarget"]>[1];
const observation: ObserveResult = { updatedAt: 1, viewHierarchy: { hierarchy: {} } };
const button: Element = { text: "Open", "resource-id": "open", clickable: true };

function edge(toolName: string, args: Record<string, unknown> = {}): NavigationEdge {
  return {
    from: "Home",
    to: "Detail",
    timestamp: 1,
    edgeType: "tool",
    interaction: { toolName, args, timestamp: 1 },
  };
}

describe("PredictiveUIState characterization", () => {
  let harness: InMemoryNavManagerHarness;
  let state: PredictiveUIState;
  let parser: FakeElementParser;
  let currentScreen: ReturnType<typeof spyOn>;
  let currentApp: ReturnType<typeof spyOn>;
  let edges: ReturnType<typeof spyOn>;

  // Migrations initialize the in-memory fixture, not the prediction behavior under test.
  beforeAll(async () => {
    harness = await installInMemoryNavManager();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  beforeEach(async () => {
    await harness.db.deleteFrom("prediction_transition_stats").execute();
    state = new PredictiveUIState();
    state["historyRepository"] = new PredictionHistoryRepository(harness.db);
    parser = new FakeElementParser();
    parser.nextFlattenedElements = [{ element: button, index: 0, depth: 0 }];
    state["elementParser"] = parser;
    currentScreen = spyOn(harness.manager, "getCurrentScreen").mockReturnValue("Home");
    currentApp = spyOn(harness.manager, "getCurrentAppId").mockReturnValue("app");
    edges = spyOn(harness.manager, "getEdgesFrom").mockResolvedValue([
      edge("tapOn", { text: "Open" }),
    ]);
  });

  afterEach(() => {
    currentScreen.mockRestore();
    currentApp.mockRestore();
    edges.mockRestore();
  });

  test("returns no predictions for missing hierarchy, screen, or a different foreground app", async () => {
    expect(await state.generate({ updatedAt: 0 })).toBeUndefined();
    currentScreen.mockReturnValue(null);
    expect(await state.generate(observation)).toBeUndefined();
    currentScreen.mockReturnValue("Home");
    expect(
      await state.generate({
        ...observation,
        activeWindow: { appId: "other", activityName: "Main", layoutSeqSum: 0 },
      }),
    ).toBeUndefined();
    expect(edges).not.toHaveBeenCalled();
  });

  test("returns no predictions for nonactionable edges, absent interactables, or unmatched targets", async () => {
    edges.mockResolvedValue([edge("pressButton")]);
    expect(await state.generate(observation)).toBeUndefined();
    edges.mockResolvedValue([edge("tapOn", { text: "Open" })]);
    parser.nextFlattenedElements = [];
    expect(await state.generate(observation)).toBeUndefined();
    parser.nextFlattenedElements = [{ element: { ...button, text: "Other" }, index: 0, depth: 0 }];
    expect(await state.generate(observation)).toBeUndefined();
  });

  test("deduplicates actions while retaining interactables and destination lookup order", async () => {
    const calls: string[] = [];
    parser.nextFlattenedElements = [
      button,
      button,
      { ...button, text: "Next", "resource-id": "next" },
    ].map((element, index) => ({ element, index, depth: 0 }));
    edges.mockImplementation(async (screen: string) => {
      calls.push(screen);
      return screen === "Home"
        ? [edge("tapOn", { text: "Open" }), edge("tapOn", { text: "Next" })]
        : [
            {
              ...edge("tapOn"),
              interaction: {
                toolName: "tapOn",
                args: {},
                timestamp: 1,
                uiState: {
                  selectedElements: [
                    { text: "Ready" },
                    { resourceId: "done" },
                    { contentDesc: "Ready" },
                    {},
                  ],
                },
              },
            },
          ];
    });
    const result = await state.generate(observation);
    expect(calls).toEqual(["Home", "Detail"]);
    expect(result?.likelyActions).toEqual([
      {
        action: "tapOn",
        target: { text: "Open", elementId: "open", contentDesc: undefined },
        predictedScreen: "Detail",
        predictedElements: ["Ready", "done"],
        confidence: 0.5,
      },
      {
        action: "tapOn",
        target: { text: "Next", elementId: "next", contentDesc: undefined },
        predictedScreen: "Detail",
        predictedElements: ["Ready", "done"],
        confidence: 0.5,
      },
    ]);
    expect(result?.interactableElements).toHaveLength(3);
  });

  test("reads history before destination edges and applies transition-specific confidence", async () => {
    const calls: string[] = [];
    await harness.db
      .insertInto("prediction_transition_stats")
      .values({
        app_id: "app",
        from_screen: "Home",
        to_screen: "Detail",
        tool_name: "tapOn",
        tool_args: '{"text":"Open"}',
        attempts: 100,
        successes: 100,
        total_confidence: 50,
        brier_score_sum: 0,
      })
      .execute();
    const repository = state["historyRepository"];
    const read = repository.getTransitionStatsForScreen.bind(repository);
    const history = spyOn(repository, "getTransitionStatsForScreen").mockImplementation(
      async (...args) => {
        calls.push("history");
        return read(...args);
      },
    );
    edges.mockImplementation(async (screen: string) => {
      calls.push(screen);
      return screen === "Home" ? [edge("tapOn", { text: "Open" })] : [];
    });
    try {
      const result = await state.generate(observation);
      expect(calls).toEqual(["Home", "history", "Detail"]);
      expect(result?.likelyActions[0].confidence).toBe(0.9);
      expect(result?.likelyActions[0].predictedElements).toBeUndefined();
    } finally {
      history.mockRestore();
    }
  });

  test("generates without an app id and skips invalid swipe targets", async () => {
    currentApp.mockReturnValue(null);
    expect((await state.generate(observation))?.likelyActions[0].confidence).toBe(0.5);
    parser.nextFlattenedElements = [{ element: { scrollable: true }, index: 0, depth: 0 }];
    edges.mockResolvedValue([edge("swipeOn", { container: { text: "No match" } })]);
    expect(await state.generate(observation)).toBeUndefined();
  });

  test("tap targets preserve nullish precedence and reject empty identifiers", () => {
    const interactable: Interactable = {
      element: {},
      clickable: true,
      scrollable: false,
      text: "Fallback",
      resourceId: "fallback",
      contentDesc: "Description",
    };
    expect(
      state["buildTarget"](edge("tapOn", { text: "", elementId: "", id: "ignored" }), interactable),
    ).toEqual({ text: "", elementId: "", contentDesc: "Description" });
    expect(state["buildTarget"](edge("tapOn", { id: "legacy" }), interactable)).toEqual({
      text: "Fallback",
      elementId: "legacy",
      contentDesc: "Description",
    });
    expect(
      state["buildTarget"](edge("tapOn"), { element: {}, clickable: true, scrollable: false }),
    ).toBeNull();
    expect(state["buildTarget"](edge("unknown"), interactable)).toBeNull();
    expect(
      state["buildTarget"]({ ...edge("tapOn"), interaction: undefined }, interactable),
    ).toBeNull();
  });

  test("swipe targets retain args precedence, uiState fallbacks, and empty target rejection", () => {
    const interactable: Interactable = { element: {}, clickable: false, scrollable: true };
    const swipe = edge("swipeOn", {
      container: { text: "Args", elementId: "", resourceId: "args-id" },
      lookFor: { contentDesc: "Goal", elementId: "goal-id", resourceId: "ignored" },
    });
    swipe.interaction!.uiState = {
      selectedElements: [],
      scrollPosition: {
        direction: "up",
        container: { text: "Fallback", resourceId: "fallback-id" },
        targetElement: { text: "Target", resourceId: "target-id" },
      },
    };
    expect(state["buildTarget"](swipe, interactable)).toEqual({
      container: { text: "Args", elementId: "args-id", contentDesc: undefined },
      lookFor: { text: undefined, elementId: "goal-id", contentDesc: "Goal" },
    });
    swipe.interaction!.args = {};
    expect(state["buildTarget"](swipe, interactable)).toEqual({
      container: { text: "Fallback", elementId: "fallback-id", contentDesc: undefined },
      lookFor: { text: "Target", elementId: "target-id", contentDesc: undefined },
    });
    expect(
      state["buildTarget"](edge("swipeOn", { lookFor: { text: "Only target" } }), interactable),
    ).toEqual({ lookFor: { text: "Only target", elementId: undefined, contentDesc: undefined } });
    expect(state["buildTarget"](edge("swipeOn", { container: {} }), interactable)).toEqual({
      container: { text: undefined, elementId: undefined, contentDesc: undefined },
    });
    expect(state["buildTarget"](edge("swipeOn"), interactable)).toBeNull();
  });
});
