import { RetryableDeviceAcquisitionError } from "./RetryableDeviceAcquisitionError";

/**
 * Another live AutoMobile daemon has claimed the device, so an explicit bind is refused (#10980,
 * owner decision 2026-10-09): two daemons must never drive the same device. Clients wait on it
 * like a held device; it frees once the other daemon releases its session.
 */
export const DEVICE_OWNED_BY_OTHER_DAEMON_CODE = "device_owned_by_other_daemon";

/** Retry hint for a device another daemon holds: its claim lapses only once that session ends. */
export const DEVICE_OWNED_BY_OTHER_DAEMON_RETRY_AFTER_MS = 2_000;

export class DeviceOwnedByOtherDaemonError extends RetryableDeviceAcquisitionError {
  /**
   * @param remedy what the caller can do instead; defaults to the acquisition remedy
   * @param message replaces the default wording; see {@link registryUnusable}
   */
  constructor(
    deviceId: string,
    readonly ownerPid: number | undefined,
    remedy = "Retry after that daemon releases it, or pick another device.",
    message = `Device '${deviceId}' is claimed by another AutoMobile daemon` +
      (ownerPid === undefined ? "" : ` (PID ${ownerPid})`) +
      ` (code ${DEVICE_OWNED_BY_OTHER_DAEMON_CODE}); two daemons must never drive the same ` +
      `device. ${remedy}`,
  ) {
    super(
      DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      deviceId,
      DEVICE_OWNED_BY_OTHER_DAEMON_RETRY_AFTER_MS,
      message,
    );
    this.name = "DeviceOwnedByOtherDaemonError";
  }

  /**
   * The claim was refused only because the host-wide device claims registry must decide it but
   * could not be used (busy, still opening, or failed to open), not because another daemon was
   * seen holding the device (#11811, fail closed). Same retryable wire code, so clients keep
   * waiting on it; the message no longer blames a daemon that may not exist.
   */
  static registryUnusable(deviceId: string): DeviceOwnedByOtherDaemonError {
    return new DeviceOwnedByOtherDaemonError(
      deviceId,
      undefined,
      undefined,
      `Device '${deviceId}' could not be claimed because the host-wide device claims registry ` +
        `cannot decide it right now (busy, still opening, or failed to open) ` +
        `(code ${DEVICE_OWNED_BY_OTHER_DAEMON_CODE}). No other AutoMobile daemon was seen ` +
        `holding it; the claim is refused so two daemons never drive the same device. Retry shortly.`,
    );
  }
}
