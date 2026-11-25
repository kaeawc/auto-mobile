import { type DeviceBootResult } from "../../../devices/deviceBootService";
import { coldBootRetryReason } from "./bootSettlement";

/**
 * What a failed acquisition left of the device it cold-booted (#19124); `deleted` when it was a
 * device this createIfMissing request created and then rolled back (#18823).
 */
export type AcquisitionDeviceLeft = "shutdown" | "booted" | "unknown" | "deleted";

/** How the rollback of a device this request created (createIfMissing) ended (#18823). */
export type CreatedDeviceRollbackOutcome = "deleted" | "failed";

const DEVICE_LEFT_DETAIL: Record<AcquisitionDeviceLeft, string> = {
  shutdown: "this request is shutting down the emulator it cold-booted",
  booted: "the device is still running",
  unknown: "this request could not confirm whether the device is still running",
  deleted: "this request shut down the device it created and deleted it",
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

/**
 * What a createIfMissing rollback left: the created device is gone once it was deleted; a failed
 * rollback stopped the device but cannot confirm what remains of it (#18823).
 */
export function createdDeviceRollbackDeviceLeft(
  outcome: CreatedDeviceRollbackOutcome,
): AcquisitionDeviceLeft {
  return outcome === "deleted" ? "deleted" : "unknown";
}

/**
 * The retry a caller can make after a failed acquisition. After a createIfMissing rollback the
 * device it named was (or may have been) deleted, so the retry creates it again (#18823).
 */
export function acquisitionNextStep(
  operationName: string,
  androidAvdName?: string,
  createdDeviceRolledBack = false,
): string {
  if (createdDeviceRolledBack) {
    return `retry ${operationName} with createIfMissing: true`;
  }
  return androidAvdName !== undefined
    ? `retry ${operationName} with the same avdName ("${androidAvdName}")`
    : `retry ${operationName} with the same arguments`;
}

/** The device state each annotated failure copy reports. */
const annotatedFailures = new WeakMap<Error, AcquisitionDeviceLeft>();

/**
 * The typed `deviceLeft` of a failure `annotateAcquisitionFailure` produced, which the tool error
 * exposes beside its message (#18823); undefined for any other value.
 */
export function acquisitionFailureDeviceLeft(error: unknown): AcquisitionDeviceLeft | undefined {
  return error instanceof Error ? annotatedFailures.get(error) : undefined;
}

/**
 * The stack of `failure` re-headed with `message`: the frames stay those of the original throw,
 * so the trace points where the failure happened while its first line matches what the caller
 * reads.
 */
function restackedWith(failure: Error, message: string): string {
  const frames = (failure.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
  return [`${failure.name}: ${message}`, ...frames].join("\n");
}

/**
 * A copy of a failed acquisition that appends the device state and next step to its message
 * (#19153), and carries the device state as a typed `deviceLeft` field (#18823). The copy keeps
 * the failure's class and fields, because typed refusals and retry classification read them, and
 * carries the original as `cause`; the original error object, which other holders may share, is
 * left unchanged. Annotates once: a copy rethrown through a second preparation is not described
 * twice.
 */
export function annotateAcquisitionFailure<T>(
  failure: T,
  deviceLeft: AcquisitionDeviceLeft,
  nextStep: string,
): T {
  if (!(failure instanceof Error) || annotatedFailures.has(failure)) {
    return failure;
  }
  const separator = /[.!?]$/.test(failure.message.trimEnd()) ? " " : ". ";
  const message =
    `${failure.message.trimEnd()}${separator}deviceLeft: ${deviceLeft} ` +
    `(${DEVICE_LEFT_DETAIL[deviceLeft]}). Next step: ${nextStep}.`;
  const annotated: Error = Object.create(Object.getPrototypeOf(failure) as object | null);
  Object.defineProperties(annotated, Object.getOwnPropertyDescriptors(failure));
  for (const [key, value] of [
    ["message", message],
    ["cause", failure],
    ["stack", restackedWith(failure, message)],
    ["deviceLeft", deviceLeft],
  ] as const) {
    Object.defineProperty(annotated, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  annotatedFailures.set(annotated, deviceLeft);
  return annotated as T;
}
