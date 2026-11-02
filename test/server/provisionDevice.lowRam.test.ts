import { describe, expect, test } from "bun:test";
import {
  provisionDeviceSchema,
  provisionDeviceRegistrationSchema,
} from "../../src/features/deviceLifecycle/core/schemas";
import { parseProvisionDeviceArgs } from "../../src/features/deviceLifecycle/provisioning/provisioning";
import { LOW_RAM_MEMORY_MB } from "../../src/utils/provisionDeviceSpecSchemas";

const android = {
  platform: "android" as const,
  name: "low-ram-phone",
  spec: {
    runtime: "system-images;android-34;google_apis;x86_64",
    deviceType: "pixel_7",
  },
};

describe("provisionDevice lowRam", () => {
  test("accepts an Android lowRam recipe without boot or automation", () => {
    const input = { device: android, lowRam: true, boot: false, readiness: "none" };
    expect(provisionDeviceSchema.safeParse(input).success).toBe(true);
    expect(provisionDeviceRegistrationSchema.safeParse(input).success).toBe(true);
  });

  test.each(["ios", "watchos", "tvos"] as const)("refuses lowRam on %s", (platform) => {
    const device = {
      platform,
      name: "apple-device",
      spec: {
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      },
    };
    for (const lowRam of [true, false]) {
      const result = provisionDeviceRegistrationSchema.safeParse({ device, lowRam });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({ code: "custom", path: ["lowRam"] }),
        );
      }
      if (platform === "ios") {
        expect(provisionDeviceSchema.safeParse({ device, lowRam }).success).toBe(false);
      }
    }
  });

  test.each([undefined, { cpuCores: 2 }, { memoryMb: 1024, cpuCores: 2 }])(
    "resolves lowRam through the existing configuration while preserving other fields (%j)",
    (configuration) => {
      const parsed = parseProvisionDeviceArgs({
        device: { ...android, spec: { ...android.spec, configuration } },
        lowRam: true,
      });
      expect(parsed.device.spec).toEqual({
        ...android.spec,
        configuration: { ...configuration, memoryMb: LOW_RAM_MEMORY_MB },
      });
    },
  );

  test("refuses conflicting explicit RAM", () => {
    const input = {
      device: { ...android, spec: { ...android.spec, configuration: { memoryMb: 4096 } } },
      lowRam: true,
    };
    for (const schema of [provisionDeviceSchema, provisionDeviceRegistrationSchema]) {
      const result = schema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({ path: ["device", "spec", "configuration", "memoryMb"] }),
        );
      }
    }
  });

  test.each([undefined, false])("leaves configuration unchanged for lowRam=%s", (lowRam) => {
    for (const configuration of [undefined, { memoryMb: 4096, cpuCores: 2 }]) {
      const device = { ...android, spec: { ...android.spec, configuration } };
      expect(
        parseProvisionDeviceArgs({ device, ...(lowRam === false ? { lowRam } : {}) }).device,
      ).toEqual(device);
    }
  });

  test.each(["android-34", "android-36.1"])("preserves the modern Play RAM minimum (%s)", (api) => {
    const device = {
      ...android,
      spec: { ...android.spec, runtime: `system-images;${api};google_apis_playstore;x86_64` },
    };
    for (const schema of [provisionDeviceSchema, provisionDeviceRegistrationSchema]) {
      const result = schema.safeParse({ device, lowRam: true });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ["device", "spec", "configuration", "memoryMb"],
            message: expect.stringContaining("at least 2048"),
          }),
        );
      }
    }
  });
});
