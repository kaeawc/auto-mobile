import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { ToolSelectionProfileProvenanceRepository } from "../../src/db/toolSelectionProfileProvenanceRepository";
import { createTestDatabase } from "./testDbHelper";

/**
 * #6225 (#6148/#6213 follow-up): durable membership set backing
 * `PersistentToolSelectionProfileRegistry`.
 *
 * The migration run inside `createTestDatabase()` is the expensive part (full
 * migrator walk over every migration file), not anything this repository
 * does. Migrating once in `beforeAll` and clearing just this suite's own
 * table between tests keeps that one-time cost off of every individual test
 * — including whichever test happens to run first, which is what the
 * 100ms/test CI budget (`scripts/validate-bun-test-timings.sh`) measures
 * (#6244 CI run: "loadAll returns empty when nothing has been minted" at
 * 118.69ms under a per-test `beforeEach` migration).
 */
describe("ToolSelectionProfileProvenanceRepository", () => {
  let db: Kysely<Database>;
  let repo: ToolSelectionProfileProvenanceRepository;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom("tool_selection_profile_provenance").execute();
    repo = new ToolSelectionProfileProvenanceRepository(db);
  });

  test("loadAll returns empty when nothing has been minted", async () => {
    expect(await repo.loadAll()).toEqual([]);
  });

  test("insert then loadAll returns the recorded uuid", async () => {
    await repo.insert("minted-uuid");
    expect(await repo.loadAll()).toEqual(["minted-uuid"]);
  });

  test("insert is idempotent: inserting the same uuid twice does not duplicate or throw", async () => {
    await repo.insert("minted-uuid");
    await repo.insert("minted-uuid");
    expect(await repo.loadAll()).toEqual(["minted-uuid"]);
  });

  test("loadAll returns every distinct minted uuid", async () => {
    await repo.insert("uuid-a");
    await repo.insert("uuid-b");
    expect((await repo.loadAll()).sort()).toEqual(["uuid-a", "uuid-b"]);
  });

  test("a value that was never inserted never appears in loadAll (no fabricated-value leak)", async () => {
    await repo.insert("minted-uuid");
    expect(await repo.loadAll()).not.toContain("fabricated-uuid");
  });
});
