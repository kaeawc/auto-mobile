import { z } from "zod/v4";
import { androidAvdConfigurationSchema } from "../models/AndroidAvdConfiguration";
import { MIN_AVD_RAM_MB } from "../utils/android-cmdline-tools/AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import { DISPLAY_CUTOUT_PREFERENCES } from "../utils/displayCutout";

const MODERN_PLAY_IMAGE_MIN_API_LEVEL = 30;
const CORE_SIMULATOR_IDENTIFIER_PREFIX = "com.apple.CoreSimulator.";
const ANDROID_SYSTEM_IMAGE_PREFIX = "system-images;";

function isModernPlayStoreRuntime(runtime: string): boolean {
  const parsedRuntime = parseAndroidSystemImageRuntime(runtime);
  return (
    parsedRuntime?.tag === "google_apis_playstore" &&
    parsedRuntime.apiLevel >= MODERN_PLAY_IMAGE_MIN_API_LEVEL
  );
}

export const androidProvisionDeviceSpecSchema = z
  .object({
    runtime: z.string().min(1).describe("Installed Android system-image package identifier"),
    deviceType: z.string().min(1).describe("Android avdmanager device profile identifier"),
    displayCutout: z
      .enum(DISPLAY_CUTOUT_PREFERENCES)
      .optional()
      .describe(
        "Required display cutout class for the exact device type; 'any' accepts every class",
      ),
    configuration: androidAvdConfigurationSchema.optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    if (spec.runtime.startsWith(CORE_SIMULATOR_IDENTIFIER_PREFIX)) {
      context.addIssue({
        code: "custom",
        message: "Android runtime must be an Android system-image identifier",
        path: ["runtime"],
      });
    }
    if (spec.deviceType.startsWith(CORE_SIMULATOR_IDENTIFIER_PREFIX)) {
      context.addIssue({
        code: "custom",
        message: "Android deviceType must be an Android avdmanager device profile identifier",
        path: ["deviceType"],
      });
    }
    const memoryMb = spec.configuration?.memoryMb;
    if (
      memoryMb !== undefined &&
      memoryMb < MIN_AVD_RAM_MB &&
      isModernPlayStoreRuntime(spec.runtime)
    ) {
      context.addIssue({
        code: "custom",
        message:
          `memoryMb must be at least ${MIN_AVD_RAM_MB} for Android API ` +
          `${MODERN_PLAY_IMAGE_MIN_API_LEVEL}+ Play Store images`,
        path: ["configuration", "memoryMb"],
      });
    }
  });

export const iosProvisionDeviceSpecSchema = z
  .object({
    runtime: z.string().min(1).describe("CoreSimulator runtime identifier"),
    deviceType: z.string().min(1).describe("CoreSimulator device-type identifier"),
    displayCutout: z
      .enum(DISPLAY_CUTOUT_PREFERENCES)
      .optional()
      .describe(
        "Required display cutout class for the exact device type; 'any' accepts every class",
      ),
  })
  .strict()
  .superRefine((spec, context) => {
    if (spec.runtime.startsWith(ANDROID_SYSTEM_IMAGE_PREFIX)) {
      context.addIssue({
        code: "custom",
        message: "iOS runtime must be a CoreSimulator runtime identifier",
        path: ["runtime"],
      });
    }
    if (!spec.deviceType.startsWith(CORE_SIMULATOR_IDENTIFIER_PREFIX)) {
      context.addIssue({
        code: "custom",
        message: "iOS deviceType must be a CoreSimulator device-type identifier",
        path: ["deviceType"],
      });
    }
  });
