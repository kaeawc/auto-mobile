import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { InputKey } from "../../../src/features/action/InputKey";
import {
  defaultFocusSelectNavigator,
  ExploreElementActions,
} from "../../../src/features/navigation/ExploreElementActions";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import type { FocusNavigateOptions } from "../../../src/features/action/FocusNavigate";
import { Explore } from "../../../src/features/navigation/Explore";
import type { ExploreResult } from "../../../src/features/navigation/ExploreTypes";
import type { ObserveScreenExecuteOptions } from "../../../src/features/observe/interfaces/ObserveScreen";
import type { BootedDevice, Element, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeNavigationGraphManager } from "../../fakes/FakeNavigationGraphManager";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createObserveResultForTest } from "../observe/flatHierarchyBuilders";
import { createHierarchyForTest } from "../observe/observeScreenTestBuilders";

const APP = "com.example.tv";
const device: BootedDevice = { deviceId: "emulator-5554", name: "TV", platform: "android" };

interface Tile {
  id: string;
  text: string;
  scrollable?: boolean;
}

/** Hand-written TV screens: each tile is a focusable row; `leadsTo` is where selecting it goes. */
const SCREENS: Record<string, { tiles: Tile[]; leadsTo: Record<string, string> }> = {
  Home: {
    tiles: [
      { id: "app:id/movies", text: "Movies" },
      { id: "app:id/settings", text: "Settings" },
    ],
    leadsTo: { "app:id/movies": "Movies", "app:id/settings": "Settings" },
  },
  Movies: { tiles: [{ id: "app:id/play", text: "Play" }], leadsTo: {} },
  Settings: { tiles: [], leadsTo: {} },
  Rails: { tiles: [{ id: "app:id/rail", text: "Rail", scrollable: true }], leadsTo: {} },
};

function observationOf(screen: string): ObserveResult {
  const node = SCREENS[screen].tiles.map((tile, index) => ({
    $: {
      class: "android.widget.FrameLayout",
      text: tile.text,
      "resource-id": tile.id,
      clickable: "true",
      focusable: "true",
      enabled: "true",
      scrollable: tile.scrollable ? "true" : "false",
      bounds: `[0,${index * 100}][400,${index * 100 + 100}]`,
    },
  }));
  return createObserveResultForTest({
    viewHierarchy: createHierarchyForTest({ hierarchy: { node }, packageName: APP }),
  });
}

/** A fake TV: observing shows the current screen; a D-pad select moves to the tile's screen. */
class FakeTvApp extends FakeObserveScreen {
  screen = "Home";
  readonly selections: FocusNavigateOptions[] = [];

  constructor(
    private readonly graph: FakeNavigationGraphManager,
    private readonly timer: FakeTimer,
  ) {
    super();
  }

  override async execute(_options?: ObserveScreenExecuteOptions): Promise<ObserveResult> {
    return observationOf(this.screen);
  }

  override async getMostRecentCachedObserveResult(): Promise<ObserveResult> {
    return observationOf(this.screen);
  }

  async navigateTo(screen: string): Promise<void> {
    this.screen = screen;
    await this.graph.recordNavigationEvent({
      destination: screen,
      source: "TEST",
      arguments: {},
      metadata: {},
      timestamp: this.timer.now(),
      sequenceNumber: 0,
      applicationId: APP,
    });
  }

  async select(options: FocusNavigateOptions) {
    this.selections.push(options);
    const id = options.until.elementId ?? options.until.resourceId;
    const next = id ? SCREENS[this.screen].leadsTo[id] : undefined;
    if (next && options.select) {
      await this.navigateTo(next);
    }
    return {
      success: next !== undefined,
      status: next !== undefined ? ("focused" as const) : ("stuck" as const),
      steps: 1,
      path: [],
      selected: next !== undefined,
      ...(next !== undefined ? {} : { message: "Focus did not move" }),
    };
  }
}

