import type { OwnedTerminationWait } from "./coldBootProcessTermination";

/**
 * What a failed boot left of the emulator it launched and then stopped itself (#19368):
 * `shutdown` once the stop was confirmed or is still running in the background, `unknown` when
 * the emulator could not be confirmed gone.
 */
export type BootTeardownDeviceLeft = "shutdown" | "unknown";

const tornDownFailures = new WeakMap<object, BootTeardownDeviceLeft>();

/** The device state a boot that stopped its own emulator reports, by how that stop ended. */
export function bootTeardownDeviceLeftFor(wait: OwnedTerminationWait): BootTeardownDeviceLeft {
  return wait === "confirmed" || wait === "pending" ? "shutdown" : "unknown";
}

/**
 * Records on `failure` that the boot which threw it stopped the emulator it launched, so the
 * acquisition can report it although no boot result reached it. A primitive failure cannot carry
 * the fact and is returned as is.
 */
export function markBootTeardown<T>(failure: T, deviceLeft: BootTeardownDeviceLeft): T {
  if (typeof failure === "object" && failure !== null) {
    tornDownFailures.set(failure, deviceLeft);
  }
  return failure;
}

/** The device state `markBootTeardown` recorded on `failure`; undefined for any other value. */
export function bootTeardownDeviceLeft(failure: unknown): BootTeardownDeviceLeft | undefined {
  return typeof failure === "object" && failure !== null
    ? tornDownFailures.get(failure)
    : undefined;
}
