import { z } from "zod";
import { DEVICE_CLOCK_TOLERANCE_MS, MAX_DEVICE_CLOCK_ADVANCE_MS } from "../utility/DeviceClock";

/**
 * Session-scoped device-condition fixtures (#14050, epic #14047): root, integrity
 * and fault states a caller puts a device into for a test, each paired with a
 * reset that release, rebind, lease expiry or an explicit reset runs.
 *
 * This is the surface every injector plugs into. Each field accepts only `"unset"`
 * (clear that condition) until its injector lands and widens the enum, so the tool
 * never advertises a condition it cannot apply.
 */
export const DEVICE_CONDITION_SCHEMA_VERSION = 1;

/** Longest lease a single request may set; renewing re-arms it. */
export const DEVICE_CONDITION_MAX_LEASE_SECONDS = 86_400;

/** The condition keys an injector can own. Fault keys are `faults.<name>`. */
export type DeviceConditionKey =
  | "rootState"
  | "integrityState"
  | `faults.${string}`
  | `vehicle.${string}`;

/** A request value; `"unset"` clears the condition instead of applying one. */
export const DEVICE_CONDITION_UNSET = "unset";

/**
 * The injector value for a fault requested with an object (#14069), whose fields travel as the
 * change's `params`. A fault with parameters has no enum value to hand the injector.
 */
export const DEVICE_CONDITION_APPLY = "apply";

/** Android application ID: dot-separated segments, each starting with a letter. */
export const ANDROID_PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/**
 * A path inside an app's data directory: relative, dot-separated names joined by `/`, no empty or
 * `..` segment. The path is interpolated into a device shell command, so only these characters pass.
 */
export const APP_FILE_PATH_PATTERN =
  /^(?!\.{1,2}(?:\/|$))[A-Za-z0-9_.-]+(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9_.-]+)*$/;

/** A full permission name, or a bare platform constant such as `CAMERA`. */
export const ANDROID_PERMISSION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.]*$/;

/** The app a package-state fault targets. */
export interface DeviceConditionPackageTarget {
  package: string;
}

/** The app file a `corruptAppFile` fault damages, and how. */
export interface DeviceConditionCorruptTarget {
  package: string;
  /** Relative to the app's data directory, e.g. `databases/app.db`. */
  path: string;
  mode: "overwrite" | "truncate";
}

/** The app a `killApp` fault ends, and how. */
export interface DeviceConditionKillTarget {
  package: string;
  mode: "background" | "forceStop";
}

/** The app a `trimMemory` fault signals, and the `onTrimMemory` level it sends. */
export interface DeviceConditionTrimTarget {
  package: string;
  level:
    | "HIDDEN"
    | "RUNNING_MODERATE"
    | "BACKGROUND"
    | "RUNNING_LOW"
    | "MODERATE"
    | "RUNNING_CRITICAL"
    | "COMPLETE";
}

/** How far a `clockSkew` fault moves the device clock from real time, in whole seconds. */
export interface DeviceConditionClockSkew {
  offsetSeconds: number;
}

/** The app and runtime permission a `revokePermission` fault targets. */
export interface DeviceConditionPermissionTarget {
  package: string;
  permission: string;
}

/**
 * A validated `deviceCondition` request. Declared as an explicit interface (not
 * `z.infer`) so that embedding {@link deviceConditionInputSchema} in the large
 * `setDeviceState` schema references this named type instead of re-inferring the
 * deep structure, which otherwise pushes tsgo past its instantiation limit and
 * collapses the whole parent schema's inference to `unknown`.
 */