describe("Explore on a focus-driven TV app", () => {
  let graph: FakeNavigationGraphManager;
  let timer: FakeTimer;
  let tv: FakeTvApp;

  beforeEach(async () => {
    graph = new FakeNavigationGraphManager();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    graph.setCurrentAppId(APP);
    tv = new FakeTvApp(graph, timer);
    await tv.navigateTo("Home");
  });

  function exploreWith(inputMode: "touch" | "dpad"): Explore {
    const explore = new Explore(device, new FakeAdbExecutor(), timer, {
      navigationManager: graph,
      inputMode: async () => inputMode,
      focusNavigatorFactory: () => ({ execute: (options) => tv.select(options) }),
    });
    explore.observeScreen = tv;
    return explore;
  }

  test("selects with D-pad focus and records the transition as a replayable focusNavigate", async () => {
    const explore = exploreWith("dpad");
    const result = (await explore.execute({
      packageName: APP,
      maxInteractions: 1,
    })) as ExploreResult;

    expect(result.interactionsPerformed).toBe(1);
    expect(tv.selections).toHaveLength(1);
    const [selection] = tv.selections;
    expect(selection.select).toBe(true);
    // The walk is pinned to the element tapOn would tap, so a focused parent row cannot stand in.
    expect(selection.firstMatch).toBe(true);
    expect(selection.pinTarget).toBeDefined();
    const { edges } = await graph.exportGraph();
    const edge = edges.find((e) => e.from === "Home");
    expect(edge?.to).toBe(tv.screen);
    expect(edge?.interaction?.toolName).toBe("focusNavigate");
    expect(edge?.interaction?.args).toEqual({ until: selection.until, select: true });
  });

  test("settles after a successful select while the record is still live", async () => {
    const explore = exploreWith("dpad");
    const element: Element = {
      bounds: { left: 0, top: 0, right: 400, bottom: 100 },
      text: "Movies",
      "resource-id": "app:id/movies",
      clickable: true,
    };
    const before = timer.now();
    expect(await explore.performInteraction(element, observationOf("Home"))).toBe(true);
    expect(timer.now() - before).toBeGreaterThanOrEqual(1000);
  });

  test("a failed focus walk is not an interaction and records no transition", async () => {
    const explore = exploreWith("dpad");
    const element: Element = {
      bounds: { left: 0, top: 0, right: 400, bottom: 100 },
      text: "Play",
      "resource-id": "app:id/play",
      clickable: true,
    };
    expect(await explore.performInteraction(element, observationOf("Home"))).toBe(false);
    expect((await graph.exportGraph()).edges).toEqual([]);
  });

  test("does not swipe a scrollable container in D-pad mode", async () => {
    const explore = exploreWith("dpad");
    const row: Element = {
      bounds: { left: 0, top: 0, right: 400, bottom: 100 },
      "resource-id": "app:id/row",
      scrollable: true,
    };
    expect(await explore.performInteraction(row, observationOf("Home"))).toBe(false);
    expect(tv.selections).toEqual([]);
  });

  test("validate skips a recorded swipe edge the D-pad cannot replay instead of retrying it", async () => {
    await tv.navigateTo("Rails");
    graph.addEdge({
      from: "Rails",
      to: "Movies",
      edgeType: "tool",
      timestamp: timer.now(),
      interaction: {
        toolName: "swipeOn",
        args: { container: { elementId: "app:id/rail" }, direction: "up", speed: "slow" },
        timestamp: timer.now(),
      },
    });
    const explore = exploreWith("dpad");
    const result = (await explore.execute({
      packageName: APP,
      mode: "validate",
      maxInteractions: 5,
    })) as ExploreResult;

    expect(tv.selections).toEqual([]);
    expect(result.graphTraversal?.edgeValidationResults).toEqual([
      expect.objectContaining({ skipped: true }),
    ]);
  });

  test("validate replays a recorded focusNavigate edge by focus on a touch device", async () => {
    graph.addEdge({
      from: "Home",
      to: "Movies",
      edgeType: "tool",
      timestamp: timer.now(),
      interaction: {
        toolName: "focusNavigate",
        args: { until: { resourceId: "app:id/movies" } },
        timestamp: timer.now(),
      },
    });
    const explore = exploreWith("touch");
    let taps = 0;
    explore.tapElement = async () => {
      taps++;
      return true;
    };
    await explore.execute({ packageName: APP, mode: "validate", maxInteractions: 3 });

    expect(taps).toBe(0);
    expect(tv.selections[0]).toMatchObject({
      until: { resourceId: "app:id/movies" },
      select: false,
    });
  });

  test("touch mode never drives the D-pad", async () => {
    const explore = exploreWith("touch");
    explore.tapElement = async () => true;
    expect(
      await explore.performInteraction(
        { bounds: { left: 0, top: 0, right: 400, bottom: 100 }, "resource-id": "app:id/movies" },
        observationOf("Home"),
      ),
    ).toBe(true);
    expect(tv.selections).toEqual([]);
  });

  test("validate replays a recorded focusNavigate target instead of rebuilding one", async () => {
    const recorded = {
      until: { resourceId: "app:id/movies", text: "Movies" },
      select: true,
      direction: "down",
      maxSteps: 7,
    };
    const actions = new ExploreElementActions({
      device,
      adb: undefined,
      timer,
      focusNavigator: () => ({ execute: (options) => tv.select(options) }),
      runRecorded: (_toolName, _args, _observation, run) => run(),
    });
    const element: Element = {
      bounds: { left: 0, top: 0, right: 400, bottom: 100 },
      "resource-id": "app:id/movies",
      text: "Movies",
    };
    expect(
      await actions.focusSelectElement(element, observationOf("Home"), {
        recorded: { toolName: "focusNavigate", args: recorded },
      }),
    ).toBe(true);
    expect(tv.selections[0]).toMatchObject({
      until: recorded.until,
      select: true,
      direction: "down",
      maxSteps: 7,
    });
  });
});

