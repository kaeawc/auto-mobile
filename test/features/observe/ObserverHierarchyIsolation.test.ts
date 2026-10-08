import { FakeScreenshotPathProtection } from "../../fakes/FakeScreenshotPathProtection";
import { afterEach, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeWebSocket,
  createSuccessWebSocketFactory,
  createInstantFailureWebSocketFactory,
} from "../../fakes/FakeWebSocket";
import { PortManager } from "../../../src/utils/PortManager";
import { createDeviceHierarchyCapture } from "../../../src/features/observe/DeviceHierarchyCapture";
import { DaemonState } from "../../../src/daemon/daemonState";
import type { RequestManager } from "../../../src/utils/RequestManager";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { readFileSync } from "node:fs";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";

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

async function sentRequestId(socket: CapturingSocket, type: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const request = socket.sent
      .map((wire) => JSON.parse(wire) as { type?: string; requestId?: string })
      .find((message) => message.type === type);
    if (request?.requestId) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return request.requestId;
    }
    await Promise.resolve();
  }
  throw new Error(`No ${type} request was sent`);
}

afterEach(() => {
  AndroidCtrlProxyClient.resetInstances();
  IOSCtrlProxyClient.resetInstances();
  PortManager.setPortAvailabilityCheckerForTesting(null);
  DaemonState.getInstance().reset();
});

test.each(["android", "ios"] as const)(
  "owned %s observer reuses the connected hierarchy client without reconnect or handshake",
  async (platform) => {
    const device = { deviceId: `${platform}-owned-observer`, name: platform, platform };
    const owner = { sessionId: "owner", poolStatus: "assigned" };
    const daemon = DaemonState.getInstance();
    Reflect.set(daemon, "sessionManager", {});
    Reflect.set(daemon, "devicePool", { getDevice: () => owner });
    Reflect.set(daemon, "deviceSessionRegistry", {});
    let reads = 0;
    let reconnects = 0;
    const hierarchy = {
      hierarchy: {
        node: { text: "Owned screen", bounds: { left: 0, top: 0, right: 30, bottom: 30 } },
      },
      screenWidth: 30,
      screenHeight: 30,
    };
    const existing = {
      isConnected: () => true,
      requestHierarchySync: async () => {
        throw new Error("normal request used");
      },
      requestHierarchySyncForObserver: async () => {
        reads++;
        return { hierarchy };
      },
      convertToViewHierarchyResult: () => hierarchy,
    };
    const clientClass = platform === "android" ? AndroidCtrlProxyClient : IOSCtrlProxyClient;
    const previousExisting = Reflect.get(clientClass, "getExistingInstance");
    const previousGet = Reflect.get(clientClass, "getInstance");
    Reflect.set(clientClass, "getExistingInstance", () => existing);
    Reflect.set(clientClass, "getInstance", () => {
      reconnects++;
      throw new Error("reconnect");
    });
    try {
      const capture = createDeviceHierarchyCapture(device, {
        viewHierarchy: { getViewHierarchy: async () => hierarchy },
        timer: new FakeTimer(),
      });
      const observed = await capture.capture({ freshness: "fresh", observerMode: true });
      expect(observed.hierarchy.hierarchy.node).toBeDefined();
      expect(reads).toBe(1);
      expect(reconnects).toBe(0);
      expect(owner).toEqual({ sessionId: "owner", poolStatus: "assigned" });
    } finally {
      Reflect.set(clientClass, "getExistingInstance", previousExisting);
      Reflect.set(clientClass, "getInstance", previousGet);
    }
  },
);

test.each(["android", "ios"] as const)(
  "%s observer closes its transient client and leaves ownership idle",
  async (platform) => {
    const device = { deviceId: `${platform}-unowned-observer`, name: platform, platform };
    const poolRecord = { sessionId: undefined, poolStatus: "idle" };
    const daemon = DaemonState.getInstance();
    Reflect.set(daemon, "sessionManager", {});
    Reflect.set(daemon, "devicePool", { getDevice: () => poolRecord });
    Reflect.set(daemon, "deviceSessionRegistry", {});
    const hierarchy = {
      hierarchy: { node: { text: "Booted", bounds: { left: 0, top: 0, right: 30, bottom: 30 } } },
      screenWidth: 30,
      screenHeight: 30,
    };
    let starts = 0;
    let closes = 0;
    const client = {
      connectForObservationRead: async () => true,
      close: async () => {
        closes++;
      },
      requestHierarchySyncForObserver: async () => ({ hierarchy }),
      convertToViewHierarchyResult: () => hierarchy,
    };
    const clientClass = platform === "android" ? AndroidCtrlProxyClient : IOSCtrlProxyClient;
    const previousExisting = Reflect.get(clientClass, "getExistingInstance");
    const previousGet = Reflect.get(clientClass, "createForObservationRead");
    Reflect.set(clientClass, "getExistingInstance", () => null);
    Reflect.set(clientClass, "createForObservationRead", () => {
      starts++;
      return client;
    });
    try {
      const capture = createDeviceHierarchyCapture(device, {
        viewHierarchy: { getViewHierarchy: async () => hierarchy },
        timer: new FakeTimer(),
      });
      const observed = await capture.capture({ freshness: "fresh", observerMode: true });
      expect(observed.hierarchy.hierarchy.node).toBeDefined();
      expect(starts).toBe(1);
      expect(closes).toBe(1);
      expect(poolRecord).toEqual({ sessionId: undefined, poolStatus: "idle" });
    } finally {
      Reflect.set(clientClass, "getExistingInstance", previousExisting);
      Reflect.set(clientClass, "createForObservationRead", previousGet);
    }
  },
);

