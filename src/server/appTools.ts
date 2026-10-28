import { SessionReleaseBroadcaster } from "../daemon/sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../daemon/streamDeviceLifecycleEvents";
import type { ActionCall } from "../features/action/ActionCall";
import { AppLifecycle, type AppLifecycleExecutionOptions } from "../features/action/AppLifecycle";
import { AppPermissions, type SetAppPermissionsResult } from "../features/action/AppPermissions";
import { CrashApp } from "../features/action/CrashApp";
import {
  type AndroidInstallRequest,
  InstallApp,
  type InstallAppCall,
  type InstallGuardOptions,
} from "../features/action/InstallApp";
import { ResetKeychain } from "../features/action/ResetKeychain";
import { TerminateApp, type TerminateAppCall } from "../features/action/TerminateApp";
import {
  UninstallApp,
  type UninstallAppCall,
  type UninstallGuardOptions,
} from "../features/action/UninstallApp";
import { InspectPackageSigning } from "../features/observe/InspectPackageSigning";
import { IosPackageSigningInspector } from "../features/observe/IosPackageSigningInspector";
import { iosMutationTokens } from "../features/storage/IosMutationTokens";
import {
  ActionableError,
  BootedDevice,
  type AppLifecycleAction,
  type AppTrimMemoryLevel,
  type AppLifecycleResult,
  type CrashAppResult,
  type InstallAppResult,
  type TerminateAppResult,
} from "../models";
import { toActionableError } from "../models/ActionableError";
import type {
  IosPackageSigningInspection,
  PackageSigningInspection,
} from "../models/PackageSigningInspection";
import type { UninstallAppResult } from "../models/UninstallAppResult";
import { isDeviceLostError } from "../utils/deviceLossOutcome";
import { logger } from "../utils/logger";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import {
  invalidateInstalledAppsCache,
  notifyInstalledAppResourceUpdated,
  queryInstalledApps,
  type AppsQueryResourceContent,
} from "./appResources";
import {
  appLifecycleResultSchema,
  crashAppResultSchema,
  getAppPermissionsResultSchema,
  inspectPackageSigningResultSchema,
  resetKeychainResultSchema,
  setAppPermissionsResultSchema,
  uninstallAppResultSchema,
} from "./appToolOutputSchemas";
import {
  attachLaunchedViewer,
  beginPrototypeLaunch,
  buildLaunchAppResponse,
  createDefaultLaunchAppToolDependencies,
  executeLaunch,
  type LaunchAppToolDependencies,
  prepareLaunchArguments,
  type PrototypeLaunch,
} from "./appToolsLaunch";
import {
  type AppActionArgs,
  appLifecycleSchema,
  type CrashAppActionArgs,
  crashAppSchema,
  type GetAppPermissionsArgs,
  getAppPermissionsSchema,
  type InspectPackageSigningArgs,
  inspectPackageSigningSchema,
  type InstallAppArgs,
  installAppTool,
  type LaunchAppActionArgs,
  launchAppSchema,
  type ListAppsArgs,
  listAppsTool,
  type ResetKeychainArgs,
  resetKeychainSchema,
  type SetAppPermissionsArgs,
  setAppPermissionsSchema,
  terminateAppSchema,
  type UninstallAppArgs,
  uninstallAppSchema,
} from "./appToolsSchemas";
import { launchFailure, redactLaunchMessage } from "./launchAppFailure";
import { launchAppResultSchema, terminateAppResultSchema } from "./toolOutputSchemas";
import { ToolRegistry } from "./toolRegistry";
import { PLAN_RELEVANT, PLAN_SKELETON } from "./toolRegistryTypes";
export {
  buildLaunchAppResponse,
  type LaunchAppExecutor,
  type LaunchAppToolDependencies,
  type PrototypeAgentLaunchInjector,
} from "./appToolsLaunch";
export {
  type AppActionArgs,
  appLifecycleSchema,
  type CrashAppActionArgs,
  crashAppSchema,
  type GetAppPermissionsArgs,
  getAppPermissionsSchema,
  type InspectPackageSigningArgs,
  inspectPackageSigningSchema,
  installAppSchema,
  installAppTool,
  type LaunchAppActionArgs,
  launchAppSchema,
  listAppsSchema,
  listAppsTool,
  packageNameSchema,
  type ResetKeychainArgs,
  resetKeychainSchema,
  type SetAppPermissionsArgs,
  setAppPermissionsSchema,
  terminateAppSchema,
  type UninstallAppArgs,
  uninstallAppSchema,
} from "./appToolsSchemas";

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
  queryInstalledApps: typeof queryInstalledApps;
}

