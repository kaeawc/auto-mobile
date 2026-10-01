import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice } from "../../src/models";
import {
  CachingDisplayInventoryProvider,
  createDisplayInventoryProvider,
} from "../../src/devices/DisplayInventoryProvider";
import { FakeDisplayInventorySource } from "../fakes/FakeDisplayInventoryProvider";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { createExecResult } from "../../src/utils/execResult";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Fold", platform: "android" };
const displays = {
  panels: [
    { key: "inner", role: "inner" as const, sizePx: { width: 2000, height: 2200 } },
    { key: "cover", role: "cover" as const, sizePx: { width: 1000, height: 2200 } },
  ],
  postures: ["closed" as const, "opened" as const],
};

describe("CachingDisplayInventoryProvider", () => {
  test("the production Android adapter runs three adb commands only on its first read", async () => {
    const fixture = (name: string): string =>
      readFileSync(join(import.meta.dir, "../fixtures/android-display", name), "utf8");
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "dumpsys SurfaceFlinger --display-id",
      createExecResult(fixture("fold-surfaceflinger.txt"), ""),
    );
    adb.setCommandResponse(
      "dumpsys display",
      createExecResult(fixture("fold-open-display-device-info.txt"), ""),
    );
    adb.setCommandResponse(
      "cmd device_state print-states",
      createExecResult(fixture("fold-states.txt"), ""),
    );
    const provider = createDisplayInventoryProvider(
      new FakeAdbClientFactory(adb),
      { readDeviceDisplays: async () => undefined },
      new FakeTimer(),
    );
    expect((await provider.hydrate(device, "1")).displays?.panels).toHaveLength(2);
    expect(adb.getExecutedCommands()).toHaveLength(3);
    await provider.hydrate(device, "1");
    expect(adb.getExecutedCommands()).toHaveLength(3);
  });

  test("dedupes fifty calls and caches a confirmed single panel", async () => {
    const source = new FakeDisplayInventorySource({ displays, degraded: false });
    const provider = new CachingDisplayInventoryProvider(source, source, new FakeTimer());
    const results = await Promise.all(
      Array.from({ length: 50 }, () => provider.hydrate(device, "1")),
    );
    expect(source.reads).toBe(1);
    expect(results.every((result) => result.displays === displays)).toBe(true);
    source.result = { degraded: false };
    provider.invalidate(device.deviceId);
    const single = await provider.hydrate(device, "1");
    expect(Object.hasOwn(single, "displays")).toBe(false);
    await provider.hydrate(device, "1");
    expect(source.reads).toBe(2);
  });

  test("serial reuse and explicit invalidation refetch", async () => {
    const source = new FakeDisplayInventorySource({ displays, degraded: false });
    const provider = new CachingDisplayInventoryProvider(source, source, new FakeTimer());
    expect((await provider.hydrate(device, "1:Fold")).displays).toBe(displays);
    source.result = { degraded: false };
    expect(
      (await provider.hydrate({ ...device, name: "Phone" }, "2:Phone")).displays,
    ).toBeUndefined();
    expect(source.reads).toBe(2);
    provider.invalidate(device.deviceId);
    source.result = { displays, degraded: false };
    expect((await provider.hydrate(device, "2:Phone")).displays).toBe(displays);
    expect(source.reads).toBe(3);
  });

  test("degraded retries serve stale inventory without waiting for the refresh", async () => {
    const timer = new FakeTimer();
    let finishRefresh:
      | ((value: { displays?: typeof displays; degraded: boolean }) => void)
      | undefined;
    let reads = 0;
    const source = {
      read: () => {
        reads++;
        return reads === 1
          ? Promise.resolve({ displays, degraded: true })
          : new Promise<{ displays?: typeof displays; degraded: boolean }>((resolve) => {
              finishRefresh = resolve;
            });
      },
    };
    const provider = new CachingDisplayInventoryProvider(source, source, timer, 5000);
    expect((await provider.hydrate(device, "1")).displays).toBe(displays);
    await provider.hydrate(device, "1");
    expect(reads).toBe(1);
    timer.advanceTime(5000);
    expect((await provider.hydrate(device, "1")).displays).toBe(displays);
    expect(reads).toBe(2);
    expect((await provider.hydrate(device, "1")).displays).toBe(displays);
    expect(reads).toBe(2);
    finishRefresh?.({ degraded: true });
    await Promise.resolve();
    await Promise.resolve();
    expect((await provider.hydrate(device, "1")).displays).toBe(displays);
  });

  test("failed reads back off for thirty seconds on the injected clock", async () => {
    const timer = new FakeTimer();
    let reads = 0;
    const source = {
      read: async () => {
        reads++;
        if (reads === 1) {
          throw new Error("temporary failure");
        }
        return { displays, degraded: false };
      },
    };
    const provider = new CachingDisplayInventoryProvider(source, source, timer);
    expect(await provider.hydrate({ ...device, displays }, "1")).toEqual({ ...device, displays });
    expect((await provider.hydrate(device, "1")).displays).toBeUndefined();
    timer.advanceTime(29_999);
    expect((await provider.hydrate(device, "1")).displays).toBeUndefined();
    expect(reads).toBe(1);
    timer.advanceTime(1);
    expect((await provider.hydrate(device, "1")).displays).toBeUndefined();
    expect(reads).toBe(2);
    await Promise.resolve();
    await Promise.resolve();
    expect((await provider.hydrate(device, "1")).displays).toBe(displays);
  });

  test("an aborted waiter does not cancel another waiter or poison the cache", async () => {
    let finishRead: ((value: { displays: typeof displays; degraded: boolean }) => void) | undefined;
    let reads = 0;
    const source = {
      read: () => {
        reads++;
        return new Promise<{ displays: typeof displays; degraded: boolean }>((resolve) => {
          finishRead = resolve;
        });
      },
    };
    const provider = new CachingDisplayInventoryProvider(source, source, new FakeTimer());
    const controller = new AbortController();
    const callerA = provider.hydrate(device, "1", controller.signal);
    const callerB = provider.hydrate(device, "1");
    controller.abort();
    await expect(callerA).rejects.toThrow();
    finishRead?.({ displays, degraded: false });
    expect((await callerB).displays).toBe(displays);
    expect((await provider.hydrate(device, "1")).displays).toBe(displays);
    expect(reads).toBe(1);
  });
});
