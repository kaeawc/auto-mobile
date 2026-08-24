import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import { BootedDevice } from "../../../../src/models";
import {
  createInstantFailureWebSocketFactory,
  createSuccessWebSocketFactory,
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeIOSCtrlProxyManager } from "../../../fakes/FakeIOSCtrlProxyManager";
import type {
  ServiceManagerFactory,
  BootedDeviceLister,
} from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import { IOSCtrlProxyManager } from "../../../../src/utils/IOSCtrlProxyManager";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("IOSCtrlProxyClient auto-setup", function () {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  let fakeManager: FakeIOSCtrlProxyManager;
  const serverPort = 8765;

  beforeEach(function () {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    testDevice = {
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      platform: "ios",
      name: "iPhone 16 Simulator",
    };

    fakeManager = new FakeIOSCtrlProxyManager();

    IOSCtrlProxyClient.resetInstances();
  });

  afterEach(async function () {
    IOSCtrlProxyClient.resetInstances();
  });

  const createManagerFactory = (): ServiceManagerFactory => {
    return () => fakeManager;
  };

  test("auto-setup triggered when WebSocket fails", async function () {
    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
    );

    await client.ensureConnected();

    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(true);

    await client.close();
  });

  test("connect succeeds after auto-setup starts service", async function () {
    let callCount = 0;
    const wsFactory = (url: string) => {
      callCount++;
      if (callCount <= 1) {
        // First call fails (before auto-setup)
        return createInstantFailureWebSocketFactory(fakeTimer)(url);
      }
      // After auto-setup, connection succeeds
      return createSuccessWebSocketFactory(fakeTimer)(url);
    };

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      wsFactory,
      fakeTimer,
      createManagerFactory(),
    );

    const result = await client.ensureConnected();

    expect(result).toBe(true);
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(true);

    await client.close();
  });

  test("retries on manager port when already-running service moved ports", async function () {
    fakeManager.setRunning(true);
    fakeManager.setServicePort(8767);
    const urls: string[] = [];
    let callCount = 0;
    const wsFactory = (url: string) => {
      urls.push(url);
      callCount++;
      if (callCount === 1) {
        return createInstantFailureWebSocketFactory(fakeTimer)(url);
      }
      return createSuccessWebSocketFactory(fakeTimer)(url);
    };

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      wsFactory,
      fakeTimer,
      createManagerFactory(),
    );

    const result = await client.ensureConnected();

    expect(result).toBe(true);
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(false);
    expect(urls).toEqual(["ws://localhost:8765/ws", "ws://localhost:8767/ws"]);

    await client.close();
  });

  test("getInstance reuses the device singleton when the service port changes", async function () {
    const client = IOSCtrlProxyClient.getInstance(testDevice, 8765);
    const sameClient = IOSCtrlProxyClient.getInstance(testDevice, 8767);

    expect(sameClient).toBe(client);
    expect((sameClient as unknown as { getWebSocketUrl: () => string }).getWebSocketUrl()).toBe(
      "ws://localhost:8767/ws",
    );

    await client.close();
  });

  test("port changes force the next connection to use the new WebSocket URL", async function () {
    const urls: string[] = [];
    const wsFactory = (url: string) => {
      urls.push(url);
      return createSuccessWebSocketFactory(fakeTimer)(url);
    };
    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      wsFactory,
      fakeTimer,
      createManagerFactory(),
    );

    expect(await client.ensureConnected()).toBe(true);

    (client as unknown as { updatePort: (port: number) => void }).updatePort(8767);

    expect(await client.ensureConnected()).toBe(true);
    expect(urls).toEqual(["ws://localhost:8765/ws", "ws://localhost:8767/ws"]);

    await client.close();
  });

  test("no auto-setup when already connected", async function () {
    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createSuccessWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
    );

    const result = await client.ensureConnected();

    expect(result).toBe(true);
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(false);

    await client.close();
  });

  test("waits for startup reaping before connecting directly to an existing runner", async function () {
    const reaping = deferred();
    const reapSpy = spyOn(
      IOSCtrlProxyManager,
      "reapOrphanedRunnerProcessesOnStartup",
    ).mockImplementation(() => reaping.promise);
    const urls: string[] = [];
    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      (url) => {
        urls.push(url);
        return createSuccessWebSocketFactory(fakeTimer)(url);
      },
      fakeTimer,
      createManagerFactory(),
    );

    try {
      IOSCtrlProxyManager.startOrphanRunnerReapOnStartup();
      const connecting = client.ensureConnected();
      await Promise.resolve();

      expect(urls).toEqual([]);

      reaping.resolve();
      await expect(connecting).resolves.toBe(true);
      expect(urls).toEqual(["ws://localhost:8765/ws"]);
    } finally {
      reaping.resolve();
      await client.close();
      reapSpy.mockRestore();
      IOSCtrlProxyManager.resetInstances();
    }
  });

  test("setup failure handled gracefully", async function () {
    fakeManager.setSetupShouldFail(true);

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
    );

    const result = await client.ensureConnected();

    expect(result).toBe(false);
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(true);

    await client.close();
  });

  test("guard prevents re-entry during auto-setup", async function () {
    // Create a manager where setup triggers another ensureConnected call
    let reentrantCallResult: boolean | null = null;
    // Use a ref object so the closure captures a mutable reference
    const clientRef: { current: IOSCtrlProxyClient | null } = { current: null };

    const reentrantManager = new FakeIOSCtrlProxyManager();
    const originalSetup = reentrantManager.setup.bind(reentrantManager);
    reentrantManager.setup = async (force, perf) => {
      // During setup, try calling ensureConnected again (simulates re-entry)
      reentrantCallResult = await clientRef.current!.ensureConnected();
      return originalSetup(force, perf);
    };

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      () => reentrantManager,
    );
    clientRef.current = client;

    await client.ensureConnected();

    // The re-entrant call should have returned false immediately
    expect(reentrantCallResult).toBe(false);

    await client.close();
  });

  test("skips auto-setup when target simulator is no longer booted", async function () {
    // Device lister returns empty — simulator has been shut down
    const lister: BootedDeviceLister = async () => [];

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
      lister,
    );

    const result = await client.ensureConnected();

    expect(result).toBe(false);
    // setup should NOT have been called since the simulator is not booted
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(false);

    await client.close();
  });

  test("skips auto-setup when a different simulator is booted", async function () {
    // A different simulator is booted, but not our target
    const otherDevice: BootedDevice = {
      deviceId: "FFFFFFFF-0000-1111-2222-333333333333",
      platform: "ios",
      name: "iPhone 15 Simulator",
    };
    const lister: BootedDeviceLister = async () => [otherDevice];

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
      lister,
    );

    const result = await client.ensureConnected();

    expect(result).toBe(false);
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(false);

    await client.close();
  });

  test("proceeds with auto-setup when target simulator is still booted", async function () {
    // Device lister returns our target simulator as booted
    const lister: BootedDeviceLister = async () => [testDevice];

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
      lister,
    );

    await client.ensureConnected();

    // setup should have been called since the simulator is booted
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(true);

    await client.close();
  });

  test("proceeds with auto-setup when boot check fails", async function () {
    // Device lister throws — should not prevent auto-setup
    const lister: BootedDeviceLister = async () => {
      throw new Error("simctl not available");
    };

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
      lister,
    );

    await client.ensureConnected();

    // setup should still proceed when boot check fails
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(true);

    await client.close();
  });
});
