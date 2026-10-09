import { afterAll, beforeAll, describe, expect, test, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import type { AccessibilityHierarchy } from "../../../src/features/observe/android/types";
import { resetDbWriteBarrier } from "../../../src/db/dbWriteBarrier";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { PortManager } from "../../../src/utils/PortManager";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket, WebSocketState } from "../../fakes/FakeWebSocket";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

describe("AndroidCtrlProxyClient navigation interaction attribution", () => {
  const device: BootedDevice = {
    deviceId: "navigation-interaction-test-device",
    platform: "android",
    isEmulator: true,
    name: "Navigation interaction test device",
  };
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  let navHarness: InMemoryNavManagerHarness;
  let client: AndroidCtrlProxyClient;
  let socket: FakeWebSocket | null = null;

  beforeAll(async () => {
    timer.enableAutoAdvance();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.resetInstances();
    navHarness = await installInMemoryNavManager();
    adb.setCommandResponse("forward", { stdout: "8765", stderr: "" });

    client = AndroidCtrlProxyClient.createForTesting(
      device,
      adb,
      (url) => {
        socket = new FakeWebSocket(url, "none", 0, timer);
        return socket;
      },
      timer,
    );
    const manager = AndroidCtrlProxyManager.getInstance(device, adb);
    spyOn(manager, "isAvailable").mockResolvedValue(true);

    const hierarchyPromise = client.getLatestHierarchy(true, 2_000);
    for (let attempt = 0; attempt < 10 && !socket; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!socket) {
      throw new Error("Expected CtrlProxy WebSocket to be created");
    }
    if (socket.readyState !== WebSocketState.OPEN) {
      await new Promise<void>((resolve) => socket!.once("open", () => resolve()));
    }
    socket.simulateMessage(
      JSON.stringify({
        type: "hierarchy_update",
        timestamp: timer.now(),
        data: {
          updatedAt: timer.now(),
          packageName: "com.example.app",
          hierarchy: { text: "Home" },
        },
      }),
    );
    await hierarchyPromise;
    // Pay the one-time cold-start cost of the first navigation event (recorder, in-memory DB write
    // barrier, lazy parse; ~4 ms, far more on a loaded runner) here, outside the per-test budget.
    // It uses its own destination and app so no test sees it as an attribution candidate.
    await sendNavigation("WarmupDestination", "dev.jasonpearson.automobile.warmup");
  });

  afterAll(async () => {
    await client.close();
    await navHarness.dispose();
    NavigationGraphManager.resetInstance();
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
    resetDbWriteBarrier();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  const sendInteraction = (applicationId: string, type: string, timestamp: number | null): void => {
    socket?.simulateMessage(
      JSON.stringify({
        type: "interaction_event",
        ...(timestamp === null ? {} : { timestamp }),
        event: {
          type,
          ...(timestamp === null ? {} : { timestamp }),
          packageName: applicationId,
          element: { text: `${applicationId} button`, "resource-id": `${applicationId}:id/button` },
        },
      }),
    );
  };

  const sendNavigation = async (
    destination: string,
    applicationId: string,
    deviceTimestamp: number | null = timer.now(),
  ): Promise<void> => {
    const hostTimestamp = timer.now();
    socket?.simulateMessage(
      JSON.stringify({
        type: "navigation_event",
        event: {
          destination,
          source: "Previous",
          arguments: {},
          metadata: {},
          ...(deviceTimestamp === null ? {} : { timestamp: deviceTimestamp }),
          sequenceNumber: hostTimestamp,
          applicationId,
        },
      }),
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await timer.advanceTimersByTimeAsync(1);
    }
  };

  const recordedEvent = (destination: string) => {
    const call = navHarness.telemetrySpy.mock.calls
      .map(([event]) => event)
      .find((event) => event.destination === destination);
    if (!call) {
      throw new Error(`Expected telemetry event for ${destination}`);
    }
    return call;
  };

  // Reuse a captured Android tree, rather than inventing parser/hierarchy JSON.
  function observePayload(): AccessibilityHierarchy {
    const capture: { viewHierarchy: AccessibilityHierarchy } = JSON.parse(
      readFileSync(
        new URL("../../fixtures/android-focus/playground-text-field-pre-tap.json", import.meta.url),
        "utf8",
      ),
    );
    return { ...capture.viewHierarchy, packageName: "", updatedAt: 1791181941976 };
  }

  test.each(["window", "root", "single-root", "top-app", "ime"])(
    "observe sync resolves Settings identity from %s before detector/build attribution",
    (source) => {
      const activeWindow = {
        appId: "com.android.settings",
        activityName: "com.android.settings.Settings",
      };
      const payload = observePayload();
      const appWindow = payload.windows!.find((window) => window.isFocused)!;
      if (source === "window" || source === "top-app" || source === "ime") {
        appWindow.packageName = activeWindow.appId;
      } else {
        const roots = payload.hierarchy.node;
        const root = (Array.isArray(roots) ? roots : [roots]).find(
          (node) => node?.windowId === appWindow.id,
        )!;
        root.packageName = activeWindow.appId;
        if (source === "single-root") {
          payload.hierarchy = root;
          payload.windows = undefined;
        }
      }
      if (source === "top-app" || source === "ime") {
        appWindow.isFocused = false;
        appWindow.isActive = false;
      }
      if (source === "ime") {
        payload.windows!.push({
          type: 2,
          isFocused: true,
          packageName: "com.google.android.inputmethod.latin",
          windowLayer: 100,
        });
      }
      // Restore the shared clock afterwards: a jump back (or ahead) would leave later
      // tests with host sequence numbers the client treats as stale or out of window.
      const clockBefore = timer.now();
      timer.setCurrentTime(1791181941935);
      const detector = spyOn(
        client.getHierarchyNavigationDetector(),
        "onHierarchyUpdate",
      ).mockImplementation(() => {});
      const build = spyOn(navHarness.manager, "clearBuildContext");
      const packages = spyOn(client, "requestPackageInfo").mockRejectedValue(
        new Error("fake package lookup unavailable"),
      );
      try {
        client.handleHierarchyUpdate(payload);
        expect(detector).toHaveBeenCalledWith(
          expect.objectContaining({ packageName: activeWindow.appId, updatedAt: 1791181941976 }),
        );
        expect(build).toHaveBeenCalledWith(activeWindow.appId);
        expect(payload.packageName).toBe(""); // Input capture is not relabeled in place.
      } finally {
        timer.setCurrentTime(clockBefore);
        detector.mockRestore();
        build.mockRestore();
        packages.mockRestore();
      }
    },
  );

  test("newly resolved SDK package still skips hierarchy detection", async () => {
    await sendNavigation("DemoIndexDestination", "dev.jasonpearson.automobile.playground");
    const payload = observePayload();
    payload.windows!.find((window) => window.isFocused)!.packageName =
      "dev.jasonpearson.automobile.playground";
    const detector = spyOn(
      client.getHierarchyNavigationDetector(),
      "onHierarchyUpdate",
    ).mockImplementation(() => {});
    try {
      client.handleHierarchyUpdate(payload);
      expect(detector).not.toHaveBeenCalled();
    } finally {
      detector.mockRestore();
    }
  });

  test("unknown focused window cannot borrow another window's package or stale build context", () => {
    const payload = observePayload();
    payload.windows!.find((window) => !window.isFocused)!.packageName =
      "dev.jasonpearson.automobile.playground";
    const build = spyOn(navHarness.manager, "clearBuildContext");
    try {
      client.handleHierarchyUpdate(payload);
      expect(build).not.toHaveBeenCalled();
      expect(client.getHierarchyNavigationDetector().hasPendingFingerprint()).toBe(false);
    } finally {
      build.mockRestore();
    }
  });

  test.each(["focused-window", "unknown"])(
    "%s identity is navigation-only and leaves the cached/returned capture unchanged",
    async (source) => {
      const payload = observePayload();
      delete payload.packageName;
      const navigationPackage = source === "focused-window" ? "com.android.settings" : undefined;
      if (navigationPackage) {
        payload.windows!.find((window) => window.isFocused)!.packageName = navigationPackage;
      }
      const before = structuredClone(payload);
      const navigation = client.getHierarchyNavigationDetector();
      // Unknown frames must reset an existing pending fingerprint, not bypass the detector.
      navigation.onHierarchyUpdate({ ...payload, packageName: "com.example.pending" });
      expect(navigation.hasPendingFingerprint()).toBe(true);
      const detector = spyOn(navigation, "onHierarchyUpdate");
      const build = spyOn(navHarness.manager, "clearBuildContext");
      const packages = spyOn(client, "requestPackageInfo").mockRejectedValue(
        new Error("fake package lookup unavailable"),
      );
      try {
        client.handleHierarchyUpdate(payload);
        const cached = (await client.getLatestHierarchy()).hierarchy;
        expect(cached).toBe(payload);
        expect(cached).toEqual(before);
        expect(Object.hasOwn(cached!, "packageName")).toBe(false);
        expect(cached?.packageName).toBeUndefined();
        expect(detector).toHaveBeenCalledWith({ ...payload, packageName: navigationPackage });
        expect(detector.mock.calls[0][0]).not.toBe(payload);
        if (navigationPackage) {
          expect(build).toHaveBeenCalledWith(navigationPackage);
          expect(navigation.hasPendingFingerprint()).toBe(true);
        } else {
          expect(build).not.toHaveBeenCalled();
          expect(navigation.hasPendingFingerprint()).toBe(false);
        }
      } finally {
        detector.mockRestore();
        build.mockRestore();
        packages.mockRestore();
      }
    },
  );

  test("does not attach another app's interaction", async () => {
    const timestamp = timer.now();
    sendInteraction("com.example.app.a", "tap", timestamp);

    await sendNavigation("OtherAppHome", "com.example.app.b");

    expect(recordedEvent("OtherAppHome").triggeringInteraction).toBeNull();
  });

  test("does not attach an interaction older than the time window", async () => {
    sendInteraction("com.example.app", "tap", 10_000);
    await timer.advanceTimersByTimeAsync(30_000);

    await sendNavigation("DelayedHome", "com.example.app", 10_001);

    expect(recordedEvent("DelayedHome").triggeringInteraction).toBeNull();
  });

  test.each([10_000, -10_000])(
    "attaches recent interactions with device clock skew of %i ms",
    async (deviceClockOffsetMs) => {
      const interactionTimestamp = timer.now() + deviceClockOffsetMs;
      sendInteraction("com.example.app", "tap", interactionTimestamp);

      await sendNavigation(
        `SkewedHome${deviceClockOffsetMs}`,
        "com.example.app",
        interactionTimestamp + 1,
      );

      expect(recordedEvent(`SkewedHome${deviceClockOffsetMs}`).triggeringInteraction).toEqual({
        type: "tap",
        elementText: "com.example.app button",
        elementResourceId: "com.example.app:id/button",
      });
    },
  );

  test("attaches an interaction when the navigation event timestamp is missing", async () => {
    sendInteraction("com.example.app", "tap", timer.now());

    await sendNavigation("MissingNavigationTimestamp", "com.example.app", null);

    expect(recordedEvent("MissingNavigationTimestamp").triggeringInteraction).toEqual({
      type: "tap",
      elementText: "com.example.app button",
      elementResourceId: "com.example.app:id/button",
    });
  });

  test("attaches an interaction with a missing device timestamp within the host window", async () => {
    sendInteraction("com.example.app", "tap", null);

    await sendNavigation("MissingInteractionTimestamp", "com.example.app");

    expect(recordedEvent("MissingInteractionTimestamp").triggeringInteraction).toEqual({
      type: "tap",
      elementText: "com.example.app button",
      elementResourceId: "com.example.app:id/button",
    });
  });

  test("does not attach an interaction with a missing timestamp outside the host window", async () => {
    sendInteraction("com.example.app", "tap", null);
    await timer.advanceTimersByTimeAsync(30_000);

    await sendNavigation("MissingTimestampTooOld", "com.example.app");

    expect(recordedEvent("MissingTimestampTooOld").triggeringInteraction).toBeNull();
  });

  test("does not attach an interaction when device event ordering is reversed", async () => {
    const interactionTimestamp = timer.now() + 1;
    sendInteraction("com.example.app", "tap", interactionTimestamp);

    await sendNavigation("ReversedDeviceOrder", "com.example.app", interactionTimestamp - 1);

    expect(recordedEvent("ReversedDeviceOrder").triggeringInteraction).toBeNull();
  });

  test("attaches a recent interaction from the same app", async () => {
    sendInteraction("com.example.app", "tap", timer.now());

    await sendNavigation("RecentHome", "com.example.app");

    expect(recordedEvent("RecentHome").triggeringInteraction).toEqual({
      type: "tap",
      elementText: "com.example.app button",
      elementResourceId: "com.example.app:id/button",
    });
  });

  test("keeps each app's newest SDK navigation route as its screen identity", async () => {
    const playground = "dev.jasonpearson.automobile.playground";
    await sendNavigation("HomeDestination", playground);
    await sendNavigation("DemoContrastDestination", playground);
    await sendNavigation("OtherDestination", "com.example.other");

    expect(client.getSdkScreenIdentity(playground)).toMatchObject({
      platform: "android",
      source: "sdk",
      confidence: "high",
      components: { bundleId: playground, navigationRoute: "DemoContrastDestination" },
    });
    expect(client.getSdkScreenIdentity("com.example.never-reported")).toBeUndefined();
    expect(client.getSdkScreenIdentity()).toBeUndefined();
  });

  describe("SDK route lifecycle", () => {
    const app = "dev.jasonpearson.automobile.playground.lifecycle";

    test("clears one app's route and wakes its waiters empty", async () => {
      await sendNavigation("HomeDestination", app);
      await sendNavigation("HomeDestination", "com.example.sibling.lifecycle");
      const waiting = client.awaitSdkScreenIdentityAfter(app, timer.now() + 1_000, 300);
      client.clearSdkScreenIdentity(app);

      expect(await waiting).toBeUndefined();
      expect(client.getSdkScreenIdentity(app)).toBeUndefined();
      expect(client.getSdkScreenIdentityReceivedAtMs(app)).toBeUndefined();
      expect(client.getSdkScreenIdentity("com.example.sibling.lifecycle")).toBeDefined();
    });

    test("drops every route when the SDK link closes", async () => {
      await sendNavigation("HomeDestination", app);
      client.onConnectionClosed();
      expect(client.getSdkScreenIdentity(app)).toBeUndefined();
    });

    test("drops the route of an app that crashed", async () => {
      await sendNavigation("HomeDestination", app);
      socket?.simulateMessage(
        JSON.stringify({
          type: "crash_event",
          timestamp: timer.now(),
          event: {
            exceptionClass: "java.lang.IllegalStateException",
            stackTrace: "at Foo.bar",
            threadName: "main",
            packageName: app,
            deviceInfo: {},
          },
        }),
      );
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await timer.advanceTimersByTimeAsync(1);
      }
      expect(client.getSdkScreenIdentity(app)).toBeUndefined();
    });

    test("a waiter resolves with the first route newer than its start", async () => {
      await sendNavigation("HomeDestination", app);
      const since = client.getSdkScreenIdentityReceivedAtMs(app)!;
      // The route already held predates `since`, so the waiter keeps waiting for a newer one.
      const waiting = client.awaitSdkScreenIdentityAfter(app, since, 300);
      await timer.advanceTimersByTimeAsync(5);
      await sendNavigation("DemoContrastDestination", app);

      expect(await waiting).toMatchObject({
        components: { navigationRoute: "DemoContrastDestination" },
      });
    });

    test("a waiter gives up after its bound", async () => {
      await sendNavigation("HomeDestination", app);
      const since = client.getSdkScreenIdentityReceivedAtMs(app)!;
      const waiting = client.awaitSdkScreenIdentityAfter(app, since, 300);
      await timer.advanceTimersByTimeAsync(300);
      expect(await waiting).toBeUndefined();
      expect(client.getSdkScreenIdentity(app)).toBeDefined();
    });

    test("a route already newer than the start answers at once", async () => {
      await sendNavigation("HomeDestination", app);
      const answer = await client.awaitSdkScreenIdentityAfter(app, -1, 300);
      expect(answer).toBeDefined();
    });
  });
});
