import { launchAppResultSchema, terminateAppResultSchema } from "./toolOutputSchemas";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import {
  ActionableError,
  BootedDevice,
  type CrashAppResult,
  type AppLifecycleAction,
  type AppLifecycleResult,
  type LaunchAppResult,
  type TerminateAppResult,
  type InstallAppResult,
} from "../models";
import { toActionableError } from "../models/ActionableError";
import { AppLifecycle, type AppLifecycleExecutionOptions } from "../features/action/AppLifecycle";
import { CrashApp } from "../features/action/CrashApp";
import { LaunchApp } from "../features/action/LaunchApp";
import {
  getLaunchObservationPackageNames,
  isLaunchPermissionDialogObservation,
} from "../features/action/launchObservationPackages";
import { TerminateApp } from "../features/action/TerminateApp";
import { InstallApp, type InstallGuardOptions } from "../features/action/InstallApp";
import { UninstallApp, type UninstallGuardOptions } from "../features/action/UninstallApp";
import { SIGNING_SHA256_PATTERN } from "../utils/signingIdentity";
import { InspectPackageSigning } from "../features/observe/InspectPackageSigning";
import type { PackageSigningInspection } from "../models/PackageSigningInspection";
import type { UninstallAppResult } from "../models/UninstallAppResult";
import { AppPermissions, type SetAppPermissionsResult } from "../features/action/AppPermissions";
import { ResetKeychain } from "../features/action/ResetKeychain";
import { resolveMissingForegroundWindow } from "../features/observe/ObserveScreen";
import {
  withIsErrorOnFailure,
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
  notifyInstalledAppResourceUpdated,
  queryInstalledApps,
  type AppsQueryResourceContent,
  type AppsQueryType,
} from "./appResources";
import { logger } from "../utils/logger";
import { isDeviceLostError } from "./deviceLossOutcome";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { iosMutationTokens } from "../features/storage/IosMutationTokens";
import { OverlayAgentProvider } from "../features/overlay-agent/OverlayAgentProvider";
import { NodeOverlayAgentConnector } from "../features/overlay/ios/overlayAgentClient";
import {
  createOverlayAgentConnect,
  OverlayAgentInjector,
  overlayAgentRegistry,
  portManagerOverlayAgentPorts,
  type OverlayAgentRecord,
  type OverlayAgentRegistry,
  type PreparedOverlayLaunch,
} from "../features/overlay/ios/overlayAgentInjection";
import { SessionReleaseBroadcaster } from "./sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../daemon/streamDeviceLifecycleEvents";
import { defaultTimer } from "../utils/SystemTimer";

export interface InstalledAppResourceRefresh {
  invalidate(deviceId: string): void;
  notify(deviceId: string): Promise<void>;
}

let installedAppResourceRefresh: InstalledAppResourceRefresh = {
  invalidate: invalidateInstalledAppsCache,
  notify: notifyInstalledAppResourceUpdated,
};

export function setInstalledAppResourceRefresh(refresh: InstalledAppResourceRefresh): void {
  installedAppResourceRefresh = refresh;
}

export function resetInstalledAppResourceRefresh(): void {
  installedAppResourceRefresh = {
    invalidate: invalidateInstalledAppsCache,
    notify: notifyInstalledAppResourceUpdated,
  };
}

async function refreshInstalledAppResources(deviceId: string): Promise<void> {
  try {
    installedAppResourceRefresh.invalidate(deviceId);
    await installedAppResourceRefresh.notify(deviceId);
  } catch (error) {
    logger.warn(`[AppTools] Failed to refresh app resources: ${error}`);
  }
}

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

export interface LaunchAppExecutor {
  execute(
    appId: string,
    clearAppData?: boolean,
    coldBoot?: boolean,
    activityName?: string,
    userId?: number,
    skipUiStability?: boolean,
    signal?: AbortSignal,
    launchArguments?: string[],
    launchEnvironment?: Record<string, string>,
  ): Promise<LaunchAppResult>;
}

/** Injects the iOS simulator overlay agent around a launch (#10567). */
export interface OverlayAgentLaunchInjector {
  prepare(device: BootedDevice, bundleId: string): Promise<PreparedOverlayLaunch>;
  attach(prepared: PreparedOverlayLaunch, pid?: number): Promise<OverlayAgentRecord>;
  abort(prepared: PreparedOverlayLaunch): void;
}

// Injection seam for the launchApp handler (mirrors the terminateApp/crashApp
// dependency seams in this file). Lets a unit test exercise the REGISTERED
// handler wiring with a fake LaunchApp, so the already-foreground response shape
// is covered by a test rather than only the response builder (issue #6868).
export interface LaunchAppToolDependencies {
  createLaunchApp(device: BootedDevice): LaunchAppExecutor;
  idGenerator: IdGenerator;
  /** Agent records shared by launchApp, terminateApp and the overlay tool. */
  overlayAgentRegistry: OverlayAgentRegistry;
  /** Created on first `overlay: true`, so a normal launch never resolves the agent dylib. */
  createOverlayAgentInjector(registry: OverlayAgentRegistry): OverlayAgentLaunchInjector;
}