export interface DeviceConditionInput {
  version?: typeof DEVICE_CONDITION_SCHEMA_VERSION;
  rootState?: "rooted-detectable" | typeof DEVICE_CONDITION_UNSET;
  integrityState?: typeof DEVICE_CONDITION_UNSET;
  /**
   * Power-domain fault injectors (#14063), each optional and each clearable with
   * `"unset"`. More fault families add their key here as they land. Kept as named
   * optional fields (not an open record) so the advertised contract is explicit.
   */
  faults?: {
    battery?: "unplug" | "low" | "full" | typeof DEVICE_CONDITION_UNSET;
    lowPower?: "on" | typeof DEVICE_CONDITION_UNSET;
    doze?: "on" | typeof DEVICE_CONDITION_UNSET;
    thermal?: "throttling" | "critical" | typeof DEVICE_CONDITION_UNSET;
    /** Process-lifecycle fault (#14068). */
    dontKeepActivities?: "on" | typeof DEVICE_CONDITION_UNSET;
    /** Storage fault (#14066). */
    storage?: "low" | "full" | typeof DEVICE_CONDITION_UNSET;
    /** Corrupt one file in a debuggable app's data directory (#14066). */
    corruptAppFile?: DeviceConditionCorruptTarget | typeof DEVICE_CONDITION_UNSET;
    /** Permission revocation (#14069); the one fault so far that takes an object. */
    revokePermission?: DeviceConditionPermissionTarget | typeof DEVICE_CONDITION_UNSET;
    /** Package state (#14069): disable an app until reset, or clear its data once. */
    disablePackage?: DeviceConditionPackageTarget | typeof DEVICE_CONDITION_UNSET;
    /** Process faults (#14068): end an app's process, or send it a trim-memory level, once. */
    killApp?: DeviceConditionKillTarget | typeof DEVICE_CONDITION_UNSET;
    trimMemory?: DeviceConditionTrimTarget | typeof DEVICE_CONDITION_UNSET;
    clearPackageData?: DeviceConditionPackageTarget | typeof DEVICE_CONDITION_UNSET;
    /** Clock fault (#14069): move the device clock away from real time until reset. */
    clockSkew?: DeviceConditionClockSkew | typeof DEVICE_CONDITION_UNSET;
  };
  /** Automotive vehicle state (#14919), each clearable with `"unset"`. */
  vehicle?: {
    motion?: "parked" | "driving" | typeof DEVICE_CONDITION_UNSET;
    nightMode?: "on" | "off" | typeof DEVICE_CONDITION_UNSET;
  };
  expiresInSeconds?: number;
  reset?: true;
}

/** A fresh schema per field: sharing one instance makes the JSON schema emit a dangling `$ref` for the second use. */
const packageTargetSchema = () =>
  z.object({ package: z.string().regex(ANDROID_PACKAGE_NAME_PATTERN) }).strict();

const corruptTargetSchema = () =>
  z
    .object({
      package: z.string().regex(ANDROID_PACKAGE_NAME_PATTERN),
      path: z.string().regex(APP_FILE_PATH_PATTERN),
      mode: z.enum(["overwrite", "truncate"]),
    })
    .strict();

const killTargetSchema = () =>
  z
    .object({
      package: z.string().regex(ANDROID_PACKAGE_NAME_PATTERN),
      mode: z.enum(["background", "forceStop"]),
    })
    .strict();

const trimTargetSchema = () =>
  z
    .object({
      package: z.string().regex(ANDROID_PACKAGE_NAME_PATTERN),
      level: z.enum([
        "HIDDEN",
        "RUNNING_MODERATE",
        "BACKGROUND",
        "RUNNING_LOW",
        "MODERATE",
        "RUNNING_CRITICAL",
        "COMPLETE",
      ]),
    })
    .strict();

/** The largest clock skew either way: the same ten-year bound as `setDeviceState.clock` advance. */
export const MAX_CLOCK_SKEW_SECONDS = MAX_DEVICE_CLOCK_ADVANCE_MS / 1000;

/** A skew inside the clock's own read-back tolerance could not be told apart from no skew. */
export const MIN_CLOCK_SKEW_SECONDS = Math.ceil(DEVICE_CLOCK_TOLERANCE_MS / 1000) + 1;

/** `faults.clockSkew` parameters; the injector re-validates its params with the same schema. */
export const clockSkewParamsSchema = () =>
  z
    .object({
      offsetSeconds: z
        .number()
        .int()
        .min(-MAX_CLOCK_SKEW_SECONDS)
        .max(MAX_CLOCK_SKEW_SECONDS)
        .refine(
          (value) => Math.abs(value) >= MIN_CLOCK_SKEW_SECONDS,
          `offsetSeconds must be at least ${MIN_CLOCK_SKEW_SECONDS} seconds either way`,
        ),
    })
    .strict();

