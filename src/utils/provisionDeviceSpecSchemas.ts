import { z } from "zod/v4";
import { androidAvdConfigurationSchema } from "../models/AndroidAvdConfiguration";
import { MIN_AVD_RAM_MB } from "./android-cmdline-tools/AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "./android-cmdline-tools/AndroidSystemImageRuntime";
import { DISPLAY_CUTOUT_PREFERENCES } from "./displayCutout";

const MODERN_PLAY_IMAGE_MIN_API_LEVEL = 30;
const CORE_SIMULATOR_IDENTIFIER_PREFIX = "com.apple.CoreSimulator.";
const ANDROID_SYSTEM_IMAGE_PREFIX = "system-images;";

export const BINDING_DEVICE_FAMILIES = [
  "phone",
  "tablet",
  "foldable",
  "tv",
  "watch",
  "automotive",
  "xr-headset",
  "xr-glasses",
] as const;
export type BindingDeviceFamily = (typeof BINDING_DEVICE_FAMILIES)[number];

const bindingDeviceFamilySchema = z
  .enum(BINDING_DEVICE_FAMILIES)
  .optional()
  .describe("Required device family, independent of the exact model and creation default");

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
/**
 * Where an Apple platform's exact identifiers are listed, and an example pair, so a refusal of a
 * missing or malformed spec names what to pass instead of only the expected type (#17090).
 */
export interface AppleProvisionSpecGuidance {
  /** The provisionDevice `platform` value. */
  platform: string;
  /** Where the caller reads the host's runtime and device-type identifiers. */
  catalog: string;
  example: { runtime: string; deviceType: string };
}

export const APPLE_PROVISION_SPEC_GUIDANCE = {
  ios: {
    platform: "ios",
    catalog: "automobile:devices/images/ios",
    example: {
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    },
  },
  watchos: {
    platform: "watchos",
    catalog: "automobile:devices/images/watchos",
    example: {
      runtime: "com.apple.CoreSimulator.SimRuntime.watchOS-11-0",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-10-46mm",
    },
  },
  tvos: {
    platform: "tvos",
    catalog: "automobile:devices/images/tvos",
    example: {
      runtime: "com.apple.CoreSimulator.SimRuntime.tvOS-26-5",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation-4K",
    },
  },
} as const satisfies Record<string, AppleProvisionSpecGuidance>;

/** "runtime and deviceType ..., e.g. {...}; list them with ..." for an Apple spec refusal. */
export function appleSpecShapeHint(guidance: AppleProvisionSpecGuidance): string {
  return (
    `pass spec { runtime, deviceType } with exact CoreSimulator identifiers, e.g. ` +
    `${JSON.stringify(guidance.example)}; list the host's identifiers with ${guidance.catalog}`
  );
}

/** Replace zod's "expected X, received undefined" for an omitted required value. */
function whenMissing(message: string): (issue: { input?: unknown }) => string | undefined {
  return (issue) => (issue.input === undefined ? message : undefined);
}

/** A required Apple spec field whose omission names the expected identifier and an example. */
function appleSpecField(
  field: "runtime" | "deviceType",
  guidance: AppleProvisionSpecGuidance,
  description: string,
): z.ZodString {
  return z
    .string({
      error: whenMissing(
        `is required: a CoreSimulator ${field === "runtime" ? "runtime" : "device-type"} ` +
          `identifier such as '${guidance.example[field]}'; list the host's identifiers with ` +
          guidance.catalog,
      ),
    })
    .min(1)
    .describe(description);
}

/** The object-level error for an omitted Apple spec. */
function appleSpecObjectError(guidance: AppleProvisionSpecGuidance) {
  return {
    error: whenMissing(`is required for ${guidance.platform}: ${appleSpecShapeHint(guidance)}`),
  };
}

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

export function refineAndroidSpec(spec: AndroidSpecFields, context: z.RefinementCtx): void {
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
    const ios = APPLE_PROVISION_SPEC_GUIDANCE.ios;
    context.addIssue({
      code: "custom",
      message:
        `iOS deviceType must be a full CoreSimulator device-type identifier ` +
        `(${CORE_SIMULATOR_IDENTIFIER_PREFIX}SimDeviceType.${spec.deviceType}, not ` +
        `'${spec.deviceType}'), e.g. '${ios.example.deviceType}'; list the host's identifiers ` +
        `with ${ios.catalog}`,
      path: ["deviceType"],
    });
  }
}

