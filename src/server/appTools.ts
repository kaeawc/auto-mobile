import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import {
  ActionableError,
  BootedDevice,
  type CrashAppResult,
  type LaunchAppResult,
  type TerminateAppResult,
} from "../models";
import { toActionableError } from "../models/ActionableError";
import { CrashApp } from "../features/action/CrashApp";
import { LaunchApp } from "../features/action/LaunchApp";
import { TerminateApp } from "../features/action/TerminateApp";
import { InstallApp } from "../features/action/InstallApp";
import { UninstallApp } from "../features/action/UninstallApp";
import { AppPermissions } from "../features/action/AppPermissions";
import { ResetKeychain } from "../features/action/ResetKeychain";
import { resolveMissingForegroundWindow } from "../features/observe/ObserveScreen";
import {
  createJSONToolResponse,
  createStructuredToolResponse,
  DefaultToolResponseFormatter,
  ToolResponseFormatter,
} from "../utils/toolUtils";
import {
  addDeviceTargetingToSchema,
  responseShapeControlFields,
  withAppIdAliases,
  withJsonSchemaOverride,
} from "./toolSchemaHelpers";
import {
  invalidateInstalledAppsCache,
  invalidateInstalledAppResourceCache,
  notifyInstalledAppResourceUpdated,
  queryInstalledApps,
  type AppsQueryType,
} from "./appResources";
import { logger } from "../utils/logger";
import { isDeviceLostError } from "./deviceLossOutcome";

export interface ListAppsToolDependencies {
  toolResponseFormatter: ToolResponseFormatter;
  queryInstalledApps: typeof queryInstalledApps;
}

let listAppsToolDependencies: ListAppsToolDependencies | null = null;

function getListAppsToolDependencies(): ListAppsToolDependencies {
  if (!listAppsToolDependencies) {
    listAppsToolDependencies = {
      toolResponseFormatter: new DefaultToolResponseFormatter(),
      queryInstalledApps,
    };
  }
  return listAppsToolDependencies;
}

export function setListAppsToolDependencies(deps: Partial<ListAppsToolDependencies>): void {
  const currentDeps = getListAppsToolDependencies();
  listAppsToolDependencies = {
    toolResponseFormatter: deps.toolResponseFormatter ?? currentDeps.toolResponseFormatter,
    queryInstalledApps: deps.queryInstalledApps ?? currentDeps.queryInstalledApps,
  };
}

export function resetListAppsToolDependencies(): void {
  listAppsToolDependencies = null;
}

export interface TerminateAppExecutor {
  execute(
    appId: string,
    options?: {
      skipUiStability?: boolean;
    },
  ): Promise<TerminateAppResult>;
}

export interface TerminateAppToolDependencies {
  createTerminateApp(device: BootedDevice): TerminateAppExecutor;
}

let terminateAppToolDependencies: TerminateAppToolDependencies | null = null;

function getTerminateAppToolDependencies(): TerminateAppToolDependencies {
  if (!terminateAppToolDependencies) {
    terminateAppToolDependencies = {
      createTerminateApp: (device) => new TerminateApp(device),
    };
  }
  return terminateAppToolDependencies;
}

export function setTerminateAppToolDependencies(deps: Partial<TerminateAppToolDependencies>): void {
  const currentDeps = getTerminateAppToolDependencies();
  terminateAppToolDependencies = {
    createTerminateApp: deps.createTerminateApp ?? currentDeps.createTerminateApp,
  };
}

export function resetTerminateAppToolDependencies(): void {
  terminateAppToolDependencies = null;
}

export interface CrashAppExecutor {
  execute(appId: string, signal?: AbortSignal): Promise<CrashAppResult>;
}

export interface CrashAppToolDependencies {
  createCrashApp(device: BootedDevice): CrashAppExecutor;
  invalidateAppResourceCache(deviceId: string): void;
  notifyAppResourceUpdated(deviceId: string): Promise<void>;
}

let crashAppToolDependencies: CrashAppToolDependencies | null = null;

function getCrashAppToolDependencies(): CrashAppToolDependencies {
  if (!crashAppToolDependencies) {
    crashAppToolDependencies = {
      createCrashApp: (device) => new CrashApp(device),
      invalidateAppResourceCache: invalidateInstalledAppResourceCache,
      notifyAppResourceUpdated: notifyInstalledAppResourceUpdated,
    };
  }
  return crashAppToolDependencies;
}

