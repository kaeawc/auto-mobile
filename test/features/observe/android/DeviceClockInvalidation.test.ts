import { afterEach, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { invalidateDisplayCaches } from "../../../../src/features/observe/DisplayTransition";
import {
  setObserveCacheStore,
  resetObserveCacheStore,
} from "../../../../src/features/observe/cache/ObserveCacheRegistry";
import { FakeObserveCacheStore } from "../../../fakes/FakeObserveCacheStore";
import { FakeDeviceClockAdapter } from "../../../fakes/FakeDeviceClockAdapter";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { writeDeviceClock } from "../../../../src/features/utility/DeviceClock";

const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
afterEach(() => {
  AndroidCtrlProxyClient.resetInstances();
  resetObserveCacheStore();
});
test("backward clock jump clears the cached hierarchy and accepts a newly pushed older timestamp", async () => {
  const timer = new FakeTimer();
  const cache = new FakeObserveCacheStore(timer);
  setObserveCacheStore(cache);
  const client = AndroidCtrlProxyClient.getInstance(device, new FakeAdbClientFactory());
  const connected = spyOn(client, "ensureConnected").mockResolvedValue(true);
  const now = Date.parse("2030-01-01T12:00:00Z");
  const newer = { updatedAt: now, packageName: "" };
  client.handleHierarchyUpdate(newer);
  expect(client.hasCachedHierarchy()).toBe(true);
  const adapter = new FakeDeviceClockAdapter();
  adapter.instantMs = now;
  const generation = cache.currentGeneration(device.deviceId);
  try {
    const result = await writeDeviceClock(
      device,
      adapter,
      { mode: "set", instant: new Date(now - 3_600_000).toISOString() },
      undefined,
      {
        hostClock: timer,
        invalidate: (deviceId) => invalidateDisplayCaches(deviceId, "Device clock changed"),
      },
    );
    expect(result.verified).toBe(true);
    expect(client.hasCachedHierarchy()).toBe(false);
    expect(cache.currentGeneration(device.deviceId)).toBeGreaterThan(generation);
    // The first read after the jump must request fresh data, never return newer.
    const older = { updatedAt: now - 3_600_000, packageName: "" };
    const read = await client.getLatestHierarchy(false, 10, undefined, true, older.updatedAt);
    expect(read.hierarchy).toBeNull();
    client.handleHierarchyUpdate(older);
    expect(client.hasCachedHierarchy()).toBe(true);
    const next = await client.getLatestHierarchy(false, 100, undefined, false, older.updatedAt);
    expect(next.hierarchy?.updatedAt).toBe(older.updatedAt);
  } finally {
    connected.mockRestore();
  }
});
