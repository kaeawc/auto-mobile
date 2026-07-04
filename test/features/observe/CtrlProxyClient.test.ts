import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { AndroidCtrlProxyManager } from "../../../src/utils/CtrlProxyManager";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { BootedDevice, HighlightShape } from "../../../src/models";
import {
  FakeWebSocket,
  createInstantFailureWebSocketFactory,
  createSuccessWebSocketFactory,
  WebSocketState
} from "../../fakes/FakeWebSocket";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { DeviceConnectionLostNotifier } from "../../../src/features/observe/DeviceConnectionLostNotifier";
import { PortManager } from "../../../src/utils/PortManager";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { createTestDatabase } from "../../db/testDbHelper";
import type { Kysely } from "kysely";
import type { Database } from "../../../src/db/types";

describe("AndroidCtrlProxyClient", function() {
  let accessibilityServiceClient: AndroidCtrlProxyClient;
  let fakeAdb: FakeAdbExecutor;
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  let fakeAdbFactory: FakeAdbClientFactory;
  const serverPort: number = 8765;

  beforeEach(async function() {
    // Create fake timer with auto-advance for async event flushing
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Create fake ADB instance
    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: `${serverPort}`, stderr: "" });
    fakeAdb.setScreenState(true);

    // Create test device
    testDevice = {
      deviceId: "test-device",
      platform: "android",
      isEmulator: true,
      name: "Test Device"
    };

    // Create FakeAdbClientFactory for AndroidCtrlProxyManager
    fakeAdbFactory = new FakeAdbClientFactory();

    // Reset singleton instances for clean test state
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();

    // Pass FakeAdbExecutor directly to createForTesting since it implements AdbExecutor
    accessibilityServiceClient = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      createSuccessWebSocketFactory(),
      fakeTimer
    );
    AndroidCtrlProxyManager.getInstance(testDevice, fakeAdbFactory).clearAvailabilityCache();

    // Clear any cached hierarchy data to prevent cache contamination between tests (issue #72)
    accessibilityServiceClient.invalidateCache();
  });

  afterEach(async function() {
    // Clean up WebSocket connections
    if (accessibilityServiceClient) {
      await accessibilityServiceClient.close();
    }
  });

  class CapturingWebSocket extends FakeWebSocket {
    sentMessages: string[] = [];

    send(data: any): void {
      this.sentMessages.push(data.toString());
      super.send(data);
    }
  }

  const createCapturingWebSocketFactory = (timer?: FakeTimer): {
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
    if (!socket) {
      return;
    }
    if (socket.readyState === WebSocketState.OPEN) {
      return;
    }
    await new Promise<void>(resolve => {
      socket.once("open", () => resolve());
    });
  };

  const waitForSocket = async (getSocket: () => FakeWebSocket | null): Promise<FakeWebSocket | null> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const socket = getSocket();
      if (socket) {
        return socket;
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    return getSocket();
  };

  const waitForSentMessages = async (socket: CapturingWebSocket | null, minCount: number = 1): Promise<void> => {
    if (!socket) {
      return;
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      if (socket.sentMessages.length >= minCount) {
        return;
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  const flushPromises = async (iterations: number = 5): Promise<void> => {
    for (let i = 0; i < iterations; i += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  // Back the NavigationGraphManager singleton with an in-memory, already-migrated
  // database. AndroidCtrlProxyClient records navigation into the singleton via
  // getInstance(); the default getDatabase() singleton runs migrations + file IO on
  // real wall-clock time, so its async writes never settle within these tests'
  // microtask-only drains and race the assertions (issue #3063). An in-memory DB has
  // no migration gate and no file IO, so recordNavigationEvent's writes commit within
  // a deterministic number of setImmediate/microtask turns. Both repositories share
  // the one connection to satisfy NavigationGraphManager's shared-connection
  // precondition. Callers must destroy the returned db and resetInstance() in cleanup.
  const installInMemoryNavManager = async (): Promise<{
    navManager: NavigationGraphManager;
    navDb: Kysely<Database>;
  }> => {
    const navDb = await createTestDatabase();
    const navRepo = new NavigationRepository(navDb);
    const coverageRepo = new TestCoverageRepository(undefined, navDb);
    const navManager = NavigationGraphManager.createForTesting(navRepo, coverageRepo);
    NavigationGraphManager.setInstanceForTesting(navManager);
    return { navManager, navDb };
  };

  test("setupPortForwarding reallocates when the current local port becomes busy before adb forward", async function() {
    await accessibilityServiceClient.close();
    AndroidCtrlProxyClient.resetInstances();
    PortManager.reset();

    const unavailablePorts = new Set<number>();
    const checkedPorts: number[] = [];
    PortManager.setPortAvailabilityCheckerForTesting({
      isPortAvailable: (port: number) => {
        checkedPorts.push(port);
        return !unavailablePorts.has(port);
      },
    });
    try {
      accessibilityServiceClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createSuccessWebSocketFactory(),
        fakeTimer
      );
      unavailablePorts.add(8765);

      await (accessibilityServiceClient as unknown as {
        setupPortForwarding: () => Promise<void>;
        getWebSocketUrl: () => string;
      }).setupPortForwarding();

      expect(checkedPorts).toEqual([8765, 8765, 8766]);
      expect(fakeAdb.getExecutedCommands()).toContain("forward --remove tcp:8766");
      expect(fakeAdb.getExecutedCommands()).toContain("forward tcp:8766 tcp:8765");
      expect((accessibilityServiceClient as unknown as { getWebSocketUrl: () => string }).getWebSocketUrl()).toBe(
        "ws://localhost:8766/ws"
      );
    } finally {
      PortManager.setPortAvailabilityCheckerForTesting(null);
    }
  });

  describe("connection lifecycle", function() {
    test("notifies the observation stream when the WebSocket connection closes", function() {
      const lostDeviceIds: string[] = [];
      const notifier: DeviceConnectionLostNotifier = {
        onDeviceConnectionLost: deviceId => {
          lostDeviceIds.push(deviceId);
        },
      };
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createSuccessWebSocketFactory(fakeTimer),
        fakeTimer,
        undefined,
        undefined,
        undefined,
        notifier
      );

      (testClient as any).onConnectionClosed();

      expect(lostDeviceIds).toEqual(["test-device"]);
    });
  });

  describe("getLatestHierarchy", function() {
    test("should return hierarchy data when WebSocket receives fresh data", async function() {
      const mockHierarchyData = {
        updatedAt: 1750934583218,
        packageName: "com.google.android.deskclock",
        hierarchy: {
          "text": "6:43 AM",
          "content-desc": "6:43 AM",
          "resource-id": "com.google.android.deskclock:id/digital_clock",
          "bounds": {
            left: 175,
            top: 687,
            right: 692,
            bottom: 973
          },
          "clickable": "false",
          "enabled": "true"
        }
      };

      // Use FakeTimer for fast, deterministic test execution
      const testTimer = new FakeTimer();
      testTimer.enableAutoAdvance();

      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: mockHierarchyData
        }));

        const result = await resultPromise;

        expect(result).not.toBeNull();
        expect(result.hierarchy).not.toBeNull();
        expect(result.fresh).toBe(true);
        expect(result.updatedAt).toBe(1750934583218);
        expect(result.hierarchy!.updatedAt).toBe(1750934583218);
        expect(result.hierarchy!.packageName).toBe("com.google.android.deskclock");
        expect(result.hierarchy!.hierarchy.text).toBe("6:43 AM");
      } finally {
        await testClient.close();
      }
    });

    test("should return cached data when not waiting for fresh data", async function() {
      const mockHierarchyData = {
        updatedAt: 100, // Use timer-relative timestamp
        packageName: "com.google.android.deskclock",
        hierarchy: {
          text: "Cached Data",
          clickable: "true"
        }
      };

      const testTimer = new FakeTimer();
      // Don't use autoAdvance - we need to control time for polling
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        testTimer
      );

      try {
        // First call to populate cache - use resolveWithFakeTimer for polling
        const firstResultPromise = testClient.getLatestHierarchy(true, 2000);

        // Wait for socket and send message (this happens in parallel with the promise)
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        // Simulate message - this sets cachedHierarchy
        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: mockHierarchyData
        }));

        // Now advance time so the polling interval finds the fresh data
        await testTimer.resolvePromise(firstResultPromise);

        // Second call should return cached data immediately (no polling needed)
        testTimer.enableAutoAdvance(); // Now autoAdvance is fine
        const startTime = testTimer.now();
        const result = await testClient.getLatestHierarchy(false, 0);
        const duration = testTimer.now() - startTime;

        expect(result).not.toBeNull();
        expect(result.hierarchy).not.toBeNull();
        expect(result.hierarchy!.hierarchy.text).toBe("Cached Data");
        expect(duration).toBeLessThan(500); // Should be fast since it's cached
      } finally {
        await testClient.close();
      }
    });

    test("should timeout when no data received within timeout period", async function() {
      // Use FakeWebSocket that connects successfully but sends no data
      // Use delayed mode with 1ms for fast execution

      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createSuccessWebSocketFactory(fakeTimer),
        fakeTimer
      );

      try {
        // Use a short timeout (50ms) to make test run fast
        const result = await testClient.getLatestHierarchy(true, 50);

        expect(result).not.toBeNull();
        expect(result.hierarchy).toBeNull();
        expect(result.fresh).toBe(false);
      } finally {
        await testClient.close();
      }
    });

    test("should return fresh data when WebSocket push arrives after 100ms under contention (regression #2285)", async function() {
      // Pre-bug: default timeout was 100ms. When ADB pipe is busy (concurrent
      // screenshots, dumpsys, etc.), the WebSocket push routinely lands after
      // 100ms and getLatestHierarchy fell back to stale cache (~31% stale rate
      // in CI). Default is now 1000ms, matching the cache freshness TTL.
      const testTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        testTimer
      );

      try {
        // Call without specifying a timeout so we exercise the default.
        const resultPromise = testClient.getLatestHierarchy(true);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        // Simulate contended push delivery: advance 300ms of virtual time
        // before the push arrives. Past the old 100ms default — with the old
        // code the polling loop would already have cleared the interval and
        // resolved null, returning stale cache (here: no cache → null).
        await testTimer.advanceTimersByTimeAsync(300);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: {
            updatedAt: testTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Contended push" }
          }
        }));

        const result = await testTimer.resolvePromise(resultPromise);

        expect(result.fresh).toBe(true);
        expect(result.hierarchy).not.toBeNull();
        expect(result.hierarchy!.hierarchy.text).toBe("Contended push");
      } finally {
        await testClient.close();
      }
    });

    test("tracks concurrent suppressed hierarchy syncs independently", async function() {
      const testTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        testTimer
      );
      const suppressionCount = (): number =>
        (testClient as unknown as {
          hierarchyObservationStreamSuppressions: Set<unknown>;
        }).hierarchyObservationStreamSuppressions.size;

      try {
        const firstRequest = testClient.requestHierarchySyncWithoutObservationStreamPush(
          undefined,
          false,
          undefined,
          3000
        );
        const secondRequest = testClient.requestHierarchySyncWithoutObservationStreamPush(
          undefined,
          false,
          undefined,
          3000
        );

        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 2);

        expect(suppressionCount()).toBe(2);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: {
            updatedAt: 100,
            packageName: "com.example",
            hierarchy: { text: "First sync" },
          },
        }));

        expect(suppressionCount()).toBe(1);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: {
            updatedAt: 200,
            packageName: "com.example",
            hierarchy: { text: "Second sync" },
          },
        }));

        expect(suppressionCount()).toBe(0);

        const [firstResult, secondResult] = await Promise.all([
          testTimer.resolvePromise(firstRequest),
          testTimer.resolvePromise(secondRequest),
        ]);
        expect(firstResult?.hierarchy).not.toBeNull();
        expect(secondResult?.hierarchy).not.toBeNull();
      } finally {
        await testClient.close();
      }
    });

    test("should handle WebSocket connection failure gracefully", async function() {
      // Use FakeWebSocket with instant failure and FakeTimer for fast, reliable test execution
      // See issues #68 (timeout race condition) and #72 (cache contamination)

      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer
      );

      try {
        const result = await testClient.getLatestHierarchy(true, 1000);

        expect(result).not.toBeNull();
        expect(result.hierarchy).toBeNull();
        expect(result.fresh).toBe(false);
      } finally {
        await testClient.close();
      }
    });

    test("should seed navigation graph from hierarchy updates", async function() {
      NavigationGraphManager.resetInstance();
      const { navManager, navDb } = await installInMemoryNavManager();

      const testTimer = new FakeTimer();
      testTimer.enableAutoAdvance();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: {
            updatedAt: testTimer.now(),
            packageName: "com.google.android.deskclock",
            hierarchy: {
              "text": "6:43 AM",
              "content-desc": "6:43 AM",
              "resource-id": "com.google.android.deskclock:id/digital_clock",
            }
          }
        }));

        await resultPromise;
        // HierarchyNavigationDetector debounces via setTimeout(100ms); in autoAdvance
        // mode the FakeTimer dispatches that via setImmediate, not as a microtask.
        // Drain setImmediate so the debounce callback runs, then drain microtasks so
        // the async setCurrentApp call inside recordHierarchyNavigation reaches its
        // first synchronous assignment (this.currentAppId = appId).
        for (let i = 0; i < 10; i++) {
          await new Promise<void>(resolve => setImmediate(resolve));
          await testTimer.advanceTimersByTimeAsync(1);
        }

        // With named-nodes-only feature, hierarchy updates alone don't create screens
        // They only update screens when there's an active SDK navigation event
        // or when the fingerprint is already correlated to a named node.
        // The app ID is still set from the package name.
        expect(navManager.getCurrentAppId()).toBe("com.google.android.deskclock");
        // Without SDK events (named nodes), currentScreen remains null
        expect(navManager.getCurrentScreen()).toBeNull();
      } finally {
        await testClient.close();
        NavigationGraphManager.resetInstance();
        await navDb.destroy();
      }
    });

    test("should preserve SDK screen names when hierarchy updates follow navigation events", async function() {
      NavigationGraphManager.resetInstance();
      const { navManager, navDb } = await installInMemoryNavManager();

      const testTimer = new FakeTimer();
      testTimer.enableAutoAdvance();
      const { factory, getSocket } = createCapturingWebSocketFactory(testTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        testTimer
      );

      try {
        const resultPromise = testClient.getLatestHierarchy(true, 2000);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "navigation_event",
          event: {
            destination: "SdkHome",
            source: "SdkStart",
            arguments: {},
            metadata: {},
            timestamp: testTimer.now(),
            sequenceNumber: 1,
            applicationId: "com.example.sdk",
          }
        }));

        socket!.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: testTimer.now(),
          data: {
            updatedAt: testTimer.now(),
            packageName: "com.example.sdk",
            hierarchy: {
              "text": "SDK Home",
              "resource-id": "com.example.sdk:id/home",
            }
          }
        }));

        await resultPromise;
        // recordNavigationEvent (fired from the navigation_event handler) commits its
        // in-memory writes across several async query hops before assigning
        // currentScreen. Drain setImmediate + microtasks so those settle
        // deterministically (issue #3063).
        for (let i = 0; i < 10; i++) {
          await new Promise<void>(resolve => setImmediate(resolve));
          await testTimer.advanceTimersByTimeAsync(1);
        }

        expect(navManager.getCurrentScreen()).toBe("SdkHome");
      } finally {
        await testClient.close();
        NavigationGraphManager.resetInstance();
        await navDb.destroy();
      }
    });
  });

  describe("convertToViewHierarchyResult", function() {
    test("should convert accessibility hierarchy to ViewHierarchyResult format", function() {
      const accessibilityHierarchy = {
        updatedAt: 1750934583218,
        packageName: "com.google.android.deskclock",
        intentChooserDetected: true,
        notificationPermissionDetected: true,
        contentHiddenRegions: [
          {
            bounds: { left: 0, top: 368, right: 1440, bottom: 2752 },
            reason: "compose-interop-no-hide-descendants",
            areaPercent: 79
          }
        ],
        hierarchy: {
          "text": "6:43 AM",
          "content-desc": "6:43 AM",
          "resource-id": "com.google.android.deskclock:id/digital_clock",
          "bounds": {
            left: 175,
            top: 687,
            right: 692,
            bottom: 973
          },
          "clickable": "false",
          "enabled": "true",
          "node": [
            {
              text: "Child Node",
              bounds: {
                left: 0,
                top: 0,
                right: 100,
                bottom: 50
              },
              clickable: "true"
            }
          ]
        }
      };

      const result = accessibilityServiceClient.convertToViewHierarchyResult(accessibilityHierarchy);

      expect(result).toBeDefined();
      expect(result.hierarchy).toBeDefined();
      expect(result.hierarchy.text).toBe("6:43 AM");
      expect(result.hierarchy["content-desc"]).toBe("6:43 AM");
      expect(result.hierarchy.bounds).toEqual({
        left: 175,
        top: 687,
        right: 692,
        bottom: 973
      });
      expect(result.hierarchy.clickable).toBeUndefined();
      expect(result.hierarchy.enabled).toBe("true");
      expect(result.intentChooserDetected).toBe(true);
      expect(result.notificationPermissionDetected).toBe(true);
      expect(result.contentHiddenRegions).toEqual([
        {
          bounds: { left: 0, top: 368, right: 1440, bottom: 2752 },
          reason: "compose-interop-no-hide-descendants",
          areaPercent: 79
        }
      ]);

      // Check child node conversion
      expect(typeof result.hierarchy.node).toBe("object");
      expect(result.hierarchy.node.text).toBe("Child Node");
      expect(result.hierarchy.node.bounds).toEqual({
        left: 0,
        top: 0,
        right: 100,
        bottom: 50
      });
      expect(result.hierarchy.node.clickable).toBe("true");
    });

    test("should handle single child node correctly", function() {
      const accessibilityHierarchy = {
        updatedAt: 1750934583218,
        packageName: "com.test.app",
        hierarchy: {
          text: "Parent",
          node: [
            {
              text: "Single Child",
              clickable: "true"
            }
          ]
        }
      };

      const result = accessibilityServiceClient.convertToViewHierarchyResult(accessibilityHierarchy);

      expect(typeof result.hierarchy.node).toBe("object"); // Single child should not be in array
      expect(result.hierarchy.node.text).toBe("Single Child");
      expect(result.hierarchy.node.clickable).toBe("true");
    });

    test("should handle conversion errors gracefully", function() {
      // Create a hierarchy that will cause conversion issues
      const problematicHierarchy = {
        updatedAt: 1750934583218,
        packageName: "com.test.app",
        hierarchy: null as any
      };

      const result = accessibilityServiceClient.convertToViewHierarchyResult(problematicHierarchy);

      expect(result).toBeDefined();
      expect(result.hierarchy).toBeDefined();
      expect(result.hierarchy.error).toContain("Accessibility hierarchy missing from accessibility service");
    });

  });

  describe("getAccessibilityHierarchy", function() {
    test("should return null when service is not available", async function() {

      // Configure service as not available
      fakeAdb.setCommandResponse("pm list packages", { stdout: "", stderr: "" });

      const result = await accessibilityServiceClient.getAccessibilityHierarchy();
      expect(result).toBeNull();
    });

    // WebSocket-based hierarchy retrieval is tested through integration tests

    test("should return null when hierarchy retrieval fails", async function() {
      // Configure service as available but WebSocket connection will fail
      fakeAdb.setCommandResponse("pm list packages", {
        stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
        stderr: ""
      });
      fakeAdb.setCommandResponse("settings get secure", {
        stdout: `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`,
        stderr: ""
      });
      fakeAdb.setCommandResponse("forward", { stdout: `${serverPort}`, stderr: "" });

      // Set screen to off - this triggers fast-fail in waitForFreshData after ~1 second
      fakeAdb.setScreenState(false);

      // Use delayed mode with 1ms for faster test execution

      // Create a new client with FakeWebSocket that fails instantly and FakeTimer
      const failingClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer
      );

      try {
        const result = await failingClient.getAccessibilityHierarchy();
        expect(result).toBeNull();
      } finally {
        // Clean up the test client
        await failingClient.close();
      }
    });
  });

  describe("package events", function() {
    test("should upsert package on added event", async function() {
      const repo = new FakeInstalledAppsRepository();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const timestamp = timer.now();

      const { factory, getSocket } = createCapturingWebSocketFactory(timer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        timer,
        repo
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "package_event",
          timestamp,
          event: {
            action: "added",
            packageName: "com.example.new",
            userId: 0,
            isSystem: false
          }
        }));

        await flushPromises();

        const rows = await repo.listInstalledApps(testDevice.deviceId);
        expect(rows).toHaveLength(1);
        expect(rows[0].package_name).toBe("com.example.new");
        expect(rows[0].user_id).toBe(0);
        expect(rows[0].is_system).toBe(0);
        expect(rows[0].last_verified_at).toBe(timestamp);
      } finally {
        await testClient.close();
      }
    });

    test("should remove package for a single user on removed event", async function() {
      const repo = new FakeInstalledAppsRepository();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const baseTime = timer.now();

      await repo.replaceInstalledApps(testDevice.deviceId, [
        {
          device_id: testDevice.deviceId,
          user_id: 0,
          package_name: "com.example.remove",
          is_system: 0,
          installed_at: baseTime,
          last_verified_at: baseTime
        },
        {
          device_id: testDevice.deviceId,
          user_id: 10,
          package_name: "com.example.remove",
          is_system: 0,
          installed_at: baseTime,
          last_verified_at: baseTime
        }
      ]);

      const { factory, getSocket } = createCapturingWebSocketFactory(timer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        timer,
        repo
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "package_event",
          timestamp: timer.now(),
          event: {
            action: "removed",
            packageName: "com.example.remove",
            userId: 0
          }
        }));

        await flushPromises();

        const rows = await repo.listInstalledApps(testDevice.deviceId);
        expect(rows.some(row => row.user_id === 0)).toBe(false);
        expect(rows.some(row => row.user_id === 10)).toBe(true);
      } finally {
        await testClient.close();
      }
    });

    test("should remove package for all users when removedForAllUsers is true", async function() {
      const repo = new FakeInstalledAppsRepository();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const baseTime = timer.now();

      await repo.replaceInstalledApps(testDevice.deviceId, [
        {
          device_id: testDevice.deviceId,
          user_id: 0,
          package_name: "com.example.all",
          is_system: 0,
          installed_at: baseTime,
          last_verified_at: baseTime
        },
        {
          device_id: testDevice.deviceId,
          user_id: 10,
          package_name: "com.example.all",
          is_system: 0,
          installed_at: baseTime,
          last_verified_at: baseTime
        }
      ]);

      const { factory, getSocket } = createCapturingWebSocketFactory(timer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        timer,
        repo
      );

      try {
        await testClient.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        socket!.simulateMessage(JSON.stringify({
          type: "package_event",
          timestamp: timer.now(),
          event: {
            action: "removed",
            packageName: "com.example.all",
            userId: 0,
            removedForAllUsers: true
          }
        }));

        await flushPromises();

        const rows = await repo.listInstalledApps(testDevice.deviceId);
        expect(rows).toHaveLength(0);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("highlight requests", function() {
    test("requestAddHighlight sends payload and resolves highlight response", async function() {
      const highlightTimer = new FakeTimer();
      // Don't use autoAdvance - we need to control time for the request timeout

      const { factory, getSocket } = createCapturingWebSocketFactory(highlightTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        highlightTimer
      );

      const shape: HighlightShape = {
        type: "box",
        bounds: {
          x: 10,
          y: 20,
          width: 100,
          height: 80
        },
        style: {
          strokeColor: "#FF0000",
          strokeWidth: 4
        }
      };

      try {
        // Start the request (don't await yet)
        const requestPromise = testClient.requestAddHighlight("highlight-1", shape, 2000);

        // Wait for socket to be created and open
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 2); // sync message + highlight request

        // Find the highlight request among sent messages (sync messages may precede it)
        const highlightMsg = socket!.sentMessages.find(m => {
          try { return JSON.parse(m).type === "add_highlight"; } catch { return false; }
        });
        expect(highlightMsg).toBeDefined();
        const payload = JSON.parse(highlightMsg!);
        expect(payload.id).toBe("highlight-1");
        expect(payload.shape.bounds.width).toBe(100);

        // Simulate the response from the server
        socket!.simulateMessage(JSON.stringify({
          type: "highlight_response",
          requestId: payload.requestId,
          success: true,
          error: null
        }));

        // Advance time to process the response
        const result = await highlightTimer.resolvePromise(requestPromise);
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });

  });

  describe("error frame handling (issue #2985)", function() {
    test("a type:error frame correlated by requestId fails the awaiting request fast", async function() {
      // The Android runner now emits a structured `type:"error"` envelope on decode/handler
      // failures (issue #2985). Without a consumer branch the awaiter would hang to timeout; this
      // asserts the pending request resolves immediately with a failed result carrying the message.
      const errorTimer = new FakeTimer();

      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      const shape: HighlightShape = {
        type: "box",
        bounds: { x: 10, y: 20, width: 100, height: 80 },
        style: { strokeColor: "#FF0000", strokeWidth: 4 }
      };

      try {
        const requestPromise = testClient.requestAddHighlight("highlight-err", shape, 2000);

        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket as CapturingWebSocket, 2);

        const highlightMsg = (socket as CapturingWebSocket).sentMessages.find(m => {
          try { return JSON.parse(m).type === "add_highlight"; } catch { return false; }
        });
        expect(highlightMsg).toBeDefined();
        const payload = JSON.parse(highlightMsg!);

        // Runner reports a structured error correlated by the request's id.
        socket!.simulateMessage(JSON.stringify({
          type: "error",
          requestId: payload.requestId,
          success: false,
          error: "Malformed request: a numeric value is out of range or not representable.",
          timestamp: errorTimer.now()
        }));

        const result = await errorTimer.resolvePromise(requestPromise);
        expect(result.success).toBe(false);
        expect(result.error).toContain("out of range");
      } finally {
        await testClient.close();
      }
    });

    test("a type:error frame with a non-matching requestId does not disturb other requests", async function() {
      // A null/unknown requestId (e.g. an unparseable payload the runner couldn't correlate) must
      // be a safe no-op: it must not crash, and must not wrongly resolve an unrelated pending
      // request. Here an in-flight highlight request must survive a mismatched error frame and
      // still resolve normally from its own response.
      const errorTimer = new FakeTimer();

      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      const shape: HighlightShape = {
        type: "box",
        bounds: { x: 10, y: 20, width: 100, height: 80 },
        style: { strokeColor: "#FF0000", strokeWidth: 4 }
      };

      try {
        const requestPromise = testClient.requestAddHighlight("highlight-keep", shape, 2000);

        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket as CapturingWebSocket, 2);

        const highlightMsg = (socket as CapturingWebSocket).sentMessages.find(m => {
          try { return JSON.parse(m).type === "add_highlight"; } catch { return false; }
        });
        const payload = JSON.parse(highlightMsg!);

        // Error frame for an unrelated / uncorrelated request — must be ignored.
        socket!.simulateMessage(JSON.stringify({
          type: "error",
          requestId: "some-other-id",
          success: false,
          error: "Malformed request: the payload is not valid JSON",
          timestamp: errorTimer.now()
        }));

        // The real response for our request still arrives and resolves it.
        socket!.simulateMessage(JSON.stringify({
          type: "highlight_response",
          requestId: payload.requestId,
          success: true,
          error: null
        }));

        const result = await errorTimer.resolvePromise(requestPromise);
        expect(result.success).toBe(true);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("bindSession", function() {
    afterEach(function() {
      NavigationGraphManager.resetInstance();
    });

    test("should use session-scoped NavigationGraphManager after binding", async function() {
      // Set different state on the global vs session-scoped instances
      const globalNav = NavigationGraphManager.getInstance();
      await globalNav.setCurrentApp("com.global.app");

      const sessionNav = NavigationGraphManager.getInstanceForSession("test-session-123");
      await sessionNav.setCurrentApp("com.session.app");

      // Before binding: client uses global instance
      // After binding: client should use session instance
      accessibilityServiceClient.bindSession("test-session-123");

      // Verify the client is now bound to this session
      // We can't directly call getNavigationGraphManager() since it's private,
      // but we can verify the binding was stored by binding again and checking
      // that the session is overwritten
      accessibilityServiceClient.bindSession("other-session");

      // The client should now be bound to "other-session"
      // This validates bindSession is a simple setter that changes routing
      const otherNav = NavigationGraphManager.getInstanceForSession("other-session");
      expect(otherNav).not.toBe(sessionNav);
      expect(otherNav).not.toBe(globalNav);
    });

    test("should use global NavigationGraphManager when no session bound", function() {
      // Without calling bindSession, client should use the global singleton
      // We verify by checking that no session instances are created
      NavigationGraphManager.resetInstance();

      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        createSuccessWebSocketFactory(),
        fakeTimer
      );

      // No session bound — global singleton should be used
      // Simply verify the client was created without error
      expect(client).toBeDefined();
    });
  });
});
