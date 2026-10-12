import { describe, expect, test } from "bun:test";
import {
  assertFrameTargetIdentityProven,
  canonicalFrameDeviceId,
  canonicalizeFrameDiscovery,
  frameHeldSessionsFrom,
  heldDevicesUnidentifiedTransportCouldAlias,
  type FrameDeviceIdentityPool,
} from "../../src/daemon/frameDeviceIdentity";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
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

  test("probes only for the row the frame names", async () => {
    const pool = foldingPool();
    pool.mapAndroidDiscovery = (devices) => [...devices];
    pool.resolveAndroidCanonicalId = (deviceId) => deviceId;
    const rows = [android(USB), android(WIRELESS)];

    await canonicalizeFrameDiscovery(pool, "android", rows, USB);
    expect(pool.probes).toBe(0);

    await canonicalizeFrameDiscovery(pool, "android", rows, WIRELESS);
    expect(pool.probes).toBe(1);
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

describe("assertFrameTargetIdentityProven", () => {
  const unassignable: FrameDeviceIdentityPool = {
    isAndroidTransportAssignable: (device) => device.deviceId !== WIRELESS,
  };
  const held = { sessionId: "holder", assignedDevice: USB, platform: "android" };
  const check = (
    pool: FrameDeviceIdentityPool | undefined,
    device: BootedDevice,
    sessions = [held],
    requesterSessionUuid?: string,
    heldBySession = false,
  ) =>
    assertFrameTargetIdentityProven(pool, device, "input/tap", heldBySession, {
      sessions,
      requesterSessionUuid,
    });

  test("allows an unidentifiable transport when nothing Android is held", async () => {
    await expect(check(unassignable, android(WIRELESS), [])).resolves.toBeUndefined();
    await expect(
      check(unassignable, android(WIRELESS), [{ ...held, platform: "ios" }]),
    ).resolves.toBeUndefined();
  });

  test("refuses a possible alias of another holder with the existing typed code", async () => {
    const refusal = check(unassignable, android(WIRELESS), [held], "other");
    await expect(refusal).rejects.toBeInstanceOf(InputDeviceOwnedError);
    await expect(refusal).rejects.toMatchObject({
      code: "device_owned_by_other_session",
      deviceId: WIRELESS,
      retryable: false,
    });
  });

  test("keeps the holder's unresolved-identity error untyped", async () => {
    const refusal = check(unassignable, android(WIRELESS), [held], "holder");
    await expect(refusal).rejects.toThrow(
      "input/tap refused: Android transport '192.168.1.20:5555' has no proven identity",
    );
    await expect(refusal).rejects.not.toHaveProperty("code");
  });

  test("a derived requester counts as its holder, but not as every holder", async () => {
    const ownership = {
      sessions: [held],
      requesterSessionUuid: "holder:label",
      sessionManager: { getDeviceLabels: () => ({ label: "holder:label" }) },
    };
    await expect(
      assertFrameTargetIdentityProven(
        unassignable,
        android(WIRELESS),
        "ide/setKeyValue",
        false,
        ownership,
      ),
    ).rejects.toThrow("no proven identity");
    await expect(
      assertFrameTargetIdentityProven(unassignable, android(WIRELESS), "ide/setKeyValue", false, {
        ...ownership,
        sessions: [held, { ...held, sessionId: "other", assignedDevice: "PHONE-B" }],
      }),
    ).rejects.toBeInstanceOf(InputDeviceOwnedError);
  });

  test("allows when positive evidence distinguishes every held device", async () => {
    await expect(
      check({ ...unassignable, androidTransportMayAliasDevice: () => false }, android(WIRELESS)),
    ).resolves.toBeUndefined();
  });

  test("unknown managed hold refuses even its execution requester without identity proof", async () => {
    const pool = { ...unassignable, androidManagedSlotHold: async () => ({}) };
    await expect(check(pool, android(WIRELESS), [], "holder")).rejects.toBeInstanceOf(
      InputDeviceOwnedError,
    );
    await expect(
      check({ ...pool, androidTransportMayAliasDevice: () => false }, android(WIRELESS), []),
    ).resolves.toBeUndefined();
  });

  test("passes proven rows, ids already held, iOS, and pools without the gate without reading slots", async () => {
    const pool = {
      ...unassignable,
      androidManagedSlotHold: async () => {
        throw new Error("unexpected slot read");
      },
    };
    await expect(check(pool, android(USB))).resolves.toBeUndefined();
    await expect(check(pool, android(WIRELESS), [held], undefined, true)).resolves.toBeUndefined();
    await expect(check(pool, ios(WIRELESS))).resolves.toBeUndefined();
    await expect(check({}, android(WIRELESS))).resolves.toBeUndefined();
    await expect(check(undefined, android(WIRELESS))).resolves.toBeUndefined();
  });
});

describe("shared non-throwing held-alias verdict", () => {
  const held = {
    sessionId: "holder",
    assignedDevice: USB,
    stableDeviceId: "stable-phone",
    platform: "android",
  };
  const pool: FrameDeviceIdentityPool = { isAndroidTransportAssignable: () => false };

  test("returns only possible Android holders, without refusing the read", async () => {
    const sessions = [held, { ...held, sessionId: "ios-holder", platform: "ios" }];
    expect(
      await heldDevicesUnidentifiedTransportCouldAlias(pool, android(WIRELESS), false, sessions),
    ).toEqual({ sessions: [held], managed: undefined });
    expect(
      await heldDevicesUnidentifiedTransportCouldAlias(
        { ...pool, androidTransportMayAliasDevice: () => false },
        android(WIRELESS),
        false,
        sessions,
      ),
    ).toBeUndefined();
    expect(
      await heldDevicesUnidentifiedTransportCouldAlias(pool, android(WIRELESS), false, []),
    ).toBeUndefined();
  });

  test("shares unknown managed holds and passes represented transport and stable ids", async () => {
    const seen: string[][] = [];
    const managedPool = {
      ...pool,
      androidManagedSlotHold: async (ids: readonly string[]) => {
        seen.push([...ids]);
        return {};
      },
    };
    expect(
      await heldDevicesUnidentifiedTransportCouldAlias(managedPool, android(WIRELESS), false, [
        held,
      ]),
    ).toEqual({ sessions: [held], managed: {} });
    expect(seen).toEqual([[USB, "stable-phone"]]);
  });

  test.each([
    [undefined, android(WIRELESS), false],
    [{}, android(WIRELESS), false],
    [{ isAndroidTransportAssignable: () => true }, android(WIRELESS), false],
    [pool, ios(WIRELESS), false],
    [pool, android(WIRELESS), true],
  ] as const)(
    "early out %j %j held=%s never reads managed holds",
    async (gate, device, heldBySession) => {
      const guarded = gate && {
        ...gate,
        androidManagedSlotHold: async () => {
          throw new Error("unexpected snapshot");
        },
      };
      expect(
        await heldDevicesUnidentifiedTransportCouldAlias(guarded, device, heldBySession, [held]),
      ).toBeUndefined();
    },
  );

  test("the shared snapshot uses reverse-map holders, with the existing legacy fallback", () => {
    expect(
      frameHeldSessionsFrom({
        getHeldDeviceSessions: () => [
          {
            deviceId: USB,
            sessionId: "releasing",
            platform: "android",
            stableDeviceId: "stable-phone",
          },
        ],
        getAllSessions: () => [],
      }),
    ).toEqual([{ ...held, sessionId: "releasing" }]);
    expect(frameHeldSessionsFrom({ getAllSessions: () => [held] })).toEqual([held]);
    expect(frameHeldSessionsFrom({})).toEqual([]);
  });
});
