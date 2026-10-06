import { expect, describe, test, beforeEach, afterEach } from "bun:test";
import {
  NavigationGraphManager,
  NavigationEvent,
} from "../../../src/features/navigation/NavigationGraphManager";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

describe("NavigationGraphManager.findPath edge selection (#9990)", () => {
  let harness: InMemoryNavManagerHarness;
  let manager: NavigationGraphManager;

  beforeEach(async () => {
    harness = await installInMemoryNavManager();
    manager = harness.manager;
    await manager.setCurrentApp("com.test.app");
  });

  afterEach(async () => {
    await harness.dispose();
  });

  /** Append `count` more traversal rows of a tool-less transition: the append-only log (#10194). */
  async function insertTraversals(
    count: number,
    from: string,
    to: string,
    firstTimestamp: number,
  ): Promise<void> {
    await harness.db
      .insertInto("navigation_edges")
      .values(
        Array.from({ length: count }, (_, index) => ({
          app_id: "com.test.app",
          from_screen: from,
          to_screen: to,
          tool_name: null,
          tool_args: null,
          timestamp: firstTimestamp + index,
        })),
      )
      .execute();
  }

  test("prefers a later tapOn edge over an earlier edge with no tool call (#9990)", async () => {
    const now = Date.now();
    await manager.recordNavigationEvent(createEvent("Home", now));
    // First Home -> Settings transition has no correlated tool call.
    await manager.recordNavigationEvent(createEvent("Settings", now + 100));
    await manager.recordNavigationEvent(createEvent("Home", now + 200));

    manager.recordToolCall("tapOn", { text: "Settings" });
    await manager.recordNavigationEvent(createEvent("Settings", now + 300));
    await manager.recordNavigationEvent(createEvent("Home", now + 400));

    const result = await manager.findPath("Settings");

    expect(result.found).toBe(true);
    expect(result.path).toHaveLength(1);
    expect(result.path[0].edgeType).toBe("tool");
    expect(result.path[0].interaction?.toolName).toBe("tapOn");
  });

  test("uses the most recent tool edge arguments for a repeated pair (#9990)", async () => {
    const now = Date.now();
    await manager.recordNavigationEvent(createEvent("Home", now));

    manager.recordToolCall("tapOn", { text: "Old Settings" });
    await manager.recordNavigationEvent(createEvent("Settings", now + 100));
    await manager.recordNavigationEvent(createEvent("Home", now + 200));

    manager.recordToolCall("tapOn", { text: "New Settings" });
    await manager.recordNavigationEvent(createEvent("Settings", now + 300));

    // A later traversal with no tool call must not displace the tool edge.
    await manager.recordNavigationEvent(createEvent("Home", now + 400));
    await manager.recordNavigationEvent(createEvent("Settings", now + 500));
    await manager.recordNavigationEvent(createEvent("Home", now + 600));

    const result = await manager.findPath("Settings");

    expect(result.path).toHaveLength(1);
    expect(result.path[0].interaction?.args).toEqual({ text: "New Settings" });
  });

  test("recency compares the row id before a device timestamp that moved backwards (#10031)", async () => {
    const now = Date.now();
    await manager.recordNavigationEvent(createEvent("Home", now));

    manager.recordToolCall("tapOn", { text: "Recorded first" });
    await manager.recordNavigationEvent(createEvent("Settings", now + 5000));
    await manager.recordNavigationEvent(createEvent("Home", now + 5100));

    // The device clock stepped back, so the later row carries an earlier timestamp.
    manager.recordToolCall("tapOn", { text: "Recorded second" });
    await manager.recordNavigationEvent(createEvent("Settings", now + 100));
    await manager.recordNavigationEvent(createEvent("Home", now + 200));

    const result = await manager.findPath("Settings");

    expect(result.path[0].interaction?.args).toEqual({ text: "Recorded second" });
  });

  test("uses a tool edge as the predecessor on a multi-hop path (#9990)", async () => {
    const now = Date.now();
    await manager.recordNavigationEvent(createEvent("Home", now));
    await manager.recordNavigationEvent(createEvent("List", now + 100));
    await manager.recordNavigationEvent(createEvent("Home", now + 200));

    manager.recordToolCall("tapOn", { text: "List" });
    await manager.recordNavigationEvent(createEvent("List", now + 300));

    manager.recordToolCall("tapOn", { text: "Detail" });
    await manager.recordNavigationEvent(createEvent("Detail", now + 400));
    await manager.recordNavigationEvent(createEvent("Home", now + 500));

    const result = await manager.findPath("Detail");

    expect(result.path.map((edge) => [edge.from, edge.to, edge.edgeType])).toEqual([
      ["Home", "List", "tool"],
      ["List", "Detail", "tool"],
    ]);
  });

  test("an edge with no tool call is not offered as a path (#10196)", async () => {
    const now = Date.now();
    await manager.recordNavigationEvent(createEvent("Home", now));
    await manager.recordNavigationEvent(createEvent("Settings", now + 100));
    await manager.recordNavigationEvent(createEvent("Home", now + 200));
    await manager.recordNavigationEvent(createEvent("Settings", now + 300));
    await manager.recordNavigationEvent(createEvent("Home", now + 400));

    const result = await manager.findPath("Settings");

    // Nothing says what caused Home -> Settings, so it is not replayed as a guessed Back press.
    // Path finding reads distinct transitions (#10194): four traversals are two edges.
    expect(result.found).toBe(false);
    expect(result.path).toEqual([]);
    expect(result.unreplayableEdges).toBe(2);
  });

  test("routes around an edge with no tool call through recorded edges (#10196)", async () => {
    const now = Date.now();
    await manager.recordNavigationEvent(createEvent("Home", now));
    // Home -> Target was seen with no attributable tool.
    await manager.recordNavigationEvent(createEvent("Target", now + 100));
    await manager.recordNavigationEvent(createEvent("Home", now + 200));

    manager.recordToolCall("tapOn", { text: "Menu" });
    await manager.recordNavigationEvent(createEvent("Menu", now + 300));
    manager.recordToolCall("tapOn", { text: "Target" });
    await manager.recordNavigationEvent(createEvent("Target", now + 400));
    manager.recordToolCall("pressButton", { button: "back" });
    await manager.recordNavigationEvent(createEvent("Home", now + 500));

    const result = await manager.findPath("Target");

    expect(result.found).toBe(true);
    expect(result.path.map((edge) => [edge.from, edge.to, edge.edgeType])).toEqual([
      ["Home", "Menu", "tool"],
      ["Menu", "Target", "tool"],
    ]);
  });

  describe("an edge with no tool call and depth evidence of Back (#10196)", () => {
    /** Home at depth `homeDepth`, Detail at `detailDepth`, ending on Detail with tool-less edges both ways. */
    async function recordWithDepths(homeDepth: number | null, detailDepth: number | null) {
      const now = Date.now();
      const depth = async (value: number | null) => {
        if (value !== null) {
          await manager.recordBackStack({ depth: value, activities: [], tasks: [] });
        }
      };
      await manager.recordNavigationEvent(createEvent("Home", now));
      await depth(homeDepth);
      await manager.recordNavigationEvent(createEvent("Detail", now + 100));
      await depth(detailDepth);
      await manager.recordNavigationEvent(createEvent("Home", now + 200));
      await manager.recordNavigationEvent(createEvent("Detail", now + 300));
    }

    test("a target shallower than its source is replayable as Back", async () => {
      await recordWithDepths(1, 2);

      const result = await manager.findPath("Home");

      expect(result.found).toBe(true);
      expect(result.path.map((edge) => [edge.from, edge.to, edge.edgeType])).toEqual([
        ["Detail", "Home", "back"],
      ]);
      expect(result.path[0].interaction).toBeUndefined();
    });

    test("the opposite edge, to a deeper screen, stays unreplayable and is reported", async () => {
      await recordWithDepths(1, 2);
      await manager.recordNavigationEvent(createEvent("Home", Date.now() + 400));

      const result = await manager.findPath("Detail");

      expect(result.found).toBe(false);
      // Home -> Detail (traversed twice, one distinct edge); Detail -> Home is the replayable one.
      expect(result.unreplayableEdges).toBe(1);
    });

    test.each([
      ["the same depth", 2, 2],
      ["unknown depths", null, null],
      ["only the target's depth known", 1, null],
      ["only the source's depth known", null, 2],
    ])("%s is no evidence: the edge is not offered", async (_label, homeDepth, detailDepth) => {
      await recordWithDepths(homeDepth, detailDepth);

      const result = await manager.findPath("Home");

      expect(result.found).toBe(false);
      // Both directions, each traversed once or twice: two distinct edges.
      expect(result.unreplayableEdges).toBe(2);
    });

    test("500 traversals of one Back edge are one distinct edge and still replay as Back (#10194, #10196)", async () => {
      await recordWithDepths(1, 2);
      await insertTraversals(500, "Detail", "Home", 10_000);

      const result = await manager.findPath("Home");

      // Back evidence is read from the node depths, so it still holds with distinct edges.
      expect(result.found).toBe(true);
      expect(result.path.map((edge) => [edge.from, edge.to, edge.edgeType])).toEqual([
        ["Detail", "Home", "back"],
      ]);
      expect(await harness.db.selectFrom("navigation_edges").selectAll().execute()).toHaveLength(
        503,
      );
    });

    test("500 traversals of one unreplayable edge are counted once, not 500 times (#10194, #10196)", async () => {
      await recordWithDepths(null, null);
      await insertTraversals(500, "Home", "Detail", 10_000);

      const result = await manager.findPath("Home");

      expect(result.found).toBe(false);
      // Home -> Detail and Detail -> Home: two distinct edges, however many rows exist.
      expect(result.unreplayableEdges).toBe(2);
    });

    test("a recorded tool edge for the pair is still preferred when the Back edge is older", async () => {
      await recordWithDepths(1, 2);
      manager.recordToolCall("pressButton", { button: "back" });
      await manager.recordNavigationEvent(createEvent("Home", Date.now() + 400));
      await manager.recordNavigationEvent(createEvent("Detail", Date.now() + 500));

      const result = await manager.findPath("Home");

      expect(result.path[0].edgeType).toBe("tool");
      expect(result.path[0].interaction?.toolName).toBe("pressButton");
    });
  });

  test("an edge recorded as a Back press is found (#10196)", async () => {
    const now = Date.now();
    await manager.recordNavigationEvent(createEvent("Home", now));
    manager.recordToolCall("tapOn", { text: "Settings" });
    await manager.recordNavigationEvent(createEvent("Settings", now + 100));
    manager.recordToolCall("pressButton", { button: "back" });
    await manager.recordNavigationEvent(createEvent("Home", now + 200));
    await manager.recordNavigationEvent(createEvent("Settings", now + 300));

    const result = await manager.findPath("Home");

    expect(result.found).toBe(true);
    expect(result.path[0].interaction).toMatchObject({
      toolName: "pressButton",
      args: { button: "back" },
    });
  });

  describe("scroll-search demotion with unreplayable edges in one search (#10154, #10196)", () => {
    /** Home -> Target once with no attributable tool, then by one tapOn per entry of `texts`. */
    async function recordTools(texts: string[]): Promise<void> {
      const now = Date.now();
      await manager.recordNavigationEvent(createEvent("Home", now));
      await manager.recordNavigationEvent(createEvent("Target", now + 10));
      await manager.recordNavigationEvent(createEvent("Home", now + 20));
      let at = now + 100;
      for (const text of texts) {
        manager.recordToolCall("tapOn", { text });
        await manager.recordNavigationEvent(createEvent("Target", at));
        await manager.recordNavigationEvent(createEvent("Home", at + 10));
        at += 100;
      }
    }

    /** What navigateTo does when a replayed tap's target is not found after scrolling, twice running. */
    async function demoteAfterTwoMisses(): Promise<void> {
      const edge = (await manager.findPath("Target")).path[0];
      for (let call = 0; call < 2; call++) {
        manager.recordEdgeReplayOutcome(edge, false);
        manager.settleTransientEdgeFailure(edge, true);
      }
      expect(manager.hasEdgeReplayFailure(edge)).toBe(true);
    }

    test("a demoted tool edge ranks below the working edge for its pair; the unknown edge is skipped", async () => {
      await recordTools(["Old", "New"]);
      // The newest edge is the one a search tries first; two misses demote it below "Old".
      await demoteAfterTwoMisses();

      const result = await manager.findPath("Target");

      expect(result.found).toBe(true);
      expect(result.path).toHaveLength(1);
      expect(result.path[0].interaction?.args).toEqual({ text: "Old" });
      expect(result.unreplayableEdges).toBeUndefined();
    });

    test("a demoted tool edge is still offered alone, and is not counted as unreplayable", async () => {
      await recordTools(["Only"]);
      await demoteAfterTwoMisses();
      await insertTraversals(500, "Home", "Elsewhere", 100_000);

      const offered = await manager.findPath("Target");
      const unreachable = await manager.findPath("Nowhere");

      expect(offered.found).toBe(true);
      expect(offered.path[0].interaction?.args).toEqual({ text: "Only" });
      expect(unreachable.found).toBe(false);
      // Home -> Target and Target -> Home (tool-less) plus Home -> Elsewhere (500 rows): three
      // distinct unknown edges; the demoted tool edge is replayable, so it adds nothing.
      expect(unreachable.unreplayableEdges).toBe(3);
    });
  });
});

function createEvent(destination: string, timestamp: number): NavigationEvent {
  return {
    destination,
    source: "TEST",
    arguments: {},
    metadata: {},
    timestamp,
    sequenceNumber: 0,
  };
}
