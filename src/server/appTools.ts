import { z } from "zod";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models";
import { LaunchApp } from "../features/action/LaunchApp";
import { TerminateApp } from "../features/action/TerminateApp";
import { InstallApp } from "../features/action/InstallApp";
import { UninstallApp } from "../features/action/UninstallApp";
import { GrantIosSimulatorPermissions } from "../features/action/GrantIosSimulatorPermissions";
import { IosSimulatorPermissions, type IosSimulatorPermissionAction } from "../features/action/IosSimulatorPermissions";
import { createJSONToolResponse, DefaultToolResponseFormatter, ToolResponseFormatter } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import {
  APPS_RESOURCE_URIS,
  APP_RESOURCE_TEMPLATES,
  invalidateInstalledAppsCache,
  notifyInstalledAppResourceUpdated
} from "./appResources";
import { logger } from "../utils/logger";

export interface ListAppsToolDependencies {
  toolResponseFormatter: ToolResponseFormatter;
}

let listAppsToolDependencies: ListAppsToolDependencies | null = null;

function getListAppsToolDependencies(): ListAppsToolDependencies {
  if (!listAppsToolDependencies) {
    listAppsToolDependencies = {
      toolResponseFormatter: new DefaultToolResponseFormatter()
    };
  }
  return listAppsToolDependencies;
}

export function setListAppsToolDependencies(deps: Partial<ListAppsToolDependencies>): void {
  const currentDeps = getListAppsToolDependencies();
  listAppsToolDependencies = {
    toolResponseFormatter: deps.toolResponseFormatter ?? currentDeps.toolResponseFormatter
  };
}

export function resetListAppsToolDependencies(): void {
  listAppsToolDependencies = null;
}

// Schema definitions
export const packageNameSchema = addDeviceTargetingToSchema(z.object({
  appId: z.string().describe("App package ID"),
}));

export const launchAppSchema = addDeviceTargetingToSchema(z.object({
  appId: z.string().describe("App package ID"),
  clearAppData: z.boolean().optional().describe("Clear app data before launch (default false)"),
  coldBoot: z.boolean().optional().describe("Cold boot app (default false)"),
}));

export const installAppSchema = addDeviceTargetingToSchema(z.object({
  artifactPath: z.string().describe("Path to app artifact (.apk for Android, .app bundle for iOS simulator, .ipa for iOS physical device)"),
}));

export const uninstallAppSchema = addDeviceTargetingToSchema(z.object({
  appId: z.string().describe("App package ID or bundle identifier to uninstall"),
  keepData: z.boolean().optional().describe("Keep app data after uninstall (Android only, default false)"),
}));

export const listAppsSchema = z.object({}).passthrough();

export const grantIosSimulatorPermissionsSchema = addDeviceTargetingToSchema(z.object({
  appId: z.string().describe("iOS app bundle identifier"),
  permissions: z.array(z.string().min(1))
    .min(1)
    .describe("simctl privacy services to grant, for example: camera, microphone, photos, contacts, location, userTracking"),
}));

export const setIosSimulatorPermissionsSchema = addDeviceTargetingToSchema(z.object({
  appId: z.string().describe("iOS app bundle identifier"),
  action: z.enum(["grant", "revoke", "reset"]).describe("Permission action to apply via simctl privacy"),
  permissions: z.array(z.string().min(1))
    .min(1)
    .describe("simctl privacy services to change, for example: camera, microphone, photos, contacts, location, all"),
}));

export const getIosSimulatorPermissionsSchema = addDeviceTargetingToSchema(z.object({
  appId: z.string().describe("iOS app bundle identifier"),
  permissions: z.array(z.string().min(1))
    .optional()
    .describe("Optional simctl privacy services to query. If omitted, returns all TCC rows for the app."),
}));

// Export interfaces for type safety
export interface AppActionArgs {
  appId: string;
}

export interface LaunchAppActionArgs {
  appId: string;
  clearAppData?: boolean;
  coldBoot?: boolean;
}