export function setCrashAppToolDependencies(deps: Partial<CrashAppToolDependencies>): void {
  const currentDeps = getCrashAppToolDependencies();
  crashAppToolDependencies = {
    createCrashApp: deps.createCrashApp ?? currentDeps.createCrashApp,
    invalidateAppResourceCache:
      deps.invalidateAppResourceCache ?? currentDeps.invalidateAppResourceCache,
    notifyAppResourceUpdated: deps.notifyAppResourceUpdated ?? currentDeps.notifyAppResourceUpdated,
  };
}

export function resetCrashAppToolDependencies(): void {
  crashAppToolDependencies = null;
}

/**
 * Extract the package name from `viewHierarchy.foregroundActivity` (issue
 * #6220 follow-up): the raw accessibility signal, in the standard
 * `package/activity` (or `package/.RelativeActivity`) wire format. Mirrors
 * `LaunchApp.packageFromForegroundActivity` — kept as a matching one-liner
 * here (not a shared import) the same way `ObserveScreen.ts` already inlines
 * this exact parse at each of its own call sites — so the attribution driving
 * `observedAppId` here and the match/mismatch decision in `LaunchApp.execute`
 * can never disagree about which app a `foregroundActivity` names.
 */
function packageFromForegroundActivity(
  observation: LaunchAppResult["observation"],
): string | undefined {
  const foregroundActivity = observation?.viewHierarchy?.foregroundActivity;
  if (!foregroundActivity) {
    return undefined;
  }
  return foregroundActivity.split("/")[0] || undefined;
}

function isVerifiedLaunchObservation(
  appId: string,
  observedAppId: string | undefined,
  observation: LaunchAppResult["observation"],
): boolean {
  return (
    observedAppId === appId &&
    observation?.freshness?.isFresh !== false &&
    observation?.freshness?.verified !== false
  );
}

/**
 * Reason a launch could not be verified (issue #6220), for the case where no
 * foreground application window was observed at all — as opposed to an
 * observed-but-different foreground (an accepted surface, e.g. a permission
 * dialog, which `LaunchApp.execute` already treats as success and this
 * response layer must not second-guess with a misleading `verified: false`).
 */
type LaunchVerificationFailureReason = "no_observation" | "no_foreground_window";

function launchVerificationFailureReason(
  observedAppId: string | undefined,
  observation: LaunchAppResult["observation"],
): LaunchVerificationFailureReason | undefined {
  if (observation === undefined) {
    return "no_observation";
  }
  // `resolveMissingForegroundWindow` (the SAME machine-readable verdict the
  // observe freshness gate uses) is consulted here too, not just an empty
  // `observedAppId` (issue #6239 review follow-up): a status-bar-only capture
  // can still carry STALE `activeWindow.appId`/`packageName` metadata from a
  // previously-resumed app, which would otherwise make `observedAppId` look
  // like a real (if wrong) observed app and suppress this structured failure.
  if (!observedAppId || resolveMissingForegroundWindow(observation) !== undefined) {
    return "no_foreground_window";
  }
  return undefined;
}

function launchVerificationFailureMessage(reason: LaunchVerificationFailureReason): string {
  return reason === "no_observation"
    ? "no observation was captured after launch"
    : "no foreground application window could be observed after launch";
}

function buildLaunchMessage(
  appId: string,
  verified: boolean | undefined,
  verifyFailureReason: LaunchVerificationFailureReason | undefined,
): string {
  if (verified === true) {
    return `Launched app ${appId} (foreground verified)`;
  }
  if (verifyFailureReason) {
    return `Launched app ${appId} (verification failed: ${launchVerificationFailureMessage(verifyFailureReason)})`;
  }
  return `Launched app ${appId}`;
}

