import { z } from "zod/v4";

/** The booted device the result describes, as every device surface reports it. */
const deviceSchema = z
  .object({
    deviceId: z.string(),
    platform: z.enum(["android", "ios"]),
  })
  .passthrough();

const resourceMapSchema = z.record(z.string(), z.unknown());

const impactItemSchema = z.object({
  description: z.string(),
  confidence: z.enum(["verified", "inferred"]),
  evidence: z.string().optional(),
});
const disabledResourcesSchema = z.array(
  z.object({
    resource: z.string(),
    labels: z.array(z.string()),
    automobileImpact: z.array(impactItemSchema),
    appImpact: z.array(impactItemSchema),
    unsafeWith: z
      .array(
        z.object({
          hazardId: z.string(),
          appliesTo: z.array(z.enum(["post_boot", "preboot"])),
          withResources: z.array(z.string()),
          reason: z.string(),
          evidence: z.string(),
        }),
      )
      .optional(),
  }),
);

/** `setDeviceResources`: a failed verification is `success: false` with `isError`. */
export const setDeviceResourcesResultSchema = z
  .object({
    success: z.boolean(),
    disabledResources: disabledResourcesSchema.optional(),
    device: deviceSchema,
    requested: resourceMapSchema,
    resources: resourceMapSchema,
    changed: z.array(z.string()),
    verification: z.literal("current_boot"),
    observed: z.object({}).passthrough().optional(),
    observationContradictions: z.array(z.string()).optional(),
    services: z.record(z.string(), resourceMapSchema).optional(),
    restore: z.object({}).passthrough().optional(),
  })
  .passthrough();

const driftSchema = z
  .object({
    resource: z.string(),
    kind: z.enum(["missingRequested", "ownedExtra", "unsupported", "commandFailure"]),
    expected: z.unknown(),
    observed: z.unknown(),
  })
  .passthrough();

/** `reconcileDeviceResources`: unresolved drift is `success: false` with `isError`. */
export const reconcileDeviceResourcesResultSchema = z
  .object({
    success: z.boolean(),
    disabledResources: disabledResourcesSchema.optional(),
    device: deviceSchema,
    identity: z.object({}).passthrough(),
    requested: resourceMapSchema,
    profileFingerprint: z.string(),
    drift: z.array(driftSchema),
    remainingDrift: z.array(driftSchema),
    applied: setDeviceResourcesResultSchema.omit({ device: true }).optional(),
    observed: z.object({}).passthrough(),
    verification: z.literal("current_boot"),
  })
  .passthrough();
