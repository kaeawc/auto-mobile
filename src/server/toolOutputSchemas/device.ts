import { disabledResourcesSchema } from "../../utils/deviceResourceSchemas";
import { z } from "zod/v4";
import { deviceDescriptionSchema } from "../../daemon/deviceDescription";
import { platformSchema } from "../../utils/schemaHelpers";
import {
  observationDisplaySchema,
  pinnedDisplaySchema,
  displayInventoryUnavailableSchema,
  staleDisplaySchema,
} from "./display";
import {
  DEVICE_STATE_READABLE_FIELDS,
  doNotDisturbModeSchema,
  biometricEnrollmentSchema,
  networkConditionProfileSchema,
} from "../../features/utility/DeviceState";
import { deviceClockInputSchema } from "../../features/utility/DeviceClock";
import { EMULATOR_SENSOR_NAMES } from "../../features/utility/EmulatorSensors";
import {
  LOCK_CREDENTIAL_MISMATCH,
  LOCK_CREDENTIAL_PREEXISTING,
} from "../../features/utility/screenLock/ScreenLockTypes";
import { BATTERY_CHARGING_VALUES, DOZE_MODES } from "../../features/utility/power/PowerTypes";
import { observationOutputSchema } from "./observation";
import { observationDiffMetadataSchema, tapEffectSchema } from "./observationMetadata";

/** Evidence from the existing boot, runner setup, and session recording steps. */
export const startDeviceReadinessSchema = z.object({
  level: z.literal("automationReady"),
  checks: z.array(z.enum(["bootCompleted", "runnerReady", "sessionBound"])),
  elapsedMs: z.number().nonnegative(),
  recovered: z.boolean().optional(),
});

export type StartDeviceReadiness = z.infer<typeof startDeviceReadinessSchema>;

/** An Apple Watch simulator has no automation runner: booted and session-bound is all (#14908). */
const watchStartDeviceReadinessSchema = z.object({
  level: z.literal("booted"),
  checks: z.array(z.enum(["bootCompleted", "sessionBound"])),
  elapsedMs: z.number().nonnegative(),
});

/** Shared acquisition description plus startDevice's successful structured result. */
export const startDeviceOutputSchema = z
  .object({
    ...deviceDescriptionSchema.partial().shape,
    platform: z.enum(["android", "ios", "watchos", "tvos"]).optional(),
    message: z.string(),
    deviceIdentity: z.unknown().optional(),
    processId: z.number().nullable().optional(),
    isReady: z.literal(true).optional(),
    acquisition: z.enum(["already-booted", "cold-boot"]).optional(),
    readiness: z.union([startDeviceReadinessSchema, watchStartDeviceReadinessSchema]).optional(),
    disabledResources: disabledResourcesSchema.optional(),
    // PerformanceTracker emits nested arrays/records rather than a flat numeric map.
    timing: z.unknown().optional(),
  })
  .passthrough();

const deviceStateFieldOutputFields = {
  supported: z.boolean(),
  verified: z.boolean().optional(),
  method: z.string().optional(),
  warning: z.string().optional(),
  error: z.string().optional(),
};
const networkConditionValuesOutputSchema = z
  .object({
    delayMs: z.number(),
    downloadKbps: z.number(),
    uploadKbps: z.number(),
    packetLossPercent: z.number(),
  })
  .passthrough();

/** One leased per-app offline rule on an iOS Simulator (#10264). */
const iosAppNetworkRuleOutputSchema = z
  .object({
    appId: z.string(),
    profile: z.literal("offline"),
    revision: z.number(),
    ownerGeneration: z.number(),
    owner: z.string().optional(),
    leaseExpiresInMs: z.number().optional(),
    droppedFlows: z.number().optional(),
  })
  .passthrough();