/**
 * Build the launchApp tool response from a {@link LaunchAppResult}, enforcing the
 * launch postcondition instead of reporting a flat "Launched app X" success
 * regardless of what actually happened (#5868).
 *
 * `LaunchApp.execute` already resolves the package (returning `success:false`
 * with "App is not installed" for an uninstalled package) and reconciles the
 * launch observation against the requested app (returning `success:false` when
 * the foreground app never matches). This surfaces those typed failures as a
 * real error — mirroring the terminate handler (#5621) — rather than swallowing
 * them behind a success message. On success it additionally reports the observed
 * foreground appId and whether it matched, so a client can skip a confirming
 * `observe` round-trip.
 *
 * `verified` is a three-way signal, never a silent `undefined` when the launch
 * genuinely could not be confirmed (issue #6220): `true` on an exact foreground
 * match against a fresh, verified observation; `false` (with `verifyFailureReason`
 * naming why) when no foreground window could be observed for the launched app at
 * all; and `undefined` only for the deliberately-ambiguous case of an observed,
 * DIFFERENT real foreground (an accepted surface such as a permission dialog,
 * which `LaunchApp.execute` already accepted as success) or a matching-but-stale
 * observation, where asserting `false` would contradict the tool's own success.
 */
/**
 * Mirror `LaunchApp`'s own reconciliation, which accepts the active window's
 * appId, the view hierarchy's packageName, OR the package parsed out of
 * `viewHierarchy.foregroundActivity` — the one remaining app-identity signal
 * on a hierarchy with no screen dimensions (so `ObserveScreen` never derives
 * `activeWindow`) and no `packageName` (issue #6220 follow-up). `||` (not
 * `??`) throughout so an empty-string appId (no foreground window
 * identified, issue #6220) falls through each fallback rather than being
 * treated as a real observed app.
 */
function resolveLaunchObservedAppId(
  observation: LaunchAppResult["observation"],
): string | undefined {
  return (
    observation?.activeWindow?.appId ||
    observation?.viewHierarchy?.packageName ||
    packageFromForegroundActivity(observation)
  );
}

export function buildLaunchAppResponse(appId: string, result: LaunchAppResult) {
  if (!result.success) {
    // `||` not `??`: an empty-string error must still yield the non-empty
    // fallback rather than surfacing a blank message.
    throw new ActionableError(result.error || `Failed to launch app ${appId}`);
  }

  const observedAppId = resolveLaunchObservedAppId(result.observation);
  // Only assert verification on an exact foreground match with a fresh, verified
  // observation. `LaunchApp.execute` retries an unverified observation, but this
  // response-level guard preserves the true-or-undefined contract for any direct
  // caller that supplies one.
  const isVerified = isVerifiedLaunchObservation(appId, observedAppId, result.observation);
  const verifyFailureReason = isVerified
    ? undefined
    : launchVerificationFailureReason(observedAppId, result.observation);
  const verified = isVerified ? true : verifyFailureReason ? false : undefined;

  return {
    message: buildLaunchMessage(appId, verified, verifyFailureReason),
    verified,
    ...(verifyFailureReason ? { verifyFailureReason } : {}),
    observedAppId,
    observation: result.observation,
    ...result,
  };
}

// Schema definitions
export const packageNameSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z.object({
      appId: z.string(),
    }),
  ),
);

// terminateApp embeds a post-action observation, so it carries the same
// response-shape control as the other action tools (issue #5886): the embedded
// observation defaults to the compact skeleton, opt-out-able via raw/project.
export const terminateAppSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z.object({
      appId: z.string(),
      ...responseShapeControlFields,
    }),
  ),
);

export const crashAppSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z.object({
      appId: z.string().trim().min(1),
    }),
  ),
);

export const crashAppResultSchema = z.object({
  message: z.string(),
  success: z.boolean(),
  supported: z.boolean(),
  platform: z.enum(["android", "ios"]),
  appId: z.string(),
  processId: z.number().int().positive().optional(),
  mechanism: z.enum(["android_am_crash", "ios_simulator_sigabrt", "unsupported"]),
  timestamp: z.number().int().nonnegative(),
  wasRunning: z.boolean().optional(),
  confirmed: z.boolean(),
  evidence: z
    .object({
      source: z.enum(["android_logcat", "ios_unified_log"]),
      summary: z.string(),
    })
    .optional(),
  userId: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

export const launchAppSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        clearAppData: z
          .boolean()
          .optional()
          .describe("Clear app data before launch (default false)"),
        coldBoot: z.boolean().optional().describe("Cold boot app (default false)"),
        ...responseShapeControlFields,
      })
      // #6154: the advertised `additionalProperties: false` was not actually
      // enforced at runtime — `.strict()` closes that gap. `withAppIdAliases`
      // runs its `z.preprocess` normalization (packageName -> appId, alias
      // deleted) before this schema ever parses, so the documented alias still
      // works under strict mode.
      .strict(),
  ),
);