export const deviceConditionInputSchema: z.ZodType<DeviceConditionInput> = z
  .object({
    version: z
      .literal(DEVICE_CONDITION_SCHEMA_VERSION)
      .optional()
      .describe("Request shape version; only 1 exists."),
    rootState: z
      .enum(["rooted-detectable", DEVICE_CONDITION_UNSET])
      .optional()
      .describe(
        "Root fixture: 'rooted-detectable' plants inert su/busybox stubs and sets SELinux permissive so root-detection checks trip (Android, non-Play image, needs a writable /system); 'unset' restores.",
      ),
    integrityState: z
      .literal(DEVICE_CONDITION_UNSET)
      .optional()
      .describe(
        "Integrity-signal state. Only 'unset' (clear) is available until an integrity injector lands.",
      ),
    faults: z
      .object({
        battery: z
          .enum(["unplug", "low", "full", DEVICE_CONDITION_UNSET])
          .optional()
          .describe("Battery fault via `dumpsys battery` (unplug / low 15% / full), or unset."),
        lowPower: z
          .enum(["on", DEVICE_CONDITION_UNSET])
          .optional()
          .describe("Toggle `settings global low_power`, restored to its prior value, or unset."),
        doze: z
          .enum(["on", DEVICE_CONDITION_UNSET])
          .optional()
          .describe("Force deep Doze via `dumpsys deviceidle force-idle`, or unset."),
        thermal: z
          .enum(["throttling", "critical", DEVICE_CONDITION_UNSET])
          .optional()
          .describe("Override thermal status via `cmd thermalservice override-status`, or unset."),
        dontKeepActivities: z
          .enum(["on", DEVICE_CONDITION_UNSET])
          .optional()
          .describe(
            "Developer options 'Don't keep activities' via `settings global always_finish_activities`, restored to its prior value, or unset. Applies to activities left after the change.",
          ),
        storage: z
          .enum(["low", "full", DEVICE_CONDITION_UNSET])
          .optional()
          .describe(
            "Use up free space on /data with a ballast file (`fallocate`): 'low' leaves about 128 MiB, 'full' about 8 MiB. Reset deletes the ballast. Or unset.",
          ),
        corruptAppFile: z
          .union([z.literal(DEVICE_CONDITION_UNSET), corruptTargetSchema()])
          .optional()
          .describe(
            "Damage one file in a debuggable app's data directory ({ package, path, mode }), e.g. a SQLite database or SharedPreferences XML. 'overwrite' zeroes its first 256 bytes, 'truncate' cuts it in half. Needs a debuggable app (run-as), force-stops the app, and keeps a copy that reset restores and verifies by checksum. Or unset.",
          ),
        revokePermission: z
          .union([
            z.literal(DEVICE_CONDITION_UNSET),
            z
              .object({
                package: z.string().regex(ANDROID_PACKAGE_NAME_PATTERN),
                permission: z.string().regex(ANDROID_PERMISSION_NAME_PATTERN),
              })
              .strict(),
          ])
          .optional()
          .describe(
            "Revoke one runtime permission from an installed app with `pm revoke` ({ package, permission }); reset re-grants it. Revoking kills the app's process, so it also restarts the app. Or unset.",
          ),
        disablePackage: z
          .union([z.literal(DEVICE_CONDITION_UNSET), packageTargetSchema()])
          .optional()
          .describe(
            "Disable an installed app for the current user with `pm disable-user` ({ package }); reset runs `pm enable`. Or unset.",
          ),
        killApp: z
          .union([z.literal(DEVICE_CONDITION_UNSET), killTargetSchema()])
          .optional()
          .describe(
            "End an app's process once ({ package, mode }): 'background' is `am kill`, which only ends a process the system could reclaim and leaves the foreground app running; 'forceStop' is `am force-stop`, the user's Force stop. Nothing to reset; 'unset' is a no-op.",
          ),
        trimMemory: z
          .union([z.literal(DEVICE_CONDITION_UNSET), trimTargetSchema()])
          .optional()
          .describe(
            "Send a running app an onTrimMemory level once ({ package, level }) with `am send-trim-memory`. The app must be running. Nothing to reset; 'unset' is a no-op.",
          ),
        clearPackageData: z
          .union([z.literal(DEVICE_CONDITION_UNSET), packageTargetSchema()])
          .optional()
          .describe(
            "Clear an installed app's data with `pm clear` ({ package }). One-shot: it kills the app's process and cannot be undone, so there is nothing to reset. 'unset' is a no-op.",
          ),
        clockSkew: z
          .union([z.literal(DEVICE_CONDITION_UNSET), clockSkewParamsSchema()])
          .optional()
          .describe(
            "Set the device clock offsetSeconds ahead of (positive) or behind (negative) real time ({ offsetSeconds }), 3 seconds to 10 years either way, with automatic time off. Reset restores real time and the original automatic-time setting and verifies them. Rootable Android emulators only (needs adb root, which restarts adbd). Shares the device clock with setDeviceState.clock: a reset from either restores real time. Or unset.",
          ),
      })
      .strict()
      .optional()
      .describe("Power and lifecycle fault injectors (Android only, behind the feature flag)."),
    vehicle: z
      .object({
        motion: z
          .enum(["parked", "driving", DEVICE_CONDITION_UNSET])
          .optional()
          .describe(
            "Vehicle motion on an Android Automotive emulator: 'parked' (gear park, speed 0, parking brake on) or 'driving' (gear drive, moving, brake off), set together so the state is consistent. Restored to the values read before the first change; or unset.",
          ),
        nightMode: z
          .enum(["on", "off", DEVICE_CONDITION_UNSET])
          .optional()
          .describe(
            "Vehicle night-mode signal on an Android Automotive emulator: 'on' or 'off' sets the signal; unset or reset returns day/night to automatic sensor control without preserving a prior manual override.",
          ),
      })
      .strict()
      .optional()
      .describe(
        "Vehicle state (Android Automotive emulators only; 'unsupported' elsewhere), via `cmd car_service inject-vhal-event`.",
      ),
    expiresInSeconds: z
      .number()
      .int()
      .min(1)
      .max(DEVICE_CONDITION_MAX_LEASE_SECONDS)
      .optional()
      .describe(
        "Lease: restore every applied condition after this many seconds unless a later deviceCondition call renews it. Session-bound calls only.",
      ),
    reset: z
      .literal(true)
      .optional()
      .describe("Restore every condition applied on this device and verify a clean read."),
  })
  .strict();

