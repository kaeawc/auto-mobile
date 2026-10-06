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

  test("falls back to the newest edge with no tool call when nothing else exists (#9990)", async () => {
    const now = Date.now();
    await manager.recordNavigationEvent(createEvent("Home", now));
    await manager.recordNavigationEvent(createEvent("Settings", now + 100));
    await manager.recordNavigationEvent(createEvent("Home", now + 200));
    await manager.recordNavigationEvent(createEvent("Settings", now + 300));
    await manager.recordNavigationEvent(createEvent("Home", now + 400));

    const result = await manager.findPath("Settings");

    expect(result.found).toBe(true);
    expect(result.path).toHaveLength(1);
    expect(result.path[0].edgeType).toBe("unknown");
    expect(result.path[0].timestamp).toBe(now + 300);
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
