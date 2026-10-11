import { describe, expect, test } from "bun:test";
import { assertFrameTargetIdentityProven } from "../../src/daemon/frameDeviceIdentity";
import {
  assertToolTargetIdentityProven,
  canonicalControlCallDeviceId,
  canonicalizeToolCallDeviceIds,
  mayControlUnheldUnidentifiedTransport,
  toolCallNamesDeviceId,
  UNPROVEN_TRANSPORT_PROBE_RETRY_MS,
  type ToolCallDeviceIdentityPool,
} from "../../src/daemon/toolCallDeviceIdentity";
import type { BootedDevice } from "../../src/models";

const USB = "R5CT1234ABC";
const WIRELESS = "192.168.1.20:5555";
const OTHER_WIRELESS = "192.168.1.21:5555";

const android = (deviceId: string): BootedDevice => ({
  deviceId,
  name: deviceId,
  platform: "android",
});

/** A pool holding USB. `folded` says whether it has learned that WIRELESS is USB's alias. */
function fakePool(options: { folded: boolean; provable?: boolean }) {
  const pool = {
    folded: options.folded,
    probes: 0,
    resolveAndroidCanonicalId: (deviceId: string) =>
      pool.folded && deviceId === WIRELESS ? USB : deviceId,
    mapAndroidDiscovery: (devices: readonly BootedDevice[]) => [
      ...new Map(
        devices
          .map((device) =>
            pool.folded && device.deviceId === WIRELESS ? { ...device, deviceId: USB } : device,
          )
          .map((device) => [device.deviceId, device]),
      ).values(),
    ],
    normalizeAndroidDiscovery: async (devices: readonly BootedDevice[]) => {
      pool.probes++;
      pool.folded = pool.folded || options.provable === true;
      return pool.mapAndroidDiscovery(devices);
    },
    getAllDevices: () => [{ id: USB }],
    isAndroidTransportAssignable: (device: BootedDevice) => device.deviceId === USB,
  };
  return pool satisfies ToolCallDeviceIdentityPool;
}

/** A connected-device scan that counts how often it is asked. */
function scanOf(devices: BootedDevice[]) {
  const scan = {
    calls: 0,
    /** Device ids of each listing handed to the discovery funnel, after the fold. */
    reconciled: [] as string[][],
    list: async () => {
      scan.calls++;
      return devices;
    },
    reconcile: async (rows: readonly BootedDevice[]) => {
      scan.reconciled.push(rows.map((row) => row.deviceId));
    },
  };
  return scan;
}

describe("canonicalizeToolCallDeviceIds", () => {
  test("rewrites the top-level deviceId and killDevice's device.deviceId", () => {
    const pool = fakePool({ folded: true });

    expect(canonicalizeToolCallDeviceIds(pool, { deviceId: WIRELESS, text: "hi" })).toEqual({
      deviceId: USB,
      text: "hi",
    });
    expect(
      canonicalizeToolCallDeviceIds(pool, {
        device: { name: "Phone", deviceId: WIRELESS, platform: "android" },
        force: false,
      }),
    ).toEqual({ device: { name: "Phone", deviceId: USB, platform: "android" }, force: false });
  });

  test("never mutates the caller's arguments", () => {
    const args = { deviceId: WIRELESS, device: { deviceId: WIRELESS } };

    canonicalizeToolCallDeviceIds(fakePool({ folded: true }), args);

    expect(args).toEqual({ deviceId: WIRELESS, device: { deviceId: WIRELESS } });
  });

  test.each([
    ["a canonical id", { deviceId: USB }],
    ["an id the pool has not folded", { deviceId: OTHER_WIRELESS }],
    ["an iOS UDID", { deviceId: "A1B2C3D4-0000-1111-2222-333344445555", platform: "ios" }],
    ["a device label, which is not a device id", { device: WIRELESS, sessionUuid: "s" }],
    ["no device id", { text: "hi" }],
  ])("returns the same object for %s", (_label, args) => {
    expect(canonicalizeToolCallDeviceIds(fakePool({ folded: true }), args)).toBe(args);
  });

  test("is the identity without a pool, for a pool with no fold, and for non-object arguments", () => {
    const args = { deviceId: WIRELESS };

    expect(canonicalizeToolCallDeviceIds(undefined, args)).toBe(args);
    expect(canonicalizeToolCallDeviceIds({}, args)).toBe(args);
    expect(canonicalizeToolCallDeviceIds(fakePool({ folded: true }), undefined)).toBeUndefined();
    expect(canonicalizeToolCallDeviceIds(fakePool({ folded: true }), [WIRELESS])).toEqual([
      WIRELESS,
    ]);
  });

  test.each([
    [{ deviceId: USB }, true],
    [{ device: { name: "Phone", deviceId: USB } }, true],
    [{ device: "A", sessionUuid: "s" }, false],
    [{ deviceId: 7 }, false],
    [{}, false],
    [undefined, false],
  ])("toolCallNamesDeviceId(%j) is %p", (args, expected) => {
    expect(toolCallNamesDeviceId(args)).toBe(expected);
  });
});