export interface InstallAppArgs {
  artifactPath: string;
}

export interface UninstallAppArgs {
  appId: string;
  keepData?: boolean;
}

export interface GrantIosSimulatorPermissionsArgs {
  appId: string;
  permissions: string[];
}

export interface SetIosSimulatorPermissionsArgs {
  appId: string;
  action: IosSimulatorPermissionAction;
  permissions: string[];
}

export interface GetIosSimulatorPermissionsArgs {
  appId: string;
  permissions?: string[];
}

// Register tools
export function registerAppTools(
) {
  const listAppsHandler = async () => {
    const { toolResponseFormatter } = getListAppsToolDependencies();
    return toolResponseFormatter.createJSONToolResponse({
      message: "To list installed apps, follow this workflow:\n\n" +
        "1. Get available devices:\n" +
        "   Read resource: automobile:devices/booted\n\n" +
        "2. List apps for a specific device (using deviceId from step 1):\n" +
        "   Read resource: automobile:devices/{deviceId}/apps\n" +
        "   Or query format: automobile:apps?deviceId={deviceId}\n\n" +
        "Optional query filters:\n" +
        "  - type=user|system (default: user)\n" +
        "  - search=<term> (filter by package name)\n" +
        "  - profile=<userId> (filter by user profile)\n\n" +
        "Example: automobile:apps?deviceId=emulator-5554&type=system&search=google",
      resources: [
        "automobile:devices/booted",
        APP_RESOURCE_TEMPLATES.DEVICE_APPS,
        APPS_RESOURCE_URIS.BASE + "?deviceId={deviceId}"
      ],
      note: "All resource URIs use the 'automobile:' prefix. URIs like 'android://apps' are not supported."
    });
  };

  // Launch app handler
  const launchAppHandler = async (device: BootedDevice, args: LaunchAppActionArgs) => {
    try {
      const launchApp = new LaunchApp(device);
      const result = await launchApp.execute(
        args.appId,
        args.clearAppData ?? false,
        args.coldBoot ?? false
      );

      return createJSONToolResponse({
        message: `Launched app ${args.appId}`,
        observation: result.observation,
        ...result
      });
    } catch (error) {
      throw new ActionableError(`Failed to launch app: ${error}`);
    } finally {
      try {
        invalidateInstalledAppsCache(device.deviceId);
        await notifyInstalledAppResourceUpdated(device.deviceId);
      } catch (error) {
        logger.warn(`[AppTools] Failed to refresh app resources after launch: ${error}`);
      }
    }
  };

  // Terminate app handler
  const terminateAppHandler = async (device: BootedDevice, args: AppActionArgs) => {
    try {
      const terminateApp = new TerminateApp(device);
      const result = await terminateApp.execute(args.appId, {
        skipUiStability: true // skip the 12+ second stability polling
      });

      return createJSONToolResponse({
        message: `Terminated app ${args.appId}`,
        observation: result.observation,
        ...result
      });
    } catch (error) {
      throw new ActionableError(`Failed to terminate app: ${error}`);
    } finally {
      try {
        invalidateInstalledAppsCache(device.deviceId);
        await notifyInstalledAppResourceUpdated(device.deviceId);
      } catch (error) {
        logger.warn(`[AppTools] Failed to refresh app resources after terminate: ${error}`);
      }
    }
  };

  // Install app handler
  const installAppHandler = async (device: BootedDevice, args: InstallAppArgs, _progress?: unknown, signal?: AbortSignal) => {
    try {
      const installApp = new InstallApp(device);
      const result = await installApp.execute(args.artifactPath, undefined, signal);
      const message = result.warning
        ? `Installed app from ${args.artifactPath}. Warning: ${result.warning}`
        : `Installed app from ${args.artifactPath}`;

      return createJSONToolResponse({
        message,
        ...result
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
  const uninstallAppHandler = async (device: BootedDevice, args: UninstallAppArgs) => {
    try {
      const uninstallApp = new UninstallApp(device);
      const result = await uninstallApp.execute(args.appId, args.keepData ?? false);

      if (!result.success) {
        throw new ActionableError(result.error || `Failed to uninstall app ${args.appId}`);
      }

      const message = result.wasInstalled
        ? `Uninstalled app ${args.appId}${result.keepData ? " (data preserved)" : ""}`
        : `App ${args.appId} was not installed`;

      return createJSONToolResponse({
        message,
        ...result
      });
    } catch (error) {
      if (error instanceof ActionableError) {throw error;}
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

  const grantIosSimulatorPermissionsHandler = async (
    device: BootedDevice,
    args: GrantIosSimulatorPermissionsArgs
  ) => {
    const grantPermissions = new GrantIosSimulatorPermissions(device);
    const result = await grantPermissions.execute(args.appId, args.permissions);

    return createJSONToolResponse({
      message: result.success
        ? `Granted ${result.grantedCount} iOS simulator permission(s) to ${args.appId}`
        : result.error ?? `Failed to grant ${result.failedCount} iOS simulator permission(s) to ${args.appId}`,
      ...result
    });
  };

  const setIosSimulatorPermissionsHandler = async (
    device: BootedDevice,
    args: SetIosSimulatorPermissionsArgs
  ) => {
    const permissions = new IosSimulatorPermissions(device);
    const result = await permissions.setPermissions(args.action, args.appId, args.permissions);

    return createJSONToolResponse({
      message: result.success
        ? `${args.action} applied to ${result.changedCount} iOS simulator permission(s) for ${args.appId}`
        : result.error ?? `Failed to ${args.action} ${result.failedCount} iOS simulator permission(s) for ${args.appId}`,
      ...result
    });
  };

  const getIosSimulatorPermissionsHandler = async (
    device: BootedDevice,
    args: GetIosSimulatorPermissionsArgs
  ) => {
    const permissions = new IosSimulatorPermissions(device);
    const result = await permissions.getPermissions(args.appId, args.permissions);

    return createJSONToolResponse({
      message: result.success
        ? `Read ${result.permissions.length} iOS simulator permission state row(s) for ${args.appId}`
        : result.error ?? `Failed to read iOS simulator permission state for ${args.appId}`,
      ...result
    });
  };

  // Register with the tool registry
  ToolRegistry.registerDeviceAware(
    "launchApp",
    "Launch app by package name",
    launchAppSchema,
    launchAppHandler
  );

  ToolRegistry.registerDeviceAware(
    "terminateApp",
    "Terminate app by package name",
    packageNameSchema,
    terminateAppHandler
  );

  ToolRegistry.registerDeviceAware(
    "installApp",
    "Install app on device (.apk for Android, .app for iOS simulator, .ipa for iOS physical device)",
    installAppSchema,
    installAppHandler
  );

  ToolRegistry.registerDeviceAware(
    "uninstallApp",
    "Uninstall app by package name or bundle identifier",
    uninstallAppSchema,
    uninstallAppHandler
  );

  ToolRegistry.register(
    "listApps",
    "Guide for listing apps via MCP resources",
    listAppsSchema,
    listAppsHandler
  );

  ToolRegistry.registerDeviceAware(
    "grantIosSimulatorPermissions",
    "Grant iOS simulator privacy permissions to an app via xcrun simctl privacy",
    grantIosSimulatorPermissionsSchema,
    grantIosSimulatorPermissionsHandler
  );

  ToolRegistry.registerDeviceAware(
    "setIosSimulatorPermissions",
    "Grant, revoke, or reset iOS simulator privacy permissions via xcrun simctl privacy",
    setIosSimulatorPermissionsSchema,
    setIosSimulatorPermissionsHandler
  );

  ToolRegistry.registerDeviceAware(
    "getIosSimulatorPermissions",
    "Read iOS simulator privacy permission state from the simulator TCC database",
    getIosSimulatorPermissionsSchema,
    getIosSimulatorPermissionsHandler
  );
}
