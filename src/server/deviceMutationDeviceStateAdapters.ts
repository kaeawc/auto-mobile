import type { Platform } from "../models";
import { opaqueIntentKey, type DeviceMutationInput } from "../daemon/sessionBroker/mutations/types";
import {
  powerIntentKey,
  type PowerIntent,
} from "../daemon/sessionBroker/mutations/deviceStateKeys";
import { appFallback } from "./deviceMutationLifecycleAdapters";
import { isRecord } from "./pipeline/isRecord";

type ToolMutation = Pick<DeviceMutationInput, "kind" | "key">;

function powerMutation(intent: PowerIntent): ToolMutation {
  return { kind: "device-setting", key: powerIntentKey(intent) };
}

function appIdOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value.appId === "string" ? value.appId : undefined;
}

/** Forcing Doze unplugs the battery first unless the caller already asked for `charging: none`. */
function dozeUnplugsBattery(power: Record<string, unknown>): boolean {
  const forced = power.doze === "light" || power.doze === "deep";
  return forced && !(isRecord(power.battery) && power.battery.charging === "none");
}

function powerIntents(power: Record<string, unknown>): PowerIntent[] {
  const standbyApp = appIdOf(power.standbyBucket);
  const inactiveApp = appIdOf(power.appInactive);
  return [
    ...(isRecord(power.battery) || dozeUnplugsBattery(power)
      ? [{ field: "battery" as const }]
      : []),
    ...(typeof power.doze === "string" ? [{ field: "doze" as const }] : []),
    ...(power.batterySaver !== undefined ? [{ field: "batterySaver" as const }] : []),
    ...(power.dataSaver !== undefined ? [{ field: "dataSaver" as const }] : []),
    ...(power.thermalStatus !== undefined ? [{ field: "thermal" as const }] : []),
    ...(standbyApp ? [{ field: "standby" as const, appId: standbyApp }] : []),
    ...(inactiveApp ? [{ field: "inactive" as const, appId: inactiveApp }] : []),
  ];
}

/** The `deviceCondition.faults` that apply a condition (`unset` only clears one). */
function appliedFaults(deviceCondition: unknown): Set<string> {
  const faults = isRecord(deviceCondition) ? deviceCondition.faults : undefined;
  return new Set(
    isRecord(faults)
      ? Object.entries(faults)
          .filter(([, value]) => typeof value === "string" && value !== "unset")
          .map(([name]) => name)
      : [],
  );
}

/** The fault injectors drive the same dumpsys/settings/cmd controls as `power`, so they share keys. */
function faultIntents(deviceCondition: unknown): PowerIntent[] {
  const faults = appliedFaults(deviceCondition);
  return [
    ...(faults.has("battery") || faults.has("doze") ? [{ field: "battery" as const }] : []),
    ...(faults.has("doze") ? [{ field: "doze" as const }] : []),
    ...(faults.has("lowPower") ? [{ field: "batterySaver" as const }] : []),
    ...(faults.has("thermal") ? [{ field: "thermal" as const }] : []),
  ];
}

/**
 * Per-control power intents for a `setDeviceState` call: `power` and the `deviceCondition`
 * power faults. Empty when the call carries neither (or a `power` with nothing recognizable,
 * which the caller records as one generic breadcrumb).
 */
export function devicePowerMutations(args: Record<string, unknown>): ToolMutation[] {
  const intents = [
    ...(isRecord(args.power) ? powerIntents(args.power) : []),
    ...faultIntents(args.deviceCondition),
  ];
  return [...new Map(intents.map((intent) => [powerIntentKey(intent), intent])).values()].map(
    powerMutation,
  );
}

function opaqueDeviceState(...parts: readonly string[]): ToolMutation {
  return { kind: "opaque", key: opaqueIntentKey("setDeviceState", ...parts) };
}

/**
 * Android effects nothing reverts and the baseline clean does not cover (#14359):
 * - an emulator GPS fix: the console has no unset command and the prior fix is unreadable;
 * - a lock-screen credential: clearing it needs the secret, which the journal never holds;
 * - a camera poster: the virtual scene has no read-back, so no prior can be captured;
 * - a `deviceCondition` package-data clear (`faults.clearPackageData`): it wipes app data nothing
 *   restores, so it records the same destructive-app intent as `launchApp(clearAppData)`.
 * Each forces keep-booted reset to escalate. A route `stop` and a credential/poster clear apply
 * no new state, so they record nothing extra.
 */
export function deviceStateFallbackMutations(
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] {
  if (platform === "ios") {
    return [];
  }
  const location = isRecord(args.location) ? args.location.mode : undefined;
  const lock = isRecord(args.screenLock) ? args.screenLock.type : undefined;
  const poster = isRecord(args.cameraPoster) ? args.cameraPoster.mode : undefined;
  return [
    ...(location === "static" || location === "route" ? [opaqueDeviceState("location")] : []),
    ...(lock === "pin" || lock === "password" || lock === "pattern"
      ? [opaqueDeviceState("screenLock")]
      : []),
    ...(poster === "image" || poster === "qr" ? [opaqueDeviceState("cameraPoster")] : []),
    ...clearedPackageFallbacks(args.deviceCondition),
  ];
}

/** The destructive-app intent for the app a `deviceCondition.faults.clearPackageData` request wipes. */
function clearedPackageFallbacks(deviceCondition: unknown): ToolMutation[] {
  const faults = isRecord(deviceCondition) ? deviceCondition.faults : undefined;
  const target = isRecord(faults) ? faults.clearPackageData : undefined;
  return isRecord(target) && typeof target.package === "string"
    ? [appFallback("clearAppData", target.package)]
    : [];
}

/**
 * True when a `setDeviceState` call skews the clock through `deviceCondition.faults.clockSkew`.
 * It drives the same clock control as the `clock` field, so it journals the same `clock` intent.
 */
export function deviceConditionSkewsClock(args: Record<string, unknown>): boolean {
  const faults = isRecord(args.deviceCondition) ? args.deviceCondition.faults : undefined;
  return isRecord(faults) && isRecord(faults.clockSkew);
}

/**
 * Tools of this family whose intents are not `setDeviceState` fields. `setPosture` on an Android
 * emulator drives host-side state (`emu fold`/`unfold`/`posture`, `resize-display`, the
 * hinge-angle sensor and a `device_state` override) that no revert or baseline clean undoes, so
 * it forces keep-booted reset to escalate. iOS keeps the plain breadcrumb.
 */
export function deviceStateToolMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: Platform,
): ToolMutation[] | undefined {
  if (name !== "setPosture") {
    return undefined;
  }
  return [
    { kind: "device-setting", key: "tool:setPosture" },
    ...(platform === "ios" ? [] : [opaqueDeviceState("posture")]),
    // A display preset resizes the display, which the foldable posture restore does not undo.
    ...(platform !== "ios" && args.displayPreset !== undefined
      ? [opaqueDeviceState("posture", "displayPreset")]
      : []),
  ];
}
