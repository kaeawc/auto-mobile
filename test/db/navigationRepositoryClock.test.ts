import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "./testDbHelper";
import type { Database } from "../../src/db/types";
import { NavigationRepository } from "../../src/db/navigationRepository";
import { FakeTimer } from "../fakes/FakeTimer";

// NavigationRepository stamps navigation_apps.updated_at from the injected Timer
// (#11862), not from the wall clock.

describe("NavigationRepository clock (#11862)", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let repo: NavigationRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(1_700_000_000_000);
    repo = new NavigationRepository({ db, timer });
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("getOrCreateApp stamps updated_at from the injected timer", async () => {
    const app = await repo.getOrCreateApp("com.example.app");
    expect(app.updated_at).toBe(new Date(1_700_000_000_000).toISOString());
  });

  test("touchApp stamps updated_at from the injected timer, including via withExecutor", async () => {
    await repo.getOrCreateApp("com.example.app");
    timer.advanceTime(60_000);
    await repo.withExecutor(db).touchApp("com.example.app");
    const row = await db
      .selectFrom("navigation_apps")
      .select("updated_at")
      .where("app_id", "=", "com.example.app")
      .executeTakeFirstOrThrow();
    expect(row.updated_at).toBe(new Date(1_700_000_060_000).toISOString());
  });
});