function createDefaultOverlayAgentInjector(registry: OverlayAgentRegistry): OverlayAgentInjector {
  return new OverlayAgentInjector({
    dylibResolver: OverlayAgentProvider.getInstance(),
    ports: portManagerOverlayAgentPorts,
    registry,
    connect: createOverlayAgentConnect(new NodeOverlayAgentConnector(), defaultTimer),
    idGenerator: defaultIdGenerator,
    hostEnv: process.env,
  });
}

let launchAppToolDependencies: LaunchAppToolDependencies | null = null;

function getLaunchAppToolDependencies(): LaunchAppToolDependencies {
  if (!launchAppToolDependencies) {
    launchAppToolDependencies = {
      createLaunchApp: (device) => new LaunchApp(device),
      idGenerator: defaultIdGenerator,
      overlayAgentRegistry,
      createOverlayAgentInjector: createDefaultOverlayAgentInjector,
    };
  }
  return launchAppToolDependencies;
}

export function setLaunchAppToolDependencies(deps: Partial<LaunchAppToolDependencies>): void {
  const currentDeps = getLaunchAppToolDependencies();
  launchAppToolDependencies = {
    createLaunchApp: deps.createLaunchApp ?? currentDeps.createLaunchApp,
    idGenerator: deps.idGenerator ?? currentDeps.idGenerator,
    overlayAgentRegistry: deps.overlayAgentRegistry ?? currentDeps.overlayAgentRegistry,
    createOverlayAgentInjector:
      deps.createOverlayAgentInjector ?? currentDeps.createOverlayAgentInjector,
  };
}

export function resetLaunchAppToolDependencies(): void {
  launchAppToolDependencies = null;
}

