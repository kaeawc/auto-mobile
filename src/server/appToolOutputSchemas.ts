import { z } from "zod/v4";
import { APP_TRIM_MEMORY_LEVELS } from "../models/AppLifecycleResult";

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
const androidInspectPackageSigningResultSchema = z
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

const iosProvisioningProfileOutputSchema = z
  .object({
    name: z.string(),
    uuid: z.string(),
    teamIds: z.array(z.string()),
    teamName: z.string().optional(),
    expirationDate: z.string().nullable(),
    expired: z.boolean().nullable(),
    provisionedDeviceCount: z.number().nullable(),
    provisionsAllDevices: z.boolean(),
  })
  .passthrough();

/** iOS variant (#14099); the Android shape above is unchanged. */
const iosInspectPackageSigningResultSchema = z
  .object({
    appId: z.string(),
    platform: z.literal("ios"),
    deviceId: z.string(),
    deviceKind: z.enum(["simulator", "physical"]),
    presence: z.enum(["installed", "absent", "unknown"]),
    unknownReason: z.string().optional(),
    signing: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("available"),
          cdHash: z.string().nullable(),
          identifier: z.string().nullable(),
          teamId: z.string().nullable(),
          signingIdentity: z.string().nullable(),
          adHoc: z.boolean(),
          authorities: z.array(z.string()),
          entitlements: z.record(z.string(), z.unknown()).nullable(),
          provisioningProfile: iosProvisioningProfileOutputSchema.nullable(),
          warnings: z.array(z.string()).optional(),
        })
        .passthrough(),
      z.object({ status: z.literal("unsigned"), reason: z.string() }).passthrough(),
      z.object({ status: z.literal("unavailable"), reason: z.string() }).passthrough(),
    ]),
    observation: z
      .object({
        source: z.enum(["simctl-app-container+codesign", "devicectl-copy+codesign"]),
        fresh: z.literal(true),
        observedAt: z.string(),
        scope: z.object({ deviceId: z.string(), appId: z.string() }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export const inspectPackageSigningResultSchema = z.union([
  androidInspectPackageSigningResultSchema,
  iosInspectPackageSigningResultSchema,
]);

export const appLifecycleResultSchema = z.object({
  message: z.string(),
  success: z.boolean(),
  supported: z.boolean(),
  action: z.enum(["background", "killBackgrounded", "trimMemory"]),
  platform: z.enum(["android", "ios"]),
  appId: z.string(),
  mechanism: z.enum(["home", "am-kill", "am-send-trim-memory", "unsupported"]),
  trimLevel: z.enum(APP_TRIM_MEMORY_LEVELS).optional(),
  userId: z.number().int().nonnegative().optional(),
  pid: z.number().int().positive().optional(),
  pidBefore: z.number().int().positive().optional(),
  pidAfter: z.number().int().positive().nullable().optional(),
  processReclaimed: z.boolean().optional(),
  errorCode: z
    .enum([
      "app_not_running",
      "app_in_foreground",
      "background_not_verified",
      "kill_failed",
      "ambiguous_user",
      "invalid_app_id",
      "trim_level_required",
      "trim_level_not_applicable",
      "trim_failed",
    ])
    .optional(),
  error: z.string().optional(),
});

export const crashAppResultSchema = z.object({
  message: z.string(),
  success: z.boolean(),
  supported: z.boolean(),
  platform: z.enum(["android", "ios"]),
  appId: z.string(),
  processId: z.number().int().positive().optional(),
  mechanism: z.enum([
    "android_am_crash",
    "ios_simulator_sigabrt",
    "ios_device_sigabrt",
    "unsupported",
  ]),
  timestamp: z.number().int().nonnegative(),
  wasRunning: z.boolean().optional(),
  confirmed: z.boolean(),
  evidence: z
    .object({
      source: z.enum([
        "android_logcat",
        "ios_unified_log",
        "android_dropbox",
        "ios_crash_report",
        "none",
      ]),
      summary: z.string(),
    })
    .optional(),
  crashReport: z
    .discriminatedUnion("status", [
      z.object({
        status: z.literal("found"),
        source: z.enum(["ios_ips", "android_dropbox"]),
        reportPath: z.string(),
        exceptionType: z.string(),
        exceptionCode: z.string().optional(),
        exceptionMessage: z.string().optional(),
        terminationReason: z.string().optional(),
        appVersion: z.string().optional(),
        frames: z.array(z.string()),
        failureOccurrenceId: z.string().optional(),
      }),
      z.object({ status: z.literal("notFound") }),
      z.object({ status: z.literal("unsupported"), reason: z.string() }),
    ])
    .optional(),
  userId: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
