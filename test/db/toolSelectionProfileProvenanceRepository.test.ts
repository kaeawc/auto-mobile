import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { ToolSelectionProfileProvenanceRepository } from "../../src/db/toolSelectionProfileProvenanceRepository";
import { createTestDatabase } from "./testDbHelper";

/**
 * #6225 (#6148/#6213 follow-up): durable membership set backing
 * `PersistentToolSelectionProfileRegistry`.
 */
describe("ToolSelectionProfileProvenanceRepository", () => {
  let db: Kysely<Database>;
  let repo: ToolSelectionProfileProvenanceRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new ToolSelectionProfileProvenanceRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
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