export interface TerminateAppExecutor {
  execute(
    appId: string,
    options?: {
      skipUiStability?: boolean;
    },
    signal?: AbortSignal,
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
}

let crashAppToolDependencies: CrashAppToolDependencies | null = null;

function getCrashAppToolDependencies(): CrashAppToolDependencies {
  if (!crashAppToolDependencies) {
    crashAppToolDependencies = {
      createCrashApp: (device) => new CrashApp(device),
    };
  }
  return crashAppToolDependencies;
}

export function setCrashAppToolDependencies(deps: Partial<CrashAppToolDependencies>): void {
  const currentDeps = getCrashAppToolDependencies();
  crashAppToolDependencies = {
    createCrashApp: deps.createCrashApp ?? currentDeps.createCrashApp,
  };
}

export function resetCrashAppToolDependencies(): void {
  crashAppToolDependencies = null;
}

export interface AppLifecycleExecutor {
  execute(
    appId: string,
    action: AppLifecycleAction,
    options?: AppLifecycleExecutionOptions,
  ): Promise<AppLifecycleResult>;
}

export interface AppLifecycleToolDependencies {
  createAppLifecycle(device: BootedDevice): AppLifecycleExecutor;
}

let appLifecycleToolDependencies: AppLifecycleToolDependencies | null = null;

function getAppLifecycleToolDependencies(): AppLifecycleToolDependencies {
  return (appLifecycleToolDependencies ??= {
    createAppLifecycle: (device) => new AppLifecycle(device),
  });
}

export function setAppLifecycleToolDependencies(deps: Partial<AppLifecycleToolDependencies>): void {
  const current = getAppLifecycleToolDependencies();
  appLifecycleToolDependencies = {
    createAppLifecycle: deps.createAppLifecycle ?? current.createAppLifecycle,
  };
}

export function resetAppLifecycleToolDependencies(): void {
  appLifecycleToolDependencies = null;
}

export interface InstallAppExecutor {
  execute(
    artifactPath: string,
    userId?: number,
    signal?: AbortSignal,
    guard?: InstallGuardOptions,
  ): Promise<InstallAppResult>;
}

export interface InstallAppToolDependencies {
  createInstallApp(device: BootedDevice): InstallAppExecutor;
}

export interface UninstallAppExecutor {
  execute(
    appId: string,
    keepData?: boolean,
    userId?: number,
    signal?: AbortSignal,
    guard?: UninstallGuardOptions,
  ): Promise<UninstallAppResult>;
}

export interface UninstallAppToolDependencies {
  createUninstallApp(device: BootedDevice): UninstallAppExecutor;
}

let uninstallAppToolDependencies: UninstallAppToolDependencies | null = null;

function getUninstallAppToolDependencies(): UninstallAppToolDependencies {
  return (uninstallAppToolDependencies ??= {
    createUninstallApp: (device) => new UninstallApp(device),
  });
}

export function setUninstallAppToolDependencies(deps: Partial<UninstallAppToolDependencies>): void {
  uninstallAppToolDependencies = {
    createUninstallApp:
      deps.createUninstallApp ?? getUninstallAppToolDependencies().createUninstallApp,
  };
}

export function resetUninstallAppToolDependencies(): void {
  uninstallAppToolDependencies = null;
}

export interface InspectPackageSigningExecutor {
  execute(
    appId: string,
    options?: { userId?: number; signal?: AbortSignal },
  ): Promise<PackageSigningInspection>;
}

export interface InspectPackageSigningToolDependencies {
  createInspectPackageSigning(device: BootedDevice): InspectPackageSigningExecutor;
}

let inspectPackageSigningToolDependencies: InspectPackageSigningToolDependencies | null = null;

function getInspectPackageSigningToolDependencies(): InspectPackageSigningToolDependencies {
  return (inspectPackageSigningToolDependencies ??= {
    createInspectPackageSigning: (device) => new InspectPackageSigning(device),
  });
}

export function setInspectPackageSigningToolDependencies(
  deps: Partial<InspectPackageSigningToolDependencies>,
): void {
  inspectPackageSigningToolDependencies = {
    createInspectPackageSigning:
      deps.createInspectPackageSigning ??
      getInspectPackageSigningToolDependencies().createInspectPackageSigning,
  };
}

export function resetInspectPackageSigningToolDependencies(): void {
  inspectPackageSigningToolDependencies = null;
}

let installAppToolDependencies: InstallAppToolDependencies | null = null;

function getInstallAppToolDependencies(): InstallAppToolDependencies {
  return (installAppToolDependencies ??= { createInstallApp: (device) => new InstallApp(device) });
}

export function setInstallAppToolDependencies(deps: Partial<InstallAppToolDependencies>): void {
  installAppToolDependencies = {
    createInstallApp: deps.createInstallApp ?? getInstallAppToolDependencies().createInstallApp,
  };
}

export function resetInstallAppToolDependencies(): void {
  installAppToolDependencies = null;
}

/** Report the first identity signal from the shared launch observation resolver. */
function isVerifiedLaunchObservation(
  appId: string,
  observation: LaunchAppResult["observation"],
): boolean {
  const packageNames = getLaunchObservationPackageNames(observation);
  return (
    packageNames.length > 0 &&
    packageNames.every((packageName) => packageName === appId) &&
    observation?.freshness?.isFresh !== false &&
    observation?.freshness?.verified !== false
  );
}

/**
 * Reason a launch could not be verified (issue #6220), for the case where no
 * foreground application window was observed at all, or foreground identity
 * signals conflict with each other or the requested app.
 */
type LaunchVerificationFailureReason =
  | "no_observation"
  | "no_foreground_window"
  | `foreground signals disagree: activeWindow=${string}, hierarchy=${string}`
  | `foreground package ${string} does not match requested ${string}`;

function launchVerificationFailureReason(
  appId: string,
  observedAppId: string | undefined,
  observation: LaunchAppResult["observation"],
): LaunchVerificationFailureReason | undefined {
  if (isLaunchPermissionDialogObservation(observation)) {
    return undefined;
  }
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
  const activeWindowPackage = observation.activeWindow?.appId;
  const hierarchyPackage = observation.viewHierarchy?.packageName;
  if (activeWindowPackage && hierarchyPackage && activeWindowPackage !== hierarchyPackage) {
    return `foreground signals disagree: activeWindow=${activeWindowPackage}, hierarchy=${hierarchyPackage}`;
  }
  if (observedAppId !== appId) {
    return `foreground package ${observedAppId} does not match requested ${appId}`;
  }
  return undefined;
}

function launchVerificationFailureMessage(reason: LaunchVerificationFailureReason): string {
  if (reason === "no_observation") {
    return "no observation was captured after launch";
  }
  if (reason === "no_foreground_window") {
    return "no foreground application window could be observed after launch";
  }
  return reason;
}

function buildTerminateMessage(appId: string, result: TerminateAppResult): string {
  if (result.wasInstalled === false) {
    return `App ${appId} is not installed; nothing to terminate`;
  }
  if (result.wasRunning === false) {
    return `App ${appId} was not running`;
  }
  // Preserve the existing message when the backend cannot establish running state.
  return `Terminated app ${appId}`;
}

function buildLaunchMessage(
  appId: string,
  verified: boolean | undefined,
  verifyFailureReason: LaunchVerificationFailureReason | undefined,
  alreadyForeground: boolean | undefined,
): string {
  // An app that was already foreground was never launched — say so rather than
  // claiming a launch that did not happen (issue #6868). The verification suffix
  // is unchanged: it describes the observed end state either way.
  const lead = alreadyForeground
    ? `App ${appId} was already in the foreground`
    : `Launched app ${appId}`;
  if (verified === true) {
    return `${lead} (foreground verified)`;
  }
  if (verifyFailureReason) {
    return `${lead} (verification failed: ${launchVerificationFailureMessage(verifyFailureReason)})`;
  }
  return lead;
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
 */
/** Report the first reconciled package; verification requires every signal to agree. */
function resolveLaunchObservedAppId(
  observation: LaunchAppResult["observation"],
): string | undefined {
  return getLaunchObservationPackageNames(observation)[0];
}

/**
 * Build the launchApp response from a successful launch result. `verified` is
 * `true` when every reconciled foreground package matches the requested app in
 * a fresh, verified observation. It is `false` with a reason when no foreground
 * window is available, foreground identity signals disagree, or the observed
 * package differs from the requested app. It remains `undefined` for an
 * accepted notification permission surface or matching-but-stale observation,
 * where the surface or freshness prevents confirmation.
 */
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
  // caller that supplies one. Identity conflicts and mismatches are then
  // surfaced as a structured verification failure below.
  const isVerified = isVerifiedLaunchObservation(appId, result.observation);
  const verifyFailureReason = isVerified
    ? undefined
    : launchVerificationFailureReason(appId, observedAppId, result.observation);
  const verified = isVerified ? true : verifyFailureReason ? false : undefined;

  return {
    message: buildLaunchMessage(appId, verified, verifyFailureReason, result.alreadyForeground),
    verified,
    ...(verifyFailureReason ? { verifyFailureReason } : {}),
    observedAppId,
    observation: result.observation,
    ...result,
  };
}

// Schema definitions
// #6613: these app schemas advertised `additionalProperties: false` but were
// not `.strict()`, so an undeclared caller argument (e.g. `installApp{userId}`,
// which this tool does not support) was silently dropped and the call ran
// against the auto-detected user instead of failing. `withAppIdAliases` runs its
// `z.preprocess` alias normalization before these schemas parse, so documented
// aliases still work under strict mode (same precedent as launchApp).
export const packageNameSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
      })
      .strict(),
  ),
);

