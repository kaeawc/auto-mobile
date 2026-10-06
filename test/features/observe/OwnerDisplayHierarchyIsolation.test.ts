import { afterEach, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { CtrlProxyHierarchy } from "../../../src/features/observe/android/CtrlProxyHierarchy";
import { HierarchyCollector } from "../../../src/features/observe/collectors/HierarchyCollector";
import type { ObserveResult } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
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

async function connectedClient(deviceId: string, adb = new FakeAdbExecutor()) {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const sockets = capturingSockets(timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId, name: "Android", platform: "android" },
    adb,
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

test("an unanswered explicit display read keeps its marker so the late reply stays isolated", async () => {
  const { client, socket, stream, backoff, timer } = await connectedClient("owner-display-timeout");
  try {
    const pending = client.requestHierarchySync(
      new NoOpPerformanceTracker(),
      false,
      undefined,
      100,
      undefined,
      2,
    );
    const { requestId } = await sentHierarchyRequest(socket);
    expect(markerCount(client)).toBe(1);
    timer.advanceTime(100);
    expect(await pending).toBeNull();
    expect(markerCount(client)).toBe(1);

    // An uncorrelated push after the failed read is an ordinary default-display update.
    socket.simulateMessage(frame("default later", DEFAULT_DISPLAY, 0, 3));
    expect(cachedText(client)).toBe("default later");
    expect(stream).toHaveBeenCalledTimes(1);
    stream.mockClear();
    backoff.mockClear();
    const scaleBefore = client.getScreenScaleMetadata();

    // The display-2 reply arrives after the waiter gave up: it is dropped, not adopted.
    socket.simulateMessage(frame("external late", SECOND_DISPLAY, 2, 4, requestId));
    expect(cachedText(client)).toBe("default later");
    expect(client.getScreenScaleMetadata()).toEqual(scaleBefore);
    expect(stream).not.toHaveBeenCalled();
    expect(backoff).not.toHaveBeenCalled();
    expect(markerCount(client)).toBe(0);
  } finally {
    await client.close();
  }
});

test("an aborted explicit display read keeps its marker until the late reply is consumed", async () => {
  const { client, socket, stream, timer } = await connectedClient("owner-display-abort");
  try {
    const controller = new AbortController();
    const pending = client.requestHierarchySync(
      new NoOpPerformanceTracker(),
      false,
      controller.signal,
      1000,
      undefined,
      2,
    );
    const { requestId } = await sentHierarchyRequest(socket);
    controller.abort();
    await pending.catch(() => null);
    // The in-flight wait notices the abort on its next poll and gives up.
    timer.advanceTime(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(markerCount(client)).toBe(1);
    socket.simulateMessage(frame("external late", SECOND_DISPLAY, 2, 2, requestId));
    expect(cachedText(client)).toBe("default");
    expect(stream).not.toHaveBeenCalled();
    expect(markerCount(client)).toBe(0);
  } finally {
    await client.close();
  }
});

test("retained markers are cleared on socket close and capped for an unresponsive runner", async () => {
  const { client, socket, timer } = await connectedClient("owner-display-marker-cap");
  try {
    for (let i = 0; i < 70; i++) {
      const pending = client.requestHierarchySync(
        new NoOpPerformanceTracker(),
        false,
        undefined,
        100,
        undefined,
        2,
      );
      await sentHierarchyRequest(socket);
      timer.advanceTime(100);
      expect(await pending).toBeNull();
    }
    expect(markerCount(client)).toBe(64);
    client.onConnectionClosed();
    expect(markerCount(client)).toBe(0);
  } finally {
    await client.close();
  }
});

test("a runner error for an explicit display read releases its marker", async () => {
  const { client, socket } = await connectedClient("owner-display-runner-error");
  try {
    const pending = client.requestHierarchySync(
      new NoOpPerformanceTracker(),
      false,
      undefined,
      1000,
      undefined,
      2,
    );
    const { requestId } = await sentHierarchyRequest(socket);
    socket.simulateMessage(JSON.stringify({ type: "error", requestId, error: "capture failed" }));
    await pending.catch(() => null);
    expect(markerCount(client)).toBe(0);
  } finally {
    await client.close();
  }
});

test("a legacy id-less frame from another display does not answer an explicit display read", async () => {
  const { client, socket, timer } = await connectedClient("owner-display-legacy-mismatch");
  try {
    // Model a legacy APK: it never advertised or echoed a request id on this connection.
    (Reflect.get(client, "hierarchy") as CtrlProxyHierarchy).resetConnectionScopedState();
    const pending = client.requestHierarchySync(
      new NoOpPerformanceTracker(),
      false,
      undefined,
      200,
      undefined,
      2,
    );
    await sentHierarchyRequest(socket);
    // A legacy APK echoes no request id: this is the default display's push, not display 2's.
    socket.simulateMessage(frame("default push", DEFAULT_DISPLAY, 0, 5));
    timer.advanceTime(100);
    timer.advanceTime(200);
    expect(await pending).toBeNull();
  } finally {
    await client.close();
  }
});

test("a legacy id-less frame for the requested display still answers the read", async () => {
  const { client, socket, timer } = await connectedClient("owner-display-legacy-match");
  try {
    (Reflect.get(client, "hierarchy") as CtrlProxyHierarchy).resetConnectionScopedState();
    const pending = client.requestHierarchySync(
      new NoOpPerformanceTracker(),
      false,
      undefined,
      200,
      undefined,
      2,
    );
    await sentHierarchyRequest(socket);
    socket.simulateMessage(frame("external legacy", SECOND_DISPLAY, 2, 5));
    timer.advanceTime(50);
    expect((await pending)?.hierarchy.hierarchy.text).toBe("external legacy");
  } finally {
    await client.close();
  }
});

test("a raw read of another display leaves the default display's cache and geometry for the next action", async () => {
  // A cached tree is only served while its package is known to run; an unanswerable
  // liveness probe leaves the cache in place.
  const adb = new FakeAdbExecutor();
  adb.setCommandError("shell dumpsys activity processes", new Error("liveness probe unavailable"));
  const { client, socket } = await connectedClient("owner-display-raw-then-default", adb);
  try {
    const geometryBefore = client.screenGeometry.bind();
    const scaleBefore = client.getScreenScaleMetadata();
    const collector = new HierarchyCollector({
      device: { deviceId: "owner-display-raw-then-default", name: "Android", platform: "android" },
      adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
      timer: new FakeTimer(),
      androidRawClient: () => client,
    });
    const observed = { viewHierarchy: { hierarchy: {} } } as ObserveResult;

    // `observe { raw: true, display }` attaches the unfiltered tree of the observed display.
    const raw = collector.collectRaw(observed, undefined, 2);
    const { requestId, displayId } = await sentHierarchyRequest(socket);
    expect(displayId).toBe(2);
    socket.simulateMessage(frame("external raw", SECOND_DISPLAY, 2, 2, requestId));
    await raw;
    expect(observed.rawViewHierarchy?.json).toContain("external raw");

    // The default display's capture still backs the next default-display action.
    expect(cachedText(client)).toBe("default");
    expect(client.screenGeometry.bind()).toEqual(geometryBefore);
    expect(client.getScreenScaleMetadata()).toEqual(scaleBefore);
    const action = await client.getLatestHierarchy(false);
    expect(action.hierarchy.hierarchy.text).toBe("default");
    expect(socket.sent.filter((wire) => wire.includes("request_hierarchy"))).toHaveLength(1);
  } finally {
    await client.close();
  }
});