describe("canonicalControlCallDeviceId", () => {
  const resolve = (
    pool: ToolCallDeviceIdentityPool | undefined,
    deviceId: string,
    scan: ReturnType<typeof scanOf>,
    now = 0,
  ) =>
    canonicalControlCallDeviceId({
      pool,
      deviceId,
      listRawAndroidDevices: scan.list,
      reconcileDiscovery: scan.reconcile,
      now,
    });

  test.each([
    ["a folded alias", WIRELESS, USB],
    ["the pooled canonical id", USB, USB],
    ["an emulator serial the pool does not hold", "emulator-5556", "emulator-5556"],
    ["a USB serial the pool does not hold", "ZY22ABCDEF", "ZY22ABCDEF"],
    ["an iOS UDID", "A1B2C3D4-0000-1111-2222-333344445555", "A1B2C3D4-0000-1111-2222-333344445555"],
  ])("answers %s from the cached fold with no scan and no probe", async (_label, id, expected) => {
    const pool = fakePool({ folded: true });
    const scan = scanOf([android(USB), android(WIRELESS)]);

    // Synchronously: an ordinary call gains no extra turn at the ingress.
    expect(resolve(pool, id, scan)).toBe(expected);
    expect(scan.calls).toBe(0);
    expect(pool.probes).toBe(0);
  });

  test("probes and folds a transport address the pool has never folded", async () => {
    const pool = fakePool({ folded: false, provable: true });
    const scan = scanOf([android(USB), android(WIRELESS)]);

    expect(await resolve(pool, WIRELESS, scan)).toBe(USB);
    expect(pool.probes).toBe(1);
    // The listing reaches the discovery funnel as pooled canonical rows, after the fold.
    expect(scan.reconciled).toEqual([[USB]]);

    // Folded now: the next call is answered from the cache.
    expect(await resolve(pool, WIRELESS, scan)).toBe(USB);
    expect(scan.calls).toBe(1);
    expect(pool.probes).toBe(1);
  });

  test("a transport the probe cannot identify is not probed again until the retry window", async () => {
    const pool = fakePool({ folded: false });
    const scan = scanOf([android(USB), android(WIRELESS)]);

    expect(await resolve(pool, WIRELESS, scan, 1_000)).toBe(WIRELESS);
    expect(await resolve(pool, WIRELESS, scan, 2_000)).toBe(WIRELESS);
    expect(await resolve(pool, WIRELESS, scan, 1_000 + UNPROVEN_TRANSPORT_PROBE_RETRY_MS - 1)).toBe(
      WIRELESS,
    );
    expect([scan.calls, pool.probes]).toEqual([1, 1]);

    expect(await resolve(pool, WIRELESS, scan, 1_000 + UNPROVEN_TRANSPORT_PROBE_RETRY_MS)).toBe(
      WIRELESS,
    );
    expect([scan.calls, pool.probes]).toEqual([2, 2]);
  });

  test("the retry limit never hides an alias the pool has since folded", async () => {
    const pool = fakePool({ folded: false });
    const scan = scanOf([android(USB), android(WIRELESS)]);
    expect(await resolve(pool, WIRELESS, scan, 1_000)).toBe(WIRELESS);

    // The pool's own refresh proves the alias inside the retry window.
    pool.folded = true;

    expect(await resolve(pool, WIRELESS, scan, 1_001)).toBe(USB);
  });

  test("a transport that is not connected is not remembered as unidentified", async () => {
    const pool = fakePool({ folded: false, provable: true });
    const absent = scanOf([android(USB)]);
    expect(await resolve(pool, WIRELESS, absent, 1_000)).toBe(WIRELESS);
    expect(pool.probes).toBe(0);

    // It connects a moment later: the very next call probes it.
    const present = scanOf([android(USB), android(WIRELESS)]);
    expect(await resolve(pool, WIRELESS, present, 1_001)).toBe(USB);
    expect(pool.probes).toBe(1);
  });

  test("the retry memo is per pool", async () => {
    const scan = scanOf([android(USB), android(WIRELESS)]);
    expect(await resolve(fakePool({ folded: false }), WIRELESS, scan, 1_000)).toBe(WIRELESS);

    const other = fakePool({ folded: false, provable: true });
    expect(await resolve(other, WIRELESS, scan, 1_001)).toBe(USB);
  });

  test("is the identity without a pool", async () => {
    const scan = scanOf([android(WIRELESS)]);

    expect(await resolve(undefined, WIRELESS, scan)).toBe(WIRELESS);
    expect(scan.calls).toBe(0);
  });
});

describe("the open owner decision for an unidentified, unheld transport", () => {
  test("tool calls are allowed today where a direct frame's rule would refuse", () => {
    const pool = fakePool({ folded: false });
    // The rule this predicate would switch on does refuse this transport.
    expect(() =>
      assertFrameTargetIdentityProven(pool, android(OTHER_WIRELESS), "tapOn", false),
    ).toThrow(/no proven identity/);

    expect(mayControlUnheldUnidentifiedTransport()).toBe(true);
    expect(() =>
      assertToolTargetIdentityProven(pool, OTHER_WIRELESS, "tapOn", false),
    ).not.toThrow();
  });
});
