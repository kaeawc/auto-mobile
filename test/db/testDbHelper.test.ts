import { describe, expect, test } from "bun:test";
import { createTestDatabase, isDefaultMigratedTemplateWarm } from "./testDbHelper";

describe("testDbHelper template warm-up", () => {
  // The migration run is charged to whichever test first needs the template unless a
  // root hook built it before the first test starts. A top-level `await` in the helper
  // did not achieve that under `bun test --isolate` (the CI unit invocation), which left
  // the first test of every DB-backed file at ~45 ms locally and ~140 ms on CI.
  test("the default template is already built when the first test starts", () => {
    expect(isDefaultMigratedTemplateWarm()).toBe(true);
  });

  test("a cloned database is migrated and independent of other clones", async () => {
    const first = await createTestDatabase();
    const second = await createTestDatabase();
    try {
      await first.insertInto("navigation_apps").values({ app_id: "com.example.one" }).execute();
      const firstRows = await first.selectFrom("navigation_apps").selectAll().execute();
      const secondRows = await second.selectFrom("navigation_apps").selectAll().execute();
      expect(firstRows.map((row) => row.app_id)).toEqual(["com.example.one"]);
      expect(secondRows).toEqual([]);
    } finally {
      await first.destroy();
      await second.destroy();
    }
  });
});
