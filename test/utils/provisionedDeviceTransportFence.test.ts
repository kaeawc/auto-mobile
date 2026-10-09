import { afterEach, describe, expect, test } from "bun:test";
import { DeviceLostError } from "../../src/daemon/emulatorLossIncident";
import type { RetiredProvisionedDeviceTransport } from "../../src/db/provisionedDeviceTransportTombstoneRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  DurableProvisionedDeviceTransportFence,
  InMemoryProvisionedDeviceTransportFence,
  resetProvisionedDeviceTransportFenceForTests,
  setProvisionedDeviceTransportFenceForTests,
  throwIfProvisionedDeviceTransportRetired,
} from "../../src/utils/provisionedDeviceTransportFence";

describe("ProvisionedDeviceTransportFence", () => {
  afterEach(() => {
    resetProvisionedDeviceTransportFenceForTests();
  });

  test("returns typed device_lost for a retired provision transport", async () => {
    const fence = new InMemoryProvisionedDeviceTransportFence();
    setProvisionedDeviceTransportFenceForTests(fence);
    await fence.retire({
      deviceId: "emulator-5554",
      stableId: "phone-api-36-a",
      reason: "timeout",
    });

    await expect(throwIfProvisionedDeviceTransportRetired("emulator-5554")).rejects.toThrow(
      DeviceLostError,
    );
    try {
      await throwIfProvisionedDeviceTransportRetired("emulator-5554");
    } catch (error) {
      expect(error).toMatchObject({
        code: "device_lost",
        deviceId: "emulator-5554",
        message: expect.stringContaining("phone-api-36-a"),
      });
    }

    await expect(throwIfProvisionedDeviceTransportRetired("emulator-5554")).rejects.toMatchObject({
      code: "device_lost",
      deviceId: "emulator-5554",
    });
  });

  test("rehydrates retired transport evidence after the in-memory fence is replaced", async () => {
    let stored: RetiredProvisionedDeviceTransport | undefined;
    const store = {
      retire: async (input: RetiredProvisionedDeviceTransport) => {
        stored = input;
      },
      get: async (deviceId: string) => (stored?.deviceId === deviceId ? { ...stored } : undefined),
      clear: async () => {
        stored = undefined;
      },
    };
    const timer = new FakeTimer();
    const firstProcess = new DurableProvisionedDeviceTransportFence({ store, timer });
    await firstProcess.retire({
      deviceId: "emulator-5554",
      stableId: "phone-api-36-a",
      reason: "timeout",
    });
    setProvisionedDeviceTransportFenceForTests(
      new DurableProvisionedDeviceTransportFence({ store, timer }),
    );

    await expect(throwIfProvisionedDeviceTransportRetired("emulator-5554")).rejects.toMatchObject({
      code: "device_lost",
      deviceId: "emulator-5554",
    });
  });

  test("a different incarnation on a retired serial is usable and the tombstone is cleared (#11134)", async () => {
    const fence = new InMemoryProvisionedDeviceTransportFence();
    setProvisionedDeviceTransportFenceForTests(fence);
    await fence.retire({
      deviceId: "emulator-5554",
      stableId: "phone-api-36-a",
      reason: "timeout",
    });

    await expect(
      throwIfProvisionedDeviceTransportRetired("emulator-5554", {
        currentIdentity: async () => "phone-api-36-b",
      }),
    ).resolves.toBeUndefined();
    expect(await fence.get("emulator-5554")).toBeUndefined();
  });

  test("keeps the tombstone when the live identity matches or is unknown", async () => {
    const fence = new InMemoryProvisionedDeviceTransportFence();
    setProvisionedDeviceTransportFenceForTests(fence);
    await fence.retire({
      deviceId: "emulator-5554",
      stableId: "phone-api-36-a",
      reason: "timeout",
    });

    for (const currentIdentity of [async () => "phone-api-36-a", async () => undefined]) {
      await expect(
        throwIfProvisionedDeviceTransportRetired("emulator-5554", { currentIdentity }),
      ).rejects.toThrow(DeviceLostError);
    }
  });

  test("clear removes a durable tombstone from the store and memory", async () => {
    const stored = new Map<string, RetiredProvisionedDeviceTransport>();
    const store = {
      retire: async (input: RetiredProvisionedDeviceTransport) => {
        stored.set(input.deviceId, input);
      },
      get: async (deviceId: string) => stored.get(deviceId),
      clear: async (deviceId: string) => {
        stored.delete(deviceId);
      },
    };
    const fence = new DurableProvisionedDeviceTransportFence({ store, timer: new FakeTimer() });
    await fence.retire({ deviceId: "emulator-5554", stableId: "a", reason: "timeout" });
    await fence.clear("emulator-5554");
    expect(await fence.get("emulator-5554")).toBeUndefined();
    expect(stored.size).toBe(0);
  });
});
