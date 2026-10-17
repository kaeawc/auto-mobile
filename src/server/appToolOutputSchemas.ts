import { z } from "zod/v4";

const appPlatformOutputSchema = z.enum(["android", "ios"]);

const listAppsAppOutputSchema = z
  .object({
    packageName: z.string(),
    type: z.enum(["user", "system"]),
    foreground: z.boolean(),
    recent: z.boolean(),
    userId: z.number().optional(),
    userProfile: z.enum(["personal", "work", "secondary", "unknown"]).optional(),
    userIds: z.array(z.number()).optional(),
    label: z.string().optional(),
    displayName: z.string().optional(),
    launchable: z.boolean().optional(),
    launchableByUserId: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough();

export const listAppsResultSchema = z
  .object({
    message: z.string(),
    query: z
      .object({
        platform: appPlatformOutputSchema.optional(),
        search: z.string().optional(),
        type: z.enum(["user", "system", "all", "launchable"]).optional(),
        profile: z.number().optional(),
        deviceId: z.string().optional(),
      })
      .passthrough(),
    observationComplete: z.boolean(),
    totalCount: z.number(),
    installedCount: z.number(),
    deviceCount: z.number(),
    lastUpdated: z.string(),
    devices: z.array(
      z
        .object({
          deviceId: z.string(),
          platform: appPlatformOutputSchema,
          totalCount: z.number(),
          lastUpdated: z.string(),
          apps: z.array(listAppsAppOutputSchema),
        })
        .passthrough(),
    ),
    launchabilityUnknownProfiles: z.array(z.number()).optional(),
    launchabilityUnknownApps: z.array(z.string()).optional(),
  })
  .passthrough();

/** Failure keeps `success:false` + `error`; the wire `isError` flag is set by the handler. */
export const getAppPermissionsResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    appId: z.string(),
    deviceId: z.string(),
    platform: appPlatformOutputSchema,
    permissions: z.array(
      z
        .object({
          permission: z.string(),
          state: z.enum(["granted", "denied", "unknown", "limited"]),
          service: z.string().optional(),
          source: z.enum(["androidRuntime", "iosTcc"]),
          verified: z.boolean().optional(),
          reason: z.string().optional(),
          accessLevel: z.enum(["readWrite", "addOnly"]).optional(),
          evidence: z.enum(["storedTccGrant", "impliedByFullPhotosGrant"]).optional(),
          authValue: z.number().optional(),
          raw: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
            .optional(),
        })
        .passthrough(),
    ),
    error: z.string().optional(),
  })
  .passthrough();

const packageSignerOutputSchema = z
  .object({
    sha256: z.string(),
    minSdkVersion: z.number().optional(),
    maxSdkVersion: z.number().optional(),
    lineage: z.array(z.string()).optional(),
  })
  .passthrough();

/** Read failures throw; an unreadable package is reported as `presence:"unknown"`, never as an error. */
export const inspectPackageSigningResultSchema = z
  .object({
    appId: z.string(),
    platform: z.literal("android"),
    deviceId: z.string(),
    userId: z.number(),
    userSource: z.enum([
      "explicit",
      "installedUser",
      "foregroundPackage",
      "managedProfile",
      "primary",
      "currentUser",
    ]),
    presence: z.enum(["installed", "absent", "unknown"]),
    unknownReason: z.string().optional(),
    state: z
      .object({ hidden: z.boolean().optional(), suspended: z.boolean().optional() })
      .passthrough()
      .optional(),
    signing: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("available"),
          scheme: z.enum(["v2", "v3", "v3.1"]),
          signerSha256: z.array(z.string()),
          signers: z.array(packageSignerOutputSchema),
          history: z.array(z.string()).optional(),
        })
        .passthrough(),
      z.object({ status: z.literal("unavailable"), reason: z.string() }).passthrough(),
    ]),
    observation: z
      .object({
        source: z.literal("dumpsys-package+apk-signing-block"),
        fresh: z.literal(true),
        observedAt: z.string(),
        scope: z
          .object({
            deviceId: z.string(),
            userId: z.number(),
            appId: z.string(),
            apkPath: z.string().optional(),
          })
          .passthrough(),
        apiLevel: z.number().nullable(),
      })
      .passthrough(),
  })
  .passthrough();