test.each(["android", "ios"] as const)(
  "owned %s observer does not start a replacement when its client is disconnected",
  async (platform) => {
    const device = { deviceId: `${platform}-disconnected-owner`, name: platform, platform };
    const daemon = DaemonState.getInstance();
    Reflect.set(daemon, "sessionManager", {});
    Reflect.set(daemon, "devicePool", { getDevice: () => ({ sessionId: "owner" }) });
    Reflect.set(daemon, "deviceSessionRegistry", {});
    const clientClass = platform === "android" ? AndroidCtrlProxyClient : IOSCtrlProxyClient;
    const previousExisting = Reflect.get(clientClass, "getExistingInstance");
    const previousGet = Reflect.get(clientClass, "createForObservationRead");
    let starts = 0;
    let connects = 0;
    let closes = 0;
    const existing = {
      isConnected: () => false,
      connectForObservationRead: () => {
        connects++;
        return Promise.resolve(true);
      },
      close: async () => {
        closes++;
      },
    };
    Reflect.set(clientClass, "getExistingInstance", () => existing);
    Reflect.set(clientClass, "createForObservationRead", () => {
      starts++;
      throw new Error("replacement");
    });
    try {
      const capture = createDeviceHierarchyCapture(device, {
        viewHierarchy: { getViewHierarchy: async () => ({ hierarchy: {} }) },
      });
      await expect(capture.capture({ freshness: "fresh", observerMode: true })).rejects.toThrow(
        "session-owned and has no connected hierarchy service",
      );
      expect(starts).toBe(0);
      expect(connects).toBe(0);
      expect(closes).toBe(0);
    } finally {
      Reflect.set(clientClass, "getExistingInstance", previousExisting);
      Reflect.set(clientClass, "createForObservationRead", previousGet);
    }
  },
);

test.each(["android", "ios"] as const)(
  "unowned %s connect-only observer reads through a transient when the singleton is disconnected",
  async (platform) => {
    const device = { deviceId: `${platform}-idle-disconnected`, name: platform, platform };
    const daemon = DaemonState.getInstance();
    Reflect.set(daemon, "sessionManager", {});
    Reflect.set(daemon, "devicePool", { getDevice: () => ({ sessionId: undefined }) });
    Reflect.set(daemon, "deviceSessionRegistry", {});
    const hierarchy = {
      hierarchy: {
        node: { text: "Available", bounds: { left: 0, top: 0, right: 30, bottom: 30 } },
      },
      screenWidth: 30,
      screenHeight: 30,
    };
    let singletonConnects = 0;
    let singletonCloses = 0;
    let transientConnects = 0;
    let transientCloses = 0;
    const existing = {
      isConnected: () => false,
      connectForObservationRead: async () => {
        singletonConnects++;
        return true;
      },
      close: async () => {
        singletonCloses++;
      },
    };
    const transient = {
      connectForObservationRead: async () => {
        transientConnects++;
        return true;
      },
      close: async () => {
        transientCloses++;
      },
      requestHierarchySyncForObserver: async () => ({ hierarchy }),
      convertToViewHierarchyResult: () => hierarchy,
    };
    const clientClass = platform === "android" ? AndroidCtrlProxyClient : IOSCtrlProxyClient;
    const previousExisting = Reflect.get(clientClass, "getExistingInstance");
    const previousFactory = Reflect.get(clientClass, "createForObservationRead");
    Reflect.set(clientClass, "getExistingInstance", () => existing);
    Reflect.set(clientClass, "createForObservationRead", () => transient);
    try {
      const capture = createDeviceHierarchyCapture(device, { timer: new FakeTimer() });
      const result = await capture.capture({ freshness: "fresh", observerMode: true });
      expect(result.hierarchy.hierarchy.node).toBeDefined();
      expect(transientConnects).toBe(1);
      expect(transientCloses).toBe(1);
      expect(singletonConnects).toBe(0);
      expect(singletonCloses).toBe(0);
      expect(clientClass.getExistingInstance(device.deviceId)).toBe(existing);
    } finally {
      Reflect.set(clientClass, "getExistingInstance", previousExisting);
      Reflect.set(clientClass, "createForObservationRead", previousFactory);
    }
  },
);

