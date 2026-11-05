import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { resolveSimulatorKillTarget } from "../../src/devices/appleTvDiscovery";

// killDevice resolves an unlisted Apple simulator UDID against the Vision and TV inventories
// before any shutdown; one failed inventory must not refuse a device the other confirms.

const UDID = "11111111-2222-3333-4444-555555555555";
const labelled: BootedDevice = { platform: "ios", name: "Living Room", deviceId: UDID };
const noIos = { listSimulatorImages: async () => [] };
const failingVision = {
  listAppleVisionSimulators: async (): Promise<never> => {
    throw new Error("vision listing timed out");
  },
};
const tvListing = (deviceIds: string[]) => ({
  listAppleTvSimulators: async () =>
    deviceIds.map((deviceId) => ({
      name: "Living Room",
      platform: "tvos" as const,
      isRunning: true,
      deviceId,
    })),
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("resolveSimulatorKillTarget", () => {
  test("a failed Vision read still resolves an Apple TV the tvOS inventory confirms", async () => {
    const target = await resolveSimulatorKillTarget(labelled, noIos, {
      vision: failingVision,
      tv: tvListing([UDID]),
    });

    expect(target).toEqual({ ...labelled, platform: "tvos" });
  });

  test("a failed Vision read is reported when the tvOS inventory does not confirm the device", async () => {
    const error = await rejection(
      resolveSimulatorKillTarget(labelled, noIos, {
        vision: failingVision,
        tv: tvListing([]),
      }),
    );

    expect(String(error)).toContain("Cannot confirm simulator platform");
    expect(String(error)).toContain("vision listing timed out");
  });
});
