import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { ProvisionDeviceOperationRepository } from "../../src/db/provisionDeviceOperationRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";

describe("ProvisionDeviceOperationRepository", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db.destroy();
  });

  // A far-future expiry keeps these behavior-only assertions independent of
  // the pruning/staleness tests below.
  const FAR_FUTURE_EXPIRY_MS = 1_000_000;

  test("replays a completed operation and rejects reuse with a different request", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    expect(await repository.begin("operation-1", "request-a", 0, FAR_FUTURE_EXPIRY_MS)).toEqual({
      started: true,
      reconcileExistingConfiguration: false,
    });
    await repository.complete("operation-1", {
      deviceId: "emulator-5554",
      name: "phone-api-36-a",
    });

    expect(await repository.begin("operation-1", "request-a", 0, FAR_FUTURE_EXPIRY_MS)).toEqual({
      started: false,
      result: {
        deviceId: "emulator-5554",
        name: "phone-api-36-a",
      },
      reconcileExistingConfiguration: false,
    });
    await expect(
      repository.begin("operation-1", "request-b", 0, FAR_FUTURE_EXPIRY_MS),
    ).rejects.toThrow(
      "operationId 'operation-1' was already used for a different provisionDevice request",
    );
  });

  test("permits configuration reconciliation only after creation began", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin("operation-retry", "request-a", 0, FAR_FUTURE_EXPIRY_MS);
    await repository.fail("operation-retry", "platform_command_failed", "config write failed");

    expect(await repository.begin("operation-retry", "request-a", 0, FAR_FUTURE_EXPIRY_MS)).toEqual(
      {
        started: true,
        reconcileExistingConfiguration: false,
      },
    );

    await repository.markDeviceCreationStarted("operation-retry");
    await repository.fail("operation-retry", "platform_command_failed", "config write failed");

    expect(await repository.begin("operation-retry", "request-a", 0, FAR_FUTURE_EXPIRY_MS)).toEqual(
      {
        started: true,
        reconcileExistingConfiguration: true,
      },
    );
  });

  test("retains creation provenance when replaying a completed operation", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin("operation-created", "request-a", 0, FAR_FUTURE_EXPIRY_MS);
    await repository.markDeviceCreationStarted("operation-created");
    await repository.complete("operation-created", { created: true });

    expect(await repository.begin("operation-created", "request-a", 0, FAR_FUTURE_EXPIRY_MS)).toEqual(
      {
        started: false,
        result: { created: true },
        reconcileExistingConfiguration: true,
      },
    );
  });

  test("reports in-progress instead of restarting a still-running operation (#6652 defect 1)", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    expect(await repository.begin("operation-running", "request-a", 0, 10_000)).toEqual({
      started: true,
      reconcileExistingConfiguration: false,
    });

    // No complete()/fail() ever runs on this row -- simulates a daemon crash
    // or restart mid-provisioning. A retry with the same idempotency key while
    // the row is still within its TTL must be told the operation is already
    // in progress, not silently re-run from scratch.
    expect(await repository.begin("operation-running", "request-a", 5_000, 10_000)).toEqual({
      started: false,
      inProgress: true,
    });
  });

  test("clears creation provenance only after verified rollback", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin("operation-cleaned-up", "request-a");
    await repository.markDeviceCreationStarted("operation-cleaned-up");
    await repository.fail("operation-cleaned-up", "platform_command_failed", "cleanup failed");

    expect(await repository.begin("operation-cleaned-up", "request-a")).toEqual({
      started: true,
      reconcileExistingConfiguration: true,
    });

    await repository.fail("operation-cleaned-up", "platform_command_failed", "cleanup succeeded", {
      clearCreationStarted: true,
    });

    expect(await repository.begin("operation-cleaned-up", "request-a")).toEqual({
      started: true,
      reconcileExistingConfiguration: false,
    });
  });

  test("treats an expired running row as abandoned and starts a fresh attempt", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin("operation-crashed", "request-a", 0, 1_000);

    // Past its TTL with no complete()/fail(): the owning process is gone, so
    // this must be distinguishable from a genuinely live "running" row above
    // rather than reporting in-progress forever.
    expect(await repository.begin("operation-crashed", "request-a", 1_000, 11_000)).toEqual({
      started: true,
      reconcileExistingConfiguration: false,
    });
  });

  test("prunes expired rows on a later begin() call instead of growing without bound (#6652 defect 2)", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin("stale-1", "request-a", 0, 1_000);
    await repository.begin("stale-2", "request-b", 0, 1_000);

    expect(
      await db.selectFrom("provision_device_operations").select("operation_id").execute(),
    ).toHaveLength(2);

    // A begin() call for an unrelated operationId, well past the stale rows'
    // expiry, must sweep them out rather than leaving them to accumulate
    // forever.
    await repository.begin("fresh", "request-c", 5_000, 15_000);

    expect(
      await db
        .selectFrom("provision_device_operations")
        .select("operation_id")
        .orderBy("operation_id")
        .execute(),
    ).toEqual([{ operation_id: "fresh" }]);
  });
});