test("Android transient uses its own forward and leaves the disconnected singleton's port and lease", async () => {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const device = {
    deviceId: "android-idle-forward",
    name: "Android",
    platform: "android" as const,
  };
  const adb = new FakeAdbExecutor();
  const existing = AndroidCtrlProxyClient.createForTesting(
    device,
    adb,
    createInstantFailureWebSocketFactory(new FakeTimer()),
    new FakeTimer(),
  );
  AndroidCtrlProxyClient.registerForTesting(existing, device.deviceId);
  const ownerPort = PortManager.getPort(device.deviceId)!;
  let holders = 0;
  let forks = 0;
  const lease = {
    tryAcquire: () => {
      holders++;
      return true;
    },
    release: () => {
      holders--;
    },
    getLastOwnerPid: () => undefined,
    fork: () => {
      forks++;
      return {
        tryAcquire: () => {
          holders++;
          return true;
        },
        release: () => {
          holders--;
        },
        getLastOwnerPid: () => undefined,
      };
    },
  };
  Reflect.set(existing, "ctrlProxyForwardLease", lease);
  lease.tryAcquire();
  const transient = AndroidCtrlProxyClient.createForObservationRead(
    device,
    new FakeAdbClientFactory(adb),
    existing,
  );
  const transientPort = Reflect.get(transient, "localPort") as number;
  const ownerForward = `${device.deviceId} tcp:${ownerPort} tcp:${PortManager.DEVICE_PORT}`;
  const transientForward = `${device.deviceId} tcp:${transientPort} tcp:${PortManager.DEVICE_PORT}`;
  const response = (stdout: string) => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (part: string) => stdout.includes(part),
  });
  adb.setCommandResponseSequence("forward --list", [
    response(ownerForward),
    response(ownerForward),
    response(`${ownerForward}\n${transientForward}`),
    response(`${ownerForward}\n${transientForward}`),
    response(ownerForward),
  ]);
  try {
    expect(transientPort).not.toBe(ownerPort);
    await transient.setupPortForwarding();
    await existing.sweepOrphanedCtrlProxyPortForwards();
    await transient.close();
    expect(forks).toBe(1);
    expect(holders).toBe(1);
    expect(PortManager.getPort(device.deviceId)).toBe(ownerPort);
    expect(adb.getExecutedCommands()).toContain(
      `forward tcp:${transientPort} tcp:${PortManager.DEVICE_PORT}`,
    );
    expect(adb.getExecutedCommands()).toContain(`forward --remove tcp:${transientPort}`);
    expect(adb.getExecutedCommands()).not.toContain(`forward --remove tcp:${ownerPort}`);
    expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBe(existing);
  } finally {
    await transient.close();
    lease.release();
    await existing.close();
  }
});

test.each(["android", "ios"] as const)(
  "%s observer queues behind a pending owner request without cancelling it",
  async (platform) => {
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    const timer = new FakeTimer();
    const device = { deviceId: `${platform}-pending-owner`, name: platform, platform };
    const client =
      platform === "android"
        ? AndroidCtrlProxyClient.createForTesting(
            device,
            new FakeAdbExecutor(),
            createSuccessWebSocketFactory(timer),
            timer,
          )
        : IOSCtrlProxyClient.createForTesting(
            device,
            8765,
            createSuccessWebSocketFactory(timer),
            timer,
          );
    const requests = Reflect.get(client, "requestManager") as RequestManager;
    const ownerId = requests.generateId("owner-action");
    const ownerAction = requests.register(ownerId, "owner-action", 1000, () => ({ ok: false }));
    let reads = 0;
    const priorHierarchy = Reflect.get(client, "_hierarchy");
    Reflect.set(
      client,
      "_hierarchy",
      platform === "android"
        ? {
            requestHierarchySyncForObserver: async () => {
              reads++;
              return null;
            },
          }
        : {
            requestHierarchySync: async () => {
              reads++;
              return null;
            },
          },
    );
    try {
      const observation = client.requestHierarchySyncForObserver(
        new NoOpPerformanceTracker(),
        false,
      );
      await Promise.resolve();
      expect(reads).toBe(0);
      expect(requests.isPending(ownerId)).toBe(true);
      requests.resolve(ownerId, { ok: true });
      timer.advanceTime(10);
      expect(await ownerAction).toEqual({ ok: true });
      await observation;
      expect(reads).toBe(1);
    } finally {
      Reflect.set(client, "_hierarchy", priorHierarchy);
      await client.close();
    }
  },
);

test("Android observer change replaces the displaced owner push", async () => {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "android-observer", name: "Android", platform: "android" },
    new FakeAdbExecutor(),
    createSuccessWebSocketFactory(timer),
    timer,
  );
  const navigation = spyOn(client, "getHierarchyNavigationDetector");
  let frames = 0;
  const originalPush = Reflect.get(client, "pushHierarchyToObservationStream");
  Reflect.set(client, "pushHierarchyToObservationStream", () => {
    frames++;
  });
  try {
    const requestId = "observer-android-1";
    const observerIds = Reflect.get(client, "observerHierarchyRequestIds") as Map<string, boolean>;
    observerIds.set(requestId, false);
    client.handleHierarchyUpdate(
      { updatedAt: 1, packageName: "com.example", hierarchy: { text: "Read" } },
      undefined,
      undefined,
      requestId,
    );
    expect(client.hasCachedHierarchy()).toBe(true);
    expect(navigation).toHaveBeenCalled();
    expect(frames).toBe(1);
    expect(observerIds.has(requestId)).toBe(false);
  } finally {
    navigation.mockRestore();
    Reflect.set(client, "pushHierarchyToObservationStream", originalPush);
    await client.close();
  }
});