// terminateApp embeds a post-action observation, so it carries the same
// response-shape control as the other action tools (issue #5886): the embedded
// observation defaults to the compact skeleton, opt-out-able via raw/project.
export const terminateAppSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        ...responseShapeControlFields,
      })
      .strict(),
  ),
);

export const crashAppSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string().trim().min(1),
      })
      .strict(),
  ),
);

export const appLifecycleSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string().trim().min(1),
        action: z.enum(["background", "killBackgrounded"]),
      })
      .strict(),
  ),
);

export const appLifecycleResultSchema = z.object({
  message: z.string(),
  success: z.boolean(),
  supported: z.boolean(),
  action: z.enum(["background", "killBackgrounded"]),
  platform: z.enum(["android", "ios"]),
  appId: z.string(),
  mechanism: z.enum(["home", "am-kill", "unsupported"]),
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
        launchArguments: z
          .array(z.string())
          .optional()
          .describe(
            "Arguments passed to the launched iOS app. Android does not support launch arguments.",
          ),
        overlay: z
          .boolean()
          .optional()
          .describe(
            "iOS simulator only: inject the overlay agent so the overlay tool can draw over this " +
              "app. Always relaunches the app, losing its state. Rejected on physical iOS devices " +
              "(use the in-app SDK), on Android (overlays need no injection) and for com.apple.* apps.",
          ),
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

const expectedSigningSha256Schema = z
  .array(
    z
      .string()
      .regex(
        SIGNING_SHA256_PATTERN,
        "Expected a SHA-256 digest: 64 hex characters, optionally colon-separated",
      ),
  )
  .min(1)
  .max(16);

export const installAppSchema = addDeviceTargetingToSchema(
  z
    .object({
      artifactPath: z.string().describe("App artifact path (.apk, .app, or .ipa)"),
      expectedSigningSha256: expectedSigningSha256Schema
        .optional()
        .describe(
          "Android: complete signer set (SHA-256 of every signing certificate) an already " +
            "installed copy must have before it is replaced; any other signer set, or signers " +
            "that cannot be read, refuses the install. See inspectPackageSigning.",
        ),
      allowDestructiveRecovery: z
        .boolean()
        .optional()
        .describe(
          "Android: false refuses the uninstall-and-reinstall recovery after " +
            "INSTALL_FAILED_VERSION_DOWNGRADE (default true)",
        ),
    })
    .strict(),
);

export const uninstallAppSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        keepData: z
          .boolean()
          .optional()
          .describe("Keep app data after uninstall (Android only, default false)"),
        expectedSigningSha256: expectedSigningSha256Schema
          .optional()
          .describe(
            "Android: complete signer set (SHA-256 of every signing certificate) the installed " +
              "package must have; a different signer set, absence, or signers that cannot be " +
              "read refuses the uninstall, and removal is confirmed by a fresh presence read.",
          ),
      })
      .strict(),
  ),
);

const appPermissionActionSchema = z.enum(["grant", "revoke", "reset"]);

export const setAppPermissionsSchema = withJsonSchemaOverride(
  withAppIdAliases(
    addDeviceTargetingToSchema(
      z
        .object({
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
          notificationPolicyAccess: z
            .boolean()
            .optional()
            .describe("Android: set DND policy access"),
          scheduleExactAlarm: z
            .enum(["allow", "deny"])
            .optional()
            .describe("Android: set SCHEDULE_EXACT_ALARM appop"),
        })
        .strict(),
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
  },
);

export const getAppPermissionsSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        permissions: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional permissions or simulator privacy services to query"),
      })
      .strict(),
  ),
);

export const inspectPackageSigningSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        userId: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Android user/profile to inspect; when omitted it is resolved and reported"),
      })
      .strict(),
  ),
);

export const resetKeychainSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
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
      })
      .strict(),
  ),
);

// #6613: `listApps` advertises `additionalProperties: false` in tools/list, so
// its runtime schema must reject undeclared arguments too. Without `.strict()`
// a call such as `listApps({ appId: "com.example" })` had the unsupported
// filter silently dropped and returned the full unfiltered listing.
export const listAppsSchema = addDeviceTargetingToSchema(
  z
    .object({
      type: z
        .enum(["launchable", "user", "system", "all"])
        .optional()
        .describe(
          "Filter by app type. Defaults to 'launchable': every app with a launcher entry point, " +
            "user-installed or preinstalled, so the apps a human names (Contacts, Clock, Settings) " +
            "are visible while content providers and RRO overlays are not. 'user' and 'system' " +
            "keep their meaning and must be asked for explicitly; 'all' returns every installed " +
            "package. The default degrades to 'user' when the device reports no launchability " +
            "signal, and an explicit 'launchable' is then rejected rather than silently empty. " +
            "On a physical iOS device, where user/system classification is unavailable (devicectl " +
            "reports no such signal), an omitted type returns every app (reported as 'all') and an " +
            "explicit 'user' or 'system' filter is rejected rather than silently honored.",
        ),
      search: z
        .string()
        .optional()
        .describe(
          "Filter by a case-insensitive substring of the package name/bundle id or of the app's " +
            "display label ('contacts' matches both com.android.contacts and an app labelled " +
            "Contacts). Android labels require the installed CtrlProxy APK; without it only the " +
            "package name is matched.",
        ),
      profile: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Filter to apps visible to this user profile id."),
    })
    .strict(),
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
  launchArguments?: string[];
  overlay?: boolean;
  raw?: boolean;
  project?: "full" | "skeleton";
}

