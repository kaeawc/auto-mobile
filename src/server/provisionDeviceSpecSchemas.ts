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

const androidRuntimeSchema = z
  .string()
  .min(1)
  .describe("Installed Android system-image package identifier");
const androidDeviceTypeSchema = z
  .string()
  .min(1)
  .describe("Android avdmanager device profile identifier");
const iosRuntimeSchema = z.string().min(1).describe("CoreSimulator runtime identifier");
const iosDeviceTypeSchema = z.string().min(1).describe("CoreSimulator device-type identifier");
const displayCutoutSchema = z
  .enum(DISPLAY_CUTOUT_PREFERENCES)
  .optional()
  .describe("Required display cutout class for the exact device type; 'any' accepts every class");

interface AndroidSpecFields {
  runtime: string;
  deviceType?: string;
  configuration?: { memoryMb?: number };
}

function refineAndroidSpec(spec: AndroidSpecFields, context: z.RefinementCtx): void {
  if (spec.runtime.startsWith(CORE_SIMULATOR_IDENTIFIER_PREFIX)) {
    context.addIssue({
      code: "custom",
      message: "Android runtime must be an Android system-image identifier",
      path: ["runtime"],
    });
  }
  if (spec.deviceType?.startsWith(CORE_SIMULATOR_IDENTIFIER_PREFIX)) {
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
}

function refineIosSpec(
  spec: { runtime: string; deviceType?: string },
  context: z.RefinementCtx,
): void {
  if (spec.runtime.startsWith(ANDROID_SYSTEM_IMAGE_PREFIX)) {
    context.addIssue({
      code: "custom",
      message: "iOS runtime must be a CoreSimulator runtime identifier",
      path: ["runtime"],
    });
  }
  if (
    spec.deviceType !== undefined &&
    !spec.deviceType.startsWith(CORE_SIMULATOR_IDENTIFIER_PREFIX)
  ) {
    context.addIssue({
      code: "custom",
      message: "iOS deviceType must be a CoreSimulator device-type identifier",
      path: ["deviceType"],
    });
  }
}

export const androidProvisionDeviceSpecSchema = z
  .object({
    runtime: androidRuntimeSchema,
    deviceType: androidDeviceTypeSchema,
    displayCutout: displayCutoutSchema,
    configuration: androidAvdConfigurationSchema.optional(),
  })
  .strict()
  .superRefine(refineAndroidSpec);

export const iosProvisionDeviceSpecSchema = z
  .object({
    runtime: iosRuntimeSchema,
    deviceType: iosDeviceTypeSchema,
    displayCutout: displayCutoutSchema,
  })
  .strict()
  .superRefine(refineIosSpec);

/**
 * A managed slot's requested Android spec (#11172): the provisionDevice spec with `deviceType`
 * optional. An omitted field is unconstrained (owner decision Q4): any existing model matches, and
 * a creation uses the reconciler's resolved default.
 */
export const androidManagedSlotSpecSchema = z
  .object({
    runtime: androidRuntimeSchema,
    deviceType: androidDeviceTypeSchema.optional(),
    displayCutout: displayCutoutSchema,
    configuration: androidAvdConfigurationSchema.optional(),
  })
  .strict()
  .superRefine(refineAndroidSpec);

/** A managed slot's requested iOS spec: `deviceType` optional, as for Android (Q4). */
export const iosManagedSlotSpecSchema = z
  .object({
    runtime: iosRuntimeSchema,
    deviceType: iosDeviceTypeSchema.optional(),
    displayCutout: displayCutoutSchema,
  })
  .strict()
  .superRefine(refineIosSpec);
