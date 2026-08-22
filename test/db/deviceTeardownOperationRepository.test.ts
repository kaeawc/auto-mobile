import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { DeviceTeardownOperationRepository } from "../../src/db/deviceTeardownOperationRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";

describe("DeviceTeardownOperationRepository", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("replays a completed operation after repository reconstruction", async () => {
    const repository = new DeviceTeardownOperationRepository(db);
    expect(await repository.begin("operation-1", "request-a", "owner-a", 100, 1_100)).toEqual({
      status: "started",
    });
    await repository.complete("operation-1", "request-a", "owner-a", { state: "destroyed" }, 1_200);

    const restarted = new DeviceTeardownOperationRepository(db);
    expect(await restarted.begin("operation-1", "request-a", "owner-b", 200, 1_200)).toEqual({
      status: "completed",
      result: { state: "destroyed" },
    });
    expect(await restarted.begin("operation-1", "request-b", "owner-c", 200, 1_200)).toEqual({
      status: "conflict",
    });
  });

  test("blocks an accepted nonterminal operation until its replay window expires", async () => {
    const repository = new DeviceTeardownOperationRepository(db);
    await repository.begin("operation-1", "request-a", "owner-a", 100, 1_100);

    expect(await repository.begin("operation-1", "request-a", "owner-b", 200, 1_200)).toEqual({
      status: "in_progress",
    });
    expect(await repository.begin("operation-1", "request-a", "owner-c", 1_100, 2_100)).toEqual({
      status: "started",
    });
  });

  test("does not let a stale owner complete a replacement operation", async () => {
    const repository = new DeviceTeardownOperationRepository(db);
    await repository.begin("operation-1", "request-a", "owner-a", 100, 200);
    expect(await repository.begin("operation-1", "request-a", "owner-b", 200, 1_200)).toEqual({
      status: "started",
    });

    await repository.complete("operation-1", "request-a", "owner-a", { state: "stale" }, 1_300);
    await repository.delete("operation-1", "request-a", "owner-a");
    await repository.renew("operation-1", "request-a", "owner-a", 1_400);

    expect(await repository.begin("operation-1", "request-a", "owner-c", 300, 1_300)).toEqual({
      status: "in_progress",
    });
  });
});
