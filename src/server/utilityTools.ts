import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError } from "../models/ActionableError";
import { SystemConfigurationManager } from "../features/utility/SystemConfigurationManager";
import {
  DeviceState,
  type BiometricEnrollment,
  type DeviceStateResult,
} from "../features/utility/DeviceState";
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
import type { SessionManager } from "../daemon/sessionManager";
import {
  applyStateAfterBiometricCaptureFailure,
  runSessionBiometricMutation,
} from "./sessionBiometricEnrollment";

// Schema definitions
export const setActiveDeviceSchema = addSessionUuidToSchema(
  z.object({
    deviceId: z.string(),
    // #5870: the platform is inferred from the resolved device (or the session),
    // so callers targeting a concrete `deviceId` need not also send `platform`.
    platform: platformSchema.optional(),
  }),
);

const changeLocalizationBaseSchema = z.object({
  platform: platformSchema,
  appId: z.string().min(1).optional().describe("Android app package for locale changes"),
  locale: z.string().min(1).optional().describe("Locale tag (e.g., ar-SA, ja-JP)"),
  timeZone: z.string().min(1).optional().describe("Zone ID (e.g., America/Los_Angeles)"),
  textDirection: z.enum(["ltr", "rtl"]).optional().describe("Text direction"),
  timeFormat: z.enum(["12", "24"]).optional().describe("Time format"),
  calendarSystem: z
    .string()
    .min(1)
    .optional()
    .describe("Calendar system (e.g., gregory, japanese, buddhist, islamic-civil)"),
  restartApp: z
    .string()
    .min(1)
    .optional()
    .describe("iOS bundle ID to relaunch after locale change"),
});