test("iOS observer hierarchy response leaves client cache and navigation untouched", async () => {
  const timer = new FakeTimer();
  const client = IOSCtrlProxyClient.createForTesting(
    { deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", name: "iOS", platform: "ios" },
    8765,
    createSuccessWebSocketFactory(timer),
    timer,
  );
  const navigation = spyOn(client, "getHierarchyNavigationDetector");
  let frames = 0;
  const originalPush = Reflect.get(client, "pushHierarchyToObservationStream");
  Reflect.set(client, "pushHierarchyToObservationStream", () => {
    frames++;
  });
  try {
    const requestId = "observer-ios-1";
    const observerIds = Reflect.get(client, "observerHierarchyRequestIds") as Set<string>;
    observerIds.add(requestId);
    const processMessage = Reflect.get(client, "processMessage") as (message: object) => void;
    processMessage.call(client, {
      type: "hierarchy_update",
      requestId,
      data: { updatedAt: 1, packageName: "com.example", hierarchy: { text: "Read" } },
    });
    expect(client.hasCachedHierarchy()).toBe(false);
    expect(navigation).not.toHaveBeenCalled();
    expect(frames).toBe(0);
    expect(observerIds.has(requestId)).toBe(false);
  } finally {
    navigation.mockRestore();
    Reflect.set(client, "pushHierarchyToObservationStream", originalPush);
    await client.close();
  }
});

test("Android real client routes a changed correlated observer frame through the owner push path", async () => {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const sockets = capturingSockets(timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "android-real-observer", name: "Android", platform: "android" },
    new FakeAdbExecutor(),
    sockets.factory,
    timer,
  );
  const push = spyOn(client, "pushHierarchyToObservationStream");
  try {
    expect(await client.ensureConnected()).toBe(true);
    expect((Reflect.get(client, "requestManager") as RequestManager).getPendingCount()).toBe(0);
    let navigationUpdates = 0;
    Reflect.set(client, "hierarchyNavigationDetector", {
      onHierarchyUpdate: () => {
        navigationUpdates++;
      },
    });
    const socket = sockets.socket();
    socket.simulateMessage(
      JSON.stringify({
        type: "hierarchy_update",
        data: {
          updatedAt: 1,
          packageName: "com.example",
          hierarchy: { text: "old", "resource-id": "navigation.root" },
        },
      }),
    );
    const before = push.mock.calls.length;
    const beforeNavigation = navigationUpdates;
    const pending = client.requestHierarchySyncForObserver(
      new NoOpPerformanceTracker(),
      false,
      undefined,
      100,
    );
    const requestId = await sentRequestId(socket, "request_hierarchy");
    socket.simulateMessage(
      JSON.stringify({
        type: "hierarchy_update",
        requestId,
        data: {
          updatedAt: 2,
          packageName: "com.example",
          hierarchy: { text: "new", "resource-id": "navigation.root" },
        },
      }),
    );
    expect((await pending)?.hierarchy.hierarchy.text).toBe("new");
    expect(
      (Reflect.get(client, "cachedHierarchy") as { hierarchy: { hierarchy: { text: string } } })
        .hierarchy.hierarchy.text,
    ).toBe("new");
    expect(push.mock.calls.length).toBe(before + 1);
    expect(navigationUpdates).toBe(beforeNavigation + 1);
    expect(
      (Reflect.get(client, "observerHierarchyRequestIds") as Map<string, boolean> | Set<string>)
        .size,
    ).toBe(0);
  } finally {
    push.mockRestore();
    await client.close();
  }
});

test("Android real client keeps an identical observer frame private", async () => {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const sockets = capturingSockets(timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "android-identical-observer", name: "Android", platform: "android" },
    new FakeAdbExecutor(),
    sockets.factory,
    timer,
  );
  const push = spyOn(client, "pushHierarchyToObservationStream");
  try {
    expect(await client.ensureConnected()).toBe(true);
    expect((Reflect.get(client, "requestManager") as RequestManager).getPendingCount()).toBe(0);
    Reflect.set(client, "hierarchyNavigationDetector", { onHierarchyUpdate: () => {} });
    const socket = sockets.socket();
    socket.simulateMessage(
      JSON.stringify({
        type: "hierarchy_update",
        data: { updatedAt: 1, packageName: "com.example", hierarchy: { text: "same" } },
      }),
    );
    const before = push.mock.calls.length;
    const pending = client.requestHierarchySyncForObserver(
      new NoOpPerformanceTracker(),
      false,
      undefined,
      100,
    );
    const requestId = await sentRequestId(socket, "request_hierarchy");
    socket.simulateMessage(
      JSON.stringify({
        type: "hierarchy_update",
        requestId,
        data: { updatedAt: 2, packageName: "com.example", hierarchy: { text: "same" } },
      }),
    );
    expect((await pending)?.hierarchy.hierarchy.text).toBe("same");
    expect(push.mock.calls.length).toBe(before);
  } finally {
    push.mockRestore();
    await client.close();
  }
});

