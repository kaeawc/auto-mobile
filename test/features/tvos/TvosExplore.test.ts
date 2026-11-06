import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  assertTvosExploreOptions,
  createTvosExploreDevice,
  nextFocusStep,
  TVOS_EXPLORE_ACTION_SETTLE_MS,
  TVOS_EXPLORE_MOVE_SETTLE_MS,
  TvosExplore,
} from "../../../src/features/tvos/TvosExplore";
import { tvosRunners } from "../../../src/features/tvos/TvosRunnerRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FocusAwareFakeTvosRunnerClient } from "../../fakes/FocusAwareFakeTvosRunnerClient";
import { tapOnSchema } from "../../../src/server/interactionTools/tapSchemas";
import { pressButtonSchema } from "../../../src/server/interactionTools";
import {
  FakeTvosExploreApp,
  RecordingTvosExploreGraph,
  type RecordedCall,
} from "../../fakes/FakeTvosExploreApp";

const DEVICE = "tv-explore";

/** The selector a recorded tapOn call carries, or an empty one for other calls. */
function selectorOf(call: RecordedCall): { elementId?: unknown; text?: unknown } {
  const selector = call.args.selector;
  return typeof selector === "object" && selector !== null ? selector : {};
}

/** Home has a row of two items; each opens a detail screen with one item. */
function homeApp(): FakeTvosExploreApp {
  return new FakeTvosExploreApp(
    {
      home: [
        { id: "movies", text: "Movies", col: 0, row: 0, opens: "movies" },
        { id: "settings", text: "Settings", col: 1, row: 0, opens: "settings" },
      ],
      movies: [{ id: "play", text: "Play", col: 0, row: 0 }],
      settings: [{ id: "toggle", text: "Toggle", col: 0, row: 0, anonymous: true }],
    },
    "home",
  );
}

function arrange(app = homeApp()) {
  const graph = new RecordingTvosExploreGraph();
  const timer = new FakeTimer();
  return { app, graph, timer, explore: new TvosExplore(app, graph, DEVICE, timer) };
}

describe("TvosExplore", () => {
  test("selects every focusable item, records each screen and returns with menu", async () => {
    const { app, graph, explore } = arrange();
    const result = await explore.execute({});
    expect(graph.events.map((event) => event.destination)).toEqual([
      "tvos-fp-home",
      "tvos-fp-movies",
      "tvos-fp-home",
      "tvos-fp-settings",
      "tvos-fp-home",
    ]);
    expect(graph.edgeCalls.map((call) => call && [call.tool, call.args])).toEqual([
      undefined,
      ["tapOn", { action: "tap", selector: { elementId: "movies" } }],
      ["pressButton", { button: "menu" }],
      ["tapOn", { action: "tap", selector: { elementId: "settings" } }],
      ["pressButton", { button: "menu" }],
    ]);
    expect(graph.calls.every((call) => call.dispatched)).toBe(true);
    expect(graph.events.every((event) => event.applicationId === "com.example.tv")).toBe(true);
    expect(result).toMatchObject({
      success: true,
      interactionsPerformed: 6,
      screensDiscovered: 3,
      edgesAdded: 4,
      coverage: { totalScreens: 3, exploredScreens: 3, percentage: 100 },
      stopReason: "No unexplored focus on the root screen",
    });
    // Focus is re-read after every remote press, plus the initial read.
    expect(app.reads).toBe(app.presses.length + 1);
  });

  test("an item without an identifier replays by text and a no-op select is withdrawn", async () => {
    const { graph, explore } = arrange();
    await explore.execute({});
    const toggle = graph.calls.find((call) => selectorOf(call).text === "Toggle");
    expect(toggle).toMatchObject({ tool: "tapOn", withdrawn: true });
    expect(graph.edgeCalls).not.toContain(toggle);
  });

  test("controls that share a label replay by their distinct identifiers", async () => {
    const app = new FakeTvosExploreApp(
      {
        home: [
          { id: "open-movies", text: "Open", col: 0, row: 0, opens: "movies" },
          { id: "open-shows", text: "Open", col: 1, row: 0, opens: "shows" },
        ],
        movies: [],
        shows: [],
      },
      "home",
    );
    const { graph, explore } = arrange(app);
    await explore.execute({});
    const edges = graph.events.flatMap((event, index) =>
      graph.edgeCalls[index]?.tool === "tapOn"
        ? [[event.destination, graph.edgeCalls[index]!.args]]
        : [],
    );
    expect(edges).toEqual([
      ["tvos-fp-movies", { action: "tap", selector: { elementId: "open-movies" } }],
      ["tvos-fp-shows", { action: "tap", selector: { elementId: "open-shows" } }],
    ]);
  });

  test("every recorded call passes its public tool's input schema", async () => {
    const { graph, explore } = arrange();
    await explore.execute({});
    const schemas = { tapOn: tapOnSchema, pressButton: pressButtonSchema } as const;
    const rejected = graph.calls.filter((call) => {
      const schema = schemas[call.tool as keyof typeof schemas];
      return !schema?.safeParse(call.args).success;
    });
    expect(graph.calls.map((call) => call.tool).sort()).toEqual([
      "pressButton",
      "pressButton",
      "tapOn",
      "tapOn",
      "tapOn",
      "tapOn",
    ]);
    expect(rejected).toEqual([]);
  });

  test("stops at maxInteractions", async () => {
    const { graph, explore } = arrange();
    const result = await explore.execute({ maxInteractions: 1 });
    expect(result).toMatchObject({
      interactionsPerformed: 1,
      stopReason: "Reached maxInteractions (1)",
    });
    expect(graph.events.map((event) => event.destination)).toEqual([
      "tvos-fp-home",
      "tvos-fp-movies",
    ]);
  });

  test("stops at timeoutMs on the injected clock", async () => {
    const { app, explore, timer } = arrange();
    app.afterPress = () => timer.advanceTime(1_000);
    const result = await explore.execute({ timeoutMs: 2_000 });
    expect(result.stopReason).toBe("Reached timeoutMs (2000)");
    expect(app.presses).toHaveLength(2);
  });

  test("refuses when packageName is not in the foreground", async () => {
    const { app, explore } = arrange();
    await expect(explore.execute({ packageName: "com.other.tv" })).rejects.toThrow(
      new ActionableError(
        "com.other.tv is not in the foreground on the Apple TV (found com.example.tv); launch it with launchApp before exploring.",
      ),
    );
    expect(app.presses).toEqual([]);
  });

  test("a select that leaves the app is answered with menu and the crawl continues", async () => {
    const app = new FakeTvosExploreApp(
      {
        home: [
          { id: "external", text: "Open Settings", col: 0, row: 0, opens: "leave" },
          { id: "about", text: "About", col: 1, row: 0, opens: "about" },
        ],
        about: [{ id: "ok", text: "OK", col: 0, row: 0 }],
      },
      "home",
    );
    const { graph, explore } = arrange(app);
    const result = await explore.execute({});
    expect(app.presses.slice(0, 2)).toEqual(["select", "menu"]);
    expect(graph.calls[0]).toMatchObject({ tool: "tapOn", withdrawn: true });
    expect(graph.events.map((event) => event.destination)).toContain("tvos-fp-about");
    expect(result.stopReason).toBe("No unexplored focus on the root screen");
  });

  test("stops when menu cannot bring the app back", async () => {
    const app = new FakeTvosExploreApp(
      { home: [{ id: "external", text: "Open", col: 0, row: 0, opens: "leave" }] },
      "home",
    );
    app.afterPress = (button) => {
      if (button === "menu") {
        app.packageName = "com.apple.TVSettings";
      }
    };
    const result = await arrange(app).explore.execute({});
    expect(result.stopReason).toBe("Left target app (com.apple.TVSettings)");
  });

  test("a long row of items is crawled to the end and the crawl terminates", async () => {
    const items = Array.from({ length: 40 }, (_, col) => ({ id: `item-${col}`, col, row: 0 }));
    const app = new FakeTvosExploreApp({ home: items }, "home");
    const { graph, explore } = arrange(app);
    const result = await explore.execute({});
    expect(graph.calls.map((call) => selectorOf(call).elementId)).toEqual(
      items.map((item) => item.id),
    );
    expect(result).toMatchObject({
      interactionsPerformed: 40,
      stopReason: "No unexplored focus on the root screen",
    });
  });

  test("an aborted signal returns a cancelled partial result", async () => {
    const { app, explore } = arrange();
    const controller = new AbortController();
    app.afterPress = () => controller.abort();
    const result = await explore.execute({}, controller.signal);
    expect(result).toMatchObject({ success: true, cancelled: true, interactionsPerformed: 1 });
  });
});

