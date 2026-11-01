import { join } from "node:path";
import { parseEffectiveHardware } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";
import { describe, expect, it } from "bun:test";
import { enrichDeviceInfoList } from "../../../src/utils/android-cmdline-tools/avdDeviceInfoEnrichment";
import type { AvdConfigReader } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";

describe("enrichDeviceInfoList effective hardware (#15475)", () => {
  it("preserves configured and effective RAM and cores", async () => {
    const hardware = parseEffectiveHardware(
      await Bun.file(
        join(import.meta.dir, "../../fixtures/android-avd-effective-ram/hardware-qemu-api37.ini"),
      ).text(),
    );
    const reader: AvdConfigReader = {
      readConfig: async () => ({ ramSizeMb: 2048, hardware: { cpuCores: 4 }, ...hardware }),
    };
    const [device] = await enrichDeviceInfoList(reader, [
      { name: "avd-a", isRunning: false, platform: "android" },
    ]);
    expect(device).toMatchObject({
      configuredRamMb: 2048,
      configuredCpuCores: 4,
      effectiveRamMb: 4096,
      effectiveCpuCores: 4,
    });
  });
  it("keeps config values authoritative and falls back only when absent", async () => {
    const device = {
      name: "avd-a",
      isRunning: false,
      platform: "android" as const,
      configuredRamMb: 1024,
      configuredCpuCores: 2,
      effectiveRamMb: 2048,
      effectiveCpuCores: 2,
    };
    const reader: AvdConfigReader = {
      readConfig: async () => ({
        ramSizeMb: 2048,
        hardware: { cpuCores: 4 },
        effectiveRamMb: 2560,
        effectiveCpuCores: 4,
      }),
    };
    expect((await enrichDeviceInfoList(reader, [device]))[0]).toMatchObject({
      configuredRamMb: 2048,
      configuredCpuCores: 4,
      effectiveRamMb: 2560,
      effectiveCpuCores: 4,
    });
    expect(
      (await enrichDeviceInfoList({ readConfig: async () => ({}) }, [device]))[0],
    ).toMatchObject(device);
  });

  it("does not infer configured cores or effective hardware when absent", async () => {
    const [device] = await enrichDeviceInfoList({ readConfig: async () => ({ ramSizeMb: 2048 }) }, [
      { name: "unlaunched", isRunning: false, platform: "android" },
    ]);
    expect(device?.configuredRamMb).toBe(2048);
    expect(device?.configuredCpuCores).toBeUndefined();
    expect(device?.effectiveRamMb).toBeUndefined();
    expect(device?.effectiveCpuCores).toBeUndefined();
  });
});
