import { afterEach, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";
import { PortManager } from "../../../src/utils/PortManager";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import type { RequestManager } from "../../../src/utils/RequestManager";

// Wire frames for the owner read path of a device with a default display (logical 0) and a
// second connected display (logical 2); the display ids match
// test/features/observe/android/fixtures/cmd-display-two-displays.txt (#10106).
const DEFAULT_DISPLAY = { width: 1080, height: 2400, pixelWidth: 1080, pixelHeight: 2400 };
const SECOND_DISPLAY = { width: 1920, height: 1080, pixelWidth: 1920, pixelHeight: 1080 };

class CapturingSocket extends FakeWebSocket {
  readonly sent: string[] = [];
  override send(data: string): void {
    this.sent.push(data);
    super.send(data);
  }
}

function capturingSockets(timer: FakeTimer): {
  factory: (url: string) => CapturingSocket;
  socket: () => CapturingSocket;
} {
  let current: CapturingSocket | undefined;
  return {
    factory: (url) => (current = new CapturingSocket(url, "none", 0, timer)),
    socket: () => {
      if (!current) {
        throw new Error("Socket was not created");
      }
      return current;
    },
  };
}

async function sentHierarchyRequest(
  socket: CapturingSocket,
): Promise<{ requestId: string; displayId?: number }> {
  for (let i = 0; i < 20; i++) {
    const request = socket.sent
      .map((wire) => JSON.parse(wire) as { type?: string; requestId?: string; displayId?: number })
      .filter((message) => message.type === "request_hierarchy")
      .at(-1);
    if (request?.requestId) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { requestId: request.requestId, displayId: request.displayId };
    }
    await Promise.resolve();
  }
  throw new Error("No request_hierarchy was sent");
}

function frame(
  text: string,
  size: typeof DEFAULT_DISPLAY,
  displayId: number,
  updatedAt: number,
  requestId?: string,
): string {
  return JSON.stringify({
    type: "hierarchy_update",
    requestId,
    data: {
      updatedAt,
      displayId,
      packageName: "com.example",
      hierarchy: { text },
      windows: [{ bounds: { left: 0, top: 0, right: size.width, bottom: size.height } }],
      nativeScale: 1,
      pixelWidth: size.pixelWidth,
      pixelHeight: size.pixelHeight,
    },
  });
}

function cachedText(client: AndroidCtrlProxyClient): string | undefined {
  const cached = Reflect.get(client, "cachedHierarchy") as {
    hierarchy: { hierarchy: { text: string } };
  } | null;
  return cached?.hierarchy.hierarchy.text;
}

function markerCount(client: AndroidCtrlProxyClient): number {
  return (Reflect.get(client, "observerHierarchyRequestIds") as Map<string, boolean>).size;
}

async function connectedClient(deviceId: string) {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const sockets = capturingSockets(timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId, name: "Android", platform: "android" },
    new FakeAdbExecutor(),
    sockets.factory,
    timer,
  );
  const stream = spyOn(client, "pushHierarchyToObservationStream");
  const backoff = spyOn(client, "startScreenshotBackoff").mockImplementation(() => {});
  expect(await client.ensureConnected()).toBe(true);
  expect((Reflect.get(client, "requestManager") as RequestManager).getPendingCount()).toBe(0);
  const socket = sockets.socket();
  // The default display's frame: what the cache, geometry and stream describe.
  // Echoed ids mark the connection as correlated, as on any current runner APK.
  socket.simulateMessage(frame("default", DEFAULT_DISPLAY, 0, 1, "seed-frame"));
  expect(cachedText(client)).toBe("default");
  stream.mockClear();
  backoff.mockClear();
  return { client, socket, stream, backoff, timer };
}

afterEach(() => {
  AndroidCtrlProxyClient.resetInstances();
  PortManager.setPortAvailabilityCheckerForTesting(null);
});

test("an owner read of a non-default display answers its caller without touching shared state", async () => {
  const { client, socket, stream, backoff } = await connectedClient("owner-display-isolation");
  try {
    const geometryBefore = client.screenGeometry.bind();
    const scaleBefore = client.getScreenScaleMetadata();
    expect(scaleBefore).toEqual({ nativeScale: 1, pixelWidth: 1080, pixelHeight: 2400 });

    const pending = client.requestHierarchySync(
      new NoOpPerformanceTracker(),
      false,
      undefined,
      1000,
      undefined,
      2,
    );
    const { requestId, displayId } = await sentHierarchyRequest(socket);
    expect(displayId).toBe(2);
    socket.simulateMessage(frame("external", SECOND_DISPLAY, 2, 2, requestId));

    const result = await pending;
    expect(result?.hierarchy.hierarchy.text).toBe("external");
    expect(result?.hierarchy.displayId).toBe(2);

    expect(cachedText(client)).toBe("default");
    expect(client.getScreenScaleMetadata()).toEqual(scaleBefore);
    expect(client.screenGeometry.bind()).toEqual(geometryBefore);
    expect(stream).not.toHaveBeenCalled();
    expect(backoff).not.toHaveBeenCalled();
    expect(markerCount(client)).toBe(0);
  } finally {
    await client.close();
  }
});

test.each([undefined, 0])(
  "an owner read with displayId %p keeps replacing the shared cache, geometry and stream",
  async (displayId) => {
    const { client, socket, stream, backoff } = await connectedClient(
      `owner-default-display-${String(displayId)}`,
    );
    try {
      const pending = client.requestHierarchySync(
        new NoOpPerformanceTracker(),
        false,
        undefined,
        1000,
        undefined,
        displayId,
      );
      const { requestId } = await sentHierarchyRequest(socket);
      socket.simulateMessage(frame("default refreshed", SECOND_DISPLAY, 0, 2, requestId));
      expect((await pending)?.hierarchy.hierarchy.text).toBe("default refreshed");

      expect(cachedText(client)).toBe("default refreshed");
      expect(client.getScreenScaleMetadata()).toEqual({
        nativeScale: 1,
        pixelWidth: 1920,
        pixelHeight: 1080,
      });
      expect(stream).toHaveBeenCalledTimes(1);
      expect(backoff).toHaveBeenCalledTimes(1);
      expect(markerCount(client)).toBe(0);
    } finally {
      await client.close();
    }
  },
);

test("an unanswered explicit display read releases its marker so a later frame is not swallowed", async () => {
  const { client, socket, stream, timer } = await connectedClient("owner-display-timeout");
  try {
    const pending = client.requestHierarchySync(
      new NoOpPerformanceTracker(),
      false,
      undefined,
      100,
      undefined,
      2,
    );
    await sentHierarchyRequest(socket);
    expect(markerCount(client)).toBe(1);
    timer.advanceTime(100);
    expect(await pending).toBeNull();
    expect(markerCount(client)).toBe(0);

    // An uncorrelated push after the failed read is an ordinary default-display update.
    socket.simulateMessage(frame("default later", DEFAULT_DISPLAY, 0, 3));
    expect(cachedText(client)).toBe("default later");
    expect(stream).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
  }
});
