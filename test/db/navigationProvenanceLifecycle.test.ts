import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { createFileBackedDbHarness } from "./withFileBackedDb";
import { WINDOWS_FILE_DB_TEST_TIMEOUT_MS } from "./fileBackedDbTestTimeout";

/**
 * AC4/AC5 coverage for #4984: the provenance migration applies cleanly as part of
 * the FULL migration chain against a real file-backed DB (not just an isolated
 * up()). Uses the shared file-backed harness so the Windows flake-avoidance
 * ordering is inherited (issue #3046).
 */
describe("navigation provenance migration — file-backed lifecycle", () => {
  let harness = createFileBackedDbHarness();

  beforeEach(() => {
    harness = createFileBackedDbHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test(
    "full migration chain creates the provenance tables on a real file DB",
    async () => {
      const lifecycle = await harness.openLifecycleTestDb("nav-provenance-");
      try {
        const db = lifecycle.module.getDatabase() as Kysely<unknown>;
        const rows = await sql<{ name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
          ('navigation_build_keys','navigation_node_observations','navigation_edge_observations')
        `.execute(db);
        const names = rows.rows.map(r => r.name).sort();
        expect(names).toEqual([
          "navigation_build_keys",
          "navigation_edge_observations",
          "navigation_node_observations",
        ]);
      } finally {
        await lifecycle.close();
      }
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS
  );
});
