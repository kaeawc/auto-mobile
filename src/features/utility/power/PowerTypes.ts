import { z } from "zod/v4";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../../../utils/androidPackageName";

/** Charger source `dumpsys battery` can report or fake. */
export const BATTERY_CHARGING_VALUES = ["ac", "usb", "wireless", "none"] as const;
export type BatteryCharging = (typeof BATTERY_CHARGING_VALUES)[number];

/** The App Standby buckets `am set-standby-bucket` accepts, least to most restricted. */
export const STANDBY_BUCKETS = ["active", "working_set", "frequent", "rare", "restricted"] as const;
export type StandbyBucket = (typeof STANDBY_BUCKETS)[number];
/** A bucket a device can report: the settable ones plus the two it will not let a shell set. */
export type ObservedStandbyBucket = StandbyBucket | "exempted" | "never" | "unknown";

export const DOZE_MODES = ["off", "light", "deep"] as const;
export type DozeMode = (typeof DOZE_MODES)[number];

const appIdSchema = z
  .string()
  .regex(ANDROID_PACKAGE_NAME_PATTERN, "power appId must be an Android package name");

const batteryInputSchema = z
  .object({
    level: z.number().int().min(0).max(100).optional().describe("Fake battery level, 0-100."),
    charging: z
      .enum(BATTERY_CHARGING_VALUES)
      .optional()
      .describe("Fake charger source: ac, usb, wireless, or none (unplugged)."),
    reset: z
      .boolean()
      .optional()
      .describe("true: return the battery to real values (`dumpsys battery reset`)."),
  })
  .strict()
  .refine(
    (battery) => battery.level !== undefined || battery.charging !== undefined || battery.reset,
    {
      message: "power.battery needs level, charging, or reset: true",
    },
  )
  .refine((battery) => !(battery.reset && (battery.level !== undefined || battery.charging)), {
    message: "power.battery.reset cannot be combined with level or charging",
  });

export const THERMAL_STATUS_VALUES = [0, 1, 2, 3, 4, 5, 6] as const;

/** `setDeviceState.power` (#14084): the power-constraint state production bugs hide behind. */
export const powerInputSchema = z
  .object({
    battery: batteryInputSchema.optional(),
    batterySaver: z.boolean().optional().describe("Turn battery saver on or off."),
    doze: z
      .enum(DOZE_MODES)
      .optional()
      .describe(
        "Force light or deep Doze, or leave it (off). light/deep unplug the battery and turn the screen off first.",
      ),
    standbyBucket: z
      .object({ appId: appIdSchema, bucket: z.enum(STANDBY_BUCKETS) })
      .strict()
      .optional()
      .describe("Put an app in an App Standby bucket (restricted needs API 30+)."),
    appInactive: z
      .object({ appId: appIdSchema, inactive: z.boolean() })
      .strict()
      .optional()
      .describe("Mark an app inactive (idle) or active."),
    dataSaver: z
      .boolean()
      .optional()
      .describe("Turn Data Saver (restrict background data) on or off."),
    thermalStatus: z
      .union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
        z.literal("reset"),
      ])
      .optional()
      .describe("Override the thermal status 0 (none) to 6 (shutdown), or reset it (API 29+)."),
  })
  .strict()
  .refine((power) => Object.values(power).some((value) => value !== undefined), {
    message: "power needs at least one field",
  });

export type SetPowerInput = z.infer<typeof powerInputSchema>;

/** Everything a session can change and release restores, in the order changes are applied. */
export type PowerField =
  | "battery"
  | "screen"
  | "doze"
  | "batterySaver"
  | "dataSaver"
  | "thermal"
  | "standby"
  | "inactive";

/** Typed refusals; each is the `errorCode` of a result that applied nothing. */
export const POWER_UNSUPPORTED_API = "power_unsupported_api_level";
export const POWER_PHYSICAL_DEVICE_REFUSED = "power_physical_device_refused";
export const POWER_DOZE_REQUIRES_UNPLUGGED = "power_doze_requires_unplugged";
export const POWER_DOZE_UNAVAILABLE = "power_doze_unavailable";
export const POWER_BASELINE_UNREADABLE = "power_baseline_unreadable";
export const POWER_COMMAND_FAILED = "power_command_failed";

