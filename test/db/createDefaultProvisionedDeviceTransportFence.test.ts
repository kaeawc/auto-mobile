import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import {
  createDefaultProvisionedDeviceTransportFence,
  installDefaultProvisionedDeviceTransportFence,
} from "../../src/db/createDefaultProvisionedDeviceTransportFence";
import {
  DurableProvisionedDeviceTransportFence,
  InMemoryProvisionedDeviceTransportFence,
  getProvisionedDeviceTransportFence,
  resetProvisionedDeviceTransportFenceForTests,
  setProvisionedDeviceTransportFenceForTests,
  throwIfProvisionedDeviceTransportRetired,
} from "../../src/utils/provisionedDeviceTransportFence";
import { FakeTimer } from "../fakes/FakeTimer";
import { createTestDatabase } from "./testDbHelper";

describe("default provisioned device transport fence", () => {
  let database: Kysely<Database>;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterEach(() => {
    resetProvisionedDeviceTransportFenceForTests();
  });

  afterAll(async () => {
    await database.destroy();
  });

  test("production installation persists through the repository and rehydrates a fresh fence", async () => {
    resetProvisionedDeviceTransportFenceForTests({ isTest: false });
    const timer = new FakeTimer();
    timer.advanceTime(1234);
    const options = { isTest: false, database, timer };
    const fence = installDefaultProvisionedDeviceTransportFence(options);
    expect(fence).toBeInstanceOf(DurableProvisionedDeviceTransportFence);
    expect(fence).not.toBeInstanceOf(InMemoryProvisionedDeviceTransportFence);
    expect(getProvisionedDeviceTransportFence()).toBe(fence);
    const retired = {
      deviceId: "emulator-5554",
      stableId: "phone-api-36-a",
      reason: "timeout",
    };
    await fence.retire(retired);

    expect(
      await database
        .selectFrom("provisioned_device_transport_tombstones")
        .selectAll()
        .where("device_id", "=", retired.deviceId)
        .executeTakeFirst(),
    ).toEqual({
      device_id: retired.deviceId,
      stable_id: retired.stableId,
      reason: retired.reason,
      retired_at_ms: 1234,
    });
    const freshFence = createDefaultProvisionedDeviceTransportFence(options);
    expect(freshFence).not.toBe(fence);
    expect(freshFence).toBeInstanceOf(DurableProvisionedDeviceTransportFence);
    await expect(freshFence.get(retired.deviceId)).resolves.toEqual(retired);
    expect(installDefaultProvisionedDeviceTransportFence(options)).toBe(fence);
  });

  test("clear deletes the durable tombstone row (#11134)", async () => {
    const fence = createDefaultProvisionedDeviceTransportFence({ isTest: false, database });
    await fence.retire({ deviceId: "emulator-5556", stableId: "phone", reason: "timeout" });
    await fence.clear("emulator-5556");
    const row = await database
      .selectFrom("provisioned_device_transport_tombstones")
      .selectAll()
      .where("device_id", "=", "emulator-5556")
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  test("an unwired production holder fails loudly for both reads and session checks", async () => {
    resetProvisionedDeviceTransportFenceForTests({ isTest: false });
    expect(getProvisionedDeviceTransportFence).toThrow("fence is not installed");
    await expect(throwIfProvisionedDeviceTransportRetired("emulator-5554")).rejects.toThrow(
      "fence is not installed",
    );
  });

  test("production construction defers the default database until fence use", () => {
    expect(createDefaultProvisionedDeviceTransportFence({ isTest: false })).toBeInstanceOf(
      DurableProvisionedDeviceTransportFence,
    );
  });

  test("test construction and reset keep the in-memory default without resolving a database", async () => {
    resetProvisionedDeviceTransportFenceForTests({ isTest: false });
    const fence = installDefaultProvisionedDeviceTransportFence({ isTest: true });
    expect(fence).toBeInstanceOf(InMemoryProvisionedDeviceTransportFence);
    await fence.retire({ deviceId: "emulator-5554", stableId: "phone", reason: "timeout" });
    resetProvisionedDeviceTransportFenceForTests();
    expect(getProvisionedDeviceTransportFence()).toBeInstanceOf(
      InMemoryProvisionedDeviceTransportFence,
    );
    await expect(
      getProvisionedDeviceTransportFence().get("emulator-5554"),
    ).resolves.toBeUndefined();
  });

  test("startup registration preserves an explicitly injected test fence", () => {
    const fence = new InMemoryProvisionedDeviceTransportFence();
    setProvisionedDeviceTransportFenceForTests(fence);
    expect(installDefaultProvisionedDeviceTransportFence({ isTest: false })).toBe(fence);
  });
});
