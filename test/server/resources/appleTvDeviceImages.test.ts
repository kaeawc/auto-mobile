import { afterEach, describe, expect, test } from "bun:test";
import fixture from "../../fixtures/ios-simctl/list-all-appletv-26-5.json";
import { FakeAppleTvSimctl } from "../../fakes/FakeAppleTvSimctl";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeAvdManager } from "../../fakes/FakeAvdManager";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { AppleTvSimulatorInventory } from "../../../src/utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import { AndroidAvdProvenanceCache } from "../../../src/utils/AndroidAvdProvenanceCache";
import {
  createDeviceImageResourcesHandler,
  resetAndroidDeviceImageResourceCache,
} from "../../../src/server/deviceImageResources";

const runtimeId = "com.apple.CoreSimulator.SimRuntime.tvOS-26-5";
function host() {
  const simctl = new FakeAppleTvSimctl();
  simctl.listing = structuredClone(fixture);
  simctl.runtimes = structuredClone(fixture.runtimes);
  simctl.deviceTypes = structuredClone(fixture.devicetypes);
  const deviceManager = new FakeDeviceUtils();
  const handler = createDeviceImageResourcesHandler({
    deviceManager,
    avdManager: new FakeAvdManager(),
    simctl: new FakeSimctl(),
    appleTvInventory: new AppleTvSimulatorInventory(simctl, "arm64"),
  });
  return { simctl, handler, deviceManager };
}

afterEach(() => {
  resetAndroidDeviceImageResourceCache();
  AndroidAvdProvenanceCache.resetForTests();
});

describe("Apple TV device images", () => {
  test("serves captured Apple TVs under tvos with compatibility from device bounds", async () => {
    const { handler } = host();
    const content = await handler.getDeviceImagesByPlatform({ platform: "tvos" });
    const result = await handler.getDeviceImagesForPlatforms(["tvos"]);
    expect(content.uri).toBe("automobile:devices/images/tvos");
    expect(JSON.parse(content.text ?? "{}").tvosCount).toBe(4);
    expect(result).toMatchObject({
      totalCount: 4,
      tvosCount: 4,
      iosCount: 0,
      catalogComplete: true,
      configuredInventory: { complete: true, observations: { tvos: { complete: true } } },
    });
    expect(
      result.images.every((image) => image.platform === "tvos" && image.formFactor === "tv"),
    ).toBe(true);
    expect(result.provisioningCatalog.runtimes.map((runtime) => runtime.id)).toEqual([runtimeId]);
    for (const type of result.provisioningCatalog.deviceTypes) {
      expect(type.platform).toBe("tvos");
      expect(type.runtimeCompatibility).toMatchObject({ knowledge: "known" });
    }
    expect(result.provisioningCatalog.deviceTypes[0].runtimeCompatibility).toMatchObject({
      knowledge: "known",
      minRuntimeVersion: "16.1.0",
      maxRuntimeVersion: null,
      compatibleRuntimeIds: [runtimeId],
    });
  });
  test("catalog compatibility respects a finite upper runtime bound", async () => {
    const { simctl, handler } = host();
    const tvRuntime = simctl.runtimes.find((runtime) => runtime.identifier === runtimeId)!;
    tvRuntime.version = "27.0";
    const result = await handler.getDeviceImagesForPlatforms(["tvos"]);
    const legacy = result.provisioningCatalog.deviceTypes.find(
      (type) => type.id === "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-4K",
    );
    expect(legacy).toMatchObject({
      availability: { available: false },
      runtimeCompatibility: {
        knowledge: "known",
        minRuntimeVersion: "11.0.0",
        maxRuntimeVersion: "26.99.0",
        compatibleRuntimeIds: [],
      },
    });
  });
  test("an empty host is complete and empty", async () => {
    const { simctl, handler } = host();
    simctl.listing = { devices: {} };
    simctl.runtimes = [];
    simctl.deviceTypes = [];
    expect(await handler.getDeviceImagesForPlatforms(["tvos"])).toMatchObject({
      tvosCount: 0,
      catalogComplete: true,
      configuredInventory: { complete: true },
    });
  });
  test("failed listing is incomplete rather than empty", async () => {
    const { simctl, handler } = host();
    simctl.listingError = new Error("listing failed");
    expect(await handler.getDeviceImagesForPlatforms(["tvos"])).toMatchObject({
      images: [],
      configuredInventory: {
        complete: false,
        observations: { tvos: { error: { code: "failed" } } },
      },
    });
  });
  test("failed catalog is incomplete", async () => {
    const { simctl, handler } = host();
    simctl.catalogError = new Error("catalog failed");
    expect(await handler.getDeviceImagesForPlatforms(["tvos"])).toMatchObject({
      catalogComplete: false,
      catalogObservations: { tvos: { error: { code: "failed" } } },
    });
  });
  test("all images remain Android and iOS without touching Apple TV inventory", async () => {
    const { handler, simctl, deviceManager } = host();
    deviceManager.setDeviceImages("ios", []);
    deviceManager.setDeviceImages("android", []);
    simctl.listingError = new Error("must not read tvos");
    simctl.catalogError = new Error("must not read tvos");
    const result = JSON.parse((await handler.getAllDeviceImages()).text ?? "{}");
    expect(Object.keys(result.catalogObservations)).toEqual(["android", "ios"]);
    expect(result).not.toHaveProperty("tvosCount");
  });
});
