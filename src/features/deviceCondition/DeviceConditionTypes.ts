import { z } from "zod";

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
export type DeviceConditionKey = "rootState" | "integrityState" | `faults.${string}`;

/** A request value; `"unset"` clears the condition instead of applying one. */
export const DEVICE_CONDITION_UNSET = "unset";

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
  };
  expiresInSeconds?: number;
  reset?: true;
}

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
      })
      .strict()
      .optional()
      .describe("Power-domain fault injectors (Android only, behind the feature flag)."),
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
    const value = (faults as Record<string, string | undefined>)[name];
    if (value !== undefined) {
      changes.push({ key: `faults.${name}`, value });
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

export const deviceConditionResultSchema = z
  .object({
    success: z.boolean(),
    version: z.literal(DEVICE_CONDITION_SCHEMA_VERSION),
    changes: z.array(
      z
        .object({
          key: z.string(),
          status: z.enum(["applied", "cleared", "unchanged", "unsupported"]),
          detail: z.string().optional(),
        })
        .passthrough(),
    ),
    restore: z
      .object({
        restored: z.array(z.string()),
        failures: z.array(z.object({ key: z.string(), error: z.string() }).passthrough()),
        verifiedClean: z.boolean(),
      })
      .passthrough()
      .optional(),
    active: z.array(z.string()),
    leaseExpiresAt: z.number().optional(),
    error: z.string().optional(),
  })
  .passthrough();
