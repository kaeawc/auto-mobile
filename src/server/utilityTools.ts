import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError } from "../models/ActionableError";
import { SystemConfigurationManager } from "../features/utility/SystemConfigurationManager";
import {
  DeviceState,
  MAX_NETWORK_CONDITION_TTL_SECONDS,
  networkConditionInputDegrades,
  networkConditionInputError,
  type BiometricEnrollment,
  type DeviceStateResult,
  type SetDeviceStateInput,
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
import { runSessionNetworkMutation } from "./sessionNetworkCondition";

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

// In direct/sessionless mode there is no session lifecycle owner to enforce a
// networkCondition TTL, so accepting `expiresInSeconds` there would echo a TTL we
// will never honor and leave the emulator shaped indefinitely (issue #6085 review
// item 3). Reject it up front rather than make a false promise.
const NETWORK_CONDITION_TTL_UNENFORCEABLE_ERROR =
  "networkCondition.expiresInSeconds cannot be honored in direct/sessionless mode: there is no " +
  "session lifecycle owner to enforce the TTL, so the device would stay shaped indefinitely. " +
  "Omit expiresInSeconds (and reset the condition yourself when done), or run within a session.";

/**
 * A networkCondition mutation needs a session restore slot only when it degrades
 * the link on an Android emulator (issue #6012) — the single decision shared by
 * the restore-slot registration and the TTL-enforceability check.
 */
function shouldRegisterNetworkRestore(device: BootedDevice, args: SetDeviceStateArgs): boolean {
  return (
    args.networkCondition !== undefined &&
    networkConditionInputDegrades(args.networkCondition) &&
    device.platform === "android" &&
    device.deviceId.startsWith("emulator-")
  );
}

/**
 * True when a request carries a networkCondition TTL that WOULD shape an emulator
 * (`registerNetworkRestore`) but has no session lifecycle owner to enforce it —
 * the case that must be rejected rather than shaped indefinitely (issue #6085).
 */
function networkConditionTtlIsUnenforceable(
  expiresInSeconds: number | undefined,
  registerNetworkRestore: boolean,
  hasLifecycleOwner: boolean,
): boolean {
  return (
    registerNetworkRestore &&
    expiresInSeconds !== undefined &&
    expiresInSeconds > 0 &&
    !hasLifecycleOwner
  );
}

const networkConditionInputSchema = z
  .object({
    profile: z
      .enum(["none", "offline", "veryBad", "2g", "3g", "4g"])
      .optional()
      .describe(
        "Device-wide network profile. Documented values: none=unshaped, offline=no data, " +
          "veryBad≈GSM (550ms/14kbps), 2g≈EDGE (400ms/237kbps), 3g≈UMTS (200ms/1920kbps), " +
          "4g≈LTE. Degraded profiles are best-effort cellular shaping, reported `partial`. " +
          "Android emulator only.",
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
      .max(MAX_NETWORK_CONDITION_TTL_SECONDS)
      .optional()
      .describe(
        "TTL in seconds. When set on a degrading request, a timer resets the device to normal " +
          "connectivity after it elapses, independent of session lifetime; session release/expiry " +
          "also restores connectivity, whichever comes first. Capped at " +
          `${MAX_NETWORK_CONDITION_TTL_SECONDS}s (~24.8 days) to fit the timer's 32-bit limit.`,
      ),
  })
  // Reject non-actionable / contradictory requests using the SAME classifier the
  // setter uses, so schema acceptance and runtime behavior cannot disagree
  // (issue #6012 review + audit): `{}`, falsy-only cancel/reset and TTL-only are
  // `empty`; `offline` + a shaping override is `invalid`. `superRefine` so each
  // carries its own message.
  .superRefine((values, ctx) => {
    const error = networkConditionInputError(values);
    if (error) {
      ctx.addIssue({ code: "custom", message: error });
    }
  });

export const getDeviceStateSchema = addDeviceTargetingToSchema(
  z.object({
    include: z
      .array(z.enum(["doNotDisturb", "biometrics", "networkCondition"]))
      .min(1)
      .optional()
      .describe("State fields to read; supports doNotDisturb, biometrics, and networkCondition"),
  }),
);

// The networkCondition sub-object's zod refinement ("at least one meaningful
// field") cannot be expressed by zod's JSON-schema conversion, so
// tool-definitions.json would advertise every field as optional and let a client
// build a `networkCondition: {}` (or TTL-only) input that tools/list calls valid
// but invocation rejects. Re-encode it as JSON-schema `anyOf`/`required` via a
// `withJsonSchemaOverride` so the advertised contract matches the runtime one
// (issue #6012 review). (The top-level "at least one device-state field"
// refinement is left unencoded, as it already is for doNotDisturb/biometrics —
// setting a top-level `anyOf` collapses the object under `flattenTopLevelUnion`.)
// cancel/reset count only when `true` (a falsy value is not a request), so their
// branches pin `const: true` to match the runtime classifier (issue #6012 audit).
// A bare zero override is the documented no-op, not a request, so its anyOf
// branch requires a NON-NEUTRAL value — mirroring the runtime classifier, which
// treats `{delayMs:0}` as `empty` (issue #6090). `{profile:"none", delayMs:0}`
// still satisfies the `profile` branch and classifies as a reset.
const NETWORK_CONDITION_REQUIRED_ANY_OF = [
  { required: ["profile"] },
  { required: ["cancel"], properties: { cancel: { const: true } } },
  { required: ["reset"], properties: { reset: { const: true } } },
  { required: ["delayMs"], properties: { delayMs: { not: { const: 0 } } } },
  { required: ["downloadKbps"], properties: { downloadKbps: { not: { const: 0 } } } },
  { required: ["uploadKbps"], properties: { uploadKbps: { not: { const: 0 } } } },
  { required: ["packetLossPercent"], properties: { packetLossPercent: { not: { const: 0 } } } },
];

// `offline` cuts the link, so a shaping override cannot apply — mirror the
// runtime `invalid` rejection in JSON schema so tools/list matches invocation
// (issue #6012 review): if profile is offline, forbid delayMs/downloadKbps/uploadKbps.
// The rejection is cancel/reset-aware (issue #6090): `cancel`/`reset` win at the
// runtime classifier ("make it clean"), so an offline+override request that also
// carries a true cancel/reset is a valid reset and must NOT be false-rejected —
// the `if` therefore only fires when NO true cancel/reset is present.
const NETWORK_CONDITION_OFFLINE_NO_OVERRIDE = {
  if: {
    required: ["profile"],
    properties: { profile: { const: "offline" } },
    not: {
      anyOf: [
        { required: ["cancel"], properties: { cancel: { const: true } } },
        { required: ["reset"], properties: { reset: { const: true } } },
      ],
    },
  },
  then: {
    not: {
      anyOf: [
        { required: ["delayMs"] },
        { required: ["downloadKbps"] },
        { required: ["uploadKbps"] },
      ],
    },
  },
};

export const setDeviceStateSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
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
  ),
  (jsonSchema) => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>> | undefined;
    const networkCondition = properties?.networkCondition;
    if (networkCondition) {
      networkCondition.anyOf = NETWORK_CONDITION_REQUIRED_ANY_OF;
      networkCondition.if = NETWORK_CONDITION_OFFLINE_NO_OVERRIDE.if;
      networkCondition.then = NETWORK_CONDITION_OFFLINE_NO_OVERRIDE.then;
    }
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
    const sessionManager =
      args.sessionUuid && DaemonState.getInstance().isInitialized()
        ? DaemonState.getInstance().getSessionManager()
        : undefined;
    // Single decision for whether an applied networkCondition needs a session
    // restore slot: a degrading request on an Android emulator (issue #6012).
    const registerNetworkRestore = shouldRegisterNetworkRestore(device, args);

    // A degrade that WOULD shape an emulator but carries a TTL with no lifecycle
    // owner to enforce it must be rejected, not applied — otherwise the device is
    // shaped indefinitely while the result falsely echoes a TTL (issue #6085
    // review item 3).
    const hasLifecycleOwner = Boolean(sessionManager && args.sessionUuid);
    if (
      networkConditionTtlIsUnenforceable(
        args.networkCondition?.expiresInSeconds,
        registerNetworkRestore,
        hasLifecycleOwner,
      )
    ) {
      return createJSONToolResponse({
        message: NETWORK_CONDITION_TTL_UNENFORCEABLE_ERROR,
        success: false,
        deviceId: device.deviceId,
        platform: device.platform,
        error: NETWORK_CONDITION_TTL_UNENFORCEABLE_ERROR,
      });
    }

    // A setter that routes ANY networkCondition-bearing mutation through
    // runSessionNetworkMutation, so the restore slot is registered before the
    // emulator command and the mutation is sequenced against release/rebind — on
    // every path, including the biometric-capture-failure fallback below (issue
    // #6012 review: that fallback previously applied networkCondition untracked).
    const applyStateTracked = (input: SetDeviceStateInput): Promise<DeviceStateResult> =>
      input.networkCondition
        ? runSessionNetworkMutation(
            sessionManager,
            args.sessionUuid,
            device.deviceId,
            registerNetworkRestore,
            () => deviceState.setState(input),
            input.networkCondition.expiresInSeconds,
          )
        : deviceState.setState(input);

    const capture = await captureBiometricEnrollment(device, args, deviceState);
    if (capture.failure) {
      const result = await applyStateAfterBiometricCaptureFailure(
        { setState: applyStateTracked },
        {
          doNotDisturb: args.doNotDisturb,
          biometrics: args.biometrics,
          networkCondition: args.networkCondition,
        },
        capture.failure,
      );
      return createJSONToolResponse({
        message: result.error ?? "Failed to read biometric enrollment state",
        ...result,
      });
    }

    const mutation = () =>
      deviceState.setState({
        doNotDisturb: args.doNotDisturb,
        biometrics: args.biometrics,
        networkCondition: args.networkCondition,
      });

    // Route network-bearing requests through runSessionNetworkMutation (slot
    // registered first, mutation tracked). The biometric-wrapper path is used
    // only when biometrics succeeded (iOS) — where networkCondition is always
    // unsupported and registers no slot — so it needs no network tracking.
    let result: DeviceStateResult;
    if (!args.biometrics && args.networkCondition) {
      result = await runSessionNetworkMutation(
        sessionManager,
        args.sessionUuid,
        device.deviceId,
        registerNetworkRestore,
        mutation,
        args.networkCondition.expiresInSeconds,
      );
    } else {
      result = await runSessionBiometricMutation(
        capture.sessionManager,
        args.sessionUuid,
        device.deviceId,
        capture.initialEnrollment,
        mutation,
      );
    }

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
    "Set device state such as Do Not Disturb, iOS Simulator biometric enrollment, and device-wide network condition. Degraded network profiles (offline/veryBad/2g/3g/4g) are best-effort cellular shaping on an Android emulator, reported `partial` (they may not affect Wi-Fi/app traffic); only reset to `none` is fully verified. A session always restores the network to a clean `none` state on release/rebind.",
    setDeviceStateSchema,
    setDeviceStateHandler,
    { defaultEnabled: false },
  );
}