export const changeLocalizationSchema = withJsonSchemaOverride(
  withAppIdAliases(addDeviceTargetingToSchema(changeLocalizationBaseSchema)).superRefine(
    (values, ctx) => {
      if (
        !values.locale &&
        !values.timeZone &&
        !values.textDirection &&
        !values.timeFormat &&
        !values.calendarSystem
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "At least one of locale, timeZone, textDirection, timeFormat, or calendarSystem must be provided.",
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
    },
  ),
  (jsonSchema) => {
    jsonSchema.if = {
      properties: {
        platform: { const: "android" },
      },
      required: ["platform", "locale"],
    };
    jsonSchema.then = {
      required: ["appId"],
    };
  },
);

const doNotDisturbStateInputSchema = z
  .object({
    enabled: z.boolean().optional().describe("Enable or disable Do Not Disturb"),
    mode: z.enum(["off", "none", "priority", "alarms"]).optional().describe("Do Not Disturb mode"),
  })
  .refine((values) => values.enabled !== undefined || values.mode !== undefined, {
    message: "Provide enabled or mode for doNotDisturb",
  });

const biometricStateInputSchema = z.object({
  enrollment: z
    .enum(["enrolled", "not_enrolled"])
    .describe("Set iOS Simulator biometric enrollment state."),
});

const networkConditionInputSchema = z
  .object({
    profile: z
      .enum(["none", "offline", "veryBad", "2g", "3g", "4g", "5g"])
      .optional()
      .describe(
        "Device-wide network profile. Documented values: none=unshaped, offline=no data, " +
          "veryBad≈GSM (550ms/14kbps), 2g≈EDGE (400ms/237kbps), 3g≈UMTS (200ms/1920kbps), " +
          "4g≈LTE, 5g=unlimited. Android emulator only.",
      ),
    cancel: z.boolean().optional().describe("Reset to normal connectivity (same as profile=none)."),
    reset: z.boolean().optional().describe("Alias of cancel."),
    delayMs: z.number().min(0).optional().describe("Override added latency in milliseconds."),
    downloadKbps: z
      .number()
      .min(0)
      .optional()
      .describe("Override download cap in kbps (0=unlimited)."),
    uploadKbps: z.number().min(0).optional().describe("Override upload cap in kbps (0=unlimited)."),
    packetLossPercent: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("Documented target packet loss; the emulator console cannot enforce partial loss."),
    expiresInSeconds: z
      .number()
      .min(0)
      .optional()
      .describe("Advisory TTL; session release/expiry restores normal connectivity."),
  })
  .refine(
    (values) =>
      values.profile !== undefined ||
      values.cancel !== undefined ||
      values.reset !== undefined ||
      values.delayMs !== undefined ||
      values.downloadKbps !== undefined ||
      values.uploadKbps !== undefined ||
      values.packetLossPercent !== undefined,
    { message: "Provide profile, cancel/reset, or an explicit override for networkCondition" },
  );

export const getDeviceStateSchema = addDeviceTargetingToSchema(
  z.object({
    include: z
      .array(z.enum(["doNotDisturb", "biometrics", "networkCondition"]))
      .min(1)
      .optional()
      .describe("State fields to read; supports doNotDisturb, biometrics, and networkCondition"),
  }),
);

export const setDeviceStateSchema = addDeviceTargetingToSchema(
  z.object({
    doNotDisturb: doNotDisturbStateInputSchema
      .optional()
      .describe("Do Not Disturb state to apply."),
    biometrics: biometricStateInputSchema
      .optional()
      .describe("iOS Simulator biometric enrollment state to apply."),
    networkCondition: networkConditionInputSchema
      .optional()
      .describe("Device-wide network condition to apply (Android emulator only)."),
  }),
).refine(
  (values) =>
    values.doNotDisturb !== undefined ||
    values.biometrics !== undefined ||
    values.networkCondition !== undefined,
  {
    message: "At least one device state field must be provided",
  },
);

// Export interfaces for type safety
export interface SetActiveDeviceArgs {
  deviceId: string;
  platform?: Platform;
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

interface BiometricEnrollmentCapture {
  sessionManager?: SessionManager;
  initialEnrollment?: BiometricEnrollment;
  failure?: DeviceStateResult;
}

async function captureBiometricEnrollment(
  device: BootedDevice,
  args: SetDeviceStateArgs,
  deviceState: DeviceState,
): Promise<BiometricEnrollmentCapture> {
  if (!args.biometrics || !args.sessionUuid || !DaemonState.getInstance().isInitialized()) {
    return {};
  }
  const sessionManager = DaemonState.getInstance().getSessionManager();
  if (sessionManager.getBiometricEnrollment(args.sessionUuid)) {
    return { sessionManager };
  }
  const state = await deviceState.getBiometricEnrollmentState();
  if (!state.supported || !state.enrollment || state.error) {
    return {
      sessionManager,
      failure: {
        success: false,
        deviceId: device.deviceId,
        platform: device.platform,
        biometrics: state,
        ...(state.error ? { error: state.error } : {}),
      },
    };
  }
  return { sessionManager, initialEnrollment: state.enrollment };
}

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
              `Device '${args.deviceId}' is already assigned to session ${pooledDevice.sessionId}`,
            );
          }
        }
        // The pool persists a replacement binding before it releases the previous
        // one, so a failed write leaves the caller's existing session intact.
        const existing = sessionManager.getSession(args.sessionUuid);
        if (!existing || existing.assignedDevice !== args.deviceId) {
          // #5870: infer the platform from the resolved pool device when the
          // caller did not send one.
          const boundSession = await devicePool.bindOrReuseDeviceSession(
            args.sessionUuid,
            args.deviceId,
            args.platform ?? pooledDevice.platform,
            undefined,
            undefined,
            undefined,
            true,
          );
          if (boundSession !== args.sessionUuid) {
            throw new ActionableError(
              `Device '${args.deviceId}' is already assigned to session ${boundSession}`,
            );
          }
        }
        logger.info(
          `[setActiveDevice] Bound device ${args.deviceId} to session ${args.sessionUuid}`,
        );
      } else {
        // Legacy single-agent path: sets global active device
        const sessionManager = DeviceSessionManager.getInstance();
        const previousDevice = sessionManager.getCurrentDevice();
        const previousPlatform = sessionManager.getCurrentPlatform();

        // #5870: with no explicit platform, "either" lets the deviceId
        // disambiguate; the resolved device carries the effective platform.
        const readyDevice = await sessionManager.ensureDeviceReady(
          args.platform ?? "either",
          args.deviceId,
        );
        const resolvedPlatform = args.platform ?? readyDevice.platform;

        // When switching platforms, clear observation caches to prevent stale
        // data from the previous platform contaminating subsequent observe calls.
        if (previousPlatform && previousPlatform !== resolvedPlatform && previousDevice) {
          logger.info(
            `[setActiveDevice] Platform switch detected (${previousPlatform} -> ${resolvedPlatform}), ` +
              `clearing observation cache for previous device ${previousDevice.deviceId}`,
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
      const localeOptions =
        args.appId && device.platform === "android"
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
    let liveChanges:
      | { springBoardRestarted: boolean; notificationPosted: boolean; appRestarted?: boolean }
      | undefined;

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
      ...(success ? {} : { error: errors.join("; ") }),
    });
  };

  const getDeviceStateHandler = async (device: BootedDevice, args: GetDeviceStateArgs) => {
    const deviceState = new DeviceState(device);
    const result = await deviceState.getState(args.include);

    return createJSONToolResponse({
      message: result.success
        ? "Read device state"
        : (result.error ?? "Failed to read device state"),
      ...result,
    });
  };

  const setDeviceStateHandler = async (device: BootedDevice, args: SetDeviceStateArgs) => {
    const deviceState = new DeviceState(device);
    const capture = await captureBiometricEnrollment(device, args, deviceState);
    if (capture.failure) {
      const result = await applyStateAfterBiometricCaptureFailure(
        deviceState,
        { doNotDisturb: args.doNotDisturb, biometrics: args.biometrics },
        capture.failure,
      );
      return createJSONToolResponse({
        message: result.error ?? "Failed to read biometric enrollment state",
        ...result,
      });
    }
    // Register the network-condition slot so session release/expiry restores
    // normal connectivity and never leaves a device impaired (issue #6012).
    // Only a degrading condition needs restoring; cancel/reset/none do not.
    if (
      args.networkCondition &&
      !args.networkCondition.cancel &&
      !args.networkCondition.reset &&
      (args.networkCondition.profile ?? "none") !== "none" &&
      args.sessionUuid &&
      DaemonState.getInstance().isInitialized()
    ) {
      DaemonState.getInstance()
        .getSessionManager()
        .setNetworkCondition(args.sessionUuid, { initialProfile: "none" });
    }

    const result = await runSessionBiometricMutation(
      capture.sessionManager,
      args.sessionUuid,
      device.deviceId,
      capture.initialEnrollment,
      () =>
        deviceState.setState({
          doNotDisturb: args.doNotDisturb,
          biometrics: args.biometrics,
          networkCondition: args.networkCondition,
        }),
    );

    return createJSONToolResponse({
      message: result.success
        ? "Applied device state"
        : (result.error ?? "Failed to apply device state"),
      ...result,
    });
  };

  // Register with the tool registry
  ToolRegistry.register(
    "setActiveDevice",
    "Set active device",
    setActiveDeviceSchema,
    setActiveDeviceHandler,
    { defaultEnabled: true },
  );

  ToolRegistry.registerDeviceAware(
    "changeLocalization",
    "Change locale, time zone, text direction, time format, and calendar system",
    changeLocalizationSchema,
    changeLocalizationHandler,
    { defaultEnabled: false },
  );

  ToolRegistry.registerDeviceAware(
    "getDeviceState",
    "Read device-level state such as Do Not Disturb, iOS Simulator biometric enrollment, and device-wide network condition",
    getDeviceStateSchema,
    getDeviceStateHandler,
    { defaultEnabled: false },
  );

  ToolRegistry.registerDeviceAware(
    "setDeviceState",
    "Set device state such as Do Not Disturb, iOS Simulator biometric enrollment, and device-wide network condition (offline/2g/3g/4g degraded connectivity; Android emulator only).",
    setDeviceStateSchema,
    setDeviceStateHandler,
    { defaultEnabled: false },
  );
}
