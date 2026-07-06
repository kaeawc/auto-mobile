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
import { addDeviceTargetingToSchema, addSessionUuidToSchema, platformSchema } from "./toolSchemaHelpers";
import { DaemonState } from "../daemon/daemonState";

const YDC_SEARCH_URL = "https://ydc-index.io/v1/search";
const YDC_API_KEY_ENV = "YDC_API_KEY";

const youcomSearchSchema = z.object({
  query: z.string().min(1).describe("Search query"),
  count: z.number().int().min(1).max(100).optional().describe("Results per section (1-100)"),
  freshness: z.string().min(1).optional().describe("Freshness filter, for example day, week, month, year, or YYYY-MM-DDtoYYYY-MM-DD"),
  offset: z.number().int().min(0).max(9).optional().describe("Pagination offset"),
  country: z.string().length(2).optional().describe("Country code such as US or GB"),
  language: z.string().min(2).max(5).optional().describe("Language code such as EN"),
  safesearch: z.enum(["off", "moderate", "strict"]).optional(),
  livecrawl: z.enum(["web", "news", "all"]).optional(),
  livecrawlFormats: z.enum(["html", "markdown"]).optional().describe("Requires livecrawl"),
  crawlTimeout: z.number().int().min(1).max(60).optional().describe("Live crawl timeout in seconds"),
});

type YoucomSearchArgs = z.infer<typeof youcomSearchSchema>;

function buildYoucomSearchUrl(args: YoucomSearchArgs): URL {
  const url = new URL(YDC_SEARCH_URL);
  url.searchParams.set("query", args.query);
  if (args.count !== undefined) {
    url.searchParams.set("count", String(args.count));
  }
  if (args.freshness) {
    url.searchParams.set("freshness", args.freshness);
  }
  if (args.offset !== undefined) {
    url.searchParams.set("offset", String(args.offset));
  }
  if (args.country) {
    url.searchParams.set("country", args.country);
  }
  if (args.language) {
    url.searchParams.set("language", args.language);
  }
  if (args.safesearch) {
    url.searchParams.set("safesearch", args.safesearch);
  }
  if (args.livecrawl) {
    url.searchParams.set("livecrawl", args.livecrawl);
  }
  if (args.livecrawlFormats) {
    url.searchParams.set("livecrawl_formats", args.livecrawlFormats);
  }
  if (args.crawlTimeout !== undefined) {
    url.searchParams.set("crawl_timeout", String(args.crawlTimeout));
  }
  return url;
}

async function runYoucomSearch(args: YoucomSearchArgs) {
  const apiKey = process.env[YDC_API_KEY_ENV];
  if (!apiKey) {
    return createJSONToolResponse({
      success: false,
      error: `Set ${YDC_API_KEY_ENV} to enable the optional You.com search tool.`,
    });
  }

  const response = await fetch(buildYoucomSearchUrl(args), {
    headers: { "X-API-Key": apiKey },
  });

  const bodyText = await response.text();
  if (!response.ok) {
    return createJSONToolResponse({
      success: false,
      error: `You.com Search API error ${response.status}: ${bodyText}`,
    });
  }

  const payload = JSON.parse(bodyText) as {
    results?: { web?: Array<Record<string, unknown>>; news?: Array<Record<string, unknown>> };
    metadata?: Record<string, unknown>;
  };

  return createJSONToolResponse({
    success: true,
    query: args.query,
    results: payload.results ?? {},
    metadata: payload.metadata ?? {},
  });
}

// Schema definitions
export const setActiveDeviceSchema = addSessionUuidToSchema(z.object({
  deviceId: z.string(),
  platform: platformSchema
}));

const changeLocalizationBaseSchema = z.object({
  platform: platformSchema,
  locale: z.string().min(1).optional().describe("Locale tag (e.g., ar-SA, ja-JP)"),
  timeZone: z.string().min(1).optional().describe("Zone ID (e.g., America/Los_Angeles)"),
  textDirection: z.enum(["ltr", "rtl"]).optional().describe("Text direction"),
  timeFormat: z.enum(["12", "24"]).optional().describe("Time format"),
  calendarSystem: z.string().min(1).optional().describe("Calendar system (e.g., gregory, japanese, buddhist, islamic-civil)"),
  restartApp: z.string().min(1).optional().describe("iOS bundle ID to relaunch after locale change")
});

export const changeLocalizationSchema = addDeviceTargetingToSchema(changeLocalizationBaseSchema).refine(values =>
  values.locale || values.timeZone || values.textDirection || values.timeFormat || values.calendarSystem, {
  message: "At least one of locale, timeZone, textDirection, timeFormat, or calendarSystem must be provided."
});

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
  locale?: string;
  timeZone?: string;
  textDirection?: "ltr" | "rtl";
  timeFormat?: "12" | "24";
  calendarSystem?: string;
  restartApp?: string;
}

export type GetDeviceStateArgs = z.infer<typeof getDeviceStateSchema>;

export type SetDeviceStateArgs = z.infer<typeof setDeviceStateSchema>;

export type YoucomSearchToolArgs = YoucomSearchArgs;

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
        // Release any existing session for this sessionUuid before rebinding
        const existing = sessionManager.getSession(args.sessionUuid);
        if (existing && existing.assignedDevice !== args.deviceId) {
          await sessionManager.releaseSession(existing.sessionId);
          await devicePool.releaseDevice(existing.assignedDevice);
        }
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

    if (args.locale !== undefined) {
      const result = await manager.setLocale(args.locale, { broadcast: false });
      if (result.success) {
        changes.locale = result.languageTag;
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

  const youcomSearchHandler = async (args: YoucomSearchArgs) => runYoucomSearch(args);

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

  ToolRegistry.register(
    "youcomSearch",
    "Search the web with the optional You.com Search API",
    youcomSearchSchema,
    youcomSearchHandler
  );
}