/** One condition change the controller should make; `value` is `"unset"` or an injector value. */
export interface DeviceConditionChange {
  key: DeviceConditionKey;
  value: string;
  /** The request object when the fault was requested with parameters (`value` is then "apply"). */
  params?: Record<string, unknown>;
}

/** Split a validated request into ordered changes; fields absent from the request are untouched. */
export function deviceConditionChanges(input: DeviceConditionInput): DeviceConditionChange[] {
  const changes: DeviceConditionChange[] = [];
  if (input.rootState !== undefined) {
    changes.push({ key: "rootState", value: input.rootState });
  }
  if (input.integrityState !== undefined) {
    changes.push({ key: "integrityState", value: input.integrityState });
  }
  const faults = input.faults ?? {};
  for (const name of Object.keys(faults).sort()) {
    const value = (faults as Record<string, unknown>)[name];
    if (typeof value === "string") {
      changes.push({ key: `faults.${name}`, value });
    } else if (value !== null && typeof value === "object") {
      changes.push({
        key: `faults.${name}`,
        value: DEVICE_CONDITION_APPLY,
        params: { ...value },
      });
    }
  }
  const vehicle = input.vehicle ?? {};
  for (const name of Object.keys(vehicle).sort()) {
    const value = (vehicle as Record<string, unknown>)[name];
    if (typeof value === "string") {
      changes.push({ key: `vehicle.${name}`, value });
    }
  }
  return changes;
}

/** True when the request asks for something: a reset or at least one condition field. */
export function deviceConditionInputIsMeaningful(input: DeviceConditionInput): boolean {
  return input.reset === true || deviceConditionChanges(input).length > 0;
}

/** What happened to one requested condition. */
export type DeviceConditionChangeStatus = "applied" | "cleared" | "unchanged" | "unsupported";

export interface DeviceConditionChangeResult {
  key: DeviceConditionKey;
  status: DeviceConditionChangeStatus;
  /** Why the condition was not applied, or what the injector reported. */
  detail?: string;
}

export interface DeviceConditionRestoreFailure {
  key: DeviceConditionKey;
  error: string;
}

/** Outcome of running registered resets, newest first, then reading each key back. */
export interface DeviceConditionRestoreReport {
  restored: DeviceConditionKey[];
  failures: DeviceConditionRestoreFailure[];
  /** True when every reset ran and every touched key read back clean. */
  verifiedClean: boolean;
}

export interface DeviceConditionResult {
  success: boolean;
  version: typeof DEVICE_CONDITION_SCHEMA_VERSION;
  changes: DeviceConditionChangeResult[];
  /** Present when the call reset conditions (explicitly or via `"unset"`). */
  restore?: DeviceConditionRestoreReport;
  /** Keys still applied on the device after this call. */
  active: DeviceConditionKey[];
  /** Wall-clock ms when the lease restores the active conditions, if one is armed. */
  leaseExpiresAt?: number;
  error?: string;
}