test("iOS real client resolves a correlated observer frame without cache or stream writes", async () => {
  const timer = new FakeTimer();
  const sockets = capturingSockets(timer);
  const client = IOSCtrlProxyClient.createForTesting(
    { deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", name: "iOS", platform: "ios" },
    8765,
    sockets.factory,
    timer,
  );
  const push = spyOn(client, "pushHierarchyToObservationStream");
  try {
    expect(await client.ensureConnected()).toBe(true);
    expect((Reflect.get(client, "requestManager") as RequestManager).getPendingCount()).toBe(0);
    Reflect.set(client, "hierarchyNavigationDetector", { onHierarchyUpdate: () => {} });
    const socket = sockets.socket();
    const pending = client.requestHierarchySyncForObserver(
      new NoOpPerformanceTracker(),
      false,
      undefined,
      100,
    );
    const requestId = await sentRequestId(socket, "request_hierarchy");
    socket.simulateMessage(
      JSON.stringify({
        type: "hierarchy_update",
        requestId,
        data: { updatedAt: 1, packageName: "com.example", hierarchy: { text: "observer" } },
      }),
    );
    expect((await pending)?.hierarchy.hierarchy.text).toBe("observer");
    expect(client.hasCachedHierarchy()).toBe(false);
    expect(push).not.toHaveBeenCalled();
    expect((Reflect.get(client, "observerHierarchyRequestIds") as Set<string>).size).toBe(0);
  } finally {
    push.mockRestore();
    await client.close();
  }
});

test("Android uncorrelated push stays with owner and observer times out", async () => {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const sockets = capturingSockets(timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "android-uncorrelated", name: "Android", platform: "android" },
    new FakeAdbExecutor(),
    sockets.factory,
    timer,
  );
  try {
    expect(await client.ensureConnected()).toBe(true);
    const socket = sockets.socket();
    const pending = client.requestHierarchySyncForObserver(
      new NoOpPerformanceTracker(),
      false,
      undefined,
      100,
    );
    await sentRequestId(socket, "request_hierarchy");
    socket.simulateMessage(
      JSON.stringify({
        type: "hierarchy_update",
        data: { updatedAt: 1, packageName: "com.example", hierarchy: { text: "owner" } },
      }),
    );
    timer.advanceTime(100);
    expect(await pending).toBeNull();
    expect(
      (Reflect.get(client, "cachedHierarchy") as { hierarchy: { hierarchy: { text: string } } })
        .hierarchy.hierarchy.text,
    ).toBe("owner");
    expect(
      (Reflect.get(client, "observerHierarchyRequestIds") as Map<string, boolean> | Set<string>)
        .size,
    ).toBe(0);
  } finally {
    await client.close();
  }
});

test.each(["android", "ios"] as const)(
  "%s observer releases its request marker after a runner error",
  async (platform) => {
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    const timer = new FakeTimer();
    const sockets = capturingSockets(timer);
    const device = { deviceId: `${platform}-observer-error`, name: platform, platform };
    const client =
      platform === "android"
        ? AndroidCtrlProxyClient.createForTesting(
            device,
            new FakeAdbExecutor(),
            sockets.factory,
            timer,
          )
        : IOSCtrlProxyClient.createForTesting(device, 8765, sockets.factory, timer);
    try {
      expect(await client.ensureConnected()).toBe(true);
      const pending = client.requestHierarchySyncForObserver(
        new NoOpPerformanceTracker(),
        false,
        undefined,
        100,
      );
      const requestId = await sentRequestId(sockets.socket(), "request_hierarchy");
      sockets
        .socket()
        .simulateMessage(JSON.stringify({ type: "error", requestId, error: "capture failed" }));
      await pending.catch(() => null);
      expect(
        (Reflect.get(client, "observerHierarchyRequestIds") as Map<string, boolean> | Set<string>)
          .size,
      ).toBe(0);
    } finally {
      await client.close();
    }
  },
);

test.each(["android", "ios"] as const)(
  "%s observer deadline expires while the owner's request is in flight",
  async (platform) => {
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const device = { deviceId: `${platform}-owner-deadline`, name: platform, platform };
    const client =
      platform === "android"
        ? AndroidCtrlProxyClient.createForTesting(
            device,
            new FakeAdbExecutor(),
            createSuccessWebSocketFactory(timer),
            timer,
          )
        : IOSCtrlProxyClient.createForTesting(
            device,
            8765,
            createSuccessWebSocketFactory(timer),
            timer,
          );
    const requests = Reflect.get(client, "requestManager") as RequestManager;
    const ownerId = requests.generateId("owner-action");
    const owner = requests.register(ownerId, "owner-action", 1000, () => ({ ok: false }));
    try {
      // Sample the owner as the observer rejects: auto-advance keeps moving fake time
      // afterwards and would expire the owner's own 1000 ms timeout next.
      const observed = await client
        .requestHierarchySyncForObserver(new NoOpPerformanceTracker(), false, undefined, 30)
        .then(
          () => ({ error: undefined, ownerPending: requests.isPending(ownerId) }),
          (error: unknown) => ({ error, ownerPending: requests.isPending(ownerId) }),
        );
      expect(observed.error).toBeInstanceOf(Error);
      expect((observed.error as Error).message).toContain(
        "Owner's in-flight request exceeded the observer hierarchy deadline",
      );
      expect(observed.ownerPending).toBe(true);
    } finally {
      requests.resolve(ownerId, { ok: true });
      await owner;
      await client.close();
    }
  },
);

test.each(["android", "ios"] as const)(
  "%s owned observer does not reconnect after its queued owner request completes",
  async (platform) => {
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    const timer = new FakeTimer();
    const sockets = capturingSockets(timer);
    const device = { deviceId: `${platform}-owner-disconnect`, name: platform, platform };
    const client =
      platform === "android"
        ? AndroidCtrlProxyClient.createForTesting(
            device,
            new FakeAdbExecutor(),
            sockets.factory,
            timer,
          )
        : IOSCtrlProxyClient.createForTesting(device, 8765, sockets.factory, timer);
    try {
      expect(await client.ensureConnected()).toBe(true);
      const requests = Reflect.get(client, "requestManager") as RequestManager;
      const ownerId = requests.generateId("owner-action");
      const owner = requests.register(ownerId, "owner-action", 1000, () => ({ ok: false }));
      const reconnect = spyOn(client, "ensureConnected");
      const observer = client.requestHierarchySyncForObserver(
        new NoOpPerformanceTracker(),
        false,
        undefined,
        100,
      );
      await Promise.resolve();
      sockets.socket().close();
      requests.resolve(ownerId, { ok: true });
      timer.advanceTime(10);
      await owner;
      expect(await observer).toBeNull();
      expect(reconnect).not.toHaveBeenCalled();
      reconnect.mockRestore();
    } finally {
      await client.close();
    }
  },
);

