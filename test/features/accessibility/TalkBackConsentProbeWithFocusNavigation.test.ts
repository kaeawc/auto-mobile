import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { CtrlProxyTalkBackDialogProbe } from "../../../src/features/accessibility/TalkBackDialogProbe";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import {
  FocusNavigationExecutor,
  type FocusNavigationDriver,
  type FocusNavigationPath,
} from "../../../src/features/talkback/FocusNavigationExecutor";
import {
  DeviceDataStreamSocketServer,
  installDeviceDataStreamSocketServerForTesting,
  stopDeviceDataStreamSocketServer,
} from "../../../src/daemon/deviceDataStreamSocketServer";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import type { BootedDevice } from "../../../src/models";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";

const device: BootedDevice = {
  deviceId: "talkback-probe-device",
  platform: "android",
  isEmulator: true,
  name: "Probe Test Device",
};

class CapturingWebSocket extends FakeWebSocket {
  sentMessages: string[] = [];
  send(data: Parameters<FakeWebSocket["send"]>[0]): void {
    this.sentMessages.push(data.toString());
    super.send(data);
  }
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 40; turn++) {
    await Promise.resolve();
  }
};

interface SentRequest {
  type: string;
  requestId: string;
}

/**
 * The TalkBack consent-dialog probe (#10147) and focus navigation (#10144) both ask CtrlProxy
 * over the same WebSocket. The probe reads the hierarchy with the observation-stream push
 * suppressed; navigation reads traversal order, current focus and the cached screen size. The
 * REAL client is used so correlation, suppression and the hierarchy cache are the production ones.
 */
async function createHarness() {
  const timer = new FakeTimer();
  let socket: CapturingWebSocket | null = null;
  const client = AndroidCtrlProxyClient.createForTesting(
    device,
    new FakeAdbExecutor(),
    (url: string) => {
      socket = new CapturingWebSocket(url, "none", 0, timer);
      return socket;
    },
    timer,
  );
  const server = new DeviceDataStreamSocketServer("/fake/talkback-probe.sock", timer, {
    authorize: () => {},
  });
  installDeviceDataStreamSocketServerForTesting(server);
  const pushes = spyOn(server, "pushHierarchyUpdate").mockReturnValue(null);
  const backoff = spyOn(client, "startScreenshotBackoff").mockImplementation(() => {});
  await client.ensureConnected();
  const wire = socket as CapturingWebSocket | null;
  if (!wire) {
    throw new Error("harness: the CtrlProxy client never opened its WebSocket");
  }

  const sent = (type: string): SentRequest[] =>
    wire.sentMessages
      .map((message) => JSON.parse(message) as SentRequest)
      .filter((message) => message.type === type);
  const reply = (message: Record<string, unknown>): void =>
    wire.simulateMessage(JSON.stringify({ timestamp: timer.now(), ...message }));
  const replyHierarchy = (
    requestId: string | null,
    updatedAt: number,
    children: unknown[],
    screen = { width: 1080, height: 2340 },
  ): void =>
    reply({
      type: "hierarchy_update",
      requestId,
      data: {
        updatedAt,
        packageName: "com.android.settings",
        windows: [{ bounds: { left: 0, top: 0, right: screen.width, bottom: screen.height } }],
        hierarchy: { node: children },
      },
    });

  // Navigation's driver: the real client for every read, a recorder for the swipe gesture.
  const swipes: number[] = [];
  const driver: FocusNavigationDriver = {
    requestTraversalOrder: () => client.requestTraversalOrder(),
    requestCurrentFocus: () => client.requestCurrentFocus(),
    requestSwipe: async () => {
      swipes.push(swipes.length);
      return { success: true, totalTimeMs: 1 };
    },
    // The client's cached screen geometry, which every hierarchy frame refreshes; reading it
    // spawns nothing, unlike getAccessibilityHierarchy's liveness checks.
    getScreenSize: async () => ({
      width: client.screenGeometry.width ?? 0,
      height: client.screenGeometry.height ?? 0,
    }),
  };
  const executor = new FocusNavigationExecutor({
    timer,
    driverFactory: { createDriver: () => driver },
  });
  const probe = new CtrlProxyTalkBackDialogProbe(device, () => client);
  return {
    timer,
    client,
    pushes,
    backoff,
    sent,
    reply,
    replyHierarchy,
    swipes,
    driver,
    executor,
    probe,
  };
}

