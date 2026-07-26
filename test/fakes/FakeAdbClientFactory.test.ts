import { describe, it, expect, beforeEach } from "bun:test";
import { FakeAdbClientFactory } from "./FakeAdbClientFactory";
import { FakeAdbClient } from "./FakeAdbClient";
import { FakeAdbExecutor } from "./FakeAdbExecutor";
import type { BootedDevice } from "../../src/models";

describe("FakeAdbClientFactory", () => {
  let factory: FakeAdbClientFactory;

  const testDevice: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel_6_API_34",
    platform: "android",
  };

  beforeEach(() => {
    factory = new FakeAdbClientFactory();
  });

  describe("create", () => {
    it("returns the shared FakeAdbClient by default", () => {
      const client1 = factory.create(testDevice);
      const client2 = factory.create(testDevice);

      expect(client1).toBe(client2);
      expect(client1).toBe(factory.getFakeClient());
    });

    it("records all create() calls", () => {
      factory.create(testDevice);
      factory.create(null);
      factory.create();

      const calls = factory.getCalls();
      expect(calls).toHaveLength(3);
      expect(calls[0].device).toEqual(testDevice);
      expect(calls[1].device).toBeNull();
      expect(calls[2].device).toBeNull();
    });
  });

  describe("useSeparateClientsPerDevice", () => {
    it("returns different clients for different devices", () => {
      factory.useSeparateClientsPerDevice();

      const device2: BootedDevice = {
        deviceId: "emulator-5556",
        name: "Pixel_7_API_34",
        platform: "android",
      };

      const client1 = factory.create(testDevice);
      const client2 = factory.create(device2);

      expect(client1).not.toBe(client2);
    });

    it("returns the same client for the same device", () => {
      factory.useSeparateClientsPerDevice();

      const client1 = factory.create(testDevice);
      const client2 = factory.create(testDevice);

      expect(client1).toBe(client2);
    });
  });

  describe("wasCalledForDevice", () => {
    it("returns true if device was used", () => {
      factory.create(testDevice);

      expect(factory.wasCalledForDevice("emulator-5554")).toBe(true);
      expect(factory.wasCalledForDevice("emulator-5556")).toBe(false);
    });
  });

  describe("with custom FakeAdbClient", () => {
    it("uses the provided fake client", () => {
      const customFake = new FakeAdbClient();
      factory = new FakeAdbClientFactory(customFake);

      const client = factory.create(testDevice);
      expect(client).toBe(customFake);
    });
  });

  describe("wrapping a configured AdbExecutor", () => {
    it("returns the exact executor it was constructed with", async () => {
      const executor = new FakeAdbExecutor();
      const wrapping = new FakeAdbClientFactory(executor);

      const client = wrapping.create(testDevice);

      // create() must return the SAME object so command config / assertions land on it.
      expect(client).toBe(executor);
      await client.executeCommand("shell echo hi");
      expect(executor.wasCommandExecuted("shell echo hi")).toBe(true);
      expect(wrapping.getCallCount()).toBe(1);
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      factory.create(testDevice);
      factory.useSeparateClientsPerDevice();
      factory.create(testDevice);

      factory.reset();

      expect(factory.getCalls()).toHaveLength(0);
      expect(factory.getCallCount()).toBe(0);
    });
  });
});

describe("FakeAdbClientFactory routing and reset outcomes", () => {
  const deviceA: BootedDevice = { deviceId: "emulator-5554", name: "A", platform: "android" };
  const deviceB: BootedDevice = { deviceId: "emulator-5556", name: "B", platform: "android" };

  it("routes commands to the same shared client regardless of device in shared mode", async () => {
    const factory = new FakeAdbClientFactory();
    factory.getFakeClient().setCommandResult("shell echo hi", "hi-from-shared");

    const fromA = await factory.create(deviceA).executeCommand("shell echo hi");
    const fromB = await factory.create(deviceB).executeCommand("shell echo hi");

    // Both devices resolve to the one shared client, so the configured result
    // is observed for either device.
    expect(fromA.stdout).toBe("hi-from-shared");
    expect(fromB.stdout).toBe("hi-from-shared");
  });

  it("routes each device to its own client in per-device mode", () => {
    const factory = new FakeAdbClientFactory();
    factory.useSeparateClientsPerDevice();

    const clientA = factory.create(deviceA);
    const clientB = factory.create(deviceB);

    expect(clientA).not.toBe(clientB);
    expect(factory.getClientForDevice("emulator-5554")).toBe(clientA);
    expect(factory.getClientForDevice("emulator-5556")).toBe(clientB);
  });

  it("reset() swaps in a fresh shared client, discarding prior configuration", async () => {
    const factory = new FakeAdbClientFactory();
    const original = factory.getFakeClient();
    original.setCommandResult("shell echo hi", "configured");

    factory.reset();

    const replacement = factory.getFakeClient();
    // The observable outcome of reset: a brand-new client, so a command
    // configured on the old one no longer resolves (this is the #108-113 swap
    // that was previously unasserted).
    expect(replacement).not.toBe(original);
    const result = await factory.create(deviceA).executeCommand("shell echo hi");
    expect(result.stdout).not.toBe("configured");
  });

  it("reset() reverts per-device routing back to shared mode", () => {
    const factory = new FakeAdbClientFactory();
    factory.useSeparateClientsPerDevice();
    factory.create(deviceA);

    factory.reset();

    // After reset the factory is back in shared mode: both devices get one client.
    expect(factory.create(deviceA)).toBe(factory.create(deviceB));
  });
});
