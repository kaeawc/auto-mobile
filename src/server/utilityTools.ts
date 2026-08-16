import { z } from "zod";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError } from "../models/ActionableError";
import { SystemConfigurationManager } from "../features/utility/SystemConfigurationManager";
import { DeviceState } from "../features/utility/DeviceState";
import { logger } from "../utils/logger";
import { createJSONToolResponse } from "../utils/toolUtils";
import { DeviceSessionManager } from "../utils/DeviceSessionManager";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { BootedDevice, Platform } from "../models";
import {
  addDeviceTargetingToSchema,
  addSessionUuidToSchema,
  platformSchema,
  withAppIdAliases,
  withJsonSchemaOverride,
} from "./toolSchemaHelpers";
import { DaemonState } from "../daemon/daemonState";

// Schema definitions
export const setActiveDeviceSchema = addSessionUuidToSchema(z.object({
  deviceId: z.string(),
  platform: platformSchema
}));

const changeLocalizationBaseSchema = z.object({
  platform: platformSchema,
  appId: z.string().min(1).optional().describe("Android app package for locale changes"),
  locale: z.string().min(1).optional().describe("Locale tag (e.g., ar-SA, ja-JP)"),
  timeZone: z.string().min(1).optional().describe("Zone ID (e.g., America/Los_Angeles)"),
  textDirection: z.enum(["ltr", "rtl"]).optional().describe("Text direction"),
  timeFormat: z.enum(["12", "24"]).optional().describe("Time format"),
  calendarSystem: z.string().min(1).optional().describe("Calendar system (e.g., gregory, japanese, buddhist, islamic-civil)"),
  restartApp: z.string().min(1).optional().describe("iOS bundle ID to relaunch after locale change")
});

export const changeLocalizationSchema = withJsonSchemaOverride(
  withAppIdAliases(addDeviceTargetingToSchema(changeLocalizationBaseSchema)).superRefine((values, ctx) => {
    if (!values.locale && !values.timeZone && !values.textDirection && !values.timeFormat && !values.calendarSystem) {
      ctx.addIssue({
        code: "custom",
        message: "At least one of locale, timeZone, textDirection, timeFormat, or calendarSystem must be provided.",
      });
    }
    if (values.appId && values.platform !== "android") {
      ctx.addIssue({
        code: "custom",
        path: ["appId"],
        message: "appId is only supported for Android locale changes.",
      });
    }
    if (values.appId && !values.locale) {
      ctx.addIssue({
        code: "custom",
        path: ["appId"],
        message: "appId only applies when locale is provided.",
      });
    }
    if (values.platform === "android" && values.locale && !values.appId) {
      ctx.addIssue({
        code: "custom",
        path: ["appId"],
        message: "appId is required for Android locale changes.",
      });
    }
  }),
  jsonSchema => {
    jsonSchema.if = {
      properties: {
        platform: { const: "android" },
      },
      required: ["platform", "locale"],
    };
    jsonSchema.then = {
      required: ["appId"],
    };
  }
);

const doNotDisturbStateInputSchema = z.object({
  enabled: z.boolean().optional().describe("Enable or disable Do Not Disturb"),
  mode: z.enum(["off", "none", "priority", "alarms"]).optional().describe("Do Not Disturb mode")
}).refine(values => values.enabled !== undefined || values.mode !== undefined, {
  message: "Provide enabled or mode for doNotDisturb"
});

export const getDeviceStateSchema = addDeviceTargetingToSchema(z.object({
  include: z.array(z.enum(["doNotDisturb"]))
    .optional()
    .describe("State fields to read; supports doNotDisturb")
}));

export const setDeviceStateSchema = addDeviceTargetingToSchema(z.object({
  doNotDisturb: doNotDisturbStateInputSchema
    .optional()
    .describe("Do Not Disturb state to apply.")
})).refine(values => values.doNotDisturb !== undefined, {
  message: "At least one device state field must be provided"
});

// Export interfaces for type safety
export interface SetActiveDeviceArgs {
  deviceId: string;
    platform: Platform;
}

