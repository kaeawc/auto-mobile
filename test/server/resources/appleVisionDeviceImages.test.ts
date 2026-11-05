import { afterEach, describe, expect, test } from "bun:test";
import fixture from "../../fixtures/ios-simctl/list-all-visionos-26-5.json";
import { FakeAppleVisionSimctl } from "../../fakes/FakeAppleVisionSimctl";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeAvdManager } from "../../fakes/FakeAvdManager";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { AppleVisionSimulatorInventory } from "../../../src/utils/ios-cmdline-tools/AppleVisionSimulatorInventory";
import { AndroidAvdProvenanceCache } from "../../../src/utils/AndroidAvdProvenanceCache";
import {
  createDeviceImageResourcesHandler,
  resetAndroidDeviceImageResourceCache,
} from "../../../src/server/deviceImageResources";

const runtimeId = "com.apple.CoreSimulator.SimRuntime.xrOS-26-5";
function host() {
  const simctl = new FakeAppleVisionSimctl();
  simctl.listing = structuredClone(fixture);
  simctl.runtimes = structuredClone(fixture.runtimes);
  simctl.deviceTypes = structuredClone(fixture.devicetypes);
  const deviceManager = new FakeDeviceUtils();
  const handler = createDeviceImageResourcesHandler({
    deviceManager,
    avdManager: new FakeAvdManager(),
    simctl: new FakeSimctl(),
    appleVisionInventory: new AppleVisionSimulatorInventory(simctl, "arm64"),
  });
  return { simctl, handler, deviceManager };
}

afterEach(() => {
  resetAndroidDeviceImageResourceCache();
  AndroidAvdProvenanceCache.resetForTests();
});

describe("Apple Vision Pro device images", () => {
  test("serves captured Apple Vision Pros under visionos with compatibility from device bounds", async () => {
    const { handler } = host();
    const content = await handler.getDeviceImagesByPlatform({ platform: "visionos" });
    const result = await handler.getDeviceImagesForPlatforms(["visionos"]);
    expect(content.uri).toBe("automobile:devices/images/visionos");
    expect(JSON.parse(content.text ?? "{}").visionosCount).toBe(3);
    expect(result).toMatchObject({
      totalCount: 3,
      visionosCount: 3,
      iosCount: 0,
      catalogComplete: true,
      configuredInventory: { complete: true, observations: { visionos: { complete: true } } },
    });
    expect(
      result.images.every(
        (image) => image.platform === "visionos" && image.formFactor === "xr-headset",
      ),
    ).toBe(true);
    expect(result.provisioningCatalog.runtimes.map((runtime) => runtime.id)).toEqual([runtimeId]);
    for (const type of result.provisioningCatalog.deviceTypes) {
      expect(type.platform).toBe("visionos");
      expect(type.runtimeCompatibility).toMatchObject({ knowledge: "known" });
    }
    expect(result.provisioningCatalog.deviceTypes[0].runtimeCompatibility).toMatchObject({
      knowledge: "known",
      minRuntimeVersion: "3.0.0",
      maxRuntimeVersion: null,
      compatibleRuntimeIds: [runtimeId],
    });
  });
  test("unknown platforms still return the complete supported-platform error", async () => {
    const { handler } = host();
    const result = await handler.getDeviceImagesByPlatform({ platform: "unknown" });
    expect(JSON.parse(result.text ?? "{}")).toEqual({
      error:
        "Invalid platform: unknown. Must be 'android', 'ios', 'watchos', 'tvos' or 'visionos'.",
    });
  });
  test("catalog compatibility respects a finite upper runtime bound", async () => {
    const { simctl, handler } = host();
    const visionRuntime = simctl.runtimes.find((runtime) => runtime.identifier === runtimeId)!;
    visionRuntime.version = "27.0";
    const result = await handler.getDeviceImagesForPlatforms(["visionos"]);
    const legacy = result.provisioningCatalog.deviceTypes.find(
      (type) => type.id === "com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro",
    );
    expect(legacy).toMatchObject({
      availability: { available: false },
      runtimeCompatibility: {
        knowledge: "known",
        minRuntimeVersion: "1.0.0",
        maxRuntimeVersion: "2.99.0",
        compatibleRuntimeIds: [],
      },
    });
  });
  test("an empty host is complete and empty", async () => {
    const { simctl, handler } = host();
    simctl.listing = { devices: {} };
    simctl.runtimes = [];
    simctl.deviceTypes = [];
    expect(await handler.getDeviceImagesForPlatforms(["visionos"])).toMatchObject({
      visionosCount: 0,
      catalogComplete: true,
      configuredInventory: { complete: true },
    });
  });
  test("failed listing is incomplete rather than empty", async () => {
    const { simctl, handler } = host();
    simctl.listingError = new Error("listing failed");
    expect(await handler.getDeviceImagesForPlatforms(["visionos"])).toMatchObject({
      images: [],
      configuredInventory: {
        complete: false,
        observations: { visionos: { error: { code: "failed" } } },
      },
    });
  });
  test("failed catalog is incomplete", async () => {
    const { simctl, handler } = host();
    simctl.catalogError = new Error("catalog failed");
    expect(await handler.getDeviceImagesForPlatforms(["visionos"])).toMatchObject({
      catalogComplete: false,
      catalogObservations: { visionos: { error: { code: "failed" } } },
    });
  });
  test("all images remain Android and iOS without touching Apple Vision Pro inventory", async () => {
    const { handler, simctl, deviceManager } = host();
    deviceManager.setDeviceImages("ios", []);
    deviceManager.setDeviceImages("android", []);
    simctl.listingError = new Error("must not read visionos");
    simctl.catalogError = new Error("must not read visionos");
    const result = JSON.parse((await handler.getAllDeviceImages()).text ?? "{}");
    expect(Object.keys(result.catalogObservations)).toEqual(["android", "ios"]);
    expect(result).not.toHaveProperty("visionosCount");
  });
});
