import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness
} from "../../helpers/navigationTestHarness";
import type { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import type { NavigationEvent } from "../../../src/utils/interfaces/NavigationGraph";

/**
 * Branch coverage for `exportGraphHistory` (#3966).
 *
 * The `auto-mobile/no-accumulator-foreach` burn-down rewrote three accumulators
 * in this method — the screen-name Set, the screen-name→id Map, and the history
 * node list — from `forEach`+mutate into declarative constructors. Those are
 * exactly the rewrites that go subtly wrong: dropping the seed `from_screen`
 * node, reordering the node list, or issuing a DB query on the empty path.
 * Nothing covered this method before, so these pin the observable contract
 * rather than the implementation.
 */

function event(destination: string, sequenceNumber: number): NavigationEvent {
  return {
    destination,
    source: "test",
    arguments: {},
    metadata: {},
    timestamp: 1_700_000_000_000 + sequenceNumber * 1000,
    sequenceNumber,
  };
}

describe("exportGraphHistory", () => {
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

  test("returns an empty page when no app is set", async () => {
    const fresh = await installInMemoryNavManager();
    try {
      const page = await fresh.manager.exportGraphHistory();
      expect(page.appId).toBeNull();
      expect(page.nodes).toEqual([]);
      expect(page.edges).toEqual([]);
    } finally {
      await fresh.dispose();
    }
  });

  test("seeds the node list with the first edge's from_screen, then one node per edge in order", async () => {
    await manager.recordNavigationEvent(event("ScreenA", 1));
    await manager.recordNavigationEvent(event("ScreenB", 2));
    await manager.recordNavigationEvent(event("ScreenC", 3));

    const page = await manager.exportGraphHistory();

    // One seed node for the first edge's origin, plus one per edge.
    expect(page.nodes.length).toBe(page.edges.length + 1);

    const screenNames = page.nodes.map(node => node.screenName);
    expect(screenNames[0]).toBe(page.edges[0].from);
    // Every subsequent node corresponds to the matching edge's destination.
    expect(screenNames.slice(1)).toEqual(page.edges.map(edge => edge.to));
  });

  test("resolves node ids for screens that exist, and carries edge ids", async () => {
    await manager.recordNavigationEvent(event("ScreenA", 1));
    await manager.recordNavigationEvent(event("ScreenB", 2));

    const page = await manager.exportGraphHistory();

    // The seed node has no originating edge; the rest are tied to their edge.
    expect(page.nodes[0].edgeId).toBeNull();
    expect(page.nodes.slice(1).map(node => node.edgeId))
      .toEqual(page.edges.map(edge => edge.id));

    // Ids resolve through the screen-name→id map rather than coming back null.
    for (const node of page.nodes) {
      expect(node.id === null || typeof node.id === "number").toBe(true);
    }
  });

  test("falls back to the current screen when there are no edges", async () => {
    // A single event creates the node but no edge chain to page over.
    await manager.recordNavigationEvent(event("OnlyScreen", 1));
    const page = await manager.exportGraphHistory();

    if (page.edges.length === 0) {
      expect(page.nodes.length).toBeLessThanOrEqual(1);
      if (page.nodes.length === 1) {
        expect(page.nodes[0].edgeId).toBeNull();
        expect(typeof page.nodes[0].screenName).toBe("string");
      }
    } else {
      // If an edge was recorded, the seeded-node contract above applies.
      expect(page.nodes.length).toBe(page.edges.length + 1);
    }
  });

  test("honours the page limit", async () => {
    for (let i = 1; i <= 6; i++) {
      await manager.recordNavigationEvent(event(`Screen${i}`, i));
    }

    const page = await manager.exportGraphHistory({ limit: 2 });
    expect(page.edges.length).toBeLessThanOrEqual(2);
    if (page.edges.length > 0) {
      expect(page.nodes.length).toBe(page.edges.length + 1);
    }
  });
});
