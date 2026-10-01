import { expect, spyOn, test } from "bun:test";
import { createDeviceHierarchyCapture } from "../../../src/features/observe/DeviceHierarchyCapture";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { ViewHierarchyResult } from "../../../src/models";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";

function fixture(elapsed: number, incomplete = true, updatedAt?: number) {
  const timer = new FakeTimer();
  const adb = new FakeAdbClient();
  adb.setForegroundApp({ packageName: "com.test", userId: 0 });
  adb.setCommandResult(
    "shell cat /data/local/tmp/automobile-hierarchy-dump.xml",
    '<hierarchy><node package="com.test" class="android.widget.Button" resource-id="com.test:id/target" text="Target" bounds="[100,0][150,50]" /></hierarchy>',
  );
  const raw: ViewHierarchyResult = {
    packageName: "com.test",
    ctrlProxyIncomplete: incomplete,
    updatedAt,
    hierarchy: {
      node: {
        package: "com.test",
        "resource-id": "com.test:id/source",
        bounds: { left: 0, top: 0, right: 50, bottom: 50 },
      },
    },
  };
  const capture = createDeviceHierarchyCapture(
    { platform: "android", deviceId: "fake", name: "fake" },
    {
      timer,
      ids: new FakeIdGenerator(["dump", "capture"]),
      adbFactory: { create: () => adb },
      syncClientFactory: () => ({
        requestHierarchySync: async () => {
          timer.advanceTime(elapsed);
          return { hierarchy: raw };
        },
        convertToViewHierarchyResult: () => ({ ...raw, updatedAt: undefined }),
      }),
    },
  );
  return { capture, adb };
}

test("fresh Android capture supplements missing app nodes within the remaining deadline", async () => {
  const { capture, adb } = fixture(400);
  const signal = new AbortController().signal;
  const snapshot = await capture.capture({ freshness: "fresh", timeoutMs: 1000, signal });
  expect(
    snapshot.nodes.find((node) => node.nativeId === "com.test:id/target")?.properties[
      "hierarchy-source"
    ],
  ).toBe("uiautomator");
  expect(snapshot.hierarchy.ctrlProxyIncomplete).toBe(true);
  expect(adb.getCommandCalls()).toHaveLength(3);
  expect(adb.getCommandCalls()[0]).toMatchObject({ timeoutMs: 600, signal });
});

test("fresh Android capture forwards the injected ADB factory to its sync client", async () => {
  const device = { platform: "android" as const, deviceId: "factory-test", name: "factory-test" };
  const raw = {
    hierarchy: { node: { text: "Ready", bounds: { left: 0, top: 0, right: 50, bottom: 50 } } },
  };
  const adbFactory = { create: () => new FakeAdbClient() };
  const singleton = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
    requestHierarchySync: async () => ({ hierarchy: raw }),
    convertToViewHierarchyResult: () => raw,
  } as any);
  try {
    await createDeviceHierarchyCapture(device, { adbFactory }).capture({ freshness: "fresh" });
    expect(singleton).toHaveBeenCalledWith(device, adbFactory);
  } finally {
    singleton.mockRestore();
  }
});

test("fresh Android capture preserves the device timestamp across conversion", async () => {
  const { capture } = fixture(0, false, 1234);
  const snapshot = await capture.capture({ freshness: "fresh", minTimestamp: 1234 });
  expect(snapshot.hierarchy.updatedAt).toBe(1234);
});

test("fresh supplemented Android capture validates the native floor without timestamping the mixed tree", async () => {
  const { capture } = fixture(0, true, 1234);
  const snapshot = await capture.capture({ freshness: "fresh", minTimestamp: 1234 });
  expect(snapshot.nodes.some((node) => node.nativeId === "com.test:id/target")).toBe(true);
  expect(snapshot.updatedAt).toBeUndefined();
  expect(snapshot.hierarchy.updatedAt).toBeUndefined();
  await expect(capture.capture({ freshness: "fresh", minTimestamp: 1235 })).rejects.toThrow(
    "timestamp floor",
  );
});

test("fresh iOS capture converts the XCTest root before normalization", async () => {
  const raw = {
    hierarchy: {
      class: "XCUIElementTypeWindow",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [{ class: "XCUIElementTypeButton", text: "Child" }],
    },
  };
  let converted = false;
  const capture = createDeviceHierarchyCapture(
    { platform: "ios", deviceId: "ios-fake", name: "ios-fake" },
    {
      timer: new FakeTimer(),
      syncClientFactory: () => ({
        requestHierarchySync: async () => ({ hierarchy: raw }),
        convertToViewHierarchyResult: () => {
          converted = true;
          return { hierarchy: { node: raw.hierarchy }, screenWidth: 100, screenHeight: 100 };
        },
      }),
    },
  );
  const snapshot = await capture.capture({ freshness: "fresh" });
  expect(converted).toBe(true);
  expect(snapshot.nodes.some((node) => node.className === "XCUIElementTypeWindow")).toBe(true);
  expect(snapshot.nodes.some((node) => node.className === "XCUIElementTypeButton")).toBe(true);
});

test.each([false, true])(
  "capture avoids supplementation when complete or budget exhausted (exhausted=%s)",
  async (exhausted) => {
    const { capture, adb } = fixture(exhausted ? 1000 : 0, exhausted);
    const snapshot = await capture.capture({ freshness: "fresh", timeoutMs: 1000 });
    expect(snapshot.nodes.some((node) => node.nativeId === "com.test:id/target")).toBe(false);
    expect(adb.getCommandCalls()).toEqual([]);
  },
);

test.each(["android", "ios"] as const)(
  "observer capture on %s uses the existing read request while an owner action is pending",
  async (platform) => {
    const raw: ViewHierarchyResult = {
      hierarchy: { node: { text: "Observer", bounds: { left: 0, top: 0, right: 20, bottom: 20 } } },
      screenWidth: 20,
      screenHeight: 20,
    };
    let releaseAction: (() => void) | undefined;
    const action = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    let actionCompleted = false;
    void action.then(() => {
      actionCompleted = true;
    });
    let observerCalls = 0;
    let normalCalls = 0;
    const capture = createDeviceHierarchyCapture(
      { platform, deviceId: `${platform}-observer`, name: "Observer" },
      {
        timer: new FakeTimer(),
        syncClientFactory: () => ({
          requestHierarchySync: async () => {
            normalCalls++;
            return { hierarchy: raw };
          },
          requestHierarchySyncForObserver: async () => {
            observerCalls++;
            return { hierarchy: raw };
          },
          convertToViewHierarchyResult: () => raw,
        }),
      },
    );
    const observed = await capture.capture({ freshness: "fresh", observerMode: true });
    expect(observed.hierarchy.hierarchy.node).toBeDefined();
    expect(observerCalls).toBe(1);
    expect(normalCalls).toBe(0);
    expect(actionCompleted).toBe(false);
    releaseAction?.();
    await action;
    expect(actionCompleted).toBe(true);
  },
);