export type PowerErrorCode =
  | typeof POWER_UNSUPPORTED_API
  | typeof POWER_PHYSICAL_DEVICE_REFUSED
  | typeof POWER_DOZE_REQUIRES_UNPLUGGED
  | typeof POWER_DOZE_UNAVAILABLE
  | typeof POWER_BASELINE_UNREADABLE
  | typeof POWER_COMMAND_FAILED;

export const POWER_UNSUPPORTED_ERROR =
  "power is Android-only: iOS has no battery, Doze or thermal controls.";

/** Battery as `dumpsys battery` reports it. */
export interface BatteryReading {
  level: number;
  charging: BatteryCharging;
  /** `charging`, `discharging`, `not_charging`, `full` or `unknown`. */
  status: string;
  /** A fake is in effect (`UPDATES STOPPED`): the values are not the real battery's. */
  faked: boolean;
}

/** Light and deep idle state machine positions from `dumpsys deviceidle get`. */
export interface DozeReading {
  mode: DozeMode;
  deep: string;
  light: string;
}

export interface ThermalReading {
  status: number;
  override: boolean;
}

export interface StandbyReading {
  appId: string;
  bucket?: ObservedStandbyBucket;
  inactive?: boolean;
}

/** `power` as getDeviceState and setDeviceState report it. */
export interface PowerState {
  supported: boolean;
  battery?: BatteryReading;
  /** Absent when the setting is unset or unreadable. */
  batterySaver?: boolean;
  doze?: DozeReading;
  dataSaver?: boolean;
  thermal?: ThermalReading;
  /** The apps this session changed (App Standby bucket and inactive state). */
  standby?: StandbyReading[];
  /** Fields the device could not answer (a probe failed), not fields that are off. */
  unreadable?: string[];
  /** Fields this call changed. */
  applied?: PowerField[];
  /** Steps taken so the request could apply, in order (e.g. unplug and screen off for Doze). */
  preconditions?: string[];
  /** Values read before the first change, for restoring by hand (a session restores them itself). */
  restoreReceipt?: PowerRestoreReceipt;
  /** Session release restores the changed fields (false for a sessionless change). */
  restoreOnRelease?: boolean;
  verified?: boolean;
  /** Requested values a fresh read did not confirm. */
  mismatches?: string[];
  errorCode?: PowerErrorCode;
  warning?: string;
  error?: string;
}

/** The values a session's changes replaced, as read before the first change. */
export interface PowerRestoreReceipt {
  battery?: BatteryReading;
  screenOn?: boolean;
  doze?: DozeMode;
  /** `null`: the setting was unset. */
  batterySaver?: boolean | null;
  dataSaver?: boolean;
  thermal?: ThermalReading;
  standby?: Record<string, ObservedStandbyBucket>;
  inactive?: Record<string, boolean>;
}

export interface PowerFieldRestoreReport {
  field: PowerField;
  status: "restored" | "failed" | "skipped";
  /** The device was read back and matches the baseline. */
  verified?: boolean;
  error?: string;
}

/** Outcome of restoring a session's power changes at release, surfaced in the release result. */
export interface PowerRestoreReport {
  status: "restored" | "partial" | "failed" | "skipped";
  deviceId: string;
  fields: PowerFieldRestoreReport[];
  /** For a failure: what may still be changed on the device and how to undo it. */
  leftover?: string;
  error?: string;
}

/** The `setDeviceState.power` field description (kept here to spare utilityTools.ts). */
export const POWER_INPUT_DESCRIPTION =
  "Android only. Fake power constraints: battery {level 0-100, charging ac|usb|wireless|none, reset}, " +
  "batterySaver, doze off|light|deep (light/deep unplug the battery and turn the screen off first and " +
  "report these as preconditions), standbyBucket {appId, bucket}, appInactive {appId, inactive}, " +
  "dataSaver and thermalStatus 0-6 or reset. Battery, Doze and thermal faking is refused on physical " +
  "devices (errorCode power_physical_device_refused); thermal override needs API 29+ and the " +
  "restricted bucket API 30+ (errorCode power_unsupported_api_level). The result carries a " +
  "restoreReceipt; a session restores every changed field in reverse order on release and reports " +
  "failures in the release result (powerRestore). A sessionless change is never restored automatically.";