describe("nextFocusStep", () => {
  test("selects an unselected focus, else tries untried moves, else goes back", () => {
    const moves = new Map([["a", new Map([["right", "b"]] as const)]]);
    expect(nextFocusStep({ moves, selected: new Set() }, "a")).toEqual({ kind: "select" });
    expect(nextFocusStep({ moves, selected: new Set(["a"]) }, "a")).toEqual({
      kind: "move",
      direction: "down",
    });
    const exhausted = new Map(
      ["a", "b"].map((key) => [
        key,
        new Map([
          ["right", "b"],
          ["down", key],
          ["left", "a"],
          ["up", key],
        ] as const),
      ]),
    );
    expect(nextFocusStep({ moves: exhausted, selected: new Set(["a"]) }, "a")).toEqual({
      kind: "move",
      direction: "right",
    });
    expect(nextFocusStep({ moves: exhausted, selected: new Set(["a", "b"]) }, "a")).toEqual({
      kind: "back",
    });
  });
});

describe("assertTvosExploreOptions", () => {
  test("refuses options a focus crawl cannot honour", () => {
    expect(() => assertTvosExploreOptions({ dryRun: true, mode: "validate" })).toThrow(
      "tvOS explore supports only maxInteractions, timeoutMs and packageName; unsupported: mode, dryRun.",
    );
    expect(() => assertTvosExploreOptions({ dryRun: false })).not.toThrow();
  });
});

describe("createTvosExploreDevice", () => {
  let client: FocusAwareFakeTvosRunnerClient;
  let unregister: () => void;
  beforeEach(() => {
    client = new FocusAwareFakeTvosRunnerClient();
    unregister = tvosRunners.register(DEVICE, client);
  });
  afterEach(() => unregister());

  test("reads the focused element and a focus-independent fingerprint", async () => {
    const device = createTvosExploreDevice(DEVICE, new FakeTimer());
    const first = await device.read();
    expect(first.focused?.["resource-id"]).toBe("B01");
    expect(first.packageName).toBe(client.tree.packageName);
    client.focus("B02");
    const second = await device.read();
    expect(second.focused?.["resource-id"]).toBe("B02");
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  test("presses through the runner and settles on the injected timer", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const device = createTvosExploreDevice(DEVICE, timer);
    await device.press("right");
    await device.press("select");
    expect(client.commands).toEqual([
      { type: "request_press_button", action: "right" },
      { type: "request_press_button", action: "select" },
    ]);
    expect(timer.getSleepHistory()).toEqual([
      TVOS_EXPLORE_MOVE_SETTLE_MS,
      TVOS_EXPLORE_ACTION_SETTLE_MS,
    ]);
  });
});
