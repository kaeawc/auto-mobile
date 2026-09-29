import { afterEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "./testDbHelper";
import type { Database } from "../../src/db/types";
import { runMigrations } from "../../src/db/migrator";
import { NavigationRepository } from "../../src/db/navigationRepository";
import { sql } from "kysely";

const PREVIOUS = "2026_09_20_000_provision_device_lifecycle_outcome";

describe("navigation suggestion provenance migration", () => {
  let db: Kysely<Database>;

  afterEach(async () => {
    await db.destroy();
  });

  test("fresh database has the suggestion observation table", async () => {
    db = await createTestDatabase({ foreignKeys: true });
    expect(await db.selectFrom("navigation_suggestion_observations").selectAll().execute()).toEqual(
      [],
    );
    const indexes = await sql<{ name: string }>`
      SELECT name FROM pragma_index_list('navigation_suggestion_observations')
    `.execute(db);
    expect(indexes.rows.map((row) => row.name)).toContain(
      "idx_navigation_suggestion_observations_build",
    );
  });

  test("upgrades the previous migration version without inventing old provenance", async () => {
    db = await createTestDatabase({ foreignKeys: true, throughMigration: PREVIOUS });
    const repo = new NavigationRepository(db);
    await repo.getOrCreateApp("com.example.app");
    const suggestion = await repo.addOrUpdateSuggestion("com.example.app", "old", "{}", 100);

    await runMigrations(db as Kysely<unknown>);

    expect(await db.selectFrom("navigation_suggestion_observations").selectAll().execute()).toEqual(
      [],
    );
    expect((await repo.getSuggestions("com.example.app"))[0].id).toBe(suggestion.id);
    const migrations = await db
      .selectFrom("kysely_migration" as never)
      .select("name" as never)
      .execute();
    expect(
      migrations.some((row) =>
        Object.values(row).includes("2026_09_29_000_navigation_suggestion_provenance"),
      ),
    ).toBe(true);
  });
});
