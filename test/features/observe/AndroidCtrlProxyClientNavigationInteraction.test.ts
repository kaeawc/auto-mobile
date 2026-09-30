import { afterAll, beforeAll, describe, expect, test, spyOn } from "bun:test";
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
});
