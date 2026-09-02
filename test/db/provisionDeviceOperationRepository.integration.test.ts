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

  test("replays a completed operation and rejects reuse with a different request", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    expect(await repository.begin("operation-1", "request-a")).toEqual({
      started: true,
      reconcileExistingConfiguration: false,
    });
    await repository.complete("operation-1", {
      deviceId: "emulator-5554",
      name: "phone-api-36-a",
    });

    expect(await repository.begin("operation-1", "request-a")).toEqual({
      started: false,
      result: {
        deviceId: "emulator-5554",
        name: "phone-api-36-a",
      },
      reconcileExistingConfiguration: false,
    });
    await expect(repository.begin("operation-1", "request-b")).rejects.toThrow(
      "operationId 'operation-1' was already used for a different provisionDevice request",
    );
  });

  test("permits configuration reconciliation only after creation began", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin("operation-retry", "request-a");
    await repository.fail("operation-retry", "platform_command_failed", "config write failed");

    expect(await repository.begin("operation-retry", "request-a")).toEqual({
      started: true,
      reconcileExistingConfiguration: false,
    });

    await repository.markDeviceCreationStarted("operation-retry");
    await repository.fail("operation-retry", "platform_command_failed", "config write failed");

    expect(await repository.begin("operation-retry", "request-a")).toEqual({
      started: true,
      reconcileExistingConfiguration: true,
    });
  });

  test("retains creation provenance when replaying a completed operation", async () => {
    const repository = new ProvisionDeviceOperationRepository(db);

    await repository.begin("operation-created", "request-a");
    await repository.markDeviceCreationStarted("operation-created");
    await repository.complete("operation-created", { created: true });

    expect(await repository.begin("operation-created", "request-a")).toEqual({
      started: false,
      result: { created: true },
      reconcileExistingConfiguration: true,
    });
  });
});
