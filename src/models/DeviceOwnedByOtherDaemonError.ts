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
  /** @param remedy what the caller can do instead; defaults to the acquisition remedy */
  constructor(
    deviceId: string,
    readonly ownerPid: number | undefined,
    remedy = "Retry after that daemon releases it, or pick another device.",
  ) {
    super(
      DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      deviceId,
      DEVICE_OWNED_BY_OTHER_DAEMON_RETRY_AFTER_MS,
      `Device '${deviceId}' is claimed by another AutoMobile daemon` +
        (ownerPid === undefined ? "" : ` (PID ${ownerPid})`) +
        ` (code ${DEVICE_OWNED_BY_OTHER_DAEMON_CODE}); two daemons must never drive the same ` +
        `device. ${remedy}`,
    );
    this.name = "DeviceOwnedByOtherDaemonError";
  }
}
