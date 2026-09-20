import { afterEach, describe, expect, test } from "bun:test";
import { DeviceLostError } from "../../src/daemon/emulatorLossIncident";
import type { RetiredProvisionedDeviceTransport } from "../../src/db/provisionedDeviceTransportTombstoneRepository";
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
    };
    const firstProcess = new DurableProvisionedDeviceTransportFence(store);
    await firstProcess.retire({
      deviceId: "emulator-5554",
      stableId: "phone-api-36-a",
      reason: "timeout",
    });
    setProvisionedDeviceTransportFenceForTests(new DurableProvisionedDeviceTransportFence(store));

    await expect(throwIfProvisionedDeviceTransportRetired("emulator-5554")).rejects.toMatchObject({
      code: "device_lost",
      deviceId: "emulator-5554",
    });
  });
});