export const installAppSchema = addDeviceTargetingToSchema(
  z.object({
    artifactPath: z.string().describe("App artifact path (.apk, .app, or .ipa)"),
  }),
);

export const uninstallAppSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z.object({
      appId: z.string(),
      keepData: z
        .boolean()
        .optional()
        .describe("Keep app data after uninstall (Android only, default false)"),
    }),
  ),
);

const appPermissionActionSchema = z.enum(["grant", "revoke", "reset"]);

export const setAppPermissionsSchema = withJsonSchemaOverride(
  withAppIdAliases(
    addDeviceTargetingToSchema(
      z.object({
        appId: z.string().trim().min(1),
        action: appPermissionActionSchema
          .optional()
          .describe(
            "Action (default grant). Android reset requires permissions=['all'] device-wide; " +
              "iOS physical devices support reset only.",
          ),
        permissions: z
          .array(z.string().min(1))
          .optional()
          .describe("Permissions; Android reset accepts only 'all'; physical iOS accepts it too"),
        userId: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Android user ID for grant/revoke, not reset"),
        notificationsEnabled: z
          .boolean()
          .optional()
          .describe("Android notification state, independent of POST_NOTIFICATIONS"),
        notificationPolicyAccess: z.boolean().optional().describe("Android: set DND policy access"),
        scheduleExactAlarm: z
          .enum(["allow", "deny"])
          .optional()
          .describe("Android: set SCHEDULE_EXACT_ALARM appop"),
      }),
    ),
  )
    .refine(
      (args) =>
        (args.permissions !== undefined && args.permissions.length > 0) ||
        args.notificationsEnabled !== undefined ||
        args.notificationPolicyAccess !== undefined ||
        args.scheduleExactAlarm !== undefined,
      "Provide at least one permission or platform-specific permission option",
    )
    .refine(
      (args) => args.action !== "reset" || args.userId === undefined,
      "Android reset is device-wide and does not support userId",
    )
    .refine(
      (args) =>
        args.action !== "reset" ||
        args.permissions?.some((permission) => permission.trim().length > 0) === true,
      "Reset requires permissions",
    )
    .refine(
      (args) =>
        args.action !== "reset" ||
        args.platform !== "android" ||
        (args.permissions?.length === 1 && args.permissions[0] === "all"),
      "Android reset requires permissions=['all']",
    ),
  (jsonSchema) => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    delete properties.appId?.minLength;
    delete properties.action?.type;
    delete properties.scheduleExactAlarm?.type;
    for (const name of [
      "action",
      "permissions",
      "userId",
      "notificationsEnabled",
      "notificationPolicyAccess",
      "scheduleExactAlarm",
      "sessionUuid",
      "device",
    ]) {
      delete properties[name]?.description;
    }
    jsonSchema.if = {
      properties: { action: { const: "reset" } },
      required: ["action"],
    };
    jsonSchema.then = {
      required: ["permissions"],
      not: { required: ["userId"] },
      if: {
        properties: { platform: { const: "android" } },
        required: ["platform"],
      },
      then: {
        properties: {
          permissions: {
            minItems: 1,
            maxItems: 1,
            items: { const: "all" },
          },
        },
      },
    };
  },
);

export const getAppPermissionsSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z.object({
      appId: z.string(),
      permissions: z
        .array(z.string().min(1))
        .optional()
        .describe("Optional permissions or simulator privacy services to query"),
    }),
  ),
);

export const resetKeychainSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z.object({
      appId: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Required. The app whose Keychain/Keystore state to reset. NOTE: iOS Simulator only supports a device-wide reset and erases EVERY app's Keychain regardless of this value.",
        ),
      confirm: z
        .boolean()
        .describe(
          "Required. Must be true to proceed. On iOS Simulator this erases the Keychain for EVERY app on the target simulator, not just appId.",
        ),
    }),
  ),
);

