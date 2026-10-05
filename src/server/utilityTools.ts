import type { DisplayInventoryProvider } from "../devices/DisplayInventoryProvider";
import { createSetActiveDeviceHandler } from "./setActiveDevice";
export type { SetActiveDeviceArgs } from "./setActiveDevice";
import { getDeviceStateResultSchema, setDeviceStateResultSchema } from "./toolOutputSchemas";
import { deviceClockInputSchema, validateDeviceClockInput } from "../features/utility/DeviceClock";
import { runSessionClockMutation } from "./sessionClock";
import {
  createSessionLocationWriteAdmission,
  createSessionLocationAppliedCallback,
  runSessionLocationMutation,
} from "./sessionLocation";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError } from "../models/ActionableError";
import { SystemConfigurationManager } from "../features/utility/SystemConfigurationManager";
import {
  DeviceState,
  biometricEnrollmentSchema,
  doNotDisturbModeSchema,
  networkConditionProfileSchema,
  DEVICE_STATE_READABLE_FIELDS,
  MAX_NETWORK_CONDITION_TTL_SECONDS,
  networkConditionInputDegrades,
  networkConditionInputError,
  type BiometricEnrollment,
  type DeviceStateResult,
  type SetDeviceStateInput,
} from "../features/utility/DeviceState";
import {
  DisplayConfig,
  type DisplayConfigResult,
  type SetDisplayConfigInput,
} from "../features/utility/DisplayConfig";
import { createJSONToolResponse, createStructuredToolResponse } from "../utils/toolUtils";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { BootedDevice, Platform } from "../models";
import {
  addDeviceTargetingToSchema,
  addSessionUuidToSchema,
  platformSchema,
  withAppIdAliases,
  withJsonSchemaOverride,
} from "./toolSchemaHelpers";
import { DaemonState } from "../daemon/daemonState";
import { reconcileDiscoveryObservation } from "../daemon/discoveryReconcile";
import type { SessionManager } from "../daemon/sessionManager";
import {
  applyStateAfterBiometricCaptureFailure,
  runSessionBiometricMutation,
} from "./sessionBiometricEnrollment";
import { runSessionNetworkMutation } from "./sessionNetworkCondition";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";

async function resumeCtrlProxyIfCurrentlyBooted(
  deviceId: string,
  platform: Platform,
): Promise<void> {
  if (platform !== "android" && platform !== "ios") {
    return;
  }
  const bootedDevices = await PlatformDeviceManagerFactory.getInstance().getBootedDevices(platform);
  await reconcileDiscoveryObservation(bootedDevices, "setActiveDevice:resumeCtrlProxy");
  if (!bootedDevices.some((device) => device.deviceId === deviceId)) {
    return;
  }
  if (
    DaemonState.getInstance().isInitialized() &&
    (await DaemonState.getInstance().getDevicePool().isShutdownReserved(deviceId))
  ) {
    return;
  }
  if (platform === "android") {
    AndroidCtrlProxyClient.resumeAfterDeviceStart(deviceId);
  } else {
    IOSCtrlProxyClient.resumeAfterDeviceStart(deviceId);
  }
}

// Schema definitions
export const setActiveDeviceSchema = addSessionUuidToSchema(
  z
    .object({
      deviceId: z.string(),
      display: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Session display pin: display key or inner/cover/rear/external; null clears, omitted preserves. On single-display devices, active resolves to the sole key; on multi-display devices active cannot be pinned. all cannot be pinned. Requires a daemon session. JSON result displayPin reports the resulting selector or null after clearing; omitted for a never-pinned session.",
        ),
      // #5870: the platform is inferred from the resolved device (or the session),
      // so callers targeting a concrete `deviceId` need not also send `platform`.
      platform: platformSchema.optional(),
    })
    .strict(),
);