const createDefaultListAppsToolDependencies = (): ListAppsToolDependencies => ({
  queryInstalledApps,
});

export interface TerminateAppExecutor {
  execute(appId: string, call?: TerminateAppCall): Promise<TerminateAppResult>;
}

export interface TerminateAppToolDependencies {
  createTerminateApp(device: BootedDevice): TerminateAppExecutor;
}

const defaultTerminateAppToolDependencies: TerminateAppToolDependencies = {
  createTerminateApp: (device) => new TerminateApp(device),
};

export interface CrashAppExecutor {
  execute(appId: string, call?: ActionCall): Promise<CrashAppResult>;
}

export interface CrashAppToolDependencies {
  createCrashApp(device: BootedDevice): CrashAppExecutor;
}

const defaultCrashAppToolDependencies: CrashAppToolDependencies = {
  createCrashApp: (device) => new CrashApp(device),
};

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

const defaultAppLifecycleToolDependencies: AppLifecycleToolDependencies = {
  createAppLifecycle: (device) => new AppLifecycle(device),
};

export interface InstallAppExecutor {
  execute(artifactPath: string, call?: InstallAppCall): Promise<InstallAppResult>;
}

export interface InstallAppToolDependencies {
  createInstallApp(device: BootedDevice): InstallAppExecutor;
}

export interface UninstallAppExecutor {
  execute(appId: string, call?: UninstallAppCall): Promise<UninstallAppResult>;
}

export interface UninstallAppToolDependencies {
  createUninstallApp(device: BootedDevice): UninstallAppExecutor;
}

const defaultUninstallAppToolDependencies: UninstallAppToolDependencies = {
  createUninstallApp: (device) => new UninstallApp(device),
};

export interface InspectPackageSigningExecutor {
  execute(
    appId: string,
    options?: { userId?: number; signal?: AbortSignal },
  ): Promise<PackageSigningInspection | IosPackageSigningInspection>;
}

export interface InspectPackageSigningToolDependencies {
  createInspectPackageSigning(device: BootedDevice): InspectPackageSigningExecutor;
}

const defaultInspectPackageSigningToolDependencies: InspectPackageSigningToolDependencies = {
  createInspectPackageSigning: (device) =>
    device.platform === "ios"
      ? new IosPackageSigningInspector(device)
      : new InspectPackageSigning(device),
};

const defaultInstallAppToolDependencies: InstallAppToolDependencies = {
  createInstallApp: (device) => new InstallApp(device),
};

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

// Injection seam for the setAppPermissions handler (mirrors the tapAny
// factory seam in interactionTools.ts). Lets a unit test exercise the
// registered handler wiring with a fake AppPermissions whose setPermissions()
// returns a chosen success/partial/failure result, instead of spying on the
// class prototype (#6251 review — a prototype spy is a process-global patch
// that can leak into unrelated tests running in the same process).
export type AppPermissionsLike = Pick<AppPermissions, "setPermissions">;

export type AppPermissionsFactory = (device: BootedDevice) => AppPermissionsLike;

const defaultAppPermissionsFactory: AppPermissionsFactory = (device) => new AppPermissions(device);

function describeSetPermissionsSuccess(appId: string, result: SetAppPermissionsResult): string {
  const applied = describeAppliedPermissions(appId, result);
  const diagnostics = result.diagnostics?.map((diagnostic) => diagnostic.message) ?? [];
  return diagnostics.length > 0 ? `${applied}. Warning: ${diagnostics.join(" ")}` : applied;
}

