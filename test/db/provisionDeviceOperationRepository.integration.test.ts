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

    expect(
      await repository.begin("operation-1", "request-a", "attempt-1", 0, FAR_FUTURE_EXPIRY_MS),
    ).toEqual({
      started: true,
      reconcileExistingConfiguration: false,
    });
    expect(
      await repository.complete("operation-1", "attempt-1", {
        deviceId: "emulator-5554",
        name: "phone-api-36-a",
      }),
    ).toBe(true);

    expect(
      await repository.begin("operation-1", "request-a", "attempt-2", 0, FAR_FUTURE_EXPIRY_MS),
    ).toEqual({
      started: false,
      result: {
        deviceId: "emulator-5554",
        name: "phone-api-36-a",
      },
      reconcileExistingConfiguration: false,
    });
    await expect(
      repository.begin("operation-1", "request-b", "attempt-3", 0, FAR_FUTURE_EXPIRY_MS),
    ).rejects.toThrow(
      "operationId 'operation-1' was already used for a different provisionDevice request",
    );
  });

  test("permits configuration reconciliation only after creation began", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin("operation-retry", "request-a", "attempt-1", 0, FAR_FUTURE_EXPIRY_MS);
    await repository.fail(
      "operation-retry",
      "attempt-1",
      "platform_command_failed",
      "config write failed",
    );

    expect(
      await repository.begin("operation-retry", "request-a", "attempt-2", 0, FAR_FUTURE_EXPIRY_MS),
    ).toEqual({
      started: true,
      reconcileExistingConfiguration: false,
    });

    expect(await repository.markDeviceCreationStarted("operation-retry", "attempt-2")).toBe(true);
    await repository.fail(
      "operation-retry",
      "attempt-2",
      "platform_command_failed",
      "config write failed",
    );

    expect(
      await repository.begin("operation-retry", "request-a", "attempt-3", 0, FAR_FUTURE_EXPIRY_MS),
    ).toEqual({
      started: true,
      reconcileExistingConfiguration: true,
    });
  });

  test("retains creation provenance when replaying a completed operation", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin("operation-created", "request-a", "attempt-1", 0, FAR_FUTURE_EXPIRY_MS);
    await repository.markDeviceCreationStarted("operation-created", "attempt-1");
    await repository.complete("operation-created", "attempt-1", { created: true });

    expect(
      await repository.begin(
        "operation-created",
        "request-a",
        "attempt-2",
        0,
        FAR_FUTURE_EXPIRY_MS,
      ),
    ).toEqual({
      started: false,
      result: { created: true },
      reconcileExistingConfiguration: true,
    });
  });

  test("reports in-progress instead of restarting a still-running operation (#6652 defect 1)", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    expect(
      await repository.begin("operation-running", "request-a", "attempt-1", 0, 10_000),
    ).toEqual({
      started: true,
      reconcileExistingConfiguration: false,
    });

    // No complete()/fail() ever runs on this row -- simulates a daemon crash
    // or restart mid-provisioning. A retry with the same idempotency key while
    // the row is still within its TTL must be told the operation is already
    // in progress, not silently re-run from scratch.
    expect(
      await repository.begin("operation-running", "request-a", "attempt-2", 5_000, 10_000),
    ).toEqual({
      started: false,
      inProgress: true,
    });
  });

  test("clears creation provenance only after verified rollback", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin(
      "operation-cleaned-up",
      "request-a",
      "attempt-1",
      0,
      FAR_FUTURE_EXPIRY_MS,
    );
    await repository.markDeviceCreationStarted("operation-cleaned-up", "attempt-1");
    await repository.fail(
      "operation-cleaned-up",
      "attempt-1",
      "platform_command_failed",
      "cleanup failed",
    );

    expect(
      await repository.begin(
        "operation-cleaned-up",
        "request-a",
        "attempt-2",
        0,
        FAR_FUTURE_EXPIRY_MS,
      ),
    ).toEqual({
      started: true,
      reconcileExistingConfiguration: true,
    });

    await repository.fail(
      "operation-cleaned-up",
      "attempt-2",
      "platform_command_failed",
      "cleanup succeeded",
      { clearCreationStarted: true },
    );

    expect(
      await repository.begin(
        "operation-cleaned-up",
        "request-a",
        "attempt-3",
        0,
        FAR_FUTURE_EXPIRY_MS,
      ),
    ).toEqual({
      started: true,
      reconcileExistingConfiguration: false,
    });
  });

  test("treats an expired running row as abandoned and starts a fresh attempt", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin("operation-crashed", "request-a", "attempt-1", 0, 1_000);

    // Past its TTL with no complete()/fail(): the owning process is gone, so
    // this must be distinguishable from a genuinely live "running" row above
    // rather than reporting in-progress forever.
    expect(
      await repository.begin("operation-crashed", "request-a", "attempt-2", 1_000, 11_000),
    ).toEqual({
      started: true,
      reconcileExistingConfiguration: false,
    });
  });

  test("re-marks a retried operation running so a third attempt is refused", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    expect(
      await repository.begin("operation-cas", "request-a", "attempt-1", 0, FAR_FUTURE_EXPIRY_MS),
    ).toEqual({ started: true, reconcileExistingConfiguration: false });
    await repository.fail("operation-cas", "attempt-1", "platform_command_failed", "boom");

    // Attempt 2 retries after the failure and is admitted...
    expect(
      await repository.begin(
        "operation-cas",
        "request-a",
        "attempt-2",
        1_000,
        FAR_FUTURE_EXPIRY_MS,
      ),
    ).toEqual({ started: true, reconcileExistingConfiguration: false });

    // ...so a third caller (another process sharing the database, or this one
    // after a restart cleared its in-memory operation map) must see the retry
    // as in progress rather than racing it on the same AVD name.
    expect(
      await repository.begin(
        "operation-cas",
        "request-a",
        "attempt-3",
        2_000,
        FAR_FUTURE_EXPIRY_MS,
      ),
    ).toEqual({ started: false, inProgress: true });
  });

  test("renews the row expiry for the attempt it admits", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin("operation-ttl", "request-a", "attempt-1", 0, 10_000);
    await repository.fail("operation-ttl", "attempt-1", "platform_command_failed", "boom");

    // The retry's TTL must measure how long THIS attempt has been running, not
    // how long ago the first attempt started -- otherwise a live attempt can
    // have its own row swept out from under it by an unrelated begin().
    await repository.begin("operation-ttl", "request-a", "attempt-2", 9_000, 1_000_000);

    const row = await db
      .selectFrom("provision_device_operations")
      .selectAll()
      .where("operation_id", "=", "operation-ttl")
      .executeTakeFirst();
    expect(row?.expires_at_ms).toBe(1_000_000);
  });

  test("fences a superseded attempt out of complete(), fail() and creation provenance", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin("operation-fence", "request-a", "attempt-1", 0, 10_000);
    // Attempt 1 wedges past its TTL; the sweep reclaims the row for attempt 2.
    expect(
      await repository.begin("operation-fence", "request-a", "attempt-2", 20_000, 1_020_000),
    ).toEqual({ started: true, reconcileExistingConfiguration: false });

    // Attempt 1 finally unwedges: none of its writes may touch attempt 2's row.
    expect(
      await repository.complete("operation-fence", "attempt-1", { device: { name: "stale" } }),
    ).toBe(false);
    expect(await repository.markDeviceCreationStarted("operation-fence", "attempt-1")).toBe(false);
    expect(
      await repository.fail("operation-fence", "attempt-1", "platform_command_failed", "stale"),
    ).toBe(false);

    expect(
      await repository.begin("operation-fence", "request-a", "attempt-3", 21_000, 1_020_000),
    ).toEqual({ started: false, inProgress: true });
  });

  test("prunes expired rows on a later begin() call instead of growing without bound (#6652 defect 2)", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin("stale-1", "request-a", "attempt-1", 0, 1_000);
    await repository.begin("stale-2", "request-b", "attempt-2", 0, 1_000);

    expect(
      await db.selectFrom("provision_device_operations").select("operation_id").execute(),
    ).toHaveLength(2);

    // A begin() call for an unrelated operationId, well past the stale rows'
    // expiry, must sweep them out rather than leaving them to accumulate
    // forever.
    await repository.begin("fresh", "request-c", "attempt-3", 5_000, 15_000);

    expect(
      await db
        .selectFrom("provision_device_operations")
        .select("operation_id")
        .orderBy("operation_id")
        .execute(),
    ).toEqual([{ operation_id: "fresh" }]);
  });
});
