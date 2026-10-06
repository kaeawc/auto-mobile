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
    expect(result.found).toBe(false);
    expect(result.path).toEqual([]);
    expect(result.unreplayableEdges).toBe(4);
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
      // Home -> Detail twice; the Detail -> Home edge is the replayable one.
      expect(result.unreplayableEdges).toBe(2);
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
      expect(result.unreplayableEdges).toBe(3);
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
