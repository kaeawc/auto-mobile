import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { DeviceConditionInjector } from "./DeviceConditionController";
import type { DeviceConditionKey } from "./DeviceConditionTypes";

/**
 * iOS refusals for `deviceCondition` (#14073). The iOS Simulator is a simulated, not
 * virtualized, runtime: no bootloader, no verified boot and no real root or jailbreak,
 * and it has no Android power, lifecycle or storage services. A request for one of
 * those conditions is refused with text naming why, instead of the generic
 * "no injector registered" reply a missing injector would give.
 */

const REAL_HARDWARE_KEYS: ReadonlySet<string> = new Set(["rootState", "integrityState"]);

/** Android-only fault services; the iOS Simulator has no equivalent to drive. */
const ANDROID_ONLY_FAULT_KEYS: ReadonlySet<string> = new Set([
  "faults.lowPower",
  "faults.doze",
  "faults.thermal",
  "faults.dontKeepActivities",
  "faults.storage",
  "faults.clockSkew",
  "vehicle.motion",
  "vehicle.nightMode",
]);

function refusalFor(key: DeviceConditionKey): string | undefined {
  if (REAL_HARDWARE_KEYS.has(key)) {
    return `unsupported on iOS Simulator: '${key}' needs a bootloader, verified boot or a jailbroken device, and the simulator is a simulated runtime with none of them. Use real jailbroken hardware, or an Android emulator fixture.`;
  }
  if (ANDROID_ONLY_FAULT_KEYS.has(key)) {
    return `unsupported on iOS Simulator: '${key}' drives an Android system service the simulator does not have. Use an Android device or emulator.`;
  }
  return undefined;
}

/**
 * An injector whose apply always refuses, for an iOS device and a key iOS cannot
 * satisfy. Returns undefined for any other platform or key so the resolver chain
 * carries on. It never touches the device, so there is nothing to reset.
 */
export function resolveIosRefusalInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
): DeviceConditionInjector | undefined {
  if (device.platform !== "ios") {
    return undefined;
  }
  const message = refusalFor(key);
  if (message === undefined) {
    return undefined;
  }
  return {
    key,
    apply: () => Promise.reject(new ActionableError(message)),
    isClean: () => Promise.resolve(true),
  };
}
