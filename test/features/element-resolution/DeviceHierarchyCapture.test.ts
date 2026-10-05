import { expect, spyOn, test } from "bun:test";
import {
  createDeviceHierarchyCapture,
  type HierarchySyncClient,
} from "../../../src/features/observe/DeviceHierarchyCapture";
import {
  iosHierarchyAcquisition,
  type IosHierarchyAcquisition,
} from "../../../src/features/observe/ios/types";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { ViewHierarchyResult } from "../../../src/models";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";

test("selected-display owner null reports no answer rather than service reachability", async () => {
  let ownerReads = 0;
  let observerReads = 0;
  let observedDiagnostics: unknown;
  const capture = createDeviceHierarchyCapture(
    { platform: "android", deviceId: "fake", name: "fake" },
    {
      timer: new FakeTimer(),
      syncClientFactory: () => ({
        requestHierarchySync: async (_perf, _raw, _signal, timeout, diagnostics, displayId) => {
          ownerReads++;
          expect(timeout).toBe(15000);
          expect(displayId).toBe(2);
          observedDiagnostics = diagnostics;
          return null;
        },
        requestHierarchySyncForObserver: async () => {
          observerReads++;
          return null;
        },
        convertToViewHierarchyResult: () => ({ hierarchy: {} }),
      }),
    },
  );
  await expect(capture.capture({ freshness: "fresh", displayId: 2 })).rejects.toThrow(
    "Device fake hierarchy service did not answer",
  );
  expect(ownerReads).toBe(1);
  expect(observerReads).toBe(0);
  expect(observedDiagnostics).toEqual({});
});

test.each([
  { runnerError: "selected panel extraction failed" },
  { failureReason: "Timed out waiting for hierarchy response after 250ms" },
  { failureReason: "Failed to establish CtrlProxy WebSocket connection" },
])("selected-display owner capture surfaces per-call diagnostics %j", async (failure) => {
  const capture = createDeviceHierarchyCapture(
    { platform: "android", deviceId: "fake", name: "fake" },
    {
      timer: new FakeTimer(),
      syncClientFactory: () => ({
        requestHierarchySync: async (_perf, _raw, _signal, timeout, diagnostics) => {
          expect(timeout).toBe(250);
          if (diagnostics) {
            Object.assign(diagnostics, failure);
          }
          return null;
        },
        convertToViewHierarchyResult: () => ({ hierarchy: {} }),
      }),
    },
  );
  await expect(
    capture.capture({ freshness: "fresh", displayId: 2, timeoutMs: 250 }),
  ).rejects.toThrow(Object.values(failure)[0]!);
});

function fixture(elapsed: number, incomplete = true, updatedAt?: number, autoAdvance = true) {
  const timer = new FakeTimer();
  if (autoAdvance) {
    timer.enableAutoAdvance();
  }
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
  const replies: (ViewHierarchyResult | null | Error)[] = [raw];
  const reads: Parameters<HierarchySyncClient["requestHierarchySync"]>[] = [];
  let converted = raw;
  const read: HierarchySyncClient["requestHierarchySync"] = async (...args) => {
    reads.push(args);
    if (reads.length === 1) {
      timer.advanceTime(elapsed);
    }
    const reply = replies[Math.min(reads.length - 1, replies.length - 1)];
    if (reply instanceof Error) {
      throw reply;
    }
    if (!reply) {
      return null;
    }
    converted = reply;
    return { hierarchy: reply, frameContext: reply.frameContext };
  };
  const syncClient: HierarchySyncClient = {
    requestHierarchySync: read,
    requestHierarchySyncForObserver: read,
    convertToViewHierarchyResult: () => ({ ...converted, updatedAt: undefined }),
  };
  const capture = createDeviceHierarchyCapture(
    { platform: "android", deviceId: "fake", name: "fake" },
    {
      timer,
      ids: new FakeIdGenerator(["dump", "capture"]),
      adbFactory: { create: () => adb },
      syncClientFactory: () => syncClient,
    },
  );
  return { capture, adb, timer, replies, reads, raw, syncClient };
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
  expect(adb.getCommandCalls()[0]).toMatchObject({ timeoutMs: 500, signal });
});

test("incomplete hierarchy retry returns the complete accessibility reply without a dump", async () => {
  const { capture, adb, timer, replies, reads, raw } = fixture(0, true, 1234);
  const complete = {
    ...raw,
    ctrlProxyIncomplete: false,
    updatedAt: 1235,
    frameContext: "complete",
  };
  replies.push(complete);
  const signal = new AbortController().signal;
  const snapshot = await capture.capture({
    freshness: "fresh",
    timeoutMs: 1000,
    minTimestamp: 1235,
    searchRaw: true,
    displayId: 2,
    signal,
  });
  expect(reads).toHaveLength(2);
  expect(reads.map((args) => [args[1], args[2], args[3], args[5]])).toEqual([
    [true, signal, 1000, 2],
    [true, signal, 900, 2],
  ]);
  expect(timer.getSleepHistory()).toEqual([100]);
  expect(adb.getCommandCalls()).toEqual([]);
  expect(snapshot.hierarchy.ctrlProxyIncomplete).toBe(false);
  expect(snapshot.hierarchy.frameContext).toBe("complete");
  expect(snapshot.updatedAt).toBe(1235);
  expect(snapshot.hierarchy.sources ?? []).not.toContain("uiautomator");
  expect(snapshot.nodes.some((node) => node.nativeId === "com.test:id/target")).toBe(false);
});