function prepareLaunchArguments(
  device: BootedDevice,
  args: LaunchAppActionArgs,
): { launchArguments?: string[]; mutationToken?: string } {
  if (args.launchArguments?.includes("--automobile-mutation-token")) {
    throw new ActionableError("launchArguments contains a reserved argument");
  }
  if (device.platform !== "ios") {
    return { launchArguments: args.launchArguments };
  }

  iosMutationTokens.clear(device.deviceId, args.appId);
  if (!args.launchArguments?.includes("--allow-storage-mutations")) {
    return { launchArguments: args.launchArguments };
  }
  const mutationToken = getLaunchAppToolDependencies().idGenerator.next();
  iosMutationTokens.set(device.deviceId, args.appId, mutationToken);
  return {
    launchArguments: [...args.launchArguments, "--automobile-mutation-token", mutationToken],
    mutationToken,
  };
}

function redactLaunchMessage(message: string, token: string | undefined): string {
  return token ? message.split(token).join("[REDACTED]") : message;
}

function redactLaunchError(error: unknown, token: string | undefined): unknown {
  return token && String(error).includes(token)
    ? new Error(redactLaunchMessage(String(error), token))
    : error;
}

export interface InstallAppArgs {
  artifactPath: string;
  expectedSigningSha256?: string[];
  allowDestructiveRecovery?: boolean;
}

export interface UninstallAppArgs {
  appId: string;
  keepData?: boolean;
  expectedSigningSha256?: string[];
}

export type SetAppPermissionsArgs = z.infer<typeof setAppPermissionsSchema>;

export type InspectPackageSigningArgs = z.infer<typeof inspectPackageSigningSchema>;

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

