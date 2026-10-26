import { describe, expect, test } from "bun:test";
import {
  adaptIosSessionDeviceCatalog,
  readIosSessionDeviceCatalog,
  type IosNativeCatalogReader,
  type IosNativeRuntime,
} from "../../../src/devices/sessionCatalog";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import capturedDeviceTypes from "../../fixtures/ios-simctl/list-devicetypes.json";

function deviceType(
  name: string,
  identifier: string,
  productFamily: string,
  modelIdentifier?: string,
): AppleDeviceType {
  return {
    name,
    identifier,
    productFamily,
    ...(modelIdentifier === undefined ? {} : { modelIdentifier }),
    bundlePath: `/Library/Developer/CoreSimulator/Profiles/DeviceTypes/${name}.simdevicetype`,
    minRuntimeVersion: 1_703_936,
    minRuntimeVersionString: "26.0.0",
    maxRuntimeVersion: 4_294_967_295,
    maxRuntimeVersionString: "65535.255.255",
  };
}

function runtime(version: string, identifier: string, isAvailable = true): AppleDeviceRuntime {
  return {
    version,
    identifier,
    isAvailable,
    name: `iOS ${version}`,
    bundlePath: `/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS ${version}.simruntime`,
    runtimeRoot: `/runtime/${version}`,
    buildversion: "24A000",
  };
}

const TYPES = [
  deviceType(
    "iPhone 17 Pro",
    "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    "iPhone",
    "iPhone18,1",
  ),
  deviceType(
    "iPhone 17 Pro Max",
    "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max",
    "iPhone",
    "iPhone18,2",
  ),
  deviceType(
    "iPad Air 13-inch (M4)",
    "com.apple.CoreSimulator.SimDeviceType.iPad-Air-13-inch-M4",
    "iPad",
    "iPad17,2",
  ),
  deviceType(
    "iPhone Duo",
    "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
    "iPhone",
    "iPhoneDuo1,1",
  ),
  deviceType(
    "iPhone Experimental Ultra",
    "com.apple.CoreSimulator.SimDeviceType.iPhone-Experimental-Ultra",
    "iPhone",
  ),
] as const;