const changeLocalizationBaseSchema = z
  .object({
    // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
    // not required — a device handle from getAndroid/getApple is sufficient on
    // its own.
    platform: platformSchema.optional(),
    appId: z.string().min(1).optional().describe("Android app package for locale changes"),
    locale: z.string().min(1).optional().describe("Locale tag (e.g., ar-SA, ja-JP)"),
    timeZone: z.string().min(1).optional().describe("Zone ID (e.g., America/Los_Angeles)"),
    textDirection: z.enum(["ltr", "rtl"]).optional().describe("Text direction"),
    timeFormat: z.enum(["12", "24"]).optional().describe("Time format"),
    calendarSystem: z
      .string()
      .min(1)
      // ICU calendar keywords are lowercase tokens beginning with a letter.
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional()
      .describe("Calendar system (e.g., gregory, japanese, buddhist, islamic-civil)"),
    restartApp: z
      .string()
      .min(1)
      .optional()
      .describe("iOS bundle ID to relaunch after locale change"),
  })
  .strict();

export const changeLocalizationSchema = withAppIdAliases(
  addDeviceTargetingToSchema(changeLocalizationBaseSchema),
).superRefine((values, ctx) => {
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
  if (values.appId && !values.locale) {
    ctx.addIssue({
      code: "custom",
      path: ["appId"],
      message: "appId only applies when locale is provided.",
    });
  }
  // #6154 follow-up: `platform` is optional here (resolved from
  // deviceId/session), so a platform-dependent check at parse time would
  // run before that resolution and could miss real violations, or reject
  // valid requests, when the caller omitted platform. Those checks
  // (`appId` requires/implies Android) run in `changeLocalizationHandler`
  // instead, against the resolved `device.platform`.
});

const doNotDisturbStateInputSchema = z
  .object({
    enabled: z.boolean().optional().describe("Enable or disable Do Not Disturb"),
    mode: doNotDisturbModeSchema.optional().describe("Do Not Disturb mode"),
  })
  .refine((values) => values.enabled !== undefined || values.mode !== undefined, {
    message: "Provide enabled or mode for doNotDisturb",
  });

const biometricStateInputSchema = z.object({
  enrollment: biometricEnrollmentSchema.describe("Set iOS Simulator biometric enrollment state."),
});

const connectivityStateInputSchema = z
  .object({
    airplaneMode: z.boolean().optional().describe("Enable or disable Airplane mode on Android."),
    wifiEnabled: z.boolean().optional().describe("Enable or disable Wi-Fi on Android."),
    bluetoothEnabled: z.boolean().optional().describe("Enable or disable Bluetooth on Android."),
    locationEnabled: z.boolean().optional().describe("Enable or disable Location on Android."),
  })
  .refine(
    (values) =>
      values.airplaneMode !== undefined ||
      values.wifiEnabled !== undefined ||
      values.bluetoothEnabled !== undefined ||
      values.locationEnabled !== undefined,
    { message: "Provide at least one connectivity field to set" },
  );

const staticLocationInputSchema = z
  .object({
    mode: z.literal("static").describe("Apply one static coordinate."),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();

const waypointSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    altitude: z.number().finite().optional(),
  })
  .strict();
const routeBaseSchema = z.object({
  mode: z.literal("route"),
  waypoints: z.array(waypointSchema).min(2),
  loop: z.boolean().optional(),
  updateIntervalMs: z.number().int().min(200).max(60000).optional(),
});
const locationInputSchema = z.union([
  staticLocationInputSchema,
  routeBaseSchema.extend({ speedMetersPerSecond: z.number().finite().positive() }).strict(),
  routeBaseSchema.extend({ durationMs: z.number().finite().positive() }).strict(),
  z.object({ mode: z.literal("stop") }).strict(),
]);

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
    profile: networkConditionProfileSchema
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