test.each(["android", "ios"] as const)(
  "%s observer without a safe initialized idle pool closes its failed transient without setup or singleton",
  async (platform) => {
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    const timer = new FakeTimer();
    const device = { deviceId: `${platform}-unreachable`, name: platform, platform };
    const daemon = DaemonState.getInstance();
    Reflect.set(daemon, "sessionManager", {});
    Reflect.set(daemon, "devicePool", {
      getDevice: () => ({ sessionId: undefined }),
      assertDeviceActionable: () => {},
    });
    Reflect.set(daemon, "deviceSessionRegistry", {});
    let setupCalls = 0;
    const adb = new FakeAdbExecutor();
    const client =
      platform === "android"
        ? AndroidCtrlProxyClient.createForTesting(
            device,
            adb,
            createInstantFailureWebSocketFactory(timer),
            timer,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            () => ({
              isAccessibilityServiceHealthy: async () => false,
              setup: async () => {
                setupCalls++;
                return { success: false, message: "blocked" };
              },
            }),
            undefined,
            true,
          )
        : IOSCtrlProxyClient.createForTesting(
            device,
            8765,
            createInstantFailureWebSocketFactory(timer),
            timer,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
          );
    const clientClass = platform === "android" ? AndroidCtrlProxyClient : IOSCtrlProxyClient;
    const originalFactory = Reflect.get(clientClass, "createForObservationRead");
    Reflect.set(clientClass, "createForObservationRead", () => client);
    const close = spyOn(client, "close");
    try {
      const capture = createDeviceHierarchyCapture(device, { timer });
      await expect(capture.capture({ freshness: "fresh", observerMode: true })).rejects.toThrow(
        "no reachable hierarchy service",
      );
      expect(close).toHaveBeenCalledTimes(1);
      expect(setupCalls).toBe(0);
      expect(clientClass.getExistingInstance(device.deviceId)).toBeNull();
      expect(Reflect.get(client, "autoReconnectEnabled")).toBe(false);
    } finally {
      close.mockRestore();
      Reflect.set(clientClass, "createForObservationRead", originalFactory);
    }
  },
);

test("unowned observer bounds its transient connection by the hierarchy deadline", async () => {
  const timer = new FakeTimer();
  const device = { deviceId: "ios-slow-service", name: "iOS", platform: "ios" as const };
  const daemon = DaemonState.getInstance();
  Reflect.set(daemon, "sessionManager", {});
  Reflect.set(daemon, "devicePool", { getDevice: () => ({ sessionId: undefined }) });
  Reflect.set(daemon, "deviceSessionRegistry", {});
  let closes = 0;
  const originalFactory = IOSCtrlProxyClient.createForObservationRead;
  IOSCtrlProxyClient.createForObservationRead = (() => ({
    connectForObservationRead: () => new Promise<boolean>(() => {}),
    close: async () => {
      closes++;
    },
  })) as typeof IOSCtrlProxyClient.createForObservationRead;
  try {
    const capture = createDeviceHierarchyCapture(device, { timer });
    const pending = capture.capture({ freshness: "fresh", observerMode: true, timeoutMs: 30 });
    await Promise.resolve();
    timer.advanceTime(30);
    await expect(pending).rejects.toThrow("Observer hierarchy connection");
    expect(closes).toBe(1);
  } finally {
    IOSCtrlProxyClient.createForObservationRead = originalFactory;
  }
});

