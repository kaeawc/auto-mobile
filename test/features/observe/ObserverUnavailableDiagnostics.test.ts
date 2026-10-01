import { afterEach, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { createDeviceHierarchyCapture } from "../../../src/features/observe/DeviceHierarchyCapture";
import { DaemonState } from "../../../src/daemon/daemonState";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeWindow } from "../../fakes/FakeWindow";
import { createInstantFailureWebSocketFactory } from "../../fakes/FakeWebSocket";

afterEach(() => {
  DaemonState.getInstance().reset();
  AndroidCtrlProxyClient.resetInstances();
  IOSCtrlProxyClient.resetInstances();
  resetObserveCacheStore();
  resetScreenshotStateStore();
});

test.each(["android", "ios"] as const)(
  "owned %s disconnected hierarchy recovery detail survives the final device read",
  async (platform) => {
    const timer = new FakeTimer();
    const device: BootedDevice = {
      deviceId: `${platform}-disconnected-diagnostic`,
      name: platform,
      platform,
    };
    const factory = new FakeAdbClientFactory(new FakeAdbExecutor());
    const daemon = DaemonState.getInstance();
    const owner = { sessionId: "owner", poolStatus: "assigned" };
    Reflect.set(daemon, "sessionManager", {});
    Reflect.set(daemon, "devicePool", { getDevice: () => owner, assertDeviceActionable: () => {} });
    Reflect.set(daemon, "deviceSessionRegistry", {});
    const client =
      platform === "android"
        ? AndroidCtrlProxyClient.createForTesting(
            device,
            new FakeAdbExecutor(),
            createInstantFailureWebSocketFactory(timer),
            timer,
          )
        : IOSCtrlProxyClient.createForTesting(
            device,
            8765,
            createInstantFailureWebSocketFactory(timer),
            timer,
          );
    const clientClass = platform === "android" ? AndroidCtrlProxyClient : IOSCtrlProxyClient;
    const existing = spyOn(clientClass, "getExistingInstance").mockReturnValue(client);
    const transient = spyOn(clientClass, "createForObservationRead");
    try {
      const screen = new RealObserveScreen(
        device,
        factory,
        {
          deviceReadOnly: true,
          window: new FakeWindow(),
          cacheStore: new FakeObserveCacheStore(timer),
          screenshotStateStore: new FakeScreenshotStateStore(timer),
          hierarchyCapture: createDeviceHierarchyCapture(device, { adbFactory: factory, timer }),
          screenshot: {
            execute: async () => ({ success: true, path: "/fake/observer.png" }),
            generateScreenshotPath: () => "/fake/observer.png",
            getActivityHash: async () => "",
          },
          screenshotEvidenceFiles: {
            stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 0 }),
          },
        },
        timer,
      );
      const result = await screen.executeDeviceRead();
      expect(result.freshness).toMatchObject({
        isFresh: false,
        category: "unavailable",
        unavailableReason: "connection_lost",
      });
      for (const detail of [result.freshness?.unavailableDetail, result.freshness?.warning]) {
        expect(detail).toContain("owning session's hierarchy client is disconnected");
        expect(detail).toContain("Run a session observe as the owner to reconnect it");
      }
      expect(result.screenshotPath).toBe("/fake/observer.png");
      expect(client.isConnected()).toBe(false);
      expect(transient).not.toHaveBeenCalled();
      expect(owner).toEqual({ sessionId: "owner", poolStatus: "assigned" });
    } finally {
      existing.mockRestore();
      transient.mockRestore();
      await client.close();
    }
  },
);

test("physical iOS with no reachable runner or cached screenshot reports the capture limitation", async () => {
  const timer = new FakeTimer();
  const device: BootedDevice = {
    deviceId: "00008030-001C195E0C10802E",
    name: "iPhone",
    platform: "ios",
  };
  const factory = new FakeAdbClientFactory(new FakeAdbExecutor());
  const client = IOSCtrlProxyClient.createForTesting(
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
  const connect = spyOn(client, "connectForObservationRead").mockResolvedValue(false);
  const close = spyOn(client, "close");
  const transient = spyOn(IOSCtrlProxyClient, "createForObservationRead").mockReturnValue(client);
  const writer = new FakeScreenshotFileWriter();
  const screenshot = new TakeScreenshot(
    device,
    factory,
    timer,
    new CountingIdGenerator("observer"),
    writer,
    undefined,
    undefined,
    undefined,
    false,
  );
  const screen = new RealObserveScreen(
    device,
    factory,
    {
      deviceReadOnly: true,
      window: new FakeWindow(),
      cacheStore: new FakeObserveCacheStore(timer),
      screenshotStateStore: new FakeScreenshotStateStore(timer),
      hierarchyCapture: createDeviceHierarchyCapture(device, { adbFactory: factory, timer }),
      screenshot,
    },
    timer,
  );
  try {
    const result = await screen.executeDeviceRead();
    expect(result.freshness?.unavailableReason).toBe("connection_lost");
    expect(result.freshness?.unavailableDetail).toContain("no reachable hierarchy service");
    expect(result.screenshotCaptureAttempted).toBe(true);
    expect(result.screenshotSettled).toBe(false);
    expect(result.screenshotPath).toBeUndefined();
    expect(result.screenshotSource).toBeUndefined();
    expect(result.screenshotSettledError).toBe(
      "No screenshot could be captured: this unowned physical iOS device has no reachable runner. Physical iOS has no host-side screenshot capture path without the runner.",
    );
    expect(writer.written).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    transient.mockRestore();
    connect.mockRestore();
    close.mockRestore();
    await client.close();
  }
});
