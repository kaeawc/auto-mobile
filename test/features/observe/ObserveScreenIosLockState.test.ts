import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { sanitizeObserveResult } from "../../../src/features/observe/output/ObserveResultOutput";
import { deviceLockSchema } from "../../../src/server/toolOutputSchemas";
import type { HierarchyCollector } from "../../../src/features/observe/collectors/HierarchyCollector";
import type { IosLockStateProbe } from "../../../src/features/observe/ios/IosLockStateProbe";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { FakeTimer } from "../../fakes/FakeTimer";

class FakeLockProbe implements IosLockStateProbe {
  reads = 0;
  async read() {
    this.reads++;
    return { locked: true, keyguardShowing: true };
  }
}

const unavailableHierarchy = {
  collect: async () => {
    throw new Error("Failed to retrieve view hierarchy");
  },
} as unknown as HierarchyCollector;

function screenFor(device: BootedDevice, probe: FakeLockProbe): RealObserveScreen {
  const timer = new FakeTimer();
  return new RealObserveScreen(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    {
      iosLockStateProbe: probe,
      hierarchyCollector: unavailableHierarchy,
      cacheStore: new FakeObserveCacheStore(timer),
      screenshotStateStore: new FakeScreenshotStateStore(timer),
    },
    timer,
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
