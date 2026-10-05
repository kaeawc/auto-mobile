import { describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type {
  AvdConfig,
  AvdConfigReader,
} from "../../../src/utils/android-cmdline-tools/AvdConfigReader";
import type { DeviceInfo } from "../../../src/models";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: DeviceInfo = {
  name: "Pixel",
  platform: "android",
  isRunning: false,
  apiLevel: 30,
  osVersion: "11",
  runtimeId: "original",
  deviceType: "original",
  architecture: "x86_64",
  screenWidth: 500,
  screenHeight: 800,
  screenDensity: 200,
  formFactor: "phone",
  capabilityInventory: { schemaVersion: 1, capabilities: [] },
};
function client(reader: AvdConfigReader): AndroidEmulatorClient {
  return new AndroidEmulatorClient(
    async () => {
      throw new Error("unexpected command");
    },
    () => {
      throw new Error("unexpected spawn");
    },
    new FakeTimer(),
    new FakeAdbClientFactory(),
    reader,
  );
}

describe("AndroidEmulatorClient typed config enrichment characterization", () => {
  test.each([
    { name: "absent config", config: null, expected: device },
    { name: "empty config preserves fallbacks", config: {}, expected: device },
    {
      name: "explicit zero values preserve nullish semantics",
      config: {
        apiLevel: 0,
        osVersion: "",
        deviceName: "",
        screenWidth: 0,
        screenHeight: 0,
        screenDensity: 0,
      },
      expected: {
        ...device,
        apiLevel: 0,
        osVersion: "",
        deviceType: "",
        screenWidth: 0,
        screenHeight: 0,
        screenDensity: 0,
      },
    },
    {
      name: "tablet profile",
      config: { deviceName: "pixel_tablet" },
      expected: { ...device, deviceType: "pixel_tablet", formFactor: "tablet" },
    },
    {
      name: "nexus tablet profile",
      config: { deviceName: "Nexus 9" },
      expected: { ...device, deviceType: "Nexus 9", formFactor: "tablet" },
    },
    {
      name: "foldable profile",
      config: { deviceName: "pixel_fold" },
      expected: { ...device, deviceType: "pixel_fold", formFactor: "foldable" },
    },
    {
      name: "all metadata overrides",
      config: {
        apiLevel: 36,
        osVersion: "16",
        systemImagePackage: "system-images;android-36;google_apis;arm64-v8a",
        architecture: "arm64",
        deviceName: "pixel_9",
        screenWidth: 1080,
        screenHeight: 2400,
        screenDensity: 420,
        capabilityInventory: {
          schemaVersion: 1,
          capabilities: [
            { id: "android.hardware.camera", state: "available", source: "avd_config" },
          ],
        },
      },
      expected: {
        ...device,
        apiLevel: 36,
        osVersion: "16",
        runtimeId: "system-images;android-36;google_apis;arm64-v8a",
        architecture: "arm64-v8a",
        deviceType: "pixel_9",
        screenWidth: 1080,
        screenHeight: 2400,
        screenDensity: 420,
        capabilityInventory: {
          schemaVersion: 1,
          capabilities: [
            { id: "android.hardware.camera", state: "available", source: "avd_config" },
          ],
        },
      },
    },
  ] satisfies { name: string; config: AvdConfig | null; expected: DeviceInfo }[])(
    "$name",
    async ({ config, expected }) => {
      const reader = new FakeAvdConfigReader(config);
      const result = await client(reader)["enrichDeviceInfoList"]([device]);
      expect(result).toEqual([expected]);
      expect(reader.readConfigCalls).toEqual(["Pixel"]);
      if (config === null) {
        expect(result[0]).toBe(device);
      }
    },
  );

  test("reader failure returns the original device", async () => {
    const reader: AvdConfigReader = {
      readConfig: async () => {
        throw new Error("config unavailable");
      },
    };
    expect((await client(reader)["enrichDeviceInfoList"]([device]))[0]).toBe(device);
  });

  test("parallel enrichment retains input order", async () => {
    let completeFirst: ((value: AvdConfig) => void) | undefined;
    const calls: string[] = [];
    const reader: AvdConfigReader = {
      readConfig: (name) => {
        calls.push(name);
        return name === "Pixel"
          ? new Promise((resolve) => {
              completeFirst = resolve;
            })
          : Promise.resolve({ apiLevel: 35 });
      },
    };
    const pending = client(reader)["enrichDeviceInfoList"]([device, { ...device, name: "Other" }]);
    expect(calls).toEqual(["Pixel", "Other"]);
    completeFirst!({ apiLevel: 36 });
    expect(await pending).toEqual([
      { ...device, apiLevel: 36 },
      { ...device, name: "Other", apiLevel: 35 },
    ]);
  });
});
