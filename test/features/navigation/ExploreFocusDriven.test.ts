import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { InputKey } from "../../../src/features/action/InputKey";
import {
  defaultFocusSelectNavigator,
  ExploreElementActions,
  type FocusListAdvancer,
} from "../../../src/features/navigation/ExploreElementActions";
import { RevealedListRows } from "../../../src/features/navigation/RevealedListRows";
import { FocusListAdvance } from "../../../src/features/action/FocusListAdvance";
import { createFocusNavigateObserver } from "../../../src/features/action/FocusNavigateObserver";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import {
  FocusNavigate,
  type FocusNavigateOptions,
} from "../../../src/features/action/FocusNavigate";
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

/** For actions that never meet a newly discovered scrollable container. */
const unusedListAdvancer = (): FocusListAdvancer => ({
  execute: async () => {
    throw new Error("no list advance expected");
  },
});

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
  let advances: { container: Element["bounds"] }[];

  beforeEach(async () => {
    advances = [];
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
      focusListAdvancerFactory: () => ({
        execute: async ({ container }) => {
          advances.push({ container });
          return { success: false, status: "stuck", direction: "down", presses: 2, revealed: [] };
        },
      }),
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

  test("advances a scrollable container in D-pad mode instead of swiping or selecting it", async () => {
    const explore = exploreWith("dpad");
    const row: Element = {
      bounds: { left: 0, top: 0, right: 400, bottom: 100 },
      "resource-id": "app:id/row",
      scrollable: true,
    };
    expect(await explore.performInteraction(row, observationOf("Home"))).toBe(false);
    expect(tv.selections).toEqual([]);
    expect(advances).toEqual([{ container: row.bounds }]);
    expect((await graph.exportGraph()).edges).toEqual([]);
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
      focusListAdvancer: unusedListAdvancer,
      revealedRows: new RevealedListRows(),
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
    focusListAdvancer: unusedListAdvancer,
    revealedRows: new RevealedListRows(),
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
  const advanced: Element["bounds"][] = [];
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
    focusListAdvancer: () => ({
      execute: async ({ container }) => {
        advanced.push(container);
        return {
          success: true,
          status: "revealed",
          direction: "right",
          presses: 4,
          revealed: ["app:id/tile|Show 5|"],
        };
      },
    }),
    revealedRows: new RevealedListRows(),
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
  expect(advanced).toEqual([]);
  // A newly discovered scrollable container is advanced through, not selected.
  expect(await actions.focusSelectElement(rail, observationOf("Rails"))).toBe(true);
  expect(advanced).toEqual([rail.bounds]);
  expect(selections).toHaveLength(1);
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

/**
 * A virtualized TV list screen: five items, three rows in the hierarchy at a time. Only pressing
 * down past the last visible row scrolls the window, so items 3 and 4 appear only on advance.
 */
class FakeTvListScreen extends FakeObserveScreen {
  first = 0;
  focus = 0;
  readonly presses: InputKeyName[] = [];
  private static readonly COUNT = 5;
  private static readonly VISIBLE = 3;

  private rowNode(index: number) {
    const top = 100 + (index - this.first) * 100;
    return {
      $: {
        class: "android.widget.FrameLayout",
        text: `Item ${index}`,
        "resource-id": `app:id/item_${index}`,
        clickable: "true",
        focusable: "true",
        enabled: "true",
        focused: index === this.focus ? "true" : "false",
        bounds: `[0,${top}][400,${top + 100}]`,
      },
    };
  }

  private observation(): ObserveResult {
    const rows = Array.from({ length: FakeTvListScreen.VISIBLE }, (_, offset) =>
      this.rowNode(this.first + offset),
    );
    const list = {
      $: {
        class: "androidx.recyclerview.widget.RecyclerView",
        "resource-id": "app:id/list",
        scrollable: "true",
        focusable: "false",
        enabled: "true",
        bounds: "[0,100][400,400]",
      },
      node: rows,
    };
    return createObserveResultForTest({
      viewHierarchy: createHierarchyForTest({ hierarchy: { node: list }, packageName: APP }),
    });
  }

  override async execute(_options?: ObserveScreenExecuteOptions): Promise<ObserveResult> {
    return this.observation();
  }

  override async getMostRecentCachedObserveResult(): Promise<ObserveResult> {
    return this.observation();
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.presses.push(key);
    if (key === "arrow_down" && this.focus < FakeTvListScreen.COUNT - 1) {
      this.focus += 1;
      if (this.focus >= this.first + FakeTvListScreen.VISIBLE) {
        this.first += 1;
      }
    }
    return { success: true };
  }
}

describe("Explore through a TV list that reveals rows only on D-pad advance", () => {
  test("advances the list and then selects a row that was not on the first screen", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const graph = new FakeNavigationGraphManager();
    graph.setCurrentAppId(APP);
    await graph.recordNavigationEvent({
      destination: "Catalog",
      source: "TEST",
      arguments: {},
      metadata: {},
      timestamp: timer.now(),
      sequenceNumber: 0,
      applicationId: APP,
    });
    const screen = new FakeTvListScreen();
    const selected: string[] = [];
    const explore = new Explore(device, new FakeAdbExecutor(), timer, {
      navigationManager: graph,
      inputMode: async () => "dpad",
      focusNavigatorFactory: () => ({
        execute: async (options) => {
          selected.push(options.until.elementId ?? options.until.label ?? "");
          return { success: true, status: "focused", steps: 0, path: [], selected: true };
        },
      }),
      // The real advance, over the production observer, against the fake list.
      focusListAdvancerFactory: () =>
        new FocusListAdvance(createFocusNavigateObserver(screen), screen, timer),
    });
    explore.observeScreen = screen;

    await explore.execute({ packageName: APP, strategy: "breadth-first", maxInteractions: 8 });

    expect(screen.presses).toContain("arrow_down");
    expect(screen.first).toBeGreaterThan(0);
    // Only an advance puts item 3 in the hierarchy, so selecting it proves the advance revealed it.
    expect(selected).toContain("app:id/item_3");
  });
});

/**
 * A virtualized TV rail: six cards side by side, three in the hierarchy at a time. Only pressing
 * right past the last visible card scrolls the rail, so cards 3 to 5 appear only on advance.
 * Down and left do nothing: the rail is the only focusable row.
 */
class FakeTvRailScreen extends FakeObserveScreen {
  first = 0;
  focus = 0;
  readonly presses: InputKeyName[] = [];
  private static readonly COUNT = 6;
  private static readonly VISIBLE = 3;

  /** Back to the screen's initial viewport, as a fresh arrival on it shows it. */
  reset(): void {
    this.first = 0;
    this.focus = 0;
    this.presses.length = 0;
  }

  private cardNode(index: number) {
    const left = (index - this.first) * 300;
    return {
      $: {
        class: "android.widget.FrameLayout",
        text: `Show ${index}`,
        "resource-id": `app:id/show_${index}`,
        clickable: "true",
        focusable: "true",
        enabled: "true",
        focused: index === this.focus ? "true" : "false",
        bounds: `[${left},100][${left + 300},400]`,
      },
    };
  }

  private observation(): ObserveResult {
    const cards = Array.from({ length: FakeTvRailScreen.VISIBLE }, (_, offset) =>
      this.cardNode(this.first + offset),
    );
    const rail = {
      $: {
        class: "androidx.leanback.widget.HorizontalGridView",
        "resource-id": "app:id/rail",
        scrollable: "true",
        focusable: "false",
        enabled: "true",
        bounds: "[0,100][900,400]",
      },
      node: cards,
    };
    return createObserveResultForTest({
      viewHierarchy: createHierarchyForTest({ hierarchy: { node: rail }, packageName: APP }),
    });
  }

  override async execute(_options?: ObserveScreenExecuteOptions): Promise<ObserveResult> {
    return this.observation();
  }

  override async getMostRecentCachedObserveResult(): Promise<ObserveResult> {
    return this.observation();
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.presses.push(key);
    if (key === "arrow_right" && this.focus < FakeTvRailScreen.COUNT - 1) {
      this.focus += 1;
      if (this.focus >= this.first + FakeTvRailScreen.VISIBLE) {
        this.first += 1;
      }
    }
    return { success: true };
  }
}

describe("Explore through a TV rail that reveals cards only on D-pad advance", () => {
  test("records the walk to a revealed card so it replays from the rail's initial viewport", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const graph = new FakeNavigationGraphManager();
    graph.setCurrentAppId(APP);
    await graph.recordNavigationEvent({
      destination: "Shows",
      source: "TEST",
      arguments: {},
      metadata: {},
      timestamp: timer.now(),
      sequenceNumber: 0,
      applicationId: APP,
    });
    const screen = new FakeTvRailScreen();
    const observer = createFocusNavigateObserver(screen);
    const explore = new Explore(device, new FakeAdbExecutor(), timer, {
      navigationManager: graph,
      inputMode: async () => "dpad",
      // The real walk and advance, over the production observer, against the fake rail.
      focusNavigatorFactory: () => new FocusNavigate(observer, screen, timer),
      focusListAdvancerFactory: () => new FocusListAdvance(observer, screen, timer),
    });
    explore.observeScreen = screen;

    await explore.execute({ packageName: APP, strategy: "breadth-first", maxInteractions: 8 });

    const recorded = Array.from(
      { length: graph.getMethodCallCount("recordToolCall") },
      (_, index) => graph.getMethodCallArgs("recordToolCall", index)!,
    )
      .filter(([toolName]) => toolName === "focusNavigate")
      .map(([, args]) => args as FocusNavigateOptions);
    // Only an advance puts show 3 in the hierarchy, so a walk to it proves the advance revealed it.
    const toRevealed = recorded.find((args) => args.until.elementId === "app:id/show_3");
    expect(toRevealed).toBeDefined();

    // navigateTo replays the edge on a fresh arrival: the rail is back at its first cards.
    screen.reset();
    const replay = await new FocusNavigate(observer, screen, timer).execute(toRevealed!);

    expect(replay.success).toBe(true);
    expect(replay.focusedElement?.resourceId).toBe("app:id/show_3");
    expect(replay.selected).toBe(true);
    expect(screen.presses).toEqual(["arrow_right", "arrow_right", "arrow_right", "enter"]);
  });
});

describe("Explore cancellation in D-pad mode", () => {
  test("a cancel while the input-mode probe is pending ends the run without waiting on it", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const graph = new FakeNavigationGraphManager();
    graph.setCurrentAppId(APP);
    const tv = new FakeTvApp(graph, timer);
    await tv.navigateTo("Home");
    const controller = new AbortController();
    let probes = 0;
    const explore = new Explore(device, new FakeAdbExecutor(), timer, {
      navigationManager: graph,
      // A traits read that never answers: only its adb timeout would end it on a device.
      inputMode: () => {
        probes++;
        controller.abort();
        return new Promise(() => {});
      },
      focusNavigatorFactory: () => ({ execute: (options) => tv.select(options) }),
    });
    explore.observeScreen = tv;

    const result = (await explore.execute(
      { packageName: APP, maxInteractions: 3 },
      undefined,
      controller.signal,
    )) as ExploreResult;

    expect(probes).toBe(1);
    expect(tv.selections).toEqual([]);
    expect(result.interactionsPerformed).toBe(0);
  });
});