function describeSetPermissionsSuccess(appId: string, result: SetAppPermissionsResult): string {
  if (result.warnings?.length) {
    return `Applied ${result.changedCount} verified app permission change(s) for ${appId}; not verified: ${result.warnings.join("; ")}`;
  }
  return result.changedCount === 0
    ? `No app permission changes were needed for ${appId} (already in the requested state)`
    : `Applied ${result.changedCount} app permission change(s) for ${appId}`;
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
      ? describeSetPermissionsSuccess(args.appId, result)
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

/**
 * Says which filters were applied and how many apps they hid. The previous
 * message reported only the surviving count, so a default-filtered listing
 * looked like the device's whole inventory and a client had to guess that `type`
 * had other values (#6798). `search` and `profile` narrow the result too, so the
 * hidden count is attributed to every active filter and the `type:"all"` advice
 * is offered only when `type` is the one that actually hid something — advising
 * it after `type:"all", search:"contacts"` would name an already-active filter
 * that cannot restore anything (#6798 review).
 */
export function describeListAppsResult(
  deviceId: string,
  content: Pick<
    AppsQueryResourceContent,
    "totalCount" | "installedCount" | "query" | "launchabilityUnknownProfiles"
  >,
): string {
  const found = `Found ${content.totalCount} app(s) on ${deviceId}`;
  const unknownProfiles = content.launchabilityUnknownProfiles ?? [];
  const unknownNote =
    unknownProfiles.length > 0
      ? ` (launchability is unknown for profile(s) ${unknownProfiles.join(", ")}, so the ` +
        "launchable filter could not judge their apps)"
      : "";
  const hidden = content.installedCount - content.totalCount;
  if (hidden <= 0) {
    return `${found}${unknownNote}`;
  }

  const effectiveType = content.query.type ?? "launchable";
  const typeNarrowed = effectiveType !== "all";
  const activeFilters: string[] = [];
  if (typeNarrowed) {
    activeFilters.push(`type=${effectiveType}`);
  }
  if (content.query.search) {
    activeFilters.push(`search="${content.query.search}"`);
  }
  if (content.query.profile !== undefined) {
    activeFilters.push(`profile=${content.query.profile}`);
  }

  const filterClause = activeFilters.length > 0 ? `${activeFilters.join(", ")}; ` : "";
  // Only actionable when type is the sole narrowing filter: otherwise the
  // remaining filters would still hide those packages.
  const advice =
    typeNarrowed && activeFilters.length === 1 ? ' — pass type:"all" to include them' : "";
  return (
    `${found} (${filterClause}${hidden} of ${content.installedCount} installed package(s) hidden ` +
    `by the active filter(s)${advice})${unknownNote}`
  );
}

const listAppsHandler = async (
  device: BootedDevice,
  args: ListAppsArgs,
  _progress?: unknown,
  signal?: AbortSignal,
) => {
  const { toolResponseFormatter, queryInstalledApps: queryApps } = getListAppsToolDependencies();
  try {
    signal?.throwIfAborted();
    const content = await queryApps(
      {
        deviceId: device.deviceId,
        platform: device.platform,
        type: args.type,
        search: args.search,
        profile: args.profile,
      },
      signal,
    );
    signal?.throwIfAborted();

    return toolResponseFormatter.createJSONToolResponse({
      message: describeListAppsResult(device.deviceId, content),
      ...content,
    });
  } catch (error) {
    throw toActionableError(error, `Failed to list apps for device ${device.deviceId}`);
  }
};

function executeLaunch(
  launchApp: LaunchAppExecutor,
  args: LaunchAppActionArgs,
  launchArguments: string[] | undefined,
  overlay: OverlayLaunch | undefined,
  signal: AbortSignal | undefined,
): Promise<LaunchAppResult> {
  return launchApp.execute(
    args.appId,
    args.clearAppData ?? false,
    // Injection takes effect only in a fresh process.
    (args.coldBoot ?? false) || overlay !== undefined,
    undefined,
    undefined,
    undefined,
    signal,
    launchArguments,
    overlay?.environment,
  );
}

/** Clears the launch's mutation token and returns the error to throw, token redacted. */
function launchFailure(
  error: unknown,
  device: BootedDevice,
  appId: string,
  mutationToken: string | undefined,
): unknown {
  if (mutationToken) {
    iosMutationTokens.clear(device.deviceId, appId, mutationToken);
  }
  const safeError = redactLaunchError(error, mutationToken);
  // A typed launch failure (uninstalled package, foreground mismatch) is
  // already an actionable error — surface it verbatim rather than re-wrapping
  // it as "Failed to launch app: Error: ..." (#5868).
  if (isDeviceLostError(error) || safeError instanceof ActionableError) {
    return safeError;
  }
  return toActionableError(safeError, `Failed to launch app`);
}

// Launch app handler
const launchAppHandler = async (
  device: BootedDevice,
  args: LaunchAppActionArgs,
  _progress?: unknown,
  signal?: AbortSignal,
) => {
  let mutationMayHaveHappened = false;
  let mutationToken: string | undefined;
  const dependencies = getLaunchAppToolDependencies();
  let overlay: OverlayLaunch | undefined;
  try {
    signal?.throwIfAborted();
    overlay = args.overlay ? await beginOverlayLaunch(dependencies, device, args.appId) : undefined;
    signal?.throwIfAborted();
    const prepared = prepareLaunchArguments(device, args);
    mutationToken = prepared.mutationToken;
    const launchApp = dependencies.createLaunchApp(device);
    mutationMayHaveHappened = true;
    const result = await executeLaunch(launchApp, args, prepared.launchArguments, overlay, signal);
    signal?.throwIfAborted();

    const safeResult = result.error
      ? { ...result, error: redactLaunchMessage(result.error, mutationToken) }
      : result;
    const response = buildLaunchAppResponse(args.appId, safeResult);
    return createStructuredToolResponse(
      overlay ? await overlay.attach(response, result.pid) : response,
    );
  } catch (error) {
    overlay?.abort();
    throw launchFailure(error, device, args.appId, mutationToken);
  } finally {
    if (mutationMayHaveHappened) {
      await refreshInstalledAppResources(device.deviceId);
    }
  }
};

/** The agent fields a client may see; the auth token stays in the daemon. */
function describeOverlayAgent(agent: OverlayAgentRecord) {
  return {
    port: agent.port,
    agentVersion: agent.handshake.agentVersion,
    protocolVersion: agent.handshake.protocolVersion,
    capabilities: agent.handshake.capabilities,
  };
}

/** An `overlay: true` launch in progress: its env, then attach on success or abort on failure. */
interface OverlayLaunch {
  environment: Record<string, string>;
  attach<T extends { message: string }>(
    response: T,
    pid?: number,
  ): Promise<T & { overlayAgent: ReturnType<typeof describeOverlayAgent> }>;
  /** Frees the port unless the agent attached; safe to call more than once. */
  abort(): void;
}

async function beginOverlayLaunch(
  dependencies: LaunchAppToolDependencies,
  device: BootedDevice,
  appId: string,
): Promise<OverlayLaunch> {
  const injector = dependencies.createOverlayAgentInjector(dependencies.overlayAgentRegistry);
  const prepared = await injector.prepare(device, appId);
  let settled = false;
  return {
    environment: prepared.environment,
    async attach(response, pid) {
      const agent = await injector.attach(prepared, pid);
      settled = true;
      return {
        ...response,
        message: `${response.message}; overlay agent ${agent.handshake.agentVersion} connected`,
        overlayAgent: describeOverlayAgent(agent),
      };
    },
    abort() {
      if (!settled) {
        settled = true;
        injector.abort(prepared);
      }
    },
  };
}

// Terminate app handler
const terminateAppHandler = async (
  device: BootedDevice,
  args: AppActionArgs,
  _progress?: unknown,
  signal?: AbortSignal,
) => {
  let mutationMayHaveHappened = false;
  try {
    signal?.throwIfAborted();
    if (device.platform === "ios") {
      iosMutationTokens.clear(device.deviceId, args.appId);
    }
    const terminateApp = getTerminateAppToolDependencies().createTerminateApp(device);
    mutationMayHaveHappened = true;
    const result = await terminateApp.execute(
      args.appId,
      {
        skipUiStability: true, // skip the 12+ second stability polling
      },
      signal,
    );

    // A typed failure (e.g. an iOS installed-app listing that failed, or a
    // devicectl termination error) must surface as an error rather than a
    // response claiming the app was terminated — issue #5621. Mirrors the
    // uninstall handler below.
    if (!result.success) {
      throw new ActionableError(result.error || `Failed to terminate app ${args.appId}`);
    }
    if (device.platform === "ios") {
      // Only after a successful termination: a failed one leaves the agent running and reachable.
      getLaunchAppToolDependencies().overlayAgentRegistry.release(device.deviceId, args.appId);
    }

    return createStructuredToolResponse({
      message: buildTerminateMessage(args.appId, result),
      observation: result.observation,
      ...result,
    });
  } catch (error) {
    if (error instanceof ActionableError) {
      throw error;
    }
    throw toActionableError(error, `Failed to terminate app`);
  } finally {
    if (mutationMayHaveHappened) {
      await refreshInstalledAppResources(device.deviceId);
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
  let mutationMayHaveHappened = false;
  try {
    signal?.throwIfAborted();
    mutationMayHaveHappened = true;
    const result = await dependencies.createCrashApp(device).execute(args.appId, signal);
    signal?.throwIfAborted();

    const message = result.success
      ? `Crashed app ${args.appId} via ${result.mechanism}${
          result.confirmed ? " (OS crash confirmed)" : " (confirmation unavailable)"
        }`
      : (result.error ?? `Failed to crash app ${args.appId}`);
    const response = createStructuredToolResponse({ message, ...result });
    return withIsErrorOnFailure(response, result.success);
  } catch (error) {
    if (isDeviceLostError(error) || error instanceof ActionableError) {
      throw error;
    }
    throw toActionableError(error, `Failed to crash app`);
  } finally {
    if (mutationMayHaveHappened) {
      await refreshInstalledAppResources(device.deviceId);
    }
  }
};

const appLifecycleHandler = async (
  device: BootedDevice,
  args: { appId: string; action: AppLifecycleAction },
  _progress?: unknown,
  signal?: AbortSignal,
) => {
  let mutationMayHaveHappened = false;
  try {
    signal?.throwIfAborted();
    const result = await getAppLifecycleToolDependencies()
      .createAppLifecycle(device)
      .execute(args.appId, args.action, {
        signal,
        onMutation: () => {
          mutationMayHaveHappened = true;
        },
      });
    signal?.throwIfAborted();
    const message = result.success
      ? (result.message ??
        (args.action === "background"
          ? `Backgrounded app ${args.appId}`
          : `Completed background kill request for ${args.appId}`))
      : (result.error ?? `Failed to perform appLifecycle ${args.action} for ${args.appId}`);
    const response = createStructuredToolResponse({ ...result, message });
    return withIsErrorOnFailure(response, result.success);
  } catch (error) {
    signal?.throwIfAborted();
    if (isDeviceLostError(error) || error instanceof ActionableError) {
      throw error;
    }
    throw toActionableError(error, "Failed to perform app lifecycle action");
  } finally {
    if (mutationMayHaveHappened) {
      await refreshInstalledAppResources(device.deviceId);
    }
  }
};

function installGuardFromArgs(args: InstallAppArgs): InstallGuardOptions | undefined {
  if (args.expectedSigningSha256 === undefined && args.allowDestructiveRecovery === undefined) {
    return undefined;
  }
  return {
    expectedSigningSha256: args.expectedSigningSha256,
    allowDestructiveRecovery: args.allowDestructiveRecovery,
  };
}

// Install app handler
const installAppHandler = async (
  device: BootedDevice,
  args: InstallAppArgs,
  _progress?: unknown,
  signal?: AbortSignal,
) => {
  let mutationMayHaveHappened = false;
  try {
    signal?.throwIfAborted();
    const installApp = getInstallAppToolDependencies().createInstallApp(device);
    mutationMayHaveHappened = true;
    const guard = installGuardFromArgs(args);
    const result = guard
      ? await installApp.execute(args.artifactPath, undefined, signal, guard)
      : await installApp.execute(args.artifactPath, undefined, signal);
    if (!result.success) {
      throw new ActionableError(result.error || `Failed to install app from ${args.artifactPath}`);
    }
    const message = result.warning
      ? `Installed app from ${args.artifactPath}. Warning: ${result.warning}`
      : `Installed app from ${args.artifactPath}`;

    return createJSONToolResponse({
      message,
      ...result,
    });
  } catch (error) {
    if (error instanceof ActionableError) {
      throw error;
    }
    throw toActionableError(error, `Failed to install app`);
  } finally {
    if (mutationMayHaveHappened) {
      await refreshInstalledAppResources(device.deviceId);
    }
  }
};

/** Passes the guard only when requested so an unguarded call keeps its historical shape. */
function executeUninstall(
  uninstallApp: UninstallAppExecutor,
  args: UninstallAppArgs,
  signal: AbortSignal | undefined,
): Promise<UninstallAppResult> {
  const keepData = args.keepData ?? false;
  const guard: UninstallGuardOptions | undefined = args.expectedSigningSha256
    ? { expectedSigningSha256: args.expectedSigningSha256 }
    : undefined;
  return guard
    ? uninstallApp.execute(args.appId, keepData, undefined, signal, guard)
    : uninstallApp.execute(args.appId, keepData, undefined, signal);
}

// Uninstall app handler
const uninstallAppHandler = async (
  device: BootedDevice,
  args: UninstallAppArgs,
  _progress?: unknown,
  signal?: AbortSignal,
) => {
  let mutationMayHaveHappened = false;
  try {
    signal?.throwIfAborted();
    const uninstallApp = getUninstallAppToolDependencies().createUninstallApp(device);
    mutationMayHaveHappened = true;
    const result = await executeUninstall(uninstallApp, args, signal);

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
    throw toActionableError(error, `Failed to uninstall app`);
  } finally {
    if (mutationMayHaveHappened) {
      await refreshInstalledAppResources(device.deviceId);
    }
  }
};

// Register tools
let unsubscribeOverlayAgentLifecycle: (() => void) | undefined;

/** A released session or a removed device ends every agent recorded on its device. */
function subscribeOverlayAgentLifecycle(): () => void {
  const releaseDevice = (deviceId: string) =>
    getLaunchAppToolDependencies().overlayAgentRegistry.releaseDevice(deviceId);
  const cleanups = [
    SessionReleaseBroadcaster.subscribe((_sessionUuid, _reason, snapshot) => {
      if (snapshot?.deviceId) {
        releaseDevice(snapshot.deviceId);
      }
    }),
    getDaemonStreamDeviceLifecycleEmitter().onDeviceRemoved(releaseDevice),
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}

export function registerAppTools() {
  unsubscribeOverlayAgentLifecycle?.();
  unsubscribeOverlayAgentLifecycle = subscribeOverlayAgentLifecycle();
  const inspectPackageSigningHandler = async (
    device: BootedDevice,
    args: InspectPackageSigningArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    try {
      const inspection = await getInspectPackageSigningToolDependencies()
        .createInspectPackageSigning(device)
        .execute(args.appId, { userId: args.userId, signal });
      return createJSONToolResponse({ ...inspection });
    } catch (error) {
      throw toActionableError(error, "Failed to inspect package signing");
    }
  };

  const getAppPermissionsHandler = async (device: BootedDevice, args: GetAppPermissionsArgs) => {
    const permissions = new AppPermissions(device);
    const result = await permissions.getPermissions(args.appId, {
      permissions: args.permissions,
    });

    const response = createJSONToolResponse({
      message: result.success
        ? `Read ${result.permissions.length} app permission state row(s) for ${args.appId}`
        : (result.error ?? `Failed to read app permission state for ${args.appId}`),
      ...result,
    });
    return withIsErrorOnFailure(response, result.success);
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
    "Launch app by package name. On Android an app that is already in the foreground returns success with alreadyForeground:true plus the observation, not an error; iOS re-launches it and returns an ordinary success without that marker. overlay:true (iOS simulators only) relaunches the app with the overlay agent injected, so its current state is lost.",
    launchAppSchema,
    launchAppHandler,
    { defaultEnabled: true, transportRecovery: "connect", outputSchema: launchAppResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "terminateApp",
    "Terminate app by package name",
    terminateAppSchema,
    terminateAppHandler,
    { defaultEnabled: true, outputSchema: terminateAppResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "crashApp",
    "Intentionally crash a running app through the platform crash path",
    crashAppSchema,
    crashAppHandler,
    { defaultEnabled: true, outputSchema: crashAppResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "appLifecycle",
    "State-preserving background-process kill for saved-state restoration tests.",
    appLifecycleSchema,
    appLifecycleHandler,
    { defaultEnabled: true, outputSchema: appLifecycleResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "installApp",
    "Install app on device (.apk, .app, or .ipa)",
    installAppSchema,
    installAppHandler,
    {
      defaultEnabled: true,
      // Installation is a platform package-manager operation. Requiring
      // accessibility automation here creates a dependency cycle on iOS:
      // a freshly erased/booted simulator cannot install the app because its
      // CtrlProxy runner is still starting, even though simctl install itself
      // does not use CtrlProxy.
      deviceReadiness: "booted",
    },
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
    // Reads only; read-only access never requires a session (#10965).
    { defaultEnabled: false, deviceReadOnly: true },
  );

  ToolRegistry.registerDeviceAware(
    "inspectPackageSigning",
    "Android: fresh read of one package's presence (installed/absent/unknown) for a user and its " +
      "SHA-256 signing certificates (complete signer set, rotation history). Never cached.",
    inspectPackageSigningSchema,
    inspectPackageSigningHandler,
    { defaultEnabled: false, deviceReadiness: "booted", deviceReadOnly: true },
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
    "List installed apps on a device, with optional display label and launchable fields when " +
      "reported by the platform or transport. The label is typically omitted on Android when " +
      "the installed CtrlProxy APK lacks label support; launchable is typically omitted for " +
      "physical iOS/devicectl records. Filters by type (default: launchable — every app with a launcher entry point, " +
      "preinstalled ones included), search (package name or label), and profile.",
    listAppsSchema,
    listAppsHandler,
    {
      defaultEnabled: true,
      // Listing installed apps only needs adb/simctl/devicectl — never CtrlProxy
      // automation — so it should not pay for (or trigger) automation-readiness
      // setup on the target device (#6216 review).
      deviceReadiness: "booted",
      // Reads only; a non-holder watches a held device through the read-only path (#10830).
      deviceReadOnly: true,
    },
  );
}
