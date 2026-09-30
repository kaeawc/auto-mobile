import { describe, expect, spyOn, test } from "bun:test";
import {
  ObservedAndroidDisplayCache,
  observedAndroidDisplay,
  observedIosDisplay,
} from "../../../src/features/observe/ObservationDisplay";
import { DisplayTransitionTracker } from "../../../src/features/observe/DisplayTransition";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import { CtrlProxyHierarchy } from "../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  HierarchyDelegateContext,
} from "../../../src/features/observe/android/types";
import type { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import type { XCTestHierarchy } from "../../../src/features/observe/ios/types";
import { GetBackStack } from "../../../src/features/observe/GetBackStack";
import type { BootedDevice, ViewHierarchyResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";

const android: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
const ios: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "simulator" };

describe("observation display stamp", () => {
  test("Android observe carries the forwarded raw capture through the real converter", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    const device = { ...android, deviceId: "android-sequence" };
    const raw: AccessibilityHierarchy = {
      updatedAt: 1,
      packageName: "com.test.app",
      captureSequence: 23,
      hierarchy: { text: "Ready", bounds: { left: 0, top: 0, right: 100, bottom: 100 } },
    };
    const converter = new CtrlProxyHierarchy({ timer } as HierarchyDelegateContext);
    const client = {
      getAccessibilityHierarchy: async () => converter.convertToViewHierarchyResult(raw),
    } as unknown as AndroidCtrlProxyClient;
    const hierarchy = new ViewHierarchy(device, new FakeAdbClientFactory(adb), client, timer);
    try {
      const screen = new RealObserveScreen(
        device,
        new FakeAdbClientFactory(adb),
        { viewHierarchy: hierarchy, cacheStore: new FakeObserveCacheStore(timer) },
        timer,
      );
      const result = await screen.execute({
        skipScreenshot: true,
        skipBackStack: true,
        skipRecompositionTracking: true,
        skipPerformanceAudit: true,
        skipAccessibilityAudit: true,
      });
      expect(result.viewHierarchy?.captureSequence).toBe(23);
      expect(result.display.generation).toBe(23);
    } finally {
      resetObserveCacheStore();
    }
  });

  test("iOS observe carries the forwarded raw capture through normalization", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    const device = { ...ios, deviceId: "ios-sequence" };
    const raw: XCTestHierarchy = {
      updatedAt: 1,
      packageName: "com.test.app",
      captureSequence: 31,
      hierarchy: { text: "Ready", bounds: { left: 0, top: 0, right: 100, bottom: 100 } },
    };
    const fakeClient = {
      getLatestHierarchy: async () => ({ hierarchy: raw, fresh: true, updatedAt: 1 }),
    } as unknown as IOSCtrlProxyClient;
    const getInstance = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(fakeClient);
    try {
      const hierarchy = new ViewHierarchy(device, new FakeAdbClientFactory(adb), undefined, timer);
      const screen = new RealObserveScreen(
        device,
        new FakeAdbClientFactory(adb),
        { viewHierarchy: hierarchy, cacheStore: new FakeObserveCacheStore(timer) },
        timer,
      );
      const result = await screen.execute({
        skipScreenshot: true,
        skipBackStack: true,
        skipPerformanceAudit: true,
        skipAccessibilityAudit: true,
      });
      expect(result.viewHierarchy?.captureSequence).toBe(31);
      expect(result.display.generation).toBe(31);
    } finally {
      getInstance.mockRestore();
      resetObserveCacheStore();
    }
  });

  test("two Android multi-panel observations reuse the live display binding", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout: 'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}',
      stderr: "",
    });
    const device: BootedDevice = {
      ...android,
      deviceId: "foldable-cache",
      displays: {
        panels: [
          { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
          { key: "inner", role: "inner", sizePx: { width: 200, height: 200 } },
        ],
        postures: ["closed", "opened"],
      },
    };
    const hierarchy = new FakeViewHierarchy();
    hierarchy.configureHierarchy({
      hierarchy: { node: { bounds: { left: 0, top: 0, right: 100, bottom: 100 } } },
      updatedAt: 1,
    });
    try {
      const options = {
        skipScreenshot: true,
        skipBackStack: true,
        skipRecompositionTracking: true,
        skipPerformanceAudit: true,
        skipAccessibilityAudit: true,
      };
      for (let index = 0; index < 2; index++) {
        const screen = new RealObserveScreen(
          device,
          new FakeAdbClientFactory(adb),
          { viewHierarchy: hierarchy, cacheStore: new FakeObserveCacheStore(timer) },
          timer,
        );
        await screen.execute(options);
      }
      expect(
        adb.getExecutedCommands().filter((command) => command.includes("cmd display get-displays")),
      ).toHaveLength(1);
    } finally {
      resetObserveCacheStore();
    }
  });

  test("an empty or failed lookup retains the last panel until the next successful read", async () => {
    const timer = new FakeTimer();
    const device: BootedDevice = {
      ...android,
      deviceId: "display-lookup-gap",
      displays: {
        panels: [
          { key: "inner", role: "inner", sizePx: { width: 200, height: 200 } },
          { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
        ],
        postures: ["opened", "closed"],
      },
    };
    const outputs = [
      'Display id 0: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 200}',
      "",
      "",
      'Display id 0: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 200}',
    ];
    let reads = 0;
    const transitions: string[] = [];
    const tracker = new DisplayTransitionTracker((_deviceId, reason) => transitions.push(reason));
    const adb = {
      executeCommand: async () => {
        const index = reads++;
        if (index === 1) {
          throw new Error("lookup failed");
        }
        return { stdout: outputs[index] ?? "", stderr: "" };
      },
    } as unknown as FakeAdbExecutor;
    const cache = new ObservedAndroidDisplayCache(timer);
    try {
      const first = await cache.resolve(device, adb);
      const failed = await cache.resolve(device, adb, undefined, true);
      const empty = await cache.resolve(device, adb, undefined, true);
      const recovered = await cache.resolve(device, adb, undefined, true);
      for (const resolved of [first, failed, empty, recovered]) {
        tracker.checkIdentity(device.deviceId, resolved.display);
        tracker.record(device.deviceId, {
          display: resolved.display,
          screenSize: { width: 200, height: 200 },
        });
      }
      expect([
        first.display.key,
        failed.display.key,
        empty.display.key,
        recovered.display.key,
      ]).toEqual(["inner", "inner", "inner", "inner"]);
      expect(reads).toBe(4);
      expect(transitions).toEqual([]);
    } finally {
      ObservedAndroidDisplayCache.release(device.deviceId);
    }
  });

  test("an aborted Android display lookup is propagated", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("cmd display get-displays", new DOMException("cancelled", "AbortError"));
    const device: BootedDevice = {
      ...android,
      displays: {
        panels: [{ key: "cover", role: "cover", sizePx: { width: 100, height: 100 } }],
        postures: ["closed"],
      },
    };
    await expect(observedAndroidDisplay(device, adb)).rejects.toHaveProperty("name", "AbortError");
  });
  test("Android single display uses stable default when inventory is absent", async () => {
    const resolved = await observedAndroidDisplay(android, new FakeAdbExecutor());
    expect(resolved).toEqual({
      display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
      logicalId: 0,
    });
  });

  test("Android foldable stamps display 0's physical panel and scopes its active window", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout: [
        'Display id 0: DisplayInfo{uniqueId "local:cover-physical" type INTERNAL, real 1080 x 2364}',
        'Display id 3: DisplayInfo{uniqueId "local:inner-physical" type INTERNAL, real 2076 x 2152}',
      ].join("\n"),
      stderr: "",
    });
    adb.setCommandResponse("dumpsys activity activities", {
      stdout: [
        "Display #0 (activities from top to bottom):",
        "  topResumedActivity=ActivityRecord{abc u0 com.cover/.Main t1}",
        "Display #3 (activities from top to bottom):",
        "  topResumedActivity=ActivityRecord{def u0 com.inner/.Main t2}",
      ].join("\n"),
      stderr: "",
    });
    const device: BootedDevice = {
      ...android,
      displays: {
        panels: [
          { key: "inner-physical", role: "inner", sizePx: { width: 2076, height: 2152 } },
          { key: "cover-physical", role: "cover", sizePx: { width: 1080, height: 2364 } },
        ],
        postures: ["closed", "opened"],
      },
    };
    const resolved = await observedAndroidDisplay(device, adb);
    expect(resolved.display).toEqual({
      key: "cover-physical",
      role: "cover",
      posture: "unknown",
      generation: 0,
    });
    expect(resolved.logicalId).toBe(0);
    const stack = await new GetBackStack(
      device,
      new FakeAdbClientFactory(adb),
      new FakeTimer(),
    ).execute(undefined, undefined, resolved.logicalId);
    expect(stack.currentActivity?.name).toBe("com.cover.Main");
  });

  test("iOS single display uses stable default and the hierarchy capture sequence", () => {
    expect(observedIosDisplay(ios, { captureSequence: 17 } as ViewHierarchyResult)).toEqual({
      key: "0",
      role: "unknown",
      posture: "unknown",
      generation: 17,
    });
  });

  test("folded iPhone Duo selects the live cover panel by runner pixel size", () => {
    const device: BootedDevice = {
      ...ios,
      displays: {
        panels: [
          { key: "inner", role: "inner", sizePx: { width: 2064, height: 2208 } },
          { key: "primary", role: "cover", sizePx: { width: 1170, height: 2532 } },
        ],
        postures: ["closed", "half_opened", "opened"],
      },
    };
    expect(
      observedIosDisplay(device, {
        pixelWidth: 1170,
        pixelHeight: 2532,
        captureSequence: 41,
      } as ViewHierarchyResult),
    ).toEqual({
      key: "primary",
      role: "cover",
      posture: "unknown",
      generation: 41,
    });
  });
});
