import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { BudgetedIosLockStateProbe } from "../../../src/features/observe/ios/BudgetedIosLockStateProbe";
import { CachedIosLockStateProbe } from "../../../src/features/observe/ios/CachedIosLockStateProbe";
import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { sanitizeObserveResult } from "../../../src/features/observe/output/ObserveResultOutput";
import { deviceLockSchema, observeResultSchema } from "../../../src/server/toolOutputSchemas";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeHierarchyCollector } from "../../fakes/FakeHierarchyCollector";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { FakeTimer } from "../../fakes/FakeTimer";

import { FakeIosLockStateProbe as FakeLockProbe } from "../../fakes/FakeIosLockStateProbe";

const unavailableHierarchy = new FakeHierarchyCollector(
  undefined,
  new ActionableError("Failed to retrieve view hierarchy"),
);

function screenFor(
  device: BootedDevice,
  probe: FakeLockProbe,
  failHierarchy = true,
): RealObserveScreen {
  const timer = new FakeTimer();
  return new RealObserveScreen(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    {
      iosLockStateProbe: probe,
      hierarchyCollector: failHierarchy ? unavailableHierarchy : new FakeHierarchyCollector(null),
      cacheStore: new FakeObserveCacheStore(timer),
      screenshotStateStore: new FakeScreenshotStateStore(timer),
    },
    { timer },
  );
}

describe("observe iOS simulator lock state", () => {
  afterEach(() => {
    resetObserveCacheStore();
    resetScreenshotStateStore();
  });

  test("retains lock state when the runner hierarchy fails", async () => {
    const probe = new FakeLockProbe();
    const result = await screenFor(
      { deviceId: "1CBBDFF1-96B4-479E-85D2-489FFAC3BC3E", platform: "ios", name: "Simulator" },
      probe,
    ).execute({ skipScreenshot: true, skipBackStack: true });
    expect(result.error).toContain("Observation failed");
    expect(result.deviceLock).toEqual({ locked: true, keyguardShowing: true });
    expect(result.deviceLockUnknown).toBeUndefined();
    if (!result.deviceLock) {
      throw new Error("Expected lock state");
    }
    const output = sanitizeObserveResult(result, { dropElements: true });
    expect(output.deviceLock).toEqual(result.deviceLock);
    expect(deviceLockSchema.parse(output.deviceLock)).toEqual(result.deviceLock);
    expect(probe.reads).toBe(1);
  });

  for (const device of [
    { deviceId: "00008110-0012345678901234", platform: "ios", name: "iPhone" },
    { deviceId: "emulator-5554", platform: "android", name: "Emulator" },
  ] as BootedDevice[]) {
    test(`does not probe ${device.name}`, async () => {
      const probe = new FakeLockProbe();
      const result = await screenFor(device, probe).execute({
        skipScreenshot: true,
        skipBackStack: true,
      });
      expect(result.deviceLock).toBeUndefined();
      expect(probe.reads).toBe(0);
    });
  }
});

for (const reason of ["pending", "timeout", "error", "unparseable"] as const) {
  test(`unknown ${reason} survives hierarchy failure and output sanitization`, async () => {
    const probe = new FakeLockProbe();
    probe.reading = { kind: "unknown", reason };
    const result = await screenFor(
      { deviceId: "1CBBDFF1-96B4-479E-85D2-489FFAC3BC3E", platform: "ios", name: "Simulator" },
      probe,
    ).execute({ skipScreenshot: true, skipBackStack: true });
    expect(result.deviceLock).toBeUndefined();
    expect(result.deviceLockUnknown).toEqual({ reason });
    const output = sanitizeObserveResult(result, { dropElements: true });
    const { deviceLockUnknownSchema } =
      await import("../../../src/server/toolOutputSchemas/observationMetadata");
    expect(deviceLockUnknownSchema.parse(output.deviceLockUnknown)).toEqual({ reason });
    expect(observeResultSchema.parse(output).deviceLockUnknown).toEqual({ reason });
  });
}

for (const known of [true, false]) {
  test(`successful hierarchy preserves ${known ? "known" : "unknown"} reading`, async () => {
    const probe = new FakeLockProbe();
    if (!known) {
      probe.reading = { kind: "unknown", reason: "pending" };
    }
    const result = await screenFor(
      { deviceId: "1CBBDFF1-96B4-479E-85D2-489FFAC3BC3E", platform: "ios", name: "Simulator" },
      probe,
      false,
    ).execute({ skipScreenshot: true, skipBackStack: true });
    expect(result.error).toBeUndefined();
    expect(result.deviceLock).toEqual(known ? { locked: true, keyguardShowing: true } : undefined);
    expect(result.deviceLockUnknown).toEqual(known ? undefined : { reason: "pending" });
  });
}

for (const hierarchyOnly of [false, true]) {
  test(`${hierarchyOnly ? "hierarchyOnly" : "observerMode"} abort does not leave an unhandled lock-state rejection`, async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const timer = new FakeTimer();
      const controller = new AbortController();
      const probe = new BudgetedIosLockStateProbe(
        new CachedIosLockStateProbe({ read: () => new Promise(() => {}) }, timer),
        timer,
      );
      const collector = new FakeHierarchyCollector();
      collector.collect = async () => {
        controller.abort(new Error("caller cancelled"));
        if (!hierarchyOnly) {
          throw new ActionableError("hierarchy cancelled");
        }
      };
      const screen = new RealObserveScreen(
        { deviceId: "1CBBDFF1-96B4-479E-85D2-489FFAC3BC3E", platform: "ios", name: "Simulator" },
        new FakeAdbClientFactory(new FakeAdbExecutor()),
        {
          iosLockStateProbe: probe,
          hierarchyCollector: collector,
          hierarchyCapture: new FakeHierarchyCapture(
            () => ({ hierarchy: {}, screenWidth: 100, screenHeight: 200 }),
            "ios",
            timer,
          ),
          cacheStore: new FakeObserveCacheStore(timer),
          screenshotStateStore: new FakeScreenshotStateStore(timer),
        },
        { timer },
      );
      const result = screen.execute({
        skipScreenshot: true,
        skipBackStack: true,
        observerMode: !hierarchyOnly,
        hierarchyOnly,
        signal: controller.signal,
      });
      if (hierarchyOnly) {
        await expect(result).resolves.toBeDefined();
      } else {
        await expect(result).rejects.toBeDefined();
      }
      // Drain the promise continuations without relying on wall-clock timers.
      for (let turn = 0; turn < 20; turn++) {
        await Promise.resolve();
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
}