describe("iOS native session catalog adapter", () => {
  test("accepts the captured simctl device-type fixture without reshaping it", () => {
    const catalog = adaptIosSessionDeviceCatalog(capturedDeviceTypes.devicetypes, []);

    expect(catalog.models.find((model) => model.name === "iPhone 17 Pro")).toMatchObject({
      simulatorDeviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      modelIdentifier: "iPhone18,1",
      modelType: { family: "iphone", variant: "pro" },
    });
    expect(catalog.models.find((model) => model.name === "iPad Pro 11-inch (M4)")).toMatchObject({
      modelIdentifier: "iPad16,4",
      modelType: { family: "ipad", variant: "pro", sizeInches: "11" },
    });
  });

  test("classifies the installed iPhone 6s naming shape as standard", () => {
    const catalog = adaptIosSessionDeviceCatalog(
      [
        deviceType(
          "iPhone 6s Plus",
          "com.apple.CoreSimulator.SimDeviceType.iPhone-6s-Plus",
          "iPhone",
          "iPhone8,2",
        ),
      ],
      [],
    );

    expect(catalog.models[0]).toMatchObject({
      archetype: "phone",
      modelType: { family: "iphone", variant: "standard" },
      metadataState: "current",
    });
  });

  test("projects real simctl fields with bounded model classification", () => {
    const catalog = adaptIosSessionDeviceCatalog(TYPES, [
      runtime("27.0.0", "com.apple.CoreSimulator.SimRuntime.iOS-27-0"),
      runtime("27.1", "com.apple.CoreSimulator.SimRuntime.iOS-27-1", false),
    ]);
    const byName = new Map(catalog.models.map((model) => [model.name, model]));

    expect(byName.get("iPhone 17 Pro")).toMatchObject({
      modelIdentifier: "iPhone18,1",
      archetype: "phone",
      modelType: { family: "iphone", variant: "pro" },
      minOsVersion: "26.0.0",
      maxOsVersion: null,
      metadataState: "current",
    });
    expect(byName.get("iPhone 17 Pro Max")?.modelType).toEqual({
      family: "iphone",
      variant: "pro-max",
    });
    expect(byName.get("iPad Air 13-inch (M4)")?.modelType).toEqual({
      family: "ipad",
      variant: "air",
      sizeInches: "13",
    });
    expect(byName.get("iPhone Duo")).toMatchObject({
      archetype: "duo",
      modelType: { family: "duo", variant: "duo" },
    });
    expect(byName.get("iPhone Experimental Ultra")).toMatchObject({
      archetype: "phone",
      metadataState: "current",
    });
    expect(byName.get("iPhone Experimental Ultra")?.modelType).toBeUndefined();
    expect(catalog.releases).toEqual([
      {
        runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
        osVersion: "27",
        installed: true,
        metadataState: "current",
      },
      {
        runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-27-1",
        osVersion: "27.1",
        installed: false,
        metadataState: "current",
      },
    ]);
  });

  test("uses exact-ID classification to refine unknown metadata without guessing", () => {
    const custom = deviceType(
      "Prototype Pro Max Ultra",
      "com.example.Prototype",
      "Prototype",
      "Prototype1,1",
    );
    const unconfigured = adaptIosSessionDeviceCatalog([custom], []).models[0];
    const configured = adaptIosSessionDeviceCatalog([custom], [], {
      classifications: [
        {
          simulatorDeviceTypeIdentifier: custom.identifier,
          modelType: { family: "iphone", variant: "pro-max" },
          aliases: ["prototype-max"],
        },
      ],
    }).models[0];

    expect(unconfigured.archetype).toBeUndefined();
    expect(unconfigured.modelType).toBeUndefined();
    expect(configured).toMatchObject({
      aliases: ["prototype-max"],
      archetype: "phone",
      modelType: { family: "iphone", variant: "pro-max" },
    });
  });

  test("classifies a renamed Duo by its device-type identifier suffix", () => {
    const renamed = deviceType(
      "iPhone Duo (2nd generation)",
      "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
      "iPhone",
    );
    const [model] = adaptIosSessionDeviceCatalog([renamed], []).models;

    expect(model).toMatchObject({
      archetype: "duo",
      modelType: { family: "duo", variant: "duo" },
    });
  });

  test("preserves native Duo and iPad evidence against contradictory overrides", () => {
    const duo = TYPES.find((entry) => entry.name === "iPhone Duo")!;
    const ipad = TYPES.find((entry) => entry.name === "iPad Air 13-inch (M4)")!;
    const catalog = adaptIosSessionDeviceCatalog([duo, ipad], [], {
      classifications: [
        {
          simulatorDeviceTypeIdentifier: duo.identifier,
          modelType: { family: "iphone", variant: "standard" },
          aliases: ["ordinary-phone"],
        },
        {
          simulatorDeviceTypeIdentifier: ipad.identifier,
          modelType: { family: "iphone", variant: "pro" },
        },
      ],
    });
    const byName = new Map(catalog.models.map((model) => [model.name, model]));

    expect(byName.get("iPhone Duo")).toMatchObject({
      archetype: "duo",
      modelType: { family: "duo", variant: "duo" },
      metadataState: "stale",
    });
    expect(byName.get("iPhone Duo")?.aliases).toBeUndefined();
    expect(byName.get("iPad Air 13-inch (M4)")).toMatchObject({
      archetype: "tablet",
      modelType: { family: "ipad", variant: "air", sizeInches: "13" },
      metadataState: "stale",
    });
  });

  test("does not certify a runtime whose checked response omits availability", () => {
    const available = runtime("27", "com.apple.CoreSimulator.SimRuntime.iOS-27-0");
    const unknownAvailability: IosNativeRuntime = {
      version: available.version,
      identifier: available.identifier,
      name: available.name,
      bundlePath: available.bundlePath,
      runtimeRoot: available.runtimeRoot,
      buildversion: available.buildversion,
    };
    const release = adaptIosSessionDeviceCatalog([], [unknownAvailability]).releases[0];

    expect(release).toEqual({
      runtimeId: available.identifier,
      osVersion: "27",
      installed: false,
      metadataState: "stale",
    });
  });

  test("propagates stale snapshot state and computes order-independent revisions", () => {
    const first = adaptIosSessionDeviceCatalog(TYPES, [
      runtime("27", "com.apple.CoreSimulator.SimRuntime.iOS-27-0"),
    ]);
    const reversed = adaptIosSessionDeviceCatalog([...TYPES].reverse(), [
      runtime("27", "com.apple.CoreSimulator.SimRuntime.iOS-27-0"),
    ]);
    const stale = adaptIosSessionDeviceCatalog(TYPES, [], { metadataState: "stale" });

    expect(reversed.provenance.revision).toBe(first.provenance.revision);
    expect(stale.models.every((model) => model.metadataState === "stale")).toBe(true);
  });

  test("returns a logged unavailable catalog when native discovery fails", async () => {
    const failure = new Error("xcrun cannot find simctl");
    const warnings: Array<{ message: string; error: unknown }> = [];
    const reader: IosNativeCatalogReader = {
      getDeviceTypesChecked: async () => {
        throw failure;
      },
      getRuntimesChecked: async () => [],
    };

    const catalog = await readIosSessionDeviceCatalog(reader, {
      logger: { warn: (message, error) => warnings.push({ message, error }) },
    });

    expect(catalog).toMatchObject({
      platform: "ios",
      provenance: {
        state: "unavailable",
        message: "Unable to read the installed iOS simulator catalog: xcrun cannot find simctl",
      },
      models: [],
      releases: [],
    });
    expect(warnings).toEqual([{ message: catalog.provenance.message!, error: failure }]);
  });
});