// Display configuration (issue #6096): font scale, effective density, and
// light/dark theme. A call with no set field is a getter; any set field (or
// `reset`) makes it a setter that returns applied + previous values so the
// client can restore. Android supports all three fields; the iOS Simulator
// supports theme only (via `simctl ui appearance`); physical iOS has no
// automatable per-device control for any field.
export const displayConfigSchema = addDeviceTargetingToSchema(
  z
    .object({
      fontScale: z
        .union([z.number().min(0.1).max(10), z.literal("default")])
        .optional()
        .describe(
          "System text scale, or 'default' to remove Android's explicit override and restore " +
            "its inherited default. Android only. Omit to leave unchanged.",
        ),
      density: z
        .union([z.number().min(72), z.enum(["smaller", "default", "larger"])])
        .optional()
        .describe(
          "Effective display density: an explicit dpi (e.g. 480), or a relative bucket " +
            "(smaller/default/larger). Android only; best-effort on physical devices. Omit to " +
            "leave unchanged.",
        ),
      theme: z
        .enum(["light", "dark", "system", "custom"])
        .optional()
        .describe(
          "Light, dark, system (follow-device), or custom (Android user-defined night-mode " +
            "schedule) theme / night mode. Supported on Android; the iOS Simulator supports only " +
            "'light'/'dark'. 'custom' mainly exists to restore a device previously on a custom " +
            "schedule (from an earlier call's `previous.theme`). Omit to leave unchanged.",
        ),
      reset: z
        .boolean()
        .optional()
        .describe(
          "On Android, restore font scale and density to device defaults. Restore night mode only " +
            "to the value displayConfig replaced earlier in this process; otherwise leave it unchanged. " +
            "Android reset never forces light mode. On the iOS Simulator, reset restores light appearance.",
        ),
    })
    .strict(),
).superRefine((values, ctx) => {
  if (
    values.reset === true &&
    (values.fontScale !== undefined || values.density !== undefined || values.theme !== undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["reset"],
      message: "reset cannot be combined with fontScale, density, or theme; send reset on its own.",
    });
  }
});

export const getDeviceStateSchema = addDeviceTargetingToSchema(
  z
    .object({
      include: z
        .array(z.enum(DEVICE_STATE_READABLE_FIELDS))
        .min(1)
        .optional()
        .describe(
          "State fields to read; supports doNotDisturb, connectivity, biometrics, " +
            "networkCondition, and clock. Defaults to doNotDisturb + connectivity, so a bare call answers " +
            "whether Airplane mode / Wi-Fi / Bluetooth / Location are already on.",
        ),
    })
    .strict(),
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
  { required: ["delayMs"], properties: { delayMs: {} } },
  { required: ["downloadKbps"], properties: { downloadKbps: {} } },
  { required: ["uploadKbps"], properties: { uploadKbps: {} } },
  { required: ["packetLossPercent"], properties: { packetLossPercent: {} } },
];

export const setDeviceStateSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        doNotDisturb: doNotDisturbStateInputSchema
          .optional()
          .describe("Do Not Disturb state to apply."),
        biometrics: biometricStateInputSchema
          .optional()
          .describe("iOS Simulator biometric enrollment state to apply."),
        connectivity: connectivityStateInputSchema
          .optional()
          .describe("Android connectivity toggles to apply."),
        networkCondition: networkConditionInputSchema
          .optional()
          .describe("Device-wide network condition to apply (Android emulator only)."),
        clock: deviceClockInputSchema
          .optional()
          .describe(
            "Set the real clock within 2000-01-01T00:00:00Z .. 2100-01-01T00:00:00Z, advance by integer byMs >= 1000 with second-level precision, or reset to host time and original auto_time (1 without a recorded slot). Rootable Android emulators only.",
          ),
        location: locationInputSchema
          .optional()
          .describe(
            "Set a static fix, start a timed route, or stop route playback on an Android emulator or iOS Simulator.",
          ),
      })
      .strict(),
  ).refine(
    (values) =>
      values.doNotDisturb !== undefined ||
      values.biometrics !== undefined ||
      values.connectivity !== undefined ||
      values.networkCondition !== undefined ||
      values.location !== undefined ||
      values.clock !== undefined,
    {
      message: "At least one device state field must be provided",
    },
  ),
  (jsonSchema) => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>> | undefined;
    const networkCondition = properties?.networkCondition;
    if (networkCondition) {
      networkCondition.anyOf = NETWORK_CONDITION_REQUIRED_ANY_OF;
    }
  },
);

// Export interfaces for type safety
export interface ChangeLocalizationArgs {
  // #6154: optional — resolved from deviceId/session when omitted.
  platform?: Platform;
  appId?: string;
  locale?: string;
  timeZone?: string;
  textDirection?: "ltr" | "rtl";
  timeFormat?: "12" | "24";
  calendarSystem?: string;
  restartApp?: string;
}

