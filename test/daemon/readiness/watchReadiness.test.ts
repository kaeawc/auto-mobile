import { describe, expect, test } from "bun:test";
import { resolveBootedWatchForCall } from "../../../src/daemon/readiness/watchReadiness";
import type { BootedDevice } from "../../../src/models";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";

// A call naming watchOS resolves only a watch a fresh watchOS listing shows booted (#14908).

const watchA: BootedDevice = { name: "Watch A", deviceId: "WATCH-A", platform: "watchos" };
const watchB: BootedDevice = { name: "Watch B", deviceId: "WATCH-B", platform: "watchos" };

function utilsWith(watches: BootedDevice[]): FakeDeviceUtils {
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("watchos", watches);
  return utils;
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => String(error),
  );

describe("resolveBootedWatchForCall", () => {
  test("resolves the named watch, else the watch pin, else the only booted watch", async () => {
    const utils = utilsWith([watchA, watchB]);
    expect(await resolveBootedWatchForCall(utils, "WATCH-B", watchA)).toEqual(watchB);
    expect(await resolveBootedWatchForCall(utils, undefined, watchA)).toEqual(watchA);
    expect(await resolveBootedWatchForCall(utilsWith([watchB]), undefined, undefined)).toEqual(
      watchB,
    );
  });

  test("an iPhone pin never selects a watch, and several watches need a deviceId", async () => {
    const iphonePin: BootedDevice = { name: "iPhone", deviceId: "WATCH-A", platform: "ios" };
    expect(
      await failure(resolveBootedWatchForCall(utilsWith([watchA, watchB]), undefined, iphonePin)),
    ).toContain("2 Apple Watch simulators are booted (WATCH-A, WATCH-B)");
  });

  test("refuses a watch the listing does not show booted, and a failed listing", async () => {
    expect(
      await failure(resolveBootedWatchForCall(utilsWith([watchA]), "WATCH-B", undefined)),
    ).toContain("No booted Apple Watch simulator matches 'WATCH-B'");
    const failed = utilsWith([watchA]);
    failed.failedPlatforms.add("watchos");
    expect(await failure(resolveBootedWatchForCall(failed, "WATCH-A", undefined))).toContain(
      "watchOS simulator discovery failed",
    );
  });

  test("a read runs its late-ownership hook on the resolved watch", async () => {
    const seen: string[] = [];
    await resolveBootedWatchForCall(utilsWith([watchA]), "WATCH-A", undefined, {
      intent: "read",
      beforeReadReadiness: async (device) => {
        seen.push(device.deviceId);
      },
    });
    expect(seen).toEqual(["WATCH-A"]);
  });
});
