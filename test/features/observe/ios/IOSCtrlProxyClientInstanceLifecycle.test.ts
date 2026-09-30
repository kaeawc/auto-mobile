import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import type { BootedDevice } from "../../../../src/models";
import { PortManager } from "../../../../src/utils/PortManager";

const device: BootedDevice = {
  deviceId: "lifecycle-test-ios-device",
  platform: "ios",
  name: "iPhone test device",
};

class FakePortManager {
  readonly allocations = new Map<string, number>();
  allocateCalls = 0;
  nextPort = 9000;

  allocate(deviceId: string): number {
    this.allocateCalls++;
    const existing = this.allocations.get(deviceId);
    if (existing !== undefined) {
      return existing;
    }
    const port = this.nextPort++;
    this.allocations.set(deviceId, port);
    return port;
  }

  releaseIfAllocated(deviceId: string, port: number): void {
    if (this.allocations.get(deviceId) === port) {
      this.allocations.delete(deviceId);
    }
  }
}

describe("IOSCtrlProxyClient instance lifecycle", () => {
  const ports = new FakePortManager();
  const restores: Array<() => void> = [];

  function createRegisteredClient(): IOSCtrlProxyClient {
    return IOSCtrlProxyClient.getInstance(device);
  }

  beforeEach(() => {
    IOSCtrlProxyClient.resetInstances();
    ports.allocations.clear();
    ports.allocateCalls = 0;
    ports.nextPort = 9000;
    const allocate = spyOn(PortManager, "allocate").mockImplementation((deviceId) =>
      ports.allocate(deviceId),
    );
    const release = spyOn(PortManager, "releaseIfAllocated").mockImplementation((deviceId, port) =>
      ports.releaseIfAllocated(deviceId, port),
    );
    restores.push(
      () => allocate.mockRestore(),
      () => release.mockRestore(),
    );
  });

  afterEach(() => {
    IOSCtrlProxyClient.resetInstances();
    for (const restore of restores.splice(0)) {
      restore();
    }
  });

  test("close evicts the registered client and releases its port", async () => {
    const client = createRegisteredClient();
    const port = client.getConnectionPortForDiagnostics();

    await client.close();

    expect(IOSCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
    expect(ports.allocations.has(device.deviceId)).toBe(false);
    const replacement = IOSCtrlProxyClient.getInstance(device);
    expect(replacement).not.toBe(client);
    expect(replacement.getConnectionPortForDiagnostics()).not.toBe(port);
  });

  test("a live lookup leaves the client's port untouched after manager port release", async () => {
    const client = createRegisteredClient();
    const port = client.getConnectionPortForDiagnostics();
    ports.allocations.delete(device.deviceId);
    ports.allocate("another-device");
    const allocationsBefore = ports.allocateCalls;

    expect(IOSCtrlProxyClient.getInstance(device)).toBe(client);
    expect(client.getConnectionPortForDiagnostics()).toBe(port);
    expect(ports.allocateCalls).toBe(allocationsBefore);
    await client.close();
  });

  test("an explicit manager port re-ports the live client without allocating", async () => {
    const client = IOSCtrlProxyClient.getInstance(device, 8765);
    const allocationsBefore = ports.allocateCalls;

    expect(IOSCtrlProxyClient.getInstance(device, 8767)).toBe(client);
    expect(client.getConnectionPortForDiagnostics()).toBe(8767);
    expect(ports.allocateCalls).toBe(allocationsBefore);
    await client.close();
  });

  test("closing a detached probe keeps the shared allocation", async () => {
    const managerPort = ports.allocate(device.deviceId);
    const detached = IOSCtrlProxyClient.createDetached(device);

    expect(detached.getConnectionPortForDiagnostics()).toBe(managerPort);
    await detached.close();

    expect(ports.allocations.get(device.deviceId)).toBe(managerPort);
  });

  test("closing a client with an explicit manager port keeps the allocation", async () => {
    const managerPort = ports.allocate(device.deviceId);
    const client = IOSCtrlProxyClient.getInstance(device, managerPort);

    await client.close();

    expect(IOSCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
    expect(ports.allocations.get(device.deviceId)).toBe(managerPort);
  });

  test("re-porting clears ownership of the client's previous allocation", async () => {
    const client = createRegisteredClient();
    const managerPort = ports.nextPort++;
    ports.allocations.set(device.deviceId, managerPort);

    IOSCtrlProxyClient.getInstance(device, managerPort);
    await client.close();

    expect(ports.allocations.get(device.deviceId)).toBe(managerPort);
  });

  test("retirement evicts and releases the old client; resume allocates a fresh port", async () => {
    const client = createRegisteredClient();
    const oldPort = client.getConnectionPortForDiagnostics();

    await IOSCtrlProxyClient.retireInstance(device.deviceId);
    expect(IOSCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
    expect(ports.allocations.has(device.deviceId)).toBe(false);

    const tombstone = IOSCtrlProxyClient.getInstance(device);
    expect(tombstone).not.toBe(client);
    expect(await tombstone.ensureConnected()).toBe(false);
    expect(ports.allocateCalls).toBe(1);

    IOSCtrlProxyClient.resumeAfterDeviceStart(device.deviceId);
    const fresh = IOSCtrlProxyClient.getInstance(device);
    expect(fresh).not.toBe(tombstone);
    expect(fresh.getConnectionPortForDiagnostics()).not.toBe(oldPort);
    expect(ports.allocateCalls).toBe(2);
  });

  test("repeated create and close does not retain ports", async () => {
    for (let index = 0; index < 5; index++) {
      const client = IOSCtrlProxyClient.getInstance(device);
      await client.close();
      expect(ports.allocations.size).toBe(0);
    }
    expect(ports.allocateCalls).toBe(5);
  });
});
