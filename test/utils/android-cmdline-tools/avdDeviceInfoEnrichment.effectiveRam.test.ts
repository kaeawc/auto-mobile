import { describe, expect, it } from "bun:test";
import { enrichDeviceInfoList } from "../../../src/utils/android-cmdline-tools/avdDeviceInfoEnrichment";
import type { AvdConfigReader } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";

describe("enrichDeviceInfoList effective hardware (#15475)", () => {
  it("lists the RAM and cores the emulator used next to nothing configured", async () => {
    const reader: AvdConfigReader = {
      readConfig: async () => ({ ramSizeMb: 2048, effectiveRamMb: 4096, effectiveCpuCores: 4 }),
    };
    const [device] = await enrichDeviceInfoList(reader, [
      { name: "avd-a", platform: "android" } as never,
    ]);
    expect(device).toMatchObject({ effectiveRamMb: 4096, effectiveCpuCores: 4 });
  });
});