test("persistent incomplete hierarchy retries once then supplements within the original deadline", async () => {
  const { capture, adb, timer, reads } = fixture(0);
  const snapshot = await capture.capture({ freshness: "fresh", timeoutMs: 1000 });
  expect(reads).toHaveLength(2);
  expect(timer.getSleepHistory()).toEqual([100]);
  expect(adb.getCommandCalls()[0]).toMatchObject({
    command: "shell uiautomator dump /data/local/tmp/automobile-hierarchy-dump.xml",
    timeoutMs: 900,
  });
  expect(adb.getCommandCalls()).toHaveLength(3);
  expect(snapshot.hierarchy.sources).toContain("uiautomator");
  expect(snapshot.hierarchy.ctrlProxyIncomplete).toBe(true);
});

test.each([null, new Error("service absent")])(
  "initial unavailable service preserves the existing failure without retry or dump: %s",
  async (reply) => {
    const { capture, adb, timer, replies, reads } = fixture(0);
    replies[0] = reply;
    await expect(capture.capture({ freshness: "fresh" })).rejects.toThrow(
      reply === null ? "hierarchy service did not answer" : "service absent",
    );
    expect(reads).toHaveLength(1);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(adb.getCommandCalls()).toEqual([]);
  },
);

test.each([false, true])(
  "complete or observer capture has no retry or dump (observer=%s)",
  async (observerMode) => {
    const { capture, adb, timer, reads } = fixture(0, observerMode);
    await capture.capture({ freshness: "fresh", observerMode });
    expect(reads).toHaveLength(1);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(adb.getCommandCalls()).toEqual([]);
  },
);

test.each([null, new Error("retry disconnected")])(
  "failed incomplete hierarchy retry retains the original dump fallback: %s",
  async (reply) => {
    const { capture, adb, timer, replies, reads } = fixture(0);
    replies.push(reply);
    const snapshot = await capture.capture({ freshness: "fresh", timeoutMs: 1000 });
    expect(reads).toHaveLength(2);
    expect(timer.getSleepHistory()).toEqual([100]);
    expect(adb.getCommandCalls()).toHaveLength(3);
    expect(snapshot.hierarchy.sources).toContain("uiautomator");
  },
);

test("incomplete hierarchy with insufficient retry budget supplements immediately", async () => {
  const { capture, adb, timer, reads } = fixture(0);
  await capture.capture({ freshness: "fresh", timeoutMs: 100 });
  expect(reads).toHaveLength(1);
  expect(timer.getSleepHistory()).toEqual([]);
  expect(adb.getCommandCalls()[0]?.timeoutMs).toBe(100);
});

test("incomplete hierarchy retry consuming the deadline does not dump", async () => {
  const { capture, adb, timer, reads, syncClient } = fixture(0);
  const read = syncClient.requestHierarchySync;
  syncClient.requestHierarchySync = async (...args) => {
    if (reads.length === 0) {
      return read(...args);
    }
    reads.push(args);
    return new Promise(() => {});
  };
  await capture.capture({ freshness: "fresh", timeoutMs: 1000 });
  // The sync deadline is enforced even if the client never answers the retry.
  expect(reads).toHaveLength(2);
  expect(timer.getSleepHistory()).toEqual([100]);
  expect(adb.getCommandCalls()).toEqual([]);
});

test("incomplete hierarchy retry backoff honours cancellation without further I/O", async () => {
  const { capture, adb, timer, reads } = fixture(0, true, undefined, false);
  const controller = new AbortController();
  const pending = capture
    .capture({ freshness: "fresh", signal: controller.signal })
    .catch((error: unknown) => error);
  await drainUntil(() => timer.getPendingSleepCount() === 1, { description: "retry backoff" });
  controller.abort(new Error("cancelled"));
  expect(await pending).toMatchObject({ message: "cancelled" });
  timer.advanceTime(100);
  await drainMicrotasks(20);
  expect(reads).toHaveLength(1);
  expect(adb.getCommandCalls()).toEqual([]);
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

// Provenance belongs to the sync envelope, never an inferred freshness flag.
test.each(["device", "client-cache", undefined, "unknown"] as const)(
  "fresh iOS capture preserves only known sync acquisition: %s",
  async (source) => {
    const timer = new FakeTimer();
    const raw: ViewHierarchyResult = {
      hierarchy: { node: { text: "Target", bounds: { left: 0, top: 0, right: 20, bottom: 20 } } },
      screenWidth: 20,
      screenHeight: 20,
    };
    const capture = createDeviceHierarchyCapture(
      { platform: "ios", deviceId: "ios-marker", name: "ios-marker" },
      {
        timer,
        ids: new FakeIdGenerator(["capture"]),
        syncClientFactory: () => ({
          requestHierarchySync: async () => {
            const response = { hierarchy: raw };
            if (source !== undefined) {
              Reflect.set(response, iosHierarchyAcquisition, source);
            }
            return response;
          },
          convertToViewHierarchyResult: () => raw,
        }),
      },
    );
    const snapshot = await capture.capture({ freshness: "fresh" });
    const hierarchy = snapshot.hierarchy as ViewHierarchyResult & IosHierarchyAcquisition;
    const expected = source === "device" || source === "client-cache" ? source : undefined;
    expect(hierarchy[iosHierarchyAcquisition]).toBe(expected);
    expect(Object.hasOwn(hierarchy, iosHierarchyAcquisition)).toBe(expected !== undefined);
    expect(JSON.stringify(hierarchy)).not.toContain("iosHierarchyAcquisition");
    expect(JSON.stringify(hierarchy)).not.toContain("client-cache");
  },
);