export const listAppsSchema = addDeviceTargetingToSchema(
  z.object({
    type: z
      .enum(["user", "system", "all"])
      .optional()
      .describe(
        "Filter by app type. Defaults to 'user', EXCEPT on a physical iOS device where " +
          "user/system classification is unavailable (devicectl reports no such signal there): " +
          "on such a device an omitted type returns every app (reported as 'all'), and an " +
          "explicit 'user' or 'system' filter is rejected rather than silently honored.",
      ),
    search: z
      .string()
      .optional()
      .describe(
        "Filter by a case-insensitive substring of the package name/bundle id. Also matches " +
          "the app's display name where the platform reports one (iOS only today — Android's " +
          "listing does not include app labels).",
      ),
    profile: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Filter to apps visible to this user profile id."),
  }),
);

export interface ListAppsArgs {
  type?: AppsQueryType;
  search?: string;
  profile?: number;
}

// Export interfaces for type safety
export interface AppActionArgs {
  appId: string;
}

export interface CrashAppActionArgs {
  appId: string;
}

export interface LaunchAppActionArgs {
  appId: string;
  clearAppData?: boolean;
  coldBoot?: boolean;
  raw?: boolean;
  project?: "full" | "skeleton";
}

export interface InstallAppArgs {
  artifactPath: string;
}

export interface UninstallAppArgs {
  appId: string;
  keepData?: boolean;
}

export type SetAppPermissionsArgs = z.infer<typeof setAppPermissionsSchema>;

export type GetAppPermissionsArgs = z.infer<typeof getAppPermissionsSchema>;

export type ResetKeychainArgs = z.infer<typeof resetKeychainSchema>;

// Injection seam for the setAppPermissions handler (mirrors the tapAny
// factory seam in interactionTools.ts). Lets a unit test exercise the
// registered handler wiring with a fake AppPermissions whose setPermissions()
// returns a chosen success/partial/failure result, instead of spying on the
// class prototype (#6251 review — a prototype spy is a process-global patch
// that can leak into unrelated tests running in the same process).
export type AppPermissionsLike = Pick<AppPermissions, "setPermissions">;

let appPermissionsFactory: (device: BootedDevice) => AppPermissionsLike = (device) =>
  new AppPermissions(device);

export function setAppPermissionsFactory(
  factory: (device: BootedDevice) => AppPermissionsLike,
): void {
  appPermissionsFactory = factory;
}

export function resetAppPermissionsFactory(): void {
  appPermissionsFactory = (device) => new AppPermissions(device);
}

export const setAppPermissionsHandler = async (
  device: BootedDevice,
  args: SetAppPermissionsArgs,
) => {
  const permissions = appPermissionsFactory(device);
  const result = await permissions.setPermissions(args.appId, {
    action: args.action,
    permissions: args.permissions,
    userId: args.userId,
    notificationsEnabled: args.notificationsEnabled,
    notificationPolicyAccess: args.notificationPolicyAccess,
    scheduleExactAlarm: args.scheduleExactAlarm,
  });

  const response = createJSONToolResponse({
    message: result.success
      ? `Applied ${result.changedCount} app permission change(s) for ${args.appId}`
      : (result.error ?? `Failed to apply app permission changes for ${args.appId}`),
    ...result,
  });
  // `result.success` requires every requested change to have applied, so a
  // partial success (some permissions changed, others didn't) already
  // reports per-operation status via `operations`/`changedCount` and may
  // stay isError:false. But when NOTHING applied, the primary operation did
  // not succeed and must be reported as such (#6200, #6251).
  const wholeOperationFailed = !result.success && result.changedCount === 0;
  return wholeOperationFailed ? { ...response, isError: true as const } : response;
};

