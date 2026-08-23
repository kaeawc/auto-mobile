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
    expect(
      await repository.complete(
        "operation-1",
        "request-a",
        "owner-a",
        { state: "destroyed" },
        1_200,
      ),
    ).toBe(true);

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

  test("purges expired records for other operations when beginning a teardown", async () => {
    const repository = new DeviceTeardownOperationRepository(db);
    await repository.begin("expired-1", "request-a", "owner-a", 0, 100);
    await repository.begin("expired-2", "request-b", "owner-b", 0, 100);

    expect(await repository.begin("active", "request-c", "owner-c", 100, 1_100)).toEqual({
      status: "started",
    });
    expect(
      await db
        .selectFrom("device_teardown_operations")
        .select(["operation_id", "expires_at_ms"])
        .orderBy("operation_id")
        .execute(),
    ).toEqual([{ operation_id: "active", expires_at_ms: 1_100 }]);
  });

  test("keeps a running expiry from moving backward when overlapping renewals settle", async () => {
    const repository = new DeviceTeardownOperationRepository(db);
    await repository.begin("operation-1", "request-a", "owner-a", 0, 100);

    expect(await repository.renew("operation-1", "request-a", "owner-a", 1_000)).toBe(true);
    expect(await repository.renew("operation-1", "request-a", "owner-a", 500)).toBe(true);
    expect(
      await db
        .selectFrom("device_teardown_operations")
        .select("expires_at_ms")
        .where("operation_id", "=", "operation-1")
        .executeTakeFirstOrThrow(),
    ).toEqual({ expires_at_ms: 1_000 });
  });

  test("does not let a stale owner complete a replacement operation", async () => {
    const repository = new DeviceTeardownOperationRepository(db);
    await repository.begin("operation-1", "request-a", "owner-a", 100, 200);
    expect(await repository.begin("operation-1", "request-a", "owner-b", 200, 1_200)).toEqual({
      status: "started",
    });

    expect(
      await repository.complete("operation-1", "request-a", "owner-a", { state: "stale" }, 1_300),
    ).toBe(false);
    await repository.delete("operation-1", "request-a", "owner-a");
    expect(await repository.renew("operation-1", "request-a", "owner-a", 1_400)).toBe(false);

    expect(await repository.begin("operation-1", "request-a", "owner-c", 300, 1_300)).toEqual({
      status: "in_progress",
    });
  });
});