const deviceStateOutputFields = {
  message: z.string(),
  success: z.boolean().optional(),
  deviceId: z.string().optional(),
  platform: platformSchema.optional(),
  error: z.string().optional(),
  displays: z
    .object({
      panels: z.array(
        z
          .object({
            key: z.string(),
            role: observationDisplaySchema.unwrap().shape.role,
            sizePx: z.object({ width: z.number(), height: z.number() }).passthrough(),
            scale: z.number().optional(),
          })
          .passthrough(),
      ),
      postures: z.array(observationDisplaySchema.unwrap().shape.posture),
    })
    .passthrough()
    .optional(),
  unsupported: z.array(z.enum(DEVICE_STATE_READABLE_FIELDS)).optional(),
  doNotDisturb: z
    .object({
      ...deviceStateFieldOutputFields,
      enabled: z.boolean().optional(),
      mode: doNotDisturbModeSchema.optional(),
      rawValue: z.string().optional(),
      bestEffort: z.boolean().optional(),
      capability: z.string().optional(),
      requestedMode: doNotDisturbModeSchema.optional(),
      appliedMode: doNotDisturbModeSchema.optional(),
    })
    .passthrough()
    .optional(),
  biometrics: z
    .object({
      ...deviceStateFieldOutputFields,
      enrollment: biometricEnrollmentSchema.optional(),
    })
    .passthrough()
    .optional(),
  connectivity: z
    .object({
      ...deviceStateFieldOutputFields,
      airplaneMode: z.boolean().optional(),
      wifiEnabled: z.boolean().optional(),
      bluetoothEnabled: z.boolean().optional(),
      locationEnabled: z.boolean().optional(),
      rawValues: z.record(z.string(), z.string()).optional(),
    })
    .passthrough()
    .optional(),
  networkCondition: z
    .object({
      ...deviceStateFieldOutputFields,
      capability: z.string().optional(),
      profile: networkConditionProfileSchema.optional(),
      requestedProfile: networkConditionProfileSchema.optional(),
      appliedProfile: networkConditionProfileSchema.optional(),
      values: networkConditionValuesOutputSchema.optional(),
      observedValues: networkConditionValuesOutputSchema.partial().optional(),
      expiresInSeconds: z.number().optional(),
      rawStatus: z.string().optional(),
      backend: z.literal("network-extension").optional(),
      controller: z
        .object({
          state: z.string(),
          contractVersion: z.number().optional(),
          detail: z.string(),
          nextStep: z.string(),
        })
        .passthrough()
        .optional(),
      scope: z.enum(["device", "app"]).optional(),
      appId: z.string().optional(),
      rule: iosAppNetworkRuleOutputSchema.optional(),
      rules: z.array(iosAppNetworkRuleOutputSchema).optional(),
      acknowledged: z.boolean().optional(),
      coverage: z.literal("partial").optional(),
      limitations: z.array(z.string()).optional(),
    })
    .passthrough()
    .optional(),
  location: z
    .object({
      ...deviceStateFieldOutputFields,
      mode: z.string().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      stopped: z.boolean().optional(),
      previousRoute: z
        .object({ endedReason: z.string(), lastError: z.string().optional() })
        .passthrough()
        .optional(),
      waypointCount: z.number().optional(),
      totalDistanceMeters: z.number().optional(),
      expectedDurationMs: z.number().optional(),
      loop: z.boolean().optional(),
      updateIntervalMs: z.number().optional(),
    })
    .passthrough()
    .optional(),
  cameraPoster: z
    .object({
      ...deviceStateFieldOutputFields,
      mode: z.enum(["image", "qr", "clear"]).optional(),
      surface: z.enum(["wall", "table"]).optional(),
      path: z.string().optional(),
    })
    .passthrough()
    .optional(),
  clock: z
    .object({
      ...deviceStateFieldOutputFields,
      capability: z.string(),
      instant: z.string().optional(),
      automaticTime: z.boolean().optional(),
      mode: z
        .union([
          deviceClockInputSchema.options[0].shape.mode,
          deviceClockInputSchema.options[1].shape.mode,
          deviceClockInputSchema.options[2].shape.mode,
        ])
        .optional(),
      requestedInstant: z.string().optional(),
      appliedInstant: z.string().optional(),
      readBack: z.boolean().optional(),
      toleranceMs: z.number().optional(),
      outcome: z.string().optional(),
    })
    .passthrough()
    .optional(),
  sensors: z
    .object({
      ...deviceStateFieldOutputFields,
      sensors: z
        .array(z.object({ name: z.enum(EMULATOR_SENSOR_NAMES), value: z.array(z.number()) }))
        .optional(),
      unavailable: z
        .array(z.object({ name: z.enum(EMULATOR_SENSOR_NAMES), reason: z.string() }))
        .optional(),
    })
    .passthrough()
    .optional(),
  // Type and outcome only: a lock-screen credential is never part of a result (#14107).
  screenLock: z
    .object({
      ...deviceStateFieldOutputFields,
      type: z.enum(["none", "pin", "password", "pattern", "unknown"]).optional(),
      secure: z.boolean().optional(),
      set: z.boolean().optional(),
      cleared: z.boolean().optional(),
      outcome: z.enum(["set", "changed", "cleared", "unchanged"]).optional(),
      restoreOnRelease: z.boolean().optional(),
      errorCode: z.enum([LOCK_CREDENTIAL_PREEXISTING, LOCK_CREDENTIAL_MISMATCH]).optional(),
    })
    .passthrough()
    .optional(),
  // Battery, Doze, saver, standby and thermal state plus the restore receipt (#14084).
  power: z
    .object({
      ...deviceStateFieldOutputFields,
      battery: z
        .object({
          level: z.number(),
          charging: z.enum(BATTERY_CHARGING_VALUES),
          status: z.string(),
          faked: z.boolean(),
        })
        .optional(),
      batterySaver: z.boolean().optional(),
      dataSaver: z.boolean().optional(),
      doze: z.object({ mode: z.enum(DOZE_MODES), deep: z.string(), light: z.string() }).optional(),
      thermal: z.object({ status: z.number(), override: z.boolean() }).optional(),
      applied: z.array(z.string()).optional(),
      preconditions: z.array(z.string()).optional(),
      restoreOnRelease: z.boolean().optional(),
      errorCode: z.string().optional(),
    })
    .passthrough()
    .optional(),
};

