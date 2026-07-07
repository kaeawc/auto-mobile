import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { NavigationGraphManager } from "../../../../src/features/navigation/NavigationGraphManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { AndroidCtrlProxyManager } from "../../../../src/utils/CtrlProxyManager";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { BootedDevice } from "../../../../src/models";
import {
  FakeWebSocket,
  WebSocketState
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeScreenshotBackoffScheduler } from "../../../../src/features/observe/ScreenshotBackoffScheduler";

describe("CtrlProxyPackages (Android)", function() {
  let fakeAdb: FakeAdbExecutor;
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  const serverPort: number = 8765;

  beforeEach(function() {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: `${serverPort}`, stderr: "" });
    fakeAdb.setScreenState(true);

    testDevice = {
      deviceId: "test-device-packages",
      platform: "android",
      isEmulator: true,
      name: "Test Device"
    };

    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.getInstance(testDevice, new FakeAdbClientFactory()).clearAvailabilityCache();
  });

  afterEach(function() {
    NavigationGraphManager.getInstance();
  });

  class CapturingWebSocket extends FakeWebSocket {
    sentMessages: string[] = [];
    send(data: any): void {
      this.sentMessages.push(data.toString());
      super.send(data);
    }
  }

  const createCapturingFactory = (timer?: FakeTimer): {
    factory: (url: string) => CapturingWebSocket;
    getSocket: () => CapturingWebSocket | null;
  } => {
    let socket: CapturingWebSocket | null = null;
    return {
      factory: (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, timer);
        return socket;
      },
      getSocket: () => socket
    };
  };

  const waitForSocketOpen = async (socket: FakeWebSocket | null): Promise<void> => {
    if (!socket || socket.readyState === WebSocketState.OPEN) {return;}
    await new Promise<void>(resolve => socket.once("open", () => resolve()));
  };

  const waitForSocket = async (getSocket: () => CapturingWebSocket | null): Promise<CapturingWebSocket | null> => {
    for (let i = 0; i < 5; i++) {
      const s = getSocket();
      if (s) {return s;}
      await new Promise(r => setImmediate(r));
    }
    return getSocket();
  };

  const waitForSentMessages = async (socket: CapturingWebSocket | null, minCount = 1): Promise<void> => {
    if (!socket) {return;}
    for (let i = 0; i < 10; i++) {
      if (socket.sentMessages.length >= minCount) {return;}
      await new Promise(r => setImmediate(r));
    }
  };

  /**
   * Find the most recent message of a given type. The client sends control messages
   * on connect (e.g. set_network_mock_rules) that interleave with test sends.
   */
  const findSentMessage = (socket: CapturingWebSocket, type: string): any => {
    for (let i = socket.sentMessages.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(socket.sentMessages[i]);
        if (parsed.type === type) {return parsed;}
      } catch {
        // skip
      }
    }
    throw new Error(`No message of type ${type} in: ${socket.sentMessages.join(", ")}`);
  };

  describe("connection lifecycle", function() {
    test("cancels screenshot backoff when the connection closes", function() {
      const { factory } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
      const scheduler = new FakeScreenshotBackoffScheduler();

      (client as any).screenshotBackoffScheduler = scheduler;
      (client as any).onConnectionClosed();

      expect(scheduler.cancelPendingCapturesCalls).toBe(1);
    });

    test("refreshes screenshot cadence by rescheduling keepalive", function() {
      const { factory } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
      const scheduler = new FakeScreenshotBackoffScheduler();

      (client as any).screenshotBackoffScheduler = scheduler;
      client.refreshObservationStreamScreenshotCadence();

      expect(scheduler.rescheduleKeepAliveCalls).toBe(1);
    });

    test("refreshes hierarchy cadence by sending interval config", async function() {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);

      const connected = await client.ensureConnected();
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      expect(connected).toBe(true);
      socket!.sentMessages = [];

      client.refreshObservationStreamHierarchyCadence(500);

      const message = findSentMessage(socket!, "set_hierarchy_interval");
      expect(message).toEqual({ type: "set_hierarchy_interval", intervalMs: 500 });
    });
  });

  describe("requestInstalledPackages", function() {
    test("sends request_installed_packages and resolves on result", async function() {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
      try {
        // Trigger a connection (any method that calls ensureConnected works)
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.requestInstalledPackages(true);
        await waitForSentMessages(socket, baseCount + 1);

        const sent = findSentMessage(socket!, "request_installed_packages");
        expect(sent.includeSystem).toBe(true);

        socket!.simulateMessage(JSON.stringify({
          type: "installed_packages_result",
          requestId: sent.requestId,
          success: true,
          userId: 0,
          packages: [
            { packageName: "com.example.app", isSystem: false, versionName: "1.0", versionCode: 1 },
            { packageName: "com.android.systemui", isSystem: true },
          ],
          totalTimeMs: 10,
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.userId).toBe(0);
        expect(result.packages).toHaveLength(2);
        expect(result.packages[0].packageName).toBe("com.example.app");
        expect(result.packages[0].isSystem).toBe(false);
        expect(result.packages[1].isSystem).toBe(true);
      } finally {
        await client.close();
      }
    });

    test("returns error when WebSocket not connected", async function() {
      const { factory } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
      try {
        const result = await client.requestInstalledPackages(true);
        expect(result.success).toBe(false);
        expect(result.error).toContain("WebSocket not connected");
      } finally {
        await client.close();
      }
    });
  });

  describe("requestPackageInfo", function() {
    test("sends request_package_info and resolves with package details", async function() {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.requestPackageInfo("com.example.app", { includePermissions: true });
        await waitForSentMessages(socket, baseCount + 1);

        const sent = findSentMessage(socket!, "request_package_info");
        expect(sent.packageName).toBe("com.example.app");
        expect(sent.includePermissions).toBe(true);

        socket!.simulateMessage(JSON.stringify({
          type: "package_info_result",
          requestId: sent.requestId,
          success: true,
          packageName: "com.example.app",
          isSystem: false,
          applicationLabel: "Example",
          versionName: "1.2.3",
          versionCode: 42,
          installerPackage: "com.android.vending",
          firstInstallTime: 100,
          lastUpdateTime: 200,
          allowBackup: true,
          requestedPermissions: ["android.permission.CAMERA"],
          grantedPermissions: { "android.permission.CAMERA": true },
          mainActivity: "com.example.app/.MainActivity",
          totalTimeMs: 5,
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.applicationLabel).toBe("Example");
        expect(result.versionName).toBe("1.2.3");
        expect(result.versionCode).toBe(42);
        expect(result.allowBackup).toBe(true);
        expect(result.grantedPermissions["android.permission.CAMERA"]).toBe(true);
        expect(result.mainActivity).toBe("com.example.app/.MainActivity");
      } finally {
        await client.close();
      }
    });

    test("returns error when package not found", async function() {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.requestPackageInfo("com.missing.app");
        await waitForSentMessages(socket, baseCount + 1);

        const sent = findSentMessage(socket!, "request_package_info");
        socket!.simulateMessage(JSON.stringify({
          type: "package_info_result",
          requestId: sent.requestId,
          success: false,
          packageName: "com.missing.app",
          error: "Package not installed or not visible: com.missing.app",
          totalTimeMs: 1,
        }));

        const result = await resultPromise;
        expect(result.success).toBe(false);
        expect(result.error).toContain("Package not installed");
      } finally {
        await client.close();
      }
    });
  });

  describe("requestLaunchIntent", function() {
    test("sends request_launch_intent and resolves with componentName", async function() {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.requestLaunchIntent("com.example.app");
        await waitForSentMessages(socket, baseCount + 1);

        const sent = findSentMessage(socket!, "request_launch_intent");
        expect(sent.packageName).toBe("com.example.app");

        socket!.simulateMessage(JSON.stringify({
          type: "launch_intent_result",
          requestId: sent.requestId,
          success: true,
          packageName: "com.example.app",
          componentName: "com.example.app/.MainActivity",
          totalTimeMs: 2,
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.componentName).toBe("com.example.app/.MainActivity");
      } finally {
        await client.close();
      }
    });
  });
});