export interface ChangeLocalizationArgs {
  platform: Platform;
  appId?: string;
  locale?: string;
  timeZone?: string;
  textDirection?: "ltr" | "rtl";
  timeFormat?: "12" | "24";
  calendarSystem?: string;
  restartApp?: string;
}

export type GetDeviceStateArgs = z.infer<typeof getDeviceStateSchema>;

export type SetDeviceStateArgs = z.infer<typeof setDeviceStateSchema>;

// Register tools
export function registerUtilityTools() {
  // Set active device handler
  const setActiveDeviceHandler = async (args: SetActiveDeviceArgs & { sessionUuid?: string }) => {
    try {
      if (args.sessionUuid && DaemonState.getInstance().isInitialized()) {
        // Session-scoped: bind the specific requested device to this session
        const sessionManager = DaemonState.getInstance().getSessionManager();
        const devicePool = DaemonState.getInstance().getDevicePool();
        let pooledDevice = devicePool.getDevice(args.deviceId);
        if (!pooledDevice) {
          await devicePool.refreshDevices();
          pooledDevice = devicePool.getDevice(args.deviceId);
        }
        if (!pooledDevice) {
          throw new ActionableError(`Device '${args.deviceId}' not found in device pool`);
        }
        if (pooledDevice.sessionId && pooledDevice.sessionId !== args.sessionUuid) {
          const owningSession = sessionManager.getSession(pooledDevice.sessionId);
          if (owningSession) {
            throw new ActionableError(
              `Device '${args.deviceId}' is already assigned to session ${pooledDevice.sessionId}`
            );
          }
        }
        // The pool persists a replacement binding before it releases the previous
        // one, so a failed write leaves the caller's existing session intact.
        const existing = sessionManager.getSession(args.sessionUuid);
        if (!existing || existing.assignedDevice !== args.deviceId) {
          const boundSession = await devicePool.bindOrReuseDeviceSession(args.sessionUuid, args.deviceId, args.platform);
          if (boundSession !== args.sessionUuid) {
            throw new ActionableError(
              `Device '${args.deviceId}' is already assigned to session ${boundSession}`
            );
          }
        }
        logger.info(`[setActiveDevice] Bound device ${args.deviceId} to session ${args.sessionUuid}`);
      } else {
        // Legacy single-agent path: sets global active device
        const sessionManager = DeviceSessionManager.getInstance();
        const previousDevice = sessionManager.getCurrentDevice();
        const previousPlatform = sessionManager.getCurrentPlatform();

        await sessionManager.ensureDeviceReady(args.platform, args.deviceId);

        // When switching platforms, clear observation caches to prevent stale
        // data from the previous platform contaminating subsequent observe calls.
        if (previousPlatform && previousPlatform !== args.platform && previousDevice) {
          logger.info(
            `[setActiveDevice] Platform switch detected (${previousPlatform} -> ${args.platform}), ` +
            `clearing observation cache for previous device ${previousDevice.deviceId}`
          );
          RealObserveScreen.clearCache(previousDevice.deviceId);
        }
      }

      return createJSONToolResponse({
        message: `Active device set to '${args.deviceId}'`,
        deviceId: args.deviceId,
      });
    } catch (error) {
      logger.error("Failed to set active device:", error);
      throw new ActionableError(`Failed to set active device: ${error}`);
    }
  };

  const changeLocalizationHandler = async (device: BootedDevice, args: ChangeLocalizationArgs) => {
    const manager = new SystemConfigurationManager(device);
    const changes: {
      locale?: string;
      timeZone?: string;
      textDirection?: "ltr" | "rtl";
      timeFormat?: "12" | "24";
      calendarSystem?: string;
    } = {};
    const errors: string[] = [];
    let localeMetadata: {
      localeScope?: "app" | "system";
      localeAppId?: string;
      localeMethod?: string;
    } = {};

    if (args.locale !== undefined) {
      const localeOptions = args.appId && device.platform === "android"
        ? { broadcast: false, appId: args.appId }
        : { broadcast: false };
      const result = await manager.setLocale(args.locale, localeOptions);
      if (result.success) {
        changes.locale = result.languageTag;
        localeMetadata = {
          localeScope: result.method?.startsWith("cmd locale set-app-locales") ? "app" : "system",
          ...(args.appId && device.platform === "android" ? { localeAppId: args.appId } : {}),
          ...(result.method ? { localeMethod: result.method } : {}),
        };
      } else {
        errors.push(result.error ?? "Failed to set locale");
      }
    }

    if (args.timeZone !== undefined) {
      const result = await manager.setTimeZone(args.timeZone);
      if (result.success) {
        changes.timeZone = result.zoneId;
      } else {
        errors.push(result.error ?? "Failed to set time zone");
      }
    }

    if (args.textDirection !== undefined) {
      const rtl = args.textDirection === "rtl";
      const result = await manager.setTextDirection(rtl, { broadcast: false });
      if (result.success) {
        changes.textDirection = rtl ? "rtl" : "ltr";
      } else {
        errors.push(result.error ?? "Failed to set text direction");
      }
    }

    if (args.timeFormat !== undefined) {
      const enabled = args.timeFormat === "24";
      const result = await manager.set24HourFormat(enabled);
      if (result.success) {
        changes.timeFormat = enabled ? "24" : "12";
      } else {
        errors.push(result.error ?? "Failed to set time format");
      }
    }

    if (args.calendarSystem !== undefined) {
      const result = await manager.setCalendarSystem(args.calendarSystem);
      if (result.success) {
        changes.calendarSystem = result.calendarSystem;
      } else {
        errors.push(result.error ?? "Failed to set calendar system");
      }
    }

    const success = errors.length === 0;
    let intentBroadcast = false;
    let liveChanges: { springBoardRestarted: boolean; notificationPosted: boolean; appRestarted?: boolean } | undefined;

    if (Object.keys(changes).length > 0) {
      if (device.platform === "android") {
        intentBroadcast = await manager.broadcastLocaleChange();
      } else if (device.platform === "ios") {
        liveChanges = await manager.applyIosLiveChanges(args.restartApp);
      }
    }

    return createJSONToolResponse({
      success,
      changes,
      intentBroadcast,
      ...localeMetadata,
      ...(liveChanges ? { iosLiveChanges: liveChanges } : {}),
      ...(success ? {} : { error: errors.join("; ") })
    });
  };

  const getDeviceStateHandler = async (device: BootedDevice, _args: GetDeviceStateArgs) => {
    const deviceState = new DeviceState(device);
    const result = await deviceState.getState();

    return createJSONToolResponse({
      message: result.success
        ? "Read device state"
        : result.error ?? "Failed to read device state",
      ...result,
    });
  };

  const setDeviceStateHandler = async (device: BootedDevice, args: SetDeviceStateArgs) => {
    const deviceState = new DeviceState(device);
    const result = await deviceState.setState({
      doNotDisturb: args.doNotDisturb,
    });

    return createJSONToolResponse({
      message: result.success
        ? "Applied device state"
        : result.error ?? "Failed to apply device state",
      ...result,
    });
  };

  // Register with the tool registry
  ToolRegistry.register(
    "setActiveDevice",
    "Set active device",
    setActiveDeviceSchema,
    setActiveDeviceHandler
  );

  ToolRegistry.registerDeviceAware(
    "changeLocalization",
    "Change locale, time zone, text direction, time format, and calendar system",
    changeLocalizationSchema,
    changeLocalizationHandler
  );

  ToolRegistry.registerDeviceAware(
    "getDeviceState",
    "Read device-level state such as Do Not Disturb",
    getDeviceStateSchema,
    getDeviceStateHandler
  );

  ToolRegistry.registerDeviceAware(
    "setDeviceState",
    "Set device state such as Do Not Disturb.",
    setDeviceStateSchema,
    setDeviceStateHandler
  );
}