/**
 * #6154 follow-up: `platform` is optional on the wire (resolved from
 * deviceId/session), so the appId<->platform cross-checks that used to live in
 * `changeLocalizationSchema`'s `superRefine` cannot run there anymore — at
 * parse time the effective platform may not be known yet (the caller may have
 * omitted it entirely). Run them here instead, against the resolved
 * `device.platform`, exported standalone so the constraint itself is directly
 * testable without a real `SystemConfigurationManager`.
 */
export function assertChangeLocalizationPlatformConstraints(
  platform: Platform,
  args: Pick<ChangeLocalizationArgs, "appId" | "locale">,
): void {
  if (args.appId && platform !== "android") {
    throw new ActionableError("appId is only supported for Android locale changes.");
  }
  if (platform === "android" && args.locale && !args.appId) {
    throw new ActionableError("appId is required for Android locale changes.");
  }
}

export type DisplayConfigArgs = z.infer<typeof displayConfigSchema>;

/** A displayConfig call is a setter when it carries reset or any display field. */
function displayConfigArgsAreSet(args: DisplayConfigArgs): boolean {
  return (
    args.reset === true ||
    args.fontScale !== undefined ||
    args.density !== undefined ||
    args.theme !== undefined
  );
}

/** Project the wire args onto the feature's set-input shape, dropping absent fields. */
function displayConfigSetInput(args: DisplayConfigArgs): SetDisplayConfigInput {
  return {
    ...(args.fontScale !== undefined ? { fontScale: args.fontScale } : {}),
    ...(args.density !== undefined ? { density: args.density } : {}),
    ...(args.theme !== undefined ? { theme: args.theme } : {}),
    ...(args.reset !== undefined ? { reset: args.reset } : {}),
  };
}

function displayConfigMessage(result: DisplayConfigResult): string {
  if (result.success) {
    return result.applied ? "Applied display configuration" : "Read display configuration";
  }
  return result.error ?? "Failed to apply display configuration";
}

function deviceStateMessage(result: DeviceStateResult): string {
  if (!result.success) {
    return result.error ?? "Failed to read device state";
  }

  const sections = [
    doNotDisturbMessage(result),
    connectivityMessage(result),
    biometricsMessage(result),
    networkConditionMessage(result),
  ].filter((section): section is string => section !== undefined);
  return sections.length > 0 ? sections.join("; ") : "Read device state";
}

function doNotDisturbMessage(result: DeviceStateResult): string | undefined {
  if (!result.doNotDisturb?.supported) {
    return undefined;
  }
  const { enabled, mode } = result.doNotDisturb;
  return enabled === false ? "DND off" : mode ? `DND on (${mode})` : "DND on";
}

function connectivityMessage(result: DeviceStateResult): string | undefined {
  if (!result.connectivity?.supported) {
    return undefined;
  }
  const { airplaneMode, wifiEnabled, bluetoothEnabled, locationEnabled } = result.connectivity;
  const connectivity = [
    connectivityStateMessage("Wi-Fi", wifiEnabled),
    connectivityStateMessage("Bluetooth", bluetoothEnabled),
    connectivityStateMessage("Location", locationEnabled),
    connectivityStateMessage("Airplane", airplaneMode),
  ].filter((state): state is string => state !== undefined);
  return connectivity.length > 0 ? connectivity.join(", ") : undefined;
}

function connectivityStateMessage(name: string, enabled: boolean | undefined): string | undefined {
  return enabled === undefined ? undefined : `${name} ${enabled ? "on" : "off"}`;
}

function biometricsMessage(result: DeviceStateResult): string | undefined {
  const enrollment = result.biometrics?.supported ? result.biometrics.enrollment : undefined;
  return enrollment === undefined ? undefined : `Biometrics ${enrollment}`;
}

