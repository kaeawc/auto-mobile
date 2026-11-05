import { beforeEach, describe, expect, test } from "bun:test";
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
    const next = options.until.resourceId
      ? SCREENS[this.screen].leadsTo[options.until.resourceId]
      : undefined;
    if (next && options.select) {
      await this.navigateTo(next);
    }
    return {
      success: next !== undefined,
      status: next !== undefined ? ("focused" as const) : ("stuck" as const),
      steps: 1,
      path: [],
      ...(next !== undefined ? { selected: true } : { message: "Focus did not move" }),
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
    const { edges } = await graph.exportGraph();
    const edge = edges.find((e) => e.from === "Home");
    expect(edge?.to).toBe(tv.screen);
    expect(edge?.interaction?.toolName).toBe("focusNavigate");
    expect(edge?.interaction?.args).toEqual({ until: selection.until, select: true });
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
});
