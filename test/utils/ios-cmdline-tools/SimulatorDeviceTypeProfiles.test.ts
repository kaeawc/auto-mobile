import { describe, expect, test } from "bun:test";
import type { AppleDeviceType } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  SimCtlSimulatorDeviceTypeProfiles,
  type SimulatorDeviceTypeLister,
} from "../../../src/utils/ios-cmdline-tools/SimulatorDeviceTypeProfiles";
import type { PlistReader } from "../../../src/utils/ios-cmdline-tools/PlistClient";

const deviceType = (overrides: Partial<AppleDeviceType> = {}): AppleDeviceType => ({
  minRuntimeVersion: 0,
  maxRuntimeVersion: 0,
  bundlePath: "/Profiles/iPhone 17.simdevicetype",
  name: "iPhone 17",
  identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  productFamily: "iPhone",
  ...overrides,
});

function plistReader(value: unknown): PlistReader {
  return {
    readJsonFile: async () => value,
    readJsonBytes: async () => value,
    readXmlFile: async () => "",
    readXmlBytes: async () => "",
    extractRawFile: async () => "",
  };
}

describe("SimCtlSimulatorDeviceTypeProfiles", () => {
  test("reads display dimensions from a device type profile", async () => {
    const lister: SimulatorDeviceTypeLister = { getDeviceTypes: async () => [deviceType()] };
    const profiles = new SimCtlSimulatorDeviceTypeProfiles(
      lister,
      plistReader({
        mainScreenWidth: "1206",
        mainScreenHeight: "2622",
        mainScreenScale: "3",
        mainScreenWidthDPI: "460",
      }),
    );

    await expect(
      profiles.profileFor("com.apple.CoreSimulator.SimDeviceType.iPhone-17"),
    ).resolves.toEqual({
      deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      productFamily: "iPhone",
      modelIdentifier: null,
      pixelWidth: 1206,
      pixelHeight: 2622,
      scale: 3,
      dpi: 460,
    });
  });

  test("matches device types by identifier", async () => {
    const profiles = new SimCtlSimulatorDeviceTypeProfiles(
      { getDeviceTypes: async () => [deviceType({ identifier: "other" }), deviceType()] },
      plistReader({ mainScreenWidth: 1206 }),
    );

    await expect(
      profiles.profileFor("com.apple.CoreSimulator.SimDeviceType.iPhone-17"),
    ).resolves.toMatchObject({
      deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      pixelWidth: 1206,
    });
  });

  test("caches profile and device type lookups", async () => {
    let calls = 0;
    const profiles = new SimCtlSimulatorDeviceTypeProfiles(
      {
        getDeviceTypes: async () => {
          calls++;
          return [deviceType()];
        },
      },
      plistReader({}),
    );

    await profiles.profileFor("com.apple.CoreSimulator.SimDeviceType.iPhone-17");
    await profiles.profileFor("com.apple.CoreSimulator.SimDeviceType.iPhone-17");

    expect(calls).toBe(1);
  });

  test("returns null when the device type listing fails", async () => {
    const profiles = new SimCtlSimulatorDeviceTypeProfiles(
      { getDeviceTypes: async () => Promise.reject(new Error("failed")) },
      plistReader({}),
    );

    await expect(
      profiles.profileFor("com.apple.CoreSimulator.SimDeviceType.iPhone-17"),
    ).resolves.toBeNull();
  });

  test("retries a transient device type listing failure", async () => {
    let calls = 0;
    const profiles = new SimCtlSimulatorDeviceTypeProfiles(
      {
        getDeviceTypes: async () => {
          calls++;
          if (calls === 1) {
            throw new Error("transient failure");
          }
          return [deviceType()];
        },
      },
      plistReader({ mainScreenWidth: 1206 }),
    );

    await expect(
      profiles.profileFor("com.apple.CoreSimulator.SimDeviceType.iPhone-17"),
    ).resolves.toBeNull();
    await expect(
      profiles.profileFor("com.apple.CoreSimulator.SimDeviceType.iPhone-17"),
    ).resolves.toMatchObject({ pixelWidth: 1206 });
    await profiles.profileFor("com.apple.CoreSimulator.SimDeviceType.iPhone-17");
    expect(calls).toBe(2);
  });

  test("returns null when the profile read fails", async () => {
    const plist = plistReader({});
    plist.readJsonFile = async () => Promise.reject(new Error("failed"));
    const profiles = new SimCtlSimulatorDeviceTypeProfiles(
      { getDeviceTypes: async () => [deviceType()] },
      plist,
    );

    await expect(
      profiles.profileFor("com.apple.CoreSimulator.SimDeviceType.iPhone-17"),
    ).resolves.toBeNull();
  });

  test("returns null for an unknown device type", async () => {
    const profiles = new SimCtlSimulatorDeviceTypeProfiles(
      { getDeviceTypes: async () => [] },
      plistReader({}),
    );

    await expect(
      profiles.profileFor("com.apple.CoreSimulator.SimDeviceType.iPhone-17"),
    ).resolves.toBeNull();
  });
});
