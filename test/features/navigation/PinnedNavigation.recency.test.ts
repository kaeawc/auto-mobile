import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolvePinnedEdge } from "../../../src/features/navigation/PinnedNavigation";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP_ID = "com.test.app";

describe("resolvePinnedEdge recency (#18321)", () => {
  let harness: InMemoryNavManagerHarness;

  beforeEach(async () => {
    harness = await installInMemoryNavManager();
    await harness.manager.setCurrentApp(APP_ID);
  });

  afterEach(async () => {
    await harness.dispose();
  });

  /** Append one tapOn traversal row of Home -> Settings; later calls get larger row ids. */
  async function insertTapOn(text: string, timestamp: number): Promise<void> {
    await harness.db
      .insertInto("navigation_edges")
      .values({
        app_id: APP_ID,
        from_screen: "Home",
        to_screen: "Settings",
        tool_name: "tapOn",
        tool_args: JSON.stringify({ text }),
        timestamp,
      })
      .execute();
  }

  test("ranks by row id before a device timestamp that moved backwards", async () => {
    await insertTapOn("old", 2000);
    // The device clock stepped back, so the later row carries an earlier timestamp.
    await insertTapOn("new", 1000);

    const edge = await resolvePinnedEdge(
      { from: "Home", to: "Settings", toolName: "tapOn" },
      harness.manager,
    );

    expect(typeof edge).not.toBe("string");
    expect(typeof edge === "string" ? edge : edge.interaction?.args).toEqual({ text: "new" });
  });

  test("getEdgesFrom exposes each edge's row id", async () => {
    await insertTapOn("old", 2000);
    await insertTapOn("new", 1000);

    const edges = await harness.manager.getEdgesFrom("Home");
    const idOf = (text: string) => edges.find((e) => e.interaction?.args.text === text)?.id;

    expect(idOf("old")).toBeNumber();
    expect(idOf("new")!).toBeGreaterThan(idOf("old")!);
  });
});
