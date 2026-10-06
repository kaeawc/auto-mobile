import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice } from "../../src/models";
import type { DisplayInventorySource } from "../../src/devices/DisplayInventoryProvider";
import {
  CachingDisplayInventoryProvider,
  createDisplayInventoryProvider,
} from "../../src/devices/DisplayInventoryProvider";
import { FakeDisplayInventorySource } from "../fakes/FakeDisplayInventoryProvider";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { createExecResult } from "../../src/utils/execResult";
import { displayInventoryOutcome } from "../../src/models/DeviceInfo";
import { DefaultDeviceMatcher, describeDisplayRequirements } from "../../src/utils/deviceMatcher";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Fold", platform: "android" };
const displays = {
  panels: [
    { key: "inner", role: "inner" as const, sizePx: { width: 2000, height: 2200 } },
    { key: "cover", role: "cover" as const, sizePx: { width: 1000, height: 2200 } },
  ],
  postures: ["closed" as const, "opened" as const],
};

describe("CachingDisplayInventoryProvider", () => {
  test("real phone capture confirms one panel without exposing displays", async () => {
    const fixture = (name: string): string =>
      readFileSync(join(import.meta.dir, "../fixtures/android-display", name), "utf8");
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "dumpsys SurfaceFlinger --display-id",
      createExecResult(fixture("phone-surfaceflinger.txt"), ""),
    );
    adb.setCommandResponse(
      "dumpsys display",
      createExecResult(fixture("phone-display-device-info.txt"), ""),
    );
    adb.setCommandResponse(
      "cmd device_state print-states",
      createExecResult(fixture("phone-states.txt"), ""),
    );
    const provider = createDisplayInventoryProvider(
      new FakeAdbClientFactory(adb),
      { readDeviceDisplays: async () => undefined },
      new FakeTimer(),
    );
    const phone = await provider.hydrate({ ...device, screenWidth: 1080, screenHeight: 2400 }, "1");
    expect(phone[displayInventoryOutcome]).toEqual({ kind: "single" });
    expect(phone.displays).toBeUndefined();
    expect(
      new DefaultDeviceMatcher().matchBootedDevice(
        { platform: "android", requires: { panels: 1 } },
        [phone],
        "LATEST",
      ),
    ).toBe(phone);
  });

  test("source failure refuses legacy-size panel and posture matches", async () => {
    const source = {
      read: async () => {
        throw new Error("source offline");
      },
    };
    const provider = new CachingDisplayInventoryProvider(source, source, new FakeTimer());
    const fold = await provider.hydrate({ ...device, screenWidth: 1080, screenHeight: 2400 }, "1");
    expect(fold[displayInventoryOutcome]).toEqual({
      kind: "unreadable",
      reason: "source offline",
    });
    const matcher = new DefaultDeviceMatcher();
    for (const requires of [{ panels: 1 }, { panels: 2 }, { posture: "default" }]) {
      expect(
        matcher.matchBootedDevice({ platform: "android", requires }, [fold], "LATEST"),
      ).toBeNull();
    }
    expect(
      describeDisplayRequirements({ platform: "android", requires: { panels: 1 } }, [
        { ...fold, booted: true },
      ]),
    ).toContain("could not be read (source offline)");
  });

  test("an unreadable empty inventory retries on the failure clock", async () => {
    const timer = new FakeTimer();
    const source = new FakeDisplayInventorySource({
      degraded: false,
      outcome: { kind: "unreadable", reason: "no matched physical display records" },
    });
    const provider = new CachingDisplayInventoryProvider(source, source, timer);
    expect((await provider.hydrate(device, "1"))[displayInventoryOutcome]?.kind).toBe("unreadable");
    await provider.hydrate(device, "1");
    expect(source.reads).toBe(1);
    source.result = { degraded: false };
    timer.advanceTime(30_000);
    await provider.hydrate(device, "1");
    await Promise.resolve();
    expect((await provider.hydrate(device, "1"))[displayInventoryOutcome]).toEqual({
      kind: "single",
    });
    expect(source.reads).toBe(2);
  });

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

  describe("a display event that invalidates the inventory during its read", () => {
    type ReadResult = Awaited<ReturnType<DisplayInventorySource["read"]>>;
    function scriptedSource(script: (read: number) => ReadResult | Error) {
      const gates: Array<() => void> = [];
      let reads = 0;
      const source: DisplayInventorySource = {
        read: () => {
          const read = ++reads;
          return new Promise<ReadResult>((resolve, reject) => {
            gates.push(() => {
              const outcome = script(read);
              if (outcome instanceof Error) {
                reject(outcome);
              } else {
                resolve(outcome);
              }
            });
          });
        },
      };
      return {
        source,
        reads: () => reads,
        release: async (read: number) => {
          // Reads start a microtask after hydrate, so let the loop reach the gate first.
          for (let i = 0; i < 5 && gates.length < read; i++) {
            await Promise.resolve();
          }
          gates[read - 1]();
        },
      };
    }

    test("re-reads so the call still gets the inventory", async () => {
      const fake = scriptedSource((read) =>
        read === 1 ? { degraded: false } : { displays, degraded: false },
      );
      const provider = new CachingDisplayInventoryProvider(
        fake.source,
        fake.source,
        new FakeTimer(),
      );
      const call = provider.hydrate(device, "1");
      await fake.release(1);
      provider.invalidate(device.deviceId);
      await fake.release(2);
      expect((await call).displays).toBe(displays);
      expect(fake.reads()).toBe(2);
      // The re-read is cached for the next call.
      expect((await provider.hydrate(device, "1")).displays).toBe(displays);
      expect(fake.reads()).toBe(2);
    });

    test("concurrent callers share the re-read", async () => {
      const fake = scriptedSource((read) =>
        read === 1 ? { degraded: false } : { displays, degraded: false },
      );
      const provider = new CachingDisplayInventoryProvider(
        fake.source,
        fake.source,
        new FakeTimer(),
      );
      const callers = [provider.hydrate(device, "1"), provider.hydrate(device, "1")];
      provider.invalidate(device.deviceId);
      await fake.release(1);
      await fake.release(2);
      const results = await Promise.all(callers);
      expect(results.map((result) => result.displays)).toEqual([displays, displays]);
      expect(fake.reads()).toBe(2);
    });

    test("an event storm is bounded and falls back to the last successful read", async () => {
      const fake = scriptedSource((read) =>
        read === 1 ? { displays, degraded: false } : new Error(`read ${read} failed`),
      );
      const provider = new CachingDisplayInventoryProvider(
        fake.source,
        fake.source,
        new FakeTimer(),
      );
      const call = provider.hydrate(device, "1");
      for (const read of [1, 2, 3]) {
        await fake.release(read);
        if (read < 3) {
          provider.invalidate(device.deviceId);
        }
      }
      const result = await call;
      expect(fake.reads()).toBe(3);
      expect(result.displays).toBe(displays);
      expect(result[displayInventoryOutcome]).toEqual({ kind: "multi" });
    });

    test("an unreadable-only storm still reports unreadable rather than no outcome", async () => {
      const fake = scriptedSource((read) => new Error(`read ${read} failed`));
      const provider = new CachingDisplayInventoryProvider(
        fake.source,
        fake.source,
        new FakeTimer(),
      );
      const call = provider.hydrate(device, "1");
      for (const read of [1, 2, 3]) {
        await fake.release(read);
        provider.invalidate(device.deviceId);
      }
      const result = await call;
      expect(fake.reads()).toBe(3);
      expect(result[displayInventoryOutcome]).toEqual({
        kind: "unreadable",
        reason: "read 3 failed",
      });
    });
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

  test("synchronous read failures retry after each failure window", async () => {
    const timer = new FakeTimer();
    const failureRetryMs = 1000;
    let reads = 0;
    const source = {
      read: () => {
        reads++;
        throw new Error("boom");
      },
    };
    const provider = new CachingDisplayInventoryProvider(
      source,
      source,
      timer,
      5000,
      failureRetryMs,
    );
    expect((await provider.hydrate(device, "1"))[displayInventoryOutcome]).toEqual({
      kind: "unreadable",
      reason: "boom",
    });
    expect(reads).toBe(1);
    timer.advanceTime(failureRetryMs);
    await provider.hydrate(device, "1");
    expect(reads).toBe(2);
    await Promise.resolve();
    timer.advanceTime(failureRetryMs);
    await provider.hydrate(device, "1");
    expect(reads).toBe(3);
  });

  test("concurrent callers share synchronous failures through the retry deadline", async () => {
    const timer = new FakeTimer();
    const failureRetryMs = 1000;
    let reads = 0;
    const source = {
      read: () => {
        reads++;
        throw new Error("boom");
      },
    };
    const provider = new CachingDisplayInventoryProvider(
      source,
      source,
      timer,
      5000,
      failureRetryMs,
    );
    const initial = await Promise.all(
      Array.from({ length: 50 }, () => provider.hydrate(device, "1")),
    );
    expect(initial.every((result) => result[displayInventoryOutcome]?.kind === "unreadable")).toBe(
      true,
    );
    expect(reads).toBe(1);
    timer.advanceTime(failureRetryMs - 1);
    await Promise.all(Array.from({ length: 50 }, () => provider.hydrate(device, "1")));
    expect(reads).toBe(1);
    timer.advanceTime(1);
    await Promise.all(Array.from({ length: 50 }, () => provider.hydrate(device, "1")));
    expect(reads).toBe(2);
  });

  test("a synchronous failure can recover to a cached multi-panel inventory", async () => {
    const timer = new FakeTimer();
    let reads = 0;
    const source = {
      read: () => {
        reads++;
        if (reads === 1) {
          throw new Error("boom");
        }
        return Promise.resolve({ displays, degraded: false });
      },
    };
    const provider = new CachingDisplayInventoryProvider(source, source, timer);
    expect((await provider.hydrate(device, "1"))[displayInventoryOutcome]?.kind).toBe("unreadable");
    timer.advanceTime(30_000);
    expect((await provider.hydrate(device, "1")).displays).toBeUndefined();
    expect(reads).toBe(2);
    await Promise.resolve();
    await Promise.resolve();
    const recovered = await provider.hydrate(device, "1");
    expect(recovered.displays).toBe(displays);
    expect(recovered[displayInventoryOutcome]).toEqual({ kind: "multi" });
    expect(reads).toBe(2);
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