const consentTree = [
  { text: "Allow TalkBack to have full control?" },
  {
    "resource-id": "android:id/button1",
    text: "Allow",
    bounds: { left: 180, top: 684, right: 540, bottom: 740 },
  },
];

const noSwipePath: FocusNavigationPath = {
  currentFocusIndex: 0,
  targetFocusIndex: 0,
  swipeCount: 0,
  direction: "forward",
};

describe("TalkBack consent probe and focus navigation share one CtrlProxy connection", () => {
  beforeEach(() => {
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
  });
  afterEach(async () => {
    await stopDeviceDataStreamSocketServer();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("interleaved replies reach their own waiters and the probe never pushes to the observation stream", async () => {
    const h = await createHarness();
    try {
      // Seed the cache the way a live stream does, then forget the seeding push.
      h.replyHierarchy(null, 100, [{ text: "Seed" }]);
      h.pushes.mockClear();
      h.backoff.mockClear();

      const probing = h.probe.probe();
      await flush();
      const navigating = h.executor.navigateToElement(
        "device-1",
        { resourceId: "target" },
        noSwipePath,
        { verificationInterval: 1, swipeDelay: 0 },
      );
      await flush();
      const hierarchyRequest = h.sent("request_hierarchy").at(-1)!;
      const traversalRequest = h.sent("get_traversal_order").at(-1);
      expect(traversalRequest).toBeDefined();

      // The probe's frame arrives between navigation's request and its reply.
      h.replyHierarchy(hierarchyRequest.requestId, 200, consentTree);
      h.reply({
        type: "traversal_order_result",
        requestId: traversalRequest!.requestId,
        totalTimeMs: 1,
        result: {
          elements: [
            {
              "resource-id": "target",
              bounds: { left: 0, top: 0, right: 10, bottom: 10 },
            },
          ],
          focusedIndex: 0,
          totalCount: 1,
        },
      });

      expect(await probing).toEqual({ kind: "dialog", tap: { x: 360, y: 712 } });
      expect(await navigating).toBe(true);
      // Neither read put a frame on the stream or restarted the screenshot back-off.
      expect(h.pushes).not.toHaveBeenCalled();
      expect(h.backoff).not.toHaveBeenCalled();
      expect(h.client.hierarchyObservationStreamSuppressions.size).toBe(0);
      expect(h.swipes).toEqual([]);
    } finally {
      await h.client.close();
    }
  });

  test("a probe in flight does not change what navigation reads as the screen size", async () => {
    const h = await createHarness();
    try {
      h.replyHierarchy(null, 100, [{ text: "Seed" }], { width: 1080, height: 2340 });
      h.pushes.mockClear();

      const probing = h.probe.probe();
      await flush();
      // Navigation's size read is a cache read and must not wait for, or consume, the probe.
      const size = await h.driver.getScreenSize();
      expect(size).toEqual({ width: 1080, height: 2340 });
      expect(h.sent("request_hierarchy")).toHaveLength(1);

      const hierarchyRequest = h.sent("request_hierarchy")[0]!;
      h.replyHierarchy(hierarchyRequest.requestId, 200, consentTree, { width: 1080, height: 2340 });
      await probing;

      expect(await h.driver.getScreenSize()).toEqual({
        width: 1080,
        height: 2340,
      });
      expect(h.pushes).not.toHaveBeenCalled();
    } finally {
      await h.client.close();
    }
  });

  test("an older probe frame cannot overwrite a newer cached hierarchy that navigation reads", async () => {
    const h = await createHarness();
    try {
      const probing = h.probe.probe();
      await flush();
      const hierarchyRequest = h.sent("request_hierarchy")[0]!;
      // A newer unsolicited frame (rotated screen) lands first, then the probe's older reply.
      h.replyHierarchy(null, 300, [{ text: "Newer" }], { width: 2340, height: 1080 });
      h.replyHierarchy(hierarchyRequest.requestId, 200, consentTree, { width: 1080, height: 2340 });
      await probing;

      expect(await h.driver.getScreenSize()).toEqual({ width: 2340, height: 1080 });
    } finally {
      await h.client.close();
    }
  });
});
