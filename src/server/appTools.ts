import { z } from "zod";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models";
import { LaunchApp } from "../features/action/LaunchApp";
import { TerminateApp } from "../features/action/TerminateApp";
import { InstallApp } from "../features/action/InstallApp";
import { UninstallApp } from "../features/action/UninstallApp";
import { AppPermissions } from "../features/action/AppPermissions";
import { createJSONToolResponse, DefaultToolResponseFormatter, ToolResponseFormatter } from "../utils/toolUtils";
import { addDeviceTargetingToSchema, withAppIdAliases, withJsonSchemaOverride } from "./toolSchemaHelpers";
import {
  APPS_RESOURCE_URIS,
  APP_RESOURCE_TEMPLATES,
  invalidateInstalledAppsCache,
  invalidateInstalledAppResourceCache,
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
export const packageNameSchema = withAppIdAliases(addDeviceTargetingToSchema(z.object({
  appId: z.string(),
})));

export const launchAppSchema = withAppIdAliases(addDeviceTargetingToSchema(z.object({
  appId: z.string(),
  clearAppData: z.boolean().optional().describe("Clear app data before launch (default false)"),
  coldBoot: z.boolean().optional().describe("Cold boot app (default false)"),
})));

export const installAppSchema = addDeviceTargetingToSchema(z.object({
  artifactPath: z.string().describe("App artifact path (.apk, .app, or .ipa)"),
}));

export const uninstallAppSchema = withAppIdAliases(addDeviceTargetingToSchema(z.object({
  appId: z.string(),
  keepData: z.boolean().optional().describe("Keep app data after uninstall (Android only, default false)"),
})));

const appPermissionActionSchema = z.enum(["grant", "revoke", "reset"]);

export const setAppPermissionsSchema = withJsonSchemaOverride(withAppIdAliases(addDeviceTargetingToSchema(
  z.object({
    appId: z.string().trim().min(1),
    action: appPermissionActionSchema
      .optional()
      .describe(
        "Action (default grant). Android reset requires permissions=['all'] device-wide; " +
        "iOS physical devices support reset only."
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
)).refine(
  args =>
    (args.permissions !== undefined && args.permissions.length > 0) ||
    args.notificationsEnabled !== undefined ||
    args.notificationPolicyAccess !== undefined ||
    args.scheduleExactAlarm !== undefined,
  "Provide at least one permission or platform-specific permission option"
).refine(
  args => args.action !== "reset" || args.userId === undefined,
  "Android reset is device-wide and does not support userId"
).refine(
  args => args.action !== "reset" || args.permissions?.some(permission => permission.trim().length > 0) === true,
  "Reset requires permissions"
).refine(
  args =>
    args.action !== "reset" ||
    args.platform !== "android" ||
    (args.permissions?.length === 1 && args.permissions[0] === "all"),
  "Android reset requires permissions=['all']"
), jsonSchema => {
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
});

export const getAppPermissionsSchema = withAppIdAliases(addDeviceTargetingToSchema(
  z.object({
    appId: z.string(),
    permissions: z
      .array(z.string().min(1))
      .optional()
      .describe("Optional permissions or simulator privacy services to query"),
  })
));

export const listAppsSchema = z.object({}).passthrough();

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

export type SetAppPermissionsArgs = z.infer<typeof setAppPermissionsSchema>;

export type GetAppPermissionsArgs = z.infer<typeof getAppPermissionsSchema>;

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
        invalidateInstalledAppResourceCache(device.deviceId);
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
        invalidateInstalledAppResourceCache(device.deviceId);
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

  const setAppPermissionsHandler = async (device: BootedDevice, args: SetAppPermissionsArgs) => {
    const permissions = new AppPermissions(device);
    const result = await permissions.setPermissions(args.appId, {
      action: args.action,
      permissions: args.permissions,
      userId: args.userId,
      notificationsEnabled: args.notificationsEnabled,
      notificationPolicyAccess: args.notificationPolicyAccess,
      scheduleExactAlarm: args.scheduleExactAlarm,
    });

    return createJSONToolResponse({
      message: result.success
        ? `Applied ${result.changedCount} app permission change(s) for ${args.appId}`
        : result.error ?? `Failed to apply app permission changes for ${args.appId}`,
      ...result,
    });
  };

  const getAppPermissionsHandler = async (device: BootedDevice, args: GetAppPermissionsArgs) => {
    const permissions = new AppPermissions(device);
    const result = await permissions.getPermissions(args.appId, {
      permissions: args.permissions,
    });

    return createJSONToolResponse({
      message: result.success
        ? `Read ${result.permissions.length} app permission state row(s) for ${args.appId}`
        : result.error ?? `Failed to read app permission state for ${args.appId}`,
      ...result,
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
    "Install app on device (.apk, .app, or .ipa)",
    installAppSchema,
    installAppHandler
  );

  ToolRegistry.registerDeviceAware(
    "uninstallApp",
    "Uninstall app by package name or bundle identifier",
    uninstallAppSchema,
    uninstallAppHandler
  );

  ToolRegistry.registerDeviceAware(
    "setAppPermissions",
    "userId grant/revoke; device-wide reset ['all']; no POST_NOTIFICATIONS.",
    setAppPermissionsSchema,
    setAppPermissionsHandler
  );

  ToolRegistry.registerDeviceAware(
    "getAppPermissions",
    "Read app permission state",
    getAppPermissionsSchema,
    getAppPermissionsHandler
  );

  ToolRegistry.register(
    "listApps",
    "Guide for listing apps via MCP resources",
    listAppsSchema,
    listAppsHandler
  );
}
