import { describe, expect, test } from "bun:test";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import type { BootedDevice } from "../../src/models";
import {
  resolveDeviceForObservationRead,
  type DeviceObservationAccess,
  type ReadListingScope,
} from "../../src/server/deviceObservationAccess";
import type { BootedResourceReadListing } from "../../src/server/resourceDeviceResolver";

// A read lists watches only when it names watchOS; "either" never scans them, so an unscanned
// watch source can only make a watchOS read incomplete (#14908).

const WATCH: BootedDevice = {
  deviceId: "6B1F3C2E-0000-4000-8000-00000000A7C1",
  name: "Apple Watch Series 10 (46mm)",
  platform: "watchos",
};
const IPHONE: BootedDevice = {
  deviceId: "1B2C3D4E-5F60-4718-8293-A1B2C3D4E5F6",
  name: "iPhone 16",
  platform: "ios",
};

function access(listings: Record<ReadListingScope, BootedResourceReadListing>) {
  const scopes: ReadListingScope[] = [];
  const read: DeviceObservationAccess = {
    avdConfigReader: undefined,
    listBooted: async () => [],
    listBootedWithStatus: async (_signal, scope = "either") => {
      scopes.push(scope);
      return listings[scope];
    },
    isAuthorized: () => true,
  };
  return { read, scopes };
}

const either = (devices: BootedDevice[]): BootedResourceReadListing => ({
  devices,
  scanned: { android: true, ios: true, watchos: false, tvos: false },
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("observation read listing scope", () => {
  test("a watchOS read lists watches and resolves the named watch", async () => {
    const { read, scopes } = access({
      either: either([IPHONE]),
      watchos: {
        devices: [WATCH],
        scanned: { android: false, ios: false, watchos: true, tvos: false },
      },
    });

    expect(
      await resolveDeviceForObservationRead(WATCH.deviceId, undefined, {
        access: read,
        platform: "watchos",
      }),
    ).toBe(WATCH);
    expect(scopes).toEqual(["watchos"]);
  });

  test("an Android or iOS read that misses is not found, never a watch discovery gap", async () => {
    const { read, scopes } = access({ either: either([IPHONE]), watchos: either([]) });

    const error = await failure(
      resolveDeviceForObservationRead("missing-device", undefined, { access: read }),
    );

    expect(error).not.toBeInstanceOf(BootedDeviceDiscoveryIncompleteError);
    expect(String(error)).toContain("missing-device");
    expect(scopes).toEqual(["either"]);
  });

  test("a watchOS read whose watch discovery failed is incomplete, not not-found", async () => {
    const { read } = access({
      either: either([IPHONE]),
      watchos: {
        devices: [],
        scanned: { android: false, ios: false, watchos: false, tvos: false },
        discoveryErrors: { watchos: { code: "unavailable", message: "simctl missing" } },
      },
    });

    const error = await failure(
      resolveDeviceForObservationRead(WATCH.deviceId, undefined, {
        access: read,
        platform: "watchos",
      }),
    );

    expect(error).toBeInstanceOf(BootedDeviceDiscoveryIncompleteError);
  });
});