/** The AVD-defining fields of an Android provisionDevice spec, for schemas that add to it. */
export const androidProvisionDeviceSpecFields = {
  runtime: androidRuntimeSchema,
  deviceType: androidDeviceTypeSchema,
  displayCutout: displayCutoutSchema,
  configuration: androidAvdConfigurationSchema.optional(),
};

export const iosProvisionDeviceSpecSchema = z
  .object(
    {
      runtime: appleSpecField(
        "runtime",
        APPLE_PROVISION_SPEC_GUIDANCE.ios,
        "CoreSimulator runtime identifier",
      ),
      deviceType: appleSpecField(
        "deviceType",
        APPLE_PROVISION_SPEC_GUIDANCE.ios,
        "CoreSimulator device-type identifier",
      ),
      displayCutout: displayCutoutSchema,
    },
    appleSpecObjectError(APPLE_PROVISION_SPEC_GUIDANCE.ios),
  )
  .strict()
  .superRefine(refineIosSpec);

/**
 * A broker binding's requested Android spec (#11172): the provisionDevice spec with `deviceType`
 * optional. An omitted field is unconstrained (owner decision Q4): any existing model matches, and
 * a creation uses the reconciler's resolved default.
 */
export const androidBindingSpecSchema = z
  .object({
    runtime: androidRuntimeSchema,
    deviceType: androidDeviceTypeSchema.optional(),
    deviceFamily: bindingDeviceFamilySchema,
    displayCutout: displayCutoutSchema,
    configuration: androidAvdConfigurationSchema.optional(),
  })
  .strict()
  .superRefine(refineAndroidSpec);

/** A broker binding's requested iOS spec: `deviceType` optional, as for Android (Q4). */
export const iosBindingSpecSchema = z
  .object({
    runtime: iosRuntimeSchema,
    deviceType: iosDeviceTypeSchema.optional(),
    deviceFamily: bindingDeviceFamilySchema,
    displayCutout: displayCutoutSchema,
  })
  .strict()
  .superRefine(refineIosSpec);

/**
 * An exact Apple Watch simulator spec (#15882): a watchOS CoreSimulator runtime and an Apple Watch
 * CoreSimulator device type, both required. It is provisionDevice's watch spec and, unchanged, a
 * broker watch binding's requested spec: a watch binding has no "any model" default, no family and
 * no cutout preference.
 */
export const watchProvisionDeviceSpecSchema = z
  .object(
    {
      runtime: appleSpecField(
        "runtime",
        APPLE_PROVISION_SPEC_GUIDANCE.watchos,
        "watchOS CoreSimulator runtime identifier",
      ),
      deviceType: appleSpecField(
        "deviceType",
        APPLE_PROVISION_SPEC_GUIDANCE.watchos,
        "Apple Watch CoreSimulator device-type identifier",
      ),
    },
    appleSpecObjectError(APPLE_PROVISION_SPEC_GUIDANCE.watchos),
  )
  .strict();

/** A broker binding's requested Apple Watch spec: exactly the provisionDevice watch spec. */
export const watchBindingSpecSchema = watchProvisionDeviceSpecSchema;

export type WatchBindingSpec = z.output<typeof watchBindingSpecSchema>;

/** Exact identifiers from the host's Apple TV catalog. */
export const appleTvProvisionDeviceSpecSchema = z
  .object(
    {
      runtime: appleSpecField(
        "runtime",
        APPLE_PROVISION_SPEC_GUIDANCE.tvos,
        "tvOS CoreSimulator runtime identifier",
      ),
      deviceType: appleSpecField(
        "deviceType",
        APPLE_PROVISION_SPEC_GUIDANCE.tvos,
        "Apple TV CoreSimulator device-type identifier",
      ),
    },
    appleSpecObjectError(APPLE_PROVISION_SPEC_GUIDANCE.tvos),
  )
  .strict();

/** Exact identifiers from the host's Apple Vision Pro catalog. */
export const appleVisionProvisionDeviceSpecSchema = z
  .object({
    runtime: z.string().min(1).describe("visionOS CoreSimulator runtime identifier"),
    deviceType: z.string().min(1).describe("Apple Vision Pro CoreSimulator device-type identifier"),
  })
  .strict();
