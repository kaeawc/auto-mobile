/**
 * The release-reason family of a device loss. Utils cannot import the daemon, so
 * `test/daemon/releaseReasons.test.ts` pins this to a family in the table.
 */
export const DEVICE_LOSS_REASON_PREFIX = "device-disconnected:" as const;

export function deviceLossCancellationReason(
  deviceId: string,
  incidentId?: string,
): `${typeof DEVICE_LOSS_REASON_PREFIX}${string}` {
  return incidentId
    ? `${DEVICE_LOSS_REASON_PREFIX}${deviceId};incident=${incidentId}`
    : `${DEVICE_LOSS_REASON_PREFIX}${deviceId}`;
}

/** Recognize the cancellation protocol, including legacy reasons without an incident ID. */
export function isDeviceLossCancellationReason(reason: unknown): reason is string {
  return typeof reason === "string" && reason.startsWith(DEVICE_LOSS_REASON_PREFIX);
}
