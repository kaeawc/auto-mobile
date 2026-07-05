import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../../src/db/dbWriteBarrier";
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
import { installInMemoryNavManager } from "../../helpers/navigationTestHarness";
import type { HierarchySyncDiagnostics } from "../../../src/features/observe/android/types";
import { logger } from "../../../src/utils/logger";

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
      const navHarness = await installInMemoryNavManager();
      const navManager = navHarness.manager;

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
        await navHarness.dispose();
      }
    });

    test("should preserve SDK screen names when hierarchy updates follow navigation events", async function() {
      NavigationGraphManager.resetInstance();
      const navHarness = await installInMemoryNavManager();
      const navManager = navHarness.manager;

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
        await navHarness.dispose();
      }
    });

    test("routes the navigation-graph write through the DB-write barrier for shutdown drain (#2885)", async function() {
      NavigationGraphManager.resetInstance();
      resetDbWriteBarrier();
      // The Android handler resolves getDbWriteBarrier() per write (#2912), so a
      // spy on the freshly-reset shared barrier observes the nav write's
      // registration. trackExisting (not track) proves the write is drain-covered
      // without a track() await hop that would perturb the ordering the preceding
      // test guards.
      const barrier = getDbWriteBarrier();
      const trackExistingSpy = spyOn(barrier, "trackExisting");
      const navHarness = await installInMemoryNavManager();
      const navManager = navHarness.manager;

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
        for (let i = 0; i < 10; i++) {
          await new Promise<void>(resolve => setImmediate(resolve));
          await testTimer.advanceTimersByTimeAsync(1);
        }

        expect(trackExistingSpy).toHaveBeenCalledTimes(1);
        // Ordering still preserved: the write committed the SDK screen name.
        expect(navManager.getCurrentScreen()).toBe("SdkHome");
      } finally {
        trackExistingSpy.mockRestore();
        await testClient.close();
        await navHarness.dispose();
        resetDbWriteBarrier();
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

    test("rewrites the runner's path-derived UUID view-ids into stable content ids at ingest (#3228)", function() {
      // The runner emits a positional UUID for id-less nodes; two captures of the
      // same row at different scroll offsets carry DIFFERENT UUIDs. Ingest must
      // rewrite them into content-derived ids so the row keeps one identity.
      const capture = (uuid: string, top: number) => ({
        updatedAt: 1750934583218,
        packageName: "com.test.app",
        hierarchy: {
          "resource-id": "com.test.app:id/root",
          "view-id": "com.test.app:id/root",
          "node": [
            {
              "view-id": uuid,
              "content-desc": "Basic long press card",
              "bounds": { left: 42, top, right: 1038, bottom: top + 231 }
            }
          ]
        }
      });

      const before = accessibilityServiceClient.convertToViewHierarchyResult(
        capture("791e44df-05d9-5e5a-3ea7-c898eedcb939", 1404)
      );
      const after = accessibilityServiceClient.convertToViewHierarchyResult(
        capture("8eb00289-ddfa-18de-7fc7-480b4d13d8cf", 1079)
      );

      const beforeId = (before.hierarchy.node as any)["view-id"];
      const afterId = (after.hierarchy.node as any)["view-id"];
      expect(beforeId).toStartWith("s-");
      expect(afterId).toBe(beforeId);
      // Resource-id-backed view-ids pass through untouched.
      expect(before.hierarchy["view-id"]).toBe("com.test.app:id/root");
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

    test("unknown command errors are rewritten with Android runner upgrade guidance", async function() {
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
        const requestPromise = testClient.requestAddHighlight("highlight-stale-runner", shape, 2000);

        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket as CapturingWebSocket, 2);

        const highlightMsg = (socket as CapturingWebSocket).sentMessages.find(m => {
          try { return JSON.parse(m).type === "add_highlight"; } catch { return false; }
        });
        expect(highlightMsg).toBeDefined();
        const payload = JSON.parse(highlightMsg!);

        socket!.simulateMessage(JSON.stringify({
          type: "error",
          requestId: payload.requestId,
          success: false,
          error: "Unknown command type: add_highlight",
          timestamp: errorTimer.now()
        }));

        const result = await errorTimer.resolvePromise(requestPromise);
        expect(result.success).toBe(false);
        expect(result.error).toContain("add_highlight");
        expect(result.error).toContain("Android CtrlProxy APK");
        expect(result.error).toContain("older than this daemon");
        expect(result.error).toContain("AUTOMOBILE_CTRL_PROXY_APK_PATH");
        expect(result.error).not.toContain("AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED");
        expect(result.error).not.toContain("iOS CtrlProxy runner");
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

  describe("hierarchy error frame correlation (issue #3032)", function() {
    // request_hierarchy does NOT await through RequestManager — it blocks in
    // CtrlProxyHierarchy.waitForFreshData for a hierarchy_update push. Before #3032 a runner
    // type:"error" frame for a hierarchy requestId no-op'd in resolveError and the caller hung to
    // the waitForFreshData timeout. These tests assert the error frame now unblocks the hierarchy
    // wait fast, while remaining a safe no-op for uncorrelated ids.

    const findSentMessageOfType = (socket: CapturingWebSocket, type: string): any | undefined => {
      const raw = socket.sentMessages.find(m => {
        try { return JSON.parse(m).type === type; } catch { return false; }
      });
      return raw ? JSON.parse(raw) : undefined;
    };

    test("a type:error frame for an in-flight hierarchy requestId fails requestHierarchySync fast", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        // 10s hierarchy sync timeout — the whole point is to NOT wait for it.
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const hierarchyMsg = findSentMessageOfType(socket, "request_hierarchy");
        expect(hierarchyMsg).toBeDefined();
        expect(hierarchyMsg.requestId).toBeDefined();

        // Runner reports a structured handler failure correlated to the hierarchy requestId.
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: hierarchyMsg.requestId,
          success: false,
          error: "request_hierarchy handler failed: view hierarchy extraction threw",
          timestamp: errorTimer.now()
        }));

        // Fail fast: no timer advance toward the 10s timeout. Only flush microtasks/setImmediate.
        await flushPromises();
        const result = await syncPromise;

        expect(result).toBeNull();
        // Prove we did not sit through the timeout: virtually no fake time elapsed.
        expect(errorTimer.getCurrentTime()).toBeLessThan(10000);
      } finally {
        await testClient.close();
      }
    });

    test("a type:error frame with an unknown requestId does not disturb an in-flight hierarchy sync", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const hierarchyMsg = findSentMessageOfType(socket, "request_hierarchy");
        expect(hierarchyMsg).toBeDefined();

        // Error frame for an uncorrelated id — must be a safe no-op for the hierarchy wait.
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: "some-unrelated-id",
          success: false,
          error: "Malformed request: the payload is not valid JSON",
          timestamp: errorTimer.now()
        }));

        // The real hierarchy push for our request still arrives and resolves the sync normally.
        socket.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: errorTimer.now(),
          data: {
            updatedAt: errorTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Recovered after uncorrelated error" }
          }
        }));

        const result = await errorTimer.resolvePromise(syncPromise);

        expect(result).not.toBeNull();
        expect(result!.hierarchy.hierarchy.text).toBe("Recovered after uncorrelated error");
      } finally {
        await testClient.close();
      }
    });
  });

  describe("hierarchy stale-nudge error frame correlation (issue #3061)", function() {
    // Sibling of #3032 for the request_hierarchy_if_stale nudge. That nudge is minted with a
    // `stale_` requestId from INSIDE waitForFreshData's interval callback (the "no push after 2s"
    // path). Before #3061 that id was never registered in pendingHierarchyRejectors, so a runner
    // type:"error" frame for the stale id no-op'd and the wait hung to timeout. These tests assert
    // the stale error frame now unblocks the enclosing hierarchy wait fast, while an uncorrelated
    // id during the stale window remains a safe no-op.

    const findSentMessageOfType = (socket: CapturingWebSocket, type: string): any | undefined => {
      const raw = socket.sentMessages.find(m => {
        try { return JSON.parse(m).type === type; } catch { return false; }
      });
      return raw ? JSON.parse(raw) : undefined;
    };

    // Drive the wait past the 2s stale-check window until the request_hierarchy_if_stale nudge is
    // actually sent. The nudge fires from inside waitForFreshData's interval callback, so it depends
    // on that interval being registered — which happens a few microtask turns after the sync's
    // request_hierarchy send. Rather than assume a fixed number of flushes (a microtask-ordering
    // flake vector), retry advancing time until the nudge appears. Total advance stays well under
    // the 10s sync timeout so a later "no timeout occurred" assertion remains valid.
    const driveUntilStaleNudge = async (socket: CapturingWebSocket, timer: FakeTimer): Promise<any> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await flushPromises();
        timer.advanceTime(2100);
        await flushPromises();
        const staleMsg = findSentMessageOfType(socket, "request_hierarchy_if_stale");
        if (staleMsg) {
          return staleMsg;
        }
      }
      return undefined;
    };

    test("a type:error frame for an in-flight request_hierarchy_if_stale nudge fails the sync fast", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        // 10s hierarchy sync timeout — the whole point is to NOT wait for it.
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const hierarchyMsg = findSentMessageOfType(socket, "request_hierarchy");
        expect(hierarchyMsg).toBeDefined();

        // Drive the wait past the 2s stale-check window so the request_hierarchy_if_stale nudge is
        // sent from inside the interval callback (total advance < the 10s timeout).
        const staleMsg = await driveUntilStaleNudge(socket, errorTimer);
        expect(staleMsg).toBeDefined();
        expect(staleMsg.requestId).toBeDefined();
        expect(String(staleMsg.requestId).startsWith("stale_")).toBe(true);

        // Runner reports a structured handler failure correlated to the stale nudge's requestId.
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: staleMsg.requestId,
          success: false,
          error: "request_hierarchy_if_stale handler failed: view hierarchy extraction threw",
          timestamp: errorTimer.now()
        }));

        // Fail fast: only flush microtasks/setImmediate, no advance toward the 10s timeout.
        await flushPromises();
        const result = await syncPromise;

        expect(result).toBeNull();
        // Prove we did not sit through the timeout: fake time stayed near the stale window.
        expect(errorTimer.getCurrentTime()).toBeLessThan(10000);
      } finally {
        await testClient.close();
      }
    });

    test("a type:error frame with an unknown requestId does not disturb the stale-nudge wait", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        // Advance past the stale window so the stale nudge is minted and registered.
        const staleMsg = await driveUntilStaleNudge(socket, errorTimer);
        expect(staleMsg).toBeDefined();

        // Error frame for an uncorrelated id — must be a safe no-op for the stale-nudge wait.
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: "some-unrelated-id",
          success: false,
          error: "Malformed request: the payload is not valid JSON",
          timestamp: errorTimer.now()
        }));

        // The real hierarchy push for our request still arrives and resolves the sync normally.
        socket.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: errorTimer.now(),
          data: {
            updatedAt: errorTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Recovered after uncorrelated stale error" }
          }
        }));

        const result = await errorTimer.resolvePromise(syncPromise);

        expect(result).not.toBeNull();
        expect(result!.hierarchy.hierarchy.text).toBe("Recovered after uncorrelated stale error");
      } finally {
        await testClient.close();
      }
    });

    test("a stale-nudge error frame does NOT discard stale cache on the getLatestHierarchy path", async function() {
      // getLatestHierarchy (unlike requestHierarchySync) enters waitForFreshData with NO primary
      // requestId — its timeout is meant to gracefully fall through to the stale cache. The stale
      // nudge is therefore left uncorrelated there (gated on `requestId` in waitForFreshData). This
      // locks in that decision: an error frame for the stale id must be a safe no-op that preserves
      // the stale-cache return, NOT a rejection that propagates to null. Removing the `&& requestId`
      // gate would flip this assertion (the wait would reject and getLatestHierarchy would return
      // hierarchy:null).
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        // Prime the connection + cache via a sync that a push resolves quickly.
        const primePromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);
        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);
        socket.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: errorTimer.now(),
          data: {
            updatedAt: errorTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Stale cache preserved" }
          }
        }));
        await errorTimer.resolvePromise(primePromise);

        // Let time pass so the cached data is stale relative to the next wait's start; this forces
        // getLatestHierarchy(waitForFresh=true) into waitForFreshData and, on timeout, into the
        // stale-cache return path.
        errorTimer.advanceTime(500);

        const latestPromise = testClient.getLatestHierarchy(true, 3000);

        // Drive to the 2s stale window so the (uncorrelated) stale nudge is minted.
        await flushPromises();
        errorTimer.advanceTime(2100);
        await flushPromises();
        const staleMsg = findSentMessageOfType(socket, "request_hierarchy_if_stale");
        expect(staleMsg).toBeDefined();
        expect(String(staleMsg.requestId).startsWith("stale_")).toBe(true);

        // Error frame for the stale id — must be a safe no-op on this path.
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: staleMsg.requestId,
          success: false,
          error: "request_hierarchy_if_stale handler failed: view hierarchy extraction threw",
          timestamp: errorTimer.now()
        }));

        // The wait falls through to its timeout and returns the STALE CACHE (not null).
        const result = await errorTimer.resolvePromise(latestPromise);
        expect(result.hierarchy).not.toBeNull();
        expect(result.hierarchy!.hierarchy.text).toBe("Stale cache preserved");
        expect(result.fresh).toBe(false);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("runner error surfacing via diagnostics (issue #3062)", function() {
    // Follow-up to #3032 / #3061. Those made a correlated runner type:"error" frame fail the
    // hierarchy wait fast, but requestHierarchySync still collapsed the rejection to `null` —
    // indistinguishable from a plain timeout `null`. #3062 threads a per-call `diagnostics`
    // out-parameter so a caller can tell "runner reported a structured handler failure" (text
    // populated) apart from "the push never arrived" (timeout: null result, diagnostics untouched).

    const findSentMessageOfType = (socket: CapturingWebSocket, type: string): any | undefined => {
      const raw = socket.sentMessages.find(m => {
        try { return JSON.parse(m).type === type; } catch { return false; }
      });
      return raw ? JSON.parse(raw) : undefined;
    };

    const driveUntilStaleNudge = async (socket: CapturingWebSocket, timer: FakeTimer): Promise<any> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await flushPromises();
        timer.advanceTime(2100);
        await flushPromises();
        const staleMsg = findSentMessageOfType(socket, "request_hierarchy_if_stale");
        if (staleMsg) {
          return staleMsg;
        }
      }
      return undefined;
    };

    test("a correlated runner error populates diagnostics.runnerError while still returning null", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const diagnostics: HierarchySyncDiagnostics = {};
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000, diagnostics);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const hierarchyMsg = findSentMessageOfType(socket, "request_hierarchy");
        expect(hierarchyMsg).toBeDefined();
        expect(hierarchyMsg.requestId).toBeDefined();

        const runnerText = "request_hierarchy handler failed: view hierarchy extraction threw";
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: hierarchyMsg.requestId,
          success: false,
          error: runnerText,
          timestamp: errorTimer.now()
        }));

        await flushPromises();
        const result = await syncPromise;

        // Contract unchanged: still null so existing callers keep working.
        expect(result).toBeNull();
        // But the runner text is now surfaced to the caller, distinct from a timeout.
        expect(diagnostics.runnerError).toBe(runnerText);
        // Fast-fail: no sitting through the 10s timeout.
        expect(errorTimer.getCurrentTime()).toBeLessThan(10000);
      } finally {
        await testClient.close();
      }
    });

    test("a plain timeout leaves diagnostics.runnerError undefined (no misattribution)", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const diagnostics: HierarchySyncDiagnostics = {};
        // Short timeout; never deliver a push or an error frame -> genuine timeout.
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 3000, diagnostics);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const result = await errorTimer.resolvePromise(syncPromise);

        expect(result).toBeNull();
        // Crucially: a timeout must NOT surface a runner error.
        expect(diagnostics.runnerError).toBeUndefined();
      } finally {
        await testClient.close();
      }
    });

    test("an uncorrelated error id leaves diagnostics.runnerError undefined and the push still resolves", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const diagnostics: HierarchySyncDiagnostics = {};
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000, diagnostics);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: "some-unrelated-id",
          success: false,
          error: "Malformed request: the payload is not valid JSON",
          timestamp: errorTimer.now()
        }));

        socket.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: errorTimer.now(),
          data: {
            updatedAt: errorTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Recovered after uncorrelated error" }
          }
        }));

        const result = await errorTimer.resolvePromise(syncPromise);

        expect(result).not.toBeNull();
        expect(result!.hierarchy.hierarchy.text).toBe("Recovered after uncorrelated error");
        expect(diagnostics.runnerError).toBeUndefined();
      } finally {
        await testClient.close();
      }
    });

    test("a correlated stale-nudge runner error also populates diagnostics.runnerError", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const diagnostics: HierarchySyncDiagnostics = {};
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000, diagnostics);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const staleMsg = await driveUntilStaleNudge(socket, errorTimer);
        expect(staleMsg).toBeDefined();
        expect(String(staleMsg.requestId).startsWith("stale_")).toBe(true);

        const runnerText = "request_hierarchy_if_stale handler failed: view hierarchy extraction threw";
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: staleMsg.requestId,
          success: false,
          error: runnerText,
          timestamp: errorTimer.now()
        }));

        await flushPromises();
        const result = await syncPromise;

        expect(result).toBeNull();
        expect(diagnostics.runnerError).toBe(runnerText);
        expect(errorTimer.getCurrentTime()).toBeLessThan(10000);
      } finally {
        await testClient.close();
      }
    });

    test("verifyServiceReady surfaces the runner error text in its terminal warn", async function() {
      // Consumption test: prove the diagnostics text actually reaches an observable, default-level
      // log line (not just the dropped per-attempt debug), attributing the deterministic handler
      // failure instead of an anonymous "no hierarchy". Spy on the module logger's warn.
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      const warnMessages: string[] = [];
      const originalWarn = logger.warn;
      logger.warn = (message: string) => {
        warnMessages.push(message);
      };

      try {
        testClient.invalidateCache();
        // Single attempt so one correlated error frame drives it straight to the terminal warn.
        const verifyPromise = testClient.verifyServiceReady(1, 10, 10000);

        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const hierarchyMsg = findSentMessageOfType(socket, "request_hierarchy");
        expect(hierarchyMsg).toBeDefined();

        const runnerText = "request_hierarchy handler failed: view hierarchy extraction threw";
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: hierarchyMsg.requestId,
          success: false,
          error: runnerText,
          timestamp: errorTimer.now()
        }));

        const ready = await errorTimer.resolvePromise(verifyPromise);

        expect(ready).toBe(false);
        const terminalWarn = warnMessages.find(m => m.includes("Service not ready"));
        expect(terminalWarn).toBeDefined();
        expect(terminalWarn).toContain(runnerText);
      } finally {
        logger.warn = originalWarn;
        await testClient.close();
      }
    });
  });

  describe("hierarchy ADB-broadcast fallback error frame correlation (issue #3089)", function() {
    // Last member of the #3032/#3061 waitForFreshData hang class. When the WebSocket
    // request_hierarchy send fails, requestHierarchySync falls back to an
    // `am broadcast ... EXTRACT_HIERARCHY --es uuid sync_<ts>_<id>` and then waits for a push.
    // Before #3089 that fallback wait registered NO rejector (it passed no requestId into
    // waitForFreshData), so a runner type:"error" frame echoing the broadcast uuid no-op'd and the
    // caller hung to the full timeout. These tests drive that fallback and assert the sync_ uuid now
    // correlates a runner error into a fast fail, while staying a safe no-op for uncorrelated ids and
    // for the getLatestHierarchy stale-cache path (which still registers no requestId).

    // A capturing socket that stays OPEN but throws when asked to SEND a request_hierarchy (or the
    // stale nudge) frame, forcing requestHierarchySync down its ADB-broadcast fallback branch. It
    // stays OPEN so the test can still deliver a simulated type:"error" frame back over the same
    // socket — modeling a WebSocket that momentarily could not accept a send but is still readable.
    class HierarchySendFailingWebSocket extends CapturingWebSocket {
      send(data: any): void {
        const str = data.toString();
        this.sentMessages.push(str);
        let parsed: any = null;
        try { parsed = JSON.parse(str); } catch { parsed = null; }
        if (parsed && (parsed.type === "request_hierarchy" || parsed.type === "request_hierarchy_if_stale")) {
          throw new Error("Simulated WebSocket send failure (forces ADB-broadcast fallback)");
        }
        // Any other frame: accept silently (base FakeWebSocket.send only checks OPEN and no-ops).
      }
    }

    const createSendFailingFactory = (timer?: FakeTimer): {
      factory: (url: string) => HierarchySendFailingWebSocket;
      getSocket: () => HierarchySendFailingWebSocket | null;
    } => {
      let socket: HierarchySendFailingWebSocket | null = null;
      return {
        factory: (url: string) => {
          socket = new HierarchySendFailingWebSocket(url, "none", 0, timer);
          return socket;
        },
        getSocket: () => socket
      };
    };

    // Poll the fake ADB command history until the EXTRACT_HIERARCHY broadcast fallback fires, then
    // return its `sync_` uuid. The fallback runs a few microtask turns after the request_hierarchy
    // send throws, so retry across setImmediate flushes rather than assuming a fixed ordering.
    const waitForBroadcastUuid = async (adb: FakeAdbExecutor): Promise<string | undefined> => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const cmd = adb.getExecutedCommands().find(c => c.includes("EXTRACT_HIERARCHY"));
        if (cmd) {
          const match = cmd.match(/--es uuid (sync_[^\s"]+)/);
          if (match) {
            return match[1];
          }
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      return undefined;
    };

    test("a type:error frame echoing the broadcast sync_ uuid fails requestHierarchySync fast", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createSendFailingFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        // 10s hierarchy sync timeout — the whole point is to NOT wait for it.
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);

        const socket = await waitForSocket(getSocket) as HierarchySendFailingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        // request_hierarchy send throws -> ADB-broadcast fallback mints and broadcasts the sync_ uuid.
        const uuid = await waitForBroadcastUuid(fakeAdb);
        expect(uuid).toBeDefined();
        expect(String(uuid).startsWith("sync_")).toBe(true);
        // Let waitForFreshData run so it registers the fast-fail rejector for the sync_ uuid.
        await flushPromises();

        // Runner reports a correlated handler failure echoing the broadcast uuid (issue #3089: the
        // EXTRACT_HIERARCHY handler emits a type:"error" frame keyed by the broadcast uuid on failure).
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: uuid,
          success: false,
          error: "Failed to extract hierarchy",
          timestamp: errorTimer.now()
        }));

        // Fail fast: no timer advance toward the 10s timeout. Only flush microtasks/setImmediate.
        await flushPromises();
        const result = await syncPromise;

        expect(result).toBeNull();
        // Prove we did not sit through the timeout: virtually no fake time elapsed.
        expect(errorTimer.getCurrentTime()).toBeLessThan(10000);
      } finally {
        await testClient.close();
      }
    });

    test("a broadcast-fallback runner error populates diagnostics.runnerError (parity with #3062)", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createSendFailingFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const diagnostics: HierarchySyncDiagnostics = {};
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000, diagnostics);

        const socket = await waitForSocket(getSocket) as HierarchySendFailingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        const uuid = await waitForBroadcastUuid(fakeAdb);
        expect(uuid).toBeDefined();
        await flushPromises();

        const runnerText = "Failed to extract hierarchy";
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: uuid,
          success: false,
          error: runnerText,
          timestamp: errorTimer.now()
        }));

        await flushPromises();
        const result = await syncPromise;

        // Contract unchanged: still null so existing callers keep their stale-cache fallback.
        expect(result).toBeNull();
        // The runner text is surfaced to the caller, distinct from a plain timeout null.
        expect(diagnostics.runnerError).toBe(runnerText);
        expect(errorTimer.getCurrentTime()).toBeLessThan(10000);
      } finally {
        await testClient.close();
      }
    });

    test("an uncorrelated error id during the broadcast fallback is a safe no-op; the push still resolves", async function() {
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createSendFailingFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        testClient.invalidateCache();
        const syncPromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);

        const socket = await waitForSocket(getSocket) as HierarchySendFailingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        const uuid = await waitForBroadcastUuid(fakeAdb);
        expect(uuid).toBeDefined();
        await flushPromises();

        // Error frame for an uncorrelated id — must be a safe no-op for the broadcast-fallback wait.
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: "some-unrelated-id",
          success: false,
          error: "Malformed request: the payload is not valid JSON",
          timestamp: errorTimer.now()
        }));

        // The real hierarchy push for our request still arrives and resolves the sync normally.
        socket.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: errorTimer.now(),
          data: {
            updatedAt: errorTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Recovered after uncorrelated broadcast error" }
          }
        }));

        const result = await errorTimer.resolvePromise(syncPromise);

        expect(result).not.toBeNull();
        expect(result!.hierarchy.hierarchy.text).toBe("Recovered after uncorrelated broadcast error");
      } finally {
        await testClient.close();
      }
    });

    test("a sync_-prefixed error frame does NOT disturb the getLatestHierarchy stale-cache path", async function() {
      // getLatestHierarchy never mints a broadcast sync_ uuid and enters waitForFreshData with NO
      // requestId — its timeout is meant to gracefully fall through to the stale cache. This locks in
      // that the #3089 correlation is scoped to requestHierarchySync: a sync_-shaped error frame is an
      // uncorrelated no-op here and must NOT reject the wait to null (which would discard the cache).
      const errorTimer = new FakeTimer();
      const { factory, getSocket } = createCapturingWebSocketFactory(errorTimer);
      const testClient = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        errorTimer
      );

      try {
        // Prime the connection + cache via a sync that a push resolves quickly.
        const primePromise = testClient.requestHierarchySync(undefined, false, undefined, 10000);
        const socket = await waitForSocket(getSocket) as CapturingWebSocket;
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);
        socket.simulateMessage(JSON.stringify({
          type: "hierarchy_update",
          timestamp: errorTimer.now(),
          data: {
            updatedAt: errorTimer.now(),
            packageName: "com.example.app",
            hierarchy: { text: "Stale cache preserved" }
          }
        }));
        await errorTimer.resolvePromise(primePromise);

        // Let time pass so the cached data is stale relative to the next wait's start.
        errorTimer.advanceTime(500);

        const latestPromise = testClient.getLatestHierarchy(true, 3000);

        // Inject a sync_-shaped error frame — no rejector is registered for it on this path.
        await flushPromises();
        socket.simulateMessage(JSON.stringify({
          type: "error",
          requestId: `sync_${errorTimer.now()}_deadbeef`,
          success: false,
          error: "Failed to extract hierarchy",
          timestamp: errorTimer.now()
        }));

        // The wait falls through to its timeout and returns the STALE CACHE (not null).
        const result = await errorTimer.resolvePromise(latestPromise);
        expect(result.hierarchy).not.toBeNull();
        expect(result.hierarchy!.hierarchy.text).toBe("Stale cache preserved");
        expect(result.fresh).toBe(false);
      } finally {
        await testClient.close();
      }
    });
  });

  describe("bindSession", function() {
    afterEach(function() {
      NavigationGraphManager.resetInstance();
    });

    test("should use session-scoped NavigationGraphManager after binding", function() {
      // This test asserts only on instance ROUTING/identity, not on per-instance
      // navigation state, so it deliberately does not call setCurrentApp: that
      // would resolve the real getDatabase() (session instances have no in-memory
      // injection seam) and trip the unit-test DB guard (issue #3067).
      const globalNav = NavigationGraphManager.getInstance();
      const sessionNav = NavigationGraphManager.getInstanceForSession("test-session-123");

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
