import type { AvdConfig, AvdConfigReader } from "../../utils/android-cmdline-tools/AvdConfigReader";
import type { BindingResultEntry } from "./provisioning/acquisitionResult";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { z } from "zod";
import type { SessionDeviceProfile } from "../../devices/sessionRequirements";
import { ActionableError } from "../../models/ActionableError";
import type { BrokerResourceRecord } from "./store";

const iosModelType = z.discriminatedUnion("family", [
  z.object({ family: z.literal("iphone"), variant: z.enum(["standard", "pro", "pro-max", "air"]) }),
  z.object({
    family: z.literal("ipad"),
    variant: z.enum(["standard", "mini", "air", "pro"]),
    sizeInches: z.string().optional(),
  }),
  z.object({ family: z.literal("duo"), variant: z.literal("duo") }),
]);

export const exactProfile = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("ios"),
    metadataState: z.literal("current"),
    simulatorDeviceTypeIdentifier: z.string().min(1),
    modelIdentifier: z.string().min(1).optional(),
    archetype: z.enum(["phone", "tablet", "duo"]),
    modelType: iosModelType,
    runtimeId: z.string().min(1),
    osVersion: z.string().regex(/^\d+(?:\.\d+)*$/),
    compatibility: z.enum(["supported", "unknown"]),
  }),
  z.object({
    platform: z.literal("android"),
    metadataState: z.literal("current"),
    profileId: z.string().min(1),
    archetype: z.enum(["phone", "tablet", "foldable"]),
    memoryMb: z.number().int().positive().optional(),
    effectiveRamMb: z.number().positive().nullable().optional(),
    effectiveCpuCores: z.number().int().positive().nullable().optional(),
    systemImagePackage: z.string().min(1),
    osVersion: z.string().regex(/^\d+(?:\.\d+)*$/),
    versionPrecision: z.enum(["major", "minor", "patch"]),
    apiLevel: z.number().int().positive(),
    abi: z.string().min(1),
    flavor: z.string().min(1),
  }),
  // An Apple Watch simulator (#15882): exactly provisionDevice's watch spec, nothing inferred.
  z.object({
    platform: z.literal("watchos"),
    metadataState: z.literal("current"),
    runtime: z.string().min(1),
    deviceType: z.string().min(1),
  }),
]);

export type BrokerNativeProfile = z.infer<typeof exactProfile>;

/**
 * Only provider-produced exact resolution records enter this store. Revalidate their native
 * identity before platform work so damaged or old metadata cannot widen a provisioning request.
 * Capability policy (for example Duo) is enforced at admission, not here: a stored resource must
 * stay readable for recovery, reset and destroy even after its host capability is turned off.
 */
export function nativeProfile(
  resource: Pick<BrokerResourceRecord, "profile">,
): BrokerNativeProfile {
  const result = z.object({ profile: exactProfile }).safeParse(resource.profile);
  if (!result.success) {
    throw new ActionableError(
      "Stored session device profile is incomplete; retain its reservation for recovery",
    );
  }
  return result.data.profile;
}

export function poolProfile(value: unknown): SessionDeviceProfile {
  return nativeProfile({ profile: value });
}

export async function brokerReceiptProfile(
  profile: BrokerNativeProfile,
  binding: Pick<BindingResultEntry, "device"> | undefined,
  reader: Pick<AvdConfigReader, "readConfig"> | undefined,
): Promise<BrokerNativeProfile> {
  let hardware: AvdConfig | null | undefined;
  if (profile.platform === "android" && binding?.device) {
    try {
      hardware = await reader?.readConfig(binding.device.name);
    } catch (error) {
      logger.warn(
        `Cannot read effective Android hardware for broker receipt: ${errorMessage(error)}`,
        error,
      );
    }
  }
  const receiptProfile =
    profile.platform === "android"
      ? {
          ...profile,
          effectiveRamMb: hardware?.effectiveRamMb ?? null,
          effectiveCpuCores: hardware?.effectiveCpuCores ?? null,
        }
      : profile;
  return receiptProfile;
}

/** Persist launch facts with the existing receipt profile without changing its configured identity. */
export function activationHardware(
  resource: BrokerResourceRecord,
  profile: SessionDeviceProfile | undefined,
): { profile_json?: string } {
  if (profile?.platform !== "android") {
    return {};
  }
  return {
    profile_json: JSON.stringify({
      ...(typeof resource.profile === "object" && resource.profile !== null
        ? resource.profile
        : {}),
      profile: {
        ...nativeProfile(resource),
        effectiveRamMb: profile.effectiveRamMb ?? null,
        effectiveCpuCores: profile.effectiveCpuCores ?? null,
      },
    }),
  };
}