/** Reads and writes share field states; early failures carry only identity and error. */
export const getDeviceStateResultSchema = z.object(deviceStateOutputFields).passthrough();
export const setDeviceStateResultSchema = z.object(deviceStateOutputFields).passthrough();

/** Rotation results include failures and successful orientation no-ops. */
export const rotateResultSchema = z
  .object({
    success: z.boolean(),
    orientation: z.string(),
    value: z.number(),
    message: z.string(),
    currentOrientation: z.string().optional(),
    previousOrientation: z.string().optional(),
    rotationPerformed: z.boolean().optional(),
    orientationLockHandled: z.boolean().optional(),
    orientationLockState: z.enum(["locked", "unlocked", "unknown"]).optional(),
    warning: z.string().optional(),
    observation: observationOutputSchema.optional(),
    observationDiff: observationDiffMetadataSchema.optional(),
    effect: tapEffectSchema.optional(),
    error: z.string().optional(),
    pinnedDisplay: pinnedDisplaySchema.optional(),
    displayInventory: displayInventoryUnavailableSchema.optional(),
    staleDisplay: staleDisplaySchema.optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();

/** Unsupported iOS posture requests are results; operational failures throw. */
export const setPostureResultSchema = z
  .object({
    message: z.string(),
    status: z.literal("unsupported").optional(),
    posture: observationDisplaySchema.unwrap().shape.posture.optional(),
    hingeAngle: z.number().finite().optional(),
    observedHingeAngle: z.number().finite().optional(),
    postureReason: z.string().optional(),
    display: observationDisplaySchema,
    locked: z.boolean().optional(),
    keyguardDismissed: z.literal(true).optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough()
  .refine(
    (result) =>
      result.posture !== "unknown" ||
      (result.hingeAngle !== undefined && Boolean(result.postureReason)),
    "Unknown posture requires a hingeAngle request and postureReason.",
  );
