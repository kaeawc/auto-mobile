import { type DeviceBootResult } from "../../../devices/deviceBootService";
import { coldBootRetryReason } from "./bootSettlement";

/** What a failed acquisition left of the device it cold-booted (#19124). */
export type AcquisitionDeviceLeft = "shutdown" | "booted" | "unknown";

const DEVICE_LEFT_DETAIL: Record<AcquisitionDeviceLeft, string> = {
  shutdown: "this request is shutting down the emulator it cold-booted",
  booted: "the device is still running",
  unknown: "this request could not confirm whether the device is still running",
};

/**
 * What a failure left of the device this request cold-booted, after
 * `cancelUnownedColdBootUnlessRetryable` decided its fate: a settlement means this request is
 * stopping the emulator; a cold boot kept for a retry (or one already running before the call) is
 * still booted; anything else cannot be confirmed. Undefined for a device that was already
 * running: the failure leaves it as the caller found it, so there is nothing new to report.
 */
export function acquisitionDeviceLeft(
  boot: DeviceBootResult | undefined,
  failure: unknown,
  settlement: Promise<void> | undefined,
): AcquisitionDeviceLeft | undefined {
  if (boot?.source !== "cold-boot") {
    return undefined;
  }
  if (settlement) {
    return "shutdown";
  }
  if (boot.runningBeforeCall === true || coldBootRetryReason(failure) !== undefined) {
    return "booted";
  }
  return "unknown";
}

/** The retry a caller can make after a failed acquisition. */
export function acquisitionNextStep(operationName: string, androidAvdName?: string): string {
  return androidAvdName !== undefined
    ? `retry ${operationName} with the same avdName ("${androidAvdName}")`
    : `retry ${operationName} with the same arguments`;
}

const annotatedFailures = new WeakSet<Error>();

/**
 * Appends the device state and next step to a failed acquisition's message, in place, so the
 * error keeps its class (typed refusals and retry classification read it). Annotates once: an
 * error object rethrown through a second preparation is not described twice.
 */
export function annotateAcquisitionFailure<T>(
  failure: T,
  deviceLeft: AcquisitionDeviceLeft,
  nextStep: string,
): T {
  if (!(failure instanceof Error) || annotatedFailures.has(failure)) {
    return failure;
  }
  annotatedFailures.add(failure);
  const separator = /[.!?]$/.test(failure.message.trimEnd()) ? " " : ". ";
  failure.message =
    `${failure.message.trimEnd()}${separator}deviceLeft: ${deviceLeft} ` +
    `(${DEVICE_LEFT_DETAIL[deviceLeft]}). Next step: ${nextStep}.`;
  return failure;
}