function describeAppliedPermissions(appId: string, result: SetAppPermissionsResult): string {
  if (result.warnings?.length) {
    return `Applied ${result.changedCount} verified app permission change(s) for ${appId}; not verified: ${result.warnings.join("; ")}`;
  }
  return result.changedCount === 0
    ? `No app permission changes were needed for ${appId} (already in the requested state)`
    : `Applied ${result.changedCount} app permission change(s) for ${appId}`;
}

export const createSetAppPermissionsHandler =
  (permissionsFactory: AppPermissionsFactory = defaultAppPermissionsFactory) =>
  async (device: BootedDevice, args: SetAppPermissionsArgs) => {
    const permissions = permissionsFactory(device);
    const result = await permissions.setPermissions(args.appId, {
      action: args.action,
      permissions: args.permissions,
      userId: args.userId,
      notificationsEnabled: args.notificationsEnabled,
      notificationPolicyAccess: args.notificationPolicyAccess,
      scheduleExactAlarm: args.scheduleExactAlarm,
    });

    const response = createStructuredToolResponse({
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

const createListAppsHandler =
  ({ queryInstalledApps: queryApps }: ListAppsToolDependencies) =>
  async (device: BootedDevice, args: ListAppsArgs, _progress?: unknown, signal?: AbortSignal) => {
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

      return createStructuredToolResponse({
        message: describeListAppsResult(device.deviceId, content),
        ...content,
      });
    } catch (error) {
      throw toActionableError(error, `Failed to list apps for device ${device.deviceId}`);
    }
  };

// Launch app handler
const createLaunchAppHandler =
  (dependencies: LaunchAppToolDependencies) =>
  async (
    device: BootedDevice,
    args: LaunchAppActionArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    let mutationMayHaveHappened = false;
    let mutationToken: string | undefined;
    let prototypeLaunch: PrototypeLaunch | undefined;
    try {
      signal?.throwIfAborted();
      prototypeLaunch = args.prototype
        ? await beginPrototypeLaunch(dependencies, device, args.appId)
        : undefined;
      signal?.throwIfAborted();
      const prepared = prepareLaunchArguments(device, args, dependencies.idGenerator);
      mutationToken = prepared.mutationToken;
      const launchApp = dependencies.createLaunchApp(device);
      mutationMayHaveHappened = true;
      const result = await executeLaunch(
        launchApp,
        args,
        prepared.launchArguments,
        prototypeLaunch,
        signal,
      );
      signal?.throwIfAborted();

      const safeResult = result.error
        ? { ...result, error: redactLaunchMessage(result.error, mutationToken) }
        : result;
      const response = buildLaunchAppResponse(args.appId, safeResult);
      await attachLaunchedViewer(
        dependencies.prototypeViewerAttacher,
        dependencies.timer,
        device,
        args,
      );
      return createStructuredToolResponse(
        prototypeLaunch ? await prototypeLaunch.attach(response, result.pid) : response,
      );
    } catch (error) {
      prototypeLaunch?.abort();
      throw launchFailure(error, device, args.appId, mutationToken);
    } finally {
      if (mutationMayHaveHappened) {
        await refreshInstalledAppResources(device.deviceId);
      }
    }
  };

// Terminate app handler
const createTerminateAppHandler =
  (
    dependencies: TerminateAppToolDependencies,
    launchDependencies: Pick<
      LaunchAppToolDependencies,
      "prototypeAgentRegistry" | "prototypeViewerConnections"
    >,
  ) =>
  async (device: BootedDevice, args: AppActionArgs, _progress?: unknown, signal?: AbortSignal) => {
    let mutationMayHaveHappened = false;
    try {
      signal?.throwIfAborted();
      if (device.platform === "ios") {
        iosMutationTokens.clear(device.deviceId, args.appId);
      }
      const terminateApp = dependencies.createTerminateApp(device);
      mutationMayHaveHappened = true;
      const result = await terminateApp.execute(args.appId, {
        skipUiStability: true, // skip the 12+ second stability polling
        signal,
      });

      // A typed failure (e.g. an iOS installed-app listing that failed, or a
      // devicectl termination error) must surface as an error rather than a
      // response claiming the app was terminated — issue #5621. Mirrors the
      // uninstall handler below.
      if (!result.success) {
        throw new ActionableError(result.error || `Failed to terminate app ${args.appId}`);
      }
      if (device.platform === "ios") {
        // Only after a successful termination: a failed one leaves the agent running and reachable.
        launchDependencies.prototypeAgentRegistry.release(device.deviceId, args.appId);
        launchDependencies.prototypeViewerConnections.release(device.deviceId, args.appId);
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

const createCrashAppHandler =
  (dependencies: CrashAppToolDependencies) =>
  async (
    device: BootedDevice,
    args: CrashAppActionArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    let mutationMayHaveHappened = false;
    try {
      signal?.throwIfAborted();
      mutationMayHaveHappened = true;
      const result = await dependencies.createCrashApp(device).execute(args.appId, { signal });
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

const createAppLifecycleHandler =
  (dependencies: AppLifecycleToolDependencies) =>
  async (
    device: BootedDevice,
    args: { appId: string; action: AppLifecycleAction; level?: AppTrimMemoryLevel },
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    let mutationMayHaveHappened = false;
    try {
      signal?.throwIfAborted();
      const result = await dependencies
        .createAppLifecycle(device)
        .execute(args.appId, args.action, {
          signal,
          trimLevel: args.level,
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

/** Android-only install inputs, passed only when requested so a plain call keeps its shape. */
function androidInstallRequestFromArgs(args: InstallAppArgs): AndroidInstallRequest | undefined {
  const { splits, bundle, grantAllPermissions, allowDowngrade } = args;
  const request = { splits, bundle, grantAllPermissions, allowDowngrade };
  return Object.values(request).some((value) => value !== undefined) ? request : undefined;
}

// Install app handler
const createInstallAppHandler =
  (dependencies: InstallAppToolDependencies) =>
  async (device: BootedDevice, args: InstallAppArgs, _progress?: unknown, signal?: AbortSignal) => {
    let mutationMayHaveHappened = false;
    try {
      signal?.throwIfAborted();
      const installApp = dependencies.createInstallApp(device);
      mutationMayHaveHappened = true;
      const guard = installGuardFromArgs(args);
      const android = androidInstallRequestFromArgs(args);
      const result = await installApp.execute(args.artifactPath, {
        signal,
        guard,
        ...(android ? { android } : {}),
      });
      if (!result.success) {
        throw new ActionableError(
          result.error || `Failed to install app from ${args.artifactPath}`,
        );
      }
      const message = result.warning
        ? `Installed app from ${args.artifactPath}. Warning: ${result.warning}`
        : `Installed app from ${args.artifactPath}`;

      return createStructuredToolResponse({
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
  return uninstallApp.execute(args.appId, { keepData, signal, guard });
}

// Uninstall app handler
const createUninstallAppHandler =
  (dependencies: UninstallAppToolDependencies) =>
  async (
    device: BootedDevice,
    args: UninstallAppArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    let mutationMayHaveHappened = false;
    try {
      signal?.throwIfAborted();
      const uninstallApp = dependencies.createUninstallApp(device);
      mutationMayHaveHappened = true;
      const result = await executeUninstall(uninstallApp, args, signal);

      if (!result.success) {
        throw new ActionableError(result.error || `Failed to uninstall app ${args.appId}`);
      }

      const message = result.wasInstalled
        ? `Uninstalled app ${args.appId}${result.keepData ? " (data preserved)" : ""}`
        : `App ${args.appId} was not installed`;

      return createStructuredToolResponse({
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
let unsubscribePrototypeAgentLifecycle: (() => void) | undefined;

/** A released session or a removed device ends every agent recorded on its device. */
function subscribePrototypeAgentLifecycle(
  dependencies: Pick<
    LaunchAppToolDependencies,
    "prototypeAgentRegistry" | "prototypeViewerConnections"
  >,
): () => void {
  const releaseDevice = (deviceId: string) => {
    dependencies.prototypeAgentRegistry.releaseDevice(deviceId);
    dependencies.prototypeViewerConnections.releaseDevice(deviceId);
  };
  const cleanups = [
    SessionReleaseBroadcaster.subscribe((_sessionUuid, _reason, snapshot, extras) => {
      // An upgrade-only re-announcement's device may belong to its next owner by now (#11206).
      if (snapshot?.deviceId && !extras?.upgradeOnly) {
        releaseDevice(snapshot.deviceId);
      }
    }),
    getDaemonStreamDeviceLifecycleEmitter().onDeviceRemoved(releaseDevice),
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}

/** Overrides for the collaborators `registerAppTools` wires into its handlers (tests, embedders). */
export interface AppToolsDependencies {
  listApps?: Partial<ListAppsToolDependencies>;
  launchApp?: Partial<LaunchAppToolDependencies>;
  terminateApp?: Partial<TerminateAppToolDependencies>;
  uninstallApp?: Partial<UninstallAppToolDependencies>;
  installApp?: Partial<InstallAppToolDependencies>;
  crashApp?: Partial<CrashAppToolDependencies>;
  appLifecycle?: Partial<AppLifecycleToolDependencies>;
  inspectPackageSigning?: Partial<InspectPackageSigningToolDependencies>;
  appPermissionsFactory?: AppPermissionsFactory;
}

/** Builds every injectable handler from real defaults overlaid with `dependencies`. */
function createAppToolHandlers(dependencies: AppToolsDependencies) {
  const listAppsHandler = createListAppsHandler({
    ...createDefaultListAppsToolDependencies(),
    ...dependencies.listApps,
  });
  const launchAppDependencies: LaunchAppToolDependencies = {
    ...createDefaultLaunchAppToolDependencies(),
    ...dependencies.launchApp,
  };
  const launchAppHandler = createLaunchAppHandler(launchAppDependencies);
  const terminateAppHandler = createTerminateAppHandler(
    { ...defaultTerminateAppToolDependencies, ...dependencies.terminateApp },
    launchAppDependencies,
  );
  const uninstallAppHandler = createUninstallAppHandler({
    ...defaultUninstallAppToolDependencies,
    ...dependencies.uninstallApp,
  });
  const installAppHandler = createInstallAppHandler({
    ...defaultInstallAppToolDependencies,
    ...dependencies.installApp,
  });
  const crashAppHandler = createCrashAppHandler({
    ...defaultCrashAppToolDependencies,
    ...dependencies.crashApp,
  });
  const appLifecycleHandler = createAppLifecycleHandler({
    ...defaultAppLifecycleToolDependencies,
    ...dependencies.appLifecycle,
  });
  const inspectPackageSigningToolDependencies: InspectPackageSigningToolDependencies = {
    ...defaultInspectPackageSigningToolDependencies,
    ...dependencies.inspectPackageSigning,
  };
  const setAppPermissionsHandler = createSetAppPermissionsHandler(
    dependencies.appPermissionsFactory,
  );
  return {
    listAppsHandler,
    launchAppDependencies,
    launchAppHandler,
    terminateAppHandler,
    uninstallAppHandler,
    installAppHandler,
    crashAppHandler,
    appLifecycleHandler,
    inspectPackageSigningToolDependencies,
    setAppPermissionsHandler,
  };
}

export function registerAppTools(dependencies: AppToolsDependencies = {}) {
  const {
    listAppsHandler,
    launchAppDependencies,
    launchAppHandler,
    terminateAppHandler,
    uninstallAppHandler,
    installAppHandler,
    crashAppHandler,
    appLifecycleHandler,
    inspectPackageSigningToolDependencies,
    setAppPermissionsHandler,
  } = createAppToolHandlers(dependencies);
  unsubscribePrototypeAgentLifecycle?.();
  unsubscribePrototypeAgentLifecycle = subscribePrototypeAgentLifecycle(launchAppDependencies);
  const inspectPackageSigningHandler = async (
    device: BootedDevice,
    args: InspectPackageSigningArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    try {
      const inspection = await inspectPackageSigningToolDependencies
        .createInspectPackageSigning(device)
        .execute(args.appId, { userId: args.userId, signal });
      return createStructuredToolResponse({ ...inspection });
    } catch (error) {
      throw toActionableError(error, "Failed to inspect package signing");
    }
  };

  const getAppPermissionsHandler = async (device: BootedDevice, args: GetAppPermissionsArgs) => {
    const permissions = new AppPermissions(device);
    const result = await permissions.getPermissions(args.appId, {
      permissions: args.permissions,
    });

    const response = createStructuredToolResponse({
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

    return createStructuredToolResponse({ ...result });
  };

  // Register with the tool registry
  ToolRegistry.registerDeviceAware(
    "launchApp",
    "Launch app by package name. On Android an app that is already in the foreground returns success with alreadyForeground:true plus the observation, not an error; iOS re-launches it and returns an ordinary success without that marker. prototype:true (iOS simulators only) relaunches the app with the prototype agent injected, so its current state is lost.",
    launchAppSchema,
    launchAppHandler,
    {
      defaultEnabled: true,
      transportRecovery: "connect",
      outputSchema: launchAppResultSchema,
      ...PLAN_SKELETON,
    },
  );

  ToolRegistry.registerDeviceAware(
    "terminateApp",
    "Terminate app by package name",
    terminateAppSchema,
    terminateAppHandler,
    {
      defaultEnabled: true,
      outputSchema: terminateAppResultSchema,
      stopsApp: true,
      ...PLAN_SKELETON,
    },
  );

  ToolRegistry.registerDeviceAware(
    "crashApp",
    "Intentionally crash a running app through the platform crash path",
    crashAppSchema,
    crashAppHandler,
    { ...PLAN_RELEVANT, defaultEnabled: true, outputSchema: crashAppResultSchema, stopsApp: true },
  );

  ToolRegistry.registerDeviceAware(
    "appLifecycle",
    "State-preserving background-process kill for saved-state restoration tests (background, killBackgrounded; iOS kills with SIGKILL after Home); trimMemory (Android only) sends onTrimMemory(level) to the running app without killing it.",
    appLifecycleSchema,
    appLifecycleHandler,
    { ...PLAN_RELEVANT, defaultEnabled: true, outputSchema: appLifecycleResultSchema },
  );

  installAppTool.register(ToolRegistry, installAppHandler);

  ToolRegistry.registerDeviceAware(
    "uninstallApp",
    "Uninstall app by package name or bundle identifier",
    uninstallAppSchema,
    uninstallAppHandler,
    { defaultEnabled: true, outputSchema: uninstallAppResultSchema, stopsApp: true },
  );

  ToolRegistry.registerDeviceAware(
    "setAppPermissions",
    "userId grant/revoke; device-wide reset ['all']; no POST_NOTIFICATIONS.",
    setAppPermissionsSchema,
    setAppPermissionsHandler,
    { ...PLAN_RELEVANT, defaultEnabled: false, outputSchema: setAppPermissionsResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "getAppPermissions",
    "Read app permission state",
    getAppPermissionsSchema,
    getAppPermissionsHandler,
    // Reads only; read-only access never requires a session (#10965).
    { defaultEnabled: false, deviceReadOnly: true, outputSchema: getAppPermissionsResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "inspectPackageSigning",
    "Fresh read of one app's presence (installed/absent/unknown) and signing. Android: a user's " +
      "SHA-256 signer set and rotation history. iOS Simulator and physical: team, signing " +
      "identity, CDHash, entitlements and embedded provisioning profile (expiry, UUID). Never cached.",
    inspectPackageSigningSchema,
    inspectPackageSigningHandler,
    {
      defaultEnabled: false,
      deviceReadiness: "booted",
      deviceReadOnly: true,
      outputSchema: inspectPackageSigningResultSchema,
    },
  );

  ToolRegistry.registerDeviceAware(
    "resetKeychain",
    "Reset an app's Keychain/Keystore state (scoped by appId). iOS Simulator resets the WHOLE device Keychain regardless of appId; physical iOS (#5188) and Android (#5190) not yet supported. Requires confirm:true.",
    resetKeychainSchema,
    resetKeychainHandler,
    { ...PLAN_RELEVANT, defaultEnabled: false, outputSchema: resetKeychainResultSchema },
  );

  listAppsTool.register(ToolRegistry, listAppsHandler);
}
