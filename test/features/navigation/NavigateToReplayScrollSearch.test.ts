import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { NavigateTo } from "../../../src/features/navigation/NavigateTo";
import type { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import type { UIStateSetup } from "../../../src/features/navigation/interfaces/UIStateSetup";
import type { ForegroundObserver } from "../../../src/features/navigation/foregroundOverlay";
import {
  isElementNotFoundFailure,
  replayLookForFor,
  SwipeOnReplayScrollSearcher,
  type ReplayScrollSearcher,
  type ReplayScrollSearchOutcome,
  type ReplayScrollSearchRequest,
} from "../../../src/features/navigation/replayScrollSearch";
import {
  ActionableError,
  type BootedDevice,
  type SwipeOnOptions,
  type SwipeOnResult,
} from "../../../src/models";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP_ID = "com.example.replaysearch";
const LINKS_TAP = { selector: { elementId: "demo_links" }, action: "tap" };
const STALE_TAP = { selector: { text: "Stale" }, action: "tap" };

/**
 * A replayed `tapOn` whose target is off screen scrolls it into view through the
 * shared lookFor machinery, bounded in swipes and time (#10154). The scroll search is
 * a fake `ReplayScrollSearcher`; the graph is the real in-memory NavigationGraphManager.
 */
describe("navigateTo replay scroll search (#10154)", () => {
  let harness: InMemoryNavManagerHarness;
  let manager: NavigationGraphManager;
  let timer: FakeTimer;
  let sequence = 0;
  let clock = 0;
  let dispatched: string[];
  /** Taps by selector label that reach Settings; an off-screen target is not one of them. */
  let reachable: Set<string>;
  /** Taps that fail with the given error until the searcher has scrolled them into view. */
  let offscreen: Set<string>;
  let tapFailure: string;
  let tapAdvancesMs: number;
  /** Whether a navigating tap is recorded as a new edge (it would be the newest, preferred one). */
  let recordTaps: boolean;
  let searches: ReplayScrollSearchRequest[];
  let observations: number;
  let observe: () => Promise<Awaited<ReturnType<ForegroundObserver["execute"]>>>;
  let searchOutcome: (request: ReplayScrollSearchRequest) => Promise<ReplayScrollSearchOutcome>;

  const device: BootedDevice = { deviceId: "fake", platform: "android", name: "Fake" };
  const noSetup: UIStateSetup = {
    setupUIState: async () => [],
    setupScrollPosition: async () => null,
  };
  const observer: ForegroundObserver = {
    execute: async () => {
      observations += 1;
      return observe();
    },
  };

  beforeEach(async () => {
    harness = await installInMemoryNavManager();
    manager = harness.manager;
    timer = new FakeTimer();
    sequence = 0;
    clock = Date.now();
    dispatched = [];
    reachable = new Set(["demo_links", "Stale"]);
    offscreen = new Set();
    tapFailure = "Failed to perform tap on element: Element not found with provided elementId 'x'";
    tapAdvancesMs = 0;
    recordTaps = true;
    searches = [];
    observations = 0;
    observe = async () => ({});
    searchOutcome = async (request) => {
      offscreen.delete(request.lookFor.elementId ?? request.lookFor.text ?? "");
      return { found: true };
    };
    await manager.setCurrentApp(APP_ID);
    registerTools();
  });

  afterEach(async () => {
    ToolRegistry.clearTools();
    await harness.dispose();
  });

  async function go(
    screen: string,
    tool?: { name: string; args: Record<string, unknown> },
    uiState?: Parameters<NavigationGraphManager["recordToolCall"]>[2],
  ): Promise<void> {
    if (tool) {
      manager.recordToolCall(tool.name, tool.args, uiState);
    }
    sequence += 1;
    clock += 100;
    await manager.recordNavigationEvent({
      destination: screen,
      source: "",
      arguments: {},
      metadata: {},
      timestamp: clock,
      sequenceNumber: sequence,
      applicationId: APP_ID,
    });
  }

  function registerTools(): void {
    ToolRegistry.clearTools();
    ToolRegistry.register(
      "tapOn",
      "Fake tap",
      z.object({
        selector: z.object({ elementId: z.string().optional(), text: z.string().optional() }),
        action: z.string().optional(),
      }),
      async (args) => {
        const label = args.selector.elementId ?? args.selector.text ?? "";
        dispatched.push(`tapOn:${label}`);
        timer.advanceTime(tapAdvancesMs);
        if (offscreen.has(label)) {
          return { success: false, error: tapFailure };
        }
        if (reachable.has(label)) {
          await go("Settings", recordTaps ? { name: "tapOn", args: { ...args } } : undefined);
        }
        return { success: true };
      },
    );
    ToolRegistry.register(
      "tapAt",
      "Fake tap at",
      z.object({ x: z.number(), y: z.number() }),
      async () => {
        dispatched.push("tapAt");
        await go("Settings");
        return { success: true };
      },
    );
    ToolRegistry.register("pressButton", "Fake press", z.object({}), async () => {
      dispatched.push("pressButton");
      await go("Settings");
      return { success: true };
    });
  }

  const searcher: ReplayScrollSearcher = {
    search: async (request) => {
      searches.push(request);
      return searchOutcome(request);
    },
  };

  function navigate(signal?: AbortSignal) {
    return new NavigateTo(
      device,
      new FakeAdbClientFactory(),
      noSetup,
      { waitForScreen: async (screen) => manager.getCurrentScreen() === screen },
      manager,
      timer,
      undefined,
      undefined,
      () => observer,
      searcher,
    ).execute({ targetScreen: "Settings", platform: "android" }, undefined, signal);
  }

  async function recordLinksEdge(
    uiState?: Parameters<NavigationGraphManager["recordToolCall"]>[2],
  ): Promise<void> {
    await go("Home");
    await go("Settings", { name: "tapOn", args: LINKS_TAP }, uiState);
    await go("Home");
  }

  test("a target that is already visible is tapped without scrolling", async () => {
    await recordLinksEdge();

    const result = await navigate();

    expect(result.success).toBe(true);
    expect(searches).toEqual([]);
    expect(dispatched).toEqual(["tapOn:demo_links"]);
  });

  test("a target below the fold is scrolled into view, then tapped", async () => {
    await recordLinksEdge();
    offscreen.add("demo_links");

    const result = await navigate();

    expect(result.success).toBe(true);
    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({
      lookFor: { elementId: "demo_links" },
      direction: "up",
      maxSwipes: 8,
    });
    expect(searches[0].container).toBeUndefined();
    expect(dispatched).toEqual(["tapOn:demo_links", "tapOn:demo_links"]);
    expect(result.path).toEqual([
      'swipeOn(lookFor: {"elementId":"demo_links"})',
      'tapOn({"selector":{"elementId":"demo_links"},"action":"tap"})',
    ]);
  });

  test("the search runs in the scroll container and direction the edge stored", async () => {
    await recordLinksEdge({
      selectedElements: [],
      scrollPosition: {
        container: { resourceId: "demo_list" },
        targetElement: { resourceId: "demo_links" },
        direction: "left",
      },
    });
    offscreen.add("demo_links");

    const result = await navigate();

    expect(result.success).toBe(true);
    expect(searches[0]).toMatchObject({
      direction: "left",
      container: { elementId: "demo_list" },
    });
  });

  test("the search is bounded by the time left in the navigateTo budget", async () => {
    await recordLinksEdge();
    offscreen.add("demo_links");
    tapAdvancesMs = 25000;

    await navigate();

    expect(searches[0].maxTimeMs).toBe(5000);
  });

  test("a single search is capped at its own maximum when the budget is large", async () => {
    await recordLinksEdge();
    offscreen.add("demo_links");

    await navigate();

    expect(searches[0].maxTimeMs).toBe(10000);
  });

  test("no search starts when the navigateTo budget is already spent", async () => {
    await recordLinksEdge();
    offscreen.add("demo_links");
    tapAdvancesMs = 31000;

    const result = await navigate();

    expect(result.success).toBe(false);
    expect(searches).toEqual([]);
    expect(result.error).toContain("Element not found");
  });

  test("an unreported dialog over the source screen gets no search swipes", async () => {
    await recordLinksEdge();
    offscreen.add("demo_links");
    observe = async () => ({ notificationPermissionDetected: true });

    const result = await navigate();

    expect(result.success).toBe(false);
    expect(searches).toEqual([]);
    expect(dispatched).toEqual(["tapOn:demo_links"]);
    expect(result.error).toContain("Not trying a fallback edge");
    expect(result.error).toContain("a notification permission dialog");
    // The step outcome reuses the pre-search observation instead of observing again.
    expect(observations).toBe(1);
  });

  test("a device that is on a different screen than the edge's source gets no search", async () => {
    await recordLinksEdge();
    offscreen.add("demo_links");
    observe = async () => {
      await go("Elsewhere");
      return {};
    };

    const result = await navigate();

    expect(result.success).toBe(false);
    expect(searches).toEqual([]);
    expect(dispatched).toEqual(["tapOn:demo_links"]);
    expect(result.currentScreen).toBe("Elsewhere");
  });

  test("a confirmed source screen is observed once before its search", async () => {
    await recordLinksEdge();
    offscreen.add("demo_links");

    const result = await navigate();

    expect(result.success).toBe(true);
    expect(observations).toBe(1);
    expect(searches).toHaveLength(1);
  });

  test("searches across steps share a total time cap", async () => {
    const edge = (label: string) => ({ selector: { text: label }, action: "tap" });
    await go("Home");
    await go("Settings", { name: "tapOn", args: STALE_TAP });
    await go("Home");
    for (const label of ["C", "B", "A"]) {
      await go("Settings", { name: "tapOn", args: edge(label) });
      await go("Home");
    }
    for (const label of ["A", "B", "C"]) {
      offscreen.add(label);
    }
    recordTaps = false;
    searchOutcome = async () => {
      timer.advanceTime(10000);
      return { found: false };
    };

    const result = await navigate();

    expect(result.success).toBe(true);
    // 10 s, then what is left of the 15 s total; the third edge gets no search at all.
    expect(searches.map((request) => request.maxTimeMs)).toEqual([10000, 5000]);
    expect(dispatched).toEqual(["tapOn:A", "tapOn:B", "tapOn:C", "tapOn:Stale"]);
  });

  describe("when the bounded search does not find the target", () => {
    beforeEach(async () => {
      // Two tap edges to Settings; the newer one (the preferred row) is off screen.
      await go("Home");
      await go("Settings", { name: "tapOn", args: STALE_TAP });
      await go("Home");
      await go("Settings", { name: "tapOn", args: LINKS_TAP });
      await go("Home");
      offscreen.add("demo_links");
      searchOutcome = async () => ({ found: false, detail: "reached end of container" });
    });

    test("the replay fails and the fallback edge runs", async () => {
      const result = await navigate();

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(searches).toHaveLength(1);
      expect(dispatched).toEqual(["tapOn:demo_links", "tapOn:Stale"]);
    });

    async function firstEdgeSelector(): Promise<unknown> {
      await go("Home");
      return (await manager.findPath("Settings")).path[0].interaction?.args.selector;
    }

    test("one miss does not demote the edge; the second consecutive miss does", async () => {
      recordTaps = false;

      expect((await navigate()).success).toBe(true);
      expect(dispatched).toEqual(["tapOn:demo_links", "tapOn:Stale"]);
      // Once is not proof: it still ranks first, as it works when the list is positioned.
      expect(await firstEdgeSelector()).toEqual({ elementId: "demo_links" });

      expect((await navigate()).success).toBe(true);
      expect(searches).toHaveLength(2);
      // Twice in a row it is ranked last, so later calls stop paying for the search.
      expect(await firstEdgeSelector()).toEqual({ text: "Stale" });
      dispatched = [];
      expect((await navigate()).success).toBe(true);
      expect(searches).toHaveLength(2);
      expect(dispatched).toEqual(["tapOn:Stale"]);
    });

    test("a replay that reaches its target resets the count", async () => {
      recordTaps = false;
      await navigate();
      offscreen.clear();
      expect((await navigate()).success).toBe(true);
      offscreen.add("demo_links");
      await navigate();

      // Two misses in total, but not consecutive: one miss is on the books.
      expect(await firstEdgeSelector()).toEqual({ elementId: "demo_links" });
    });

    test("a failure an earlier call recorded is not erased by a later transient miss", async () => {
      recordTaps = false;
      tapFailure = "tap was rejected by the device";
      await navigate();
      await go("Home");
      const demo = (await manager.getEdgesFrom("Home")).find(
        (edge) => edge.interaction?.args.selector?.elementId === "demo_links",
      );
      expect(demo && manager.hasEdgeReplayFailure(demo)).toBe(true);

      // Now Stale does not navigate, so the failed edge is tried again and misses.
      tapFailure =
        "Failed to perform tap on element: Element not found with provided elementId 'x'";
      reachable.delete("Stale");
      await navigate();

      expect(searches).toHaveLength(1);
      expect(demo && manager.hasEdgeReplayFailure(demo)).toBe(true);
    });

    test("a refused coordinate replay is not counted as a missed search", async () => {
      await manager.clearCurrentGraph();
      await manager.setCurrentApp(APP_ID);
      await go("Home");
      await go("Settings", { name: "tapAt", args: { x: 10, y: 20 } });
      await go("Home");
      await go("Settings", { name: "tapOn", args: LINKS_TAP });
      await go("Home");
      recordTaps = false;

      const result = await navigate();
      await navigate();

      expect(result.success).toBe(false);
      // The list was left scrolled by the failed search: no recorded coordinates are tapped.
      expect(dispatched).not.toContain("tapAt");
      expect(result.error).toContain("Not replaying tapAt");
      const edges = await manager.getEdgesFrom("Home");
      const tapAt = edges.find((edge) => edge.interaction?.toolName === "tapAt");
      expect(tapAt && manager.hasEdgeReplayFailure(tapAt)).toBe(false);
      // The tapOn edge's target was missed twice, so it is demoted; the refused one is not.
      const links = edges.find((edge) => edge.interaction?.toolName === "tapOn");
      expect(links && manager.hasEdgeReplayFailure(links)).toBe(true);
    });

    test("the fallback edge's search looks back the other way, from the scrolled position", async () => {
      offscreen.add("Stale");
      searchOutcome = async (request) => {
        offscreen.delete(request.lookFor.elementId ?? request.lookFor.text ?? "");
        return request.lookFor.text ? { found: true } : { found: false };
      };

      const result = await navigate();

      expect(result.success).toBe(true);
      expect(searches.map((request) => request.direction)).toEqual(["up", "down"]);
    });

    test("the failure names the search that was made", async () => {
      await manager.clearCurrentGraph();
      await manager.setCurrentApp(APP_ID);
      await recordLinksEdge();

      const result = await navigate();

      expect(result.success).toBe(false);
      expect(result.error).toContain("Element not found");
      expect(result.error).toContain("at most 8 swipes");
      expect(result.error).toContain("reached end of container");
    });
  });

  test("a replay that fails for another reason does not scroll, and is remembered", async () => {
    await go("Home");
    await go("Settings", { name: "tapOn", args: STALE_TAP });
    await go("Home");
    await go("Settings", { name: "tapOn", args: LINKS_TAP });
    await go("Home");
    offscreen.add("demo_links");
    tapFailure = "tap was rejected by the device";

    const result = await navigate();

    expect(result.success).toBe(true);
    expect(searches).toEqual([]);
    expect(dispatched).toEqual(["tapOn:demo_links", "tapOn:Stale"]);
    await go("Home");
    const next = await manager.findPath("Settings");
    expect(next.path[0].interaction?.args.selector).toEqual({ text: "Stale" });
  });

  test("cancelling during the search dispatches nothing further", async () => {
    await recordLinksEdge();
    offscreen.add("demo_links");
    const controller = new AbortController();
    searchOutcome = async (request) => {
      // The caller cancels while the search is running; the search then reports success.
      controller.abort();
      offscreen.delete(request.lookFor.elementId ?? "");
      return { found: true };
    };

    await expect(navigate(controller.signal)).rejects.toThrow();

    expect(searches).toHaveLength(1);
    expect(dispatched).toEqual(["tapOn:demo_links"]);
  });

  test("a cancelled signal is never handed a new search", async () => {
    await recordLinksEdge();
    offscreen.add("demo_links");
    const controller = new AbortController();
    controller.abort();

    await expect(navigate(controller.signal)).rejects.toThrow();

    expect(searches).toEqual([]);
    expect(dispatched).toEqual([]);
  });
});

describe("replay scroll search helpers", () => {
  test("selector forms lookFor can express", () => {
    expect(replayLookForFor({ selector: { elementId: "a", text: "b" } })).toEqual({
      elementId: "a",
    });
    expect(replayLookForFor({ selector: { text: "Open Network Test" }, action: "tap" })).toEqual({
      text: "Open Network Test",
    });
    expect(replayLookForFor({ text: "Chat" })).toEqual({ text: "Chat" });
    expect(replayLookForFor({ selector: { testTag: "x" } })).toBeUndefined();
    expect(replayLookForFor({ selector: { text: "" } })).toBeUndefined();
  });

  test("only a missing target is an element-not-found failure", () => {
    expect(
      isElementNotFoundFailure(
        new ActionableError(
          "tapOn failed on android: Failed to perform tap on element: Element not found with provided text 'Open Network Test'",
        ),
      ),
    ).toBe(true);
    expect(
      isElementNotFoundFailure(
        new ActionableError("Container element not found with provided elementId 'list'"),
      ),
    ).toBe(false);
    expect(isElementNotFoundFailure(new Error("Element not found"))).toBe(false);
  });
});

describe("SwipeOnReplayScrollSearcher", () => {
  const device: BootedDevice = { deviceId: "fake", platform: "android", name: "Fake" };
  const request: ReplayScrollSearchRequest = {
    lookFor: { text: "Open Network Test" },
    direction: "up",
    container: { elementId: "demo_list" },
    maxSwipes: 8,
    maxTimeMs: 4000,
  };

  function searcherWith(
    execute: (options: SwipeOnOptions, signal?: AbortSignal) => Promise<unknown>,
  ) {
    const calls: SwipeOnOptions[] = [];
    const swipeOn = {
      execute: async (options: SwipeOnOptions, _progress?: unknown, signal?: AbortSignal) => {
        calls.push(options);
        return (await execute(options, signal)) as SwipeOnResult;
      },
    };
    return { calls, searcher: new SwipeOnReplayScrollSearcher(device, new FakeTimer(), swipeOn) };
  }

  test("runs swipeOn lookFor in the container with the swipe and time limits", async () => {
    const { calls, searcher } = searcherWith(async () => ({ success: true, found: true }));

    expect(await searcher.search(request)).toEqual({ found: true });
    expect(calls).toEqual([
      {
        direction: "up",
        autoTarget: true,
        includeSystemInsets: false,
        container: { elementId: "demo_list" },
        lookFor: { text: "Open Network Test", maxTime: 4000, maxSwipes: 8 },
      },
    ]);
  });

  test("without a stored container it leaves scroll targeting to swipeOn", async () => {
    const { calls, searcher } = searcherWith(async () => ({ success: true, found: true }));

    await searcher.search({ ...request, container: undefined });

    expect(calls[0].container).toBeUndefined();
    expect(calls[0].autoTarget).toBe(true);
  });

  test("a search that ends without the element, or errors as not-found, is found:false", async () => {
    const ended = searcherWith(async () => ({ success: true, found: false, error: "end" }));
    expect(await ended.searcher.search(request)).toEqual({ found: false, detail: "end" });

    const thrown = searcherWith(async () => {
      throw new ActionableError('text "x" not found after scrolling');
    });
    expect(await thrown.searcher.search(request)).toEqual({
      found: false,
      detail: 'text "x" not found after scrolling',
    });
  });

  test("an unexpected error propagates", async () => {
    const { searcher } = searcherWith(async () => {
      throw new Error("device gone");
    });

    await expect(searcher.search(request)).rejects.toThrow("device gone");
  });

  test("cancellation is not reported as a missing element", async () => {
    const controller = new AbortController();
    const { calls, searcher } = searcherWith(async () => {
      controller.abort();
      throw new ActionableError("text not found after scrolling");
    });

    await expect(searcher.search(request, controller.signal)).rejects.toThrow();
    expect(calls).toHaveLength(1);

    await expect(searcher.search(request, controller.signal)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
