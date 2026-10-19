import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { SqliteSessionToolSelectionRepository } from "../../src/db/sessionToolSelectionRepository";
import { createTestDatabase } from "./testDbHelper";

/**
 * #6886 review — `setToolEnabled { toolNames: [...] }` advertises all-or-nothing
 * semantics, so the whole batch has to reach SQLite as ONE transaction. A
 * per-name loop of independent upserts leaves the first names written when a
 * later one fails, and lets a concurrent enable/disable batch interleave into a
 * state neither request asked for.
 */
describe("SqliteSessionToolSelectionRepository.setMany", () => {
  let db: Kysely<Database>;
  let repository: SqliteSessionToolSelectionRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repository = new SqliteSessionToolSelectionRepository(() => db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("applies every entry of the batch", async () => {
    await repository.setMany("session-1", [
      { toolName: "sendKeys", enabled: true },
      { toolName: "clipboard", enabled: true },
      { toolName: "observe", enabled: false },
    ]);

    expect(await repository.list("session-1")).toEqual(
      new Map([
        ["sendKeys", true],
        ["clipboard", true],
        ["observe", false],
      ]),
    );
  });

  test("overwrites an existing override in the same batch", async () => {
    await repository.set("session-1", "sendKeys", true);

    await repository.setMany("session-1", [
      { toolName: "sendKeys", enabled: false },
      { toolName: "clipboard", enabled: false },
    ]);

    expect(await repository.list("session-1")).toEqual(
      new Map([
        ["sendKeys", false],
        ["clipboard", false],
      ]),
    );
  });

  test("writes nothing when a later entry of the batch fails", async () => {
    await repository.set("session-1", "observe", true);

    // Fail the second insert inside SQLite, after the first row was written.
    // This preserves the transaction failure without lying about a tool name's type.
    await sql`CREATE TEMP TRIGGER reject_clipboard BEFORE INSERT ON session_tool_overrides
      WHEN NEW.tool_name = 'clipboard'
      BEGIN SELECT RAISE(ABORT, 'injected batch write failure'); END`.execute(db);
    await expect(
      repository.setMany("session-1", [
        { toolName: "sendKeys", enabled: true },
        { toolName: "clipboard", enabled: true },
      ]),
    ).rejects.toThrow();

    expect(await repository.list("session-1")).toEqual(new Map([["observe", true]]));
  });
});
