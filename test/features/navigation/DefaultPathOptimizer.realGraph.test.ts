import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DefaultPathOptimizer } from "../../../src/features/navigation/DefaultPathOptimizer";
import type { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP_ID = "com.example.backpath";

/**
 * The back-button heuristic verifies that the target screen reaches the current
 * one by forward edges (the route the user took down the stack). These tests drive
 * the REAL NavigationGraphManager so the search direction is exercised against
 * the manager's actual edges, not a stub that can hide a reversed lookup.
 */
describe("DefaultPathOptimizer against a real navigation graph", () => {
  let harness: InMemoryNavManagerHarness;
  let manager: NavigationGraphManager;
  let sequence = 0;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
    manager = harness.manager;
  });

  afterAll(async () => {
    await harness.dispose();
  });

  beforeEach(async () => {
    sequence = 0;
    await manager.setCurrentApp(APP_ID);
    await manager.clearCurrentGraph();
  });

  /** Visit `screen` (creating an edge from the previous one) and record its depth. */
  async function visit(screen: string, depth: number): Promise<void> {
    sequence += 1;
    await manager.recordNavigationEvent({
      destination: screen,
      source: "",
      arguments: {},
      metadata: {},
      timestamp: 1000 + sequence,
      sequenceNumber: sequence,
      applicationId: APP_ID,
    });
    await manager.recordBackStack({ depth, currentTaskId: 1 });
  }

  test("uses two Back presses when the target leads to the current screen in two edges", async () => {
    await visit("Feed", 1);
    await visit("Detail", 2);
    await visit("Settings", 3);

    const result = await new DefaultPathOptimizer(manager).shouldUseBackButton(
      "Settings",
      "Feed",
      3,
    );

    expect(result).toMatchObject({ shouldUseBack: true, backPresses: 2 });
    expect(result.reason).toMatch(/matches depth difference/);
  });

  test("does not press Back when only the opposite direction (current to target) has a matching path", async () => {
    // Settings -> Profile -> Feed, then Feed -> Settings: Feed reaches Settings in ONE
    // edge, so the two-level gap is not a retraced stack. Searching from the current
    // screen finds the unrelated two-edge route Settings -> Profile -> Feed instead.
    await visit("Settings", 3);
    await visit("Profile", 2);
    await visit("Feed", 1);
    await visit("Settings", 3);

    const result = await new DefaultPathOptimizer(manager).shouldUseBackButton(
      "Settings",
      "Feed",
      3,
    );

    expect(result.shouldUseBack).toBe(false);
    expect(result.backPresses).toBe(0);
    expect(result.reason).toMatch(/doesn't match depth difference/);
  });

  test("keeps the depth-1 fallback when no forward path is recorded", async () => {
    await visit("Feed", 1);
    await visit("Detail", 2);
    // Forget every edge but keep the nodes' depths.
    await harness.db.deleteFrom("navigation_edges").execute();

    const result = await new DefaultPathOptimizer(manager).shouldUseBackButton("Detail", "Feed", 2);

    expect(result).toMatchObject({ shouldUseBack: true, backPresses: 1 });
    expect(result.reason).toMatch(/Depth difference is 1/);
  });

  test("declines a depth-2 gap with no recorded forward path", async () => {
    await visit("Feed", 1);
    await visit("Detail", 2);
    await visit("Settings", 3);
    await harness.db.deleteFrom("navigation_edges").execute();

    const result = await new DefaultPathOptimizer(manager).shouldUseBackButton(
      "Settings",
      "Feed",
      3,
    );

    expect(result.shouldUseBack).toBe(false);
    expect(result.reason).toMatch(/No known navigation path to verify safety/);
  });
});