test("Android observer JPEG screenshot uses ADB while the real owner client stays untouched", async () => {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const sockets = capturingSockets(timer);
  const device = {
    deviceId: "android-observer-shot",
    name: "Android",
    platform: "android" as const,
  };
  const adb = new FakeAdbExecutor();
  const base64 = readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64");
  adb.setDefaultResponse({
    stdout: base64,
    stderr: "",
    toString: () => base64,
    trim: () => base64.trim(),
    includes: (part) => base64.includes(part),
  });
  const client = AndroidCtrlProxyClient.createForTesting(device, adb, sockets.factory, timer);
  const screenshotRequest = spyOn(client, "requestScreenshot");
  const writer = new FakeScreenshotFileWriter();
  try {
    expect(await client.ensureConnected()).toBe(true);
    AndroidCtrlProxyClient.registerForTesting(client, device.deviceId);
    const screenshot = new TakeScreenshot(
      device,
      new FakeAdbClientFactory(adb),
      timer,
      new CountingIdGenerator("observer"),
      writer,
      undefined,
      undefined,
      undefined,
      false,
      { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
    );
    const result = await screenshot.executeObservationRead({ format: "jpeg" });
    expect(result.success).toBe(true);
    expect(writer.written).toHaveLength(1);
    expect(screenshotRequest).not.toHaveBeenCalled();
    expect(adb.getExecutedCommands().some((command) => command.includes("screencap"))).toBe(true);
    expect(sockets.socket().sent.some((wire) => wire.includes("request_screenshot"))).toBe(false);
  } finally {
    screenshotRequest.mockRestore();
    await client.close();
  }
});

test.each([true, false])(
  "iOS simulator observer captures %s panel without advancing transitions",
  async (hasObservedPanel) => {
    const device = {
      deviceId: `A1B2C3D4-E5F6-7890-ABCD-EF12345678${hasObservedPanel ? "90" : "91"}`,
      name: "Duo",
      platform: "ios" as const,
      displays: {
        panels: [
          { key: "cover-1", role: "cover" as const, sizePx: { width: 100, height: 100 } },
          { key: "primary-1", role: "inner" as const, sizePx: { width: 200, height: 200 } },
        ],
        postures: [],
      },
    };
    if (hasObservedPanel) {
      displayTransitions.record(device.deviceId, {
        display: { key: "primary-1", role: "inner", generation: 1 },
        screenSize: { width: 200, height: 200 },
      } as ObserveResult);
    }
    const revision = displayTransitions.revision(device.deviceId);
    const captures: string[] = [];
    const simctl = spyOn(SimCtlClient.prototype, "screenshot").mockImplementation(
      async (_deviceId, display) => {
        captures.push(display);
        return readFileSync("test/fixtures/screenshots/black-on-white.png");
      },
    );
    const writer = new FakeScreenshotFileWriter();
    try {
      const screenshot = new TakeScreenshot(
        device,
        new FakeAdbClientFactory(new FakeAdbExecutor()),
        new FakeTimer(),
        new CountingIdGenerator("observer"),
        writer,
        undefined,
        undefined,
        undefined,
        false,
        { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
      );
      expect((await screenshot.executeObservationRead({ format: "png" })).success).toBe(true);
      expect(captures).toEqual([hasObservedPanel ? "primary-1" : "cover-1"]);
      expect(displayTransitions.revision(device.deviceId)).toBe(revision);
    } finally {
      simctl.mockRestore();
      displayTransitions.reset(device.deviceId);
    }
  },
);

test("aborted iOS simulator observer removes its frame and never pushes to the stream", async () => {
  const device = {
    deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567892",
    name: "Simulator",
    platform: "ios" as const,
  };
  const controller = new AbortController();
  const writer = new FakeScreenshotFileWriter(() => controller.abort());
  const simctl = spyOn(SimCtlClient.prototype, "screenshot").mockResolvedValue(
    readFileSync("test/fixtures/screenshots/black-on-white.png"),
  );
  try {
    const screenshot = new TakeScreenshot(
      device,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      new FakeTimer(),
      new CountingIdGenerator("observer"),
      writer,
      undefined,
      undefined,
      undefined,
      false,
      { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
    );
    let pushes = 0;
    Reflect.set(screenshot, "pushScreenshotToStream", () => {
      pushes++;
    });
    expect(await screenshot.executeObservationRead({ format: "png" }, controller.signal)).toEqual({
      success: false,
      error: OPERATION_CANCELLED_MESSAGE,
    });
    // Admission and rollback settle after the abort wins the request race.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writer.removed).toEqual(writer.written);
    expect(pushes).toBe(0);
  } finally {
    simctl.mockRestore();
  }
});

test("iOS observer screenshot uses the real open client without reconnect or stream push", async () => {
  const timer = new FakeTimer();
  const sockets = capturingSockets(timer);
  const device = {
    deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
    name: "iOS",
    platform: "ios" as const,
  };
  const client = IOSCtrlProxyClient.createForTesting(device, 8765, sockets.factory, timer);
  const writer = new FakeScreenshotFileWriter();
  try {
    expect(await client.ensureConnected()).toBe(true);
    const instances = Reflect.get(IOSCtrlProxyClient, "instances") as Map<
      string,
      IOSCtrlProxyClient
    >;
    instances.set(device.deviceId, client);
    const reconnect = spyOn(client, "ensureConnected");
    const screenshot = new TakeScreenshot(
      device,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      timer,
      new CountingIdGenerator("observer"),
      writer,
      undefined,
      undefined,
      undefined,
      false,
      { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
    );
    let pushes = 0;
    Reflect.set(screenshot, "pushScreenshotToStream", () => {
      pushes++;
    });
    const pending = screenshot.executeObservationRead({ format: "png" });
    const requestId = await sentRequestId(sockets.socket(), "request_screenshot");
    sockets.socket().simulateMessage(
      JSON.stringify({
        type: "screenshot",
        requestId,
        data: readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
        format: "png",
      }),
    );
    expect((await pending).success).toBe(true);
    expect(writer.written).toHaveLength(1);
    expect(pushes).toBe(0);
    expect(reconnect).not.toHaveBeenCalled();
    reconnect.mockRestore();
  } finally {
    await client.close();
  }
});

test("iOS observer screenshot waits for the owner's in-flight request", async () => {
  const timer = new FakeTimer();
  const sockets = capturingSockets(timer);
  const device = { deviceId: "ios-screenshot-owner", name: "iOS", platform: "ios" as const };
  const client = IOSCtrlProxyClient.createForTesting(device, 8765, sockets.factory, timer);
  try {
    expect(await client.ensureConnected()).toBe(true);
    const requests = Reflect.get(client, "requestManager") as RequestManager;
    const ownerId = requests.generateId("owner-action");
    const owner = requests.register(ownerId, "owner-action", 1000, () => ({ ok: false }));
    const screenshot = client.requestScreenshotForObserver(100);
    await Promise.resolve();
    expect(sockets.socket().sent.some((wire) => wire.includes("request_screenshot"))).toBe(false);
    requests.resolve(ownerId, { ok: true });
    timer.advanceTime(10);
    await owner;
    const requestId = await sentRequestId(sockets.socket(), "request_screenshot");
    sockets.socket().simulateMessage(
      JSON.stringify({
        type: "screenshot",
        requestId,
        data: readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
        format: "png",
      }),
    );
    expect((await screenshot).success).toBe(true);
  } finally {
    await client.close();
  }
});

test("unowned physical iOS screenshot uses and closes a real transient client", async () => {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const sockets = capturingSockets(timer);
  const device = {
    deviceId: "00008030-001C195E0C10802E",
    name: "iPhone",
    platform: "ios" as const,
  };
  const daemon = DaemonState.getInstance();
  Reflect.set(daemon, "sessionManager", {});
  Reflect.set(daemon, "devicePool", { getDevice: () => ({ sessionId: undefined }) });
  Reflect.set(daemon, "deviceSessionRegistry", {});
  const client = IOSCtrlProxyClient.createForTesting(
    device,
    8765,
    sockets.factory,
    timer,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  const originalFactory = IOSCtrlProxyClient.createForObservationRead;
  IOSCtrlProxyClient.createForObservationRead = () => client;
  const close = spyOn(client, "close");
  const writer = new FakeScreenshotFileWriter();
  try {
    const screenshot = new TakeScreenshot(
      device,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      timer,
      new CountingIdGenerator("observer"),
      writer,
      undefined,
      undefined,
      undefined,
      false,
      { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
    );
    const pending = screenshot.executeObservationRead({ format: "png" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const requestId = await sentRequestId(sockets.socket(), "request_screenshot");
    sockets.socket().simulateMessage(
      JSON.stringify({
        type: "screenshot",
        requestId,
        data: readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
        format: "png",
      }),
    );
    expect((await pending).success).toBe(true);
    expect(writer.written).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(IOSCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
  } finally {
    close.mockRestore();
    IOSCtrlProxyClient.createForObservationRead = originalFactory;
    await client.close();
  }
});

test("owned physical iOS screenshot does not create a replacement client", async () => {
  const timer = new FakeTimer();
  const device = {
    deviceId: "00008030-001C195E0C10802E",
    name: "iPhone",
    platform: "ios" as const,
  };
  const daemon = DaemonState.getInstance();
  Reflect.set(daemon, "sessionManager", {});
  Reflect.set(daemon, "devicePool", { getDevice: () => ({ sessionId: "owner" }) });
  Reflect.set(daemon, "deviceSessionRegistry", {});
  const factory = spyOn(IOSCtrlProxyClient, "createForObservationRead");
  try {
    const screenshot = new TakeScreenshot(
      device,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      timer,
      new CountingIdGenerator("observer"),
      new FakeScreenshotFileWriter(),
      undefined,
      undefined,
      undefined,
      false,
      { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
    );
    expect(await screenshot.executeObservationRead({ format: "png" })).toMatchObject({
      success: false,
      error: "Owned iOS device has no connected screenshot service",
    });
    expect(factory).not.toHaveBeenCalled();
  } finally {
    factory.mockRestore();
  }
});

test("Android observer preservation policies use separate flights and isolate only the preserved reply", async () => {
  const timer = new FakeTimer();
  const sockets = capturingSockets(timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "android-observer-policies", name: "Android", platform: "android" },
    new FakeAdbExecutor(),
    sockets.factory,
    timer,
  );
  const push = spyOn(client, "pushHierarchyToObservationStream");
  try {
    expect(await client.ensureConnected()).toBe(true);
    Reflect.set(client, "hierarchyNavigationDetector", { onHierarchyUpdate: () => {} });
    const ordinary = client.requestHierarchySyncForObserver(
      new NoOpPerformanceTracker(),
      false,
      undefined,
      100,
    );
    const preserved = client.requestHierarchySyncForObserver(
      new NoOpPerformanceTracker(),
      false,
      undefined,
      100,
      { preserveDisplayState: true },
    );
    await sentRequestId(sockets.socket(), "request_hierarchy");
    const requests = sockets
      .socket()
      .sent.map((wire) => JSON.parse(wire) as { type: string; requestId: string })
      .filter((request) => request.type === "request_hierarchy");
    expect(requests).toHaveLength(2);
    const markers = Reflect.get(client, "observerHierarchyRequestIds") as Map<string, boolean>;
    expect(requests.map((request) => markers.get(request.requestId))).toEqual([false, true]);
    for (const [index, request] of requests.entries()) {
      sockets.socket().simulateMessage(
        JSON.stringify({
          type: "hierarchy_update",
          requestId: request.requestId,
          data: {
            updatedAt: index + 1,
            packageName: "com.example",
            hierarchy: { text: index === 0 ? "owner" : "aggregate" },
          },
        }),
      );
    }
    expect((await ordinary)?.hierarchy.hierarchy.text).toBe("owner");
    expect((await preserved)?.hierarchy.hierarchy.text).toBe("aggregate");
    expect(
      (Reflect.get(client, "cachedHierarchy") as { hierarchy: { hierarchy: { text: string } } })
        .hierarchy.hierarchy.text,
    ).toBe("owner");
    expect(push).toHaveBeenCalledTimes(1);
    expect(markers.size).toBe(0);
  } finally {
    push.mockRestore();
    await client.close();
  }
});
