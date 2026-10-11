import { describe, expect, test } from "bun:test";
import {
  canonicalFrameDeviceId,
  canonicalizeFrameDiscovery,
  type FrameDeviceIdentityPool,
} from "../../src/daemon/frameDeviceIdentity";
import type { BootedDevice } from "../../src/models";

const android = (deviceId: string): BootedDevice => ({
  deviceId,
  name: deviceId,
  platform: "android",
});
const ios = (deviceId: string): BootedDevice => ({ deviceId, name: deviceId, platform: "ios" });

const USB = "R5CT1234ABC";
const WIRELESS = "192.168.1.20:5555";

/** A pool that has folded WIRELESS onto USB, recording every fold it is asked for. */
function foldingPool(pooled: string[] = [USB]): FrameDeviceIdentityPool & { probes: number } {
  const fold = (devices: readonly BootedDevice[]) => [
    ...new Map(
      devices
        .map((device) => (device.deviceId === WIRELESS ? { ...device, deviceId: USB } : device))
        .map((device) => [device.deviceId, device]),
    ).values(),
  ];
  const pool = {
    probes: 0,
    mapAndroidDiscovery: fold,
    resolveAndroidCanonicalId: (deviceId: string) => (deviceId === WIRELESS ? USB : deviceId),
    normalizeAndroidDiscovery: async (devices: readonly BootedDevice[]) => {
      pool.probes++;
      return fold(devices);
    },
    getAllDevices: () => pooled.map((id) => ({ id })),
  };
  return pool;
}

describe("canonicalizeFrameDiscovery", () => {
  test("maps an alias row and the frame's device id to the pooled canonical id", async () => {
    const pool = foldingPool();

    const result = await canonicalizeFrameDiscovery(
      pool,
      "android",
      [android(USB), android(WIRELESS)],
      WIRELESS,
    );

    expect(result.deviceId).toBe(USB);
    expect(result.devices.map((device) => device.deviceId)).toEqual([USB]);
    expect(pool.probes).toBe(0);
  });

  test("probes and folds a transport address the pool has never folded", async () => {
    const pool = foldingPool();
    pool.mapAndroidDiscovery = (devices) => [...devices];

    const result = await canonicalizeFrameDiscovery(
      pool,
      "android",
      [android(USB), android(WIRELESS)],
      undefined,
    );

    expect(pool.probes).toBe(1);
    expect(result.devices.map((device) => device.deviceId)).toEqual([USB]);
    expect(result.deviceId).toBeUndefined();
  });

  test("does not probe for a pooled transport address or an ordinary serial", async () => {
    const pool = foldingPool([WIRELESS, "emulator-5554"]);
    pool.mapAndroidDiscovery = (devices) => [...devices];
    pool.resolveAndroidCanonicalId = (deviceId) => deviceId;

    const result = await canonicalizeFrameDiscovery(
      pool,
      "android",
      [android(WIRELESS), android("emulator-5554"), android("R5CTOTHER")],
      WIRELESS,
    );

    expect(pool.probes).toBe(0);
    expect(result.deviceId).toBe(WIRELESS);
    expect(result.devices).toHaveLength(3);
  });

  test("leaves iOS rows and ids untouched and never consults the Android fold", async () => {
    const pool = foldingPool();
    const rows = [ios("00008110-000A1D2E3C4B801E"), ios(WIRELESS)];

    const result = await canonicalizeFrameDiscovery(pool, "ios", rows, WIRELESS);

    expect(result).toEqual({ devices: rows, deviceId: WIRELESS });
    expect(pool.probes).toBe(0);
  });

  test("is the identity without a pool or with a pool that has no fold", async () => {
    const rows = [android(USB), android(WIRELESS)];

    expect(await canonicalizeFrameDiscovery(undefined, "android", rows, WIRELESS)).toEqual({
      devices: rows,
      deviceId: WIRELESS,
    });
    expect(await canonicalizeFrameDiscovery({}, "android", rows, WIRELESS)).toEqual({
      devices: rows,
      deviceId: WIRELESS,
    });
    expect(canonicalFrameDeviceId(undefined, WIRELESS)).toBe(WIRELESS);
    expect(canonicalFrameDeviceId({}, WIRELESS)).toBe(WIRELESS);
  });
});
