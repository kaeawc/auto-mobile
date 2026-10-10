export function deviceLossCancellationReason(
  deviceId: string,
  incidentId?: string,
): `device-disconnected:${string}` {
  return incidentId
    ? `device-disconnected:${deviceId};incident=${incidentId}`
    : `device-disconnected:${deviceId}`;
}

/** Recognize the cancellation protocol, including legacy reasons without an incident ID. */
export function isDeviceLossCancellationReason(reason: unknown): reason is string {
  return typeof reason === "string" && reason.startsWith("device-disconnected:");
}