function networkConditionMessage(result: DeviceStateResult): string | undefined {
  const profile = result.networkCondition?.supported ? result.networkCondition.profile : undefined;
  return profile === undefined ? undefined : `Network ${profile}`;
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

interface LocalizationChanges {
  locale?: string;
  timeZone?: string;
  textDirection?: "ltr" | "rtl";
  timeFormat?: "12" | "24";
  calendarSystem?: string;
}

interface LocalizationLocaleMetadata {
  localeScope?: "app" | "system";
  localeAppId?: string;
  localeMethod?: string;
}

async function applyLocaleChange(
  manager: SystemConfigurationManager,
  device: BootedDevice,
  args: ChangeLocalizationArgs,
  changes: LocalizationChanges,
  errors: string[],
): Promise<LocalizationLocaleMetadata> {
  const localeOptions =
    args.appId && device.platform === "android"
      ? { broadcast: false, appId: args.appId }
      : { broadcast: false };
  const result = await manager.setLocale(args.locale!, localeOptions);
  if (result.success) {
    changes.locale = result.languageTag;
    // Prefer the scope the adapter reports directly (issue #6346): on
    // Android < 13 a per-app request is forced device-wide, and the adapter
    // says so via localeScope: "system" rather than us inferring it from the
    // method string.
    const localeScope =
      result.localeScope ??
      (result.method?.startsWith("cmd locale set-app-locales") ? "app" : "system");
    return {
      localeScope,
      ...(args.appId && device.platform === "android" ? { localeAppId: args.appId } : {}),
      ...(result.method ? { localeMethod: result.method } : {}),
    };
  } else {
    errors.push(result.error ?? "Failed to set locale");
  }
  return {};
}

async function applyTextDirectionChange(
  manager: SystemConfigurationManager,
  textDirection: "ltr" | "rtl",
  changes: LocalizationChanges,
  errors: string[],
): Promise<void> {
  const rtl = textDirection === "rtl";
  const result = await manager.setTextDirection(rtl, { broadcast: false });
  if (result.success) {
    changes.textDirection = rtl ? "rtl" : "ltr";
  } else {
    errors.push(result.error ?? "Failed to set text direction");
  }
}

async function applyAdditionalLocalizationChanges(
  manager: SystemConfigurationManager,
  args: ChangeLocalizationArgs,
  changes: LocalizationChanges,
  errors: string[],
): Promise<void> {
  if (args.timeZone !== undefined) {
    const result = await manager.setTimeZone(args.timeZone);
    if (result.success) {
      changes.timeZone = result.zoneId;
    } else {
      errors.push(result.error ?? "Failed to set time zone");
    }
  }

  if (args.textDirection !== undefined) {
    await applyTextDirectionChange(manager, args.textDirection, changes, errors);
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
}

const changeLocalizationHandler = async (device: BootedDevice, args: ChangeLocalizationArgs) => {
  assertChangeLocalizationPlatformConstraints(device.platform, args);

  const manager = new SystemConfigurationManager(device);
  const changes: LocalizationChanges = {};
  const errors: string[] = [];
  let localeMetadata: LocalizationLocaleMetadata = {};

  if (args.locale !== undefined) {
    localeMetadata = await applyLocaleChange(manager, device, args, changes, errors);
  }

  await applyAdditionalLocalizationChanges(manager, args, changes, errors);

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

const displayConfigHandler = async (device: BootedDevice, args: DisplayConfigArgs) => {
  const displayConfig = new DisplayConfig(device);
  const result = displayConfigArgsAreSet(args)
    ? await displayConfig.setConfig(displayConfigSetInput(args))
    : await displayConfig.getConfig();
  const response = createJSONToolResponse({
    message: displayConfigMessage(result),
    ...result,
  });
  return result.success ? response : { ...response, isError: true as const };
};

const getDeviceStateHandler = async (device: BootedDevice, args: GetDeviceStateArgs) => {
  const deviceState = new DeviceState(device);
  const result = await deviceState.getState(args.include);

  return createStructuredToolResponse({
    message: deviceStateMessage(result),
    ...result,
  });
};

// Register tools
export function registerUtilityTools(
  options: { displayInventory?: DisplayInventoryProvider } = {},
) {
  const setActiveDeviceHandler = createSetActiveDeviceHandler({
    displayInventory: options.displayInventory,
    resumeCtrlProxy: resumeCtrlProxyIfCurrentlyBooted,
  });

  const setDeviceStateHandler = async (device: BootedDevice, args: SetDeviceStateArgs) => {
    if (args.clock !== undefined) {
      validateDeviceClockInput(args.clock);
    }
    const sessionManager =
      args.sessionUuid && DaemonState.getInstance().isInitialized()
        ? DaemonState.getInstance().getSessionManager()
        : undefined;
    const deviceState = new DeviceState(device, {
      clockMutation: (mutation) =>
        runSessionClockMutation(sessionManager, args.sessionUuid, device.deviceId, mutation),
      canWriteLocation: createSessionLocationWriteAdmission({
        sessionManager,
        sessionUuid: args.sessionUuid,
        deviceId: device.deviceId,
      }),
      onLocationApplied: createSessionLocationAppliedCallback({
        sessionManager,
        sessionUuid: args.sessionUuid,
        device,
      }),
    });
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
      return createStructuredToolResponse({
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
    const applyLocationTracked = (input: SetDeviceStateInput): Promise<DeviceStateResult> =>
      input.location && !capture.sessionManager
        ? runSessionLocationMutation({
            sessionManager,
            sessionUuid: args.sessionUuid,
            deviceId: device.deviceId,
            mutation: () => applyStateTracked(input),
          })
        : applyStateTracked(input);
    if (capture.failure) {
      const result = await applyStateAfterBiometricCaptureFailure(
        { setState: applyStateTracked },
        {
          doNotDisturb: args.doNotDisturb,
          biometrics: args.biometrics,
          connectivity: args.connectivity,
          networkCondition: args.networkCondition,
          location: args.location,
          clock: args.clock,
        },
        capture.failure,
      );
      return createStructuredToolResponse({
        message: result.error ?? "Failed to read biometric enrollment state",
        ...result,
      });
    }

    const mutation = () =>
      applyLocationTracked({
        doNotDisturb: args.doNotDisturb,
        biometrics: args.biometrics,
        connectivity: args.connectivity,
        networkCondition: args.networkCondition,
        location: args.location,
        clock: args.clock,
      });

    const result = await runSessionBiometricMutation(
      capture.sessionManager,
      args.sessionUuid,
      device.deviceId,
      capture.initialEnrollment,
      mutation,
    );

    return createStructuredToolResponse({
      message: result.success
        ? "Applied device state"
        : (result.error ?? "Failed to apply device state"),
      ...result,
    });
  };

  // Register with the tool registry
  ToolRegistry.register(
    "setActiveDevice",
    "Set active device using existing session binding or legacy global selection. With a daemon session, display pins a display key or role (inner/cover/rear/external); null clears, omission preserves. Explicit display arguments (including active) bypass the pin; otherwise pin beats focus/posture. On single-display devices, active resolves to the sole key; on multi-display devices active cannot be pinned. all cannot be pinned. Missing or inactive pinned panels fail without dispatch; clear with display: null. Pins clear on release/rebind and are unsupported in direct mode. Returns a text JSON result with message, deviceId, optional sessionUuid, and displayPin (string or null) when display was passed or a pin is present/cleared; never-pinned calls omit displayPin.",
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
    "displayConfig",
    "Read or set the visual display configuration — font/text scale, effective display density, and light/dark (night mode) theme — for adaptive-layout and large-font accessibility testing. A call with no set field reads current values; providing fontScale, density, theme, or reset applies the change and returns applied + previous values so the client can restore. Android supports all three fields (density overrides are best-effort on physical devices); the iOS Simulator supports theme only (via `simctl ui appearance`); physical iOS devices are unsupported. On Android, reset restores font scale and density to device defaults and restores night mode only to the value displayConfig replaced earlier in this process; otherwise night mode is left unchanged. Android reset never forces light mode. iOS Simulator reset restores light appearance.",
    displayConfigSchema,
    displayConfigHandler,
    { defaultEnabled: false },
  );

  ToolRegistry.registerDeviceAware(
    "getDeviceState",
    "Read device-level state including clock (Android epoch-second instant and automaticTime, readable without root; unsupported on iOS), Do Not Disturb, the connectivity toggles (airplaneMode, wifiEnabled, bluetoothEnabled, locationEnabled), iOS Simulator biometric enrollment, and device-wide network condition. Use it as the idempotency oracle before flipping a toggle — a bare call returns doNotDisturb + connectivity, so you can check whether Airplane mode is already on instead of inferring it from the status bar. Each connectivity field is true/false, or omitted when the device could not answer (the key is absent on this API level, or the value did not parse) — omitted never means off. Android only: iOS reports connectivity unsupported, because Airplane mode / Wi-Fi / Bluetooth / Location have no simctl or devicectl read verb and a simulator shares the host's network stack." +
      " Clock control supports only rootable Android emulators; Play Store images, physical devices and iOS return unsupported. Set accepts ISO-8601 instants within 2000-01-01T00:00:00Z .. 2100-01-01T00:00:00Z (inclusive); cumulative advance must stay in that window. Commands have second-level precision; advance requires integer byMs >= 1000 (maximum 315360000000), uses device read-back time, and verifies movement with a 2000ms tolerance; set within tolerance reports outcome=unchanged. On session release/rebind/teardown/reset, AutoMobile explicitly restores HOST-derived real time plus the original auto_time, even if it was 1, and verifies both. Failed restore is retried and quarantines the device until success or removal. Clock control restarts adbd on the emulator; connections such as port forwards may be re-established. Restore unroots adbd if AutoMobile rooted it (bounded, best-effort). Hierarchy/observe caches and freshness baselines are invalidated on every clock change. The restore slot is in memory only: daemon restart loses it; reset is recovery to HOST time plus auto_time=1 on a rootable emulator. Without a slot, unsupported targets report unsupported/nothing to reset without clock mutations; with a slot, refused root reports failure and retains pending restoration. Sessionless callers must reset explicitly. Session-bound and sessionless clock writes share one device queue and original ownership baseline; session release restores the device while sessionless ownership persists until reset or removal. Removal cancels clock work for that device incarnation. Changing the clock affects TLS/certificate validation, token expiry, and freshness checks.",
    getDeviceStateSchema,
    getDeviceStateHandler,
    { defaultEnabled: false, outputSchema: getDeviceStateResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "setDeviceState",
    "Set device state such as Do Not Disturb, Android connectivity toggles (airplaneMode, wifiEnabled, bluetoothEnabled, locationEnabled), static location or background route playback on an Android emulator or iOS Simulator, iOS Simulator biometric enrollment, and device-wide network condition. A static fix, replacement route, or stop cancels the active route. The location result may include previousRoute with endedReason and lastError; stop also reports whether a route was active. On release or rebind of a session that set a location, iOS Simulator clears it with `simctl location clear`; failed clears are retried and quarantine the device until success or removal. Android emulator fixes persist after the session because the emulator console has no unset command; reset the fix explicitly if needed. Direct-mode (sessionless) calls are unchanged; an existing session marker on the device also clears later sessionless fixes on release. Connectivity values are desired end states and are verified by a fresh Android read; iOS connectivity writes are unsupported. Degraded network profiles (offline/veryBad/2g/3g/4g) are best-effort cellular shaping on an Android emulator, reported `partial` (they may not affect Wi-Fi/app traffic); only reset to `none` is fully verified. A session always restores the network to a clean `none` state on release/rebind." +
      " Clock control supports only rootable Android emulators; Play Store images, physical devices and iOS return unsupported. Set accepts ISO-8601 instants within 2000-01-01T00:00:00Z .. 2100-01-01T00:00:00Z (inclusive); cumulative advance must stay in that window. Commands have second-level precision; advance requires integer byMs >= 1000 (maximum 315360000000), uses device read-back time, and verifies movement with a 2000ms tolerance; set within tolerance reports outcome=unchanged. On session release/rebind/teardown/reset, AutoMobile explicitly restores HOST-derived real time plus the original auto_time, even if it was 1, and verifies both. Failed restore is retried and quarantines the device until success or removal. Clock control restarts adbd on the emulator; connections such as port forwards may be re-established. Restore unroots adbd if AutoMobile rooted it (bounded, best-effort). Hierarchy/observe caches and freshness baselines are invalidated on every clock change. The restore slot is in memory only: daemon restart loses it; reset is recovery to HOST time plus auto_time=1 on a rootable emulator. Without a slot, unsupported targets report unsupported/nothing to reset without clock mutations; with a slot, refused root reports failure and retains pending restoration. Sessionless callers must reset explicitly. Session-bound and sessionless clock writes share one device queue and original ownership baseline; session release restores the device while sessionless ownership persists until reset or removal. Removal cancels clock work for that device incarnation. Changing the clock affects TLS/certificate validation, token expiry, and freshness checks.",
    setDeviceStateSchema,
    setDeviceStateHandler,
    { defaultEnabled: false, outputSchema: setDeviceStateResultSchema },
  );
}
