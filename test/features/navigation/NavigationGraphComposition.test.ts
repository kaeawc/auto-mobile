import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { DefaultPathOptimizer } from "../../../src/features/navigation/DefaultPathOptimizer";
import {
  initializeGraphTraversal,
  markEdgeSkipped,
  resolveEdgeTarget,
  selectNextEdgeToTraverse,
  validateNavigation,
} from "../../../src/features/navigation/ExploreValidateMode";
import { NavigateTo } from "../../../src/features/navigation/NavigateTo";
import type { UIStateSetup } from "../../../src/features/navigation/interfaces/UIStateSetup";
import type { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import type { BootedDevice, Element } from "../../../src/models";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP_ID = "com.example.composition";

type ToolArgs = Record<string, unknown>;

/** The argument shapes Explore records for each action (Explore.ts runRecorded callers). */
const EXPLORE_ARGS: Record<string, ToolArgs> = {
  tapOn: { selector: { text: "Settings" }, action: "tap" },
  tapAt: { x: 540, y: 900, action: "tap" },
  swipeOn: { container: { elementId: "com.example:id/feed" }, direction: "up", speed: "slow" },
};
const BACK_ARGS: ToolArgs = { button: "back" };

/**
 * Cross-feature composition tests on the REAL in-memory NavigationGraphManager:
 * #9989 (explore records tool calls) x #9990 (findPath edge preference),
 * #9992/navback (Back-button BFS) x recorded Back edges, #9991 (validate mode),
 * and the relaunch-root check.
 */
describe("navigation graph composition", () => {
  let harness: InMemoryNavManagerHarness;
  let manager: NavigationGraphManager;
  let sequence = 0;
  let clock = 0;

  beforeEach(async () => {
    harness = await installInMemoryNavManager();
    manager = harness.manager;
    sequence = 0;
    clock = Date.now();
    await manager.setCurrentApp(APP_ID);
  });

  afterEach(async () => {
    await harness.dispose();
  });

  /** Move to `screen`; `tool` (when given) is recorded first so the new edge carries it. */
  async function go(
    screen: string,
    tool?: { name: string; args: ToolArgs },
    depth?: number,
  ): Promise<void> {
    if (tool) {
      manager.recordToolCall(tool.name, tool.args);
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
    if (depth !== undefined) {
      await manager.recordBackStack({ depth, currentTaskId: 1 });
    }
  }

  const back = { name: "pressButton", args: BACK_ARGS };

  describe("explore-recorded edges x findPath preference (#9989 x #9990)", () => {
    for (const toolName of Object.keys(EXPLORE_ARGS)) {
      for (const order of ["older no-tool edge", "newer no-tool edge"] as const) {
        test(`findPath replays the recorded ${toolName} over a ${order} for the same pair`, async () => {
          await go("Home");
          const recordedFirst = order === "newer no-tool edge";
          const noToolEdge = async () => {
            await go("Settings");
            await go("Home");
          };
          const recordedEdge = async () => {
            await go("Settings", { name: toolName, args: EXPLORE_ARGS[toolName] });
            await go("Home");
          };
          await (recordedFirst ? recordedEdge() : noToolEdge());
          await (recordedFirst ? noToolEdge() : recordedEdge());

          const result = await manager.findPath("Settings");

          expect(result.found).toBe(true);
          expect(result.path).toHaveLength(1);
          expect(result.path[0].edgeType).toBe("tool");
          expect(result.path[0].interaction?.toolName).toBe(toolName);
          expect(result.path[0].interaction?.args).toEqual(EXPLORE_ARGS[toolName]);
        });
      }
    }

    test("navigateTo replays the explore-recorded tapOn, not a Back press, for the pair", async () => {
      await go("Home");
      await go("Settings");
      await go("Home");
      await go("Settings", { name: "tapOn", args: EXPLORE_ARGS.tapOn });
      await go("Home");

      ToolRegistry.clearTools();
      const dispatched: unknown[] = [];
      ToolRegistry.register(
        "tapOn",
        "Fake tap",
        z.object({ selector: z.object({ text: z.string() }), action: z.string() }),
        async (args) => {
          dispatched.push(args.selector);
          return { success: true };
        },
      );
      ToolRegistry.register("pressButton", "Fake press", z.object({}), async () => {
        dispatched.push("pressButton");
        return { success: true };
      });
      const noSetup: UIStateSetup = {
        setupUIState: async () => [],
        setupScrollPosition: async () => null,
      };
      const device: BootedDevice = { deviceId: "fake", platform: "ios", name: "Fake" };
      try {
        const result = await new NavigateTo(
          device,
          new FakeAdbClientFactory(),
          noSetup,
          { waitForScreen: async () => true },
          manager,
          new FakeTimer(),
        ).execute({ targetScreen: "Settings", platform: "ios" });

        expect(result.success).toBe(true);
        expect(dispatched).toEqual([{ text: "Settings" }]);
      } finally {
        ToolRegistry.clearTools();
      }
    });
  });

  describe("Back-button BFS in shouldUseBackButton", () => {
    test("is not misled by repeated edge rows for one screen pair", async () => {
      await go("Feed", undefined, 1);
      // Three Feed -> Detail rows (no-tool, tapOn, no-tool) and two Detail -> Settings rows.
      await go("Detail", undefined, 2);
      await go("Feed");
      await go("Detail", { name: "tapOn", args: EXPLORE_ARGS.tapOn });
      await go("Feed");
      await go("Detail", undefined, 2);
      await go("Settings", undefined, 3);
      await go("Detail");
      await go("Settings", { name: "tapOn", args: EXPLORE_ARGS.tapOn }, 3);
      const rows = await harness.db.selectFrom("navigation_edges").selectAll().execute();
      expect(rows.filter((r) => r.from_screen === "Feed" && r.to_screen === "Detail")).toHaveLength(
        3,
      );

      const result = await new DefaultPathOptimizer(manager).shouldUseBackButton(
        "Settings",
        "Feed",
        3,
      );

      // Hop count is by screen, not by edge row: Feed -> Detail -> Settings is two hops.
      expect(result).toMatchObject({ shouldUseBack: true, backPresses: 2 });
      expect(result.reason).toMatch(/matches depth difference/);
    });

    test("a recorded Back edge is not a forward step toward the current screen", async () => {
      // Root(1) -> Feed(2) -> Back -> Root, then Root -> Settings(4) by tap. Walking
      // Feed -Back-> Root -tap-> Settings is two edges, but it climbs the stack first;
      // it is not the route down from Feed, so two Back presses are not justified.
      await go("Root", undefined, 1);
      await go("Feed", { name: "tapOn", args: EXPLORE_ARGS.tapOn }, 2);
      await go("Root", back, 1);
      await go("Settings", { name: "tapOn", args: EXPLORE_ARGS.tapOn }, 4);

      const result = await new DefaultPathOptimizer(manager).shouldUseBackButton(
        "Settings",
        "Feed",
        4,
      );

      expect(result.shouldUseBack).toBe(false);
      expect(result.reason).toMatch(/No known navigation path to verify safety/);
    });

    test("a recorded Back edge A -> B does not make B -> A look like a recorded forward step", async () => {
      // Only the Back press Detail -> Home is known (the screen was entered some
      // other way). From Home (target) there is no forward edge to Detail (current).
      await go("Detail", undefined, 1);
      await go("Home", back, 1);

      const optimizer = new DefaultPathOptimizer(manager);
      const forward = await optimizer.shouldUseBackButton("Detail", "Home", 2);
      expect(forward).toMatchObject({ shouldUseBack: true, backPresses: 1 });
      expect(forward.reason).toMatch(/Depth difference is 1/);

      // The opposite query (Home is the deeper, current screen; Detail the target):
      // Detail's only outgoing edge is the Back press, which must not count as forward.
      await manager.recordBackStack({ depth: 3, currentTaskId: 1 });
      const reverse = await optimizer.shouldUseBackButton("Home", "Detail", 3);
      expect(reverse.shouldUseBack).toBe(false);
      expect(reverse.reason).toMatch(/No known navigation path to verify safety/);
    });

    test("forward tap edges still count when a Back edge exists for the same pair", async () => {
      await go("Feed", undefined, 1);
      await go("Detail", { name: "tapOn", args: EXPLORE_ARGS.tapOn }, 2);
      await go("Feed", back, 1);
      await go("Detail", { name: "tapOn", args: EXPLORE_ARGS.tapOn }, 2);

      const result = await new DefaultPathOptimizer(manager).shouldUseBackButton(
        "Detail",
        "Feed",
        2,
      );

      expect(result).toMatchObject({ shouldUseBack: true, backPresses: 1 });
      expect(result.reason).toMatch(/matches depth difference/);
    });
  });

  describe("validate mode over a mixed graph (#9991)", () => {
    function element(overrides: Partial<Element>): Element {
      return {
        bounds: { left: 0, top: 0, right: 10, bottom: 10 },
        clickable: true,
        enabled: true,
        class: "android.widget.Button",
        ...overrides,
      } as Element;
    }

    const homeElements: Element[] = [
      element({ text: "Settings", "resource-id": "com.example:id/settings" }),
      element({
        text: "",
        "resource-id": "com.example:id/map",
        bounds: { left: 500, top: 850, right: 600, bottom: 950 },
      }),
      element({ text: "", "resource-id": "com.example:id/feed", scrollable: true }),
    ];

    test("reports matched, back, skipped and diverged edges separately", async () => {
      await go("Home");
      await go("Settings", { name: "tapOn", args: EXPLORE_ARGS.tapOn });
      await go("Home", back);
      await go("Map", { name: "tapAt", args: EXPLORE_ARGS.tapAt });
      await go("Home", back);
      await go("Feed", { name: "swipeOn", args: EXPLORE_ARGS.swipeOn });
      await go("Home");
      await go("Legacy");
      await go("Home", back);
      await go("Vanished", {
        name: "tapOn",
        args: { selector: { text: "Vanished" }, action: "tap" },
      });
      await go("Home", back);

      const state = await initializeGraphTraversal(manager);
      expect(state.totalEdgesInGraph).toBe(10);

      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const edges = [...state.pendingEdges.values()];
      const outcome = new Map<string, string>();
      for (const edge of edges) {
        const label = `${edge.from}->${edge.to}`;
        const resolution = resolveEdgeTarget(edge.from === "Home" ? homeElements : [], edge);
        if (resolution.status === "not-validatable") {
          markEdgeSkipped(state, edge, resolution.reason, timer);
          outcome.set(label, "skipped");
        } else if (resolution.status === "not-found") {
          outcome.set(label, "not-found");
        } else {
          // Replay lands on the recorded destination except the tapAt, which diverges.
          const actual = edge.to === "Map" ? "Settings" : edge.to;
          const ok = await validateNavigation(
            edge,
            state,
            { getCurrentScreen: () => actual },
            timer,
            resolution.status === "back" ? 1 : resolution.confidence,
            () => {},
          );
          outcome.set(label, `${resolution.status}:${ok ? "ok" : "diverged"}`);
        }
      }

      expect(Object.fromEntries(outcome)).toEqual({
        "Home->Settings": "matched:ok",
        "Settings->Home": "back:ok",
        "Home->Map": "matched:diverged",
        "Map->Home": "back:ok",
        "Home->Feed": "matched:ok",
        "Feed->Home": "skipped",
        "Home->Legacy": "skipped",
        "Legacy->Home": "back:ok",
        "Home->Vanished": "not-found",
        "Vanished->Home": "back:ok",
      });
      const results = [...state.edgeValidationResults.values()];
      expect(results.filter((r) => r.skipped)).toHaveLength(2);
      expect(results.filter((r) => !r.skipped && r.success)).toHaveLength(6);
      expect(results.filter((r) => !r.skipped && !r.success)).toHaveLength(1);
      // Skipped and validated edges left the pending set; the not-found one did not.
      expect(selectNextEdgeToTraverse(state, "Home")?.to).toBe("Vanished");
      expect(state.traversedEdges.size).toBe(7);
    });
  });
});
