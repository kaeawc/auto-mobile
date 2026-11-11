import { expect, test } from "bun:test";
import { CachedAndroidXrDisplaySize } from "../../../../src/features/observe/android/AndroidXrDisplaySize";
import type { BootedDevice } from "../../../../src/models";
import { FakeAndroidXrDetector } from "../../../fakes/FakeAndroidXrDetector";
import { FakeHierarchyCollector } from "../../../fakes/FakeHierarchyCollector";
import { FakeLogger } from "../../../fakes/FakeLogger";
import { spatialPanelObservation } from "../../../helpers/xrSpatialPanelFixture";

test.each([true, false])(
  "the synchronous XR identity reuses the primed verdict (%s)",
  async (xr) => {
    const observation = spatialPanelObservation();
    let device: BootedDevice = { name: "fake", deviceId: "xr-first", platform: "android" };
    const detector = new FakeAndroidXrDetector(xr);
    const cache = new CachedAndroidXrDisplaySize({
      device: () => device,
      xrDetector: detector,
      hierarchyCollector: () => new FakeHierarchyCollector(),
      readDisplaySize: async () => observation.screenSize,
    });
    expect(cache.isXrCached()).toBe(false);
    await cache.prime(observation, observation.viewHierarchy!);
    expect(cache.isXrCached()).toBe(xr);
    observation.viewHierarchy!.rotation = 1;
    expect(cache.isXrCached()).toBe(xr);
    expect(detector.queries).toEqual(["xr-first"]);
    device = { ...device, deviceId: "unprimed-second" };
    expect(cache.isXrCached()).toBe(false);
    device = { ...device, deviceId: "xr-first", platform: "ios" };
    expect(cache.isXrCached()).toBe(false);
    expect(detector.queries).toEqual(["xr-first"]);
  },
);

test("a failed display-size read preserves the resolved XR identity", async () => {
  const observation = spatialPanelObservation("host-missing");
  const detector = new FakeAndroidXrDetector(true);
  const logger = new FakeLogger();
  const cache = new CachedAndroidXrDisplaySize({
    device: () => ({ name: "fake", deviceId: "xr-size-failure", platform: "android" }),
    xrDetector: detector,
    hierarchyCollector: () => new FakeHierarchyCollector(),
    readDisplaySize: async () => {
      throw new Error("display size unavailable");
    },
    logger,
  });
  await cache.prime(observation, observation.viewHierarchy!);
  expect(cache.isXrCached()).toBe(true);
  expect(logger.messages).toContainEqual(
    expect.objectContaining({
      level: "warn",
      message: expect.stringContaining("XR display size read failed"),
    }),
  );
  expect(detector.queries).toEqual(["xr-size-failure"]);
});