test("validate keeps a recorded focusNavigate that did not select from pressing enter", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const selections: FocusNavigateOptions[] = [];
  const actions = new ExploreElementActions({
    device,
    adb: undefined,
    timer,
    focusNavigator: () => ({
      execute: async (options) => {
        selections.push(options);
        return { success: true, status: "focused", steps: 1, path: [], message: "focused" };
      },
    }),
    runRecorded: (_toolName, _args, _observation, run) => run(),
  });
  const element: Element = {
    bounds: { left: 0, top: 0, right: 400, bottom: 100 },
    "resource-id": "app:id/movies",
  };
  // Recorded from a public call that changed screen on focus alone.
  const recorded = { until: { resourceId: "app:id/movies" }, direction: "right" };

  expect(
    await actions.focusSelectElement(element, observationOf("Home"), {
      recorded: { toolName: "focusNavigate", args: recorded },
    }),
  ).toBe(true);
  expect(selections[0]).toMatchObject({ until: recorded.until, select: false, direction: "right" });
});

test("validate replays a recorded focus walk that targets a scrollable container", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const selections: FocusNavigateOptions[] = [];
  const actions = new ExploreElementActions({
    device,
    adb: undefined,
    timer,
    focusNavigator: () => ({
      execute: async (options) => {
        selections.push(options);
        return { success: true, status: "focused", steps: 1, path: [], message: "focused" };
      },
    }),
    runRecorded: (_toolName, _args, _observation, run) => run(),
  });
  const rail: Element = {
    bounds: { left: 0, top: 0, right: 400, bottom: 100 },
    "resource-id": "app:id/rail",
    scrollable: true,
  };
  const recorded = { until: { resourceId: "app:id/rail" } };

  expect(
    await actions.focusSelectElement(rail, observationOf("Rails"), {
      recorded: { toolName: "focusNavigate", args: recorded },
    }),
  ).toBe(true);
  expect(selections[0]).toMatchObject({ until: recorded.until, select: false });
  // A newly discovered scrollable container is still left alone.
  expect(await actions.focusSelectElement(rail, observationOf("Rails"))).toBeNull();
});

describe("defaultFocusSelectNavigator", () => {
  test("forwards the abort signal to every D-pad key press", async () => {
    const focused: Element = {
      bounds: { left: 0, top: 0, right: 400, bottom: 100 },
      text: "Movies",
      focused: true,
    };
    const screen = new (class extends FakeObserveScreen {
      override async execute(): Promise<ObserveResult> {
        return { ...observationOf("Home"), focusedElement: focused };
      }
    })();
    const routing: unknown[] = [];
    const press = spyOn(InputKey.prototype, "press").mockImplementation(
      async (key, _timeout, _frame, options) => {
        routing.push(options);
        return { success: true, key, keyCode: key };
      },
    );
    try {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const signal = new AbortController().signal;
      const result = await defaultFocusSelectNavigator(
        device,
        screen,
        new FakeAdbClientFactory(),
        timer,
      ).execute({ until: { text: "Movies" }, select: true, signal });
      expect(result.selected).toBe(true);
      expect(routing).toEqual([{ signal }]);
    } finally {
      press.mockRestore();
    }
  });
});