// Register tools
export function registerAppTools() {
  const listAppsHandler = async (device: BootedDevice, args: ListAppsArgs) => {
    const { toolResponseFormatter, queryInstalledApps: queryApps } = getListAppsToolDependencies();
    try {
      const content = await queryApps({
        deviceId: device.deviceId,
        platform: device.platform,
        type: args.type,
        search: args.search,
        profile: args.profile,
      });

      return toolResponseFormatter.createJSONToolResponse({
        message: `Found ${content.totalCount} app(s) on ${device.deviceId}`,
        ...content,
      });
    } catch (error) {
      throw toActionableError(error, `Failed to list apps for device ${device.deviceId}`);
    }
  };

  // Launch app handler
  const launchAppHandler = async (
    device: BootedDevice,
    args: LaunchAppActionArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    try {
      signal?.throwIfAborted();
      const launchApp = new LaunchApp(device);
      const result = await launchApp.execute(
        args.appId,
        args.clearAppData ?? false,
        args.coldBoot ?? false,
        undefined,
        undefined,
        undefined,
        signal,
      );
      signal?.throwIfAborted();

      return createJSONToolResponse(buildLaunchAppResponse(args.appId, result));
    } catch (error) {
      if (isDeviceLostError(error)) {
        throw error;
      }
      // A typed launch failure (uninstalled package, foreground mismatch) is
      // already an actionable error — surface it verbatim rather than re-wrapping
      // it as "Failed to launch app: Error: ..." (#5868).
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to launch app: ${error}`);
    } finally {
      if (!signal?.aborted) {
        try {
          invalidateInstalledAppResourceCache(device.deviceId);
          await notifyInstalledAppResourceUpdated(device.deviceId);
        } catch (error) {
          logger.warn(`[AppTools] Failed to refresh app resources after launch: ${error}`);
        }
      }
    }
  };

  // Terminate app handler
  const terminateAppHandler = async (device: BootedDevice, args: AppActionArgs) => {
    try {
      const terminateApp = getTerminateAppToolDependencies().createTerminateApp(device);
      const result = await terminateApp.execute(args.appId, {
        skipUiStability: true, // skip the 12+ second stability polling
      });

      // A typed failure (e.g. an iOS installed-app listing that failed, or a
      // devicectl termination error) must surface as an error rather than a
      // response claiming the app was terminated — issue #5621. Mirrors the
      // uninstall handler below.
      if (!result.success) {
        throw new ActionableError(result.error || `Failed to terminate app ${args.appId}`);
      }

      return createJSONToolResponse({
        message: `Terminated app ${args.appId}`,
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to terminate app: ${error}`);
    } finally {
      try {
        invalidateInstalledAppResourceCache(device.deviceId);
        await notifyInstalledAppResourceUpdated(device.deviceId);
      } catch (error) {
        logger.warn(`[AppTools] Failed to refresh app resources after terminate: ${error}`);
      }
    }
  };

  const crashAppHandler = async (
    device: BootedDevice,
    args: CrashAppActionArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    const dependencies = getCrashAppToolDependencies();
    try {
      signal?.throwIfAborted();
      const result = await dependencies.createCrashApp(device).execute(args.appId, signal);
      signal?.throwIfAborted();

      const message = result.success
        ? `Crashed app ${args.appId} via ${result.mechanism}${
            result.confirmed ? " (OS crash confirmed)" : " (confirmation unavailable)"
          }`
        : (result.error ?? `Failed to crash app ${args.appId}`);
      return createStructuredToolResponse({ message, ...result });
    } catch (error) {
      if (isDeviceLostError(error) || error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to crash app: ${error}`);
    } finally {
      dependencies.invalidateAppResourceCache(device.deviceId);
      if (!signal?.aborted) {
        try {
          await dependencies.notifyAppResourceUpdated(device.deviceId);
        } catch (error) {
          logger.warn(`[AppTools] Failed to refresh app resources after crash: ${error}`);
        }
      }
    }
  };

  // Install app handler
  const installAppHandler = async (
    device: BootedDevice,
    args: InstallAppArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    try {
      const installApp = new InstallApp(device);
      const result = await installApp.execute(args.artifactPath, undefined, signal);
      const message = result.warning
        ? `Installed app from ${args.artifactPath}. Warning: ${result.warning}`
        : `Installed app from ${args.artifactPath}`;

      return createJSONToolResponse({
        message,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to install app: ${error}`);
    } finally {
      try {
        invalidateInstalledAppsCache(device.deviceId);
        await notifyInstalledAppResourceUpdated(device.deviceId);
      } catch (error) {
        logger.warn(`[AppTools] Failed to refresh app resources after install: ${error}`);
      }
    }
  };

  // Uninstall app handler
  const uninstallAppHandler = async (
    device: BootedDevice,
    args: UninstallAppArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    try {
      const uninstallApp = new UninstallApp(device);
      const result = await uninstallApp.execute(
        args.appId,
        args.keepData ?? false,
        undefined,
        signal,
      );

      if (!result.success) {
        throw new ActionableError(result.error || `Failed to uninstall app ${args.appId}`);
      }

      const message = result.wasInstalled
        ? `Uninstalled app ${args.appId}${result.keepData ? " (data preserved)" : ""}`
        : `App ${args.appId} was not installed`;

      return createJSONToolResponse({
        message,
        ...result,
      });
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to uninstall app: ${error}`);
    } finally {
      try {
        invalidateInstalledAppsCache(device.deviceId);
        await notifyInstalledAppResourceUpdated(device.deviceId);
      } catch (error) {
        logger.warn(`[AppTools] Failed to refresh app resources after uninstall: ${error}`);
      }
    }
  };

  const getAppPermissionsHandler = async (device: BootedDevice, args: GetAppPermissionsArgs) => {
    const permissions = new AppPermissions(device);
    const result = await permissions.getPermissions(args.appId, {
      permissions: args.permissions,
    });

    return createJSONToolResponse({
      message: result.success
        ? `Read ${result.permissions.length} app permission state row(s) for ${args.appId}`
        : (result.error ?? `Failed to read app permission state for ${args.appId}`),
      ...result,
    });
  };

  const resetKeychainHandler = async (device: BootedDevice, args: ResetKeychainArgs) => {
    // A destructive, device-wide reset must target an explicitly selected device.
    // deviceId/device-label/sessionUuid are the device-bound selectors; if none is
    // present the device was ambiently resolved and the action refuses to run.
    const explicitlyTargeted = Boolean(args.deviceId || args.device || args.sessionUuid);
    const action = new ResetKeychain(device);
    const result = await action.execute({
      appId: args.appId,
      confirm: args.confirm,
      explicitlyTargeted,
    });

    return createJSONToolResponse({ ...result });
  };

  // Register with the tool registry
  ToolRegistry.registerDeviceAware(
    "launchApp",
    "Launch app by package name",
    launchAppSchema,
    launchAppHandler,
    { defaultEnabled: true },
  );

  ToolRegistry.registerDeviceAware(
    "terminateApp",
    "Terminate app by package name",
    terminateAppSchema,
    terminateAppHandler,
    { defaultEnabled: true },
  );

  ToolRegistry.registerDeviceAware(
    "crashApp",
    "Intentionally crash a running app through the platform crash path",
    crashAppSchema,
    crashAppHandler,
    { defaultEnabled: true, outputSchema: crashAppResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "installApp",
    "Install app on device (.apk, .app, or .ipa)",
    installAppSchema,
    installAppHandler,
    { defaultEnabled: true },
  );

  ToolRegistry.registerDeviceAware(
    "uninstallApp",
    "Uninstall app by package name or bundle identifier",
    uninstallAppSchema,
    uninstallAppHandler,
    { defaultEnabled: true },
  );

  ToolRegistry.registerDeviceAware(
    "setAppPermissions",
    "userId grant/revoke; device-wide reset ['all']; no POST_NOTIFICATIONS.",
    setAppPermissionsSchema,
    setAppPermissionsHandler,
    { defaultEnabled: false },
  );

  ToolRegistry.registerDeviceAware(
    "getAppPermissions",
    "Read app permission state",
    getAppPermissionsSchema,
    getAppPermissionsHandler,
    { defaultEnabled: false },
  );

  ToolRegistry.registerDeviceAware(
    "resetKeychain",
    "Reset an app's Keychain/Keystore state (scoped by appId). iOS Simulator resets the WHOLE device Keychain regardless of appId; physical iOS (#5188) and Android (#5190) not yet supported. Requires confirm:true.",
    resetKeychainSchema,
    resetKeychainHandler,
    { defaultEnabled: false },
  );

  ToolRegistry.registerDeviceAware(
    "listApps",
    "List installed apps on a device. Filters by type (default: user), search, and profile.",
    listAppsSchema,
    listAppsHandler,
    {
      defaultEnabled: true,
      // Listing installed apps only needs adb/simctl/devicectl — never CtrlProxy
      // automation — so it should not pay for (or trigger) automation-readiness
      // setup on the target device (#6216 review).
      deviceReadiness: "booted",
    },
  );
}
