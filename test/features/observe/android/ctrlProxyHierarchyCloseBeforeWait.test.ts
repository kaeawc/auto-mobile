import { expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../../../src/features/observe/android/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

test.each([false, true])(
  "close during ADB dispatch settles hierarchy wait before registration (replacement=%s)",
  async (replace) => {
    const timer = new FakeTimer();
    let socket: FakeWebSocket | null = new FakeWebSocket("ws://fake", "none", 0, timer);
    await Promise.resolve();
    socket.send = () => {
      throw new Error("send failed");
    };
    let releaseBroadcast: () => void = () => {};
    const broadcast = new Promise<void>((resolve) => {
      releaseBroadcast = resolve;
    });
    let started = false;
    const adb = new FakeAdbExecutor();
    adb.executeCommand = async () => {
      started = true;
      await broadcast;
      return { stdout: "", stderr: "" };
    };
    const context: HierarchyDelegateContext = {
      getWebSocket: () => socket,
      requestManager: new RequestManager(timer),
      timer,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
      device: { deviceId: "fake", platform: "android", name: "Fake" },
      adb,
      getCachedHierarchy: () => null,
      setCachedHierarchy: () => {},
      getLastWebSocketTimeout: () => 0,
      setLastWebSocketTimeout: () => {},
    };
    const hierarchy = new CtrlProxyHierarchy(context);
    let settled = false;
    const pending = hierarchy.requestHierarchySync().then((value) => {
      settled = true;
      return value;
    });
    for (let turn = 0; turn < 30; turn++) {
      await Promise.resolve();
    }
    expect(started).toBe(true);
    socket = replace ? new FakeWebSocket("ws://replacement", "none", 0, timer) : null;
    hierarchy.rejectAllPendingHierarchy("closed");
    releaseBroadcast();
    for (let turn = 0; turn < 30; turn++) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);
    expect(await pending).toBeNull();
    expect(timer.now()).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(0);
  },
);
